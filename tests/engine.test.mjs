// tests/engine.test.mjs — run with `node --test tests/*.test.mjs` (Node ≥ 21 treats the argument as a
// glob; a bare directory such as `node --test tests/` is not expanded).
//
// Conformance (docs/EXTENDING.md §7) for every registered tissue (src/tissues/index.js) plus the
// unregistered starter src/tissues/_template.js:
//   1. schema validation   2. determinism   3. invariants   4. every scenario's `checks`   5. performance
// Plus the fibrous golden regression against tests/golden/fibrous.json (recorded from v0.1 model.js,
// seed 7): species.total / species.mat / fa / cells.a within 3 % relative or 0.01 absolute (whichever
// is larger) at every recorded day of all recorded runs. Plus engine API tests (stat paths, init.from
// cache, injury, cell-count dial, export format 2) and the shared copy helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      assert.ok(t.dials.some((d) => d.role === 'cellCount'), 'a cellCount dial');
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

// ---------------------------------------------------------------- golden regression (fibrous, seed 7)
describe('golden regression: fibrous vs tests/golden/fibrous.json', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/fibrous.json', import.meta.url), 'utf8'));
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
  const tissue = TISSUES.fibrous;
  assert.ok(tissue, 'fibrous must be registered');
  const M = new TissueEngine(tissue, { seed: golden.seed });
  const spd = Math.round(1 / M.dt);
  const summary = {};

  for (const [key, raw] of Object.entries(golden.runs)) {
    test(`run '${key}': ${raw.scenario}, ${raw.days} d, ${raw.rows.length} recorded days`, () => {
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
          const tol = Math.max(0.01, 0.03 * Math.abs(gv));
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
    assert.ok(still.includes('the cloud is still') && still.includes('hardly any matrix'), still);
    const evap = copyEquilibriumSentence({ deposition: 0.001, degradation: 0.01, species: { total: 0.5 }, cells: { a: 0.1 }, logE: 1 }, { matrix: 'aggrecan', cellsActive: 'x', cellsQuiet: 'the chondrocytes are quiet' });
    assert.ok(evap.includes('evaporating') && evap.includes('the chondrocytes are quiet') && evap.includes('aggrecan'), evap);
    // v0.1 stats shape still accepted
    const legacy = copyEquilibriumSentence({ deposition: 0.02, degradation: 0.01, meanRho: 0.8, meanAlpha: 0.9, meanLogE: 1.7 });
    assert.ok(legacy.includes('condensing') && legacy.includes('stiff enough'), legacy);
  });
});
