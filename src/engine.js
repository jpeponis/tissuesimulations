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
 *                    differs from the main run's), without that scenario's
 *                    events, and copies species, T, principal axes, fields and
 *                    cells.  Cached per (scenario, days, seed) in the instance.
 *                    Chains (from → from) are allowed up to depth 4.
 *  scenario.events   OPTIONAL `events: [{ at, dials }, { at, injure: { center?, radius? } }]`
 *                    applied by checkScenario() and the headless tools when the
 *                    clock reaches day `at` (before stepping on).  The app may
 *                    treat them as suggestions (v0.1 never auto-injured).
 *  checks            `{ at, stat, op, value }` or `{ at, stat, rel: { stat, op, at? }, value? }`:
 *                    with `rel` the check passes when stat(at) op (rel.stat at
 *                    rel.at (default: same day) + value (default 0)).
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
 *  stat(path)        also accepts 'fz', 'cells.n', 't' and 'species.fiberTotal'.
 *  exportMeta(extra) merges `extra` (e.g. { exportEveryDays }) into the meta.
 *  woundStats()      means inside the last wound sphere (null without a wound).
 *  checkScenario     `{ seed = 7, engine }`: pass an existing engine of the same
 *                    tissue to reuse its init.from cache.
 * ---------------------------------------------------------------------------
 */

export const ENGINE_VERSION = '0.2.0';

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
});

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
const ENGINE_FORMATS = Object.freeze(['fixed2', 'percent', 'cells', 'int', 'onoff']);
const ENGINE_HEX = /^#[0-9a-fA-F]{6}$/;
const ENGINE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGINE_TISSUE_KEY = /^[a-z0-9-]+$/;

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
    case 'species.total': return s.species.total;
    case 'species.fiberTotal': return s.species.fiberTotal;
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
  return undefined;
}

/** Is `path` a stat path that exists for this definition (species/field keys resolved)? */
function engineStatPathValid(tissue, path) {
  if (typeof path !== 'string') return false;
  if (['t', 'fa', 'globalFA', 'fz', 'logE', 'E', 'deposition', 'degradation', 'ratio', 'species.total', 'species.fiberTotal',
    'fiber.total', 'cells.a', 'cells.b', 'cells.c', 'cells.n'].includes(path)) return true;
  const p = path.split('.');
  const sKeys = (tissue.species || []).map((s) => s.key), fKeys = (tissue.fields || []).map((f) => f.key);
  if (p[0] === 'species' && p.length === 2) return sKeys.includes(p[1]);
  if (p[0] === 'species' && p.length === 3 && p[2] === 'fraction') return sKeys.includes(p[1]);
  if (p[0] === 'fields' && p.length === 2) return fKeys.includes(p[1]);
  return false;
}

export class TissueEngine {
  /**
   * @param {object} tissue     a tissue definition (docs/EXTENDING.md §1)
   * @param {object} opts       { seed: uint32, overrides: { N, dt, ... engine numerics } }
   */
  constructor(tissue, opts = {}) {
    const errors = TissueEngine.validate(tissue);
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
    this._typeInitA = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.a) || 0));
    this._typeInitB = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.b) || 0));
    this._typeInitC = Float64Array.from(tissue.cellTypes.map((c) => (c.init && c.init.c) || 0));
    this._typeCMin = Float64Array.from(tissue.cellTypes.map((c) => (c.cRange ? c.cRange[0] : 0)));
    this._typeCMax = Float64Array.from(tissue.cellTypes.map((c) => (c.cRange ? c.cRange[1] : 1)));
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

    // ---- per-step scratch
    this._aSum = new Float64Array(NV);
    this._cellCount = new Int32Array(NV);

    // ---- reusable hook contexts (monomorphic: every field initialised once)
    const self = this;
    this._cctx = {
      i: 0, type: 0, a: 0, b: 0, c: 0, dt: this.dt,
      rho: new Float32Array(this.nSpecies), fiberTotal: 0, fa: 0, fz: 0,
      field: new Float32Array(this.nFields), E: 0, dial: this._dialVals, load: 0, cellsInVoxel: 0,
      rng: () => self.rng(),
      out: { a: 0, b: 0, c: 0, secrete: new Float64Array(this.nSpecies), pol: 0, align: 0, fieldSrc: new Float64Array(this.nFields),
        speed: 0, guide: 0, loadAlign: 0, noise: 0, aSum: 0 },
    };
    this._vctx = {
      v: 0, dt: this.dt, rho: new Float32Array(this.nSpecies), fiberTotal: 0, fa: 0, Tzz_over_trace: 0,
      field: new Float32Array(this.nFields), dial: this._dialVals, load: 0, aSum: 0, nCellsHere: 0, inflam: 0,
      out: { dRho: new Float64Array(this.nSpecies), loss: 0, fieldSrc: new Float64Array(this.nFields), E: 0 },
    };

    this.rules = null;
    this.scenario = null;
    this.time = 0; this.stepCount = 0;
    this.wound = null;
    this._lastDep = 0; this._lastDeg = 0;
    this._fromCache = new Map();

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
    if (overrides.seed !== undefined) this.seed = overrides.seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.scenario = scenarioKey;
    this.time = 0; this.stepCount = 0; this.wound = null;
    this._lastDep = 0; this._lastDeg = 0;
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
      if (this._cellDial >= 0) this._addCells(Math.round(+dials[this.dialKeys[this._cellDial]]));
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
    const n1 = this.nCells + 1;
    let best = 0, bestDef = -Infinity;
    for (let t = 0; t < this.nTypes; t++) {
      const deficit = this._typeFraction[t] * n1 - this._typeCount[t];
      if (deficit > bestDef) { bestDef = deficit; best = t; }
    }
    return best;
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
    const rng = this.rng;
    for (let c = 0; c < count && this.nCells > 0; c++) {
      const i = Math.floor(rng() * this.nCells), last = this.nCells - 1;
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
    if (n > this.nCells) this._addCells(n - this.nCells);
    else if (n < this.nCells) this._removeCells(this.nCells - n);
    if (this._cellDial >= 0) { this._dialVals[this._cellDial] = this.nCells; this.dials[this.dialKeys[this._cellDial]] = this.nCells; }
  }

  /** Change dials while running. Partial object keyed by dial key; unknown keys are ignored. */
  setDials(partial) {
    for (const k of Object.keys(partial)) {
      const i = this.dialIndex[k];
      if (i === undefined || partial[k] === undefined) continue;
      if (i === this._cellDial) { this._setCellCount(+partial[k]); this._countCells(); }
      else { this._dialVals[i] = +partial[k]; this.dials[k] = +partial[k]; }
    }
    return this.dials;
  }

  // -------------------------------------------------------- init.from (pre-run)

  _loadFrom(from) {
    if (this._depth >= 4) throw new Error(`init.from chain deeper than 4 (tissue '${this.tissue.key}')`);
    const key = `${from.scenario}|${from.days}|${this.seed}`;
    let S = this._fromCache.get(key);
    if (!S) {
      const pre = new TissueEngine(this.tissue, { seed: (this.seed + 1) >>> 0, overrides: this._overrides, _depth: this._depth + 1 });
      pre.reset(from.scenario);
      pre.step(Math.round(from.days / this.dt));
      const copy = (a) => Float32Array.from(a);
      S = {
        species: pre.species.map(copy),
        Txx: copy(pre.Txx), Tyy: copy(pre.Tyy), Tzz: copy(pre.Tzz), Txy: copy(pre.Txy), Txz: copy(pre.Txz), Tyz: copy(pre.Tyz),
        fx: copy(pre.fx), fy: copy(pre.fy), fz: copy(pre.fz),
        fields: pre.fields.map(copy),
        cx: pre._cx.slice(0, 3 * pre.nCells), cp: pre._cp.slice(0, 3 * pre.nCells),
        ca: pre._ca.slice(0, pre.nCells), cb: pre._cb.slice(0, pre.nCells), cc: pre._cc.slice(0, pre.nCells), ctype: pre._ctype.slice(0, pre.nCells),
        typeCount: Int32Array.from(pre._typeCount), nCells: pre.nCells,
      };
      this._fromCache.set(key, S);
    }
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
    const fields = this.fields, fieldSrc = this._fieldSrc, aSum = this._aSum, cellCount = this._cellCount;
    const cx = this._cx, cp = this._cp, ca = this._ca, cb = this._cb, cc = this._cc, ctype = this._ctype, vox = this._vox, dxs = this._dx;
    const cMin = this._typeCMin, cMax = this._typeCMax;
    const n = this.nCells, rules = this.rules;
    const load = this._loadDial >= 0 ? this._dialVals[this._loadDial] : 0;
    const loadA = P.loadExp === 2 ? load * load : Math.pow(load, P.loadExp);

    for (let f = 0; f < nF; f++) fieldSrc[f].fill(0);
    aSum.fill(0);

    // ---------------------------------------------------------- cells
    const ctx = this._cctx, out = ctx.out, cRho = ctx.rho, cField = ctx.field, secrete = out.secrete, cSrc = out.fieldSrc;
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
      let px = cp[i3], py = cp[i3 + 1], pz = cp[i3 + 2];
      let dep = 0;
      for (let s = 0; s < nS; s++) {
        const sec = secrete[s];
        if (sec <= 0) continue;
        species[s][v] += sec * dt; depTotal += sec;
        if (isFiber[s]) dep += sec * dt;
      }
      const kA = out.align * dt;
      if (dep > 0 || kA > 0) {
        const pol = out.pol < 0 ? 0 : (out.pol > 1 ? 1 : out.pol);
        const iso = (1 - pol) / 3 * dep, ani = pol * dep;
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

      // --- per-voxel accumulators
      for (let f = 0; f < nF; f++) fieldSrc[f][v] += cSrc[f];
      const as = out.aSum;
      aSum[v] += as === as ? as : a;

      // --- polarity: contact guidance toward ±f, load alignment toward ±z, persistence noise
      const fxv = fx[v], fyv = fy[v], fzv = fz[v];
      const sg = (px * fxv + py * fyv + pz * fzv) >= 0 ? 1 : -1;
      const kG = out.guide * dt * fa[v];
      px += kG * (sg * fxv - px); py += kG * (sg * fyv - py); pz += kG * (sg * fzv - pz);
      const sz = pz >= 0 ? 1 : -1, kL = out.loadAlign * dt;
      px -= kL * px; py -= kL * py; pz += kL * (sz - pz);
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
        const d0 = 2 * P.rCell, d02 = d0 * d0, kRep = P.kRep;
        cursor.set(binStart.subarray(0, NV));
        for (let i = 0; i < n; i++) binCell[cursor[vox[i]]++] = i;
        dxs.fill(0, 0, 3 * n);
        const N2 = N * N;
        for (let i = 0; i < n; i++) {
          const v = vox[i], ix = (v / N2) | 0, iy = ((v / N) | 0) % N, iz = v % N;
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
                  const j3 = 3 * j;
                  const ddx = cx[j3] - xi, ddy = cx[j3 + 1] - yi, ddz = cx[j3 + 2] - zi;
                  const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                  if (d2 >= d02 || d2 === 0) continue;
                  const d = Math.sqrt(d2);
                  const f = kRep * (d0 - d) / d * 0.5;
                  dxs[i3] -= f * ddx; dxs[i3 + 1] -= f * ddy; dxs[i3 + 2] -= f * ddz;
                  dxs[j3] += f * ddx; dxs[j3 + 1] += f * ddy; dxs[j3 + 2] += f * ddz;
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
    vctx.dt = dt; vctx.load = load;
    const kLF = P.kLoadFib * loadA * dt, eps = P.eps, eps2 = eps * eps, rhoMax = P.rhoMax, inflam = this.inflam;
    const doF = (this.stepCount % P.fEvery) === 0;
    let degTotal = 0;
    for (let v = 0; v < NV; v++) {
      let txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      let tr = txx + tyy + tzz;
      let tot0 = 0;
      for (let s = 0; s < nS; s++) { const r = species[s][v]; vRho[s] = r; if (isFiber[s]) tot0 += r; }
      vctx.v = v; vctx.fiberTotal = tot0; vctx.fa = fa[v]; vctx.Tzz_over_trace = tr > eps ? tzz / tr : 0;
      for (let f = 0; f < nF; f++) vField[f] = fields[f][v];
      vctx.aSum = aSum[v]; vctx.nCellsHere = cellCount[v]; vctx.inflam = inflam[v];
      for (let s = 0; s < nS; s++) dRho[s] = 0;
      for (let f = 0; f < nF; f++) vSrc[f] = 0;
      vout.loss = 0; vout.E = E[v];

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
          txx -= kLF * txx; tyy -= kLF * tyy; tzz += kLF * (tr - tzz);
          txy -= kLF * txy; txz -= kLF * txz; tyz -= kLF * tyz;
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

    // ------------------------------------------- diffusible fields
    this._diffuse(dt);

    this._lastDep = depTotal; this._lastDeg = degTotal;
    this.time += dt; this.stepCount++;
  }

  /** Explicit 6-neighbour diffusion with zero-flux walls, sources, bath exchange, decay, inflammation. */
  _diffuse(dt) {
    const N = this.N, NV = this.NV, h2 = this.h * this.h, N2 = N * N, Nm1 = N - 1, inflam = this.inflam;
    const hasInfl = this._inflTau > 0;
    for (let f = 0; f < this.nFields; f++) {
      const lam = Math.min(this._fD[f] * dt / h2, 1 / 6);
      const bd = this._fBathDial[f], bath = bd >= 0 ? this._dialVals[bd] : 0, face = this._fBoundary[f];
      const kBath = bd >= 0 && face === 0 ? this._fKBath[f] : 0;   // face boundaries: no bulk relaxation
      const decay = this._fDecay[f], wInf = hasInfl ? this._fInfl[f] : 0;
      const g = this.fields[f], g2 = this._fields2[f], src = this._fieldSrc[f];
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
            const ng = gv + lam * (sg - cnt * gv) + dt * (kBath * (bath - gv) + src[v] - decay * gv + wInf * inflam[v]);
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
    if (hasInfl) {
      const dec = Math.exp(-dt / this._inflTau);
      for (let v = 0; v < NV; v++) { const inf = inflam[v]; if (inf > 0) inflam[v] = inf > 1e-4 ? inf * dec : 0; }
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
      for (let s = 0; s < nS; s++) vout.dRho[s] = 0;
      for (let f = 0; f < nF; f++) vout.fieldSrc[f] = 0;
      vout.loss = 0; vout.E = this.E[v];
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
      N: this.N, L: this.L, h: this.h, time: this.time, dt: this.dt,
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
    let total = 0, fiberTot = 0;
    for (let s = 0; s < nS; s++) {
      const arr = this.species[s];
      let sum = 0;
      for (let v = 0; v < NV; v++) sum += arr[v];
      const mean = sum / NV;
      species[this.speciesKeys[s]] = mean; total += mean;
      if (this._isFiber[s]) fiberTot += mean;
    }
    for (let s = 0; s < nS; s++) fraction[this.speciesKeys[s]] = total > 1e-9 ? species[this.speciesKeys[s]] / total : 0;
    species.total = total; species.fiberTotal = fiberTot;
    const fields = {};
    for (let f = 0; f < nF; f++) {
      const arr = this.fields[f];
      let sum = 0;
      for (let v = 0; v < NV; v++) sum += arr[v];
      fields[this.fieldKeys[f]] = sum / NV;
    }
    let sA = 0, sB = 0, sC = 0;
    for (let i = 0; i < n; i++) { sA += this._ca[i]; sB += this._cb[i]; sC += this._cc[i]; }
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
      cells: { a: n > 0 ? sA / n : 0, b: n > 0 ? sB / n : 0, c: n > 0 ? sC / n : 0, n },
      fields,
      deposition, degradation,
      ratio: degradation > 1e-12 ? deposition / degradation : (deposition > 1e-12 ? Infinity : 1),
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
    species.total = total; species.fiberTotal = cnt ? sTot / cnt : 0;
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
    const a = tmRoundArray(this._ca.subarray(0, n), 3);
    return {
      t: Math.round(this.time * 1000) / 1000,
      species,
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

  /** `meta` block of the format-2 export; `extra` (e.g. { exportEveryDays }) is merged in. */
  exportMeta(extra = {}) {
    const t = this.tissue;
    return Object.assign({
      format: 2, tissue: t.key, tissueVersion: t.version, engine: ENGINE_VERSION,
      N: this.N, L: this.L, K: this.P.K, dtDays: this.dt, scenario: this.scenario,
      dials: Object.assign({}, this.dials), seed: this.seed,
      species: t.species.map((s) => ({ key: s.key, label: s.label, kind: s.kind, color: s.color })),
      cellTypes: t.cellTypes.map((c) => ({ key: c.key, label: c.label, colors: c.colors.slice(), shape: Object.assign({}, c.shape), radius: c.radius })),
    }, extra);
  }

  // ------------------------------------------------------------- scenario checks

  /**
   * Run `scenarioKey` (with its `events`) to the latest `at` of its checks and evaluate them.
   * Returns [{ check, value, ref, pass }]. opts: { seed = 7, engine } (engine: reuse an instance
   * of the same tissue, e.g. for its init.from cache).
   */
  static checkScenario(tissue, scenarioKey, opts = {}) {
    const seed = opts.seed === undefined ? 7 : opts.seed;
    const M = opts.engine || new TissueEngine(tissue, { seed });
    if (M.tissue !== tissue) throw new Error('checkScenario: engine belongs to another tissue');
    if (opts.engine && M.seed !== (seed >>> 0)) M.seed = seed >>> 0;
    M.reset(scenarioKey);
    const sc = M.scenarioDef(scenarioKey);
    const checks = sc.checks || [], events = (sc.events || []).map((e) => Object.assign({}, e));
    const days = new Set();
    let last = 0;
    for (const c of checks) {
      days.add(c.at); if (c.at > last) last = c.at;
      if (c.rel && c.rel.at !== undefined) { days.add(c.rel.at); if (c.rel.at > last) last = c.rel.at; }
    }
    for (const e of events) if (e.at > last) last = e.at;
    const stepsPerDay = Math.round(1 / M.dt);
    const rec = new Map();
    for (let d = 0; d <= last; d++) {
      for (const e of events) {
        if (e.at !== d || e.fired) continue;
        e.fired = true;
        if (e.dials) M.setDials(e.dials);
        if (e.injure) M.injure(e.injure.center || null, e.injure.radius);
      }
      if (days.has(d)) rec.set(d, M.stats());
      if (d < last) M.step(stepsPerDay);
    }
    return checks.map((check) => {
      const value = engineStatFrom(rec.get(check.at), check.stat);
      let pass, ref;
      if (check.rel) {
        const at = check.rel.at === undefined ? check.at : check.rel.at;
        ref = engineStatFrom(rec.get(at), check.rel.stat) + (check.value === undefined ? 0 : check.value);
        pass = ENGINE_OPS[check.rel.op](value, ref);
      } else {
        ref = check.value;
        pass = ENGINE_OPS[check.op](value, check.value);
      }
      return { check, value, ref, pass: !!pass };
    });
  }

  // ------------------------------------------------------------- schema

  /** Validate a tissue definition against EXTENDING.md §1. Returns an array of error strings ([] = valid). */
  static validate(t) {
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
      if (!isStr(s.label)) err.push(`species '${s.key}' label missing`);
      if (!['fiber', 'gel', 'scaffold'].includes(s.kind)) err.push(`species '${s.key}' kind must be fiber|gel|scaffold`);
      if (!isHex(s.color)) err.push(`species '${s.key}' color must be #rrggbb`);
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
    });
    if (!Array.isArray(t.cellTypes) || t.cellTypes.length === 0) err.push('cellTypes must be a non-empty array');
    else t.cellTypes.forEach((c, i) => {
      if (!isStr(c.key) || !ENGINE_IDENT.test(c.key)) err.push(`cellTypes[${i}].key invalid`);
      if (!isStr(c.label)) err.push(`cellType '${c.key}' label missing`);
      if (!Array.isArray(c.colors) || c.colors.length !== 2 || !c.colors.every(isHex)) err.push(`cellType '${c.key}' colors must be two #rrggbb`);
      if (!c.shape || !['a', 'b'].includes(c.shape.by) || !isNum(c.shape.aspectMin) || !isNum(c.shape.aspectMax)) err.push(`cellType '${c.key}' shape must be { by: 'a'|'b', aspectMin, aspectMax }`);
      if (!isNum(c.radius) || c.radius <= 0) err.push(`cellType '${c.key}' radius must be > 0`);
      if (typeof c.motile !== 'boolean') err.push(`cellType '${c.key}' motile must be boolean`);
      if (c.fraction !== undefined && (!isNum(c.fraction) || c.fraction < 0)) err.push(`cellType '${c.key}' fraction must be ≥ 0`);
      if (c.init && ((c.init.a !== undefined && !isNum(c.init.a)) || (c.init.b !== undefined && !isNum(c.init.b)) || (c.init.c !== undefined && !isNum(c.init.c)))) err.push(`cellType '${c.key}' init.a/b/c must be numbers`);
      if (c.cRange !== undefined && (!Array.isArray(c.cRange) || c.cRange.length !== 2 || !c.cRange.every(isNum) || c.cRange[0] >= c.cRange[1])) err.push(`cellType '${c.key}' cRange must be [lo, hi] with lo < hi`);
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
          if (!isNum(c.at) || c.at < 0) err.push(`${w}: at must be a day ≥ 0`);
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
        else if (!isNum(v)) err.push(`engine.${k} must be a number`);
      }
    }
    if (t.copy !== undefined && (typeof t.copy !== 'object' || t.copy === null)) err.push('copy must be an object');
    if (t.copy && t.copy.vocabulary) for (const k of ['matrix', 'cellsActive', 'cellsQuiet']) if (!isStr(t.copy.vocabulary[k])) err.push(`copy.vocabulary.${k} missing`);
    return err;
  }
}
