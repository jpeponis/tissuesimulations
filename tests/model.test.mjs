// tests/model.test.mjs — run with `node --test` (or `node --test tests/*.test.mjs`; Node ≥ 21 treats the
// argument as a glob, so a bare directory such as `node --test tests/` is not expanded)
// Invariants (no NaN, mass ≥ 0, FA ∈ [0,1], cells in the box, determinism) and the qualitative
// scenario expectations of docs/SPEC.md §1.7 as tuned in src/model.js (see its header).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TissueModel, SCENARIOS, DEFAULT_PARAMS, mulberry32, tmRoundArray } from '../src/model.js';

const SEED = 7;
const STEPS_PER_DAY = Math.round(1 / DEFAULT_PARAMS.dt);

/** Step `days` days; `events` = { [day]: (model) => void } fired when the clock reaches that day. */
function runDays(model, days, events = {}, onDay = null) {
  for (let d = 0; d < days; d++) {
    const t = Math.round(model.time);
    if (events[t]) { events[t](model); events[t] = null; }
    if (onDay) onDay(t, model);
    model.step(STEPS_PER_DAY);
  }
  const t = Math.round(model.time);
  if (events[t]) { events[t](model); events[t] = null; }
  if (onDay) onDay(t, model);
}

function allFinite(arr) { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; }

function checkInvariants(model, label) {
  const s = model.state, P = model.params;
  for (const k of ['Txx', 'Tyy', 'Tzz', 'Txy', 'Txz', 'Tyz', 'rho', 'rhoMat', 'fa', 'fx', 'fy', 'fz', 'g', 'm', 'E', 'cx', 'cp', 'alpha']) {
    assert.ok(allFinite(s[k]), `${label}: ${k} has NaN/Inf`);
  }
  for (let v = 0; v < model.NV; v++) {
    assert.ok(s.rho[v] >= 0, `${label}: rho < 0 at ${v}`);
    assert.ok(s.rho[v] <= P.rhoMax + 1e-4, `${label}: rho > rhoMax at ${v}`);
    assert.ok(s.rhoMat[v] >= 0 && s.rhoMat[v] <= s.rho[v] + 1e-5, `${label}: rhoMat outside [0, rho] at ${v}`);
    assert.ok(s.fa[v] >= 0 && s.fa[v] <= 1, `${label}: FA outside [0,1] at ${v}`);
    assert.ok(s.g[v] >= 0 && s.m[v] >= 0, `${label}: negative field at ${v}`);
    assert.ok(s.E[v] >= P.E0 - 1e-6, `${label}: E below E0 at ${v}`);
    // diagonal of the structure tensor non-negative (PSD guard)
    assert.ok(s.Txx[v] >= 0 && s.Tyy[v] >= 0 && s.Tzz[v] >= 0, `${label}: negative tensor diagonal at ${v}`);
  }
  assert.equal(s.cx.length, 3 * s.nCells);
  for (let i = 0; i < s.nCells; i++) {
    for (let d = 0; d < 3; d++) {
      const q = s.cx[3 * i + d];
      assert.ok(q >= 0 && q <= P.L, `${label}: cell ${i} outside the box (${q})`);
    }
    const pn = Math.hypot(s.cp[3 * i], s.cp[3 * i + 1], s.cp[3 * i + 2]);
    assert.ok(Math.abs(pn - 1) < 1e-3, `${label}: polarity not unit (${pn})`);
    assert.ok(s.alpha[i] >= 0 && s.alpha[i] <= 1, `${label}: alpha outside [0,1]`);
  }
}

// ---------------------------------------------------------------- shared runs (computed once, lazily)
const cache = {};
function shared(name, make) { if (!(name in cache)) cache[name] = make(); return cache[name]; }
const series = (model, days, events = {}) => {
  const out = [];
  runDays(model, days, events, (t, m) => out.push({ ...m.stats(), t, wound: m.woundStats() })); // integer day label wins over stats().t
  return out;
};
const at = (rows, day) => rows.find((r) => r.t === day);

const maturation90 = () => shared('maturation90', () => { const m = new TissueModel({}, SEED); m.reset('maturation'); return series(m, 90); });
const maturationLowG = () => shared('maturationLowG', () => { const m = new TissueModel({}, SEED); m.reset('maturation', { dials: { Gext: 0.2 } }); return series(m, 90); });
const fibrosis90 = () => shared('fibrosis90', () => { const m = new TissueModel({}, SEED); m.reset('fibrosis'); return series(m, 90, { 45: (mm) => mm.setDials({ Gext: 0.2 }) }); });
const fibrosisLowG = () => shared('fibrosisLowG', () => { const m = new TissueModel({}, SEED); m.reset('fibrosis', { dials: { Gext: 0.2 } }); return series(m, 90); });
// one instance for everything that starts from the matured state (its matured-state cache is per instance)
const maturedModel = () => shared('maturedModel', () => new TissueModel({}, SEED));

// ---------------------------------------------------------------- invariants
describe('invariants', () => {
  test('PRNG is deterministic and in [0,1)', () => {
    const a = mulberry32(123), b = mulberry32(123);
    for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
  });

  test('all scenarios keep the state finite and bounded over 10 days (incl. injury and dial changes)', () => {
    for (const key of Object.keys(SCENARIOS)) {
      const m = new TissueModel({}, SEED);
      m.reset(key);
      checkInvariants(m, `${key} t=0`);
      m.step(2 * STEPS_PER_DAY);
      if (key === 'wound') m.injure();
      m.setDials({ protease: 1, strain: 0 });
      m.step(4 * STEPS_PER_DAY);
      m.setDials({ nCells: 400, Gext: 1 });
      m.step(2 * STEPS_PER_DAY);
      m.setDials({ nCells: 40 });
      m.step(2 * STEPS_PER_DAY);
      checkInvariants(m, `${key} t=10`);
      const s = m.stats();
      assert.ok(Number.isFinite(s.deposition) && Number.isFinite(s.degradation) && s.deposition >= 0 && s.degradation >= 0);
    }
  });

  test('FA is 0 for an isotropic tensor and 1 for a single axis; principal axis follows the tensor', () => {
    const m = new TissueModel({}, SEED);
    m.reset('sandbox');
    const v = 5;
    m.Txx[v] = 0.2; m.Tyy[v] = 0.2; m.Tzz[v] = 0.2; m.Txy[v] = 0; m.Txz[v] = 0; m.Tyz[v] = 0;
    const w = 6;
    m.Txx[w] = 0; m.Tyy[w] = 0; m.Tzz[w] = 0.5; m.Txy[w] = 0; m.Txz[w] = 0; m.Tyz[w] = 0;
    m.fx[w] = 0.3; m.fy[w] = 0.2; m.fz[w] = 0.93;
    m._derived();
    assert.ok(m.fa[v] < 1e-6, `isotropic FA = ${m.fa[v]}`);
    assert.ok(Math.abs(m.fa[w] - 1) < 1e-5, `uniaxial FA = ${m.fa[w]}`);
    assert.ok(Math.abs(Math.abs(m.fz[w]) - 1) < 1e-3, 'principal axis should be z');
    assert.ok(Math.abs(m.rho[w] - 0.5) < 1e-6);
  });

  test('same seed → identical trajectories (incl. random wound); different seed → different', () => {
    const run = (seed) => {
      const m = new TissueModel({}, seed); m.reset('maturation');
      m.step(150); m.injure(); m.setDials({ nCells: 200 }); m.step(150);
      return m;
    };
    const a = run(11), b = run(11), c = run(12);
    for (const k of ['Txx', 'Tyz', 'rho', 'rhoMat', 'fa', 'g', 'm', 'E']) assert.deepEqual(a[k], b[k], `field ${k} differs`);
    assert.deepEqual(a.state.cx, b.state.cx); assert.deepEqual(a.state.alpha, b.state.alpha);
    assert.deepEqual(a.wound, b.wound);
    assert.notDeepEqual(a.state.cx, c.state.cx);
  });

  test('setDials adds/removes cells and keeps the views consistent', () => {
    const m = new TissueModel({}, SEED); m.reset('sandbox');
    assert.equal(m.state.nCells, 160);
    m.setDials({ nCells: 300 });
    assert.equal(m.nCells, 300); assert.equal(m.state.cx.length, 900); assert.equal(m.state.alpha.length, 300);
    m.step(5);
    m.setDials({ nCells: 40 });
    assert.equal(m.state.cp.length, 120);
    m.setDials({ nCells: 10000 });
    assert.equal(m.nCells, m.cap, 'clamped to capacity');
    m.step(5);
    checkInvariants(m, 'after cell count changes');
    assert.equal(m.setDials({ Gext: 0.9 }).Gext, 0.9);
  });

  test('snapshot() has the SPEC §1.10 shape', () => {
    const m = new TissueModel({}, SEED); m.reset('maturation'); m.step(10);
    const f = m.snapshot(), NV = m.NV, n = m.nCells;
    assert.equal(f.rho.length, NV); assert.equal(f.fa.length, NV); assert.equal(f.phiMat.length, NV); assert.equal(f.f.length, 3 * NV);
    assert.equal(f.cells.x.length, 3 * n); assert.equal(f.cells.p.length, 3 * n); assert.equal(f.cells.alpha.length, n);
    assert.ok(Array.isArray(f.rho) && typeof f.t === 'number');
    assert.ok(f.rho.every(Number.isFinite) && f.f.every(Number.isFinite));
    const meta = m.exportMeta();
    for (const k of ['N', 'L', 'K', 'dtDays', 'scenario', 'dials']) assert.ok(k in meta, `meta.${k}`);
    assert.deepEqual(tmRoundArray(new Float32Array([0.12345, 1.5]), 2), [0.12, 1.5]);
  });

  test('matured state is cached, reproducible and sensible', () => {
    const m = maturedModel();
    const t0 = process.hrtime.bigint();
    const S = m.maturedState();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(m.maturedState(), S, 'second call returns the cache');
    let sum = 0; for (let v = 0; v < m.NV; v++) sum += S.Txx[v] + S.Tyy[v] + S.Tzz[v];
    assert.ok(sum / m.NV > 0.6, `matured mean rho ${sum / m.NV}`);
    console.log(`    matured-state pre-run: ${ms.toFixed(0)} ms (first call)`);
    assert.ok(ms < 4000, 'matured-state pre-run took too long');
  });

  test('step cost (informational; loose bound)', () => {
    const m = new TissueModel({}, SEED); m.reset('maturation'); m.step(200);
    const t0 = process.hrtime.bigint(); m.step(1000);
    const msPerStep = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
    console.log(`    step: ${msPerStep.toFixed(3)} ms at N=${m.N}, n=${m.nCells}`);
    assert.ok(msPerStep < 5, `step too slow: ${msPerStep} ms`);
  });
});

// ---------------------------------------------------------------- scenarios
describe('scenario 1 — scaffold to tissue (maturation)', () => {
  test('density rises from ~0.15 to > 0.6 by day 60, fibres align, matrix matures, stiffness climbs > 10x', () => {
    const r = maturation90(), r0 = at(r, 0), r60 = at(r, 60);
    assert.ok(Math.abs(r0.meanRho - 0.15) < 0.02);
    assert.ok(r60.meanRho > 0.6, `rho(60) = ${r60.meanRho}`);
    assert.ok(r60.meanFA > 0.45, `FA(60) = ${r60.meanFA}`);
    assert.ok(r60.meanFz > 0.5, 'fibres align along z (load axis)');
    assert.ok(r60.phiMat > 0.5, `phiMat(60) = ${r60.phiMat}`);
    assert.ok(r60.meanLogE - r0.meanLogE > 1, `stiffness climb ${10 ** (r60.meanLogE - r0.meanLogE)}x`);
  });
  test('activation rises then settles below 1', () => {
    const r = maturation90(), a0 = at(r, 0).meanAlpha, a45 = at(r, 45).meanAlpha, a60 = at(r, 60).meanAlpha, a90 = at(r, 90).meanAlpha;
    assert.ok(a60 > a0 + 0.3, 'alpha rises');
    assert.ok(a60 > 0.5 && a90 < 0.97, `alpha settles at ${a90}`);
    assert.ok(Math.abs(a90 - a45) < 0.08, `alpha settled: ${a45} → ${a90}`);
  });
  test('with Gext = 0.2 from the start the tissue stays at a much lower plateau', () => {
    const lo = at(maturationLowG(), 90).meanRho, hi = at(maturation90(), 90).meanRho;
    assert.ok(lo < 0.5 * hi, `lowG ${lo} vs ${hi}`);
  });
  test('protease dial 1 vs 0 gives clearly different plateaus', () => {
    const run = (p) => { const m = new TissueModel({}, SEED); m.reset('maturation', { dials: { protease: p } }); runDays(m, 60); return m.stats().meanRho; };
    const p0 = run(0), p1 = run(1);
    assert.ok(p1 < 0.5 * p0, `protease 1: ${p1}, protease 0: ${p0}`);
    assert.ok(p0 > 0.6);
  });
});

describe('scenario 2 — unloading (disuse atrophy)', () => {
  test('from the matured state with strain 0: density falls > 40 % in 60 d, alpha < 0.3, FA falls, mature decays slower than new', () => {
    const m = maturedModel(); m.reset('unloading');
    assert.equal(m.dials.strain, 0);
    const r = series(m, 60), r0 = at(r, 0), r60 = at(r, 60);
    assert.ok(r0.meanRho > 0.6, `matured start rho ${r0.meanRho}`);
    assert.ok(r60.meanRho < 0.6 * r0.meanRho, `rho ${r0.meanRho} → ${r60.meanRho}`);
    assert.ok(r60.meanAlpha < 0.3, `alpha(60) = ${r60.meanAlpha}`);
    assert.ok(r60.meanFA < r0.meanFA - 0.1, `FA ${r0.meanFA} → ${r60.meanFA}`);
    const newKept = r60.meanRhoNew / r0.meanRhoNew, matKept = r60.meanRhoMat / r0.meanRhoMat;
    assert.ok(matKept > newKept + 0.2, `mature kept ${matKept}, new kept ${newKept}`);
    assert.ok(r60.meanM > r0.meanM, 'MMP rises when unloaded');
  });
});

describe('scenario 3 — fibrosis (runaway) and hysteresis', () => {
  test('denser, stiffer and less aligned than maturation; density holds > 80 % of its peak after Gext drops to 0.2 at day 45', () => {
    const f = fibrosis90(), mtn = maturation90();
    const peak = Math.max(...f.map((r) => r.meanRho));
    const f90 = at(f, 90), m90 = at(mtn, 90);
    assert.ok(at(f, 45).meanRho > at(mtn, 45).meanRho, 'fibrosis runs ahead of maturation');
    assert.ok(f90.meanRho > 0.8 * peak, `after the drop rho(90) ${f90.meanRho} vs peak ${peak}`);
    assert.ok(f90.meanRho > m90.meanRho, `fibrosis rho ${f90.meanRho} vs maturation ${m90.meanRho}`);
    assert.ok(f90.meanLogE > m90.meanLogE, `fibrosis log E ${f90.meanLogE} vs maturation ${m90.meanLogE}`);
    assert.ok(f90.meanFA < m90.meanFA - 0.1, `fibrosis FA ${f90.meanFA} vs maturation ${m90.meanFA}`);
    assert.ok(f90.meanAlpha > 0.5, 'cells stay activated after the drop (autocrine + tension memory)');
  });
  test('bistability: the same dials (Gext 0.2) from the start give a much lower plateau', () => {
    const lo = at(fibrosisLowG(), 90).meanRho, hi = at(fibrosis90(), 90).meanRho;
    assert.ok(lo < 0.5 * hi, `lowG ${lo} vs after-drop ${hi}`);
  });
});

describe('scenario 4 — wound healing', () => {
  test('injury empties the sphere; it refills within ~3 weeks with immature, less aligned matrix; alignment only partially recovers', () => {
    const m = maturedModel(); m.reset('wound');
    const control = series(m, 90);                       // same tissue, never injured
    m.reset('wound');
    const rows = series(m, 90, { 5: (mm) => mm.injure([0.5, 0.5, 0.5]) });
    const pre = rows.find((r) => r.t === 4), hit = at(rows, 5), r26 = at(rows, 26), r90 = at(rows, 90);
    assert.ok(hit.wound && hit.wound.meanRho < 0.05, `wound rho right after injury ${hit.wound.meanRho}`);
    assert.ok(hit.meanFA < pre.meanFA - 0.01, 'global FA dips at injury');
    assert.ok(hit.meanG > pre.meanG && hit.meanM > pre.meanM, 'burst of growth factor and protease');
    assert.ok(r26.wound.meanRho > 0.35, `wound rho 3 weeks after injury ${r26.wound.meanRho}`);
    assert.ok(r26.wound.phiMat < r26.phiMat - 0.1, `wound matrix immature: ${r26.wound.phiMat} vs ${r26.phiMat}`);
    assert.ok(r26.wound.meanFA < r26.meanFA - 0.05, `wound matrix less aligned: ${r26.wound.meanFA} vs ${r26.meanFA}`);
    assert.ok(r90.meanFA > hit.meanFA, 'global FA recovers partly');
    assert.ok(r90.meanFA < at(control, 90).meanFA, `scar leaves the tissue less aligned than uninjured control (${r90.meanFA} vs ${at(control, 90).meanFA})`);
    const r60 = at(rows, 60);
    assert.ok(r60.wound.meanFA < r60.meanFA - 0.02, `scar region still less aligned at +55 d (${r60.wound.meanFA} vs ${r60.meanFA})`);
    assert.ok(r90.wound.meanFA < r90.meanFA + 0.03, 'the scar never becomes more aligned than its surroundings');
  });
});

describe('scenario 5 — sandbox', () => {
  test('all dials at 0: the matrix evaporates (rho < 0.05 by day 60 from 0.15)', () => {
    const m = new TissueModel({}, SEED);
    m.reset('sandbox', { dials: { Gext: 0, strain: 0, protease: 0, nCells: 40 }, init: { rho0: 0.15 } });
    const r = series(m, 60);
    assert.ok(at(r, 60).meanRho < 0.05, `rho(60) = ${at(r, 60).meanRho}`);
    assert.ok(at(r, 60).degradation > at(r, 60).deposition, 'evaporating: degradation > deposition');
  });
  test('sandbox preset itself starts nearly empty (rho 0.02) with mid dials', () => {
    const m = new TissueModel({}, SEED); m.reset('sandbox');
    assert.ok(Math.abs(m.stats().meanRho - 0.02) < 0.005);
    assert.deepEqual(m.dials, { Gext: 0.5, strain: 0.5, protease: 0.5, nCells: 160 });
  });
});
