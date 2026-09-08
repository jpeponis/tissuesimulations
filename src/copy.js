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

/**
 * Words used when a tissue supplies no `copy.vocabulary` (docs/EXTENDING.md §1 `copy`).
 * Every tissue-specific fragment of the equilibrium sentence comes from here, so nothing
 * in this file assumes fibroblasts, collagen, an activation switch — or even the weather
 * metaphor. A tissue overrides only what it wants; the app may also fill in `cellStateNoun`
 * from the cell type's state labels, so a definition never has to repeat them.
 *
 *   matrix          noun phrase for what the cells build ('collagen', 'proteoglycan and collagen')
 *   cellsActive     clause: the cells are working ('the chondrocytes are pumping out aggrecan')
 *   cellsQuiet      clause: the cells are not working
 *   cellsMid        clause: the cells are halfway
 *   cellStateNoun   the cell's primary state, as a noun ('activation', 'phenotype')
 *   stiffHigh       optional continuation of `activeStiff`, used when the matrix is stiff
 *                   (E ≥ thresholds.stiffKPa) — e.g. 'enough to hold them switched on'
 *   activeStiff     continuation after `cellsActive` while condensing INTO a stiff matrix
 *   activeSoftening continuation after `cellsActive` while condensing into a matrix that is
 *                   still soft (the default says it is thickening and stiffening as they go)
 *   stillHint       clause used when there is essentially no matrix yet (density < thresholds.empty);
 *                   null → built from `matrix`
 *   metaphor        the four phrases that name the balance: { still, condensing, evaporating, steady }.
 *                   A tissue that does not want the cloud can say { still: 'the tissue is idle', … }
 *   thresholds      { quiet, active, empty, stiffKPa, condensing, evaporating, still } — where the
 *                   sentence switches. `condensing` / `evaporating` are deposition/degradation
 *                   ratios, `stiffKPa` a stiffness in kPa, `still` the rate below which both
 *                   fluxes count as zero, `empty` the density below which there is no matrix yet
 *                   (measured on species.tissueTotal, i.e. WITHOUT an undissolved scaffold)
 *   equilibrium     optional (stats, V) => string, a complete replacement for the sentence; a
 *                   falsy or non-string return falls back to the generic one
 *   scaffoldNoun    (read by the app) name of the third flux bar for a tissue whose scaffold dissolves
 *   gauge           (read by the app, not here) { left, right, ratio, caption } labels for the flux gauge
 */
export const COPY_VOCABULARY_DEFAULT = Object.freeze({
  matrix: 'matrix',
  cellsActive: 'the cells are working hard',
  cellsQuiet: 'the cells are quiet',
  cellsMid: 'the cells are partly switched on',
  cellStateNoun: 'activation',
  stiffHigh: '',
  activeStiff: 'and the matrix around them is already stiff',
  activeSoftening: 'and the matrix is thickening and stiffening as they go',
  stillHint: null,
  metaphor: Object.freeze({
    still: 'the cloud is still',
    condensing: 'the cloud is condensing',
    evaporating: 'the cloud is evaporating',
    steady: 'the cloud holds its shape',
  }),
  thresholds: Object.freeze({ quiet: 0.3, active: 0.6, empty: 0.05, stiffKPa: 30, condensing: 1.15, evaporating: 0.87, still: 1e-6 }),
  equilibrium: null,
});

/** The vocabulary a tissue actually gets: defaults, with `metaphor` and `thresholds` merged per key. */
function copyVocabulary(vocabulary) {
  const V = Object.assign({}, COPY_VOCABULARY_DEFAULT, vocabulary || {});
  V.metaphor = Object.assign({}, COPY_VOCABULARY_DEFAULT.metaphor, (vocabulary && vocabulary.metaphor) || {});
  V.thresholds = Object.assign({}, COPY_VOCABULARY_DEFAULT.thresholds, (vocabulary && vocabulary.thresholds) || {});
  return V;
}

/** The numbers the sentence and the app both key off, read out of a stats() object (either shape). */
function copyReadStats(stats, V) {
  const s = stats || {};
  const T = V.thresholds;
  const dep = Math.max(0, copyNum(s.deposition));
  const deg = Math.max(0, copyNum(s.degradation));
  const alpha = copyNum(s.cells ? s.cells.a : s.meanAlpha);
  // What counts as "matrix" here is what the CELLS have built. A tissue whose cube starts full of
  // an undissolved scaffold (a hydrogel trellis) reports `species.tissueTotal` — the same total
  // minus every scaffold species — and the sentence keys off that, so day 0 of such a tissue reads
  // "hardly any … yet" instead of counting the trellis as matrix. A tissue with no scaffold
  // species has tissueTotal === total, and the v0.1 shape (meanRho) is unchanged.
  const sp = s.species || null;
  const rho = copyNum(sp ? (Number.isFinite(sp.tissueTotal) ? sp.tissueTotal : sp.total) : s.meanRho);
  const logE = s.logE !== undefined ? s.logE : s.meanLogE;
  const E = Number.isFinite(logE) ? Math.pow(10, logE) : NaN;
  const tiny = T.still;
  const still = dep < tiny && deg < tiny;
  const ratio = deg > tiny ? dep / deg : dep > tiny ? Infinity : 1;
  const trend = still ? 'still' : ratio > T.condensing ? 'condensing' : ratio < T.evaporating ? 'evaporating' : 'steady';
  const cells = alpha < T.quiet ? 'quiet' : alpha > T.active ? 'activated' : 'partly';
  const empty = rho < T.empty;
  // "…and the matrix around them is already stiff" is a claim about the matrix the CELLS built, so
  // it cannot be made while there is none: a fresh hydrogel is 30–60 kPa on the trellis alone.
  return { dep, deg, alpha, rho, E, ratio, trend, cells, empty, stiff: Number.isFinite(E) && E >= T.stiffKPa && !empty };
}

/**
 * Which way the balance is going, in the tissue's own thresholds:
 * 'still' | 'condensing' | 'evaporating' | 'steady'. The app uses it for the dot beside the
 * sentence and to decide when a screen-reader announcement is worth making.
 */
export function copyTrend(stats, vocabulary) {
  return copyReadStats(stats, copyVocabulary(vocabulary)).trend;
}

/**
 * One live sentence (<= 28 words) describing the current balance and what the
 * cells are doing. Pure: same stats in, same string out.
 *
 * stats: an engine stats() object — deposition / degradation are MEAN density
 *   change per day over the tissue, cells.a the mean primary cell state (0..1),
 *   species.total the mean matrix density, logE the mean log10 stiffness (kPa).
 *   (The v0.1 shape meanAlpha / meanRho / meanLogE is still accepted.)
 * vocabulary: tissue.copy.vocabulary, merged over COPY_VOCABULARY_DEFAULT — every
 *   tissue-specific word is read from there, so a new tissue needs no change here.
 *   `vocabulary.equilibrium(stats, V)` replaces the sentence outright.
 *
 * Balance: ratio deposition/degradation > thresholds.condensing condensing,
 * < thresholds.evaporating evaporating, otherwise holding shape ("still" below
 * thresholds.still on both mean rates). Cells: below thresholds.quiet quiet,
 * above thresholds.active working. Empty: density < thresholds.empty.
 * Stiff: E >= thresholds.stiffKPa AND there is matrix to be stiff (density >= thresholds.empty).
 */
export function copyEquilibriumSentence(stats, vocabulary) {
  const V = copyVocabulary(vocabulary);
  if (typeof V.equilibrium === 'function') {
    let own = null;
    try { own = V.equilibrium(stats || {}, V); } catch (e) { own = null; }
    if (typeof own === 'string' && own.trim()) return own;
  }
  const m = V.metaphor;
  const { dep, deg, trend, cells, empty, stiff } = copyReadStats(stats, V);

  const verb = trend === 'condensing' ? 'outpaces' : trend === 'evaporating' ? 'trails' : 'matches';
  const head = 'Deposition ' + copyFormatRate(dep) + ' ' + verb + ' degradation ' + copyFormatRate(deg);

  const nothingYet = typeof V.stillHint === 'string' && V.stillHint
    ? V.stillHint
    : 'there is hardly any ' + V.matrix + ' yet, so add cells, growth factor or load to start condensation.';
  let tail;
  if (trend === 'still') {
    tail = empty
      ? m.still + '; ' + nothingYet
      : m.still + '; almost nothing is being built or removed, so nothing here is changing.';
  } else if (trend === 'condensing') {
    if (cells === 'activated') {
      tail = stiff
        ? m.condensing + '; ' + V.cellsActive + ', ' + V.activeStiff + (V.stiffHigh ? ' ' + V.stiffHigh : '') + '.'
        : m.condensing + '; ' + V.cellsActive + ', ' + V.activeSoftening + '.';
    } else if (cells === 'quiet') {
      tail = m.condensing + '; ' + V.cellsQuiet + ', so this is slow basal deposition with little breakdown to oppose it.';
    } else {
      tail = m.condensing + '; ' + V.cellsMid + ' and laying down more ' + V.matrix + ' than is removed.';
    }
  } else if (trend === 'evaporating') {
    if (cells === 'activated') {
      tail = m.evaporating + '; ' + V.cellsActive + ', but breakdown is winning, and a thinning matrix pulls their ' + V.cellStateNoun + ' down.';
    } else if (cells === 'quiet') {
      tail = m.evaporating + '; ' + V.cellsQuiet + ', making little ' + V.matrix + ', so breakdown wins and the tissue thins.';
    } else {
      tail = m.evaporating + '; ' + V.cellsMid + ' and cannot keep pace with breakdown.';
    }
  } else if (cells === 'activated') {
    tail = m.steady + '; ' + V.cellsActive + ', replacing almost exactly the ' + V.matrix + ' that is removed — a busy balance.';
  } else if (cells === 'quiet') {
    tail = empty
      ? m.steady + '; ' + nothingYet
      : m.steady + '; ' + V.cellsQuiet + ' and turnover is slow, so the tissue is resting, not remodelling.';
  } else {
    tail = m.steady + '; ' + V.cellsMid + ', replacing ' + V.matrix + ' about as fast as it is removed.';
  }

  return head + ' — ' + tail;
}
