// Records reference statistics of the fibrous tissue for regression tests.
// Usage: node tools/make_golden.mjs [outFile]   (default tests/golden/fibrous.json)
// Re-run deliberately when the model changes on purpose; the test compares within tolerance.
import { writeFileSync } from 'node:fs';
import { TissueModel, DEFAULT_PARAMS } from '../src/model.js';

const out = process.argv[2] || new URL('../tests/golden/fibrous.json', import.meta.url).pathname;
const SEED = 7;
const runs = {
  maturation: { scenario: 'maturation', days: 90 },
  unloading: { scenario: 'unloading', days: 90 },
  fibrosis: { scenario: 'fibrosis', days: 90, at: { 45: { Gext: 0.2 } } },
  wound: { scenario: 'wound', days: 90, injureAt: 5 },
  sandbox: { scenario: 'sandbox', days: 60, dials: { Gext: 0, strain: 0, protease: 0 }, init: { rho0: 0.15 } },
};
const golden = { seed: SEED, params: DEFAULT_PARAMS, every: 5, runs: {} };
for (const [key, r] of Object.entries(runs)) {
  const M = new TissueModel({}, SEED);
  M.reset(r.scenario, { dials: r.dials, init: r.init });
  const stepsPerDay = Math.round(1 / M.params.dt);
  const rows = [];
  const rec = () => { const s = M.stats(); rows.push({ t: +s.t.toFixed(2), meanRho: s.meanRho, meanRhoMat: s.meanRhoMat, meanFA: s.meanFA, meanLogE: s.meanLogE, meanAlpha: s.meanAlpha, meanG: s.meanG, meanM: s.meanM, deposition: s.deposition, degradation: s.degradation }); };
  rec();
  for (let d = 1; d <= r.days; d++) {
    if (r.injureAt === d) M.injure([0.5, 0.5, 0.5]);
    if (r.at && r.at[d]) M.setDials(r.at[d]);
    M.step(stepsPerDay);
    if (d % golden.every === 0) rec();
  }
  golden.runs[key] = { ...r, rows };
}
writeFileSync(out, JSON.stringify(golden, null, 1));
console.log('wrote', out, Object.keys(golden.runs).map((k) => `${k}:${golden.runs[k].rows.length} rows`).join(' '));
