#!/usr/bin/env node
// tools/run_headless.mjs — run the Tissue Weather scenarios without a browser.
//
//   node tools/run_headless.mjs [--out DIR] [--days 90] [--snap 5] [--csv 0.5]
//                               [--seed 7] [--only a,b,c] [--blender PATH]
//
// For every run it writes  <out>/<name>.csv   (stats every --csv days)
//                     and  <out>/<name>.json  (SPEC §1.10 trajectory, snapshot every --snap days).
// It also writes <out>/maturation_traj.json (the maturation trajectory, for Blender) and,
// with --blender PATH, copies it there.  Default --out is $TISSUE_OUT or ./scratch/model.
//
// Runs (SPEC §1.7 presets plus the variants the tests and plots rely on):
//   maturation             preset 1
//   maturation_lowG        preset 1 with Gext = 0.2 from the start (low branch of the hysteresis)
//   maturation_protease0   preset 1 with protease = 0
//   maturation_protease1   preset 1 with protease = 1
//   unloading              preset 2: matured tissue, strain 0 from the start
//   fibrosis               preset 3, Gext dropped to 0.2 at day 45 (hysteresis)
//   fibrosis_nodrop        preset 3 without the drop (the runaway itself)
//   fibrosis_lowG          preset 3 with Gext = 0.2 from the start
//   wound                  preset 4: matured tissue, injured at day 5 (sphere at the centre)
//   sandbox                preset 5 with all dials at 0 (40 cells), started from rho 0.15
import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TissueModel } from '../src/model.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = 'true'; }
}
const OUT = resolve(args.out ?? process.env.TISSUE_OUT ?? 'scratch/model');
const DAYS = +(args.days ?? 90);
const SNAP = +(args.snap ?? 5);
const CSV_EVERY = +(args.csv ?? 0.5);
const SEED = +(args.seed ?? 7);
const ONLY = args.only ? new Set(args.only.split(',')) : null;

const RUNS = {
  maturation: { scenario: 'maturation' },
  maturation_lowG: { scenario: 'maturation', dials: { Gext: 0.2 } },
  maturation_protease0: { scenario: 'maturation', dials: { protease: 0 } },
  maturation_protease1: { scenario: 'maturation', dials: { protease: 1 } },
  unloading: { scenario: 'unloading' },
  fibrosis: { scenario: 'fibrosis', events: [{ day: 45, setDials: { Gext: 0.2 } }] },
  fibrosis_nodrop: { scenario: 'fibrosis' },
  fibrosis_lowG: { scenario: 'fibrosis', dials: { Gext: 0.2 } },
  wound: { scenario: 'wound', events: [{ day: 5, injure: { center: [0.5, 0.5, 0.5] } }] },
  sandbox: { scenario: 'sandbox', dials: { Gext: 0, strain: 0, protease: 0, nCells: 40 }, init: { rho0: 0.15 } },
};

const CSV_COLS = ['t', 'meanRho', 'meanRhoNew', 'meanRhoMat', 'phiMat', 'meanFA', 'globalFA', 'meanFz', 'meanLogE', 'meanE',
  'meanAlpha', 'meanG', 'meanGcell', 'meanH', 'meanM', 'deposition', 'degradation', 'nCells',
  'woundRho', 'woundPhiMat', 'woundFA', 'woundCells', 'Gext', 'strain', 'protease'];

function fmt(x) {
  if (x === undefined || x === null || Number.isNaN(x)) return '';
  return Number.isInteger(x) ? String(x) : (+x.toPrecision(6)).toString();
}

function runOne(name, cfg) {
  const model = new TissueModel({}, SEED);
  model.reset(cfg.scenario, { dials: cfg.dials || {}, init: cfg.init || {} });
  const dt = model.params.dt;
  const chunk = Math.max(1, Math.round(CSV_EVERY / dt));
  const snapEvery = Math.max(1, Math.round(SNAP / CSV_EVERY));
  const events = (cfg.events || []).map((e) => Object.assign({ fired: false }, e));
  const eventLog = [];
  const rows = [], frames = [];

  const fireEvents = () => {
    for (const ev of events) {
      if (ev.fired || model.time < ev.day - 1e-9) continue;
      ev.fired = true;
      if (ev.setDials) { model.setDials(ev.setDials); eventLog.push({ t: +model.time.toFixed(3), type: 'setDials', dials: ev.setDials }); }
      if (ev.injure) { const w = model.injure(ev.injure.center ?? null, ev.injure.radius); eventLog.push({ t: +model.time.toFixed(3), type: 'injure', center: w.center, radius: w.radius }); }
    }
  };
  const record = (k) => {
    const s = model.stats(), w = model.woundStats(), d = model.dials;
    rows.push({ ...s, woundRho: w ? w.meanRho : undefined, woundPhiMat: w ? w.phiMat : undefined, woundFA: w ? w.meanFA : undefined,
      woundCells: w ? w.nCells : undefined, Gext: d.Gext, strain: d.strain, protease: d.protease });
    if (k % snapEvery === 0) frames.push(model.snapshot());
  };

  const t0 = process.hrtime.bigint();
  const nChunks = Math.round(DAYS / CSV_EVERY);
  let k = 0;
  fireEvents(); record(k);
  let steps = 0;
  for (k = 1; k <= nChunks; k++) {
    model.step(chunk); steps += chunk;
    fireEvents();          // events fire at the boundary they belong to (e.g. injure at t = 5.0)
    record(k);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  mkdirSync(OUT, { recursive: true });
  const csv = [CSV_COLS.join(',')].concat(rows.map((r) => CSV_COLS.map((c) => fmt(r[c])).join(','))).join('\n') + '\n';
  writeFileSync(join(OUT, `${name}.csv`), csv);
  const traj = { meta: { ...model.exportMeta(), run: name, days: DAYS, exportEvery: SNAP, initialDials: Object.assign({}, cfg.dials || {}), events: eventLog }, frames };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(traj));

  const first = rows[0], last = rows[rows.length - 1], peak = Math.max(...rows.map((r) => r.meanRho));
  console.log(`${name.padEnd(22)} ${DAYS} d in ${(ms / 1000).toFixed(2)} s (${(ms / steps).toFixed(3)} ms/step) ` +
    `rho ${first.meanRho.toFixed(3)} -> ${last.meanRho.toFixed(3)} (peak ${peak.toFixed(3)})  FA ${last.meanFA.toFixed(2)}  ` +
    `phiMat ${last.phiMat.toFixed(2)}  log10E ${last.meanLogE.toFixed(2)}  alpha ${last.meanAlpha.toFixed(2)}` +
    (last.woundRho !== undefined ? `  wound rho ${last.woundRho.toFixed(2)}` : ''));
  return { rows, traj };
}

const results = {};
for (const [name, cfg] of Object.entries(RUNS)) {
  if (ONLY && !ONLY.has(name)) continue;
  results[name] = runOne(name, cfg);
}

if (results.maturation) {
  const p = join(OUT, 'maturation_traj.json');
  writeFileSync(p, JSON.stringify(results.maturation.traj));
  const mb = statSync(p).size / 1e6;
  console.log(`wrote ${p} (${mb.toFixed(2)} MB, ${results.maturation.traj.frames.length} frames)`);
  if (args.blender) { copyFileSync(p, resolve(args.blender)); console.log(`copied to ${resolve(args.blender)}`); }
}
console.log(`outputs in ${OUT}`);
