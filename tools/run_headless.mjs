#!/usr/bin/env node
// tools/run_headless.mjs — run a tissue's scenarios without a browser.
//
//   node tools/run_headless.mjs [--tissue fibrous] [--out DIR] [--days 90] [--snap 5]
//                               [--csv-every 0.5] [--events true|false] [--seed 7] [--only a,b,c]
//                               [--blender PATH] [--no-variants] [--help]
//
// Every option also takes the `--key=value` form. `--help` prints the usage above with this
// tissue's runs and exits 0; an `--only` name that is not a run exits 2 and lists them, so a typo
// cannot silently produce an empty output directory.
//
// Runs every scenario of the tissue plus the tissue-specific variants listed in
// HEADLESS_VARIANTS. `--events` (default on; `--events false` or `--no-events` turns it off)
// applies each scenario's `events` — dial changes and injuries at day `at`, fired when the clock
// reaches that day. `--csv-every` (alias: the older `--csv`) is the CSV sampling interval in days.
// For every run it writes
//     <out>/<name>.csv    stats every --csv-every days, generic columns:
//                         t, species.<key>…, fa, logE, cells.a, cells.b, fields.<key>…, deposition,
//                         degradation, then species.total, species.tissueTotal, globalFA, fz, E,
//                         cells.c, cells.n, ratio, cumDeposition, cumDegradation, scaffoldFlux,
//                         dial.<key>…
//     <out>/<name>.json   format-2 trajectory (docs/EXTENDING.md §5), snapshot every --snap days.
// With `--blender PATH` it also writes <out>/<firstScenario>_traj.json and copies it there (that
// duplicate is written ONLY for --blender: it is the same multi-MB file as <firstScenario>.json).
// Default --out is $TISSUE_OUT or ./scratch/<tissue>.
import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TissueEngine } from '../src/engine.js';
import { TISSUES, TISSUE_DEFAULT } from '../src/tissues/index.js';

const KNOWN_FLAGS = ['tissue', 'out', 'days', 'snap', 'csv-every', 'csv', 'events', 'no-events',
  'seed', 'only', 'blender', 'no-variants', 'help', 'h'];
const args = {};
const badFlags = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  let k, v;
  if (eq > 0) { k = a.slice(2, eq); v = a.slice(eq + 1); }            // --days=40
  else {
    k = a.slice(2);
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { v = next; i++; } else v = 'true';
  }
  if (!KNOWN_FLAGS.includes(k)) badFlags.push(`--${k}`);
  args[k] = v;
}

const USAGE = `usage: node tools/run_headless.mjs [options]

  --tissue KEY      which tissue to run (default ${TISSUE_DEFAULT}); registered: ${Object.keys(TISSUES).join(', ')}
  --only a,b,c      run only these runs (scenario keys and variant names, see below)
  --days N          simulated days per run (default 90)
  --snap N          trajectory snapshot every N days (default 5)
  --csv-every N     CSV row every N days (default 0.5; alias --csv)
  --events BOOL     apply each scenario's scripted events (default true; --no-events turns them off)
  --no-variants     scenarios only, no HEADLESS_VARIANTS
  --seed N          PRNG seed (default 7)
  --out DIR         output directory (default $TISSUE_OUT or scratch/<tissue>)
  --blender PATH    also write <out>/<firstScenario>_traj.json and copy it to PATH
  --help            this text

Options also take --key=value. Writes <out>/<run>.csv (stats over time) and <out>/<run>.json
(format-2 trajectory, docs/EXTENDING.md §5) per run.`;

const HELP = args.help === 'true' || args.h === 'true';
if (badFlags.length && !HELP) { console.error(`unknown option${badFlags.length > 1 ? 's' : ''}: ${badFlags.join(', ')}\n\n${USAGE}`); process.exit(2); }

const TISSUE_KEY = (HELP && !TISSUES[args.tissue]) ? TISSUE_DEFAULT : (args.tissue ?? TISSUE_DEFAULT);
const tissue = TISSUES[TISSUE_KEY];
if (!tissue) { console.error(`unknown tissue '${TISSUE_KEY}'; registered: ${Object.keys(TISSUES).join(', ')}`); process.exit(1); }
const OUT = resolve(args.out ?? process.env.TISSUE_OUT ?? `scratch/${TISSUE_KEY}`);
const DAYS = +(args.days ?? 90);
const SNAP = +(args.snap ?? 5);
const CSV_EVERY = +(args['csv-every'] ?? args.csv ?? 0.5);
const EVENTS = args.events !== 'false' && args['no-events'] !== 'true';
const SEED = +(args.seed ?? 7);
const ONLY = args.only && args.only !== 'true' ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

// Extra runs per tissue: { name: { scenario, dials?, init?, events?, label? } }
// (`events` replaces the scenario's; `label` is the plot legend, else it is derived from the
// scenario title and the dial overrides).
const HEADLESS_VARIANTS = {
  fibrous: {
    maturation_lowG: { scenario: 'maturation', dials: { Gext: 0.2 } },
    maturation_protease0: { scenario: 'maturation', dials: { protease: 0 } },
    maturation_protease1: { scenario: 'maturation', dials: { protease: 1 } },
    fibrosis_nodrop: { scenario: 'fibrosis', events: [], label: 'Fibrosis, bath never lowered' },
    fibrosis_lowG: { scenario: 'fibrosis', dials: { Gext: 0.2 }, events: [], label: 'Fibrosis dials at bath 0.2' },
    sandbox_evaporate: { scenario: 'sandbox', dials: { Gext: 0, strain: 0, protease: 0, nCells: 40 }, init: { species: { new: 0.15 } }, label: 'Sandbox, every dial at zero' },
    // Unloading with ONLY the load removed: the bath and the protease dial stay where the matured
    // tissue had them (Gext 0.5, protease 0.4). This is the control behind the copy fix of
    // docs/REVIEW.md F1 — off load alone the tissue holds its density and the cells stay activated,
    // so the atrophy of the `unloading` scenario needs the bath drop too.
    unloading_loadOnly: { scenario: 'unloading', dials: { Gext: 0.5, strain: 0, protease: 0.4 }, label: 'Unloading, load removed but bath kept' },
  },
};

// Every run carries a human `title` (the plot legend and the panel headings come from it, so
// tools/plot_scenarios.py needs no table of run names of its own).
const titleOf = (sc, v) => {
  const base = (sc && sc.title) || v.scenario;
  if (v.label) return v.label;
  const dials = Object.entries(v.dials || {}).map(([k, x]) => `${k} ${x}`);
  const parts = [];
  if (dials.length) parts.push(dials.length > 3 ? `${dials.slice(0, 3).join(', ')}, …` : dials.join(', '));
  if (v.events && v.events.length === 0 && sc && (sc.events || []).length) parts.push('no scripted events');
  return parts.length ? `${base}, ${parts.join(', ')}` : base;
};

const RUNS = {};
for (const sc of tissue.scenarios) RUNS[sc.key] = { scenario: sc.key, title: sc.title || sc.key, events: EVENTS ? sc.events || [] : [] };
if (args['no-variants'] !== 'true') for (const [name, v] of Object.entries(HEADLESS_VARIANTS[TISSUE_KEY] || {})) {
  const sc = tissue.scenarios.find((s) => s.key === v.scenario);
  RUNS[name] = Object.assign({ events: (sc || {}).events || [] }, v, { title: titleOf(sc, v) });
  if (!EVENTS) RUNS[name].events = [];
}
const RUN_ORDER = Object.keys(RUNS);

if (HELP) {
  console.log(`${USAGE}\n\nruns for '${TISSUE_KEY}': ${Object.keys(RUNS).join(', ')}`);
  process.exit(0);
}
if (ONLY) {                                            // a typo in --only used to produce nothing at all
  const unknown = [...ONLY].filter((k) => !RUNS[k]);
  if (unknown.length) {
    console.error(`unknown run${unknown.length > 1 ? 's' : ''} in --only: ${unknown.join(', ')}\n` +
      `runs for '${TISSUE_KEY}': ${Object.keys(RUNS).join(', ')}` +
      (args['no-variants'] === 'true' ? '\n(--no-variants is on, so the HEADLESS_VARIANTS names are not available)' : ''));
    process.exit(2);
  }
}

const speciesCols = tissue.species.map((s) => `species.${s.key}`), fieldCols = tissue.fields.map((f) => `fields.${f.key}`);
const dialCols = tissue.dials.map((d) => `dial.${d.key}`);
const CSV_COLS = ['t', ...speciesCols, 'fa', 'logE', 'cells.a', 'cells.b', ...fieldCols, 'deposition', 'degradation',
  'species.total', 'species.tissueTotal', 'globalFA', 'fz', 'E', 'cells.c', 'cells.n', 'ratio',
  'cumDeposition', 'cumDegradation', 'scaffoldFlux', ...dialCols];

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
  const traj = { meta: Object.assign(M.exportMeta({ exportEveryDays: SNAP }), {
    run: name, title: cfg.title || name, order: RUN_ORDER.indexOf(name),
    days: DAYS, initialDials: Object.assign({}, cfg.dials || {}), events: eventLog }), frames };
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

// <first>_traj.json duplicates <first>.json byte for byte and is several MB, so it is written only
// when something asks for it: --blender PATH (the Blender importer's documented input file).
const firstKey = tissue.scenarios[0].key;
if (args.blender && args.blender !== 'true' && results[firstKey]) {
  const p = join(OUT, `${firstKey}_traj.json`);
  writeFileSync(p, JSON.stringify(results[firstKey].traj));
  const mb = statSync(p).size / 1e6;
  console.log(`wrote ${p} (${mb.toFixed(2)} MB, ${results[firstKey].traj.frames.length} frames, format 2)`);
  copyFileSync(p, resolve(args.blender));
  console.log(`copied to ${resolve(args.blender)}`);
} else if (args.blender === 'true') {
  console.error('--blender needs a path, e.g. --blender blender/sample_trajectory.json');
  process.exit(2);
} else if (args.blender && !results[firstKey]) {
  console.error(`--blender: '${firstKey}' was not run (--only ${[...(ONLY || [])].join(',')}), so there is nothing to copy`);
  process.exit(2);
}
console.log(`outputs in ${OUT}`);
