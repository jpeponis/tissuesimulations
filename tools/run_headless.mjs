#!/usr/bin/env node
// tools/run_headless.mjs — run a tissue's scenarios without a browser.
//
//   node tools/run_headless.mjs [--tissue fibrous] [--out DIR] [--days 90] [--snap 5] [--csv 0.5]
//                               [--seed 7] [--only a,b,c] [--blender PATH] [--no-variants]
//
// Runs every scenario of the tissue (applying the scenario's `events`: dial changes and
// injuries at day `at`, fired when the clock reaches that day) plus the tissue-specific
// variants listed in HEADLESS_VARIANTS. For every run it writes
//     <out>/<name>.csv    stats every --csv days, generic columns:
//                         t, species.<key>…, fa, logE, cells.a, cells.b, fields.<key>…, deposition,
//                         degradation, then species.total, globalFA, fz, E, cells.c, cells.n, ratio, dial.<key>…
//     <out>/<name>.json   format-2 trajectory (docs/EXTENDING.md §5), snapshot every --snap days.
// It also writes <out>/<firstScenario>_traj.json (e.g. maturation_traj.json, for Blender) and,
// with --blender PATH, copies it there. Default --out is $TISSUE_OUT or ./scratch/<tissue>.
import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TissueEngine } from '../src/engine.js';
import { TISSUES, TISSUE_DEFAULT } from '../src/tissues/index.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = 'true'; }
}
const TISSUE_KEY = args.tissue ?? TISSUE_DEFAULT;
const tissue = TISSUES[TISSUE_KEY];
if (!tissue) { console.error(`unknown tissue '${TISSUE_KEY}'; registered: ${Object.keys(TISSUES).join(', ')}`); process.exit(1); }
const OUT = resolve(args.out ?? process.env.TISSUE_OUT ?? `scratch/${TISSUE_KEY}`);
const DAYS = +(args.days ?? 90);
const SNAP = +(args.snap ?? 5);
const CSV_EVERY = +(args.csv ?? 0.5);
const SEED = +(args.seed ?? 7);
const ONLY = args.only ? new Set(args.only.split(',')) : null;

// Extra runs per tissue: { name: { scenario, dials?, init?, events? } } (events replace the scenario's).
const HEADLESS_VARIANTS = {
  fibrous: {
    maturation_lowG: { scenario: 'maturation', dials: { Gext: 0.2 } },
    maturation_protease0: { scenario: 'maturation', dials: { protease: 0 } },
    maturation_protease1: { scenario: 'maturation', dials: { protease: 1 } },
    fibrosis_nodrop: { scenario: 'fibrosis', events: [] },
    fibrosis_lowG: { scenario: 'fibrosis', dials: { Gext: 0.2 }, events: [] },
    sandbox_evaporate: { scenario: 'sandbox', dials: { Gext: 0, strain: 0, protease: 0, nCells: 40 }, init: { species: { new: 0.15 } } },
  },
};

const RUNS = {};
for (const sc of tissue.scenarios) RUNS[sc.key] = { scenario: sc.key, events: sc.events || [] };
if (args['no-variants'] !== 'true') for (const [name, v] of Object.entries(HEADLESS_VARIANTS[TISSUE_KEY] || {})) {
  RUNS[name] = Object.assign({ events: (tissue.scenarios.find((s) => s.key === v.scenario) || {}).events || [] }, v);
}

const speciesCols = tissue.species.map((s) => `species.${s.key}`), fieldCols = tissue.fields.map((f) => `fields.${f.key}`);
const dialCols = tissue.dials.map((d) => `dial.${d.key}`);
const CSV_COLS = ['t', ...speciesCols, 'fa', 'logE', 'cells.a', 'cells.b', ...fieldCols, 'deposition', 'degradation',
  'species.total', 'globalFA', 'fz', 'E', 'cells.c', 'cells.n', 'ratio', ...dialCols];

function fmt(x) {
  if (x === undefined || x === null || Number.isNaN(x) || !Number.isFinite(x)) return '';
  return Number.isInteger(x) ? String(x) : (+x.toPrecision(6)).toString();
}

const M = new TissueEngine(tissue, { seed: SEED });   // one instance: init.from pre-runs are cached per instance

function runOne(name, cfg) {
  M.reset(cfg.scenario, { dials: cfg.dials || {}, init: cfg.init || {} });
  const dt = M.dt;
  const chunk = Math.max(1, Math.round(CSV_EVERY / dt));
  const snapEvery = Math.max(1, Math.round(SNAP / CSV_EVERY));
  const events = (cfg.events || []).map((e) => Object.assign({ fired: false }, e));
  const eventLog = [];
  const rows = [], frames = [];

  const fireEvents = () => {
    for (const ev of events) {
      if (ev.fired || M.time < ev.at - 1e-9) continue;
      ev.fired = true;
      if (ev.dials) { M.setDials(ev.dials); eventLog.push({ t: +M.time.toFixed(3), type: 'setDials', dials: ev.dials }); }
      if (ev.injure) { const w = M.injure(ev.injure.center ?? null, ev.injure.radius); if (w) eventLog.push({ t: +M.time.toFixed(3), type: 'injure', center: w.center, radius: w.radius }); }
    }
  };
  const record = (k) => {
    const s = M.stats(), row = {};
    for (const c of CSV_COLS) row[c] = c.startsWith('dial.') ? M.dials[c.slice(5)] : TissueEngine.statFrom(s, c);
    rows.push(row);
    if (k % snapEvery === 0) frames.push(M.snapshot());
  };

  const t0 = process.hrtime.bigint();
  const nChunks = Math.round(DAYS / CSV_EVERY);
  let k = 0;
  fireEvents(); record(k);
  let steps = 0;
  for (k = 1; k <= nChunks; k++) {
    M.step(chunk); steps += chunk;
    fireEvents();          // events fire at the boundary they belong to (e.g. injure at t = 5.0)
    record(k);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  mkdirSync(OUT, { recursive: true });
  const csv = [CSV_COLS.join(',')].concat(rows.map((r) => CSV_COLS.map((c) => fmt(r[c])).join(','))).join('\n') + '\n';
  writeFileSync(join(OUT, `${name}.csv`), csv);
  const traj = { meta: Object.assign(M.exportMeta({ exportEveryDays: SNAP }), { run: name, days: DAYS, initialDials: Object.assign({}, cfg.dials || {}), events: eventLog }), frames };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(traj));

  const first = rows[0], last = rows[rows.length - 1], peak = Math.max(...rows.map((r) => r['species.total']));
  const lastFiber = tissue.species.filter((s) => s.kind === 'fiber').pop();
  console.log(`${name.padEnd(22)} ${DAYS} d in ${(ms / 1000).toFixed(2)} s (${(ms / steps).toFixed(3)} ms/step) ` +
    `total ${first['species.total'].toFixed(3)} -> ${last['species.total'].toFixed(3)} (peak ${peak.toFixed(3)})  FA ${last.fa.toFixed(2)}  ` +
    (lastFiber ? `${lastFiber.key} ${last[`species.${lastFiber.key}`].toFixed(2)}  ` : '') +
    `log10E ${last.logE.toFixed(2)}  a ${last['cells.a'].toFixed(2)}`);
  return { rows, traj };
}

const results = {};
for (const [name, cfg] of Object.entries(RUNS)) {
  if (ONLY && !ONLY.has(name)) continue;
  results[name] = runOne(name, cfg);
}

const firstKey = tissue.scenarios[0].key;
if (results[firstKey]) {
  const p = join(OUT, `${firstKey}_traj.json`);
  writeFileSync(p, JSON.stringify(results[firstKey].traj));
  const mb = statSync(p).size / 1e6;
  console.log(`wrote ${p} (${mb.toFixed(2)} MB, ${results[firstKey].traj.frames.length} frames, format 2)`);
  if (args.blender) { copyFileSync(p, resolve(args.blender)); console.log(`copied to ${resolve(args.blender)}`); }
}
console.log(`outputs in ${OUT}`);
