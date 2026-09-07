// src/copy.js — student-facing text for Tissue Weather.
//
// Build constraints (docs/SPEC.md §0): ES module, named exports only, no
// imports, and every top-level identifier prefixed COPY_ / copy so the
// single-file build can strip `export ` and concatenate without collisions.
//
// Voice: plain, second person, concrete. The cloud metaphor (droplets = matrix
// fibers, vapor = soluble precursors, humidity / pressure / temperature = the
// dials) is a label and a hint, not a claim. COPY_METAPHOR_BREAKS says where
// it fails. Colour words match render.js: fibers pale blue (new) to amber
// (mature); cells blue (quiescent) to orange (activated); growth factor teal;
// protease magenta.

// ---------------------------------------------------------------------------
// Dials. Keys match the model dial names used by app.js.
// biology <= 18 words, metaphor <= 10 words, watch <= 20 words.
// ---------------------------------------------------------------------------
export const COPY_DIALS = Object.freeze({
  Gext: Object.freeze({
    label: 'Growth-factor bath',
    biology: 'TGF-β-like signal in the medium. It pushes fibroblasts to activate and lay down more collagen.',
    metaphor: 'Humidity: how much vapor is available to condense.',
    watch: 'Cells turn orange as they activate, then the flux bar tips toward condensing a day or two later.',
  }),
  strain: Object.freeze({
    label: 'Mechanical load',
    biology: 'Static stretch along the vertical axis. Cells feel more tension, and fibers and cells line up with it.',
    metaphor: 'Pressure: a steady push that shapes the cloud.',
    watch: 'Fibers swing toward the arrows and the alignment trace rises; stiffness jumps at once, activation follows over days.',
  }),
  protease: Object.freeze({
    label: 'Protease activity',
    biology: 'Balance of matrix-cutting enzymes (MMPs) against their inhibitors (TIMPs). Above the middle, enzymes outnumber inhibitors.',
    metaphor: 'Temperature: heat turns droplets back into vapor.',
    watch: 'Flux bar leans toward evaporating. Pale new fibers thin first; amber mature ones resist. Switch on the protease haze.',
  }),
  nCells: Object.freeze({
    label: 'Cell number',
    biology: 'Seeding density. Each cell builds and digests matrix, so more cells amplify whichever way the balance leans.',
    metaphor: 'Condensation nuclei: droplets need something to form on.',
    watch: 'Few cells: the matrix barely changes for weeks. Many cells: the cube fills in faster, and so does breakdown.',
  }),
});

// ---------------------------------------------------------------------------
// Scenario cards. goal: one sentence. steps: three imperatives.
// question: one probing question. expect <= 30 words, checkable by a student.
// ---------------------------------------------------------------------------
export const COPY_SCENARIOS = Object.freeze({
  maturation: Object.freeze({
    title: 'Scaffold to tissue',
    goal: 'Watch a loose provisional scaffold turn into dense, aligned, mature tissue while the cells inside it change too.',
    steps: Object.freeze([
      'Press Play and let about four weeks pass at 5 days per second.',
      'Watch the fiber colour and the alignment trace, then check stiffness.',
      'Pause and note which changed first: density, alignment, or maturity.',
    ]),
    question: 'Stiffness and activation both rise. Which one is driving the other, and how would you test that with the dials?',
    expect: 'Density climbs, fibers swing toward the load arrows and turn amber over four to eight weeks, the stiffness trace climbs steadily, and cells shift from blue toward orange.',
  }),
  unloading: Object.freeze({
    title: 'Unloading',
    goal: 'Take a mature tissue off load and see how a matrix that took weeks to build slowly comes apart.',
    steps: Object.freeze([
      'Confirm load is zero and the growth-factor bath is low, then press Play.',
      'Watch the flux bar and the cell colour during the first few days.',
      'Run for six weeks and compare how fast the pale and amber fibers disappear.',
    ]),
    question: 'Nothing was added to the dish. Why does removing load alone flip the cells from building to dismantling?',
    expect: 'Cells fade back toward blue within days, the flux bar tips to evaporating, density and alignment fall over weeks, and amber mature fibers outlast the pale new ones.',
  }),
  fibrosis: Object.freeze({
    title: 'Fibrosis',
    goal: 'Push the growth-factor bath high and find out whether turning it back down undoes what it started.',
    steps: Object.freeze([
      'Press Play with the bath at 0.9 and run for four weeks.',
      'Drop the bath to 0.2 without pausing and keep running.',
      'Wait another four weeks and compare stiffness and activation with where they started.',
    ]),
    question: 'You returned the bath to its starting value. What is now holding the cells in their activated state, if not the growth factor?',
    expect: 'Dense, stiff, poorly aligned matrix by week four. After you lower the bath, stiffness and activation may dip but stay high: the tissue does not retrace its path.',
  }),
  wound: Object.freeze({
    title: 'Wound healing',
    goal: 'Injure a mature tissue and follow the repair from inflammatory burst to scar.',
    steps: Object.freeze([
      'Press Play, then click Injure and find the hole that appears.',
      'Switch on the growth-factor and protease layers and watch the wound for a week.',
      'Run for eight weeks and compare fiber colour and direction inside and outside the old wound.',
    ]),
    question: 'The hole refills with matrix, so why does the repaired patch still count as a scar rather than a regeneration?',
    expect: 'A teal and magenta flare fills the hole, nearby cells turn orange and wander in, pale tangled fibers appear within days, and they mature slowly without fully regaining alignment.',
  }),
  sandbox: Object.freeze({
    title: 'Sandbox',
    goal: 'Start from almost nothing and find a set of dials that grows a tissue you would be willing to implant.',
    steps: Object.freeze([
      'Choose dial settings and predict, out loud, which way the flux bar will tip.',
      'Press Play and check your prediction after one simulated week.',
      'Change one dial at a time and find a setting where the flux bar sits near zero.',
    ]),
    question: 'When the flux bar sits at zero, is the tissue idle or busy, and which readout would tell you?',
    expect: 'There is no single right answer. You should be able to find settings that condense, settings that evaporate, and at least one steady balance that still shows active turnover.',
  }),
});

// ---------------------------------------------------------------------------
// Readouts (plots.js). meaning <= 18 words.
// ---------------------------------------------------------------------------
export const COPY_READOUTS = Object.freeze({
  rho: Object.freeze({
    label: 'Matrix density',
    unit: 'relative (1 ≈ dense mature tissue)',
    meaning: 'Total fiber mass per volume, split into pale new matrix and amber mature crosslinked matrix.',
  }),
  fa: Object.freeze({
    label: 'Alignment',
    unit: '0–1 (fractional anisotropy)',
    meaning: 'How strongly fibers share one direction: 0 is a random tangle, 1 is a perfectly parallel bundle.',
  }),
  E: Object.freeze({
    label: 'Stiffness',
    unit: 'kPa (log scale)',
    meaning: 'How hard the matrix resists stretching. Rises with density, maturity and load; cells sense it and respond.',
  }),
  alpha: Object.freeze({
    label: 'Cell activation',
    unit: '0–1 (mean over cells)',
    meaning: 'How far cells have shifted from quiet fibroblast toward contractile, collagen-pumping myofibroblast.',
  }),
  flux: Object.freeze({
    label: 'Matrix flux',
    unit: 'density per day',
    meaning: 'Deposition against degradation right now. The bar leans toward condensing when building wins and evaporating when breakdown wins.',
  }),
});

// ---------------------------------------------------------------------------
// Live equilibrium sentence.
// ---------------------------------------------------------------------------

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

function copyNum(v) {
  return Number.isFinite(v) ? v : 0;
}

/**
 * One live sentence (<= 28 words) describing the current balance and what the
 * cells are doing. Pure: same stats in, same string out.
 *
 * stats = { deposition, degradation, meanRho, meanFA, meanAlpha, meanLogE }
 *   deposition / degradation: total rates this step (density per day)
 *   meanRho: mean fiber density; meanFA: accepted for API symmetry, unused
 *   meanAlpha: mean cell activation 0..1
 *   meanLogE: mean log10 stiffness in kPa
 *
 * Balance: ratio deposition/degradation > 1.15 condensing, < 0.87 evaporating,
 * otherwise holding shape. Cells: alpha < 0.3 quiet, > 0.6 activated.
 */
export function copyEquilibriumSentence(stats) {
  const s = stats || {};
  const dep = Math.max(0, copyNum(s.deposition));
  const deg = Math.max(0, copyNum(s.degradation));
  const alpha = copyNum(s.meanAlpha);
  const rho = copyNum(s.meanRho);
  const E = Number.isFinite(s.meanLogE) ? Math.pow(10, s.meanLogE) : NaN;

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
        ? 'the cloud is condensing; activated cells keep pumping collagen into a matrix already stiff enough to hold them switched on.'
        : 'the cloud is condensing; activated cells are pumping out collagen and stiffening the matrix that keeps them switched on.';
    } else if (cells === 'quiet') {
      tail = 'the cloud is condensing; the cells are quiet, so this is slow basal deposition with little breakdown to oppose it.';
    } else {
      tail = 'the cloud is condensing; the cells are partly activated and laying down more than the proteases remove.';
    }
  } else if (trend === 'evaporating') {
    if (cells === 'activated') {
      tail = 'the cloud is evaporating; the cells are activated, but breakdown is winning, and a softening matrix pulls activation down.';
    } else if (cells === 'quiet') {
      tail = 'the cloud is evaporating; the cells are quiet, making little collagen and more protease, so the matrix thins.';
    } else {
      tail = 'the cloud is evaporating; the cells are only partly activated and cannot keep pace with breakdown.';
    }
  } else if (cells === 'activated') {
    tail = 'the cloud holds its shape; activated cells rebuild almost exactly what the proteases remove, so this is a busy balance.';
  } else if (cells === 'quiet') {
    tail = empty
      ? 'the cloud holds its shape; there is hardly any matrix yet, so add cells, growth factor or load to start condensation.'
      : 'the cloud holds its shape; the cells are quiet and turnover is slow, so the tissue is resting, not remodelling.';
  } else {
    tail = 'the cloud holds its shape; partly activated cells replace matrix about as fast as it is removed.';
  }

  return head + ' — ' + tail;
}

// ---------------------------------------------------------------------------
// Intro panel. tagline <= 14 words; each paragraph <= 60 words.
// ---------------------------------------------------------------------------
export const COPY_INTRO = Object.freeze({
  title: 'Tissue Weather',
  tagline: 'A cloud of matrix and the cells that make it, in dynamic equilibrium.',
  paragraphs: Object.freeze([
    'You are looking at a cube of tissue about a third of a millimetre across. The rods are bundles of extracellular matrix fibers: pale blue when freshly laid down, amber once crosslinked and mature. The small bodies among them are fibroblasts. Blue ones are resting; orange ones have activated into contractile, collagen-producing myofibroblasts and stretch into spindles.',
    'The four dials are the weather. Growth-factor bath is humidity: the signal available to drive cells. Load is pressure: a steady stretch along the arrows. Protease is temperature: how fast matrix breaks back down. Cell number is the supply of condensation nuclei. Three act only through the cells; load also pulls on the fibers directly.',
    'Dynamic reciprocity, a phrase from Bissell, Hall and Parry in 1982, means the conversation runs both ways. Cells build and digest the matrix; the matrix, through its stiffness, alignment and stored growth factor, tells the cells what to become. Turn a dial and you nudge that loop. Sometimes it settles back; sometimes, as in fibrosis, it locks in.',
  ]),
});

// ---------------------------------------------------------------------------
// Where the metaphor breaks. Each claim / reality <= 25 words.
// ---------------------------------------------------------------------------
export const COPY_METAPHOR_BREAKS = Object.freeze([
  Object.freeze({
    claim: 'A cloud reshapes itself in seconds when the weather changes.',
    reality: 'Matrix turnover takes weeks in a dish and years in adult tissue. Cells respond to a dial within a day; fibers follow much later.',
  }),
  Object.freeze({
    claim: 'Droplets and vapor are the same water; condensation can always be reversed by evaporation.',
    reality: 'Crosslinked collagen resists proteases and does not become provisional matrix again. Fibrosis keeps its shape after the growth factor is gone: hysteresis.',
  }),
  Object.freeze({
    claim: 'Droplets are passive; the weather acts on them and they simply obey.',
    reality: 'Cells rewrite their own rules. A stiffer matrix activates them, and activated cells build stiffer matrix. That loop is the reciprocity.',
  }),
  Object.freeze({
    claim: 'Humidity, pressure and temperature are set from outside; the cloud cannot change its own weather.',
    reality: 'Cells release growth factor themselves, and digesting matrix frees more that was stored in it. The tissue partly makes its own humidity.',
  }),
]);

// ---------------------------------------------------------------------------
// Colour legend.
// ---------------------------------------------------------------------------
export const COPY_LEGEND = Object.freeze({
  fibers: 'Fibers: pale blue when new, amber once mature and crosslinked. Thicker rods mean denser matrix; rods that share a direction mean aligned matrix.',
  fiberNew: 'New matrix (provisional, collagen III-like)',
  fiberMature: 'Mature matrix (crosslinked collagen I)',
  cells: 'Cells: blue and round when quiet, orange and spindle-shaped when activated into myofibroblasts.',
  cellQuiescent: 'Quiescent fibroblast',
  cellActivated: 'Activated myofibroblast',
  growthFactor: 'Teal haze: growth factor (TGF-β-like). Denser haze, stronger signal. Off by default; toggle it on.',
  protease: 'Magenta haze: protease (MMP) activity. Where it is thick, matrix is being cut. Off by default; toggle it on.',
  load: 'Translucent arrows on the top and bottom faces: mechanical load along the vertical axis. Longer arrows, more stretch.',
});
