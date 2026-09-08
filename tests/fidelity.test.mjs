// tests/fidelity.test.mjs — the teaching claims, checked against the model that makes them.
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
// docs/REVIEW.md F1–F9: five pieces of student-facing copy contradicted the built model. Copy was
// fixed (never a parameter — the goldens and the scenario checks pin the behaviour), and these are
// the pins that keep the two together. Each test states the claim the copy now makes and measures
// it on the current engine, so a later parameter change that invalidates a sentence fails here
// instead of in a classroom.
//
//   F1  unloading is load AND bath: off load alone the tissue keeps its mass and half its activation
//   F2  TGF-β gates, tension potentiates (not "both required")
//   F3  the wound patch does catch up in alignment (unlike a real scar)
//   F4  no cell swims into the wound; the ones there dim slightly
//   F5  the hysteresis is autocrine, not matrix release
//   F6  the protease dial at 0 still degrades
//   F7  the stiffness readout is a geometric mean in kPa, and lands in scar country
//   F8  the alignment headline is whole-tissue coherence (globalFA), not the per-voxel mean (fa)
//   F9  the load dial is a 0–1 index, not engineering strain
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TissueEngine } from '../src/engine.js';
import { TISSUES } from '../src/tissues/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIB = TISSUES.fibrous;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** Run `scenario` (optionally with dial overrides) to `days` and return stats(). */
function runTo(days, { scenario = 'maturation', dials = {}, seed = 7, engine = null } = {}) {
  const M = engine || new TissueEngine(FIB, { seed });
  if (!engine) M.reset(scenario, { dials });
  M.step(Math.round((days - M.time) / M.dt));
  return { M, s: M.stats() };
}

/** Every string in the fibrous definition's copy, dials, scenarios and readouts, as one text. */
function fibrousCopy() {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk({ copy: FIB.copy, dials: FIB.dials, scenarios: FIB.scenarios, readouts: FIB.readouts, injury: FIB.injury });
  return parts.join('\n');
}

describe('fidelity: what the copy claims, measured (docs/REVIEW.md F1–F9)', () => {
  // ---------------------------------------------------------------- F1
  test('F1: taking the load away alone does not cause atrophy — the bath drop does', () => {
    const from = { M: null };
    const shared = new TissueEngine(FIB, { seed: 7 });        // one engine: the init.from pre-run is cached

    shared.reset('unloading', { dials: { Gext: 0.5, strain: 0, protease: 0.4 } });   // load off, bath kept
    const start = shared.stats();
    shared.step(Math.round(60 / shared.dt));
    const loadOnly = shared.stats();
    assert.ok(start.species.total > 0.9, `the pre-run must hand over a matured tissue (got ${start.species.total.toFixed(3)})`);
    assert.ok(loadOnly.species.total > 0.95 * start.species.total,
      `off load alone the density holds: ${start.species.total.toFixed(3)} → ${loadOnly.species.total.toFixed(3)}`);
    assert.ok(loadOnly.cells.a > 0.5, `and the cells stay activated (a = ${loadOnly.cells.a.toFixed(3)})`);
    assert.ok(loadOnly.globalFA < 0.35 && loadOnly.globalFA < 0.5 * start.globalFA,
      `what load alone does take away is the alignment: globalFA ${start.globalFA.toFixed(3)} → ${loadOnly.globalFA.toFixed(3)}`);

    shared.reset('unloading');                                 // the shipped scenario: load off AND bath down
    shared.step(Math.round(60 / shared.dt));
    const both = shared.stats();
    assert.ok(both.species.total < 0.6, `with the bath down too the matrix does go (${both.species.total.toFixed(3)})`);
    assert.ok(both.cells.a < 0.3, `and the cells switch off (a = ${both.cells.a.toFixed(3)})`);
    from.M = shared;
  });

  test('F1: no copy still says load alone flips the cells', () => {
    const copy = fibrousCopy();
    assert.ok(!/removing load alone/i.test(copy), 'the unloading question must not claim load alone does it');
    for (const doc of ['docs/TEACHING.md', 'docs/MODEL.md']) {
      assert.ok(!/removing load alone/i.test(read(doc)), `${doc} still claims load alone flips the cells`);
    }
  });

  // ---------------------------------------------------------------- F2
  test('F2: growth factor GATES activation — with the bath at 0 no load activates anything', () => {
    for (const strain of [0.6, 1]) {
      const { s } = runTo(7, { dials: { Gext: 0, strain } });
      assert.ok(s.cells.a < 0.05, `Gext 0, strain ${strain}: a = ${s.cells.a.toFixed(3)} (must stay below 0.05)`);
    }
    const { s } = runTo(60, { dials: { Gext: 0, strain: 1 } });
    assert.ok(s.cells.a < 0.05, `and it stays off for two months (a = ${s.cells.a.toFixed(3)})`);
  });

  test('F2: tension POTENTIATES it — the bath alone activates the cells about half way', () => {
    for (const days of [28, 60]) {
      const { s } = runTo(days, { dials: { strain: 0 } });
      assert.ok(s.cells.a > 0.4 && s.cells.a < 0.65,
        `strain 0, bath 0.5 at day ${days}: a = ${s.cells.a.toFixed(3)} (the claim is "about half", 0.4–0.65)`);
    }
    const loaded = runTo(60).s;                                // the same bath WITH load goes much further
    assert.ok(loaded.cells.a > 0.8, `and load takes it the rest of the way (a = ${loaded.cells.a.toFixed(3)})`);
  });

  test('F2: no copy still requires tension AND growth factor together', () => {
    assert.ok(!/only when tension and TGF-β act together/i.test(read('docs/TEACHING.md')),
      'TEACHING objective 3 must state the gate-and-potentiate law, not an AND');
  });

  // ---------------------------------------------------------------- F3
  test('F3: the wound is a visible tangle at three weeks and has caught up by eight', () => {
    const M = new TissueEngine(FIB, { seed: 7 });
    M.reset('wound');
    const steps = (d) => Math.round(d / M.dt);
    M.step(steps(5));
    M.injure([0.5, 0.5, 0.5]);
    const N3 = M.N ** 3;
    const gap = () => {                                        // mean FA inside the wound vs outside it
      const w = M.woundStats(), s = M.stats();
      const outside = (s.fa * N3 - w.fa * w.nVox) / (N3 - w.nVox);
      return { inside: w.fa, outside, gap: outside - w.fa, wound: w };
    };
    M.step(steps(21));
    const wk3 = gap();
    assert.ok(wk3.gap > 0.08, `three weeks in, the patch is still a tangle: inside ${wk3.inside.toFixed(3)} vs outside ${wk3.outside.toFixed(3)}`);
    M.step(steps(35));                                         // 8 weeks after the injury
    const wk8 = gap();
    assert.ok(wk8.gap < 0.1, `by eight weeks it has caught up: inside ${wk8.inside.toFixed(3)} vs outside ${wk8.outside.toFixed(3)} (gap ${wk8.gap.toFixed(3)})`);
    assert.ok(wk8.gap < wk3.gap, 'and the gap is closing, not widening');
    assert.ok(wk8.wound.species.total > 0.8, `the hole has refilled (${wk8.wound.species.total.toFixed(3)})`);
  });

  test('F3: no copy still says the scar never regains alignment', () => {
    const copy = fibrousCopy();
    assert.ok(!/without fully regaining alignment/i.test(copy));
    assert.ok(!/without regaining their neighbours' alignment/i.test(read('docs/TEACHING.md')));
  });

  // ---------------------------------------------------------------- F4
  test('F4: nothing migrates into the wound, and the cells in it dim rather than activate', () => {
    const M = new TissueEngine(FIB, { seed: 7 });
    M.reset('wound');
    const steps = (d) => Math.round(d / M.dt);
    M.step(steps(5));
    M.injure([0.5, 0.5, 0.5]);
    const at = M.woundStats();
    const share = at.nVox / M.N ** 3;                          // the wound's share of the volume
    let minA = at.cells.a, maxN = at.cells.n;
    for (let d = 1; d <= 7; d++) {
      M.step(steps(1));
      const w = M.woundStats();
      minA = Math.min(minA, w.cells.a);
      maxN = Math.max(maxN, w.cells.n);
    }
    assert.ok(minA < at.cells.a - 0.02, `the cells there slacken (${at.cells.a.toFixed(3)} → ${minA.toFixed(3)}), they do not switch on`);
    assert.ok(minA > 0.6, 'but they stay activated — they were already orange before the injury');
    assert.ok(maxN < 1.5 * share * M.nCells,
      `no chemotaxis: at most ${maxN} of ${M.nCells} cells were inside a sphere holding ${(100 * share).toFixed(1)} % of the volume`);
  });

  test('F4: no copy still has cells turning orange and wandering in', () => {
    const copy = fibrousCopy();
    assert.ok(!/turn orange and wander in/i.test(copy));
    assert.ok(!/cells activate and wander in/i.test(read('docs/TEACHING.md')));
  });

  // ---------------------------------------------------------------- F5
  test('F5: the fibrosis memory is autocrine — matrix release supplies under 1 % of it', () => {
    const M = new TissueEngine(FIB, { seed: 7 });
    M.reset('fibrosis');
    const steps = (d) => Math.round(d / M.dt);
    M.step(steps(45));
    M.setDials({ Gext: 0.2 });                                  // the scripted event
    M.step(steps(15));
    const s = M.stats(), p = FIB.params;
    const bath = M.dials.Gext, kBath = FIB.fields.find((f) => f.key === 'g').kBath;
    assert.ok(s.fields.g > 1.5 * bath, `the haze stays well above the bath: g = ${s.fields.g.toFixed(3)} vs Gext ${bath}`);
    // In steady state the bath drains kBath·(g − Gext) per day, so that is what the cell sources supply.
    const drain = kBath * (s.fields.g - bath);
    const release = p.kGrel * s.degradation;                    // the "digesting matrix frees stored TGF-β" term
    assert.ok(release < 0.01 * drain,
      `matrix release is ${release.toFixed(5)}/d against ${drain.toFixed(3)}/d held up by the cells (${(100 * release / drain).toFixed(2)} %)`);
    assert.ok(s.cells.a > 0.5, `and the cells are still on (a = ${s.cells.a.toFixed(3)})`);
  });

  test('F5: the copy attributes the memory to the cells, not to matrix release', () => {
    const copy = fibrousCopy();
    assert.ok(/autocrine|release growth factor themselves|own humidity/i.test(copy), 'the autocrine loop must be named somewhere in the copy');
    assert.ok(!/digesting matrix frees more that was stored in it\. The tissue partly makes its own humidity\./.test(copy),
      'the metaphor break must no longer put matrix release on the same footing as the cells');
  });

  // ---------------------------------------------------------------- F6
  test('F6: the protease dial at 0 still degrades matrix', () => {
    const { s } = runTo(60, { dials: { protease: 0 } });
    assert.ok(s.degradation > 0, `degradation is ${s.degradation.toFixed(5)}/day at dial 0`);
    assert.ok(s.cumDegradation > 0.05, `and it adds up (${s.cumDegradation.toFixed(3)} of density cut in 60 days)`);
    const dial = FIB.dials.find((d) => d.key === 'protease');
    assert.ok(!/above the middle, enzymes outnumber inhibitors/i.test(dial.biology),
      'the dial text must not promise that below the middle nothing is cut');
  });

  // ---------------------------------------------------------------- F7
  test('F7: stiffness is a geometric mean in kPa, and the numbers are scar-range', () => {
    const stiff = FIB.readouts.find((r) => r.key === 'stiff');
    assert.match(stiff.unit, /kPa/);
    assert.match(`${stiff.unit} ${stiff.meaning}`, /geometric mean/i, 'the readout plots the mean of log10 E, which is a geometric mean');
    const mature = runTo(90).s;
    assert.ok(mature.logE > 1.9 && mature.logE < 2.3, `maturation ends near 125 kPa (log10E ${mature.logE.toFixed(2)})`);
    const M = new TissueEngine(FIB, { seed: 7 });
    M.reset('fibrosis');
    M.step(Math.round(45 / M.dt));
    M.setDials({ Gext: 0.2 });
    M.step(Math.round(45 / M.dt));
    const fib = M.stats();
    assert.ok(fib.logE > mature.logE, `and fibrosis ends stiffer still (${(10 ** fib.logE).toFixed(0)} kPa vs ${(10 ** mature.logE).toFixed(0)} kPa)`);
    assert.ok(10 ** fib.logE > 100 && 10 ** fib.logE < 250, 'hypertrophic-scar country, not normal dermis');
  });

  // ---------------------------------------------------------------- F8
  test('F8: the alignment headline series is globalFA, and the two measures really differ', () => {
    const align = FIB.readouts.find((r) => r.key === 'align');
    assert.equal(align.series[0].stat, 'globalFA', 'the headline trace must be the whole-tissue coherence');
    assert.match(align.series[0].label, /whole tissue/i);
    const local = align.series.find((x) => x.stat === 'fa');
    assert.ok(local, 'the per-voxel measure may stay, as a second trace');
    assert.match(local.label, /local anisotropy/i);
    // the fibrosis run is where the difference bites: aligned patches, no shared direction
    const M = new TissueEngine(FIB, { seed: 7 });
    M.reset('fibrosis');
    M.step(Math.round(90 / M.dt));
    const s = M.stats();
    assert.ok(s.fa - s.globalFA > 0.05,
      `fibrosis: per-voxel FA ${s.fa.toFixed(3)} vs whole-tissue ${s.globalFA.toFixed(3)} — the label has to say which one is drawn`);
    // the scenario checks and the goldens stay on `fa`; this is a readout change only
    assert.ok(FIB.scenarios.every((sc) => (sc.checks || []).every((c) => c.stat !== 'globalFA')),
      'do not move the scenario checks onto globalFA: the recorded goldens are on fa');
  });

  // ---------------------------------------------------------------- F9
  test('F9: the load dial reads as a 0–1 index, not as a percentage strain', () => {
    const dial = FIB.dials.find((d) => d.key === 'strain');
    assert.equal(dial.format, 'fixed2', 'a "60 %" reading is read as 60 % engineering strain, which no tissue survives');
    assert.match(dial.biology, /load index/i);
    assert.equal(dial.role, 'load');
    assert.equal(dial.min, 0);
    assert.equal(dial.max, 1);
  });
});
