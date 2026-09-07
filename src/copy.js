// src/copy.js — shared student-facing copy helpers for Tissue Weather.
//
// Tissue-specific text (dials, scenario cards, readouts, intro, metaphor
// breaks, legend, vocabulary) lives in the tissue definitions under
// src/tissues/ (docs/EXTENDING.md §1 `copy`). This file keeps only what every
// tissue shares: the live equilibrium sentence and two formatters.
//
// Build constraints (docs/EXTENDING.md): ES module, named exports only, no
// imports, every top-level identifier prefixed COPY_ / copy so the single-file
// build can strip `export ` and concatenate without collisions.
//
// Voice: plain, second person, concrete. The cloud metaphor (droplets = matrix,
// vapor = soluble precursors, humidity / pressure / temperature = the dials) is
// a label and a hint, not a claim; each tissue says where it breaks.

/** Format a rate (density per day) compactly: 0.12/d, 0.005/d, 1.5/d, 12/d. */
export function copyFormatRate(x) {
  const v = Number.isFinite(x) ? Math.abs(x) : 0;
  let s;
  if (v >= 10) s = v.toFixed(0);
  else if (v >= 1) s = v.toFixed(1);
  else if (v >= 0.01) s = v.toFixed(2);
  else if (v >= 0.0005) s = v.toFixed(3);
  else s = '0';
  return s + '/d';
}

/**
 * Format a dial value per the definition's `format` field (docs/EXTENDING.md §1):
 * 'fixed2' → 0.50 · 'percent' → 60 % · 'cells' → 160 cells · 'int' → 160 ·
 * 'onoff' → Off / On (0/1 toggle) · function → format(value).
 */
export function copyFormatDial(format, value) {
  const v = Number.isFinite(value) ? value : 0;
  if (typeof format === 'function') return String(format(v));
  switch (format) {
    case 'fixed2': return v.toFixed(2);
    case 'percent': return `${Math.round(v * 100)} %`;
    case 'cells': return `${Math.round(v)} cells`;
    case 'int': return String(Math.round(v));
    case 'onoff': return v >= 0.5 ? 'On' : 'Off';
    default: return String(v);
  }
}

function copyNum(v) {
  return Number.isFinite(v) ? v : 0;
}

/** Nouns used when a tissue supplies no `copy.vocabulary`. */
export const COPY_VOCABULARY_DEFAULT = Object.freeze({
  matrix: 'matrix',
  cellsActive: 'activated cells are building matrix',
  cellsQuiet: 'the cells are quiet',
});

/**
 * One live sentence (<= 28 words) describing the current balance and what the
 * cells are doing. Pure: same stats in, same string out.
 *
 * stats: an engine stats() object — deposition / degradation are MEAN density
 *   change per day over the tissue, cells.a the mean primary cell state (0..1),
 *   species.total the mean matrix density, logE the mean log10 stiffness (kPa).
 *   (The v0.1 shape meanAlpha / meanRho / meanLogE is still accepted.)
 * vocabulary: tissue.copy.vocabulary = { matrix, cellsActive, cellsQuiet }.
 *
 * Balance: ratio deposition/degradation > 1.15 condensing, < 0.87 evaporating,
 * otherwise holding shape ("still" below 1e-6 on both mean rates).
 * Cells: a < 0.3 quiet, > 0.6 activated. Empty: density < 0.05. Stiff: E >= 30 kPa.
 */
export function copyEquilibriumSentence(stats, vocabulary) {
  const s = stats || {};
  const V = Object.assign({}, COPY_VOCABULARY_DEFAULT, vocabulary || {});
  const dep = Math.max(0, copyNum(s.deposition));
  const deg = Math.max(0, copyNum(s.degradation));
  const alpha = copyNum(s.cells ? s.cells.a : s.meanAlpha);
  const rho = copyNum(s.species ? s.species.total : s.meanRho);
  const logE = s.logE !== undefined ? s.logE : s.meanLogE;
  const E = Number.isFinite(logE) ? Math.pow(10, logE) : NaN;

  const tiny = 1e-6;
  const still = dep < tiny && deg < tiny;
  const ratio = deg > tiny ? dep / deg : dep > tiny ? Infinity : 1;
  const trend = still ? 'still' : ratio > 1.15 ? 'condensing' : ratio < 0.87 ? 'evaporating' : 'steady';
  const cells = alpha < 0.3 ? 'quiet' : alpha > 0.6 ? 'activated' : 'partly';
  const empty = rho < 0.05;
  const stiff = Number.isFinite(E) && E >= 30;

  const verb = trend === 'condensing' ? 'outpaces' : trend === 'evaporating' ? 'trails' : 'matches';
  const head = 'Deposition ' + copyFormatRate(dep) + ' ' + verb + ' degradation ' + copyFormatRate(deg);

  let tail;
  if (trend === 'still') {
    tail = empty
      ? 'the cloud is still; there is hardly any matrix yet, so add cells, growth factor or load to start condensation.'
      : 'the cloud is still; almost nothing is being built or removed, so nothing here is changing.';
  } else if (trend === 'condensing') {
    if (cells === 'activated') {
      tail = stiff
        ? 'the cloud is condensing; ' + V.cellsActive + ' into a matrix already stiff enough to hold them switched on.'
        : 'the cloud is condensing; ' + V.cellsActive + ' and stiffening the matrix that keeps them switched on.';
    } else if (cells === 'quiet') {
      tail = 'the cloud is condensing; ' + V.cellsQuiet + ', so this is slow basal deposition with little breakdown to oppose it.';
    } else {
      tail = 'the cloud is condensing; the cells are partly activated and laying down more ' + V.matrix + ' than is removed.';
    }
  } else if (trend === 'evaporating') {
    if (cells === 'activated') {
      tail = 'the cloud is evaporating; the cells are activated, but breakdown is winning, and a softening matrix pulls activation down.';
    } else if (cells === 'quiet') {
      tail = 'the cloud is evaporating; ' + V.cellsQuiet + ', making little ' + V.matrix + ', so breakdown wins and the matrix thins.';
    } else {
      tail = 'the cloud is evaporating; the cells are only partly activated and cannot keep pace with breakdown.';
    }
  } else if (cells === 'activated') {
    tail = 'the cloud holds its shape; activated cells rebuild almost exactly the ' + V.matrix + ' that is removed, so this is a busy balance.';
  } else if (cells === 'quiet') {
    tail = empty
      ? 'the cloud holds its shape; there is hardly any matrix yet, so add cells, growth factor or load to start condensation.'
      : 'the cloud holds its shape; ' + V.cellsQuiet + ' and turnover is slow, so the tissue is resting, not remodelling.';
  } else {
    tail = 'the cloud holds its shape; partly activated cells replace ' + V.matrix + ' about as fast as it is removed.';
  }

  return head + ' — ' + tail;
}
