/*
 * Tissue Weather — generic simulation engine (docs/EXTENDING.md §2–§3, §5).
 *
 * The engine knows about a cubic grid of voxels, per-voxel matrix SPECIES
 * densities, a shared fiber orientation tensor T (trace = Σ fiber species),
 * diffusible FIELDS, motile CELLS with two state scalars (a, b) and a type, the
 * dials, the numerics, statistics and the export format.  It knows nothing
 * about what the matrix is made of or what the cells do: that comes from a
 * tissue definition (src/tissues/*.js) whose `makeRules()` returns the hooks
 * `cell(ctx)`, `voxel(ctx)` and optionally `stiffness(ctx)`.
 *
 * Pure ES module: no DOM, no `performance`, no `Math.random` (all randomness
 * comes from a mulberry32 PRNG seeded in the constructor), named exports only,
 * top-level identifiers prefixed `TissueEngine` / `ENGINE_` / `engine` / `tm` /
 * `mulberry32` so the single-file build can concatenate the sources.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONTRACT IS SILENT — choices made here (all documented in one place)
 * ---------------------------------------------------------------------------
 *  engine numerics   ENGINE_DEFAULTS adds L (cube side), K (fiber instances per
 *                    voxel, export meta only), nCellsMax (capacity of the cell
 *                    arrays; the real capacity is max(nCellsMax, cellCount dial
 *                    max)) and eps (a voxel whose fiber total is ≤ eps has its
 *                    tensor and fiber species zeroed).  `trace` must be 'fiber'.
 *  constructor       `new TissueEngine(tissue, { seed, overrides })` validates
 *                    the definition (TissueEngine.validate) and resets to the
 *                    FIRST scenario so the instance is always in a valid state.
 *  reset(key, o)     `o = { dials, init, seed }` are optional overrides merged
 *                    shallowly over the scenario's dials / init (tools and the
 *                    golden regression use them).  makeRules() is called at the
 *                    start of every reset.
 *  init.species      uniform densities with ONE jitter draw per voxel shared by
 *                    all species: density × (1 + jitter·(u − ½)), u ~ U[0,1)
 *                    (i.e. ± jitter·50 %; default jitter 0, the draw is always
 *                    consumed so the RNG stream does not depend on it), then
 *                    three draws for a random initial principal axis.  Species
 *                    not listed start at 0.  Fields with a bath start at the
 *                    bath dial's value, others at 0; `init.fields: {key: v}`
 *                    overrides that.  Cells: three draws for the position, three
 *                    for the polarity; a = cellType.init.a (default 0), b =
 *                    cellType.init.b (default 0).  With several cell types the
 *                    type of each new cell is chosen deterministically (no RNG)
 *                    so that the counts track `cellType.fraction` (default:
 *                    equal shares).
 *  init.from         pre-runs `from.scenario` for `from.days` in a fresh engine
 *                    with seed + 1 (v0.1 convention: the pre-run's RNG stream
 *                    differs from the main run's) and copies species, T, principal
 *                    axes, fields and cells.  `from.events: true` replays the source
 *                    scenario's events during the pre-run (default false: v0.1
 *                    behaviour); `from.dials` overrides its dials.  Cached per
 *                    (scenario, days, seed, events, dials) in the instance.
 *                    Chains (from → from) are allowed up to depth 4.
 *  scenario.events   OPTIONAL `events: [{ at, dials }, { at, injure: { center?, radius? } }]`
 *                    applied by checkScenario() and the headless tools when the
 *                    clock reaches day `at` (before stepping on).  The app may
 *                    treat them as suggestions (v0.1 never auto-injured).
 *  checks            `{ at, stat, op, value }` or `{ at, stat, rel: { stat, op, at? }, value? }`:
 *                    with `rel` the check passes when stat(at) op (rel.stat at
 *                    rel.at (default: same day) + value (default 0)).  `at` may also be a
 *                    WINDOW `[from, to]` with `agg: 'min' | 'max' | 'mean' | 'first'`, which
 *                    checkScenario evaluates on samples every 0.5 d inside the window (a
 *                    `rel` reference day then defaults to `from`).
 *  cell hook outputs out.a / out.b are pre-filled with the current values (so a
 *                    hook that does not write them leaves the state unchanged);
 *                    out.aSum is pre-filled with NaN and the engine substitutes
 *                    out.a ("default a") when the hook leaves it; every other
 *                    output is zeroed.  ctx.fz is |f_z|.  ctx.rho reflects the
 *                    deposition of cells processed earlier in the same step;
 *                    ctx.fiberTotal, ctx.fa, ctx.E are from the last voxel pass.
 *  voxel hook        out.E is pre-filled with the voxel's current E; the engine
 *                    applies dRho first (clamp ≥ 0), then rescales T so that its
 *                    trace equals the new fiber total (this both applies the loss
 *                    and keeps trace(T) = Σ fiber species exact), then the
 *                    passive load alignment, the trace clamp (T AND the fiber
 *                    species are scaled), the PSD guard.  A fiber total that
 *                    appears in a voxel with a zero tensor is added isotropically.
 *  species.D/sink    OPTIONAL per-species transport (v0.3, off unless the species declares it).
 *                    `D` (L²/day) diffuses the species AFTER the voxel pass with the same
 *                    explicit 6-neighbour zero-flux scheme as the fields (the per-face
 *                    diffusion number is clamped ≤ 1/6, so the pass is unconditionally
 *                    stable); `sink` (/day) removes sink·rho·dt from the +z face layer only
 *                    (`boundary: 'face:+z'`, the only species boundary — "washes out into the
 *                    medium").  A FIBER species carries its share of the orientation tensor
 *                    with it: the tensor flux across a face is (mass flux)·T(source)/
 *                    fiberTotal(source), which keeps trace(T) = Σ fiber species exact; after
 *                    the pass T is rescaled onto the new fiber total and FA / the principal
 *                    axis are refreshed (same math as the voxel pass, same fEvery cadence).
 *                    Transport is hindered by the voxel hook's OPTIONAL out.mobility ∈ [0,1]
 *                    (default 1, e.g. a tight hydrogel mesh); a face uses the mean of its two
 *                    voxels.  Sink loss counts as degradation, or as scaffoldFlux for a
 *                    species of kind 'scaffold'.
 *  out.mobility      voxel-hook output, only read when some species has D (see above).
 *  out.polS/alignS   OPTIONAL per-fiber-species orientation of a cell's deposition
 *                    (Float32Array indexed by SPECIES index).  They are read only when the
 *                    hook sets out.usePolS = true (one store per cell otherwise); an entry
 *                    left NaN falls back to the scalar out.pol / out.align, and the engine
 *                    refills both arrays with NaN after a cell that used them.  polS is exact
 *                    (each fiber species is deposited with its own orientation strength);
 *                    T is shared, so alignS is applied as ONE realignment rate, the mean of
 *                    alignS weighted by the post-deposition local density of each fiber
 *                    species (nothing to realign ⇒ rate 0).
 *  out.vox[k]        general per-voxel accumulators, k < engine.vox (ENGINE_DEFAULTS.vox = 1,
 *                    max 4), summed over the cells of a voxel and handed to voxel() as
 *                    ctx.vox[k].  Accumulator 0 IS the legacy aSum: it defaults to NaN and the
 *                    engine substitutes out.aSum, or the cell's new `a` when that is NaN too;
 *                    accumulators 1..3 default to 0.  ctx.aSum stays an alias of ctx.vox[0].
 *  out.scaffoldLoss  voxel-hook output (≥ 0): dissolution of a 'scaffold' species, which is
 *                    neither deposition nor degradation of tissue.  stats().scaffoldFlux is
 *                    its mean per-voxel rate (a third flux bar).
 *  cellType.states   `[{ key: 'a'|'b'|'c', label, range }]` labels and ranges the cell scalars;
 *                    `stateLabels` / `cRange` remain accepted aliases (TissueEngine.cellStates
 *                    merges the two forms).  Only `c` may have a range other than [0, 1]:
 *                    the renderer maps a and b on [0, 1].
 *  cellType.radius   number, or `{ by: 'a'|'b', min, max }` — validated here, consumed by the
 *                    renderer; exportMeta emits the state-0 value as `radius` (so format-2
 *                    readers keep working) plus `radiusBy` when it varies.
 *  engine.scratch    a plain object the engine creates once per instance and never touches.
 *                    makeRules() may allocate per reset and cache arrays there (e.g. a
 *                    neighbour table for this N) instead of on a module-level map.
 *  field/species mode  OPTIONAL 'auto' (default) | 'explicit' | 'subcycled' | 'quasiSteady'
 *                    (fields only).  The diffusive passes are explicit 6-neighbour stencils, so
 *                    they are stable only while lam = D·dt/h² ≤ 1/6.  v0.3 clamped lam there,
 *                    which silently integrates a fast field with a smaller D; the mode is now
 *                    chosen ONCE at construction from lam: explicit (≤ 1/6, bit-identical to
 *                    v0.3), sub-cycled (nSub = ceil(6·lam) sub-steps of dt/nSub, sources / bath /
 *                    decay / Dirichlet face applied per sub-step, capped at ENGINE_SUB_MAX) or,
 *                    for a field whose steady problem is well posed (Dirichlet face, kBath or
 *                    decay), a warm-started over-relaxed Gauss-Seidel steady solve clamped ≥ 0.
 *                    The steady solve lags the hooks' sources by one step, so it moves the field
 *                    ENGINE_QS_THETA of the way to each solution (same fixed point, no
 *                    oscillation when the source depends on the field).  `engine.fieldModes` /
 *                    `speciesModes` report what was chosen; validate() warns once per definition.
 *  engine.loadMode   'tension' (default: T relaxes onto the load axis z, the v0.3 behaviour) or
 *                    'compression' (T relaxes into the plane ⊥ to z; a cell's out.loadAlign
 *                    likewise pulls its polarity into that plane).  Trace-preserving either way.
 *  cellType.motile   `false` is honoured: the cell keeps its polarity and position (no guidance,
 *                    load alignment, noise draws or migration) and repulsion moves only the
 *                    motile partner of a pair, so it acts as an obstacle.  Its hooks still run.
 *  cellType.rCell    OPTIONAL per-type repulsion radius (default engine.rCell); a pair's contact
 *                    distance is rCell_i + rCell_j.  validate() warns when 2·max(rCell) ≥ h,
 *                    which is the assumption behind the 27-bin neighbour search.
 *  cellType.count    OPTIONAL absolute number of cells of this type (instead of `fraction`).
 *                    With a cellCount dial the dial still sets the TOTAL: counted types are
 *                    seeded first (scaled down together if they do not fit), the rest share what
 *                    is left by fraction, and removals take from the types above their target.
 *  revision          monotonic counter on the instance and in `state`, bumped by step (once per
 *                    simulated step), reset, injure and a setDials that resolved a dial.  A
 *                    renderer keys its dirty-check on it and falls back to "always update" when
 *                    it is undefined.
 *  warmFrom/         resumable init.from pre-runs: warmFrom(from, maxSteps) advances the pre-run
 *  warmScenarios     for `from` by at most maxSteps steps and caches it when it finishes;
 *                    warmScenarios(maxSteps) does one slice for the first scenario that is not
 *                    cached yet.  Slicing is bit-identical to the synchronous pre-run (events
 *                    fire on the same day boundaries) and _loadFrom falls back to it.
 *  stats().cells     .byType.<cellType key> = { n, a, b, c }; stat paths 'cells.byType.<key>'
 *                    (the count) and 'cells.byType.<key>.a|b|c|n'.
 *  snapshot().fields per-frame field grids (4 decimals), one per declared field; exportMeta adds
 *                    `fields` (key/label/colour), `loadRange` ([min, max] of the load dial),
 *                    `tissueName` and `scenarioTitle`.  All additive: format 2 readers are fine.
 *  validate warnings TissueEngine.warnings(t, { overrides }) returns non-fatal notes (field or
 *                    species mode, repulsion range vs h, cell seeding); validate() prints each
 *                    once per definition with console.warn and still returns only hard errors.
 *  field.boundary    OPTIONAL 'bath' (default: relaxation toward the bath dial
 *                    everywhere at kBath) or 'face:+z' / 'face:-z' (Dirichlet:
 *                    the voxels of that z layer are held at the bath dial's value
 *                    after every step, no bulk relaxation, all other walls
 *                    zero-flux — e.g. oxygen entering from the medium face).
 *                    Consumption is a negative cell fieldSrc; fields stay ≥ 0.
 *  cell state c      a third per-cell scalar next to a and b (ctx.c, out.c,
 *                    state.cc, stats.cells.c, snapshot cells.c), clamped to
 *                    cellType.cRange (default [0, 1]); initial value
 *                    cellType.init.c (default 0).  Swap-remove moves it too.
 *  load axis         z, fixed.  With no role:'load' dial ctx.load = 0 and the
 *                    passive alignment is off (hooks may still output loadAlign).
 *  polarity noise    `out.noise` rad/√day → three Gaussian draws (each the sum
 *                    of three uniforms) per cell per step, only when noise > 0.
 *  stats().fz        Tzz / trace of the MEAN tensor (alignment with the load
 *                    axis; 1/3 when there is no fiber).  ratio = deposition /
 *                    degradation (Infinity if only deposition, 1 if both are 0).
 *                    species.total includes the scaffold
 *                    species, species.tissueTotal does not; stats().scaffold is their sum.
 *                    cumDeposition / cumDegradation are the integrals of deposition and
 *                    degradation since the last reset (density, not density/day).
 *  stat(path)        also accepts 'fz', 'cells.n', 't', 'species.fiberTotal',
 *                    'species.tissueTotal', 'scaffold', 'scaffoldFlux', 'cumDeposition' and
 *                    'cumDegradation'.
 *  exportMeta(extra) merges `extra` (e.g. { exportEveryDays }) into the meta; `loadDial` and
 *                    `cellCountDial` name the dials with those roles (null when there is none).
 *  woundStats()      means inside the last wound sphere (null without a wound).
 *  checkScenario     `{ seed = 7, engine }`: pass an existing engine of the same
 *                    tissue to reuse its init.from cache.
 * ---------------------------------------------------------------------------
 */

export const ENGINE_VERSION = '0.3.0';

/** Engine-level numerics; a tissue's `engine` block and constructor `overrides` are merged over these. */
export const ENGINE_DEFAULTS = Object.freeze({
  N: 12,            // voxels per side
  L: 1,             // cube side (≈ 300 µm)
  dt: 0.02,         // days per step
  K: 3,             // fiber instances per voxel (render / export meta only)
  rhoMax: 2,        // trace clamp on the fiber total
  kLoadFib: 0.06,   // /day passive alignment of T toward z, × load^loadExp
  loadExp: 2,       // exponent of the load dial in the passive alignment
  fEvery: 4,        // refresh the principal axis every fEvery steps
  rCell: 0.03,      // cell radius (repulsion range 2·rCell)
  kRep: 0.5,        // repulsion stiffness
  trace: 'fiber',   // T trace = Σ fiber species (the only supported mode)
  nCellsMax: 400,   // minimum capacity of the cell arrays
  eps: 1e-6,        // fiber total below which a voxel's tensor is zeroed
  vox: 1,           // per-voxel cell accumulators out.vox[0..vox−1] (1..4; 0 is the legacy aSum)
  loadMode: 'tension',  // passive alignment of T: 'tension' (toward the load axis z) | 'compression' (into the ⊥ plane)
});

/** Integration modes of the diffusive passes (fields, species transport), by index. */
export const ENGINE_MODES = Object.freeze(['explicit', 'subcycled', 'quasiSteady']);
const ENGINE_LAM_STABLE = 1 / 6;   // largest stable diffusion number of the explicit 6-neighbour stencil
const ENGINE_SUB_MAX = 20;         // cap on explicit sub-steps per step (beyond it, 'auto' goes quasi-steady)
const ENGINE_QS_TOL = 1e-4;        // quasi-steady solve: converged when no voxel moves by more than this
const ENGINE_QS_SWEEPS = 50;       // quasi-steady solve: at most this many Gauss-Seidel sweeps per step
const ENGINE_QS_THETA = 0.5;       // quasi-steady solve: how far the field moves toward the solve each step

/**
 * Pick the integration mode of one diffusive quantity from its diffusion number lam = D·dt/h².
 *   'explicit'     one explicit step; lam is CLAMPED at 1/6 (the v0.3 behaviour: stable, but a
 *                  clamped field integrates with a smaller D than the definition asks for)
 *   'subcycled'    nSub = ceil(6·lam) explicit sub-steps of dt/nSub, sources/bath/decay per sub-step
 *   'quasiSteady'  the diffusion is far faster than the step: solve the steady state instead
 *   'auto'         explicit while lam ≤ 1/6, then sub-cycled, then (if the steady problem is well
 *                  posed) quasi-steady once more than ENGINE_SUB_MAX sub-steps would be needed
 * `steady` says whether a steady solve is well posed (Dirichlet face, bath relaxation or decay).
 * Returns { mode: 0 | 1 | 2 (index into ENGINE_MODES), nSub, nWant, capped, fellBack }.
 */
function engineDiffusionMode(lam, want = 'auto', steady = false) {
  const nWant = lam > ENGINE_LAM_STABLE ? Math.ceil(6 * lam) : 1;
  if (want === 'explicit') return { mode: 0, nSub: 1, nWant, capped: nWant > 1, fellBack: false };
  const fellBack = want === 'quasiSteady' && !steady;
  if (want === 'quasiSteady' && steady) return { mode: 2, nSub: 1, nWant, capped: false, fellBack: false };
  if (want === 'auto' && nWant > ENGINE_SUB_MAX && steady) return { mode: 2, nSub: 1, nWant, capped: false, fellBack: false };
  const nSub = nWant > ENGINE_SUB_MAX ? ENGINE_SUB_MAX : nWant;
  return { mode: nSub > 1 ? 1 : 0, nSub, nWant, capped: nWant > ENGINE_SUB_MAX, fellBack };
}

/** mulberry32 PRNG: returns a function producing uniform floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function tmRand() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tmClamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/** Round a typed array into a plain array with `digits` decimals (for JSON). */
export function tmRoundArray(arr, digits) {
  const f = 10 ** digits, out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * f) / f;
  return out;
}

const ENGINE_OPS = Object.freeze({
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
  between: (a, b) => Array.isArray(b) && a >= b[0] && a <= b[1],
});
const ENGINE_AGGS = Object.freeze({
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  mean: (a) => a.reduce((x, y) => x + y, 0) / a.length,
  first: (a) => a[0],
});
/** Species keys the stat paths reserve (species.total & co. would be shadowed). */
const ENGINE_RESERVED_SPECIES = Object.freeze(['total', 'fiberTotal', 'tissueTotal']);
const ENGINE_FORMATS = Object.freeze(['fixed2', 'percent', 'cells', 'int', 'onoff']);
const ENGINE_HEX = /^#[0-9a-fA-F]{6}$/;
const ENGINE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGINE_TISSUE_KEY = /^[a-z0-9-]+$/;
/** Warnings already printed, per definition object, so validate() only says each thing once. */
const ENGINE_WARNED = new WeakMap();
const engineFmt = (x) => (x === 0 ? '0' : (Math.abs(x) >= 1e-3 && Math.abs(x) < 1e5 ? String(+x.toPrecision(3)) : x.toExponential(2)));

/** Resolve a §1 stat path against a stats() object; undefined if unknown. */
function engineStatFrom(s, path) {
  switch (path) {
    case 't': return s.t;
    case 'fa': return s.fa;
    case 'globalFA': return s.globalFA;
    case 'fz': return s.fz;
    case 'logE': return s.logE;
    case 'E': return s.E;
    case 'deposition': return s.deposition;
    case 'degradation': return s.degradation;
    case 'ratio': return s.ratio;
    case 'cumDeposition': return s.cumDeposition;
    case 'cumDegradation': return s.cumDegradation;
    case 'scaffold': return s.scaffold;
    case 'scaffoldFlux': return s.scaffoldFlux;
    case 'species.total': return s.species.total;
    case 'species.fiberTotal': return s.species.fiberTotal;
    case 'species.tissueTotal': return s.species.tissueTotal;
    case 'fiber.total': return s.species.fiberTotal;
    case 'cells.a': return s.cells.a;
    case 'cells.b': return s.cells.b;
    case 'cells.c': return s.cells.c;
    case 'cells.n': return s.cells.n;
    default: break;
  }
  const p = path.split('.');
  if (p[0] === 'species' && p.length === 2) return s.species[p[1]];
  if (p[0] === 'species' && p.length === 3 && p[2] === 'fraction') return s.fraction[p[1]];
  if (p[0] === 'fields' && p.length === 2) return s.fields[p[1]];
  if (p[0] === 'cells' && p[1] === 'byType' && (p.length === 3 || p.length === 4)) {
    const bt = s.cells && s.cells.byType ? s.cells.byType[p[2]] : undefined;
    if (bt === undefined) return undefined;
    return p.length === 3 ? bt.n : bt[p[3]];
  }
  return undefined;
}

/** Is `path` a stat path that exists for this definition (species/field keys resolved)? */
function engineStatPathValid(tissue, path) {
  if (typeof path !== 'string') return false;
  if (['t', 'fa', 'globalFA', 'fz', 'logE', 'E', 'deposition', 'degradation', 'ratio', 'species.total', 'species.fiberTotal',
    'species.tissueTotal', 'scaffold', 'scaffoldFlux', 'cumDeposition', 'cumDegradation',
    'fiber.total', 'cells.a', 'cells.b', 'cells.c', 'cells.n'].includes(path)) return true;
  const p = path.split('.');
  const sKeys = (tissue.species || []).map((s) => s.key), fKeys = (tissue.fields || []).map((f) => f.key);
  if (p[0] === 'species' && p.length === 2) return sKeys.includes(p[1]);
  if (p[0] === 'species' && p.length === 3 && p[2] === 'fraction') return sKeys.includes(p[1]);
  if (p[0] === 'fields' && p.length === 2) return fKeys.includes(p[1]);
  if (p[0] === 'cells' && p[1] === 'byType' && (p.length === 3 || p.length === 4)) {
    return (tissue.cellTypes || []).some((c) => c.key === p[2]) && (p.length === 3 || ['a', 'b', 'c', 'n'].includes(p[3]));
  }
  return false;
}

export class TissueEngine {
  /**
   * @param {object} tissue     a tissue definition (docs/EXTENDING.md §1)
   * @param {object} opts       { seed: uint32, overrides: { N, dt, ... engine numerics } }
   */
  constructor(tissue, opts = {}) {
    const errors = TissueEngine.validate(tissue, { overrides: opts.overrides });
    if (errors.length) throw new Error(`invalid tissue definition '${tissue && tissue.key}': ${errors.join('; ')}`);
    this.tissue = tissue;
    this.seed = (opts.seed === undefined ? 20240907 : opts.seed) >>> 0;
    this._overrides = Object.assign({}, opts.overrides || {});
    this._depth = opts._depth | 0;
    const P = this.P = Object.freeze(Object.assign({}, ENGINE_DEFAULTS, tissue.engine || {}, this._overrides));
    if (P.trace !== 'fiber') throw new Error(`engine.trace '${P.trace}' is not supported (only 'fiber')`);
    const N = this.N = P.N | 0, NV = this.NV = N * N * N;
    this.L = P.L; this.h = P.L / N; this.dt = P.dt;
    this.rng = mulberry32(this.seed);

    // ---- species
    this.speciesKeys = tissue.species.map((s) => s.key);
    this.speciesIndex = {};
    this.speciesKeys.forEach((k, i) => { this.speciesIndex[k] = i; });
    this.nSpecies = this.speciesKeys.length;
    this.species = this.speciesKeys.map(() => new Float32Array(NV));
    this._isFiber = new Uint8Array(this.nSpecies);
    const fiberIdx = [];
    tissue.species.forEach((s, i) => { if (s.kind === 'fiber') { this._isFiber[i] = 1; fiberIdx.push(i); } });
    this._fiberIdx = Int32Array.from(fiberIdx);
    this._lastFiber = fiberIdx.length ? fiberIdx[fiberIdx.length - 1] : -1;
    // OPT-IN species transport: D (L²/day) diffuses, sink (/day) drains the +z face layer
    this._isScaffold = new Uint8Array(this.nSpecies);
    this._sD = new Float64Array(this.nSpecies); this._sSink = new Float64Array(this.nSpecies);
    const diffIdx = [], sinkIdx = [];
    tissue.species.forEach((s, i) => {
      if (s.kind === 'scaffold') this._isScaffold[i] = 1;
      if (s.D > 0) { this._sD[i] = s.D; diffIdx.push(i); }
      if (s.sink > 0) { this._sSink[i] = s.sink; sinkIdx.push(i); }
    });
    this._diffIdx = Int32Array.from(diffIdx); this._sinkIdx = Int32Array.from(sinkIdx);
    // integration mode per diffusing species (A1): explicit while lam ≤ 1/6, then sub-cycled
    this._sMode = new Int8Array(this.nSpecies); this._sSub = new Int32Array(this.nSpecies).fill(1);
    this.speciesModes = tissue.species.map((sp, i) => {
      const lam = this._sD[i] * P.dt / (this.h * this.h);
      const r = engineDiffusionMode(lam, sp.mode || 'auto', false);
      this._sMode[i] = r.mode; this._sSub[i] = r.nSub;
      return { key: sp.key, D: this._sD[i], lam, mode: ENGINE_MODES[r.mode], nSub: r.nSub, capped: r.capped };
    });
    this._anyTransport = diffIdx.length > 0 || sinkIdx.length > 0;
    this._anyFiberD = diffIdx.some((i) => this._isFiber[i]);
    this._anyFiberMoves = this._anyFiberD || sinkIdx.some((i) => this._isFiber[i]);
    this._mob = diffIdx.length ? new Float64Array(NV).fill(1) : null;   // voxel hook out.mobility
    this._sDelta = diffIdx.length ? new Float64Array(NV) : null;
    this._tDelta = this._anyFiberD ? new Float64Array(6 * NV) : null;   // 6 components per voxel, interleaved
    this._fiberArrays = this._anyFiberMoves ? new Array(fiberIdx.length) : null;
    this._tScaf = 0;

    // ---- orientation tensor and derived per-voxel fields
    this.Txx = new Float32Array(NV); this.Tyy = new Float32Array(NV); this.Tzz = new Float32Array(NV);
    this.Txy = new Float32Array(NV); this.Txz = new Float32Array(NV); this.Tyz = new Float32Array(NV);
    this.fiberTotal = new Float32Array(NV);
    this.fa = new Float32Array(NV);
    this.fx = new Float32Array(NV); this.fy = new Float32Array(NV); this.fz = new Float32Array(NV);
    this.E = new Float32Array(NV);
    this.inflam = new Float32Array(NV);

    // ---- dials
    this.dialKeys = tissue.dials.map((d) => d.key);
    this.dialIndex = {};
    this.dialKeys.forEach((k, i) => { this.dialIndex[k] = i; });
    this.nDials = this.dialKeys.length;
    this._dialVals = new Float64Array(this.nDials);
    this.dials = {};
    this._loadDial = -1; this._cellDial = -1;
    tissue.dials.forEach((d, i) => {
      this._dialVals[i] = d.default; this.dials[d.key] = d.default;
      if (d.role === 'load') this._loadDial = i;
      if (d.role === 'cellCount') this._cellDial = i;
    });

    // ---- fields
    this.fieldKeys = tissue.fields.map((f) => f.key);
    this.fieldIndex = {};
    this.fieldKeys.forEach((k, i) => { this.fieldIndex[k] = i; });
    this.nFields = this.fieldKeys.length;
    this.fields = this.fieldKeys.map(() => new Float32Array(NV));
    this._fields2 = this.fieldKeys.map(() => new Float32Array(NV));
    this._fieldSrc = this.fieldKeys.map(() => new Float64Array(NV));
    this._fD = new Float64Array(this.nFields); this._fKBath = new Float64Array(this.nFields);
    this._fDecay = new Float64Array(this.nFields); this._fBathDial = new Int32Array(this.nFields).fill(-1);
    this._fInfl = new Float64Array(this.nFields); this._fBurst = new Float64Array(this.nFields);
    this._fBoundary = new Int8Array(this.nFields);   // 0 bath, +1 face:+z (k = N−1 held), −1 face:−z (k = 0 held)
    tissue.fields.forEach((f, i) => {
      this._fD[i] = f.D || 0; this._fKBath[i] = f.kBath || 0; this._fDecay[i] = f.decay || 0;
      this._fBathDial[i] = f.bath ? this.dialIndex[f.bath] : -1;
      this._fBoundary[i] = f.boundary === 'face:+z' ? 1 : (f.boundary === 'face:-z' ? -1 : 0);
    });
    // integration mode per field (A1): explicit / sub-cycled / quasi-steady, chosen from lam = D·dt/h²
    this._fMode = new Int8Array(this.nFields); this._fSub = new Int32Array(this.nFields).fill(1);
    this._fQSteady = new Uint8Array(this.nFields);
    this.fieldModes = tissue.fields.map((f, i) => {
      const lam = this._fD[i] * P.dt / (this.h * this.h);
      const steady = TissueEngine._steadySolvable(f);
      const r = engineDiffusionMode(lam, f.mode || 'auto', steady);
      this._fMode[i] = r.mode; this._fSub[i] = r.nSub; this._fQSteady[i] = steady ? 1 : 0;
      return { key: f.key, D: this._fD[i], lam, mode: ENGINE_MODES[r.mode], nSub: r.nSub, capped: r.capped, steady };
    });
    this._qsOmega = 2 / (1 + Math.sin(Math.PI / Math.max(2, N)));   // SOR factor of the quasi-steady sweeps
    this._qsTheta = ENGINE_QS_THETA;                                // damping of the lagged-source iteration
    const inj = tissue.injury || null;
    this._inflTau = inj && inj.inflammation ? inj.inflammation.tau : 0;
    if (inj && inj.inflammation && inj.inflammation.sources) {
      for (const [k, v] of Object.entries(inj.inflammation.sources)) this._fInfl[this.fieldIndex[k]] = v;
    }
    if (inj && inj.fieldBurst) for (const [k, v] of Object.entries(inj.fieldBurst)) this._fBurst[this.fieldIndex[k]] = v;
    this._clearSpecies = inj ? Int32Array.from((inj.clearSpecies || []).map((k) => this.speciesIndex[k])) : new Int32Array(0);

    // ---- cells (fixed capacity, `nCells` live)
    const cellDial = this._cellDial >= 0 ? tissue.dials[this._cellDial] : null;
    this.cap = Math.max(P.nCellsMax | 0, cellDial ? Math.max(cellDial.max, cellDial.default) | 0 : 0, 1);
    this.nTypes = tissue.cellTypes.length;
    this._typeFraction = new Float64Array(this.nTypes);
    this._typeCount = new Int32Array(this.nTypes);
    let fracSum = 0;
    tissue.cellTypes.forEach((c, i) => { this._typeFraction[i] = c.fraction === undefined ? 1 : c.fraction; fracSum += this._typeFraction[i]; });
    for (let i = 0; i < this.nTypes; i++) this._typeFraction[i] /= fracSum || 1;
    this._typeMotile = Uint8Array.from(tissue.cellTypes.map((c) => (c.motile === false ? 0 : 1)));
    this._allMotile = this._typeMotile.every((m) => m === 1);
    this._typeRCell = Float64Array.from(tissue.cellTypes.map((c) => (typeof c.rCell === 'number' ? c.rCell : P.rCell)));
    this._sameRCell = this._typeRCell.every((r) => r === P.rCell);
    this._typeWanted = Int32Array.from(tissue.cellTypes.map((c) => (Number.isInteger(c.count) ? c.count : -1)));
    this._anyTypeCount = this._typeWanted.some((c) => c >= 0);
    this._typeShare = this._anyTypeCount ? new Float64Array(this.nTypes) : this._typeFraction;
    this._typeTarget = this._anyTypeCount ? new Float64Array(this.nTypes) : null;
    this._typeInitA = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.a) || 0));
    this._typeInitB = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.b) || 0));
    this._typeInitC = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.c) || 0));
    const cRangeOf = (c) => { const st = (c.states || []).find((s) => s.key === 'c' && Array.isArray(s.range)); return st ? st.range : (c.cRange || [0, 1]); };
    this._typeCMin = Float64Array.from(tissue.cellTypes.map((c) => cRangeOf(c)[0]));
    this._typeCMax = Float64Array.from(tissue.cellTypes.map((c) => cRangeOf(c)[1]));
    this._cx = new Float32Array(3 * this.cap);
    this._cp = new Float32Array(3 * this.cap);
    this._ca = new Float32Array(this.cap);
    this._cb = new Float32Array(this.cap);
    this._cc = new Float32Array(this.cap);
    this._ctype = new Uint8Array(this.cap);
    this._vox = new Int32Array(this.cap);
    this._dx = new Float32Array(3 * this.cap);
    this._binStart = new Int32Array(NV + 1); this._binCursor = new Int32Array(NV); this._binCell = new Int32Array(this.cap);
    this._views = { n: -1, cx: null, cp: null, ca: null, cb: null, cc: null, ctype: null };
    this.nCells = 0;

    // ---- per-step scratch: `vox` per-voxel accumulators (0 is the legacy aSum)
    const nVox = this.nVox = Math.max(1, Math.min(4, P.vox | 0));
    this._acc = [];
    for (let q = 0; q < nVox; q++) this._acc.push(new Float64Array(NV));
    this._aSum = this._acc[0];
    this._cellCount = new Int32Array(NV);
    this._statA = new Float64Array(this.nTypes); this._statB = new Float64Array(this.nTypes);
    this._statC = new Float64Array(this.nTypes); this._statN = new Int32Array(this.nTypes);

    // ---- a place for makeRules() to cache per-reset allocations (never touched by the engine)
    this.scratch = {};

    // ---- reusable hook contexts (monomorphic: every field initialised once)
    const self = this;
    this._cctx = {
      i: 0, type: 0, a: 0, b: 0, c: 0, dt: this.dt,
      rho: new Float32Array(this.nSpecies), fiberTotal: 0, fa: 0, fz: 0,
      field: new Float32Array(this.nFields), E: 0, dial: this._dialVals, load: 0, cellsInVoxel: 0,
      rng: () => self.rng(),
      out: { a: 0, b: 0, c: 0, secrete: new Float64Array(this.nSpecies), pol: 0, align: 0, fieldSrc: new Float64Array(this.nFields),
        speed: 0, guide: 0, loadAlign: 0, noise: 0, aSum: 0, vox: new Float64Array(nVox),
        usePolS: false, polS: new Float32Array(this.nSpecies).fill(NaN), alignS: new Float32Array(this.nSpecies).fill(NaN) },
    };
    this._vctx = {
      v: 0, dt: this.dt, rho: new Float32Array(this.nSpecies), fiberTotal: 0, fa: 0, Tzz_over_trace: 0,
      field: new Float32Array(this.nFields), dial: this._dialVals, load: 0, aSum: 0, vox: new Float64Array(nVox),
      nCellsHere: 0, inflam: 0,
      out: { dRho: new Float64Array(this.nSpecies), loss: 0, scaffoldLoss: 0, fieldSrc: new Float64Array(this.nFields), E: 0, mobility: 1 },
    };

    this.rules = null;
    this.scenario = null;
    this.revision = 0;          // monotonic; bumped by step / reset / injure / setDials (B1)
    this.time = 0; this.stepCount = 0;
    this.wound = null;
    this._lastDep = 0; this._lastDeg = 0; this._lastScafLoss = 0;
    this._cumDep = 0; this._cumDeg = 0;
    this._fromCache = new Map();
    this._warm = new Map();     // resumable init.from pre-runs (warmFrom / warmScenarios)

    this.reset(tissue.scenarios[0].key);
  }

  // ------------------------------------------------------------------ setup

  /** Scenario definition by key (throws if unknown). */
  scenarioDef(key) {
    const sc = this.tissue.scenarios.find((s) => s.key === key);
    if (!sc) throw new Error(`unknown scenario '${key}' for tissue '${this.tissue.key}'`);
    return sc;
  }

  /**
   * Reset to a scenario. Optional overrides { dials: {...}, init: {...}, seed } are merged
   * shallowly over the scenario's own dials / init.
   */
  reset(scenarioKey = this.tissue.scenarios[0].key, overrides = {}) {
    const sc = this.scenarioDef(scenarioKey);
    if (overrides.seed !== undefined) {
      const sd = overrides.seed >>> 0;
      if (sd !== this.seed) this._warm.clear();   // a half-finished warmFrom belongs to the old seed
      this.seed = sd;
    }
    this.rng = mulberry32(this.seed);
    this.scenario = scenarioKey;
    this.time = 0; this.stepCount = 0; this.wound = null;
    this._lastDep = 0; this._lastDeg = 0; this._lastScafLoss = 0;
    this._cumDep = 0; this._cumDeg = 0;
    if (this._mob) this._mob.fill(1);
    this.rules = this.tissue.makeRules(this, this.tissue.params || {});
    if (!this.rules || typeof this.rules.cell !== 'function' || typeof this.rules.voxel !== 'function') {
      throw new Error(`makeRules() of '${this.tissue.key}' must return { cell, voxel[, stiffness] }`);
    }

    const dialDefaults = {};
    for (const d of this.tissue.dials) dialDefaults[d.key] = d.default;
    const dials = Object.assign(dialDefaults, sc.dials || {}, overrides.dials || {});
    const init = Object.assign({}, sc.init || {}, overrides.init || {});

    // dial values first (cell count applied after the cells exist)
    for (let i = 0; i < this.nDials; i++) {
      if (i === this._cellDial) continue;
      const v = +dials[this.dialKeys[i]];
      this._dialVals[i] = v; this.dials[this.dialKeys[i]] = v;
    }
    if (init.from) {
      this._loadFrom(init.from);
    } else {
      this._initUniform(init);
      this.nCells = 0;
      this._typeCount.fill(0);
      // how many cells to seed: the cellCount dial when there is one, otherwise Σ cellTypes[].count
      const wantN = this._cellDial >= 0 ? Math.round(+dials[this.dialKeys[this._cellDial]])
        : (this._anyTypeCount ? this._countTotal() : 0);
      if (this._anyTypeCount) this._updateShares(wantN);
      if (wantN > 0) this._addCells(wantN);
      for (let f = 0; f < this.nFields; f++) {
        const bd = this._fBathDial[f];
        this.fields[f].fill(bd >= 0 ? this._dialVals[bd] : 0);
      }
      if (init.fields) for (const [k, v] of Object.entries(init.fields)) if (k in this.fieldIndex) this.fields[this.fieldIndex[k]].fill(+v);
    }
    if (this._cellDial >= 0) this._setCellCount(+dials[this.dialKeys[this._cellDial]]);
    this._countCells();
    this._derived();
    this._stiffness();
    this.revision++;
    return this;
  }

  _initUniform(init) {
    const NV = this.NV, rng = this.rng, nS = this.nSpecies, species = this.species, isFiber = this._isFiber;
    const base = new Float64Array(nS);
    if (init.species) for (const [k, v] of Object.entries(init.species)) if (k in this.speciesIndex) base[this.speciesIndex[k]] = +v;
    const jitter = init.jitter === undefined ? 0 : +init.jitter;
    for (let v = 0; v < NV; v++) {
      const jit = 1 + jitter * (rng() - 0.5);   // one draw per voxel, always consumed
      let tot = 0;
      for (let s = 0; s < nS; s++) {
        const r = base[s] * jit;
        species[s][v] = r;
        if (isFiber[s]) tot += r;
      }
      this.Txx[v] = tot / 3; this.Tyy[v] = tot / 3; this.Tzz[v] = tot / 3;
      this.Txy[v] = 0; this.Txz[v] = 0; this.Tyz[v] = 0;
      // random initial principal axis (warm start for the power iteration)
      const x = rng() - 0.5, y = rng() - 0.5, z = rng() - 0.5;
      const n = Math.hypot(x, y, z) || 1;
      this.fx[v] = x / n; this.fy[v] = y / n; this.fz[v] = z / n;
    }
    this.inflam.fill(0);
  }

  /** Type for the next cell: the one furthest below its target share (deterministic, no RNG). */
  _nextType() {
    if (this.nTypes === 1) return 0;
    const n1 = this.nCells + 1, share = this._typeShare;
    let best = 0, bestDef = -Infinity;
    for (let t = 0; t < this.nTypes; t++) {
      const deficit = share[t] * n1 - this._typeCount[t];
      if (deficit > bestDef) { bestDef = deficit; best = t; }
    }
    return best;
  }

  /** Σ of the declared cellTypes[].count (0 for types that declare none). */
  _countTotal() {
    let n = 0;
    for (let t = 0; t < this.nTypes; t++) if (this._typeWanted[t] > 0) n += this._typeWanted[t];
    return n;
  }

  /**
   * Targets and shares for a total of `total` cells when some cell type declares an absolute
   * `count`: those types get their count (scaled down together if they do not all fit), the rest
   * share what is left by `fraction`.  Without any `count` this is never called and
   * `_typeShare` IS `_typeFraction` (v0.3 behaviour, bit-identical).
   */
  _updateShares(total) {
    const share = this._typeShare, target = this._typeTarget, want = this._typeWanted;
    let fixed = 0, freeFrac = 0;
    for (let t = 0; t < this.nTypes; t++) {
      if (want[t] >= 0) fixed += want[t]; else freeFrac += this._typeFraction[t];
    }
    const scale = fixed > total && fixed > 0 ? total / fixed : 1;
    const rest = Math.max(0, total - fixed * scale);
    for (let t = 0; t < this.nTypes; t++) {
      target[t] = want[t] >= 0 ? want[t] * scale : (freeFrac > 0 ? this._typeFraction[t] / freeFrac : 0) * rest;
      share[t] = total > 0 ? target[t] / total : 0;
    }
  }

  _addCells(count) {
    const rng = this.rng, L = this.L;
    for (let c = 0; c < count && this.nCells < this.cap; c++) {
      const i = this.nCells, i3 = 3 * i;
      this._cx[i3] = rng() * L; this._cx[i3 + 1] = rng() * L; this._cx[i3 + 2] = rng() * L;
      const px = rng() - 0.5, py = rng() - 0.5, pz = rng() - 0.5;
      const n = Math.hypot(px, py, pz) || 1;
      this._cp[i3] = px / n; this._cp[i3 + 1] = py / n; this._cp[i3 + 2] = pz / n;
      const t = this._nextType();
      this._ctype[i] = t; this._typeCount[t]++;
      this._ca[i] = this._typeInitA[t]; this._cb[i] = this._typeInitB[t]; this._cc[i] = this._typeInitC[t];
      this.nCells++;
    }
  }

  _removeCells(count) {
    const rng = this.rng, protect = this._anyTypeCount, target = this._typeTarget;
    for (let c = 0; c < count && this.nCells > 0; c++) {
      let i = Math.floor(rng() * this.nCells);
      if (protect) {
        // keep the types that declared an absolute `count` at their target: walk on from the drawn
        // index (one RNG draw either way) to the next cell of a type that is above its target
        let over = false;
        for (let t = 0; t < this.nTypes; t++) if (this._typeCount[t] > Math.round(target[t])) { over = true; break; }
        if (over) {
          for (let k = 0; k < this.nCells; k++) {
            const j = (i + k) % this.nCells;
            if (this._typeCount[this._ctype[j]] > Math.round(target[this._ctype[j]])) { i = j; break; }
          }
        }
      }
      const last = this.nCells - 1;
      this._typeCount[this._ctype[i]]--;
      if (i !== last) {
        for (let d = 0; d < 3; d++) {
          this._cx[3 * i + d] = this._cx[3 * last + d];
          this._cp[3 * i + d] = this._cp[3 * last + d];
        }
        this._ca[i] = this._ca[last]; this._cb[i] = this._cb[last]; this._cc[i] = this._cc[last]; this._ctype[i] = this._ctype[last];
      }
      this.nCells--;
    }
  }

  _setCellCount(n) {
    n = Math.max(0, Math.min(this.cap, Math.round(n)));
    if (this._anyTypeCount) this._updateShares(n);
    if (n > this.nCells) this._addCells(n - this.nCells);
    else if (n < this.nCells) this._removeCells(this.nCells - n);
    if (this._cellDial >= 0) { this._dialVals[this._cellDial] = this.nCells; this.dials[this.dialKeys[this._cellDial]] = this.nCells; }
  }

  /** Change dials while running. Partial object keyed by dial key; unknown keys are ignored. */
  setDials(partial) {
    let hit = 0;
    for (const k of Object.keys(partial)) {
      const i = this.dialIndex[k];
      if (i === undefined || partial[k] === undefined) continue;
      hit++;
      if (i === this._cellDial) { this._setCellCount(+partial[k]); this._countCells(); }
      else { this._dialVals[i] = +partial[k]; this.dials[k] = +partial[k]; }
    }
    if (hit) this.revision++;
    return this.dials;
  }

  // -------------------------------------------------------- init.from (pre-run)

  /** Cache key of one init.from descriptor (scenario, days, seed, events, dial overrides). */
  _fromKey(from) {
    const withEvents = from.events === true, dialsKey = from.dials ? JSON.stringify(from.dials) : '';
    return `${from.scenario}|${from.days}|${this.seed}|${withEvents ? 'e' : ''}|${dialsKey}`;
  }

  /** Snapshot of a finished pre-run (what _loadFrom copies into this engine). */
  static _captureFrom(pre) {
    const copy = (a) => Float32Array.from(a);
    return {
      species: pre.species.map(copy),
      Txx: copy(pre.Txx), Tyy: copy(pre.Tyy), Tzz: copy(pre.Tzz), Txy: copy(pre.Txy), Txz: copy(pre.Txz), Tyz: copy(pre.Tyz),
      fx: copy(pre.fx), fy: copy(pre.fy), fz: copy(pre.fz),
      fields: pre.fields.map(copy),
      cx: pre._cx.slice(0, 3 * pre.nCells), cp: pre._cp.slice(0, 3 * pre.nCells),
      ca: pre._ca.slice(0, pre.nCells), cb: pre._cb.slice(0, pre.nCells), cc: pre._cc.slice(0, pre.nCells), ctype: pre._ctype.slice(0, pre.nCells),
      typeCount: Int32Array.from(pre._typeCount), nCells: pre.nCells,
    };
  }

  /** Fresh pre-run job for `from` (the engine plus the event cursor _preRunSlice advances). */
  _makeWarm(from) {
    if (this._depth >= 4) throw new Error(`init.from chain deeper than 4 (tissue '${this.tissue.key}')`);
    const pre = new TissueEngine(this.tissue, { seed: (this.seed + 1) >>> 0, overrides: this._overrides, _depth: this._depth + 1 });
    pre.reset(from.scenario, from.dials ? { dials: from.dials } : {});
    const withEvents = from.events === true;
    return {
      pre, withEvents, total: Math.round(from.days / pre.dt), done: 0, day: 0, fired: false,
      spd: Math.round(1 / pre.dt),
      events: withEvents ? (pre.scenarioDef(from.scenario).events || []).map((e) => Object.assign({}, e)) : [],
    };
  }

  /**
   * Advance a pre-run job by at most `maxSteps` steps; returns true when it has reached its day
   * count.  Splitting a pre-run into slices is BIT-IDENTICAL to running it in one call: without
   * events it is one `step()` loop, and with them the day cursor fires everything due on day d
   * before stepping day d on, exactly as the synchronous loop did.
   */
  static _preRunSlice(W, maxSteps = Infinity) {
    if (!W.withEvents) {
      const k = Math.min(maxSteps, W.total - W.done);
      if (k > 0) { W.pre.step(k); W.done += k; }
      return W.done >= W.total;
    }
    let budget = maxSteps;
    while (W.done < W.total && budget > 0) {
      if (!W.fired) {
        for (const e of W.events) {
          if (e.fired || e.at > W.day) continue;
          e.fired = true;
          if (e.dials) W.pre.setDials(e.dials);
          if (e.injure) W.pre.injure(e.injure.center || null, e.injure.radius);
        }
        W.fired = true;
      }
      const target = Math.min(W.total, (W.day + 1) * W.spd);
      const k = Math.min(budget, target - W.done);
      if (k > 0) { W.pre.step(k); W.done += k; budget -= k; }
      if (W.done >= target) { W.day++; W.fired = false; }
    }
    return W.done >= W.total;
  }

  /**
   * Step a pre-run engine for `days` (init.from). With `withEvents` the source scenario's
   * events are replayed exactly as checkScenario fires them: everything due on day d before
   * stepping day d on. Without it (the default) the pre-run sees no events at all.
   */
  static _preRun(pre, scenarioKey, days, withEvents) {
    const W = {
      pre, withEvents, total: Math.round(days / pre.dt), done: 0, day: 0, fired: false, spd: Math.round(1 / pre.dt),
      events: withEvents ? (pre.scenarioDef(scenarioKey).events || []).map((e) => Object.assign({}, e)) : [],
    };
    TissueEngine._preRunSlice(W, Infinity);
  }

  /**
   * RESUMABLE init.from pre-run (A2): advance the pre-run for `from` by at most `maxSteps` steps
   * and cache it once it is finished, so an app can spread the 3000-step matured state over
   * animation frames instead of freezing the UI.  Cheap and safe to call again after it is done.
   * Returns { done, key, scenario, steps, remaining } — `done` means the pre-run is in the cache,
   * so the next `reset()` of a scenario that starts from it is instant.
   * Seed-sensitive: warm with the same seed the reset will use.
   */
  warmFrom(from, maxSteps = Infinity) {
    const key = this._fromKey(from);
    if (this._fromCache.has(key)) return { done: true, key, scenario: from.scenario, steps: 0, remaining: 0 };
    let W = this._warm.get(key);
    if (!W) { W = this._makeWarm(from); this._warm.set(key, W); }
    const before = W.done;
    const done = TissueEngine._preRunSlice(W, maxSteps);
    if (done) { this._fromCache.set(key, TissueEngine._captureFrom(W.pre)); this._warm.delete(key); }
    return { done, key, scenario: from.scenario, steps: W.done - before, remaining: W.total - W.done };
  }

  /**
   * Warm the init.from pre-runs of every scenario of this tissue, one slice per call
   * (`maxSteps` steps of the first scenario that is not cached yet).  Returns
   * { done: true } once every pre-run is cached, otherwise { done: false, scenario, remaining }.
   */
  warmScenarios(maxSteps = 200) {
    for (const sc of this.tissue.scenarios) {
      const from = sc.init && sc.init.from;
      if (!from || this._fromCache.has(this._fromKey(from))) continue;
      const r = this.warmFrom(from, maxSteps);
      return { done: false, scenario: sc.key, from: r.scenario, steps: r.steps, remaining: r.remaining };
    }
    return { done: true, scenario: null, steps: 0, remaining: 0 };
  }

  /** Copy a (possibly just-computed) init.from pre-run into this engine. */
  _loadFrom(from) {
    const key = this._fromKey(from);
    let S = this._fromCache.get(key);
    if (!S) { this.warmFrom(from, Infinity); S = this._fromCache.get(key); }
    for (let s = 0; s < this.nSpecies; s++) this.species[s].set(S.species[s]);
    this.Txx.set(S.Txx); this.Tyy.set(S.Tyy); this.Tzz.set(S.Tzz); this.Txy.set(S.Txy); this.Txz.set(S.Txz); this.Tyz.set(S.Tyz);
    this.fx.set(S.fx); this.fy.set(S.fy); this.fz.set(S.fz);
    for (let f = 0; f < this.nFields; f++) this.fields[f].set(S.fields[f]);
    this._cx.set(S.cx); this._cp.set(S.cp); this._ca.set(S.ca); this._cb.set(S.cb); this._cc.set(S.cc); this._ctype.set(S.ctype);
    this._typeCount.set(S.typeCount); this.nCells = S.nCells;
    this.inflam.fill(0);
  }

  // -------------------------------------------------------------- injury

  /**
   * Spherical wound (tissue.injury): clears `clearSpecies` (T rescaled), adds `fieldBurst`,
   * arms the inflammation field. `center` null → random spot away from the walls.
   * Returns the wound record, or null if the tissue has no `injury`.
   */
  injure(center = null, radius = undefined) {
    const inj = this.tissue.injury;
    if (!inj) return null;
    if (radius === undefined) radius = inj.radius;
    const N = this.N, h = this.h, L = this.L, eps = this.P.eps;
    let cx, cy, cz;
    if (center) { [cx, cy, cz] = center; }
    else {
      const margin = Math.min(radius, L / 2);
      cx = margin + this.rng() * (L - 2 * margin);
      cy = margin + this.rng() * (L - 2 * margin);
      cz = margin + this.rng() * (L - 2 * margin);
    }
    const r2 = radius * radius, clear = this._clearSpecies, fiberIdx = this._fiberIdx, hasInfl = this._inflTau > 0;
    let count = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * h - cx;
      for (let j = 0; j < N; j++) {
        const y = (j + 0.5) * h - cy;
        for (let k = 0; k < N; k++) {
          const z = (k + 0.5) * h - cz;
          if (x * x + y * y + z * z > r2) continue;
          const v = (i * N + j) * N + k;
          const tr0 = this.Txx[v] + this.Tyy[v] + this.Tzz[v];
          for (let q = 0; q < clear.length; q++) this.species[clear[q]][v] = 0;
          let tot = 0;
          for (let q = 0; q < fiberIdx.length; q++) tot += this.species[fiberIdx[q]][v];
          if (tot <= eps || tr0 <= eps) {
            this.Txx[v] = 0; this.Tyy[v] = 0; this.Tzz[v] = 0; this.Txy[v] = 0; this.Txz[v] = 0; this.Tyz[v] = 0;
            if (tot <= eps) for (let q = 0; q < fiberIdx.length; q++) this.species[fiberIdx[q]][v] = 0;
            else { this.Txx[v] = tot / 3; this.Tyy[v] = tot / 3; this.Tzz[v] = tot / 3; }
          } else {
            const sc = tot / tr0;
            this.Txx[v] *= sc; this.Tyy[v] *= sc; this.Tzz[v] *= sc; this.Txy[v] *= sc; this.Txz[v] *= sc; this.Tyz[v] *= sc;
          }
          for (let f = 0; f < this.nFields; f++) if (this._fBurst[f] !== 0) this.fields[f][v] += this._fBurst[f];
          if (hasInfl) this.inflam[v] = 1;
          count++;
        }
      }
    }
    this.wound = { center: [cx, cy, cz], radius, time: this.time, nVox: count };
    this._derived();
    this._stiffness();
    this.revision++;
    return this.wound;
  }

  // ---------------------------------------------------------------- step

  step(nSteps = 1) {
    for (let s = 0; s < nSteps; s++) this._step();
    return this;
  }

  _gauss() { // ~N(0,1): sum of three uniforms, variance 3/12 → scaled
    const r = this.rng;
    return (r() + r() + r() - 1.5) * 2;
  }

  _step() {
    const P = this.P, dt = this.dt, N = this.N, NV = this.NV, L = this.L;
    const invh = 1 / this.h, Nm1 = N - 1, sqrtDt = Math.sqrt(dt);
    const nS = this.nSpecies, nF = this.nFields, species = this.species, isFiber = this._isFiber, fiberIdx = this._fiberIdx;
    const Txx = this.Txx, Tyy = this.Tyy, Tzz = this.Tzz, Txy = this.Txy, Txz = this.Txz, Tyz = this.Tyz;
    const fiberTotal = this.fiberTotal, fa = this.fa, fx = this.fx, fy = this.fy, fz = this.fz, E = this.E;
    const fields = this.fields, fieldSrc = this._fieldSrc, accs = this._acc, acc0 = accs[0], cellCount = this._cellCount;
    const nVox = this.nVox, wantMob = this._mob !== null, mob = this._mob;
    const cx = this._cx, cp = this._cp, ca = this._ca, cb = this._cb, cc = this._cc, ctype = this._ctype, vox = this._vox, dxs = this._dx;
    const cMin = this._typeCMin, cMax = this._typeCMax;
    const n = this.nCells, rules = this.rules;
    const motile = this._typeMotile, allMotile = this._allMotile, compress = P.loadMode === 'compression';
    const load = this._loadDial >= 0 ? this._dialVals[this._loadDial] : 0;
    const loadA = P.loadExp === 2 ? load * load : Math.pow(load, P.loadExp);

    for (let f = 0; f < nF; f++) fieldSrc[f].fill(0);
    for (let q = 0; q < nVox; q++) accs[q].fill(0);

    // ---------------------------------------------------------- cells
    const ctx = this._cctx, out = ctx.out, cRho = ctx.rho, cField = ctx.field, secrete = out.secrete, cSrc = out.fieldSrc;
    const oVox = out.vox, polS = out.polS, alignS = out.alignS;
    ctx.dt = dt; ctx.load = load;
    let depTotal = 0;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      const x = cx[i3], y = cx[i3 + 1], z = cx[i3 + 2];
      let ix = (x * invh) | 0, iy = (y * invh) | 0, iz = (z * invh) | 0;
      if (ix > Nm1) ix = Nm1; if (iy > Nm1) iy = Nm1; if (iz > Nm1) iz = Nm1;
      const v = (ix * N + iy) * N + iz;

      // --- inputs
      const a0 = ca[i], b0 = cb[i], c0 = cc[i], ty = ctype[i];
      ctx.i = i; ctx.type = ty; ctx.a = a0; ctx.b = b0; ctx.c = c0;
      for (let s = 0; s < nS; s++) cRho[s] = species[s][v];
      ctx.fiberTotal = fiberTotal[v]; ctx.fa = fa[v]; ctx.fz = fz[v] < 0 ? -fz[v] : fz[v];
      for (let f = 0; f < nF; f++) cField[f] = fields[f][v];
      ctx.E = E[v]; ctx.cellsInVoxel = cellCount[v];
      // --- outputs (a, b keep their value unless written; aSum defaults to the new a)
      out.a = a0; out.b = b0; out.c = c0; out.pol = 0; out.align = 0; out.speed = 0; out.guide = 0; out.loadAlign = 0; out.noise = 0; out.aSum = NaN;
      out.usePolS = false; oVox[0] = NaN;
      for (let q = 1; q < nVox; q++) oVox[q] = 0;
      for (let s = 0; s < nS; s++) secrete[s] = 0;
      for (let f = 0; f < nF; f++) cSrc[f] = 0;

      rules.cell(ctx);

      // --- state
      let a = out.a, b = out.b, c = out.c;
      a = a < 0 ? 0 : (a > 1 ? 1 : a); b = b < 0 ? 0 : (b > 1 ? 1 : b);
      const cLo = cMin[ty], cHi = cMax[ty];
      c = c < cLo ? cLo : (c > cHi ? cHi : c);
      if (a !== a) a = a0; if (b !== b) b = b0; if (c !== c) c = c0;
      ca[i] = a; cb[i] = b; cc[i] = c;

      // --- deposition into the voxel; fiber species also into T with orientation `pol`
      //     (out.polS[s] / out.alignS[s] override it per fiber species when out.usePolS is set)
      let px = cp[i3], py = cp[i3 + 1], pz = cp[i3 + 2];
      const uPS = out.usePolS;
      let dep = 0, isoS = 0, aniS = 0;
      if (!uPS) {
        for (let s = 0; s < nS; s++) {
          const sec = secrete[s];
          if (sec <= 0) continue;
          species[s][v] += sec * dt; depTotal += sec;
          if (isFiber[s]) dep += sec * dt;
        }
      } else {
        for (let s = 0; s < nS; s++) {
          const sec = secrete[s];
          if (sec <= 0) continue;
          species[s][v] += sec * dt; depTotal += sec;
          if (!isFiber[s]) continue;
          const d = sec * dt;
          dep += d;
          let ps = polS[s];
          if (ps !== ps) ps = out.pol;
          ps = ps < 0 ? 0 : (ps > 1 ? 1 : ps);
          isoS += (1 - ps) / 3 * d; aniS += ps * d;
        }
      }
      let kA;
      if (!uPS) kA = out.align * dt;
      else {   // T is shared: one realignment rate, weighted by the post-deposition fiber densities
        let wTot = 0, wSum = 0;
        for (let q = 0; q < fiberIdx.length; q++) {
          const s = fiberIdx[q], r = species[s][v];
          let al = alignS[s];
          if (al !== al) al = out.align;
          wTot += r; wSum += r * al;
        }
        kA = (wTot > 0 ? wSum / wTot : 0) * dt;
      }
      if (dep > 0 || kA > 0) {
        let iso, ani;
        if (!uPS) {
          const pol = out.pol < 0 ? 0 : (out.pol > 1 ? 1 : out.pol);
          iso = (1 - pol) / 3 * dep; ani = pol * dep;
        } else { iso = isoS; ani = aniS; }
        let txx = Txx[v] + iso + ani * px * px, tyy = Tyy[v] + iso + ani * py * py, tzz = Tzz[v] + iso + ani * pz * pz;
        let txy = Txy[v] + ani * px * py, txz = Txz[v] + ani * px * pz, tyz = Tyz[v] + ani * py * pz;
        // traction realignment toward p pᵀ (trace-preserving)
        if (kA > 0) {
          const tr = txx + tyy + tzz;
          txx += kA * (tr * px * px - txx); tyy += kA * (tr * py * py - tyy); tzz += kA * (tr * pz * pz - tzz);
          txy += kA * (tr * px * py - txy); txz += kA * (tr * px * pz - txz); tyz += kA * (tr * py * pz - tyz);
        }
        Txx[v] = txx; Tyy[v] = tyy; Tzz[v] = tzz; Txy[v] = txy; Txz[v] = txz; Tyz[v] = tyz;
      }
      if (uPS) { polS.fill(NaN); alignS.fill(NaN); }   // the next cell starts from the scalars again

      // --- per-voxel accumulators (0: out.vox[0], else out.aSum, else the new a)
      for (let f = 0; f < nF; f++) fieldSrc[f][v] += cSrc[f];
      const v0 = oVox[0], as = out.aSum;
      acc0[v] += v0 === v0 ? v0 : (as === as ? as : a);
      for (let q = 1; q < nVox; q++) accs[q][v] += oVox[q];

      // --- polarity: contact guidance toward ±f, load alignment toward ±z, persistence noise
      //     A cell type with `motile: false` keeps its polarity and its place: no guidance, no load
      //     alignment, no noise draws (so it consumes no RNG) and no migration.
      if (allMotile || motile[ty] === 1) {
        const fxv = fx[v], fyv = fy[v], fzv = fz[v];
        const sg = (px * fxv + py * fyv + pz * fzv) >= 0 ? 1 : -1;
        const kG = out.guide * dt * fa[v];
        px += kG * (sg * fxv - px); py += kG * (sg * fyv - py); pz += kG * (sg * fzv - pz);
        const kL = out.loadAlign * dt;
        if (compress) { pz -= kL * pz; }   // compression: the polarity relaxes into the plane ⊥ to z
        else { const sz = pz >= 0 ? 1 : -1; px -= kL * px; py -= kL * py; pz += kL * (sz - pz); }
        if (out.noise > 0) {
          const sigN = out.noise * sqrtDt;
          px += sigN * this._gauss(); py += sigN * this._gauss(); pz += sigN * this._gauss();
        }
        let pn = Math.sqrt(px * px + py * py + pz * pz);
        if (pn < 1e-9) { px = 0; py = 0; pz = 1; pn = 1; }
        px /= pn; py /= pn; pz /= pn;
        cp[i3] = px; cp[i3 + 1] = py; cp[i3 + 2] = pz;

        // --- migration
        const speed = out.speed;
        cx[i3] = x + speed * px * dt; cx[i3 + 1] = y + speed * py * dt; cx[i3 + 2] = z + speed * pz * dt;
      }
    }

    // --- voxel binning (cell counts) and soft repulsion between cells closer than 2 rCell
    //     (2 rCell < h, so partners are in the same or an adjacent voxel: 27 bins per cell)
    if (n > 0) {
      const binStart = this._binStart, binCell = this._binCell, cursor = this._binCursor;
      binStart.fill(0);
      for (let i = 0; i < n; i++) {
        const i3 = 3 * i;
        let ix = (cx[i3] * invh) | 0, iy = (cx[i3 + 1] * invh) | 0, iz = (cx[i3 + 2] * invh) | 0;
        if (ix > Nm1) ix = Nm1; else if (ix < 0) ix = 0;
        if (iy > Nm1) iy = Nm1; else if (iy < 0) iy = 0;
        if (iz > Nm1) iz = Nm1; else if (iz < 0) iz = 0;
        const v = (ix * N + iy) * N + iz;
        vox[i] = v; binStart[v + 1]++;
      }
      for (let v = 0; v < NV; v++) { cellCount[v] = binStart[v + 1]; binStart[v + 1] += binStart[v]; }
      if (n > 1) {
        // contact distance: 2·rCell, or rCell(type i) + rCell(type j) when a cell type overrides it
        const sameR = this._sameRCell, rc = this._typeRCell;
        const d0g = 2 * P.rCell, d02g = d0g * d0g, kRep = P.kRep;
        cursor.set(binStart.subarray(0, NV));
        for (let i = 0; i < n; i++) binCell[cursor[vox[i]]++] = i;
        dxs.fill(0, 0, 3 * n);
        const N2 = N * N;
        for (let i = 0; i < n; i++) {
          const v = vox[i], ix = (v / N2) | 0, iy = ((v / N) | 0) % N, iz = v % N;
          const ti = ctype[i], moti = allMotile || motile[ti] === 1, ri = sameR ? 0 : rc[ti];
          const i3 = 3 * i, xi = cx[i3], yi = cx[i3 + 1], zi = cx[i3 + 2];
          const x0 = ix > 0 ? ix - 1 : 0, x1 = ix < Nm1 ? ix + 1 : Nm1;
          const y0 = iy > 0 ? iy - 1 : 0, y1 = iy < Nm1 ? iy + 1 : Nm1;
          const z0 = iz > 0 ? iz - 1 : 0, z1 = iz < Nm1 ? iz + 1 : Nm1;
          for (let jx = x0; jx <= x1; jx++) {
            for (let jy = y0; jy <= y1; jy++) {
              const wBase = (jx * N + jy) * N;
              for (let jz = z0; jz <= z1; jz++) {
                const w = wBase + jz;
                for (let q = binStart[w], qEnd = binStart[w + 1]; q < qEnd; q++) {
                  const j = binCell[q];
                  if (j <= i) continue;
                  const tj = ctype[j], d0 = sameR ? d0g : ri + rc[tj], d02 = sameR ? d02g : d0 * d0;
                  const j3 = 3 * j;
                  const ddx = cx[j3] - xi, ddy = cx[j3 + 1] - yi, ddz = cx[j3 + 2] - zi;
                  const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                  if (d2 >= d02 || d2 === 0) continue;
                  const d = Math.sqrt(d2);
                  const f = kRep * (d0 - d) / d * 0.5;
                  // a non-motile cell is an obstacle: the pair force only moves the motile partner
                  if (moti) { dxs[i3] -= f * ddx; dxs[i3 + 1] -= f * ddy; dxs[i3 + 2] -= f * ddz; }
                  if (allMotile || motile[tj] === 1) { dxs[j3] += f * ddx; dxs[j3 + 1] += f * ddy; dxs[j3 + 2] += f * ddz; }
                }
              }
            }
          }
        }
        for (let i = 0; i < 3 * n; i++) cx[i] += dxs[i];
      }
    } else {
      cellCount.fill(0);
    }
    // --- walls: reflect position and polarity
    const Lmax = L - 1e-6;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      for (let d = 0; d < 3; d++) {
        let q = cx[i3 + d];
        if (q < 0) { q = -q; cp[i3 + d] = -cp[i3 + d]; }
        if (q > Lmax) { q = 2 * Lmax - q; cp[i3 + d] = -cp[i3 + d]; }
        if (q < 0) q = 0; else if (q > Lmax) q = Lmax;
        cx[i3 + d] = q;
      }
    }

    // ------------------------------------------------------- voxels: rules, integration, derived fields
    const vctx = this._vctx, vout = vctx.out, vRho = vctx.rho, vField = vctx.field, dRho = vout.dRho, vSrc = vout.fieldSrc;
    const vVox = vctx.vox;
    vctx.dt = dt; vctx.load = load;
    const kLF = P.kLoadFib * loadA * dt, eps = P.eps, eps2 = eps * eps, rhoMax = P.rhoMax, inflam = this.inflam;
    const doF = (this.stepCount % P.fEvery) === 0;
    let degTotal = 0, scafTotal = 0;
    for (let v = 0; v < NV; v++) {
      let txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      let tr = txx + tyy + tzz;
      let tot0 = 0;
      for (let s = 0; s < nS; s++) { const r = species[s][v]; vRho[s] = r; if (isFiber[s]) tot0 += r; }
      vctx.v = v; vctx.fiberTotal = tot0; vctx.fa = fa[v]; vctx.Tzz_over_trace = tr > eps ? tzz / tr : 0;
      for (let f = 0; f < nF; f++) vField[f] = fields[f][v];
      vctx.aSum = acc0[v]; vctx.nCellsHere = cellCount[v]; vctx.inflam = inflam[v];
      vVox[0] = acc0[v];
      for (let q = 1; q < nVox; q++) vVox[q] = accs[q][v];
      for (let s = 0; s < nS; s++) dRho[s] = 0;
      for (let f = 0; f < nF; f++) vSrc[f] = 0;
      vout.loss = 0; vout.scaffoldLoss = 0; vout.E = E[v];
      if (wantMob) vout.mobility = 1;

      rules.voxel(vctx);

      // --- integrate species (clamp ≥ 0); new fiber total
      let tot1 = 0;
      for (let s = 0; s < nS; s++) {
        let r = vRho[s] + dRho[s] * dt;
        if (r < 0 || r !== r) r = 0;
        species[s][v] = r;
        if (isFiber[s]) tot1 += species[s][v];
      }
      const loss = vout.loss;
      if (loss > 0) degTotal += loss;
      const sLoss = vout.scaffoldLoss;
      if (sLoss > 0) scafTotal += sLoss;
      if (wantMob) { const mb = vout.mobility; mob[v] = mb > 1 ? 1 : (mb > 0 ? mb : 0); }
      for (let f = 0; f < nF; f++) fieldSrc[f][v] += vSrc[f];

      // --- tensor: follow the fiber total (orientation preserved), load alignment, clamp, PSD guard
      if (tot1 > eps) {
        if (tr > eps) {
          const sc = tot1 / tr;
          txx *= sc; tyy *= sc; tzz *= sc; txy *= sc; txz *= sc; tyz *= sc;
        } else {
          txx = tot1 / 3; tyy = txx; tzz = txx; txy = 0; txz = 0; tyz = 0;
        }
        tr = tot1;
        if (kLF > 0) {
          if (compress) {   // load ⊥ to the fibers: T relaxes toward the isotropic xy plane, tr·(I − ẑẑ)/2
            const half = 0.5 * tr;
            txx += kLF * (half - txx); tyy += kLF * (half - tyy); tzz -= kLF * tzz;
            txy -= kLF * txy; txz -= kLF * txz; tyz -= kLF * tyz;
          } else {          // tension: T relaxes toward tr·ẑẑ (trace-preserving either way)
            txx -= kLF * txx; tyy -= kLF * tyy; tzz += kLF * (tr - tzz);
            txy -= kLF * txy; txz -= kLF * txz; tyz -= kLF * tyz;
          }
        }
        if (tr > rhoMax) {
          const sc = rhoMax / tr;
          txx *= sc; tyy *= sc; tzz *= sc; txy *= sc; txz *= sc; tyz *= sc;
          for (let q = 0; q < fiberIdx.length; q++) species[fiberIdx[q]][v] *= sc;
          tr = rhoMax;
        }
        if (txx < 0) txx = 0; if (tyy < 0) tyy = 0; if (tzz < 0) tzz = 0;
        if (txy * txy > txx * tyy) txy = (txy < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tyy);
        if (txz * txz > txx * tzz) txz = (txz < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tzz);
        if (tyz * tyz > tyy * tzz) tyz = (tyz < 0 ? -0.999 : 0.999) * Math.sqrt(tyy * tzz);
      } else {
        txx = 0; tyy = 0; tzz = 0; txy = 0; txz = 0; tyz = 0; tr = 0;
        for (let q = 0; q < fiberIdx.length; q++) species[fiberIdx[q]][v] = 0;
      }
      Txx[v] = txx; Tyy[v] = tyy; Tzz[v] = tzz; Txy[v] = txy; Txz[v] = txz; Tyz[v] = tyz;
      fiberTotal[v] = tr;

      // --- derived: FA, principal axis (warm-started power iteration), stiffness from the hook
      const fro2 = txx * txx + tyy * tyy + tzz * tzz + 2 * (txy * txy + txz * txz + tyz * tyz);
      let f = 0;
      if (fro2 > eps2) {
        f = 1.5 * (fro2 - tr * tr / 3) / fro2;      // FA² = 3/2·‖T − (tr/3)I‖² / ‖T‖²
        f = f <= 0 ? 0 : (f >= 1 ? 1 : Math.sqrt(f));
        if (doF) {
          let ax = fx[v], ay = fy[v], az = fz[v];
          for (let it = 0; it < 2; it++) {
            const bx = txx * ax + txy * ay + txz * az;
            const by = txy * ax + tyy * ay + tyz * az;
            const bz = txz * ax + tyz * ay + tzz * az;
            const bn = Math.sqrt(bx * bx + by * by + bz * bz);
            if (bn < 1e-12) break;
            ax = bx / bn; ay = by / bn; az = bz / bn;
          }
          fx[v] = ax; fy[v] = ay; fz[v] = az;
        }
      }
      fa[v] = f;
      const Ev = vout.E;
      E[v] = Ev === Ev ? Ev : E[v];
    }

    // ------------------------------------------- species transport (opt-in), then the fields
    if (this._anyTransport) { degTotal += this._transport(dt, doF); scafTotal += this._tScaf; }
    this._diffuse(dt);

    this._lastDep = depTotal; this._lastDeg = degTotal; this._lastScafLoss = scafTotal;
    const invNV = 1 / NV;
    this._cumDep += depTotal * invNV * dt; this._cumDeg += degTotal * invNV * dt;
    this.time += dt; this.stepCount++; this.revision++;
  }

  /**
   * Species transport (v0.3, only for species that declare `D` or `sink`): explicit
   * 6-neighbour diffusion with zero-flux walls (per-face diffusion number clamped ≤ 1/6 and
   * scaled by the voxel hook's `out.mobility`), then the `sink` loss at the +z face layer.
   * A fiber species carries T with it (flux × T(source)/fiberTotal(source)), so trace(T) keeps
   * tracking Σ fiber species; T is rescaled and FA / the axis refreshed afterwards.
   * Returns the summed non-scaffold sink RATE; the scaffold part is left in this._tScaf.
   */
  _transport(dt, doF) {
    const N = this.N, NV = this.NV, N2 = N * N, Nm1 = N - 1, eps = this.P.eps, eps2 = eps * eps;
    const species = this.species, isFiber = this._isFiber, fiberIdx = this._fiberIdx;
    const Txx = this.Txx, Tyy = this.Tyy, Tzz = this.Tzz, Txy = this.Txy, Txz = this.Txz, Tyz = this.Tyz;
    const ft = this.fiberTotal, fa = this.fa, fx = this.fx, fy = this.fy, fz = this.fz;
    const idx = this._diffIdx, mob = this._mob, delta = this._sDelta, dT = this._tDelta;
    const withT = this._anyFiberD;
    if (withT) dT.fill(0);
    const dtH2 = dt / (this.h * this.h), lamMax = 1 / 6;

    for (let q = 0; q < idx.length; q++) {
      const s = idx[q], arr = species[s], fib = withT && isFiber[s] === 1;
      // A1: explicit while lam = D·dt/h² ≤ 1/6, otherwise nSub explicit sub-steps of dt/nSub
      const nSub = this._sSub[s], kD = this._sD[s] * (nSub === 1 ? dtH2 : (dt / nSub) / (this.h * this.h));
      const face = (v, w) => {
        let lam = kD * 0.5 * (mob[v] + mob[w]);
        if (lam > lamMax) lam = lamMax;
        const f = lam * (arr[w] - arr[v]);
        if (f === 0) return;
        delta[v] += f; delta[w] -= f;
        if (!fib) return;
        const src = f > 0 ? w : v, tot = ft[src];
        if (tot <= eps) return;
        const r = f / tot, a6 = 6 * v, b6 = 6 * w;
        const axx = r * Txx[src], ayy = r * Tyy[src], azz = r * Tzz[src];
        const axy = r * Txy[src], axz = r * Txz[src], ayz = r * Tyz[src];
        dT[a6] += axx; dT[b6] -= axx; dT[a6 + 1] += ayy; dT[b6 + 1] -= ayy; dT[a6 + 2] += azz; dT[b6 + 2] -= azz;
        dT[a6 + 3] += axy; dT[b6 + 3] -= axy; dT[a6 + 4] += axz; dT[b6 + 4] -= axz; dT[a6 + 5] += ayz; dT[b6 + 5] -= ayz;
      };
      for (let it = 0; it < nSub; it++) {
        delta.fill(0);
        for (let i = 0; i < N; i++) {
          const ip = i < Nm1;
          for (let j = 0; j < N; j++) {
            const jp = j < Nm1, base = (i * N + j) * N;
            for (let k = 0; k < N; k++) {
              const v = base + k;
              if (ip) face(v, v + N2);
              if (jp) face(v, v + N);
              if (k < Nm1) face(v, v + 1);
            }
          }
        }
        for (let v = 0; v < NV; v++) { const r = arr[v] + delta[v]; arr[v] = r > 0 ? r : 0; }
      }
    }

    // --- sink: loss to the medium at the +z face layer only
    let deg = 0, scaf = 0;
    const sIdx = this._sinkIdx;
    for (let q = 0; q < sIdx.length; q++) {
      const s = sIdx[q], arr = species[s], kS = this._sSink[s];
      let sum = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const v = (i * N + j) * N + Nm1, r = arr[v];
          if (r <= 0) continue;
          let l = kS * r * dt;
          if (l > r) l = r;
          arr[v] = r - l; sum += l;
        }
      }
      const rate = sum / dt;
      if (this._isScaffold[s]) scaf += rate; else deg += rate;
    }
    this._tScaf = scaf;
    if (!this._anyFiberMoves) return deg;

    // --- fiber species moved: carry T with them, rescale onto the new total, refresh FA / axis
    //     (same math as the voxel pass and _derived)
    const nFib = fiberIdx.length, fArr = this._fiberArrays;
    for (let q = 0; q < nFib; q++) fArr[q] = species[fiberIdx[q]];
    for (let v = 0; v < NV; v++) {
      let tot = 0;
      for (let q = 0; q < nFib; q++) tot += fArr[q][v];
      let txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      if (withT) {
        const a6 = 6 * v;
        txx += dT[a6]; tyy += dT[a6 + 1]; tzz += dT[a6 + 2]; txy += dT[a6 + 3]; txz += dT[a6 + 4]; tyz += dT[a6 + 5];
      }
      if (tot > eps) {
        const tr0 = txx + tyy + tzz;
        if (tr0 > eps) { const sc = tot / tr0; txx *= sc; tyy *= sc; tzz *= sc; txy *= sc; txz *= sc; tyz *= sc; }
        else { txx = tot / 3; tyy = txx; tzz = txx; txy = 0; txz = 0; tyz = 0; }
        if (txx < 0) txx = 0; if (tyy < 0) tyy = 0; if (tzz < 0) tzz = 0;
        if (txy * txy > txx * tyy) txy = (txy < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tyy);
        if (txz * txz > txx * tzz) txz = (txz < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tzz);
        if (tyz * tyz > tyy * tzz) tyz = (tyz < 0 ? -0.999 : 0.999) * Math.sqrt(tyy * tzz);
      } else {
        txx = 0; tyy = 0; tzz = 0; txy = 0; txz = 0; tyz = 0; tot = 0;
        for (let q = 0; q < nFib; q++) fArr[q][v] = 0;
      }
      Txx[v] = txx; Tyy[v] = tyy; Tzz[v] = tzz; Txy[v] = txy; Txz[v] = txz; Tyz[v] = tyz;
      ft[v] = tot;
      const fro2 = txx * txx + tyy * tyy + tzz * tzz + 2 * (txy * txy + txz * txz + tyz * tyz);
      let f = 0;
      if (fro2 > eps2) {
        f = 1.5 * (fro2 - tot * tot / 3) / fro2;
        f = f <= 0 ? 0 : (f >= 1 ? 1 : Math.sqrt(f));
        if (doF) {
          let ax = fx[v], ay = fy[v], az = fz[v];
          for (let it = 0; it < 2; it++) {
            const bx = txx * ax + txy * ay + txz * az;
            const by = txy * ax + tyy * ay + tyz * az;
            const bz = txz * ax + tyz * ay + tzz * az;
            const bn = Math.sqrt(bx * bx + by * by + bz * bz);
            if (bn < 1e-12) break;
            ax = bx / bn; ay = by / bn; az = bz / bn;
          }
          fx[v] = ax; fy[v] = ay; fz[v] = az;
        }
      }
      fa[v] = f;
    }
    return deg;
  }

  /**
   * The field pass (A1): one of three integrations per field, chosen at construction from
   * lam = D·dt/h² and the optional `fields[].mode` (see `fieldModes`):
   *   explicit     one 6-neighbour step with zero-flux walls, sources, bath exchange, decay and
   *                inflammation — lam CLAMPED at 1/6 (v0.3 behaviour, kept bit-identical)
   *   subcycled    nSub such steps of dt/nSub, with sources / bath / decay / the Dirichlet face
   *                applied on every sub-step
   *   quasiSteady  the diffusion is far faster than one step: solve the steady state instead
   * The inflammation field decays once per step in every mode.
   */
  _diffuse(dt) {
    const N = this.N, NV = this.NV, h2 = this.h * this.h, N2 = N * N, Nm1 = N - 1, inflam = this.inflam;
    const hasInfl = this._inflTau > 0;
    for (let f = 0; f < this.nFields; f++) {
      const bd = this._fBathDial[f], bath = bd >= 0 ? this._dialVals[bd] : 0, face = this._fBoundary[f];
      const kBath = bd >= 0 && face === 0 ? this._fKBath[f] : 0;   // face boundaries: no bulk relaxation
      const decay = this._fDecay[f], wInf = hasInfl ? this._fInfl[f] : 0;
      if (this._fMode[f] === 2) { this._diffuseSteady(f, bath, face, kBath, decay, wInf); continue; }
      const nSub = this._fSub[f], dts = nSub === 1 ? dt : dt / nSub;
      let lam = this._fD[f] * dts / h2;
      if (lam > ENGINE_LAM_STABLE) lam = ENGINE_LAM_STABLE;
      const src = this._fieldSrc[f];
      for (let it = 0; it < nSub; it++) {
        const g = this.fields[f], g2 = this._fields2[f];
        for (let i = 0; i < N; i++) {
          const im = i > 0, ip = i < Nm1;
          for (let j = 0; j < N; j++) {
            const jm = j > 0, jp = j < Nm1;
            const base = (i * N + j) * N;
            for (let k = 0; k < N; k++) {
              const v = base + k;
              const gv = g[v];
              let sg = 0, cnt = 0;
              if (im) { sg += g[v - N2]; cnt++; }
              if (ip) { sg += g[v + N2]; cnt++; }
              if (jm) { sg += g[v - N]; cnt++; }
              if (jp) { sg += g[v + N]; cnt++; }
              if (k > 0) { sg += g[v - 1]; cnt++; }
              if (k < Nm1) { sg += g[v + 1]; cnt++; }
              const ng = gv + lam * (sg - cnt * gv) + dts * (kBath * (bath - gv) + src[v] - decay * gv + wInf * inflam[v]);
              g2[v] = ng > 0 ? ng : 0;
            }
          }
        }
        if (face !== 0 && bd >= 0) {   // Dirichlet face: hold the boundary layer at the bath value
          const k = face > 0 ? Nm1 : 0;
          for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g2[(i * N + j) * N + k] = bath;
        }
        this.fields[f] = g2; this._fields2[f] = g;
      }
    }
    if (hasInfl) {
      const dec = Math.exp(-dt / this._inflTau);
      for (let v = 0; v < NV; v++) { const inf = inflam[v]; if (inf > 0) inflam[v] = inf > 1e-4 ? inf * dec : 0; }
    }
  }

  /**
   * Quasi-steady field solve (A1): for a field whose diffusion is orders of magnitude faster than
   * one step, integrating in time is pointless — the profile is the steady state of
   *     0 = D∇²g + kBath·(bath − g) + src − decay·g + wInf·inflam
   * on the same 6-neighbour stencil (zero-flux walls, the Dirichlet face held at the bath value).
   * Solved by warm-started Gauss-Seidel with over-relaxation, in place, clamped ≥ 0; at most
   * ENGINE_QS_SWEEPS sweeps and stopped as soon as no voxel moves by more than ENGINE_QS_TOL.
   * Warm-started from the previous step, so a running sim usually converges in a few sweeps.
   * Only chosen when the steady problem is well posed (see _steadySolvable), never for a species.
   */
  _diffuseSteady(f, bath, face, kBath, decay, wInf) {
    const N = this.N, NV = this.NV, N2 = N * N, Nm1 = N - 1, inflam = this.inflam;
    const g = this.fields[f], src = this._fieldSrc[f], prev = this._fields2[f];
    const c = this._fD[f] / (this.h * this.h), om = this._qsOmega, theta = this._qsTheta;
    const kHold = face > 0 ? Nm1 : (face < 0 ? 0 : -1);
    if (theta < 1) prev.set(g);
    if (kHold >= 0) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g[(i * N + j) * N + kHold] = bath;
    for (let sweep = 0; sweep < ENGINE_QS_SWEEPS; sweep++) {
      let worst = 0;
      for (let i = 0; i < N; i++) {
        const im = i > 0, ip = i < Nm1;
        for (let j = 0; j < N; j++) {
          const jm = j > 0, jp = j < Nm1;
          const base = (i * N + j) * N;
          for (let k = 0; k < N; k++) {
            if (k === kHold) continue;
            const v = base + k;
            let sg = 0, cnt = 0;
            if (im) { sg += g[v - N2]; cnt++; }
            if (ip) { sg += g[v + N2]; cnt++; }
            if (jm) { sg += g[v - N]; cnt++; }
            if (jp) { sg += g[v + N]; cnt++; }
            if (k > 0) { sg += g[v - 1]; cnt++; }
            if (k < Nm1) { sg += g[v + 1]; cnt++; }
            const den = c * cnt + kBath + decay;
            const gs = (c * sg + kBath * bath + src[v] + wInf * inflam[v]) / den;
            const gv = g[v];
            let ng = gv + om * (gs - gv);
            if (ng < 0) ng = 0;
            const d = ng > gv ? ng - gv : gv - ng;
            if (d > worst) worst = d;
            g[v] = ng;
          }
        }
      }
      if (worst < ENGINE_QS_TOL) break;
    }
    // The hook's sources were computed from the field as it was at the START of the step, so a
    // source that depends on the field (Michaelis-Menten uptake, say) makes this a lagged
    // fixed-point iteration: g* = solve(src(g*)) is the true steady state, but jumping the whole
    // way there every step can oscillate between "everything consumed" and "nothing consumed".
    // Moving a fraction theta of the way damps that; the fixed point is unchanged.
    if (theta < 1) {
      for (let v = 0; v < NV; v++) { const p0 = prev[v], ng = p0 + theta * (g[v] - p0); g[v] = ng > 0 ? ng : 0; }
      if (kHold >= 0) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g[(i * N + j) * N + kHold] = bath;
    }
  }

  /** Cell counts per voxel from the current positions (used after reset / cell-count changes). */
  _countCells() {
    const N = this.N, Nm1 = N - 1, invh = 1 / this.h, cx = this._cx, cc = this._cellCount;
    cc.fill(0);
    for (let i = 0; i < this.nCells; i++) {
      const i3 = 3 * i;
      let ix = (cx[i3] * invh) | 0, iy = (cx[i3 + 1] * invh) | 0, iz = (cx[i3 + 2] * invh) | 0;
      if (ix > Nm1) ix = Nm1; else if (ix < 0) ix = 0;
      if (iy > Nm1) iy = Nm1; else if (iy < 0) iy = 0;
      if (iz > Nm1) iz = Nm1; else if (iz < 0) iz = 0;
      cc[(ix * N + iy) * N + iz]++;
    }
  }

  /** Full recomputation of fiberTotal, FA and the principal axis (2 warm-started power iterations). */
  _derived() {
    const NV = this.NV, eps = this.P.eps, nS = this.nSpecies, species = this.species, isFiber = this._isFiber;
    const Txx = this.Txx, Tyy = this.Tyy, Tzz = this.Tzz, Txy = this.Txy, Txz = this.Txz, Tyz = this.Tyz;
    const fa = this.fa, fx = this.fx, fy = this.fy, fz = this.fz, fiberTotal = this.fiberTotal;
    for (let v = 0; v < NV; v++) {
      const txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      const tr = txx + tyy + tzz;
      let tot = 0;
      for (let s = 0; s < nS; s++) if (isFiber[s]) tot += species[s][v];
      fiberTotal[v] = tot;
      const fro2 = txx * txx + tyy * tyy + tzz * tzz + 2 * (txy * txy + txz * txz + tyz * tyz);
      let f = 0;
      if (fro2 > eps * eps) {
        f = 1.5 * (fro2 - tr * tr / 3) / fro2;
        f = f <= 0 ? 0 : (f >= 1 ? 1 : Math.sqrt(f));
        let ax = fx[v], ay = fy[v], az = fz[v];
        for (let it = 0; it < 2; it++) {
          const bx = txx * ax + txy * ay + txz * az;
          const by = txy * ax + tyy * ay + tyz * az;
          const bz = txz * ax + tyz * ay + tzz * az;
          const bn = Math.sqrt(bx * bx + by * by + bz * bz);
          if (bn < 1e-12) break;
          ax = bx / bn; ay = by / bn; az = bz / bn;
        }
        fx[v] = ax; fy[v] = ay; fz[v] = az;
      }
      fa[v] = f;
    }
  }

  /** Fill E from the tissue's `stiffness` hook (or `voxel` with dt = 0). */
  _stiffness() {
    const NV = this.NV, nS = this.nSpecies, nF = this.nFields, species = this.species, fields = this.fields;
    const vctx = this._vctx, vout = vctx.out, eps = this.P.eps;
    const hook = typeof this.rules.stiffness === 'function' ? this.rules.stiffness : this.rules.voxel;
    vctx.dt = 0; vctx.load = this._loadDial >= 0 ? this._dialVals[this._loadDial] : 0;
    for (let v = 0; v < NV; v++) {
      const tr = this.Txx[v] + this.Tyy[v] + this.Tzz[v];
      for (let s = 0; s < nS; s++) vctx.rho[s] = species[s][v];
      vctx.v = v; vctx.fiberTotal = this.fiberTotal[v]; vctx.fa = this.fa[v]; vctx.Tzz_over_trace = tr > eps ? this.Tzz[v] / tr : 0;
      for (let f = 0; f < nF; f++) vctx.field[f] = fields[f][v];
      vctx.aSum = 0; vctx.nCellsHere = this._cellCount[v]; vctx.inflam = this.inflam[v];
      for (let q = 0; q < this.nVox; q++) vctx.vox[q] = 0;
      for (let s = 0; s < nS; s++) vout.dRho[s] = 0;
      for (let f = 0; f < nF; f++) vout.fieldSrc[f] = 0;
      vout.loss = 0; vout.scaffoldLoss = 0; vout.mobility = 1; vout.E = this.E[v];
      hook(vctx);
      const Ev = vout.E;
      this.E[v] = Ev === Ev ? Ev : this.E[v];
    }
    vctx.dt = this.dt;
  }

  // ------------------------------------------------------------- readouts

  get state() {
    const n = this.nCells, vw = this._views;
    if (vw.n !== n) {
      vw.n = n;
      vw.cx = this._cx.subarray(0, 3 * n); vw.cp = this._cp.subarray(0, 3 * n);
      vw.ca = this._ca.subarray(0, n); vw.cb = this._cb.subarray(0, n); vw.cc = this._cc.subarray(0, n); vw.ctype = this._ctype.subarray(0, n);
    }
    return {
      N: this.N, L: this.L, h: this.h, time: this.time, dt: this.dt, revision: this.revision,
      dials: this.dials, nCells: n, wound: this.wound, tissue: this.tissue.key, scenario: this.scenario,
      species: this.species, speciesKeys: this.speciesKeys,
      Txx: this.Txx, Tyy: this.Tyy, Tzz: this.Tzz, Txy: this.Txy, Txz: this.Txz, Tyz: this.Tyz,
      fiberTotal: this.fiberTotal, fa: this.fa, fx: this.fx, fy: this.fy, fz: this.fz, E: this.E, inflam: this.inflam,
      fields: this.fields, fieldKeys: this.fieldKeys,
      cx: vw.cx, cp: vw.cp, ca: vw.ca, cb: vw.cb, cc: vw.cc, ctype: vw.ctype,
    };
  }

  /** Generic scalar readouts (EXTENDING.md §3). deposition/degradation are MEAN density change per day. */
  stats() {
    const NV = this.NV, n = this.nCells, nS = this.nSpecies, nF = this.nFields;
    const fa = this.fa, E = this.E;
    let sF = 0, sLE = 0, sE = 0;
    let mxx = 0, myy = 0, mzz = 0, mxy = 0, mxz = 0, myz = 0;
    for (let v = 0; v < NV; v++) {
      sF += fa[v]; sE += E[v]; sLE += Math.log10(E[v]);
      mxx += this.Txx[v]; myy += this.Tyy[v]; mzz += this.Tzz[v]; mxy += this.Txy[v]; mxz += this.Txz[v]; myz += this.Tyz[v];
    }
    const species = {}, fraction = {};
    let total = 0, fiberTot = 0, scafTot = 0;
    for (let s = 0; s < nS; s++) {
      const arr = this.species[s];
      let sum = 0;
      for (let v = 0; v < NV; v++) sum += arr[v];
      const mean = sum / NV;
      species[this.speciesKeys[s]] = mean; total += mean;
      if (this._isFiber[s]) fiberTot += mean;
      if (this._isScaffold[s]) scafTot += mean;
    }
    for (let s = 0; s < nS; s++) fraction[this.speciesKeys[s]] = total > 1e-9 ? species[this.speciesKeys[s]] / total : 0;
    species.total = total; species.fiberTotal = fiberTot; species.tissueTotal = total - scafTot;
    const fields = {};
    for (let f = 0; f < nF; f++) {
      const arr = this.fields[f];
      let sum = 0;
      for (let v = 0; v < NV; v++) sum += arr[v];
      fields[this.fieldKeys[f]] = sum / NV;
    }
    let sA = 0, sB = 0, sC = 0;
    const tA = this._statA, tB = this._statB, tC = this._statC, tN = this._statN;
    tA.fill(0); tB.fill(0); tC.fill(0); tN.fill(0);
    for (let i = 0; i < n; i++) {
      const a = this._ca[i], b = this._cb[i], c = this._cc[i], ty = this._ctype[i];
      sA += a; sB += b; sC += c;
      tA[ty] += a; tB[ty] += b; tC[ty] += c; tN[ty]++;
    }
    const byType = {};
    for (let ty = 0; ty < this.nTypes; ty++) {
      const m = tN[ty];
      byType[this.tissue.cellTypes[ty].key] = { n: m, a: m ? tA[ty] / m : 0, b: m ? tB[ty] / m : 0, c: m ? tC[ty] / m : 0 };
    }
    // FA of the mean tensor = coherence of alignment across the whole tissue
    const tr = mxx + myy + mzz, fro2 = mxx * mxx + myy * myy + mzz * mzz + 2 * (mxy * mxy + mxz * mxz + myz * myz);
    let gFA = 0;
    if (fro2 > 1e-12) { gFA = 1.5 * (fro2 - tr * tr / 3) / fro2; gFA = gFA <= 0 ? 0 : Math.sqrt(Math.min(1, gFA)); }
    const deposition = this._lastDep / NV, degradation = this._lastDeg / NV;
    return {
      t: this.time,
      species, fraction,
      fa: sF / NV, globalFA: gFA, fz: tr > 1e-9 ? mzz / tr : 1 / 3,
      logE: sLE / NV, E: sE / NV,
      cells: { a: n > 0 ? sA / n : 0, b: n > 0 ? sB / n : 0, c: n > 0 ? sC / n : 0, n, byType },
      fields,
      deposition, degradation,
      ratio: degradation > 1e-12 ? deposition / degradation : (deposition > 1e-12 ? Infinity : 1),
      scaffold: scafTot, scaffoldFlux: this._lastScafLoss / NV,
      cumDeposition: this._cumDep, cumDegradation: this._cumDeg,
    };
  }

  /** One stat by §1 path, e.g. 'species.mat.fraction'. Throws on an unknown path. */
  stat(path) {
    const v = engineStatFrom(this.stats(), path);
    if (v === undefined) throw new Error(`unknown stat path '${path}'`);
    return v;
  }

  /** Same as stat(), from an already computed stats() object (undefined if unknown). */
  static statFrom(stats, path) { return engineStatFrom(stats, path); }

  /** Means inside the last wound sphere (null without a wound). */
  woundStats(wound = this.wound) {
    if (!wound) return null;
    const N = this.N, h = this.h, [cx, cy, cz] = wound.center, r2 = wound.radius * wound.radius;
    const nS = this.nSpecies, nF = this.nFields;
    const sS = new Float64Array(nS), sFld = new Float64Array(nF);
    let sF = 0, cnt = 0, sTot = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * h - cx;
      for (let j = 0; j < N; j++) {
        const y = (j + 0.5) * h - cy;
        for (let k = 0; k < N; k++) {
          const z = (k + 0.5) * h - cz;
          if (x * x + y * y + z * z > r2) continue;
          const v = (i * N + j) * N + k;
          for (let s = 0; s < nS; s++) sS[s] += this.species[s][v];
          for (let f = 0; f < nF; f++) sFld[f] += this.fields[f][v];
          sF += this.fa[v]; sTot += this.fiberTotal[v]; cnt++;
        }
      }
    }
    let nc = 0, sA = 0, sB = 0, sC = 0;
    for (let i = 0; i < this.nCells; i++) {
      const x = this._cx[3 * i] - cx, y = this._cx[3 * i + 1] - cy, z = this._cx[3 * i + 2] - cz;
      if (x * x + y * y + z * z <= r2) { nc++; sA += this._ca[i]; sB += this._cb[i]; sC += this._cc[i]; }
    }
    const species = {}, fraction = {}, fields = {};
    let total = 0;
    for (let s = 0; s < nS; s++) { species[this.speciesKeys[s]] = cnt ? sS[s] / cnt : 0; total += species[this.speciesKeys[s]]; }
    for (let s = 0; s < nS; s++) fraction[this.speciesKeys[s]] = total > 1e-9 ? species[this.speciesKeys[s]] / total : 0;
    let scafTot = 0;
    for (let s = 0; s < nS; s++) if (this._isScaffold[s]) scafTot += species[this.speciesKeys[s]];
    species.total = total; species.fiberTotal = cnt ? sTot / cnt : 0; species.tissueTotal = total - scafTot;
    for (let f = 0; f < nF; f++) fields[this.fieldKeys[f]] = cnt ? sFld[f] / cnt : 0;
    return { species, fraction, fields, fa: cnt ? sF / cnt : 0, nVox: cnt, cells: { n: nc, a: nc ? sA / nc : 0, b: nc ? sB / nc : 0, c: nc ? sC / nc : 0 } };
  }

  /** One frame of the format-2 export (EXTENDING.md §5): plain arrays, rounded. */
  snapshot() {
    const NV = this.NV, n = this.nCells, nS = this.nSpecies;
    const f = new Float32Array(3 * NV);
    for (let v = 0; v < NV; v++) { f[3 * v] = this.fx[v]; f[3 * v + 1] = this.fy[v]; f[3 * v + 2] = this.fz[v]; }
    const phi = new Float32Array(NV);
    if (this._lastFiber >= 0) {
      const last = this.species[this._lastFiber];
      for (let v = 0; v < NV; v++) phi[v] = this.fiberTotal[v] > 1e-9 ? last[v] / this.fiberTotal[v] : 0;
    }
    const species = {};
    for (let s = 0; s < nS; s++) species[this.speciesKeys[s]] = tmRoundArray(this.species[s], 3);
    const fields = {};                                   // E1: diffusible fields travel with the frame
    for (let f = 0; f < this.nFields; f++) fields[this.fieldKeys[f]] = tmRoundArray(this.fields[f], 4);
    const a = tmRoundArray(this._ca.subarray(0, n), 3);
    return {
      t: Math.round(this.time * 1000) / 1000,
      species,
      fields,
      fa: tmRoundArray(this.fa, 3),
      f: tmRoundArray(f, 3),
      rho: tmRoundArray(this.fiberTotal, 3),   // format-1 readers: rho = fiber total
      phiMat: tmRoundArray(phi, 3),            // format-1 readers: fraction of the LAST fiber species
      cells: {
        x: tmRoundArray(this._cx.subarray(0, 3 * n), 4),
        p: tmRoundArray(this._cp.subarray(0, 3 * n), 3),
        a, b: tmRoundArray(this._cb.subarray(0, n), 3), c: tmRoundArray(this._cc.subarray(0, n), 3),
        type: Array.from(this._ctype.subarray(0, n)),
        alpha: a,                               // format-1 readers
      },
    };
  }

  /**
   * `meta` block of the format-2 export; `extra` (e.g. { exportEveryDays }) is merged in.
   * `loadDial` / `cellCountDial` name the dials carrying those roles (null when there is none)
   * so a reader knows which dial to draw load arrows for without guessing at 'strain', and
   * `loadRange` is that dial's [min, max] so a reader can normalise it (a 0–0.2 compression dial
   * draws the same arrows as a 0–1 stretch dial).  `fields` mirrors `species` for the per-frame
   * field grids `snapshot()` now writes; `tissueName` / `scenarioTitle` are display labels.
   * A cellType with a state-dependent radius exports the state-0 value as `radius` (readers of
   * format 2 keep working) plus `radiusBy: { by, min, max }`.
   */
  exportMeta(extra = {}) {
    const t = this.tissue;
    return Object.assign({
      format: 2, tissue: t.key, tissueVersion: t.version, engine: ENGINE_VERSION,
      N: this.N, L: this.L, K: this.P.K, dtDays: this.dt, scenario: this.scenario,
      dials: Object.assign({}, this.dials), seed: this.seed,
      tissueName: t.name,
      scenarioTitle: (t.scenarios.find((s) => s.key === this.scenario) || {}).title || null,
      loadDial: this._loadDial >= 0 ? this.dialKeys[this._loadDial] : null,
      loadRange: this._loadDial >= 0 ? [t.dials[this._loadDial].min, t.dials[this._loadDial].max] : null,
      cellCountDial: this._cellDial >= 0 ? this.dialKeys[this._cellDial] : null,
      species: t.species.map((s) => ({ key: s.key, label: s.label, kind: s.kind, color: s.color })),
      fields: t.fields.map((f) => ({ key: f.key, label: f.label, color: f.color })),
      cellTypes: t.cellTypes.map((c) => {
        const meta = { key: c.key, label: c.label, colors: c.colors.slice(), shape: Object.assign({}, c.shape), radius: c.radius };
        if (c.radius && typeof c.radius === 'object') { meta.radius = c.radius.min; meta.radiusBy = Object.assign({}, c.radius); }
        return meta;
      }),
    }, extra);
  }

  /**
   * Is a quasi-steady solve well posed for this field definition?  It needs somewhere for the
   * flux to go: a Dirichlet face held at a bath dial, a bulk bath relaxation (kBath > 0) or a
   * decay term.  A pure zero-flux field with a net source has no steady state, so 'auto' keeps
   * integrating it in time and an explicit 'quasiSteady' request falls back to sub-cycling.
   */
  static _steadySolvable(f) {
    const face = f.boundary === 'face:+z' || f.boundary === 'face:-z';
    if (face && f.bath) return true;
    if (f.bath && (f.kBath || 0) > 0) return true;
    return (f.decay || 0) > 0;
  }

  /**
   * The cell scalars of a cell type as `[{ key, label, range }]`, merging the `states` array
   * with the older `stateLabels` / `cRange` aliases (states wins). a and b are always [0, 1].
   */
  static cellStates(cellType) {
    const out = [];
    for (const key of ['a', 'b', 'c']) {
      const st = (cellType.states || []).find((s) => s.key === key);
      const label = st ? st.label : ((cellType.stateLabels || {})[key] || null);
      let range = st && Array.isArray(st.range) ? st.range.slice() : null;
      if (!range) range = key === 'c' && cellType.cRange ? cellType.cRange.slice() : [0, 1];
      if (label !== null || key === 'a') out.push({ key, label, range });
    }
    return out;
  }

  // ------------------------------------------------------------- scenario checks

  /**
   * Run `scenarioKey` (with its `events`) to the latest `at` of its checks and evaluate them.
   * Returns [{ check, value, ref, pass }]. opts: { seed = 7, engine } (engine: reuse an instance
   * of the same tissue, e.g. for its init.from cache).
   *
   * The clock advances on a HALF-DAY grid (day boundaries land exactly where they did in v0.2,
   * so a scenario's trajectory is unchanged): a check whose `at` is a window `[from, to]` is
   * evaluated on the samples every 0.5 d inside it, aggregated by `agg` ('min' | 'max' | 'mean'
   * | 'first'). Events fire as soon as the clock reaches their day.
   */
  static checkScenario(tissue, scenarioKey, opts = {}) {
    const seed = opts.seed === undefined ? 7 : opts.seed;
    const M = opts.engine || new TissueEngine(tissue, { seed });
    if (M.tissue !== tissue) throw new Error('checkScenario: engine belongs to another tissue');
    if (opts.engine && M.seed !== (seed >>> 0)) M.seed = seed >>> 0;
    M.reset(scenarioKey);
    const sc = M.scenarioDef(scenarioKey);
    const checks = sc.checks || [], events = (sc.events || []).map((e) => Object.assign({}, e));
    const g = (t) => Math.round(t * 2);            // times live on the half-day grid, as integers
    const want = new Set();
    let last = 0;
    const add = (t) => { const q = g(t); want.add(q); if (q / 2 > last) last = q / 2; };
    for (const c of checks) {
      if (Array.isArray(c.at)) for (let q = g(c.at[0]); q <= g(c.at[1]); q++) add(q / 2);
      else add(c.at);
      if (c.rel && c.rel.at !== undefined) add(c.rel.at);
    }
    for (const e of events) if (e.at > last) last = g(e.at) / 2;
    const spd = Math.round(1 / M.dt), half = Math.round(spd / 2);
    const rec = new Map();
    const nHalf = g(last);
    for (let i = 0; i <= nHalf; i++) {
      const t = i / 2;
      for (const e of events) {
        if (e.fired || e.at > t + 1e-9) continue;
        e.fired = true;
        if (e.dials) M.setDials(e.dials);
        if (e.injure) M.injure(e.injure.center || null, e.injure.radius);
      }
      if (want.has(i)) rec.set(i, M.stats());
      if (i < nHalf) M.step(i % 2 === 0 ? half : spd - half);
    }
    const at0 = (c) => (Array.isArray(c.at) ? c.at[0] : c.at);
    return checks.map((check) => {
      let value;
      if (Array.isArray(check.at)) {
        const vals = [];
        for (let q = g(check.at[0]); q <= g(check.at[1]); q++) {
          const s = rec.get(q);
          const x = s === undefined ? undefined : engineStatFrom(s, check.stat);
          if (x !== undefined) vals.push(x);
        }
        value = vals.length ? ENGINE_AGGS[check.agg](vals) : undefined;
      } else {
        value = engineStatFrom(rec.get(g(check.at)), check.stat);
      }
      let pass, ref;
      if (check.rel) {
        const at = check.rel.at === undefined ? at0(check) : check.rel.at;
        ref = engineStatFrom(rec.get(g(at)), check.rel.stat) + (check.value === undefined ? 0 : check.value);
        pass = ENGINE_OPS[check.rel.op](value, ref);
      } else {
        ref = check.value;
        pass = ENGINE_OPS[check.op](value, check.value);
      }
      return { check, value, ref, pass: !!pass };
    });
  }

  // ------------------------------------------------------------- schema

  /**
   * Validate a tissue definition against EXTENDING.md §1. Returns an array of error strings
   * ([] = valid).  A VALID definition is also passed through TissueEngine.warnings(t, opts) and
   * anything it finds (a field that cannot integrate explicitly, a repulsion range wider than a
   * voxel, cell seeding that has no source) is printed once per definition with console.warn.
   * `opts.overrides` are the constructor's engine overrides, so the reported diffusion numbers
   * are the ones this engine will actually run with.
   */
  static validate(t, opts = {}) {
    const err = [];
    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
    const isStr = (x) => typeof x === 'string' && x.length > 0;
    const isHex = (x) => typeof x === 'string' && ENGINE_HEX.test(x);
    if (!t || typeof t !== 'object') return ['definition is not an object'];
    if (!isStr(t.key) || !ENGINE_TISSUE_KEY.test(t.key)) err.push('key must match [a-z0-9-]+');
    if (!isStr(t.name)) err.push('name missing');
    if (!isStr(t.version)) err.push('version missing');
    if (typeof t.makeRules !== 'function') err.push('makeRules must be a function');

    const sKeys = [], fKeys = [], dKeys = [], scKeys = [];
    if (!Array.isArray(t.species) || t.species.length === 0) err.push('species must be a non-empty array');
    else t.species.forEach((s, i) => {
      if (!isStr(s.key) || !ENGINE_IDENT.test(s.key)) err.push(`species[${i}].key invalid`);
      else if (sKeys.includes(s.key)) err.push(`species key '${s.key}' duplicated`); else sKeys.push(s.key);
      if (ENGINE_RESERVED_SPECIES.includes(s.key)) err.push(`species key '${s.key}' is reserved by the stat paths`);
      if (!isStr(s.label)) err.push(`species '${s.key}' label missing`);
      if (!['fiber', 'gel', 'scaffold'].includes(s.kind)) err.push(`species '${s.key}' kind must be fiber|gel|scaffold`);
      if (!isHex(s.color)) err.push(`species '${s.key}' color must be #rrggbb`);
      if (s.D !== undefined && (!isNum(s.D) || s.D < 0)) err.push(`species '${s.key}' D must be a number ≥ 0`);
      if (s.sink !== undefined && (!isNum(s.sink) || s.sink < 0)) err.push(`species '${s.key}' sink must be a number ≥ 0`);
      if (s.boundary !== undefined && s.boundary !== 'face:+z') err.push(`species '${s.key}' boundary must be 'face:+z' (the only species boundary)`);
      if (s.mode !== undefined && !['auto', 'explicit', 'subcycled'].includes(s.mode)) {
        err.push(`species '${s.key}' mode must be auto|explicit|subcycled (transport moves mass, so there is no quasiSteady)`);
      }
    });
    if (!Array.isArray(t.fields)) err.push('fields must be an array');
    else t.fields.forEach((f, i) => {
      if (!isStr(f.key) || !ENGINE_IDENT.test(f.key)) err.push(`fields[${i}].key invalid`);
      else if (fKeys.includes(f.key)) err.push(`field key '${f.key}' duplicated`); else fKeys.push(f.key);
      if (!isStr(f.label)) err.push(`field '${f.key}' label missing`);
      if (!isHex(f.color)) err.push(`field '${f.key}' color must be #rrggbb`);
      if (!isNum(f.D) || f.D < 0) err.push(`field '${f.key}' D must be a number ≥ 0`);
      if (f.bath !== null && f.bath !== undefined && !isStr(f.bath)) err.push(`field '${f.key}' bath must be null or a dial key`);
      if (f.kBath !== undefined && (!isNum(f.kBath) || f.kBath < 0)) err.push(`field '${f.key}' kBath must be ≥ 0`);
      if (f.decay !== undefined && (!isNum(f.decay) || f.decay < 0)) err.push(`field '${f.key}' decay must be ≥ 0`);
      if (f.boundary !== undefined && !['bath', 'face:+z', 'face:-z'].includes(f.boundary)) err.push(`field '${f.key}' boundary must be bath|face:+z|face:-z`);
      if (f.boundary && f.boundary !== 'bath' && !f.bath) err.push(`field '${f.key}' boundary '${f.boundary}' needs a bath dial`);
      if (f.mode !== undefined && !['auto', 'explicit', 'subcycled', 'quasiSteady'].includes(f.mode)) err.push(`field '${f.key}' mode must be auto|explicit|subcycled|quasiSteady`);
    });
    if (!Array.isArray(t.cellTypes) || t.cellTypes.length === 0) err.push('cellTypes must be a non-empty array');
    else t.cellTypes.forEach((c, i) => {
      if (!isStr(c.key) || !ENGINE_IDENT.test(c.key)) err.push(`cellTypes[${i}].key invalid`);
      if (!isStr(c.label)) err.push(`cellType '${c.key}' label missing`);
      if (!Array.isArray(c.colors) || c.colors.length !== 2 || !c.colors.every(isHex)) err.push(`cellType '${c.key}' colors must be two #rrggbb`);
      if (!c.shape || !['a', 'b'].includes(c.shape.by) || !isNum(c.shape.aspectMin) || !isNum(c.shape.aspectMax)) err.push(`cellType '${c.key}' shape must be { by: 'a'|'b', aspectMin, aspectMax }`);
      if (isNum(c.radius)) { if (c.radius <= 0) err.push(`cellType '${c.key}' radius must be > 0`); }
      else if (c.radius && typeof c.radius === 'object') {
        if (!['a', 'b'].includes(c.radius.by) || !isNum(c.radius.min) || !isNum(c.radius.max) || c.radius.min <= 0 || c.radius.max <= 0) {
          err.push(`cellType '${c.key}' radius object must be { by: 'a'|'b', min > 0, max > 0 }`);
        }
      } else err.push(`cellType '${c.key}' radius must be a number > 0 or { by, min, max }`);
      if (typeof c.motile !== 'boolean') err.push(`cellType '${c.key}' motile must be boolean`);
      if (c.fraction !== undefined && (!isNum(c.fraction) || c.fraction < 0)) err.push(`cellType '${c.key}' fraction must be ≥ 0`);
      if (c.count !== undefined) {
        if (!Number.isInteger(c.count) || c.count < 0) err.push(`cellType '${c.key}' count must be an integer ≥ 0`);
        if (c.fraction !== undefined) err.push(`cellType '${c.key}' declares both count and fraction (count is absolute, fraction is a share of what is left)`);
      }
      if (c.rCell !== undefined && (!isNum(c.rCell) || c.rCell <= 0)) err.push(`cellType '${c.key}' rCell must be a number > 0`);
      if (c.init && ((c.init.a !== undefined && !isNum(c.init.a)) || (c.init.b !== undefined && !isNum(c.init.b)) || (c.init.c !== undefined && !isNum(c.init.c)))) err.push(`cellType '${c.key}' init.a/b/c must be numbers`);
      if (c.cRange !== undefined && (!Array.isArray(c.cRange) || c.cRange.length !== 2 || !c.cRange.every(isNum) || c.cRange[0] >= c.cRange[1])) err.push(`cellType '${c.key}' cRange must be [lo, hi] with lo < hi`);
      if (c.states !== undefined) {
        if (!Array.isArray(c.states)) err.push(`cellType '${c.key}' states must be an array`);
        else {
          const stKeys = [];
          c.states.forEach((st, k) => {
            if (!st || !['a', 'b', 'c'].includes(st.key)) { err.push(`cellType '${c.key}' states[${k}].key must be a|b|c`); return; }
            if (stKeys.includes(st.key)) err.push(`cellType '${c.key}' states: '${st.key}' duplicated`); else stKeys.push(st.key);
            if (st.label !== undefined && st.label !== null && !isStr(st.label)) err.push(`cellType '${c.key}' states.${st.key}.label must be a string`);
            if (st.range === undefined) return;
            if (!Array.isArray(st.range) || st.range.length !== 2 || !st.range.every(isNum) || st.range[0] >= st.range[1]) err.push(`cellType '${c.key}' states.${st.key}.range must be [lo, hi] with lo < hi`);
            else if (st.key !== 'c') { if (st.range[0] !== 0 || st.range[1] !== 1) err.push(`cellType '${c.key}' states.${st.key}.range must be [0, 1] (only c may have another range)`); }
            else if (c.cRange && (c.cRange[0] !== st.range[0] || c.cRange[1] !== st.range[1])) err.push(`cellType '${c.key}': states.c.range and cRange disagree`);
          });
        }
      }
    });
    if (t.cellTypes && t.cellTypes.length > 255) err.push('at most 255 cell types');
    let nLoad = 0, nCount = 0;
    if (!Array.isArray(t.dials)) err.push('dials must be an array');
    else t.dials.forEach((d, i) => {
      if (!isStr(d.key) || !ENGINE_IDENT.test(d.key)) err.push(`dials[${i}].key invalid`);
      else if (dKeys.includes(d.key)) err.push(`dial key '${d.key}' duplicated`); else dKeys.push(d.key);
      if (!isStr(d.label)) err.push(`dial '${d.key}' label missing`);
      if (!isNum(d.min) || !isNum(d.max) || d.min >= d.max) err.push(`dial '${d.key}' needs min < max`);
      if (!isNum(d.step) || d.step <= 0) err.push(`dial '${d.key}' step must be > 0`);
      if (!isNum(d.default) || d.default < d.min || d.default > d.max) err.push(`dial '${d.key}' default outside [min, max]`);
      if (!(typeof d.format === 'function' || ENGINE_FORMATS.includes(d.format))) err.push(`dial '${d.key}' format must be fixed2|percent|cells|int|onoff|function`);
      if (d.role !== undefined) {
        if (d.role === 'load') nLoad++;
        else if (d.role === 'cellCount') nCount++;
        else err.push(`dial '${d.key}' role must be load|cellCount`);
      }
    });
    if (nLoad > 1) err.push('at most one dial with role load');
    if (nCount > 1) err.push('at most one dial with role cellCount');
    if (Array.isArray(t.fields)) t.fields.forEach((f) => { if (f.bath && !dKeys.includes(f.bath)) err.push(`field '${f.key}' bath '${f.bath}' is not a dial`); });

    const checkPath = (path, where) => { if (!engineStatPathValid(t, path)) err.push(`${where}: unknown stat path '${path}'`); };
    if (!Array.isArray(t.scenarios) || t.scenarios.length === 0) err.push('scenarios must be a non-empty array');
    else {
      t.scenarios.forEach((s) => { if (isStr(s.key)) scKeys.push(s.key); });
      t.scenarios.forEach((s, i) => {
        if (!isStr(s.key) || !ENGINE_IDENT.test(s.key)) err.push(`scenarios[${i}].key invalid`);
        if (scKeys.indexOf(s.key) !== i) err.push(`scenario key '${s.key}' duplicated`);
        if (!isStr(s.title)) err.push(`scenario '${s.key}' title missing`);
        if (s.dials) for (const k of Object.keys(s.dials)) { if (!dKeys.includes(k)) err.push(`scenario '${s.key}' dials: unknown dial '${k}'`); if (!isNum(s.dials[k])) err.push(`scenario '${s.key}' dial '${k}' not a number`); }
        const init = s.init || {};
        if (init.species) for (const k of Object.keys(init.species)) { if (!sKeys.includes(k)) err.push(`scenario '${s.key}' init.species: unknown species '${k}'`); if (!isNum(init.species[k]) || init.species[k] < 0) err.push(`scenario '${s.key}' init.species.${k} must be ≥ 0`); }
        if (init.jitter !== undefined && (!isNum(init.jitter) || init.jitter < 0 || init.jitter > 2)) err.push(`scenario '${s.key}' init.jitter must be in [0, 2]`);
        if (init.fields) for (const k of Object.keys(init.fields)) if (!fKeys.includes(k)) err.push(`scenario '${s.key}' init.fields: unknown field '${k}'`);
        if (init.from) {
          if (!scKeys.includes(init.from.scenario)) err.push(`scenario '${s.key}' init.from.scenario '${init.from.scenario}' unknown`);
          if (init.from.scenario === s.key) err.push(`scenario '${s.key}' init.from refers to itself`);
          if (!isNum(init.from.days) || init.from.days <= 0) err.push(`scenario '${s.key}' init.from.days must be > 0`);
          if (init.from.events !== undefined && typeof init.from.events !== 'boolean') err.push(`scenario '${s.key}' init.from.events must be a boolean`);
          if (init.from.dials !== undefined) {
            if (typeof init.from.dials !== 'object' || init.from.dials === null) err.push(`scenario '${s.key}' init.from.dials must be an object`);
            else for (const k of Object.keys(init.from.dials)) {
              if (!dKeys.includes(k)) err.push(`scenario '${s.key}' init.from.dials: unknown dial '${k}'`);
              if (!isNum(init.from.dials[k])) err.push(`scenario '${s.key}' init.from.dials.${k} must be a number`);
            }
          }
          // cycle detection
          let cur = init.from.scenario, hops = 0;
          while (cur && hops < 10) {
            const nxt = t.scenarios.find((q) => q.key === cur);
            cur = nxt && nxt.init && nxt.init.from ? nxt.init.from.scenario : null; hops++;
            if (cur === s.key) { err.push(`scenario '${s.key}' init.from chain is cyclic`); break; }
          }
        }
        if (s.checks !== undefined && !Array.isArray(s.checks)) err.push(`scenario '${s.key}' checks must be an array`);
        (Array.isArray(s.checks) ? s.checks : []).forEach((c, j) => {
          const w = `scenario '${s.key}' checks[${j}]`;
          if (Array.isArray(c.at)) {
            if (c.at.length !== 2 || !c.at.every(isNum) || c.at[0] < 0 || c.at[1] < c.at[0]) err.push(`${w}: at [from, to] needs 0 ≤ from ≤ to`);
            if (!(c.agg in ENGINE_AGGS)) err.push(`${w}: at [from, to] needs agg min|max|mean|first`);
          } else {
            if (!isNum(c.at) || c.at < 0) err.push(`${w}: at must be a day ≥ 0 (or [from, to] with agg)`);
            if (c.agg !== undefined) err.push(`${w}: agg only applies to at [from, to]`);
          }
          checkPath(c.stat, w);
          if (c.rel) {
            checkPath(c.rel.stat, `${w}.rel`);
            if (!['gt', 'lt'].includes(c.rel.op)) err.push(`${w}.rel.op must be gt|lt`);
            if (c.rel.at !== undefined && (!isNum(c.rel.at) || c.rel.at < 0)) err.push(`${w}.rel.at must be a day ≥ 0`);
            if (c.value !== undefined && !isNum(c.value)) err.push(`${w}: value (offset) must be a number`);
          } else if (c.op === 'between') {
            if (!Array.isArray(c.value) || c.value.length !== 2 || !c.value.every(isNum) || c.value[0] > c.value[1]) err.push(`${w}: between needs value [lo, hi]`);
          } else if (c.op === 'gt' || c.op === 'lt') {
            if (!isNum(c.value)) err.push(`${w}: value must be a number`);
          } else err.push(`${w}: op must be gt|lt|between`);
        });
        (Array.isArray(s.events) ? s.events : []).forEach((e, j) => {
          const w = `scenario '${s.key}' events[${j}]`;
          if (!isNum(e.at) || e.at < 0) err.push(`${w}: at must be a day ≥ 0`);
          if (!e.dials && !e.injure) err.push(`${w}: needs dials or injure`);
          if (e.dials) for (const k of Object.keys(e.dials)) if (!dKeys.includes(k)) err.push(`${w}: unknown dial '${k}'`);
          if (e.injure && !t.injury) err.push(`${w}: injure event but the tissue has no injury block`);
        });
      });
    }
    if (t.readouts !== undefined) {
      if (!Array.isArray(t.readouts)) err.push('readouts must be an array');
      else t.readouts.forEach((r, i) => {
        if (!isStr(r.key)) err.push(`readouts[${i}].key missing`);
        if (!isStr(r.label)) err.push(`readout '${r.key}' label missing`);
        if (!['stack', 'lines', 'log', 'flux'].includes(r.type)) err.push(`readout '${r.key}' type must be stack|lines|log|flux`);
        if (r.type !== 'flux') {
          if (!Array.isArray(r.series) || r.series.length === 0) err.push(`readout '${r.key}' needs series`);
          else r.series.forEach((ser) => { checkPath(ser.stat, `readout '${r.key}' series`); if (!isHex(ser.color)) err.push(`readout '${r.key}' series '${ser.stat}' color must be #rrggbb`); });
        }
      });
    }
    if (t.injury !== undefined && t.injury !== null) {
      const inj = t.injury;
      if (!isNum(inj.radius) || inj.radius <= 0) err.push('injury.radius must be > 0');
      (inj.clearSpecies || []).forEach((k) => { if (!sKeys.includes(k)) err.push(`injury.clearSpecies: unknown species '${k}'`); });
      for (const k of Object.keys(inj.fieldBurst || {})) if (!fKeys.includes(k)) err.push(`injury.fieldBurst: unknown field '${k}'`);
      if (inj.inflammation) {
        for (const k of Object.keys(inj.inflammation.sources || {})) if (!fKeys.includes(k)) err.push(`injury.inflammation.sources: unknown field '${k}'`);
        if (!isNum(inj.inflammation.tau) || inj.inflammation.tau <= 0) err.push('injury.inflammation.tau must be > 0');
      }
    }
    if (t.engine !== undefined) {
      if (typeof t.engine !== 'object') err.push('engine must be an object');
      else for (const [k, v] of Object.entries(t.engine)) {
        if (!(k in ENGINE_DEFAULTS)) err.push(`engine.${k} is not an engine numeric`);
        else if (k === 'trace') { if (v !== 'fiber') err.push("engine.trace must be 'fiber'"); }
        else if (k === 'vox') { if (!Number.isInteger(v) || v < 1 || v > 4) err.push('engine.vox must be an integer 1..4'); }
        else if (k === 'loadMode') { if (v !== 'tension' && v !== 'compression') err.push("engine.loadMode must be 'tension' or 'compression'"); }
        else if (!isNum(v)) err.push(`engine.${k} must be a number`);
      }
    }
    if (t.copy !== undefined && (typeof t.copy !== 'object' || t.copy === null)) err.push('copy must be an object');
    if (t.copy && t.copy.vocabulary) for (const k of ['matrix', 'cellsActive', 'cellsQuiet']) if (!isStr(t.copy.vocabulary[k])) err.push(`copy.vocabulary.${k} missing`);
    if (!err.length) {
      const warn = TissueEngine.warnings(t, opts);
      if (warn.length && typeof console !== 'undefined' && console.warn) {
        let seen = ENGINE_WARNED.get(t);
        if (!seen) { seen = new Set(); ENGINE_WARNED.set(t, seen); }
        for (const w of warn) if (!seen.has(w)) { seen.add(w); console.warn(`tissue '${t.key}': ${w}`); }
      }
    }
    return err;
  }

  /**
   * Non-fatal notes about a VALID definition (docs/EXTENDING.md §7.1).  Each is something the
   * engine works around silently but an author should know about:
   *   - a field or species whose diffusion number lam = D·dt/h² is above the explicit limit 1/6,
   *     naming the field, lam and the integration mode the engine picked (A1);
   *   - a repulsion range 2·max(rCell) that is not smaller than a voxel, which the 27-bin
   *     neighbour search assumes;
   *   - cell seeding with neither a role:'cellCount' dial nor any cellTypes[].count, or with both.
   * `opts.overrides` are the constructor's engine overrides. Pure: returns the strings, prints nothing.
   */
  static warnings(t, opts = {}) {
    const out = [];
    if (!t || typeof t !== 'object' || !Array.isArray(t.fields) || !Array.isArray(t.species) || !Array.isArray(t.cellTypes) || !Array.isArray(t.dials)) return out;
    const P = Object.assign({}, ENGINE_DEFAULTS, t.engine || {}, opts.overrides || {});
    const h = P.L / (P.N | 0), h2 = h * h;
    const say = (what, lam, r, steady) => {
      const head = `${what}: lam = D·dt/h² = ${engineFmt(lam)}`;
      if (r.mode === 0) return `${head} > 1/6 but mode is 'explicit' — the diffusion number is CLAMPED at 1/6, so it integrates as if D were ${engineFmt(ENGINE_LAM_STABLE * h2 / P.dt)}`;
      if (r.mode === 2) return `${head} → mode 'quasiSteady' (steady solve, ≤ ${ENGINE_QS_SWEEPS} sweeps to ${ENGINE_QS_TOL})`;
      let msg = `${head} > 1/6 → mode 'subcycled' (${r.nSub} explicit sub-steps per step)`;
      if (r.capped) msg += `; ${r.nWant} would be needed, capped at ${ENGINE_SUB_MAX}${steady ? " — set mode: 'quasiSteady'" : ' — this field has no steady state (no Dirichlet face, kBath or decay), so it is integrated in time'}`;
      else if (r.fellBack) msg += " — mode 'quasiSteady' needs a Dirichlet face, kBath > 0 or decay > 0";
      return msg;
    };
    for (const f of t.fields) {
      const lam = (f.D || 0) * P.dt / h2, steady = TissueEngine._steadySolvable(f);
      const r = engineDiffusionMode(lam, f.mode || 'auto', steady);
      if (r.mode === 0 && !r.capped) continue;
      out.push(say(`field '${f.key}'`, lam, r, steady));
    }
    for (const sp of t.species) {
      const lam = (sp.D || 0) * P.dt / h2;
      const r = engineDiffusionMode(lam, sp.mode || 'auto', false);
      if (r.mode === 0 && !r.capped) continue;
      out.push(say(`species '${sp.key}'`, lam, r, false));
    }
    let rMax = P.rCell;
    for (const c of t.cellTypes) if (typeof c.rCell === 'number' && c.rCell > rMax) rMax = c.rCell;
    if (2 * rMax >= h) {
      out.push(`repulsion range 2·max(rCell) = ${engineFmt(2 * rMax)} is not smaller than a voxel (h = ${engineFmt(h)}): the 27-bin neighbour search can miss overlapping cells — lower rCell or raise N`);
    }
    const hasDial = t.dials.some((d) => d.role === 'cellCount'), hasCount = t.cellTypes.some((c) => Number.isInteger(c.count));
    if (hasDial && hasCount) out.push("both a role:'cellCount' dial and cellTypes[].count: the dial sets the TOTAL, the counted types are seeded first and the rest share what is left by `fraction`");
    if (!hasDial && !hasCount) out.push("no role:'cellCount' dial and no cellTypes[].count: the tissue starts with no cells (unless a scenario's init.from brings some)");
    return out;
  }
}
