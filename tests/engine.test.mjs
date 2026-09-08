// tests/engine.test.mjs — run with `node --test tests/*.test.mjs` (Node ≥ 21 treats the argument as a
// glob; a bare directory such as `node --test tests/` is not expanded).
//
// Conformance (docs/EXTENDING.md §7) for every registered tissue (src/tissues/index.js) plus the
// unregistered starter src/tissues/_template.js:
//   1. schema validation   2. determinism   3. invariants   4. every scenario's `checks`   5. performance
// Plus the fibrous golden regression against tests/golden/fibrous.json (recorded from v0.1 model.js,
// seed 7): species.total / species.mat / fa / cells.a within 3 % relative or 0.01 absolute (whichever
// is larger) at every recorded day of all recorded runs. Plus engine API tests (stat paths, init.from
// cache, injury, cell-count dial, export format 2), the v0.3 contract features (species D / sink,
// polS / alignS, out.vox accumulators, scaffold flux, aggregated checks, init.from.events) and the
// shared copy helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { TissueEngine, ENGINE_DEFAULTS, ENGINE_VERSION, mulberry32, tmClamp, tmRoundArray } from '../src/engine.js';
import { TISSUES, TISSUE_DEFAULT } from '../src/tissues/index.js';
import { TISSUE_TEMPLATE } from '../src/tissues/_template.js';
import { copyEquilibriumSentence, copyFormatRate, copyFormatDial } from '../src/copy.js';

const SEED = 7;
const CONFORMANCE = Object.assign({}, TISSUES, { _template: TISSUE_TEMPLATE });

// one engine per tissue, shared so that init.from pre-runs are computed once
const engines = {};
const engineFor = (t) => (engines[t.key] ??= new TissueEngine(t, { seed: SEED }));

const allFinite = (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; };

function checkInvariants(M, label) {
  const s = M.state, P = M.P;
  for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz', 'fiberTotal', 'fa', 'fx', 'fy', 'fz', 'E', 'inflam', 'cx', 'cp', 'ca', 'cb', 'cc']) {
    assert.ok(allFinite(s[k]), `${label}: ${k} has NaN/Inf`);
  }
  for (const arr of s.species) assert.ok(allFinite(arr), `${label}: species has NaN/Inf`);
  for (const arr of s.fields) assert.ok(allFinite(arr), `${label}: field has NaN/Inf`);
  const fiber = M.tissue.species.map((sp, i) => (sp.kind === 'fiber' ? i : -1)).filter((i) => i >= 0);
  for (let v = 0; v < M.NV; v++) {
    let tot = 0;
    for (let i = 0; i < s.species.length; i++) { assert.ok(s.species[i][v] >= 0, `${label}: species ${i} < 0 at ${v}`); if (fiber.includes(i)) tot += s.species[i][v]; }
    assert.ok(tot <= P.rhoMax + 1e-4, `${label}: fiber total > rhoMax at ${v}`);
    const tr = s.Txx[v] + s.Tyy[v] + s.Tzz[v];
    assert.ok(Math.abs(tr - tot) <= 1e-4 + 1e-4 * tot, `${label}: trace(T) ${tr} ≠ fiber total ${tot} at ${v}`);
    assert.ok(Math.abs(s.fiberTotal[v] - tot) <= 1e-4 + 1e-4 * tot, `${label}: fiberTotal stale at ${v}`);
    assert.ok(s.fa[v] >= 0 && s.fa[v] <= 1, `${label}: FA outside [0,1] at ${v}`);
    assert.ok(s.Txx[v] >= 0 && s.Tyy[v] >= 0 && s.Tzz[v] >= 0, `${label}: negative tensor diagonal at ${v}`);
    assert.ok(s.E[v] > 0, `${label}: E ≤ 0 at ${v}`);
    for (const arr of s.fields) assert.ok(arr[v] >= 0, `${label}: negative field at ${v}`);
  }
  assert.equal(s.cx.length, 3 * s.nCells);
  for (let i = 0; i < s.nCells; i++) {
    for (let d = 0; d < 3; d++) {
      const q = s.cx[3 * i + d];
      assert.ok(q >= 0 && q <= P.L, `${label}: cell ${i} outside the box (${q})`);
    }
    const pn = Math.hypot(s.cp[3 * i], s.cp[3 * i + 1], s.cp[3 * i + 2]);
    assert.ok(Math.abs(pn - 1) < 1e-3, `${label}: polarity not unit (${pn})`);
    assert.ok(s.ca[i] >= 0 && s.ca[i] <= 1 && s.cb[i] >= 0 && s.cb[i] <= 1, `${label}: a/b outside [0,1]`);
    assert.ok(s.ctype[i] < M.tissue.cellTypes.length, `${label}: bad cell type`);
  }
  const st = M.stats();
  assert.ok(Number.isFinite(st.deposition) && Number.isFinite(st.degradation) && st.deposition >= 0 && st.degradation >= 0);
  assert.ok(Number.isFinite(st.fa) && Number.isFinite(st.logE) && Number.isFinite(st.species.total));
}

/** Drive an engine through a scenario with dial changes and (if possible) an injury; returns the engine. */
function stressRun(M, key) {
  const spd = Math.round(1 / M.dt);
  const t = M.tissue, dialMax = {}, dialMin = {};
  for (const d of t.dials) { dialMax[d.key] = d.max; dialMin[d.key] = d.min; }
  const cellDial = t.dials.find((d) => d.role === 'cellCount');
  M.reset(key);
  checkInvariants(M, `${t.key}/${key} t=0`);
  M.step(2 * spd);
  if (t.injury) M.injure();
  M.setDials(dialMin);
  M.step(3 * spd);
  M.setDials(dialMax);
  M.step(3 * spd);
  if (cellDial) { M.setDials({ [cellDial.key]: cellDial.min }); M.step(spd); M.setDials({ [cellDial.key]: cellDial.default }); }
  M.step(spd);
  return M;
}

// ---------------------------------------------------------------- conformance, per tissue
for (const [regKey, t] of Object.entries(CONFORMANCE)) {
  describe(`conformance: ${t.key}${regKey === '_template' ? ' (unregistered starter)' : ''}`, () => {
    test('1. schema: the definition validates and is complete', () => {
      const errors = TissueEngine.validate(t);
      assert.deepEqual(errors, [], `validation errors:\n  ${errors.join('\n  ')}`);
      if (regKey !== '_template') assert.equal(t.key, regKey, 'registry key must equal tissue.key');
      assert.ok(t.scenarios.length >= 2, 'at least two scenarios');
      for (const sc of t.scenarios) assert.ok(Array.isArray(sc.checks) && sc.checks.length > 0, `scenario '${sc.key}' has no checks`);
      assert.ok(t.readouts && t.readouts.length > 0, 'readouts');
      assert.ok(t.copy && t.copy.intro && t.copy.legend && t.copy.vocabulary, 'copy blocks');
      // a way to seed cells: the cellCount dial, or (v0.4) absolute cellTypes[].count values
      assert.ok(t.dials.some((d) => d.role === 'cellCount') || t.cellTypes.some((c) => Number.isInteger(c.count)),
        "a role:'cellCount' dial or cellTypes[].count");
      // the export meta names the dials with roles, and every cell scalar resolves to a label + range
      const meta = engineFor(t).exportMeta();
      assert.equal(meta.loadDial, (t.dials.find((d) => d.role === 'load') || {}).key ?? null, 'meta.loadDial');
      assert.equal(meta.cellCountDial, (t.dials.find((d) => d.role === 'cellCount') || {}).key ?? null, 'meta.cellCountDial');
      assert.equal(meta.engine, ENGINE_VERSION);
      for (const c of t.cellTypes) {
        for (const st of TissueEngine.cellStates(c)) assert.ok(st.range[0] < st.range[1], `cellType '${c.key}' state ${st.key} range`);
        assert.ok(typeof meta.cellTypes.find((m) => m.key === c.key).radius === 'number', `cellType '${c.key}' exports a numeric radius`);
      }
    });

    test('2. determinism: two engines with the same seed agree after 200 steps; a different seed differs', () => {
      const first = t.scenarios[0].key;
      const a = new TissueEngine(t, { seed: 11 }), b = new TissueEngine(t, { seed: 11 }), c = new TissueEngine(t, { seed: 12 });
      for (const M of [a, b, c]) { M.reset(first); M.step(100); if (t.injury) M.injure(); M.step(100); }
      assert.deepEqual(a.stats(), b.stats());
      for (let s = 0; s < a.species.length; s++) assert.deepEqual(a.species[s], b.species[s], `species ${s}`);
      for (let f = 0; f < a.fields.length; f++) assert.deepEqual(a.fields[f], b.fields[f], `field ${f}`);
      assert.deepEqual(a.state.cx, b.state.cx); assert.deepEqual(a.state.ca, b.state.ca); assert.deepEqual(a.Txy, b.Txy);
      assert.deepEqual(a.wound, b.wound);
      assert.notDeepEqual(a.state.cx, c.state.cx, 'different seeds should give different trajectories');
    });

    test('3. invariants: finite, bounded, consistent state through every scenario with dial changes and injury', () => {
      const M = engineFor(t);
      for (const sc of t.scenarios) {
        stressRun(M, sc.key);
        checkInvariants(M, `${t.key}/${sc.key} t=10`);
      }
    });

    for (const sc of t.scenarios) {
      test(`4. checks: scenario '${sc.key}' (${sc.checks.length} checks)`, () => {
        const res = TissueEngine.checkScenario(t, sc.key, { seed: SEED, engine: engineFor(t) });
        const fails = res.filter((r) => !r.pass).map((r) => `at ${r.check.at}: ${r.check.stat} ${r.check.rel ? `${r.check.rel.op} ${r.check.rel.stat}@${r.check.rel.at ?? r.check.at}${r.check.value ? ` + ${r.check.value}` : ''}` : `${r.check.op} ${JSON.stringify(r.check.value)}`} → value ${r.value}, ref ${r.ref}`);
        assert.deepEqual(fails, [], `failed checks:\n  ${fails.join('\n  ')}`);
      });
    }

    test('5. performance: < 1 ms/step at N = 12 with 160 cells (budget 0.5 ms)', () => {
      const M = new TissueEngine(t, { seed: SEED, overrides: { N: 12 } });
      M.reset(t.scenarios[0].key);
      const cellDial = t.dials.find((d) => d.role === 'cellCount');
      if (cellDial) M.setDials({ [cellDial.key]: 160 });
      M.step(200);
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = process.hrtime.bigint(); M.step(500);
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6 / 500);
      }
      console.log(`    ${t.key}: step ${best.toFixed(3)} ms at N=${M.N}, n=${M.nCells}`);
      assert.ok(best < 1, `step too slow: ${best} ms`);
    });
  });
}

// ---------------------------------------------------------------- golden regression (seed 7)
// Two kinds of file, two jobs (docs/REVIEW.md D2):
//   golden/fibrous.json           recorded from v0.1 model.js — "still the same MODEL", 3 % / 0.01
//   golden/<tissue>.engine.json   recorded from this engine (tools/make_golden.mjs) — "still the same
//                                 ARITHMETIC", 1e-5 relative / 1e-7 absolute on every recorded path.
// The suite is tissue-agnostic: a format-2 golden names its own tissue and carries its own runs, so
// recording one for a new tissue is `make_golden --tissue <key> --out tests/golden/<key>.engine.json`
// and NOTHING here — every `tests/golden/*.engine.json` is discovered and registered below.
const goldenSuite = (file, label, tolOf) => describe(`golden regression: tests/golden/${file} (${label})`, () => {
  const golden = JSON.parse(readFileSync(new URL(`./golden/${file}`, import.meta.url), 'utf8'));
  // v0.1 stats names → stat paths; format-2 goldens already use stat paths
  const LEGACY = { meanRho: 'species.total', meanRhoMat: 'species.mat', meanFA: 'fa', meanAlpha: 'cells.a' };
  /** Normalise a run descriptor to { scenario, days, dials, init, events: [{ at, dials | injure }] }. */
  const normalise = (r) => {
    const events = (r.events || []).map((e) => Object.assign({}, e));
    // v0.1 make_golden fired the day-d event BEFORE stepping day d, i.e. when the clock read d − 1
    if (r.injureAt !== undefined) events.push({ at: r.injureAt - 1, injure: { center: [0.5, 0.5, 0.5] } });
    if (r.at) for (const [d, dials] of Object.entries(r.at)) events.push({ at: +d - 1, dials });
    const init = r.init && r.init.rho0 !== undefined ? { species: { new: r.init.rho0, mat: r.init.phiMat0 ? r.init.rho0 * r.init.phiMat0 : 0 } } : r.init;
    return { scenario: r.scenario, days: r.days, dials: r.dials, init, events };
  };
  const tissueKey = golden.tissue || 'fibrous';                 // the v0.1 file predates the key
  const tissue = TISSUES[tissueKey];
  assert.ok(tissue, `${tissueKey} must be registered`);
  const M = new TissueEngine(tissue, { seed: golden.seed });
  const spd = Math.round(1 / M.dt);
  const summary = {};

  for (const [key, raw] of Object.entries(golden.runs)) {
    test(`${tissue.key} run '${key}': ${raw.scenario}, ${raw.days} d, ${raw.rows.length} recorded days`, () => {
      const r = normalise(raw);
      M.reset(r.scenario, { dials: r.dials, init: r.init });
      const fire = (d) => { for (const e of r.events) if (e.at === d) { if (e.dials) M.setDials(e.dials); if (e.injure) M.injure(e.injure.center, e.injure.radius); } };
      const rows = [];
      fire(0); rows.push(M.stats());
      for (let d = 1; d <= r.days; d++) {
        M.step(spd); fire(d);
        if (d % golden.every === 0) rows.push(M.stats());
      }
      assert.equal(rows.length, raw.rows.length, 'row count');
      const worst = {};
      const failures = [];
      for (let i = 0; i < raw.rows.length; i++) {
        const g = raw.rows[i], s = rows[i];
        assert.ok(Math.abs(s.t - g.t) < 1e-6, `time mismatch ${s.t} vs ${g.t}`);
        for (const [gk, gv] of Object.entries(g)) {
          if (gk === 't') continue;
          // a v0.1 golden (no format field) is compared on the four mandated stats only — its
          // deposition/degradation columns are totals over voxels, the engine reports means;
          // a format-2 golden (written by tools/make_golden.mjs) is compared on every recorded stat path
          if (golden.format !== 2 && !LEGACY[gk]) continue;
          const path = LEGACY[gk] || gk;
          const ev = TissueEngine.statFrom(s, path);
          if (ev === undefined) continue;
          const tol = tolOf(gv);
          const err = Math.abs(ev - gv), rel = Math.abs(gv) > 1e-9 ? err / Math.abs(gv) : 0;
          if (!worst[path] || rel > worst[path]) worst[path] = rel;
          if (err > tol) failures.push(`t=${g.t} ${path}: golden ${gv.toFixed(5)} engine ${ev.toFixed(5)} (rel ${(100 * rel).toFixed(2)} %)`);
        }
      }
      summary[key] = worst;
      console.log(`    ${key}: max rel error ${Object.entries(worst).map(([k, v]) => `${k} ${(100 * v).toFixed(2)} %`).join(', ')}`);
      assert.deepEqual(failures, [], `golden mismatch:\n  ${failures.join('\n  ')}`);
    });
  }
});
// tests/golden/fibrous.json is the one hand-named file: it is the v0.1 model.js reference, not an
// engine recording, and it is compared at the looser tolerance.
goldenSuite('fibrous.json', 'v0.1 model.js, 3 %', (gv) => Math.max(0.01, 0.03 * Math.abs(gv)));
// Every engine golden in tests/golden/ runs itself: `node tools/make_golden.mjs --tissue <key> --out
// tests/golden/<key>.engine.json` is the whole recipe for adding one (docs/EXTENDING.md §7), and a
// golden left behind for a tissue that is no longer registered fails loudly rather than silently.
const engineGoldens = readdirSync(new URL('./golden/', import.meta.url)).filter((f) => f.endsWith('.engine.json')).sort();
assert.ok(engineGoldens.length, 'tests/golden/ must carry at least one <tissue>.engine.json');
for (const file of engineGoldens) goldenSuite(file, 'this engine, 1e-5', (gv) => Math.max(1e-7, 1e-5 * Math.abs(gv)));

// ---------------------------------------------------------------- engine API (using fibrous)
describe('engine API', () => {
  const t = TISSUES.fibrous;

  test('PRNG is deterministic and in [0,1); tmClamp / tmRoundArray helpers', () => {
    const a = mulberry32(123), b = mulberry32(123);
    for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
    assert.equal(tmClamp(5, 0, 1), 1); assert.equal(tmClamp(-1, 0, 1), 0); assert.equal(tmClamp(0.5, 0, 1), 0.5);
    assert.deepEqual(tmRoundArray(new Float32Array([0.12345, 1.5]), 2), [0.12, 1.5]);
    assert.equal(typeof ENGINE_VERSION, 'string'); assert.equal(ENGINE_DEFAULTS.N, 12);
  });

  test('registry: TISSUE_DEFAULT is registered and every entry validates', () => {
    assert.ok(TISSUES[TISSUE_DEFAULT]);
    for (const [k, def] of Object.entries(TISSUES)) { assert.equal(def.key, k); assert.deepEqual(TissueEngine.validate(def), []); }
  });

  test('validate() rejects broken definitions', () => {
    const bad = Object.assign({}, t, { species: [{ key: 'x', label: 'x', kind: 'goo', color: 'red' }], scenarios: [Object.assign({}, t.scenarios[0], { checks: [{ at: 5, stat: 'species.nope', op: 'gt', value: 1 }] })] });
    const errors = TissueEngine.validate(bad);
    assert.ok(errors.some((e) => /kind/.test(e)) && errors.some((e) => /color/.test(e)) && errors.some((e) => /species.nope/.test(e)), errors.join('; '));
    assert.throws(() => new TissueEngine(bad), /invalid tissue definition/);
  });

  test('constructor resets to the first scenario; indices are exposed', () => {
    const M = new TissueEngine(t, { seed: SEED });
    assert.equal(M.scenario, t.scenarios[0].key);
    assert.deepEqual(M.speciesIndex, { new: 0, mat: 1 }); assert.deepEqual(M.fieldIndex, { g: 0, m: 1 });
    assert.deepEqual(M.dialIndex, { Gext: 0, strain: 1, protease: 2, nCells: 3 });
    assert.equal(M.tissue, t);
    assert.deepEqual(M.dials, { Gext: 0.5, strain: 0.6, protease: 0.4, nCells: 160 });
    assert.ok(Math.abs(M.stats().species.total - 0.15) < 0.02);
    assert.equal(M.stats().fields.g, 0.5, 'bath field starts at the bath dial value');
  });

  test('stat(path) resolves every §1 path and rejects unknown ones', () => {
    const M = engineFor(t); M.reset('maturation'); M.step(50);
    const s = M.stats();
    const paths = ['species.new', 'species.mat', 'species.new.fraction', 'species.mat.fraction', 'species.total', 'fiber.total', 'fa', 'globalFA', 'fz',
      'logE', 'E', 'cells.a', 'cells.b', 'cells.c', 'cells.n', 'fields.g', 'fields.m', 'deposition', 'degradation', 'ratio', 't'];
    for (const p of paths) { const v = M.stat(p); assert.ok(Number.isFinite(v), `${p} = ${v}`); assert.equal(v, TissueEngine.statFrom(s, p)); }
    assert.ok(Math.abs(s.species.total - (s.species.new + s.species.mat)) < 1e-9);
    assert.ok(Math.abs(s.fraction.new + s.fraction.mat - 1) < 1e-9);
    assert.equal(s.species.fiberTotal, s.species.total);
    assert.ok(s.deposition > 0 && s.deposition < 1, 'deposition is a MEAN per-voxel rate (v0.1 totals were ~40)');
    assert.ok(Math.abs(s.ratio - s.deposition / s.degradation) < 1e-12);
    assert.throws(() => M.stat('species.bogus'), /unknown stat path/);
    assert.throws(() => M.stat('nonsense'), /unknown stat path/);
  });

  test('setDials adds/removes cells, clamps to capacity, keeps the views consistent', () => {
    const M = new TissueEngine(t, { seed: SEED }); M.reset('sandbox');
    assert.equal(M.state.nCells, 160);
    M.setDials({ nCells: 300 });
    assert.equal(M.nCells, 300); assert.equal(M.state.cx.length, 900); assert.equal(M.state.ca.length, 300); assert.equal(M.state.ctype.length, 300);
    M.step(5);
    M.setDials({ nCells: 40 });
    assert.equal(M.state.cp.length, 120); assert.equal(M.dials.nCells, 40);
    M.setDials({ nCells: 10000 });
    assert.equal(M.nCells, M.cap, 'clamped to capacity');
    M.step(5);
    checkInvariants(M, 'after cell count changes');
    assert.equal(M.setDials({ Gext: 0.9, bogus: 1 }).Gext, 0.9);
    assert.equal(M._dialVals[M.dialIndex.Gext], 0.9, 'dial array used by the hooks follows');
  });

  test('init.from: pre-run is cached per (scenario, days, seed) and reproducible; overrides work', () => {
    const M = new TissueEngine(t, { seed: SEED });
    const t0 = process.hrtime.bigint(); M.reset('unloading');
    const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
    const a = Float32Array.from(M.species[1]);
    assert.equal(M.dials.strain, 0); assert.ok(M.stats().species.total > 0.6, 'starts matured');
    const t1 = process.hrtime.bigint(); M.reset('unloading');
    const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.deepEqual(M.species[1], a, 'same matured state on the second reset');
    assert.ok(ms2 < ms1 / 5, `second reset should hit the cache (${ms1.toFixed(0)} ms → ${ms2.toFixed(1)} ms)`);
    assert.equal(M._fromCache.size, 1);
    M.reset('wound'); assert.equal(M._fromCache.size, 1, 'wound shares the maturation/60 pre-run');
    assert.ok(Math.abs(M.stats().species.total - 0.997) < 0.03);
    console.log(`    matured-state pre-run: ${ms1.toFixed(0)} ms (first call)`);
    // overrides
    M.reset('sandbox', { dials: { Gext: 0, strain: 0, protease: 0 }, init: { species: { new: 0.15 } } });
    assert.deepEqual(M.dials, { Gext: 0, strain: 0, protease: 0, nCells: 160 });
    assert.ok(Math.abs(M.stats().species.total - 0.15) < 0.02);
    assert.equal(M.stats().fields.g, 0);
  });

  test('injure(): empties the sphere, bursts the fields, arms inflammation; the wound refills with immature, less aligned matrix', () => {
    const M = engineFor(t); M.reset('wound');
    const spd = Math.round(1 / M.dt);
    M.step(5 * spd);
    const pre = M.stats();
    const w = M.injure([0.5, 0.5, 0.5]);
    assert.ok(w && w.nVox > 20 && w.radius === t.injury.radius);
    const ws = M.woundStats(), hit = M.stats();
    assert.ok(ws.species.total < 0.01, `wound total right after injury ${ws.species.total}`);
    assert.ok(hit.fields.g > pre.fields.g && hit.fields.m > pre.fields.m, 'burst of growth factor and protease');
    assert.ok(hit.fa < pre.fa - 0.01, 'global FA dips');
    let infl = 0; for (let v = 0; v < M.NV; v++) infl += M.inflam[v]; assert.equal(infl, w.nVox, 'inflammation armed in the wound');
    M.step(21 * spd);
    const w21 = M.woundStats(), s21 = M.stats();
    assert.ok(w21.species.total > 0.35, `wound refills: ${w21.species.total}`);
    assert.ok(w21.fraction.mat < s21.fraction.mat - 0.1, `wound matrix immature: ${w21.fraction.mat} vs ${s21.fraction.mat}`);
    assert.ok(w21.fa < s21.fa - 0.05, `wound matrix less aligned: ${w21.fa} vs ${s21.fa}`);
    const M2 = new TissueEngine(t, { seed: 5 }); M2.reset('maturation');
    const rw = M2.injure();
    assert.ok(rw.center.every((c) => c >= 0.25 && c <= 0.75), 'random centre stays away from the walls');
    assert.equal(new TissueEngine(TISSUE_TEMPLATE, { seed: 1 }).injure(), null, 'no injury block → null');
  });

  test('checkScenario applies events (fibrosis Gext drop at day 45) and evaluates rel checks', () => {
    const M = engineFor(t);
    const res = TissueEngine.checkScenario(t, 'fibrosis', { seed: SEED, engine: M });
    assert.equal(M.dials.Gext, 0.2, 'event applied');
    assert.ok(res.every((r) => typeof r.pass === 'boolean' && Number.isFinite(r.value)));
    const rel = res.find((r) => r.check.rel);
    assert.ok(rel && Number.isFinite(rel.ref));
  });

  test('snapshot() / exportMeta() have the format-2 shape (with format-1 aliases)', () => {
    const M = engineFor(t); M.reset('maturation'); M.step(10);
    const f = M.snapshot(), NV = M.NV, n = M.nCells;
    assert.deepEqual(Object.keys(f.species), ['new', 'mat']);
    assert.equal(f.species.new.length, NV); assert.equal(f.fa.length, NV); assert.equal(f.f.length, 3 * NV);
    assert.equal(f.rho.length, NV); assert.equal(f.phiMat.length, NV);
    for (let v = 0; v < NV; v++) assert.ok(Math.abs(f.rho[v] - (f.species.new[v] + f.species.mat[v])) < 2e-3, 'rho = fiber total');
    assert.equal(f.cells.x.length, 3 * n); assert.equal(f.cells.p.length, 3 * n);
    assert.equal(f.cells.a.length, n); assert.equal(f.cells.b.length, n); assert.equal(f.cells.c.length, n); assert.equal(f.cells.type.length, n);
    assert.deepEqual(f.cells.alpha, f.cells.a);
    assert.ok(f.rho.every(Number.isFinite) && f.f.every(Number.isFinite) && typeof f.t === 'number');
    const meta = M.exportMeta({ exportEveryDays: 2 });
    assert.equal(meta.format, 2); assert.equal(meta.tissue, 'fibrous'); assert.equal(meta.exportEveryDays, 2);
    for (const k of ['N', 'L', 'K', 'dtDays', 'scenario', 'dials', 'species', 'cellTypes']) assert.ok(k in meta, `meta.${k}`);
    assert.deepEqual(meta.species.map((s) => s.key), ['new', 'mat']);
    assert.deepEqual(Object.keys(meta.cellTypes[0]).sort(), ['colors', 'key', 'label', 'radius', 'shape']);
    assert.ok(JSON.stringify({ meta, frames: [f] }).length > 1000);
  });

  test('state exposes the contract arrays', () => {
    const M = engineFor(t); M.reset('maturation');
    const s = M.state;
    for (const k of ['N', 'L', 'h', 'time', 'dt', 'dials', 'nCells', 'wound', 'tissue', 'species', 'speciesKeys', 'Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz',
      'fiberTotal', 'fa', 'fx', 'fy', 'fz', 'E', 'inflam', 'fields', 'fieldKeys', 'cx', 'cp', 'ca', 'cb', 'cc', 'ctype']) assert.ok(k in s, `state.${k}`);
    assert.equal(s.tissue, 'fibrous'); assert.deepEqual(s.speciesKeys, ['new', 'mat']); assert.deepEqual(s.fieldKeys, ['g', 'm']);
    assert.equal(s.species.length, 2); assert.equal(s.fields.length, 2); assert.ok(s.ctype instanceof Uint8Array);
    M.step(1);
    assert.equal(M.state.fields, s.fields, 'fields array identity is stable across the buffer swap');
  });

  test('FA is 0 for an isotropic tensor and 1 for a single axis; principal axis follows the tensor', () => {
    const M = new TissueEngine(t, { seed: SEED }); M.reset('sandbox');
    const v = 5, w = 6;
    M.Txx[v] = 0.2; M.Tyy[v] = 0.2; M.Tzz[v] = 0.2; M.Txy[v] = 0; M.Txz[v] = 0; M.Tyz[v] = 0;
    M.Txx[w] = 0; M.Tyy[w] = 0; M.Tzz[w] = 0.5; M.Txy[w] = 0; M.Txz[w] = 0; M.Tyz[w] = 0;
    M.fx[w] = 0.3; M.fy[w] = 0.2; M.fz[w] = 0.93;
    M._derived();
    assert.ok(M.fa[v] < 1e-6, `isotropic FA = ${M.fa[v]}`);
    assert.ok(Math.abs(M.fa[w] - 1) < 1e-5, `uniaxial FA = ${M.fa[w]}`);
    assert.ok(Math.abs(Math.abs(M.fz[w]) - 1) < 1e-3, 'principal axis should be z');
  });

  test('protease dial 1 vs 0 gives clearly different plateaus; Gext 0.2 gives a much lower plateau', () => {
    const run = (dials, days = 60) => { const M = new TissueEngine(t, { seed: SEED }); M.reset('maturation', { dials }); M.step(days * Math.round(1 / M.dt)); return M.stats().species.total; };
    const p0 = run({ protease: 0 }), p1 = run({ protease: 1 });
    assert.ok(p1 < 0.5 * p0 && p0 > 0.6, `protease 1: ${p1}, protease 0: ${p0}`);
    const lo = run({ Gext: 0.2 }, 90), hi = run({}, 90);
    assert.ok(lo < 0.5 * hi, `lowG ${lo} vs ${hi}`);
  });
});

// ---------------------------------------------------------------- v0.3 contract features (docs/EXTENDING.md §2, §7)
// A throw-away fixture tissue that opts into every v0.3 feature: species transport (D, sink),
// per-species deposition orientation (polS / alignS), extra per-voxel accumulators (out.vox),
// the scaffold flux bar (out.scaffoldLoss), transport hindrance (out.mobility), `states` and a
// state-dependent radius. Nothing here is registered, so the conformance suite above is untouched.
const LAB = {
  key: 'lab', name: 'Lab bench', short: 'exercises the v0.3 engine features', version: '0.3.0',
  species: [
    { key: 'scaf', label: 'Scaffold', kind: 'scaffold', color: '#9ec5d8' },
    { key: 'gag', label: 'Gel', kind: 'gel', color: '#7fe0c9', D: 0.05, sink: 0.8, boundary: 'face:+z' },
    { key: 'felt', label: 'Isotropic fiber', kind: 'fiber', color: '#e8f1f8', D: 0.02 },
    { key: 'rope', label: 'Aligned fiber', kind: 'fiber', color: '#e0a24a' },
  ],
  fields: [{ key: 'g', label: 'Growth factor', color: '#3fd6c4', D: 0.05, bath: 'Gext', kBath: 4, decay: 0 }],
  cellTypes: [
    { key: 'cell', label: 'Builder', colors: ['#4ea3ff', '#ff7a3d'],
      shape: { by: 'a', aspectMin: 2.0, aspectMax: 1.0 },              // aspectMin > aspectMax is legal
      radius: { by: 'a', min: 0.028, max: 0.04 }, motile: true,
      init: { a: 0.3, b: 0, c: 0 },
      states: [{ key: 'a', label: 'activation' }, { key: 'c', label: 'pericellular pool', range: [0, 2] }] },
  ],
  dials: [
    { key: 'Gext', label: 'Growth-factor bath', min: 0, max: 1, step: 0.01, default: 0.6, format: 'fixed2' },
    { key: 'load', label: 'Load', min: 0, max: 1, step: 0.01, default: 0.4, format: 'percent', role: 'load' },
    { key: 'nCells', label: 'Cells', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount' },
  ],
  scenarios: [
    { key: 'grow', title: 'Grow', goal: 'g', steps: ['a'], question: 'q', expect: 'e',
      dials: { Gext: 0.6, load: 0.4, nCells: 160 },
      init: { species: { scaf: 0.8, gag: 0.05 }, jitter: 0.1 },
      events: [{ at: 5, dials: { Gext: 0.1 } }],
      checks: [
        { at: 20, stat: 'species.gag', op: 'gt', value: 0.05 },
        { at: [10, 20], agg: 'min', stat: 'logE', op: 'gt', value: -1 },
        { at: [10, 20], agg: 'mean', stat: 'species.tissueTotal', op: 'gt', value: 0 },
        { at: [0, 20], agg: 'first', stat: 'species.scaf', op: 'between', value: [0.75, 0.85] },
        { at: 20, stat: 'cumDegradation', rel: { stat: 'cumDeposition', op: 'lt' } },
      ] },
    { key: 'after', title: 'After', goal: 'g', steps: ['a'], question: 'q', expect: 'e',
      dials: { Gext: 0.2, load: 0, nCells: 160 },
      init: { from: { scenario: 'grow', days: 10, events: true, dials: { Gext: 0.9 } } },
      checks: [{ at: 5, stat: 'species.total', op: 'gt', value: 0 }] },
  ],
  readouts: [{ key: 'flux', label: 'Flux', unit: 'per day', meaning: 'm', type: 'flux' }],
  copy: { intro: { tagline: 't', paragraphs: ['p'] }, legend: { fibers: 'f', cells: 'c' },
    vocabulary: { matrix: 'matrix', cellsActive: 'cells build', cellsQuiet: 'cells rest' } },
  engine: { N: 8, dt: 0.02, vox: 3 },
  params: { kHyd: 0.05, sGag: 0.6, sFelt: 0.12, sRope: 0.1, kLoss: 0.05 },
  makeRules(engine, p) {
    const iScaf = engine.speciesIndex.scaf, iGag = engine.speciesIndex.gag;
    const iFelt = engine.speciesIndex.felt, iRope = engine.speciesIndex.rope, iG = engine.fieldIndex.g;
    const sc = engine.scratch;                       // makeRules may allocate per reset and cache here
    sc.calls = (sc.calls || 0) + 1;
    return {
      cell(ctx) {
        const out = ctx.out, a = Math.min(1, ctx.a + (ctx.field[iG] - ctx.a) * ctx.dt);
        out.a = a;
        out.secrete[iGag] = p.sGag * a; out.secrete[iFelt] = p.sFelt * a; out.secrete[iRope] = p.sRope * a;
        out.usePolS = true;                          // per-species orientation
        out.polS[iFelt] = 0; out.polS[iRope] = 0.95;
        out.alignS[iFelt] = 0; out.alignS[iRope] = 0.6;
        out.vox[1] = a * a;                          // accumulator 1: Σ a² of the cells here
        out.vox[2] = 1;                              // accumulator 2: our own cell count
        out.fieldSrc[iG] = 2 * a;
        out.speed = 0.2; out.guide = 2; out.noise = 1.5;
      },
      voxel(ctx) {
        const out = ctx.out, rho = ctx.rho, scaf = rho[iScaf];
        const hyd = p.kHyd * scaf;
        out.dRho[iScaf] = -hyd;
        out.scaffoldLoss = hyd;                      // a third flux bar: neither deposition nor degradation
        for (const i of [iGag, iFelt, iRope]) out.dRho[i] = -p.kLoss * rho[i];
        out.loss = p.kLoss * (rho[iGag] + rho[iFelt] + rho[iRope]);
        out.mobility = 1 - (scaf > 1 ? 1 : scaf);    // a tight scaffold hinders transport
        out.E = 0.3 + 5 * scaf + 20 * (rho[iGag] + rho[iFelt] + rho[iRope]) ** 2;
      },
    };
  },
};

/** A lab engine with inert rules, so a test can drive one mechanism at a time. */
function labBare(overrides = {}, mobility = 1) {
  const M = new TissueEngine(LAB, { seed: 3 });
  M.reset('grow', Object.assign({ dials: { nCells: 40 } }, overrides));
  M.species.forEach((a) => a.fill(0));
  M.rules.cell = () => {};
  M.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.mobility = mobility; };
  return M;
}

describe('engine v0.3: species transport, per-species orientation, accumulators', () => {
  test('validate() accepts the opt-in fixture and every new field', () => {
    assert.deepEqual(TissueEngine.validate(LAB), []);
    const M = new TissueEngine(LAB, { seed: 3 });
    assert.equal(M.nVox, 3, 'engine.vox');
    assert.equal(M._typeCMax[0], 2, 'states.c.range sets the c clamp');
    assert.ok(M.scratch && typeof M.scratch === 'object', 'engine.scratch exists for makeRules');
    assert.ok(M.scratch.calls >= 1, 'makeRules cached on engine.scratch');
  });

  test('species D: 6-neighbour diffusion, zero-flux walls, mass conserved away from the sink', () => {
    const M = labBare();
    const N = M.N, iGag = M.speciesIndex.gag, mid = ((3 * N) + 3) * N + 3;
    M.species[iGag][mid] = 1;
    const before = M.species[iGag].reduce((a, b) => a + b, 0);
    M.step(8);
    const g = M.species[iGag], after = g.reduce((a, b) => a + b, 0);
    assert.ok(g[mid] < 1 && g[mid + 1] > 1e-3, `spike spreads: ${g[mid]} / ${g[mid + 1]}`);
    assert.ok(Math.abs(after - before) < 1e-3, `mass conserved: ${before} → ${after}`);
    const N2 = N * N;
    assert.equal(g[mid + N2], g[mid + N], 'isotropic: the +x and +y neighbours are identical');
    assert.equal(g[mid - N2], g[mid - N], 'and so are the −x and −y ones');
    // an explicit scheme with the diffusion number clamped at 1/6 can never go negative or oscillate
    for (let v = 0; v < M.NV; v++) assert.ok(g[v] >= 0 && g[v] <= 1, `bounded at ${v}: ${g[v]}`);
  });

  test('species sink: the +z layer loses sink·rho·dt·mobility and it counts as degradation', () => {
    // The mesh gates the leak exactly as it gates diffusion. Sink without D, so the closed form
    // is exact: a mobility of m loses (1 − m·sink·dt) of the face layer per step, and nothing else.
    const t = Object.assign({}, LAB, { species: LAB.species.map((s) => (s.key === 'gag' ? Object.assign({}, s, { D: 0 }) : s)) });
    assert.deepEqual(TissueEngine.validate(t), [], 'fixture valid');
    const dt = LAB.engine.dt;
    const top = (mob) => {
      const M = new TissueEngine(t, { seed: 3 });
      M.reset('grow', { dials: { nCells: 40 } });
      M.species.forEach((a) => a.fill(0));
      M.rules.cell = () => {};
      M.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.mobility = mob; };
      M.species[M.speciesIndex.gag].fill(0.5);
      M.step(5);
      return { g: M.species[M.speciesIndex.gag], s: M.stats(), N: M.N };
    };
    const sealed = top(0);                            // a sealed mesh keeps the aggrecan in
    assert.equal(sealed.g[sealed.N - 1], 0.5, 'mobility 0 holds the face layer');
    assert.equal(sealed.s.degradation, 0, 'and nothing reaches the flux gauge');
    const open = top(1);                              // mobility 1 (the default) → the v0.3 arithmetic
    const N = open.N, g = open.g;
    assert.ok(Math.abs(g[N - 1] - 0.5 * (1 - 0.8 * dt) ** 5) < 1e-6, `top layer ${g[N - 1]}`);
    assert.equal(g[0], 0.5, 'every other layer is untouched');
    const s = open.s;
    assert.ok(s.degradation > 0 && s.cumDegradation > 0, 'sink loss reaches the flux gauge');
    assert.ok(Math.abs(s.cumDegradation - s.degradation * 5 * dt) / s.cumDegradation < 0.05, 'cumDegradation is its integral');
    const half = top(0.5);
    assert.ok(Math.abs(half.g[N - 1] - 0.5 * (1 - 0.5 * 0.8 * dt) ** 5) < 1e-6, `half-open mesh: ${half.g[N - 1]}`);
  });

  test('a fiber species with carryTensor: false travels as a felt (T is not carried)', () => {
    const build = (carryTensor) => {
      const sp = LAB.species.map((s) => (s.key === 'felt' ? Object.assign({}, s, { carryTensor }) : s));
      const t = Object.assign({}, LAB, { species: sp });
      assert.deepEqual(TissueEngine.validate(t), [], 'fixture valid');
      const M = new TissueEngine(t, { seed: 3 });
      M.reset('grow', { dials: { nCells: 40, load: 0 } });     // load 0: no passive alignment
      M.species.forEach((a) => a.fill(0));
      M.rules.cell = () => {};
      M.rules.voxel = (ctx) => { ctx.out.E = 1; };
      const N = M.N, v = ((3 * N) + 3) * N + 3, w = v + 1;
      for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz']) M[k].fill(0);
      M.species[M.speciesIndex.felt][v] = 1; M.Tzz[v] = 1;      // one voxel of z-aligned fiber
      M._derived();
      M.step(10);
      const trW = M.Txx[w] + M.Tyy[w] + M.Tzz[w];
      return { M, v, w, trW, fzShare: trW > 0 ? M.Tzz[w] / trW : 0, mass: M.species[M.speciesIndex.felt][w] };
    };
    const carried = build(true), felt = build(false);
    assert.ok(Math.abs(carried.mass - felt.mass) < 1e-9, 'the same mass moves either way');
    assert.ok(Math.abs(felt.trW - felt.mass) < 1e-5, 'trace(T) still equals the fiber total');
    assert.ok(carried.fzShare > 0.9, 'carried: it arrives aligned');
    assert.ok(Math.abs(felt.fzShare - 1 / 3) < 1e-3, `felt: it arrives isotropic (${felt.fzShare})`);
    assert.ok(felt.M.fa[felt.w] < 0.05, 'and adds no anisotropy to the neighbour');
    assert.equal(felt.M._tDelta, null, 'no tensor-flux buffer is allocated when nothing carries T');
    assert.ok(TissueEngine.validate(Object.assign({}, LAB, {
      species: LAB.species.map((s) => (s.key === 'gag' ? Object.assign({}, s, { carryTensor: false }) : s)),
    })).some((e) => /carryTensor only applies to a kind:'fiber' species/.test(e)));
  });

  test("out.scaffoldLoss is clamped to what the voxel actually gave up", () => {
    const M = labBare({}, 0);
    const iScaf = M.speciesIndex.scaf;
    M.species[iScaf].fill(0.01);
    // a hook that asks for far more dissolution than there is scaffold left
    M.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.mobility = 0; ctx.out.dRho[iScaf] = -50; ctx.out.scaffoldLoss = 50; };
    M.step(1);
    const s = M.stats();
    assert.equal(s.scaffold, 0, 'the scaffold is gone');
    assert.ok(Math.abs(s.scaffoldFlux - 0.01 / M.dt) < 1e-6, `the flux bar reports 0.01/dt, not 50 (${s.scaffoldFlux})`);
    M.step(1);
    assert.equal(M.stats().scaffoldFlux, 0, 'and nothing at all once the network has gone');
  });

  test('a fiber species carries the orientation tensor with it (trace stays exact)', () => {
    const M = labBare();
    const N = M.N, iFelt = M.speciesIndex.felt, v = ((3 * N) + 3) * N + 3, w = v + 1;
    for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz']) M[k].fill(0);
    M.species[iFelt][v] = 1; M.Tzz[v] = 1;            // one voxel of perfectly z-aligned fiber
    M._derived();
    M.step(10);
    const trV = M.Txx[v] + M.Tyy[v] + M.Tzz[v], trW = M.Txx[w] + M.Tyy[w] + M.Tzz[w];
    assert.ok(Math.abs(trV - M.species[iFelt][v]) < 1e-5, 'trace(T) = fiber total at the source');
    assert.ok(Math.abs(trW - M.species[iFelt][w]) < 1e-5, 'trace(T) = fiber total at the neighbour');
    assert.ok(M.species[iFelt][w] > 1e-3, 'the neighbour received fiber');
    assert.ok(M.fa[w] > 0.9 && M.Tzz[w] / trW > 0.9, `it arrived aligned, not isotropic (FA ${M.fa[w]})`);
    assert.ok(Math.abs(M.fz[w]) > 0.99, 'the principal axis followed');
  });

  test('out.mobility hinders transport (a tight mesh holds matrix where it was made)', () => {
    const spread = (mob) => {
      const M = labBare({}, mob);
      const N = M.N, mid = ((3 * N) + 3) * N + 3;
      M.species[M.speciesIndex.gag][mid] = 1;
      M.step(20);
      return M.species[M.speciesIndex.gag][mid];
    };
    assert.ok(spread(0.05) > spread(1) + 0.1, 'mobility 0.05 keeps the spike, mobility 1 spreads it');
  });

  test('out.polS / out.alignS: each fiber species is deposited with its own orientation', () => {
    // one pinned cell polarised along z, secreting 3 parts isotropic felt to 1 part axial rope
    const build = (mode) => {
      const M = new TissueEngine(LAB, { seed: 3 });
      M.reset('grow', { dials: { nCells: 40, load: 0 }, init: { species: {} } });   // load 0: no passive alignment
      M.species.forEach((a) => a.fill(0));
      for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz']) M[k].fill(0);
      const iFelt = M.speciesIndex.felt, iRope = M.speciesIndex.rope;
      M.nCells = 1; M._cx[0] = 0.5; M._cx[1] = 0.5; M._cx[2] = 0.5;
      M._cp[0] = 0; M._cp[1] = 0; M._cp[2] = 1;
      M.rules.cell = (ctx) => {
        ctx.out.secrete[iFelt] = 3; ctx.out.secrete[iRope] = 1;
        if (mode === 'polS') { ctx.out.usePolS = true; ctx.out.polS[iFelt] = 0; ctx.out.polS[iRope] = 1; }
        else ctx.out.pol = mode;
        ctx.out.speed = 0; ctx.out.guide = 0; ctx.out.noise = 0;
      };
      M.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.mobility = 0; };
      M.step(10);
      const v = (4 * M.N + 4) * M.N + 4;
      return M.Tzz[v] / (M.Txx[v] + M.Tyy[v] + M.Tzz[v]);
    };
    const exact = 1 / 4 + (3 / 4) / 3;                // rope fully axial + felt isotropic
    assert.ok(Math.abs(build('polS') - exact) < 1e-6, `polS is exact: ${build('polS')} vs ${exact}`);
    assert.ok(Math.abs(build(1) - 1) < 1e-6, 'one scalar pol has to mix the two rates');
    assert.ok(Math.abs(build(0.25) - exact) < 1e-6, 'the deposition-weighted scalar reproduces it only by hand');
  });

  test('out.alignS is applied as one density-weighted realignment rate; NaN falls back to the scalars', () => {
    const run = (write) => {
      const M = new TissueEngine(LAB, { seed: 3 });
      M.reset('grow', { dials: { nCells: 40, load: 0 }, init: { species: {} } });
      M.species.forEach((a) => a.fill(0));
      for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz']) M[k].fill(0);
      const iFelt = M.speciesIndex.felt;
      M.nCells = 1; M._cx[0] = 0.5; M._cx[1] = 0.5; M._cx[2] = 0.5;
      M._cp[0] = 0; M._cp[1] = 0; M._cp[2] = 1;
      M.rules.cell = (ctx) => { ctx.out.secrete[iFelt] = 1; ctx.out.pol = 0; ctx.out.align = 2; write(ctx.out, iFelt); ctx.out.speed = 0; ctx.out.guide = 0; ctx.out.noise = 0; };
      M.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.mobility = 0; };
      M.step(10);
      const v = (4 * M.N + 4) * M.N + 4;
      return M.fa[v];
    };
    const scalar = run(() => {});                                            // align 2 through out.align
    const perSpecies = run((o, i) => { o.usePolS = true; o.alignS[i] = 2; }); // the same through alignS
    const off = run((o, i) => { o.usePolS = true; o.alignS[i] = 0; });        // explicitly no realignment
    const fallback = run((o) => { o.usePolS = true; });                       // all NaN → out.align
    assert.ok(Math.abs(scalar - perSpecies) < 1e-9, `alignS[s] = out.align gives the same tensor (${scalar} vs ${perSpecies})`);
    assert.ok(off < scalar - 0.2, `alignS 0 realigns nothing (FA ${off} vs ${scalar})`);
    assert.ok(Math.abs(fallback - scalar) < 1e-9, 'a NaN entry falls back to the scalar out.align');
  });

  test('out.vox[k]: extra per-voxel accumulators reach voxel(); vox[0] stays the aSum alias', () => {
    const M = new TissueEngine(LAB, { seed: 3 });
    M.reset('grow');
    let seen = null, cells = 0;
    const base = M.rules.voxel;
    M.rules.voxel = (ctx) => {
      base(ctx);
      cells += ctx.vox[2];
      if (seen === null && ctx.nCellsHere === 1) seen = { v0: ctx.vox[0], v1: ctx.vox[1], v2: ctx.vox[2], aSum: ctx.aSum };
    };
    M.step(1);
    assert.ok(Math.abs(cells - M.nCells) < 1e-9, `Σ vox[2] = cell count (${cells} vs ${M.nCells})`);
    assert.equal(seen.v0, seen.aSum, 'ctx.vox[0] IS ctx.aSum');
    assert.equal(seen.v2, 1, 'one cell in this voxel');
    assert.ok(Math.abs(seen.v1 - seen.v0 * seen.v0) < 1e-9, 'vox[1] carries Σ a² (one cell here)');
    // the default of accumulator 0 is unchanged: out.aSum, else the cell's new a
    const F = new TissueEngine(TISSUES.fibrous, { seed: SEED });
    F.reset('maturation');
    let sum = 0, n = 0;
    const vb = F.rules.voxel;
    F.rules.voxel = (ctx) => { vb(ctx); if (ctx.nCellsHere > 0) { sum += ctx.aSum / ctx.nCellsHere; n++; } };
    F.step(1);
    assert.ok(n > 0 && Math.abs(sum / n - F.stats().cells.a) < 0.02, 'fibrous still gets mean a through aSum');
  });

  test('stats(): scaffold, species.tissueTotal, scaffoldFlux and the cumulative integrals', () => {
    const M = new TissueEngine(LAB, { seed: 3 });
    M.reset('grow');
    const s0 = M.stats();
    assert.equal(s0.cumDeposition, 0); assert.equal(s0.cumDegradation, 0);
    M.step(50);
    const s = M.stats();
    assert.ok(Math.abs(s.scaffold - s.species.scaf) < 1e-12, 'scaffold = Σ scaffold species');
    assert.ok(Math.abs(s.species.tissueTotal - (s.species.total - s.species.scaf)) < 1e-12, 'tissueTotal excludes it');
    assert.ok(s.species.total > s.species.tissueTotal, 'species.total still includes the scaffold');
    assert.ok(Math.abs(s.scaffoldFlux - 0.05 * s.species.scaf) < 2e-3, `scaffoldFlux ≈ kHyd·scaf (${s.scaffoldFlux})`);
    assert.ok(s.degradation < s.scaffoldFlux, 'scaffold dissolution is not degradation');
    assert.ok(s.cumDeposition > 0 && s.cumDegradation > 0 && s.cumDeposition > s.cumDegradation);
    for (const p of ['scaffold', 'scaffoldFlux', 'species.tissueTotal', 'cumDeposition', 'cumDegradation']) {
      assert.ok(Number.isFinite(M.stat(p)), p);
      assert.equal(M.stat(p), TissueEngine.statFrom(s, p));
    }
    M.reset('grow');
    assert.equal(M.stats().cumDeposition, 0, 'the integrals restart on reset');
  });

  test('checkScenario: aggregated checks sample every 0.5 d inside the window', () => {
    const res = TissueEngine.checkScenario(LAB, 'grow', { seed: 5 });
    assert.ok(res.every((r) => r.pass), res.filter((r) => !r.pass).map((r) => `${JSON.stringify(r.check.at)} ${r.check.stat} ${r.value}`).join('; '));
    const mn = res.find((r) => r.check.agg === 'min'), mean = res.find((r) => r.check.agg === 'mean'), first = res.find((r) => r.check.agg === 'first');
    // re-sample the run by hand, every 0.5 d, and aggregate the same way
    const M = new TissueEngine(LAB, { seed: 5 });
    M.reset('grow');
    const half = Math.round(1 / M.dt) / 2, logE = [], tissue = [];
    for (let i = 0; i <= 40; i++) {
      if (i === 10) M.setDials({ Gext: 0.1 });                    // the scenario's day-5 event
      logE.push(M.stat('logE')); tissue.push(M.stat('species.tissueTotal'));
      M.step(half);
    }
    const win = (a) => a.slice(20, 41);                           // days 10 … 20 inclusive
    assert.ok(Math.abs(mn.value - Math.min(...win(logE))) < 1e-9, `'min' is the min of the 21 samples (${mn.value})`);
    assert.ok(mn.value < win(logE)[0], 'and it is not simply the first sample');
    const wt = win(tissue), avg = wt.reduce((x, y) => x + y, 0) / wt.length;
    assert.ok(Math.abs(mean.value - avg) < 1e-9, `'mean' averages the same samples (${mean.value} vs ${avg})`);
    assert.ok(Math.abs(first.value - 0.8) < 0.02, `'first' is the value at the start of the range (${first.value})`);
  });

  test('init.from: `events` replays the source scenario, `dials` overrides its dials, both are cached', () => {
    const M = new TissueEngine(LAB, { seed: 5 });
    M.reset('after');
    const withEvents = M.stats().species.total;
    assert.equal(M._fromCache.size, 1);
    M.reset('after');
    assert.equal(M._fromCache.size, 1, 'the pre-run is cached');
    const variant = (from) => {
      const alt = Object.assign({}, LAB, { scenarios: LAB.scenarios.map((s) => (s.key === 'after' ? Object.assign({}, s, { init: { from } }) : s)) });
      const E = new TissueEngine(alt, { seed: 5 });
      E.reset('after');
      return E.stats().species.total;
    };
    const noEvents = variant({ scenario: 'grow', days: 10, dials: { Gext: 0.9 } });
    const starved = variant({ scenario: 'grow', days: 10, events: true, dials: { Gext: 0 } });
    assert.ok(Math.abs(withEvents - noEvents) > 1e-3, `events: the day-5 Gext drop is replayed (${withEvents} vs ${noEvents})`);
    assert.ok(starved < withEvents, `dials: a starved pre-run hands over less (${starved} vs ${withEvents})`);
    assert.deepEqual(TissueEngine.validate(Object.assign({}, LAB, {
      scenarios: LAB.scenarios.map((s) => (s.key === 'after' ? Object.assign({}, s, { init: { from: { scenario: 'grow', days: 10, events: 'yes', dials: { nope: 1 } } } }) : s)),
    })).sort(), ["scenario 'after' init.from.dials: unknown dial 'nope'", "scenario 'after' init.from.events must be a boolean"]);
  });

  test('exportMeta(): loadDial / cellCountDial, and a state-dependent radius keeps a format-2 number', () => {
    const M = new TissueEngine(LAB, { seed: 3 });
    const meta = M.exportMeta();
    assert.equal(meta.loadDial, 'load'); assert.equal(meta.cellCountDial, 'nCells');
    assert.equal(meta.engine, ENGINE_VERSION);
    assert.equal(meta.cellTypes[0].radius, 0.028, 'the state-0 radius, for readers that expect a number');
    assert.deepEqual(meta.cellTypes[0].radiusBy, { by: 'a', min: 0.028, max: 0.04 });
    const F = new TissueEngine(TISSUES.fibrous, { seed: SEED }).exportMeta();
    assert.equal(F.loadDial, 'strain'); assert.equal(F.cellCountDial, 'nCells');
    assert.equal(F.cellTypes[0].radius, 0.03); assert.ok(!('radiusBy' in F.cellTypes[0]), 'a plain radius stays plain');
    const T = new TissueEngine(TISSUE_TEMPLATE, { seed: 1 }).exportMeta();
    assert.equal(T.loadDial, 'strain');
  });

  test('cellStates() merges `states` with the stateLabels / cRange aliases', () => {
    const merged = TissueEngine.cellStates(LAB.cellTypes[0]);
    assert.deepEqual(merged, [{ key: 'a', label: 'activation', range: [0, 1] }, { key: 'c', label: 'pericellular pool', range: [0, 2] }]);
    const legacy = TissueEngine.cellStates({ stateLabels: { a: 'activation', b: null, c: 'pool' }, cRange: [0, 3] });
    assert.deepEqual(legacy, [{ key: 'a', label: 'activation', range: [0, 1] }, { key: 'c', label: 'pool', range: [0, 3] }]);
    assert.deepEqual(TissueEngine.cellStates({}), [{ key: 'a', label: null, range: [0, 1] }]);
  });

  test('validate() rejects the new fields when they are malformed', () => {
    const bend = (patch) => TissueEngine.validate(Object.assign({}, LAB, patch));
    const has = (errors, re) => errors.some((e) => re.test(e));
    assert.ok(has(bend({ species: [{ key: 'total', label: 'x', kind: 'gel', color: '#ffffff' }] }), /reserved/), 'species key total');
    assert.ok(has(bend({ species: [{ key: 'a', label: 'x', kind: 'gel', color: '#ffffff', D: -1 }] }), /D must be/), 'negative D');
    assert.ok(has(bend({ species: [{ key: 'a', label: 'x', kind: 'gel', color: '#ffffff', sink: 'lots' }] }), /sink must be/), 'sink');
    assert.ok(has(bend({ species: [{ key: 'a', label: 'x', kind: 'gel', color: '#ffffff', boundary: 'face:-z' }] }), /boundary must be/), 'species boundary');
    assert.ok(has(bend({ engine: { vox: 9 } }), /engine\.vox/), 'engine.vox range');
    assert.ok(has(bend({ cellTypes: [Object.assign({}, LAB.cellTypes[0], { radius: { by: 'c', min: 1, max: 2 } })] }), /radius object/), 'radius.by');
    assert.ok(has(bend({ cellTypes: [Object.assign({}, LAB.cellTypes[0], { radius: 'big' })] }), /radius must be/), 'radius type');
    assert.ok(has(bend({ cellTypes: [Object.assign({}, LAB.cellTypes[0], { states: [{ key: 'b', label: 'x', range: [0, 4] }] })] }), /must be \[0, 1\]/), 'only c may be re-ranged');
    assert.ok(has(bend({ cellTypes: [Object.assign({}, LAB.cellTypes[0], { cRange: [0, 3] })] }), /disagree/), 'states.c vs cRange');
    const win = (at, agg) => bend({ scenarios: LAB.scenarios.map((s) => (s.key === 'grow' ? Object.assign({}, s, { checks: [{ at, agg, stat: 'fa', op: 'gt', value: 0 }] }) : s)) });
    assert.ok(has(win([10, 5], 'min'), /from ≤ to/), 'reversed at');
    assert.ok(has(win([10, 20], 'median'), /agg min\|max\|mean\|first/), 'unknown agg');
    assert.ok(has(win(10, 'min'), /agg only applies/), 'agg without a range');
    assert.deepEqual(TissueEngine.validate(LAB), [], 'the fixture itself stays valid');
  });
});

// ---------------------------------------------------------------- v0.4 engine work package A
// A throw-away fixture with one mechanism wired at a time (nothing here is registered, so the
// conformance suite above is untouched). `o` overrides any block of the definition.
function bench(o = {}) {
  return Object.assign({
    key: 'bench', name: 'Bench tissue', short: 'one mechanism at a time', version: '0.4.0',
    species: [{ key: 'x', label: 'X', kind: 'gel', color: '#888888' }],
    fields: [],
    cellTypes: [{ key: 'c', label: 'C', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.01, motile: true }],
    dials: [{ key: 'bath', label: 'Bath', min: 0, max: 1, step: 0.01, default: 1, format: 'fixed2' },
      { key: 'nCells', label: 'Cells', min: 0, max: 400, step: 1, default: 0, format: 'cells', role: 'cellCount' }],
    scenarios: [{ key: 'run', title: 'Run', goal: 'g', steps: ['a'], question: 'q', expect: 'e',
      dials: {}, init: { species: {} }, checks: [{ at: 1, stat: 'fa', op: 'lt', value: 2 }] }],
    readouts: [{ key: 'flux', label: 'Flux', unit: 'per day', meaning: 'm', type: 'flux' }],
    copy: { intro: { tagline: 't', paragraphs: ['p'] }, legend: { fibers: 'f', cells: 'c' },
      vocabulary: { matrix: 'matrix', cellsActive: 'active', cellsQuiet: 'quiet' } },
    engine: {}, params: {},
    makeRules: () => ({ cell(ctx) { ctx.out.speed = 0; }, voxel(ctx) { ctx.out.E = 1; } }),
  }, o);
}
/** A bench engine carrying one field, with `rule` writing its sources in the voxel hook. */
function fieldBench(field, engine, rule) {
  const t = bench({ fields: [field], engine });
  assert.deepEqual(TissueEngine.validate(t), [], 'fixture valid');
  const M = new TissueEngine(t, { seed: 1 });
  M.reset('run');
  if (rule) M.rules.voxel = (ctx) => { ctx.out.E = 1; rule(ctx); };
  return M;
}
const pick = (m) => ({ mode: m.mode, nSub: m.nSub });
const zColumn = (M, f = 0) => { const N = M.N, out = []; for (let k = 0; k < N; k++) out.push(M.fields[f][(((N >> 1) * N) + (N >> 1)) * N + k]); return out; };

describe('engine A1: the field solver picks an integration mode instead of clamping D', () => {
  test('the mode follows lam = D·dt/h² and the definition may override it', () => {
    // fibrous: lam = 0.05·0.02/(1/12)² = 0.144 ≤ 1/6 → the explicit v0.3 path, unchanged
    const F = new TissueEngine(TISSUES.fibrous, { seed: SEED });
    for (const m of F.fieldModes) { assert.equal(m.mode, 'explicit'); assert.equal(m.nSub, 1); assert.ok(Math.abs(m.lam - 0.144) < 1e-9, `lam ${m.lam}`); }
    const fld = (D, extra) => Object.assign({ key: 'g', label: 'G', color: '#3fd6c4', D, bath: null, kBath: 0, decay: 1 }, extra);
    const modeOf = (D, extra, engine) => fieldBench(fld(D, extra), Object.assign({ N: 16, dt: 0.05, L: 1 }, engine)).fieldModes[0];
    assert.deepEqual(pick(modeOf(0.01)), { mode: 'explicit', nSub: 1 }, 'lam 0.128 stays explicit');
    assert.deepEqual(pick(modeOf(0.05)), { mode: 'subcycled', nSub: 4 }, 'lam 0.64 → ceil(6·lam) sub-steps');
    assert.deepEqual(pick(modeOf(0.5)), { mode: 'quasiSteady', nSub: 1 }, 'lam 6.4 would need 39 sub-steps → steady solve');
    assert.deepEqual(pick(modeOf(5)), { mode: 'quasiSteady', nSub: 1 }, 'lam 64 → far too fast to integrate');
    // …but only when the steady problem is well posed; otherwise it sub-cycles as far as the cap
    assert.deepEqual(pick(modeOf(0.5, { decay: 0 })), { mode: 'subcycled', nSub: 20 }, 'no decay, no bath, no face: 39 wanted, capped at 20');
    // explicit overrides
    assert.deepEqual(pick(modeOf(5, { mode: 'explicit' })), { mode: 'explicit', nSub: 1 }, "mode 'explicit' keeps the v0.3 clamp");
    assert.deepEqual(pick(modeOf(5, { mode: 'subcycled' })), { mode: 'subcycled', nSub: 20 }, "mode 'subcycled' never goes steady");
    assert.deepEqual(pick(modeOf(0.05, { mode: 'quasiSteady' })), { mode: 'quasiSteady', nSub: 1 }, 'a slow field may still be solved steady');
    // a steady solve needs somewhere for the flux to go: no face, no bath, no decay → sub-cycle
    assert.deepEqual(pick(modeOf(5, { mode: 'quasiSteady', decay: 0 })), { mode: 'subcycled', nSub: 20 }, 'quasiSteady falls back when it is not well posed');
    assert.ok(TissueEngine.warnings(bench({ fields: [fld(0.5, { decay: 0 })], engine: { N: 16, dt: 0.05 } }))[0].includes('capped at 20'), 'and the cap is reported');
    assert.deepEqual(pick(modeOf(5, { decay: 0, bath: 'bath', kBath: 2 })), { mode: 'quasiSteady', nSub: 1 }, 'a bath relaxation makes it well posed');
    // species transport gets the same treatment (but never a steady solve: transport moves mass)
    const sp = (D, mode) => new TissueEngine(bench({ species: [{ key: 'x', label: 'X', kind: 'gel', color: '#888888', D, mode }], engine: { N: 16, dt: 0.05 } }), { seed: 1 }).speciesModes[0];
    assert.deepEqual(pick(sp(0.01)), { mode: 'explicit', nSub: 1 });
    assert.deepEqual(pick(sp(0.05)), { mode: 'subcycled', nSub: 4 });
    assert.deepEqual(pick(sp(5, 'explicit')), { mode: 'explicit', nSub: 1 });
    // and the schema knows the new keys
    assert.ok(TissueEngine.validate(bench({ fields: [fld(1, { mode: 'sometimes' })] })).some((e) => /mode must be auto\|explicit\|subcycled\|quasiSteady/.test(e)));
    assert.ok(TissueEngine.validate(bench({ species: [{ key: 'x', label: 'X', kind: 'gel', color: '#888888', D: 1, mode: 'quasiSteady' }] })).some((e) => /no quasiSteady/.test(e)));
  });

  test('a plane source with decay reaches the analytic decay length √(D/decay) (N=16, dt=0.05)', () => {
    // steady state of ∂g/∂t = D∇²g − k·g with a source in the z = 0 layer: g ∝ exp(−z/ℓ), ℓ = √(D/k).
    // On the 6-neighbour stencil the exact discrete length is h / acosh(1 + h²k/2D).
    const measure = (D, k, mode) => {
      const N = 16, h = 1 / N;
      const M = fieldBench({ key: 'g', label: 'G', color: '#3fd6c4', D, bath: null, kBath: 0, decay: k, mode },
        { N, dt: 0.05, L: 1 }, (ctx) => { if (ctx.v % N === 0) ctx.out.fieldSrc[0] = 100; });
      M.step(600);
      const col = zColumn(M);
      return { mode: M.fieldModes[0].mode, ell: h / Math.log(col[3] / col[4]), col };
    };
    const cont = Math.sqrt(0.05 / 3.2);                                  // 0.125
    const disc = (1 / 16) / Math.acosh(1 + (1 / 256) * 3.2 / (2 * 0.05)); // 0.12628 (same for the ×100 pair)
    const sub = measure(0.05, 3.2);            // lam 0.64 → sub-cycled
    const qs = measure(5, 320);                // lam 64, same ℓ → quasi-steady
    assert.equal(sub.mode, 'subcycled'); assert.equal(qs.mode, 'quasiSteady');
    assert.ok(Math.abs(sub.ell - cont) / cont < 0.02, `sub-cycled ℓ ${sub.ell} vs analytic ${cont}`);
    assert.ok(Math.abs(qs.ell - cont) / cont < 0.02, `quasi-steady ℓ ${qs.ell} vs analytic ${cont}`);
    assert.ok(Math.abs(sub.ell - disc) / disc < 1e-3, `sub-cycled ℓ ${sub.ell} vs the exact discrete ${disc}`);
    assert.ok(Math.abs(qs.ell - sub.ell) / sub.ell < 1e-3, 'the two modes agree with each other');
    // this is the A1 defect: one explicit step with lam clamped at 1/6 integrates a much smaller D
    const clamped = measure(0.05, 3.2, 'explicit');
    assert.equal(clamped.mode, 'explicit');
    assert.ok(clamped.ell < 0.6 * cont, `the clamped mode is ~2× short: ${clamped.ell}`);
    for (const c of [...sub.col, ...qs.col, ...clamped.col]) assert.ok(Number.isFinite(c) && c >= 0);
  });

  test('a face-fed field with uniform consumption settles on the steady parabola', () => {
    // 0 = D∇²g − q with zero flux at z = 0 and the top LAYER held at the bath value g0:
    // g(z) = g0 + q/(2D)·(z² − zTop²) at the voxel centres z = (k+½)h, zTop = (N−½)h — and that is
    // the exact solution of the discrete stencil too, so the check can be tight.
    const run = (D, q, N, dt) => {
      const M = fieldBench({ key: 'o2', label: 'O₂', color: '#6f9ce8', D, bath: 'bath', kBath: 0, decay: 0, boundary: 'face:+z' },
        { N, dt, L: 1 }, (ctx) => { ctx.out.fieldSrc[0] = -q; });
      M.setDials({ bath: 1 });
      M.step(Math.round(40 / dt));
      const h = 1 / N, zTop = (N - 0.5) * h, col = zColumn(M);
      let worst = 0;
      for (let k = 0; k < N; k++) {
        const z = (k + 0.5) * h;
        worst = Math.max(worst, Math.abs(col[k] - (1 + (q / (2 * D)) * (z * z - zTop * zTop))));
      }
      return { mode: M.fieldModes[0].mode, worst, top: col[N - 1], monotone: col.every((v, k) => k === 0 || v >= col[k - 1]) };
    };
    const sub = run(0.06, 0.02, 12, 0.02);      // cartilage-like O₂: lam 0.173 → 2 sub-steps
    const qs = run(1000, 300, 12, 0.02);        // physiological O₂: lam 2880 → steady solve
    assert.equal(sub.mode, 'subcycled'); assert.equal(qs.mode, 'quasiSteady');
    assert.ok(sub.worst < 1e-3, `sub-cycled parabola off by ${sub.worst}`);
    assert.ok(qs.worst < 1e-3, `quasi-steady parabola off by ${qs.worst}`);
    assert.equal(sub.top, 1); assert.equal(qs.top, 1, 'the Dirichlet layer stays at the bath value (1 is exact in float32)');
    assert.ok(sub.monotone && qs.monotone, 'oxygen falls away from the medium face');
  });

  test('the quasi-steady solve handles a saturating consumption that exhausts the field', () => {
    // Michaelis-Menten uptake makes the source depend on the field, so the solve is a lagged
    // fixed point. Compare with a Newton solve of the same nonlinear discrete steady problem.
    const N = 12, h = 1 / N, D = 1, q = 20, Km = 0.02, bath = 0.24, c = D / (h * h);
    const M = fieldBench({ key: 'o2', label: 'O₂', color: '#6f9ce8', D, bath: 'bath', kBath: 0, decay: 0, boundary: 'face:+z', mode: 'quasiSteady' },
      { N, dt: 0.02, L: 1 }, (ctx) => { const o = ctx.field[0]; ctx.out.fieldSrc[0] = -q * o / (o + Km); });
    M.setDials({ bath });
    M.step(2000);
    const col = zColumn(M);
    for (let v = 0; v < M.NV; v++) assert.ok(M.fields[0][v] >= 0 && Number.isFinite(M.fields[0][v]), 'field stays ≥ 0 and finite');
    assert.ok(Math.abs(col[N - 1] - bath) < 1e-6, 'the medium face is held at the bath value');
    assert.ok(col.every((v, k) => k === 0 || v >= col[k - 1] - 1e-6), 'monotone toward the medium face');
    // Newton solve of c·(Σ neighbours − cnt·g) = q·g/(g+Km) on the same stencil (1-D in z)
    const g = new Float64Array(N).fill(0.1); g[N - 1] = bath;
    for (let it = 0; it < 4000; it++) {
      for (let k = 0; k < N - 1; k++) {
        const sg = (k > 0 ? g[k - 1] : 0) + g[k + 1], cnt = k > 0 ? 2 : 1;
        let x = g[k];
        for (let s = 0; s < 60; s++) {
          const f = c * (sg - cnt * x) - q * x / (x + Km);
          const nx = Math.max(0, x - f / (-c * cnt - q * Km / ((x + Km) * (x + Km))));
          if (Math.abs(nx - x) < 1e-15) { x = nx; break; }
          x = nx;
        }
        g[k] = x;
      }
    }
    for (let k = N - 3; k < N; k++) assert.ok(Math.abs(col[k] - g[k]) < 0.05 * g[k] + 1e-3, `layer ${k}: solver ${col[k]} vs Newton ${g[k]}`);
    assert.ok(col[0] < 0.01 * bath, `the deep half is starved (${col[0]})`);
  });

  test('validate() prints only the notes with an action attached; warnings() still has them all', () => {
    const warned = [];
    const real = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      // a healthy quasi-steady field: correctly integrated, nothing to do about it → not printed
      const t = bench({ fields: [{ key: 'o2', label: 'O₂', color: '#6f9ce8', D: 5, bath: 'bath', kBath: 0, decay: 0, boundary: 'face:+z' }], engine: { N: 16, dt: 0.05 } });
      assert.deepEqual(TissueEngine.validate(t), []);
      new TissueEngine(t, { seed: 1 });
      assert.deepEqual(warned, [], `a clean quasiSteady field prints nothing: ${warned.join(' | ')}`);
      const note = TissueEngine.warnings(t)[0];
      assert.match(note, /field 'o2'/); assert.match(note, /lam = D·dt\/h² = 64/); assert.match(note, /quasiSteady/);
      assert.equal(TissueEngine.notes(t)[0].actionable, false);
      // a clean sub-cycle is the same: cartilage's o2 must not warn on every load (it is correct)
      const sub = bench({ fields: [{ key: 'o2', label: 'O₂', color: '#6f9ce8', D: 0.06, bath: 'bath', kBath: 0, decay: 0, boundary: 'face:+z' }], engine: { N: 12, dt: 0.02 } });
      TissueEngine.validate(sub); new TissueEngine(sub, { seed: 1 });
      assert.deepEqual(warned, [], 'a clean sub-cycle prints nothing either');
      assert.match(TissueEngine.warnings(sub)[0], /subcycled/);
      assert.deepEqual(TissueEngine.warnings(TISSUES.cartilage).filter((w) => /field 'o2'/.test(w)).length, 1, 'but it is on record as a note');
      // …while a definition that asks for 'explicit' above the limit IS running a different D
      const clamp = bench({ fields: [{ key: 'g', label: 'G', color: '#3fd6c4', D: 5, bath: null, kBath: 0, decay: 1, mode: 'explicit' }], engine: { N: 16, dt: 0.05 } });
      assert.deepEqual(TissueEngine.validate(clamp), []);
      assert.equal(warned.length, 1, `warned once, got ${warned.length}: ${warned.join(' | ')}`);
      assert.match(warned[0], /CLAMPED at 1\/6/);
      TissueEngine.validate(clamp);
      assert.equal(warned.length, 1, 'validating the same definition again is silent');
      // so is a capped sub-cycle and a quasiSteady request that could not be honoured
      const capped = bench({ fields: [{ key: 'g', label: 'G', color: '#3fd6c4', D: 0.5, bath: null, kBath: 0, decay: 0 }], engine: { N: 16, dt: 0.05 } });
      TissueEngine.validate(capped);
      assert.match(warned[1], /capped at 20/);
      const fell = bench({ fields: [{ key: 'g', label: 'G', color: '#3fd6c4', D: 0.05, bath: null, kBath: 0, decay: 0, mode: 'quasiSteady' }], engine: { N: 16, dt: 0.05 } });
      TissueEngine.validate(fell);
      assert.match(warned[2], /needs a Dirichlet face/);
      // and the overrides the engine will really run with are the ones reported
      const w = TissueEngine.warnings(TISSUES.fibrous, { overrides: { dt: 0.2 } });
      assert.ok(w.some((x) => /field 'g'.*subcycled/.test(x)), w.join(' | '));
      assert.deepEqual(TissueEngine.warnings(TISSUES.fibrous), [], 'fibrous as built is quiet');
    } finally { console.warn = real; }
  });

  test("a mode: 'subcycled' below the stability limit is reported as it was asked for", () => {
    // one sub-step of dt IS an explicit step, so the arithmetic is identical — but `fieldModes` is
    // the only way an author can confirm the engine honoured the definition, so it must not lie.
    const fld = (mode) => ({ key: 'g', label: 'G', color: '#3fd6c4', D: 0.01, bath: null, kBath: 0, decay: 1, mode });
    const M = (mode) => new TissueEngine(bench({ fields: [fld(mode)], engine: { N: 16, dt: 0.05, L: 1 } }), { seed: 1 });
    const auto = M(undefined), asked = M('subcycled');
    assert.deepEqual(pick(auto.fieldModes[0]), { mode: 'explicit', nSub: 1 }, 'lam 0.128: auto stays explicit');
    assert.deepEqual(pick(asked.fieldModes[0]), { mode: 'subcycled', nSub: 1 }, 'and a request for sub-cycling reads back as sub-cycled');
    auto.rules.voxel = (ctx) => { ctx.out.E = 1; ctx.out.fieldSrc[0] = ctx.v % 16 === 0 ? 100 : 0; };
    asked.rules.voxel = auto.rules.voxel;
    auto.step(50); asked.step(50);
    for (let v = 0; v < auto.NV; v++) assert.equal(auto.fields[0][v], asked.fields[0][v], 'the arithmetic is identical');
    assert.equal(TissueEngine.notes(bench({ fields: [fld('subcycled')], engine: { N: 16, dt: 0.05 } }))[0].actionable, false);
  });

  test('the quasi-steady solve reaches a decay-only uniform steady state, not just a small increment', () => {
    // src/decay everywhere is the exact solution of the discrete problem too (∇²g = 0), and this is
    // the configuration where the per-sweep increment is LEAST like an error bound: the constant
    // mode is nearly singular, so a fixed 1e-4 increment test stops ~100× short of it.
    const N = 12, dt = 0.05, D = 5, decay = 4, src = 8;
    const M = fieldBench({ key: 'g', label: 'G', color: '#3fd6c4', D, bath: null, kBath: 0, decay },
      { N, dt, L: 1 }, (ctx) => { ctx.out.fieldSrc[0] = src; });
    assert.equal(M.fieldModes[0].mode, 'quasiSteady');
    M.step(50);
    const col = zColumn(M), exact = src / decay;
    for (const v of col) assert.ok(Math.abs(v - exact) < 1e-3, `after 50 steps: ${v} vs ${exact}`);
    M.step(350);
    assert.ok(Math.abs(zColumn(M)[N >> 1] - exact) < 1e-4, 'and it keeps closing on it');
  });
});

describe('engine A2: resumable init.from pre-runs (warmFrom / warmScenarios)', () => {
  const t = TISSUES.fibrous;
  const from = t.scenarios.find((s) => s.key === 'unloading').init.from;

  test('warmFrom in 500-step slices lands on exactly the synchronous pre-run', () => {
    const sync = new TissueEngine(t, { seed: SEED });
    sync.reset('unloading');
    const warm = new TissueEngine(t, { seed: SEED });
    const slices = [];
    for (let i = 0; i < 7; i++) slices.push(warm.warmFrom(from, 500));
    assert.equal(slices.filter((r) => !r.done).length, 5, 'six slices of 500 cover the 3000-step pre-run');
    assert.equal(slices.reduce((a, r) => a + r.steps, 0), 3000, 'and no step is run twice');
    assert.equal(slices[6].steps, 0, 'calling again once it is warm does nothing');
    assert.equal(warm._fromCache.size, 1);
    assert.equal(warm._warm.size, 0, 'the partial pre-run is dropped once it is cached');
    const t0 = process.hrtime.bigint();
    warm.reset('unloading');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 60, `the reset was served from the cache (${ms.toFixed(0)} ms)`);
    for (let s = 0; s < sync.species.length; s++) assert.deepEqual(warm.species[s], sync.species[s], `species ${s}`);
    for (let f = 0; f < sync.fields.length; f++) assert.deepEqual(warm.fields[f], sync.fields[f], `field ${f}`);
    for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz', 'fa', 'fx', 'fy', 'fz', 'E']) assert.deepEqual(warm[k], sync[k], k);
    assert.deepEqual(warm.state.cx, sync.state.cx); assert.deepEqual(warm.state.cp, sync.state.cp);
    assert.deepEqual(warm.state.ca, sync.state.ca); assert.deepEqual(warm.stats(), sync.stats());
  });

  test('warmScenarios walks the tissue and reports when everything is cached', () => {
    const M = new TissueEngine(t, { seed: SEED });
    let calls = 0, r;
    do { r = M.warmScenarios(400); calls++; } while (!r.done && calls < 50);
    assert.ok(r.done && calls > 1, `finished after ${calls} calls`);
    assert.equal(M._fromCache.size, 1, 'unloading and wound share one maturation/60 pre-run');
    assert.deepEqual(M.warmScenarios(400), { done: true, scenario: null, steps: 0, remaining: 0 }, 'idempotent once warm');
    const before = M.stats();
    M.warmScenarios(400);
    assert.deepEqual(M.stats(), before, 'warming never touches the engine that is being watched');
    // events are replayed on the same day boundaries as the synchronous pre-run
    const ev = { scenario: 'fibrosis', days: 50, events: true };
    const a = new TissueEngine(t, { seed: SEED }), b = new TissueEngine(t, { seed: SEED });
    a.warmFrom(ev, Infinity);
    while (!b.warmFrom(ev, 137).done);
    assert.deepEqual(b._fromCache.get(b._fromKey(ev)).species[1], a._fromCache.get(a._fromKey(ev)).species[1]);
  });
});

describe('engine A4/A5/B1/E1/E5: load mode, cell types, revision, export', () => {
  test('engine.loadMode: tension aligns the tensor with z, compression with the plane ⊥ to it', () => {
    const fz = (loadMode) => {
      const M = new TissueEngine(TISSUES.fibrous, { seed: SEED, overrides: loadMode ? { loadMode } : {} });
      M.reset('maturation');
      M.step(40 * Math.round(1 / M.dt));
      return M.stats().fz;
    };
    const tension = fz(), compression = fz('compression');
    assert.equal(fz(), fz('tension'), "'tension' is the default and changes nothing");
    assert.ok(tension > 0.4, `tension pulls the tensor onto z (fz ${tension})`);
    assert.ok(compression < 1 / 3, `compression pushes it off z (fz ${compression})`);
    assert.ok(TissueEngine.validate(bench({ engine: { loadMode: 'shear' } })).some((e) => /loadMode/.test(e)));
    assert.deepEqual(TissueEngine.validate(bench({ engine: { loadMode: 'compression' } })), []);
  });

  test('cellTypes[].motile is optional and defaults to true (docs/EXTENDING.md §1)', () => {
    const { motile, ...noMotile } = bench().cellTypes[0];       // the same type with the key dropped
    assert.equal(motile, true, 'the fixture declares it, so dropping it is the interesting case');
    const bare = bench({ cellTypes: [noMotile] });
    assert.deepEqual(TissueEngine.validate(bare), [], 'an omitted `motile` is not an error — the upgrade table says to drop it');
    assert.ok(TissueEngine.validate(bench({ cellTypes: [Object.assign({}, noMotile, { motile: 'yes' })] })).some((e) => /motile must be a boolean/.test(e)),
      'but a non-boolean still is');
    // and the cell that comes out moves, exactly as `motile: true` would
    const rules = () => ({ cell(ctx) { ctx.out.speed = 0.5; }, voxel(ctx) { ctx.out.E = 1; } });
    const walk = (types) => {
      const M = new TissueEngine(bench({ cellTypes: types, makeRules: rules }), { seed: 3 });
      M.reset('run', { dials: { nCells: 8 } });
      const x0 = Float64Array.from(M.state.cx);
      M.step(20);
      const x1 = M.state.cx;
      let moved = 0;
      for (let i = 0; i < x0.length; i++) moved += Math.abs(x1[i] - x0[i]);
      return moved;
    };
    assert.ok(walk([noMotile]) > 0, 'a cell type without the key is motile');
    assert.equal(walk([noMotile]), walk([Object.assign({}, noMotile, { motile: true })]),
      'and moves bit-for-bit as `motile: true` does');
  });

  test("cellTypes[].motile: false pins a cell in place, including under repulsion", () => {
    const types = [
      { key: 'walker', label: 'Walker', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.02, motile: true, fraction: 1 },
      { key: 'anchor', label: 'Anchor', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.02, motile: false, fraction: 1 },
    ];
    const t = bench({ cellTypes: types, makeRules: () => ({ cell(ctx) { ctx.out.speed = 0.4; ctx.out.noise = 2; }, voxel(ctx) { ctx.out.E = 1; } }) });
    const M = new TissueEngine(t, { seed: 4 });
    M.reset('run', { dials: { nCells: 60 } });
    const x0 = Float32Array.from(M.state.cx), p0 = Float32Array.from(M.state.cp), ty = Uint8Array.from(M.state.ctype);
    M.step(200);
    let moved = 0, still = 0;
    for (let i = 0; i < M.nCells; i++) {
      const d = Math.hypot(M.state.cx[3 * i] - x0[3 * i], M.state.cx[3 * i + 1] - x0[3 * i + 1], M.state.cx[3 * i + 2] - x0[3 * i + 2]);
      if (ty[i] === 1) { assert.equal(d, 0, `anchored cell ${i} moved by ${d}`); still++; } else if (d > 0.05) moved++;
    }
    assert.ok(still > 20 && moved > 20, `${still} anchored, ${moved} walkers moved`);
    for (let i = 0; i < M.nCells; i++) if (ty[i] === 1) for (let d = 0; d < 3; d++) assert.equal(M.state.cp[3 * i + d], p0[3 * i + d], 'and its polarity is untouched');
    // an overlapping pair: only the motile partner is pushed away
    const P = new TissueEngine(t, { seed: 4 });
    P.reset('run', { dials: { nCells: 2 } });
    P.rules.cell = (ctx) => { ctx.out.speed = 0; ctx.out.noise = 0; };
    P._cx.set([0.5, 0.5, 0.5, 0.51, 0.5, 0.5]);
    const anchor = P.state.ctype[0] === 1 ? 0 : 1, walker = 1 - anchor;
    const at0 = [P.state.cx[0], P.state.cx[3]];
    P.step(1);
    assert.equal(P.state.cx[3 * anchor], at0[anchor], 'the anchor stayed');
    assert.ok(Math.abs(P.state.cx[3 * walker] - at0[walker]) > 1e-4, 'the walker was pushed');
  });

  test('cellTypes[].count seeds an absolute number and survives the cell-count dial', () => {
    const types = [
      { key: 'pinned', label: 'Pinned', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.01, motile: true, count: 10 },
      { key: 'rest', label: 'Rest', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.01, motile: true },
    ];
    const M = new TissueEngine(bench({ cellTypes: types }), { seed: 4 });
    M.reset('run', { dials: { nCells: 40 } });
    const n = () => { const b = M.stats().cells.byType; return [b.pinned.n, b.rest.n]; };
    assert.deepEqual(n(), [10, 30], 'the counted type is seeded first, the rest share what is left');
    M.setDials({ nCells: 20 });
    assert.deepEqual(n(), [10, 10], 'shrinking the total only removes cells that are above target');
    M.setDials({ nCells: 40 });
    assert.deepEqual(n(), [10, 30]);
    M.setDials({ nCells: 6 });
    assert.deepEqual(n(), [6, 0], 'a total below the declared count scales the counted type down');
    // without any count the share array IS the fraction array: the v0.3 seeding path is untouched
    const plain = new TissueEngine(TISSUES.fibrous, { seed: SEED });
    assert.equal(plain._typeShare, plain._typeFraction);
    assert.ok(TissueEngine.validate(bench({ cellTypes: [Object.assign({}, types[0], { count: 2.5 })] })).some((e) => /count must be an integer/.test(e)));
    assert.ok(TissueEngine.validate(bench({ cellTypes: [Object.assign({}, types[0], { fraction: 1 })] })).some((e) => /both count and fraction/.test(e)));
    assert.ok(TissueEngine.warnings(bench({ cellTypes: types })).some((w) => /cellCount' dial and cellTypes\[\]\.count/.test(w)));
  });

  test('cellTypes[].rCell: per-type repulsion radius, with a warning when it no longer fits a voxel', () => {
    const mk = (rCell) => bench({
      cellTypes: [{ key: 'big', label: 'Big', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.01, motile: true, rCell }],
      makeRules: () => ({ cell(ctx) { ctx.out.speed = 0; }, voxel(ctx) { ctx.out.E = 1; } }),
    });
    const gap = (rCell) => {
      const M = new TissueEngine(mk(rCell), { seed: 4 });
      M.reset('run', { dials: { nCells: 2 } });
      M._cx.set([0.5, 0.5, 0.5, 0.55, 0.5, 0.5]);
      M.step(1);
      return M.state.cx[3] - M.state.cx[0];
    };
    // pair at 0.05 apart, kRep 0.5: a contact distance d0 opens the gap by kRep·(d0 − d)/d·d
    assert.ok(Math.abs(gap(0.01) - 0.05) < 1e-6, 'contact distance 0.02 < 0.05: the pair is left alone');
    assert.ok(Math.abs(gap(0.03) - 0.055) < 1e-6, 'rCell 0.03 = the engine default → the v0.3 push');
    assert.ok(Math.abs(gap(0.04) - 0.065) < 1e-6, 'a larger per-type radius pushes harder');
    assert.deepEqual(TissueEngine.warnings(mk(0.03)), [], 'the default fits inside a voxel');
    assert.ok(TissueEngine.warnings(mk(0.05)).some((w) => /27-bin neighbour search/.test(w)), '2·0.05 ≥ h = 1/12');
    assert.ok(TissueEngine.validate(mk(-1)).some((e) => /rCell must be/.test(e)));
  });

  test('stats().cells.byType and its stat paths', () => {
    const M = engineFor(TISSUES.fibrous); M.reset('maturation'); M.step(20);
    const s = M.stats();
    assert.deepEqual(Object.keys(s.cells.byType), ['fibroblast']);
    assert.equal(s.cells.byType.fibroblast.n, s.cells.n);
    assert.equal(s.cells.byType.fibroblast.a, s.cells.a);
    assert.equal(M.stat('cells.byType.fibroblast'), s.cells.n, 'the bare path is the count');
    assert.equal(M.stat('cells.byType.fibroblast.a'), s.cells.a);
    assert.equal(TissueEngine.statFrom(s, 'cells.byType.nope'), undefined);
    assert.throws(() => M.stat('cells.byType.nope.a'), /unknown stat path/);
    // a scenario check may use the path
    assert.deepEqual(TissueEngine.validate(Object.assign({}, TISSUES.fibrous, {
      scenarios: TISSUES.fibrous.scenarios.map((sc, i) => (i ? sc : Object.assign({}, sc, { checks: [{ at: 5, stat: 'cells.byType.fibroblast.a', op: 'gt', value: 0 }] }))),
    })), []);
  });

  test('state.revision is bumped by step / reset / injure / setDials (B1)', () => {
    const M = new TissueEngine(TISSUES.fibrous, { seed: SEED });
    const r = () => M.state.revision;
    const r0 = r();
    assert.ok(Number.isInteger(r0) && r0 > 0);
    M.step(1); assert.equal(r(), r0 + 1);
    M.step(5); assert.equal(r(), r0 + 6, 'one per simulated step');
    M.setDials({ Gext: 0.7 }); assert.equal(r(), r0 + 7);
    M.setDials({ nope: 1 }); assert.equal(r(), r0 + 7, 'an unknown dial changes nothing');
    M.injure([0.5, 0.5, 0.5]); assert.equal(r(), r0 + 8);
    M.reset('maturation'); assert.equal(r(), r0 + 9);
    assert.equal(M.revision, M.state.revision);
  });

  test('snapshot().fields and the export meta additions (E1, E5, E6)', () => {
    const M = engineFor(TISSUES.fibrous); M.reset('maturation'); M.step(10);
    const f = M.snapshot(), meta = M.exportMeta();
    assert.deepEqual(Object.keys(f.fields), meta.fields.map((x) => x.key), 'one grid per declared field');
    for (const k of Object.keys(f.fields)) { assert.equal(f.fields[k].length, M.NV); assert.ok(f.fields[k].every(Number.isFinite)); }
    const g = M.fields[M.fieldIndex.g];
    for (let v = 0; v < M.NV; v++) assert.ok(Math.abs(f.fields.g[v] - g[v]) < 1e-4, 'rounded, not resampled');
    assert.deepEqual(meta.fields, TISSUES.fibrous.fields.map((x) => ({ key: x.key, label: x.label, color: x.color })));
    const load = TISSUES.fibrous.dials.find((d) => d.role === 'load');
    assert.deepEqual(meta.loadRange, [load.min, load.max]);
    assert.equal(meta.tissueName, TISSUES.fibrous.name);
    assert.equal(meta.scenarioTitle, 'Scaffold to tissue');
    M.reset('wound'); assert.equal(M.exportMeta().scenarioTitle, M.scenarioDef('wound').title);
    // additive only: the cellTypes entries keep exactly the keys format-2 readers expect
    assert.deepEqual(Object.keys(meta.cellTypes[0]).sort(), ['colors', 'key', 'label', 'radius', 'shape']);
    const T = new TissueEngine(TISSUE_TEMPLATE, { seed: 1 }).exportMeta();
    assert.ok(Array.isArray(T.fields) && T.loadRange !== undefined);
  });
});

// ---------------------------------------------------------------- v0.4 round 4: contract follow-ups
describe('engine round 4: repulsion share, warm slices, seeding notes, snapshot options, checks', () => {
  const anchorPair = (motile) => {
    // two cells 0.01 apart, contact distance 2·rCell = 0.06, kRep 0.5, nothing else moving
    const types = [
      { key: 'walker', label: 'Walker', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.02, motile: true, fraction: 1 },
      { key: 'anchor', label: 'Anchor', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.02, motile, fraction: 1 },
    ];
    const M = new TissueEngine(bench({ cellTypes: types }), { seed: 4 });
    M.reset('run', { dials: { nCells: 2 } });
    M.rules.cell = (ctx) => { ctx.out.speed = 0; ctx.out.noise = 0; };
    M._cx.set([0.5, 0.5, 0.5, 0.51, 0.5, 0.5]);
    M.step(1);
    return { gap: Math.abs(M.state.cx[3] - M.state.cx[0]), cx: Array.from(M.state.cx), types: Array.from(M.state.ctype) };
  };

  test('repulsion is shared by the partners that can move: an obstacle pushes the walker all the way', () => {
    const both = anchorPair(true), one = anchorPair(false);
    assert.ok(Math.abs(both.gap - 0.035) < 1e-6, `two motile cells split the correction: ${both.gap}`);
    assert.ok(Math.abs(one.gap - both.gap) < 1e-6, `an anchor gives the walker the whole correction: ${one.gap}`);
    const anchor = one.types[0] === 1 ? 0 : 1;
    assert.equal(one.cx[3 * anchor], Math.fround(anchor === 0 ? 0.5 : 0.51), 'and the anchor itself has not moved');
  });

  test('warmFrom does not build a whole nested pre-run in its first slice (A2 / A9)', () => {
    let calls = 0;
    const sc = (key, init, extra) => Object.assign({ key, title: key, goal: 'g', steps: ['a'], question: 'q', expect: 'e', dials: {}, init, checks: [{ at: 1, stat: 'fa', op: 'lt', value: 2 }] }, extra);
    const t = bench({
      scenarios: [
        sc('matured', { from: { scenario: 'seed', days: 30 } }),      // scenarios[0] itself pre-runs
        sc('seed', { species: { x: 0.1 } }),
        sc('later', { from: { scenario: 'seed', days: 4 } }),
      ],
      makeRules: () => ({ cell(ctx) { ctx.out.speed = 0; }, voxel(ctx) { calls++; ctx.out.E = 1; ctx.out.dRho[0] = 0.01; } }),
    });
    const M = new TissueEngine(t, { seed: 1 });                       // the host pays for scenarios[0] once
    M.reset('seed');
    const from = t.scenarios[2].init.from;
    calls = 0;
    const first = M.warmFrom(from, 5);
    assert.equal(first.done, false, 'a 5-step slice of a 200-step pre-run is not done');
    assert.ok(calls <= 7 * M.NV, `the slice runs 5 steps, not a nested pre-run of scenarios[0] (${calls / M.NV} voxel passes)`);
    while (!M.warmFrom(from, 37).done);                               // finish it in odd slices
    M.reset('later');
    const F = new TissueEngine(t, { seed: 1 });
    F.reset('later');                                                 // the synchronous path
    assert.deepEqual(Array.from(M.species[0]), Array.from(F.species[0]), 'sliced == synchronous');
    assert.deepEqual(M.stats(), F.stats());
  });

  test("cellTypes[].count without a cellCount dial: the types that declare none are never seeded", () => {
    const typed = (count) => ({ key: count === undefined ? 'rest' : 'pinned', label: 'T', colors: ['#000000', '#ffffff'], shape: { by: 'a', aspectMin: 1, aspectMax: 1 }, radius: 0.01, motile: true, count });
    const t = bench({
      cellTypes: [typed(10), typed(undefined)],
      dials: [{ key: 'bath', label: 'Bath', min: 0, max: 1, step: 0.01, default: 1, format: 'fixed2' }],   // no role:'cellCount'
      scenarios: [{ key: 'run', title: 'Run', goal: 'g', steps: ['a'], question: 'q', expect: 'e', dials: {}, init: { species: {} }, checks: [{ at: 1, stat: 'cells.n', op: 'gt', value: 0 }] }],
    });
    assert.deepEqual(TissueEngine.validate(t), [], 'it is a legal definition');
    const M = new TissueEngine(t, { seed: 1 });
    const b = M.stats().cells.byType;
    assert.deepEqual([b.pinned.n, b.rest.n], [10, 0], 'the fraction-only type gets a share of nothing');
    const notes = TissueEngine.notes(t);
    const seeded = notes.find((n) => /NEVER seeded/.test(n.text));
    assert.ok(seeded && seeded.actionable, `it is an actionable warning: ${notes.map((n) => n.text).join(' | ')}`);
    assert.match(seeded.text, /rest/, 'and it names the type');
  });

  test('snapshot({ fields: false }) leaves the per-field grids out of a frame (A2 export size)', () => {
    const M = new TissueEngine(TISSUES.fibrous, { seed: SEED });
    M.reset('maturation'); M.step(10);
    const full = M.snapshot(), lean = M.snapshot({ fields: false });
    assert.ok(full.fields && Object.keys(full.fields).length === M.nFields, 'the default is unchanged');
    assert.equal('fields' in lean, false, 'and the opt-out drops the key entirely (§5: a reader tolerates it)');
    assert.deepEqual(Object.keys(lean), Object.keys(full).filter((k) => k !== 'fields'));
    for (const k of Object.keys(lean)) assert.deepEqual(lean[k], full[k], `${k} is untouched`);
    assert.ok(JSON.stringify(lean).length < 0.8 * JSON.stringify(full).length, 'and it is materially smaller');
  });

  test("checks: rel gains a factor, and agg 'cross' reports the first day a condition holds", () => {
    // one species grown at a flat 0.1 / day by the voxel hook: x(t) = 0.1·t everywhere
    const t = bench({
      scenarios: [{ key: 'run', title: 'Run', goal: 'g', steps: ['a'], question: 'q', expect: 'e',
        dials: {}, init: { species: {} },
        checks: [
          { at: [0, 10], agg: 'cross', stat: 'species.x', op: 'gt', threshold: 0.47 },
          { at: [0, 3], agg: 'cross', stat: 'species.x', op: 'gt', threshold: 0.47 },
          { at: 10, stat: 'species.x', rel: { stat: 'species.x', at: 5, factor: 1.9, op: 'gt' } },
          { at: 10, stat: 'species.x', rel: { stat: 'species.x', at: 5, factor: 2.1, op: 'gt' } },
          { at: 10, stat: 'species.x', rel: { stat: 'species.x', at: 5, factor: 2, op: 'gt' }, value: -0.05 },
          { at: 10, stat: 'species.x', rel: { stat: 'species.x', at: 5, op: 'gt' }, value: 0.4 },
        ] }],
      makeRules: () => ({ cell(ctx) { ctx.out.speed = 0; }, voxel(ctx) { ctx.out.E = 1; ctx.out.dRho[0] = 0.1; } }),
    });
    assert.deepEqual(TissueEngine.validate(t), []);
    const r = TissueEngine.checkScenario(t, 'run', { seed: 1 });
    assert.equal(r[0].value, 5, `the crossing DAY is the value (${r[0].value})`);
    assert.equal(r[0].ref, 0.47, 'and the threshold is the reference');
    assert.ok(r[0].pass && Math.abs(r[0].crossed.stat - 0.5) < 1e-3, `crossed carries the stat too: ${JSON.stringify(r[0].crossed)}`);
    assert.equal(r[1].value, undefined, 'no crossing inside the window');
    assert.equal(r[1].pass, false); assert.equal(r[1].crossed, null);
    assert.ok(r[2].pass && Math.abs(r[2].ref - 0.95) < 1e-3, `factor 1.9 × x(5): ${r[2].ref}`);
    assert.ok(!r[3].pass && Math.abs(r[3].ref - 1.05) < 1e-3, 'factor 2.1 is out of reach');
    assert.ok(r[4].pass && Math.abs(r[4].ref - 0.95) < 1e-3, 'factor and offset compose: ref = x(at)·factor + value');
    assert.ok(r[5].pass && Math.abs(r[5].ref - 0.9) < 1e-3, 'no factor is still factor 1 (v0.3 shape unchanged)');
    // the schema knows the new keys
    const chk = (c) => TissueEngine.validate(bench({ scenarios: [{ key: 'run', title: 'R', goal: 'g', steps: ['a'], question: 'q', expect: 'e', dials: {}, init: { species: {} }, checks: [c] }] }));
    assert.ok(chk({ at: [0, 5], agg: 'cross', stat: 'fa', op: 'gt', threshold: 1, value: 2 }).some((e) => /drop 'value'/.test(e)));
    assert.ok(chk({ at: [0, 5], agg: 'cross', stat: 'fa', op: 'gt', threshold: 1, rel: { stat: 'fa', op: 'gt' } }).some((e) => /takes no rel reference/.test(e)));
    assert.ok(chk({ at: [0, 5], agg: 'cross', stat: 'fa', op: 'gt' }).some((e) => /needs a numeric threshold/.test(e)));
    assert.ok(chk({ at: 5, stat: 'fa', op: 'gt', value: 1, threshold: 2 }).some((e) => /threshold only applies/.test(e)));
    assert.ok(chk({ at: [0, 5], agg: 'cross', stat: 'fa', op: 'between', threshold: [0.1, 0.2] }).length === 0);
    assert.ok(chk({ at: 5, stat: 'fa', rel: { stat: 'fa', at: 0, op: 'gt', factor: 'twice' } }).some((e) => /factor must be a number/.test(e)));
    assert.ok(chk({ at: [0, 5], agg: 'sometimes', stat: 'fa', op: 'gt', value: 1 }).some((e) => /min\|max\|mean\|first\|cross/.test(e)));
  });

  test('a range check that compares its own aggregate with its own first sample is flagged', () => {
    const withCheck = (c) => bench({ scenarios: [{ key: 'run', title: 'R', goal: 'g', steps: ['a'], question: 'q', expect: 'e', dials: {}, init: { species: {} }, checks: [c] }] });
    const dead = withCheck({ at: [10, 20], agg: 'max', stat: 'fa', rel: { stat: 'fa', op: 'lt' } });
    assert.deepEqual(TissueEngine.validate(dead), [], 'it is legal, just never true');
    const n = TissueEngine.notes(dead).find((x) => /can never pass/.test(x.text));
    assert.ok(n && n.actionable, TissueEngine.warnings(dead).join(' | '));
    // and the idioms that DO work are quiet
    for (const ok of [
      { at: [10, 20], agg: 'min', stat: 'fa', rel: { stat: 'fa', op: 'lt' } },                 // "it dips below where it started"
      { at: [10, 20], agg: 'max', stat: 'fa', rel: { stat: 'fa', at: 0, op: 'lt' } },          // reference before the window
      { at: [10, 20], agg: 'max', stat: 'fa', rel: { stat: 'cells.a', op: 'lt' } },            // a different stat
      { at: [10, 20], agg: 'max', stat: 'fa', rel: { stat: 'fa', op: 'lt' }, value: 0.1 },     // a real head-room
      { at: [10, 20], agg: 'max', stat: 'fa', rel: { stat: 'fa', op: 'lt', factor: 1.5 } },    // …or a factor
    ]) assert.deepEqual(TissueEngine.warnings(withCheck(ok)), [], JSON.stringify(ok));
    // the shipped tissues and the starter are clean
    for (const [key, tis] of Object.entries(CONFORMANCE)) {
      assert.deepEqual(TissueEngine.notes(tis).filter((x) => /can never pass/.test(x.text)), [], key);
    }
  });
});

// ---------------------------------------------------------------- shared copy helpers
describe('copy helpers', () => {
  test('copyFormatDial implements every format', () => {
    assert.equal(copyFormatDial('fixed2', 0.5), '0.50');
    assert.equal(copyFormatDial('percent', 0.6), '60 %');
    assert.equal(copyFormatDial('cells', 160), '160 cells');
    assert.equal(copyFormatDial('int', 2.6), '3');
    assert.equal(copyFormatDial('onoff', 1), 'On'); assert.equal(copyFormatDial('onoff', 0), 'Off');
    assert.equal(copyFormatDial((v) => `${v} mm`, 3), '3 mm');
    assert.equal(copyFormatRate(0.0234), '0.02/d'); assert.equal(copyFormatRate(12.3), '12/d'); assert.equal(copyFormatRate(0), '0/d');
  });

  test('copyEquilibriumSentence reads the engine stats shape and uses the tissue vocabulary', () => {
    const M = engineFor(TISSUES.fibrous); M.reset('maturation'); M.step(30 * Math.round(1 / M.dt));
    const s = M.stats(), V = TISSUES.fibrous.copy.vocabulary;
    const sentence = copyEquilibriumSentence(s, V);
    assert.match(sentence, /^Deposition \S+\/d (outpaces|trails|matches) degradation \S+\/d — the cloud/);
    assert.ok(sentence.includes('condensing') && sentence.includes(V.cellsActive), sentence);
    assert.equal(copyEquilibriumSentence(s, V), sentence, 'pure');
    const still = copyEquilibriumSentence({ deposition: 0, degradation: 0, species: { total: 0.01 }, cells: { a: 0 }, logE: 0 }, V);
    assert.ok(still.includes('the cloud is still') && still.includes(`hardly any ${V.matrix}`), still);
    const evap = copyEquilibriumSentence({ deposition: 0.001, degradation: 0.01, species: { total: 0.5 }, cells: { a: 0.1 }, logE: 1 }, { matrix: 'aggrecan', cellsActive: 'x', cellsQuiet: 'the chondrocytes are quiet' });
    assert.ok(evap.includes('evaporating') && evap.includes('the chondrocytes are quiet') && evap.includes('aggrecan'), evap);
    // v0.1 stats shape still accepted
    const legacy = copyEquilibriumSentence({ deposition: 0.02, degradation: 0.01, meanRho: 0.8, meanAlpha: 0.9, meanLogE: 1.7 });
    assert.ok(legacy.includes('condensing') && /stiff/.test(legacy), legacy);
  });
});
