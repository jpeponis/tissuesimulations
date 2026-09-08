// Records reference statistics of a tissue for the golden regression test (tests/engine.test.mjs).
//   node tools/make_golden.mjs [--tissue fibrous] [--out FILE] [--seed 7]     (default FILE: tests/golden/<tissue>.json)
// Re-run DELIBERATELY when the model changes on purpose.
//
// TWO KINDS OF GOLDEN, two tolerances (docs/REVIEW.md D2):
//   tests/golden/fibrous.json         recorded from v0.1 model.js. "Is this still the same MODEL?"
//                                     — compared within 3 % / 0.01. NEVER re-record it: the 3 %
//                                     agreement with v0.1 is the claim, and this tool cannot
//                                     reproduce it (it would just record the engine as it is now).
//   tests/golden/<tissue>.engine.json recorded from THIS engine. "Is this still the same
//                                     ARITHMETIC?" — compared at 1e-5 relative / 1e-7 absolute on
//                                     every recorded stat path. Re-record it (and say so in the
//                                     commit message) whenever a change to the engine or to the
//                                     tissue's parameters is meant to move the numbers.
//     node tools/make_golden.mjs --tissue fibrous --out tests/golden/fibrous.engine.json
//
// Protocol (shared with the test): reset(scenario, { dials, init }); record at t = 0; then for each
// day: step one day, fire the run's events whose `at` equals that day (dial changes / injury), and
// record every `every` days. Runs = every scenario of the tissue (with its own `events`), with the
// per-tissue overrides in GOLDEN_VARIANTS merged in (the fibrous sandbox run starts from new = 0.15
// with all dials at 0 so that "evaporation" is on record).
//
// Columns are stat paths (docs/EXTENDING.md §1), including the v0.3 additions
// species.tissueTotal / cumDeposition / cumDegradation / scaffoldFlux; the test compares every
// recorded path of a format-2 golden, so re-recording widens what is guarded.
//
// Note: tests/golden/fibrous.json was recorded by the v0.1 make_golden (model.js), whose loop fired
// the day-d event BEFORE stepping day d (i.e. at t = d − 1) and described it as { injureAt, at: {d: dials} }.
// The test translates that legacy shape; this tool writes explicit `events: [{ at, ... }]`.
import { writeFileSync } from 'node:fs';
import { TissueEngine, ENGINE_VERSION } from '../src/engine.js';
import { TISSUES, TISSUE_DEFAULT } from '../src/tissues/index.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = 'true'; }
}
const TISSUE_KEY = args.tissue ?? TISSUE_DEFAULT;
const tissue = TISSUES[TISSUE_KEY];
if (!tissue) { console.error(`unknown tissue '${TISSUE_KEY}'; registered: ${Object.keys(TISSUES).join(', ')}`); process.exit(1); }
const out = args.out || new URL(`../tests/golden/${TISSUE_KEY}.json`, import.meta.url).pathname;
if (/(^|\/)fibrous\.json$/.test(out) && args.force !== 'true') {
  console.error(`refusing to overwrite ${out}: it is the v0.1 reference (see the header).\n` +
    `Record the engine reference instead:\n  node tools/make_golden.mjs --tissue ${TISSUE_KEY} --out tests/golden/${TISSUE_KEY}.engine.json\n` +
    '(--force overrides this, but nothing in the repo should need it.)');
  process.exit(2);
}
const SEED = +(args.seed ?? 7);
const EVERY = 5;

const GOLDEN_VARIANTS = {
  fibrous: { sandbox: { days: 60, dials: { Gext: 0, strain: 0, protease: 0 }, init: { species: { new: 0.15 } } } },
};

const runs = {};
for (const sc of tissue.scenarios) {
  runs[sc.key] = Object.assign({ scenario: sc.key, days: 90, events: (sc.events || []).map((e) => Object.assign({}, e)) },
    (GOLDEN_VARIANTS[TISSUE_KEY] || {})[sc.key] || {});
}

const M = new TissueEngine(tissue, { seed: SEED });
const cols = ['species.total', 'species.tissueTotal', ...tissue.species.map((s) => `species.${s.key}`), 'fa', 'logE', 'cells.a', 'cells.b',
  ...tissue.fields.map((f) => `fields.${f.key}`), 'deposition', 'degradation', 'cumDeposition', 'cumDegradation', 'scaffoldFlux'];
const golden = { seed: SEED, tissue: TISSUE_KEY, tissueVersion: tissue.version, engine: ENGINE_VERSION, format: 2,
  params: tissue.params, engineParams: M.P, every: EVERY, runs: {} };
for (const [key, r] of Object.entries(runs)) {
  M.reset(r.scenario, { dials: r.dials, init: r.init });
  const stepsPerDay = Math.round(1 / M.dt);
  const rows = [];
  const rec = () => { const s = M.stats(), row = { t: +s.t.toFixed(2) }; for (const c of cols) row[c] = TissueEngine.statFrom(s, c); rows.push(row); };
  const fire = (d) => { for (const e of r.events || []) if (e.at === d) { if (e.dials) M.setDials(e.dials); if (e.injure) M.injure(e.injure.center ?? null, e.injure.radius); } };
  fire(0); rec();
  for (let d = 1; d <= r.days; d++) {
    M.step(stepsPerDay);
    fire(d);
    if (d % EVERY === 0) rec();
  }
  golden.runs[key] = Object.assign({}, r, { rows });
}
writeFileSync(out, JSON.stringify(golden, null, 1));
console.log('wrote', out, Object.keys(golden.runs).map((k) => `${k}:${golden.runs[k].rows.length} rows`).join(' '));
