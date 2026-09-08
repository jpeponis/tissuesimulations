// tests/copy.test.mjs — the shared student-facing copy layer (src/copy.js).
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
// src/copy.js writes the one live sentence under the clock. docs/REVIEW.md C15 opened it up so a
// second tissue can own every word of it (`stillHint`, `metaphor`, `activeStiff`,
// `activeSoftening`, `thresholds`, and a whole-sentence `equilibrium(stats)` override) — and the
// hard requirement on that change was that the FIBROUS sentence does not move a byte. These tests
// pin exactly that: the eleven states the sentence can be in, written out in full, plus the
// behaviour of each new slot and of copyTrend / the two formatters.
//
// If one of the frozen strings fails after a deliberate rewording of the fibrous copy, update
// FIBROUS_V and the expectations together, in the same commit as the copy change — and say so in
// the message. The strings below are the v0.3 output (recorded before the C15 refactor).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyEquilibriumSentence, copyFormatDial, copyFormatRate, copyTrend, COPY_VOCABULARY_DEFAULT } from '../src/copy.js';
import { TISSUES } from '../src/tissues/index.js';

/** The fibrous vocabulary as it was when these strings were recorded. */
const FIBROUS_V = Object.freeze({
  matrix: 'collagen',
  cellsActive: 'activated cells are pumping out collagen',
  cellsQuiet: 'the cells are quiet',
});

/** [name, stats, expected sentence] — one per branch the sentence can take. */
const FIBROUS_CASES = [
  ['condensing, activated, stiff matrix',
    { t: 30, deposition: 0.0412, degradation: 0.0177, cells: { a: 0.83 }, species: { total: 0.62 }, logE: 1.62 },
    'Deposition 0.04/d outpaces degradation 0.02/d — the cloud is condensing; activated cells are pumping out collagen, and the matrix around them is already stiff.'],
  ['steady, activated (the fibrosis plateau)',
    { t: 60, deposition: 0.0203, degradation: 0.0201, cells: { a: 0.91 }, species: { total: 1.02 }, logE: 2.16 },
    'Deposition 0.02/d matches degradation 0.02/d — the cloud holds its shape; activated cells are pumping out collagen, replacing almost exactly the collagen that is removed — a busy balance.'],
  ['evaporating, quiet cells (unloading)',
    { t: 20, deposition: 0.0032, degradation: 0.0121, cells: { a: 0.22 }, species: { total: 0.41 }, logE: 1.1 },
    'Deposition 0.003/d trails degradation 0.01/d — the cloud is evaporating; the cells are quiet, making little collagen, so breakdown wins and the tissue thins.'],
  ['still and empty (day 0 of a bare scaffold)',
    { t: 0, deposition: 0, degradation: 0, cells: { a: 0.05 }, species: { total: 0.02 }, logE: -0.5 },
    'Deposition 0/d matches degradation 0/d — the cloud is still; there is hardly any collagen yet, so add cells, growth factor or load to start condensation.'],
  ['condensing, activated, soft matrix',
    { t: 8, deposition: 0.052, degradation: 0.006, cells: { a: 0.72 }, species: { total: 0.3 }, logE: 0.9 },
    'Deposition 0.05/d outpaces degradation 0.006/d — the cloud is condensing; activated cells are pumping out collagen, and the matrix is thickening and stiffening as they go.'],
  ['steady, half-activated cells',
    { t: 44, deposition: 0.01, degradation: 0.0101, cells: { a: 0.45 }, species: { total: 0.5 }, logE: 1.3 },
    'Deposition 0.01/d matches degradation 0.01/d — the cloud holds its shape; the cells are partly switched on, replacing collagen about as fast as it is removed.'],
  ['evaporating, half-activated cells',
    { t: 12, deposition: 0.004, degradation: 0.02, cells: { a: 0.5 }, species: { total: 0.4 }, logE: 1.2 },
    'Deposition 0.004/d trails degradation 0.02/d — the cloud is evaporating; the cells are partly switched on and cannot keep pace with breakdown.'],
  ['condensing, quiet cells (basal deposition)',
    { t: 3, deposition: 0.002, degradation: 0.0005, cells: { a: 0.1 }, species: { total: 0.2 }, logE: 0.4 },
    'Deposition 0.002/d outpaces degradation 0.001/d — the cloud is condensing; the cells are quiet, so this is slow basal deposition with little breakdown to oppose it.'],
  ['evaporating, activated cells',
    { t: 33, deposition: 0.006, degradation: 0.03, cells: { a: 0.77 }, species: { total: 0.5 }, logE: 1.4 },
    'Deposition 0.006/d trails degradation 0.03/d — the cloud is evaporating; activated cells are pumping out collagen, but breakdown is winning, and a thinning matrix pulls their activation down.'],
  ['still, with matrix already there',
    { t: 90, deposition: 0, degradation: 0, cells: { a: 0.4 }, species: { total: 0.8 }, logE: 1.9 },
    'Deposition 0/d matches degradation 0/d — the cloud is still; almost nothing is being built or removed, so nothing here is changing.'],
  ['the v0.1 stats shape is still accepted',
    { deposition: 0.03, degradation: 0.01, meanAlpha: 0.7, meanRho: 0.55, meanLogE: 1.55 },
    'Deposition 0.03/d outpaces degradation 0.01/d — the cloud is condensing; activated cells are pumping out collagen, and the matrix around them is already stiff.'],
];

describe('the fibrous equilibrium sentence is unchanged (docs/REVIEW.md C15)', () => {
  for (const [name, stats, want] of FIBROUS_CASES) {
    test(name, () => {
      assert.equal(copyEquilibriumSentence(stats, FIBROUS_V), want);
    });
  }

  test('src/tissues/fibrous.js still supplies exactly that vocabulary', () => {
    const live = (TISSUES.fibrous.copy || {}).vocabulary || {};
    assert.deepEqual({ matrix: live.matrix, cellsActive: live.cellsActive, cellsQuiet: live.cellsQuiet }, FIBROUS_V,
      'the fibrous wording moved: update FIBROUS_V and the frozen strings above in the same commit');
    for (const [, stats, want] of FIBROUS_CASES) assert.equal(copyEquilibriumSentence(stats, live), want);
  });

  test('the app passes cellStateNoun as well, which does not disturb the fibrous strings', () => {
    const asApp = Object.assign({ cellStateNoun: 'activation' }, FIBROUS_V);
    for (const [, stats, want] of FIBROUS_CASES) assert.equal(copyEquilibriumSentence(stats, asApp), want);
  });
});

describe('the vocabulary slots a second tissue needs (C15)', () => {
  const stats = { deposition: 0.04, degradation: 0.01, cells: { a: 0.8 }, species: { total: 0.6 }, logE: 1.7 };

  test('metaphor replaces the weather words without touching the rest', () => {
    const out = copyEquilibriumSentence(stats, { metaphor: { condensing: 'the tissue is building' } });
    assert.match(out, /— the tissue is building; /);
    assert.ok(!out.includes('cloud'), out);
    // the other three phrases still fall back to the defaults
    assert.match(copyEquilibriumSentence({ deposition: 0, degradation: 0, species: { total: 0.5 } }, { metaphor: { condensing: 'x' } }), /the cloud is still/);
  });

  test('activeStiff / activeSoftening / stiffHigh are the continuations after cellsActive', () => {
    const V = { cellsActive: 'the chondrocytes are working', activeStiff: 'and the cartilage around them is already firm', stiffHigh: 'enough to hold them round' };
    assert.equal(copyEquilibriumSentence(stats, V),
      'Deposition 0.04/d outpaces degradation 0.01/d — the cloud is condensing; the chondrocytes are working, and the cartilage around them is already firm enough to hold them round.');
    const soft = Object.assign({ activeSoftening: 'and the gel is still soft' }, V);
    assert.match(copyEquilibriumSentence(Object.assign({}, stats, { logE: 0.5 }), soft), /the chondrocytes are working, and the gel is still soft\.$/);
  });

  // A tissue that starts as a bare hydrogel trellis has species.total ≈ 1 on day 0 while the cells
  // have built nothing at all, so "empty" measured on the total could never fire and the sentence
  // talked about "the matrix around them" when there was no matrix. The engine already separates
  // the two (species.tissueTotal = total − every scaffold species), and the sentence keys off that.
  describe('an undissolved scaffold is not matrix (docs/EXTENDING.md §3 species.tissueTotal)', () => {
    const day0 = { t: 0, deposition: 0, degradation: 0, cells: { a: 0.1 }, species: { total: 0.98, tissueTotal: 0.003 }, logE: 1.6 };

    test('a cube full of undissolved scaffold still reads as empty', () => {
      assert.match(copyEquilibriumSentence(day0, {}), /there is hardly any matrix yet/);
      // and the tissue's own words for both halves come through
      assert.match(copyEquilibriumSentence(day0, { matrix: 'proteoglycan and collagen' }), /hardly any proteoglycan and collagen yet/);
      assert.match(copyEquilibriumSentence(day0, { stillHint: 'the gel is still a bare trellis; press Play.' }), /the gel is still a bare trellis; press Play\.$/);
    });

    test('without tissueTotal the total is used, so nothing about the v0.1 or the fibrous shape moves', () => {
      const noSplit = { deposition: 0, degradation: 0, cells: { a: 0.1 }, species: { total: 0.98 }, logE: 1.6 };
      assert.match(copyEquilibriumSentence(noSplit, {}), /almost nothing is being built or removed/);
      assert.match(copyEquilibriumSentence({ deposition: 0, degradation: 0, meanAlpha: 0.1, meanRho: 0.98, meanLogE: 1.6 }, {}), /almost nothing is being built or removed/);
      // a tissue with no scaffold species reports tissueTotal === total: byte-identical either way
      for (const [, stats, want] of FIBROUS_CASES) {
        const sp = stats.species ? { species: Object.assign({}, stats.species, { tissueTotal: stats.species.total }) } : {};
        assert.equal(copyEquilibriumSentence(Object.assign({}, stats, sp), FIBROUS_V), want);
      }
    });

    test('nothing "is already stiff" while there is no matrix to be stiff', () => {
      // a fresh hydrogel is 30–60 kPa on the undissolved trellis alone, with the cells working
      const fresh = { deposition: 0.04, degradation: 0.01, cells: { a: 0.9 }, species: { total: 0.97, tissueTotal: 0.02 }, logE: 1.6 };
      assert.ok(!/already stiff/.test(copyEquilibriumSentence(fresh, {})), copyEquilibriumSentence(fresh, {}));
      assert.match(copyEquilibriumSentence(fresh, {}), /thickening and stiffening as they go\.$/);
      // …and once the cells have built something, the stiff branch is back
      const built = Object.assign({}, fresh, { species: { total: 0.97, tissueTotal: 0.4 } });
      assert.match(copyEquilibriumSentence(built, {}), /already stiff\.$/);
    });

    test('a scaffold that has dissolved into real matrix stops reading as empty', () => {
      const later = { deposition: 0, degradation: 0, cells: { a: 0.1 }, species: { total: 0.7, tissueTotal: 0.4 }, logE: 1.6 };
      assert.match(copyEquilibriumSentence(later, {}), /almost nothing is being built or removed/);
    });
  });

  test('stillHint replaces the "add cells, growth factor or load" advice', () => {
    const empty = { deposition: 0, degradation: 0, cells: { a: 0 }, species: { total: 0 }, logE: -1 };
    assert.match(copyEquilibriumSentence(empty, { stillHint: 'the well is empty; seed it.' }), /the cloud is still; the well is empty; seed it\.$/);
    assert.match(copyEquilibriumSentence(empty, {}), /there is hardly any matrix yet/);
  });

  test('thresholds move where the sentence switches, one key at a time', () => {
    const s = { deposition: 0.011, degradation: 0.01, cells: { a: 0.5 }, species: { total: 0.5 }, logE: 1.7 };
    assert.match(copyEquilibriumSentence(s, {}), /holds its shape/);                       // ratio 1.1 < 1.15
    assert.match(copyEquilibriumSentence(s, { thresholds: { condensing: 1.05 } }), /is condensing/);
    // a tissue that calls its cells activated earlier
    assert.match(copyEquilibriumSentence(s, { thresholds: { active: 0.4 } }), /the cells are working hard/);
    // and one whose matrix counts as stiff at 100 kPa, not 30
    const stiff = { deposition: 0.04, degradation: 0.01, cells: { a: 0.8 }, species: { total: 0.6 }, logE: 1.7 };  // 50 kPa
    assert.match(copyEquilibriumSentence(stiff, {}), /already stiff/);
    assert.match(copyEquilibriumSentence(stiff, { thresholds: { stiffKPa: 100 } }), /thickening and stiffening/);
    assert.match(copyEquilibriumSentence({ deposition: 1e-7, degradation: 1e-7, species: { total: 0.5 } }, {}), /is still/);
    assert.match(copyEquilibriumSentence({ deposition: 1e-7, degradation: 1e-7, species: { total: 0.5 } }, { thresholds: { still: 1e-9 } }), /holds its shape/);
  });

  test('equilibrium(stats, V) replaces the whole sentence, and a bad one falls back', () => {
    const seen = [];
    const out = copyEquilibriumSentence(stats, { equilibrium: (s, V) => { seen.push([s, V]); return `Day ${s.t || 0}: my own sentence.`; } });
    assert.equal(out, 'Day 0: my own sentence.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].deposition, 0.04, 'the override gets the stats object');
    assert.equal(seen[0][1].matrix, 'matrix', 'and the merged vocabulary');
    assert.match(copyEquilibriumSentence(stats, { equilibrium: () => '' }), /the cloud is condensing/);
    assert.match(copyEquilibriumSentence(stats, { equilibrium: () => 42 }), /the cloud is condensing/);
    assert.match(copyEquilibriumSentence(stats, { equilibrium: () => { throw new Error('boom'); } }), /the cloud is condensing/);
  });

  test('the defaults are frozen and still carry the v0.3 words', () => {
    assert.ok(Object.isFrozen(COPY_VOCABULARY_DEFAULT));
    assert.equal(COPY_VOCABULARY_DEFAULT.matrix, 'matrix');
    assert.equal(COPY_VOCABULARY_DEFAULT.cellsActive, 'the cells are working hard');
    assert.equal(COPY_VOCABULARY_DEFAULT.metaphor.condensing, 'the cloud is condensing');
    assert.deepEqual(COPY_VOCABULARY_DEFAULT.thresholds, { quiet: 0.3, active: 0.6, empty: 0.05, stiffKPa: 30, condensing: 1.15, evaporating: 0.87, still: 1e-6 });
    // overriding one threshold must not drop the others (they are merged per key)
    assert.match(copyEquilibriumSentence({ deposition: 0, degradation: 0, species: { total: 0.01 } }, { thresholds: { quiet: 0.1 } }), /hardly any matrix yet/);
  });
});

describe('copyTrend (the dot beside the sentence, and when to announce)', () => {
  const of = (dep, deg, extra = {}) => copyTrend(Object.assign({ deposition: dep, degradation: deg }, extra), null);
  test('names the four states', () => {
    assert.equal(of(0, 0), 'still');
    assert.equal(of(0.04, 0.01), 'condensing');
    assert.equal(of(0.004, 0.02), 'evaporating');
    assert.equal(of(0.01, 0.01), 'steady');
  });
  test('agrees with the sentence at the thresholds, and honours the tissue\'s own', () => {
    assert.equal(of(0.0116, 0.01), 'condensing');   // 1.16 > 1.15
    assert.equal(of(0.0114, 0.01), 'steady');
    assert.equal(of(0.0086, 0.01), 'evaporating');  // 0.86 < 0.87
    assert.equal(copyTrend({ deposition: 0.0114, degradation: 0.01 }, { thresholds: { condensing: 1.1 } }), 'condensing');
  });
  test('is pure and tolerates junk', () => {
    assert.equal(copyTrend(null, null), 'still');
    assert.equal(copyTrend({}, {}), 'still');
    assert.equal(copyTrend({ deposition: NaN, degradation: undefined }, null), 'still');
  });
});

describe('formatters', () => {
  test('copyFormatRate', () => {
    assert.equal(copyFormatRate(12.4), '12/d');
    assert.equal(copyFormatRate(1.55), '1.6/d');
    assert.equal(copyFormatRate(0.123), '0.12/d');
    assert.equal(copyFormatRate(0.0044), '0.004/d');
    assert.equal(copyFormatRate(0.0001), '0/d');
    assert.equal(copyFormatRate(-0.5), '0.50/d', 'the magnitude only: the sign is carried by the words');
    assert.equal(copyFormatRate(NaN), '0/d');
  });
  test('copyFormatDial covers every format in docs/EXTENDING.md §1', () => {
    assert.equal(copyFormatDial('fixed2', 0.5), '0.50');
    assert.equal(copyFormatDial('percent', 0.6), '60 %');
    assert.equal(copyFormatDial('cells', 160.4), '160 cells');
    assert.equal(copyFormatDial('int', 12.6), '13');
    assert.equal(copyFormatDial('onoff', 1), 'On');
    assert.equal(copyFormatDial('onoff', 0), 'Off');
    assert.equal(copyFormatDial((v) => `${v} µm`, 300), '300 µm');
    assert.equal(copyFormatDial('fixed2', NaN), '0.00');
    assert.equal(copyFormatDial(undefined, 3), '3');
  });
});

describe('every registered tissue gets a sentence it can live with', () => {
  for (const [key, t] of Object.entries(TISSUES)) {
    test(`${key}: no placeholder, no undefined, one sentence per state`, () => {
      const voc = (t.copy || {}).vocabulary || {};
      const states = [
        { deposition: 0, degradation: 0, cells: { a: 0 }, species: { total: 0 }, logE: -1 },
        { deposition: 0, degradation: 0, cells: { a: 0.5 }, species: { total: 0.9 }, logE: 1.5 },
        { deposition: 0.05, degradation: 0.01, cells: { a: 0.9 }, species: { total: 0.9 }, logE: 2.2 },
        { deposition: 0.05, degradation: 0.01, cells: { a: 0.9 }, species: { total: 0.4 }, logE: 0.5 },
        { deposition: 0.05, degradation: 0.01, cells: { a: 0.1 }, species: { total: 0.4 }, logE: 1 },
        { deposition: 0.05, degradation: 0.01, cells: { a: 0.45 }, species: { total: 0.4 }, logE: 1 },
        { deposition: 0.005, degradation: 0.05, cells: { a: 0.9 }, species: { total: 0.4 }, logE: 1 },
        { deposition: 0.005, degradation: 0.05, cells: { a: 0.1 }, species: { total: 0.4 }, logE: 1 },
        { deposition: 0.005, degradation: 0.05, cells: { a: 0.45 }, species: { total: 0.4 }, logE: 1 },
        { deposition: 0.01, degradation: 0.01, cells: { a: 0.9 }, species: { total: 0.9 }, logE: 1.5 },
        { deposition: 0.01, degradation: 0.01, cells: { a: 0.1 }, species: { total: 0.9 }, logE: 1.5 },
        { deposition: 0.01, degradation: 0.01, cells: { a: 0.45 }, species: { total: 0.9 }, logE: 1.5 },
      ];
      const seen = new Set();
      for (const s of states) {
        const out = copyEquilibriumSentence(s, voc);
        assert.ok(out.length > 40, `too short: ${out}`);
        assert.ok(!/undefined|null|NaN|\{|\}/.test(out), `placeholder leaked into: ${out}`);
        assert.match(out, /^Deposition .*\.$|\.$/, `not a sentence: ${out}`);
        assert.ok(out.split(' ').length <= 45, `too long (${out.split(' ').length} words): ${out}`);
        seen.add(out);
      }
      assert.ok(seen.size >= 8, `only ${seen.size} distinct sentences over 12 states — a slot is probably shadowing another`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// `copy.vocabulary.equilibrium` — the one piece of EXECUTABLE copy a tissue definition can carry.
// Cartilage uses it to say the thing the shared sentence structurally cannot: the hydrogel is a
// third rate, neither deposition nor degradation, and for the first three weeks of the race it is
// what the stiffness trace is doing. Nothing exercised the override until this block: the sweep
// above feeds states with no `scaffold`, where cartilage's override correctly returns null.
describe('vocabulary.equilibrium (whole-sentence override)', () => {
  const V = TISSUES.cartilage.copy.vocabulary;
  const M = COPY_VOCABULARY_DEFAULT.metaphor;         // cartilage does not override the four words
  /** A cartilage-shaped stats object; the defaults are the race at about day 10. */
  const st = (o = {}) => ({
    deposition: 0.03, degradation: 0.01, scaffold: 0.5, scaffoldFlux: 0.04,
    cells: { a: 0.9 }, species: { total: 1.0, tissueTotal: 0.5 }, logE: 1.5, ...o,
  });

  test('while the trellis is there and draining, all three rates are in the sentence', () => {
    const out = copyEquilibriumSentence(st(), V);
    assert.match(out, /^Deposition 0\.03\/d, degradation 0\.01\/d, hydrogel draining 0\.04\/d — /);
    assert.match(out, /the chondrocytes are pumping out aggrecan/);
    assert.ok(out.endsWith('.'), `not a sentence: ${out}`);
    assert.ok(!/undefined|null|NaN|\{|\}/.test(out), `placeholder leaked into: ${out}`);
  });

  test('the race clause turns over when deposition passes the drain', () => {
    assert.match(copyEquilibriumSentence(st({ scaffoldFlux: 0.04, deposition: 0.03 }), V),
      /the trellis is going faster than they can fill in\.$/);
    assert.match(copyEquilibriumSentence(st({ scaffoldFlux: 0.01, deposition: 0.03 }), V),
      /they are filling in faster than the trellis goes\.$/);
  });

  test('the override and copyTrend never name different weather', () => {
    const cases = [
      st(),                                                            // condensing
      st({ deposition: 0.005, degradation: 0.05 }),                    // evaporating
      st({ deposition: 0.01, degradation: 0.01 }),                     // steady
      st({ deposition: 0, degradation: 0 }),                           // still
    ];
    const seen = new Set();
    for (const s of cases) {
      const out = copyEquilibriumSentence(s, V);
      const word = M[copyTrend(s, V)];
      assert.ok(out.includes(word), `copyTrend says "${word}" but the sentence reads: ${out}`);
      seen.add(word);
    }
    assert.equal(seen.size, 4, 'the four states should produce four different trend words');
  });

  test('it hands back to the shared sentence once the trellis has gone, or is not moving', () => {
    for (const s of [st({ scaffold: 0 }), st({ scaffold: 0.02 }), st({ scaffoldFlux: 0 })]) {
      const out = copyEquilibriumSentence(s, V);
      assert.ok(!/hydrogel draining/.test(out), `the override should have declined: ${out}`);
      assert.match(out, /^Deposition .* (outpaces|trails|matches) degradation .* — /);
    }
  });

  test('a partial, empty or null stats object falls back instead of throwing', () => {
    for (const s of [null, undefined, {}, { deposition: NaN, scaffold: NaN, scaffoldFlux: NaN }]) {
      const out = copyEquilibriumSentence(s, V);
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 40 && !/undefined|NaN/.test(out), `bad fallback: ${out}`);
    }
  });

  test('a throwing or non-string override is ignored, not propagated', () => {
    const boom = { ...V, equilibrium() { throw new Error('nope'); } };
    assert.match(copyEquilibriumSentence(st(), boom), /^Deposition /);
    for (const bad of [() => '', () => null, () => 42, () => ({})]) {
      assert.match(copyEquilibriumSentence(st(), { ...V, equilibrium: bad }), /^Deposition /);
    }
  });
});
