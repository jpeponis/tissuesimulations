/*
 * Tissue Weather — simulation core (docs/SPEC.md §1.1–1.7, §1.10).
 *
 * Pure ES module: no DOM, no `performance`, no `Math.random` (all randomness
 * comes from an injected mulberry32 PRNG seeded from the constructor), named
 * exports only, every top-level identifier prefixed `tm`/`Tissue`/`DEFAULT_`/
 * `SCENARIOS`/`mulberry32` so the single-file build can concatenate files.
 *
 * Runs in the browser and in node (`node --test tests/`, tools/run_headless.mjs).
 *
 * ---------------------------------------------------------------------------
 * PARAMETER / EQUATION CHANGES RELATIVE TO docs/SPEC.md (tuning log)
 * ---------------------------------------------------------------------------
 * The spec's constants are order-of-magnitude placeholders.  Put together as
 * written they cannot produce the scenario behaviour the spec describes (see
 * the "why" column); everything below was changed deliberately and verified
 * with tools/run_headless.mjs + tests/model.test.mjs.  All other numbers are
 * the spec's.  Reviewer items from docs/MODEL.md §4 are marked [MODEL.md #n].
 *
 *  SECRETION  s = (sBasal + sAct·α²)·(sTens + (1−sTens)·H)·(1 − rho/rhoCrowd)²
 *    sAct 0.05 → 2.5, sBasal 0.004 → 0.005.  Deposition goes into the ONE voxel
 *      the cell occupies, so the mean rate is (n/N³)·s ≈ 0.093·s at 160 cells;
 *      with the spec's s ≤ 0.054 the tissue gains ≤ 0.005 rho/d and cannot
 *      reach rho 0.6 in 60 d [MODEL.md #9].  α² (not α): collagen synthesis is
 *      strongly activation dependent; this keeps quiescent cells from slowly
 *      filling a low-growth-factor tissue.
 *    sTens 0.5 (new): relaxed cells synthesize less [MODEL.md #10; 0.5 rather
 *      than the suggested 0.3 so a soft scaffold can still be colonised].
 *    rhoCrowd 1.6, depCrowd 2 (new): crowding/feedback inhibition of synthesis.
 *      This is what lets a loaded tissue SETTLE at rho ≈ 1 instead of running
 *      to the trace clamp: with tension-suppressed MMP, degradation at the
 *      high state is lower than at the start, so a synthesis-side brake is
 *      required for a steady state.
 *  ACTIVATION  α* = tanh( gsat·(aG + aE·H) − aSoft·Esoft/(E+Esoft) ),
 *              gsat = g²/(g² + gHalf²),  H = τ²/(1+τ²),  τ = (E/Eref)(strain + κα)
 *    Growth factor GATES activation and tension potentiates it (multiplicative,
 *      Hinz) instead of the spec's additive sum: with the additive form the
 *      load term alone drives any loaded tissue to the high state, so Gext has
 *      no low state and no hysteresis is possible.
 *    tanh instead of clamp: the spec's aE + aG ≥ 1 pins α at 1.0 in every
 *      loaded scenario; tanh lets α rise and settle at ≈ 0.85–0.9.
 *    Hill-2 on g (gHill 2, gHalf 0.3 → 0.5) [MODEL.md #8] and Hill-2 on tension
 *      (nHill 2; the spec's τ/(1+τ) is Hill-1) [MODEL.md #4].  The load
 *      dependence of τ is KEPT (a pure stiffness gate would keep cells
 *      activated in unloaded stiff tissue and abolish disuse atrophy); the
 *      resulting stiffness half-point Eref/(strain+κα) ≈ 14 kPa at strain 0.6
 *      matches the 12 kPa the reviewer asked for.
 *    aE 0.8 → 0.6, aG 0.8 → 1.15 (re-scaled for the multiplicative form).
 *    kappa (undefined in the spec) → 0.12: cell contractility must be a minor
 *      part of tension or an unloaded matured tissue holds itself up.
 *    aSoft 0.2 → 0.1, Esoft 1 → 0.5 kPa, smooth instead of a step (the step
 *      sits exactly at the initial stiffness and flickers).
 *    tauAlpha 1 d → tauAlphaUp 2 d / tauAlphaDown 4 d [MODEL.md #5].
 *  MMP SOURCE per cell  mBasal·P^3 + mAct·(1−H)/(1 + (α/mAlphaHalf)²)
 *    mBasal 20, protExp 3 (new): convex dial → active-MMP map (TIMP folded into
 *      the dial: free MMP rises steeply past the TIMP level).  Makes protease
 *      0.2 vs 0.4 a 8× difference (fibrosis vs maturation) and dial > 0.55
 *      dissolve the scaffold.
 *    mAct 3.5, mAlphaHalf 0.25 (new factor): activated cells stop making MMP
 *      (TGF-β induces TIMP).  Without it the maturation start (soft, unloaded)
 *      is indistinguishable from unloading and the scaffold dissolves.
 *    kMdec 1 /d, mMin 0.02 (background protease; not in the spec).
 *  GROWTH FACTOR  dg/dt = kBath(Gext − g) + kGcell·α·H per cell + kGrel·deg + D∇²g
 *    kBath 4 /d, kGdec 0 (so g = Gext exactly without cells), kGcell 12,
 *      kGrel 2, Dg = Dm = 0.05 L²/d (the explicit-Euler limit D ≤ h²/(6dt) is
 *      enforced by clamping the diffusion number to 1/6 [MODEL.md #7]; decay
 *      length sqrt(D/kBath) ≈ 1.3 voxels).  Release ∝ α·H: latent TGF-β is
 *      activated by contractile cells on stiff matrix [MODEL.md #4, Wipff 2007].
 *      This local autocrine cloud is the memory that keeps a fibrotic tissue
 *      activated after Gext is lowered.
 *  DEGRADATION  deg = kDeg·(mMin+m)·(rhoNew + rMat·rhoMat)·(1 − kProt·strain·Tzz/rho)
 *    kDeg 0.5 (spec).  rMat 0.15 → 0.05 [MODEL.md #3; 0.05 rather than 0.02
 *      because the unloading scenario must lose > 40 % in 60 d].  kProt 0.5
 *      (new): strained aligned fibres resist proteolysis [MODEL.md #3].
 *  MATURATION  mat = kMat0·rhoNew·(kMatBase + kLox·Σ α of cells in the voxel)
 *    kMat0 1/14 (spec), kLox 2 → 12, kMatBase 0.1 (new): cross-linking needs
 *      LOX from activated cells.  With the spec's (1 + 2·α) a cell-free or
 *      quiescent gel matures into protected collagen and can never evaporate.
 *  ALIGNMENT / MOTILITY
 *    kLoadFib 0.5 → 0.06 × strain² (loadExp 2): at 0.5 the static load alone
 *      drives FA → 1 in days, independent of the cells.
 *    kLoadAlign 1.5 → 10 × strain² × H: cells align with the load only when
 *      they feel it; cells in a soft wound therefore deposit isotropic scar.
 *    kGuide 2 → 6, sigmaP 0.6 → 2.5 rad/√d (persistence ~4–6 h) [MODEL.md #2,
 *      partially: 4–6 rad/√d cannot be resolved at dt = 0.02 d].
 *    v0 0.7 L/d kept (≈ 9 µm/h; the spec's "30 µm/h" comment was wrong)
 *      [MODEL.md #1]; speed × grip factor (vFloor 0.5 + 0.5·min(1, rho/0.5)):
 *      little traction in a fresh clot.  The full Metzcar tent [MODEL.md #6]
 *      was tried and rejected: it makes cells diffuse OUT of sparse regions
 *      and a wound never refills.  kRep 0.5 (new): repulsion stiffness.
 *  STIFFNESS  kStrain 1 → 0.5 so the density advantage of fibrotic tissue is
 *      not cancelled by its lower load in E.
 *  INJURY  instantaneous bursts kept (woundG 0.6, woundM 0.8) plus an
 *      inflammation field (woundGrate 4, woundMrate 1 per day, tauInfl 5 d):
 *      with a 6 h bath exchange time the spec's bursts vanish within hours,
 *      whereas the inflammatory phase lasts days.
 *  SCENARIOS  wound dials (unspecified) = Gext 0.5, strain 0.45, protease 0.4.
 *      sandbox keeps rho 0.02 as in the spec; run_headless starts it from 0.15
 *      so "evaporation" at all-dials-zero is visible.
 *  NUMERICS  fEvery 4 (principal axis refreshed every 4 steps), matured state
 *      = 60 d of the maturation preset at dt 0.02 (≈ 0.8 s in node, cached).
 * ---------------------------------------------------------------------------
 */

export const TM_VERSION = '0.1.0';

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

export const DEFAULT_PARAMS = Object.freeze({
  // --- domain / integration (§1.1) ---
  N: 12,            // voxels per side
  L: 1,             // cube side (≈300 µm)
  dt: 0.02,         // days per step
  K: 3,             // fiber instances per voxel (render / export meta only)
  nCells: 160,
  nCellsMax: 400,   // capacity of the cell arrays
  // --- stiffness (§1.2) ---
  E0: 0.3, Escale: 20, kMat: 3, kStrain: 0.5, // kPa; E = E0 + Escale·rho²·(1 + kMat·phiMat)·(1 + kStrain·strain)
  Eref: 10,         // kPa
  rhoMax: 2,        // trace clamp
  // --- diffusible fields (§1.3) ---
  Dg: 0.05, Dm: 0.05,   // L²/day (clamped to explicit-Euler stability; decay length sqrt(D/kBath) ≈ 1.3 voxels)
  kBath: 4,             // /day, relaxation of g toward Gext (also removes autocrine excess)
  kGcell: 12,           // autocrine / latent-TGF-β activation per cell × alpha × H(tension) (Wipff 2007)
  kGrel: 2,             // g released per unit matrix degraded
  kGdec: 0,             // /day extra decay (0: bath exchange is the only sink, so g = Gext without cells)
  mBasal: 20,           // per-cell MMP source × proteaseDial^protExp
  protExp: 3,           // convex dial→active-MMP map (TIMP folded in: active MMP rises steeply past the TIMP level)
  mAct: 3.5,            // per-cell MMP source × (1 − H(tension)) × activation suppression
  mAlphaHalf: 0.25,     // activation at which cell MMP output is halved
  kMdec: 1.0,           // /day
  mMin: 0.02,           // background protease activity (always present)
  // --- cells (§1.4) ---
  kappa: 0.12,          // cell contractility as equivalent strain
  nHill: 2,             // Hill exponent on tension
  aE: 0.6, aG: 1.15, gHalf: 0.5, gHill: 2, aSoft: 0.1, Esoft: 0.5,  // gsat = g^gHill/(g^gHill + gHalf^gHill)
  tauAlphaUp: 2, tauAlphaDown: 4,  // days (α-SMA appears in 1–2 d, disappears in 2–5 d)
  sBasal: 0.005, sAct: 2.5,       // density/day per cell into its voxel (s = sBasal + sAct·alpha²)
  sTens: 0.5,           // secretion × (sTens + (1 − sTens)·H): relaxed cells synthesize less (Lambert 1992)
  rhoCrowd: 1.6,        // deposition crowding scale: × (1 − rho/rhoCrowd)^depCrowd
  polBase: 0.2, polAct: 0.6,
  kAlign: 0.6,          // /day traction realignment
  v0: 0.7,              // L/day (≈ 9 µm/h at L = 300 µm; 3D fibroblast speeds 5–30 µm/h)
  rhoStar: 0.5, vFloor: 0.5,      // grip factor vFloor + (1−vFloor)·min(1, rho/rhoStar): little traction in a fresh clot
  sigmaP: 2.5,          // rad/sqrt(day) polarity noise (persistence ~4–6 h)
  kGuide: 6, kLoadAlign: 10,      // /day (load term × strain^loadExp × H(tension))
  rCell: 0.03, kRep: 0.5,
  // --- ECM update (§1.5) ---
  kDeg: 0.5,            // /day
  rMat: 0.05,           // relative protease susceptibility of mature matrix (half-life months–years)
  kProt: 0.5,           // strained aligned fibres resist proteolysis: deg × (1 − kProt·strain·Tzz/rho)
  kMat0: 1 / 14,        // /day maturation (× (kMatBase + kLox·alphaLocal))
  kMatBase: 0.1,        // maturation without activated cells (LOX needs myofibroblasts)
  kLox: 12,             // per unit summed activation of cells in the voxel
  kLoadFib: 0.06,       // /day passive load alignment of fibers (× strain^loadExp)
  loadExp: 2,           // threshold-like strain dependence of alignment terms
  depCrowd: 2,          // exponent of the crowding factor
  // --- injury (§1.6) ---
  woundRadius: 0.25, woundG: 0.6, woundM: 0.8,   // instantaneous bursts (spec)
  woundGrate: 4, woundMrate: 1.0, tauInfl: 5,     // sustained inflammatory sources (per day) decaying with tauInfl (days)
  // --- matured-state factory (§1.7) ---
  matureDays: 60,
  matureDt: 0.02,
  fEvery: 4,            // refresh the principal axis every fEvery steps (0.08 d)
  eps: 1e-6,
});

export const SCENARIOS = Object.freeze({
  maturation: Object.freeze({
    label: 'Scaffold to tissue (maturation)',
    dials: Object.freeze({ Gext: 0.5, strain: 0.6, protease: 0.4, nCells: 160 }),
    init: Object.freeze({ rho0: 0.15, phiMat0: 0, matured: false }),
  }),
  unloading: Object.freeze({
    label: 'Unloading (disuse atrophy)',
    dials: Object.freeze({ Gext: 0.2, strain: 0.0, protease: 0.5, nCells: 160 }),
    init: Object.freeze({ matured: true }),
  }),
  fibrosis: Object.freeze({
    label: 'Fibrosis (runaway)',
    dials: Object.freeze({ Gext: 0.9, strain: 0.3, protease: 0.2, nCells: 160 }),
    init: Object.freeze({ rho0: 0.15, phiMat0: 0, matured: false }),
  }),
  wound: Object.freeze({
    label: 'Wound healing',
    dials: Object.freeze({ Gext: 0.5, strain: 0.45, protease: 0.4, nCells: 160 }),
    init: Object.freeze({ matured: true }),
    injureAt: 5, // suggested: press Injure ~5 days in (the model does not auto-injure)
  }),
  sandbox: Object.freeze({
    label: 'Empty sandbox',
    dials: Object.freeze({ Gext: 0.5, strain: 0.5, protease: 0.5, nCells: 160 }),
    init: Object.freeze({ rho0: 0.02, phiMat0: 0, matured: false }),
  }),
});

export function tmClamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/** Round a typed array into a plain array with `digits` decimals (for JSON). */
export function tmRoundArray(arr, digits) {
  const f = 10 ** digits, out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * f) / f;
  return out;
}

const tmDialKeys = ['Gext', 'strain', 'protease', 'nCells'];

export class TissueModel {
  /**
   * @param {object} params  overrides of DEFAULT_PARAMS
   * @param {number} seed    PRNG seed (uint32)
   * @param {function} rngFactory  seed -> () => uniform in [0,1)  (default mulberry32)
   */
  constructor(params = {}, seed = 20240907, rngFactory = mulberry32) {
    this.params = Object.assign({}, DEFAULT_PARAMS, params);
    this.seed = seed >>> 0;
    this._rngFactory = rngFactory;
    this.rng = rngFactory(this.seed);

    const P = this.params;
    const N = P.N, NV = N * N * N;
    this.N = N; this.NV = NV; this.h = P.L / N;

    // ECM structure tensor (6 components) + derived per-voxel fields
    this.Txx = new Float32Array(NV); this.Tyy = new Float32Array(NV); this.Tzz = new Float32Array(NV);
    this.Txy = new Float32Array(NV); this.Txz = new Float32Array(NV); this.Tyz = new Float32Array(NV);
    this.rho = new Float32Array(NV); this.rhoMat = new Float32Array(NV);
    this.fa = new Float32Array(NV);
    this.fx = new Float32Array(NV); this.fy = new Float32Array(NV); this.fz = new Float32Array(NV);
    this.g = new Float32Array(NV); this.m = new Float32Array(NV); this.E = new Float32Array(NV);
    // scratch
    this._g2 = new Float32Array(NV); this._m2 = new Float32Array(NV);
    this._srcG = new Float32Array(NV); this._srcM = new Float32Array(NV);
    this._aSum = new Float32Array(NV); this._deg = new Float32Array(NV);
    this.inflam = new Float32Array(NV); // inflammatory source strength (1 in a fresh wound, decays)

    // cells (fixed capacity, `nCells` live)
    this.cap = Math.max(P.nCellsMax, P.nCells);
    this._cx = new Float32Array(3 * this.cap);
    this._cp = new Float32Array(3 * this.cap);
    this._alpha = new Float32Array(this.cap);
    this._vox = new Int32Array(this.cap);
    this._dx = new Float32Array(3 * this.cap); // repulsion displacements
    this._binStart = new Int32Array(NV + 1); this._binCursor = new Int32Array(NV); this._binCell = new Int32Array(this.cap);
    this._views = { n: -1, cx: null, cp: null, alpha: null };

    this.nCells = 0;
    this.time = 0;
    this.stepCount = 0;
    this.scenario = null;
    this.dials = { Gext: 0.5, strain: 0.5, protease: 0.5, nCells: P.nCells };
    this.wound = null;
    this._lastDep = 0; this._lastDeg = 0; this._meanH = 0; this._meanGcell = 0;
    this._maturedCache = null;
    this._maturedMs = null;

    this.reset('maturation');
  }

  // ------------------------------------------------------------------ setup

  /** Reset to a scenario preset (key of SCENARIOS). Optional overrides:
   *  { dials: {...}, init: {rho0, phiMat0, matured}, seed } */
  reset(scenarioKey = 'maturation', overrides = {}) {
    const sc = SCENARIOS[scenarioKey];
    if (!sc) throw new Error(`unknown scenario '${scenarioKey}'`);
    if (overrides.seed !== undefined) this.seed = overrides.seed >>> 0;
    this.rng = this._rngFactory(this.seed);
    this.scenario = scenarioKey;
    this.time = 0; this.stepCount = 0; this.wound = null;
    this._lastDep = 0; this._lastDeg = 0;

    const dials = Object.assign({}, sc.dials, overrides.dials || {});
    const init = Object.assign({}, sc.init, overrides.init || {});

    if (init.matured) {
      this._loadMatured();
    } else {
      this._initUniform(init.rho0 ?? 0.15, init.phiMat0 ?? 0);
      this.nCells = 0;
      this._addCells(dials.nCells);
    }
    // apply dials (cell count adjusts by add/remove)
    this.dials.Gext = dials.Gext; this.dials.strain = dials.strain; this.dials.protease = dials.protease;
    this._setCellCount(dials.nCells);
    if (!init.matured) this.g.fill(dials.Gext);
    this._derived();
    return this;
  }

  _initUniform(rho0, phiMat0) {
    const NV = this.NV, rng = this.rng;
    for (let v = 0; v < NV; v++) {
      const r = rho0 * (1 + 0.2 * (rng() - 0.5));
      this.Txx[v] = r / 3; this.Tyy[v] = r / 3; this.Tzz[v] = r / 3;
      this.Txy[v] = 0; this.Txz[v] = 0; this.Tyz[v] = 0;
      this.rhoMat[v] = phiMat0 * r;
      // random initial principal axis (warm start for power iteration)
      let x = rng() - 0.5, y = rng() - 0.5, z = rng() - 0.5;
      const n = Math.hypot(x, y, z) || 1;
      this.fx[v] = x / n; this.fy[v] = y / n; this.fz[v] = z / n;
    }
    this.g.fill(0); this.m.fill(0);
    this._deg.fill(0); this.inflam.fill(0);
  }

  _addCells(count) {
    const rng = this.rng, L = this.params.L;
    for (let c = 0; c < count && this.nCells < this.cap; c++) {
      const i = this.nCells, i3 = 3 * i;
      this._cx[i3] = rng() * L; this._cx[i3 + 1] = rng() * L; this._cx[i3 + 2] = rng() * L;
      let px = rng() - 0.5, py = rng() - 0.5, pz = rng() - 0.5;
      const n = Math.hypot(px, py, pz) || 1;
      this._cp[i3] = px / n; this._cp[i3 + 1] = py / n; this._cp[i3 + 2] = pz / n;
      this._alpha[i] = 0.05;
      this.nCells++;
    }
  }

  _removeCells(count) {
    const rng = this.rng;
    for (let c = 0; c < count && this.nCells > 0; c++) {
      const i = Math.floor(rng() * this.nCells), last = this.nCells - 1;
      if (i !== last) {
        for (let d = 0; d < 3; d++) {
          this._cx[3 * i + d] = this._cx[3 * last + d];
          this._cp[3 * i + d] = this._cp[3 * last + d];
        }
        this._alpha[i] = this._alpha[last];
      }
      this.nCells--;
    }
  }

  _setCellCount(n) {
    n = Math.max(0, Math.min(this.cap, Math.round(n)));
    if (n > this.nCells) this._addCells(n - this.nCells);
    else if (n < this.nCells) this._removeCells(this.nCells - n);
    this.dials.nCells = this.nCells;
  }

  /** Change dials while running. Partial object with any of Gext, strain, protease, nCells. */
  setDials(partial) {
    for (const k of tmDialKeys) {
      if (partial[k] === undefined) continue;
      if (k === 'nCells') this._setCellCount(partial[k]);
      else this.dials[k] = +partial[k];
    }
    return this.dials;
  }

  // -------------------------------------------------------- matured state

  /**
   * Snapshot of the tissue after running the maturation scenario for
   * params.matureDays with the same params/seed. Computed once and cached.
   * Returns { Txx..Tyz, rhoMat, fx, fy, fz, g, m, cx, cp, alpha, nCells, time }.
   */
  maturedState() {
    if (this._maturedCache) return this._maturedCache;
    const P = this.params;
    const pre = new TissueModel(Object.assign({}, P, { dt: P.matureDt }), (this.seed + 1) >>> 0, this._rngFactory);
    pre.reset('maturation');
    const steps = Math.round(P.matureDays / P.matureDt);
    pre.step(steps);
    const copy = (a) => Float32Array.from(a);
    this._maturedCache = {
      Txx: copy(pre.Txx), Tyy: copy(pre.Tyy), Tzz: copy(pre.Tzz),
      Txy: copy(pre.Txy), Txz: copy(pre.Txz), Tyz: copy(pre.Tyz),
      rhoMat: copy(pre.rhoMat), fx: copy(pre.fx), fy: copy(pre.fy), fz: copy(pre.fz),
      g: copy(pre.g), m: copy(pre.m), deg: copy(pre._deg),
      cx: pre._cx.slice(0, 3 * pre.nCells), cp: pre._cp.slice(0, 3 * pre.nCells),
      alpha: pre._alpha.slice(0, pre.nCells), nCells: pre.nCells, time: pre.time,
    };
    return this._maturedCache;
  }

  _loadMatured() {
    const S = this.maturedState();
    this.Txx.set(S.Txx); this.Tyy.set(S.Tyy); this.Tzz.set(S.Tzz);
    this.Txy.set(S.Txy); this.Txz.set(S.Txz); this.Tyz.set(S.Tyz);
    this.rhoMat.set(S.rhoMat); this.fx.set(S.fx); this.fy.set(S.fy); this.fz.set(S.fz);
    this.g.set(S.g); this.m.set(S.m); this._deg.set(S.deg);
    this._cx.set(S.cx); this._cp.set(S.cp); this._alpha.set(S.alpha);
    this.nCells = S.nCells; this.inflam.fill(0);
  }

  // -------------------------------------------------------------- injury

  /** Spherical wound (§1.6): zero T and rhoMat, g += woundG, m += woundM inside. */
  injure(center = null, radius = this.params.woundRadius) {
    const P = this.params, N = this.N, h = this.h, L = P.L;
    let cx, cy, cz;
    if (center) { [cx, cy, cz] = center; }
    else {
      // random spot, kept away from the walls so most of the sphere is inside
      const margin = Math.min(radius, L / 2);
      cx = margin + this.rng() * (L - 2 * margin);
      cy = margin + this.rng() * (L - 2 * margin);
      cz = margin + this.rng() * (L - 2 * margin);
    }
    const r2 = radius * radius;
    let count = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * h - cx;
      for (let j = 0; j < N; j++) {
        const y = (j + 0.5) * h - cy;
        for (let k = 0; k < N; k++) {
          const z = (k + 0.5) * h - cz;
          if (x * x + y * y + z * z > r2) continue;
          const v = (i * N + j) * N + k;
          this.Txx[v] = 0; this.Tyy[v] = 0; this.Tzz[v] = 0;
          this.Txy[v] = 0; this.Txz[v] = 0; this.Tyz[v] = 0;
          this.rhoMat[v] = 0;
          this.g[v] += P.woundG; this.m[v] += P.woundM; this.inflam[v] = 1;
          count++;
        }
      }
    }
    this.wound = { center: [cx, cy, cz], radius, time: this.time, nVox: count };
    this._derived();
    return this.wound;
  }

  // ---------------------------------------------------------------- step

  step(nSteps = 1) {
    for (let s = 0; s < nSteps; s++) this._step();
    return this;
  }

  _gauss() { // ~N(0,1): sum of three uniforms, variance 3/12 -> scaled
    const r = this.rng;
    return (r() + r() + r() - 1.5) * 2;
  }

  _step() {
    const P = this.params, dt = P.dt, N = this.N, NV = this.NV, L = P.L;
    const invh = 1 / this.h, Nm1 = N - 1;
    const strain = this.dials.strain, protease = this.dials.protease, Gext = this.dials.Gext;
    const Txx = this.Txx, Tyy = this.Tyy, Tzz = this.Tzz, Txy = this.Txy, Txz = this.Txz, Tyz = this.Tyz;
    const rho = this.rho, rhoMat = this.rhoMat, fa = this.fa, fx = this.fx, fy = this.fy, fz = this.fz;
    const g = this.g, E = this.E;
    const srcG = this._srcG, srcM = this._srcM, aSum = this._aSum, deg = this._deg;
    const cx = this._cx, cp = this._cp, alpha = this._alpha, vox = this._vox, dxs = this._dx;
    const n = this.nCells;

    srcG.fill(0); srcM.fill(0); aSum.fill(0);

    // ---------------------------------------------------------- cells (§1.4)
    const invEref = 1 / P.Eref, aUp = Math.min(1, dt / P.tauAlphaUp), aDown = Math.min(1, dt / P.tauAlphaDown);
    const gHalfN = Math.pow(P.gHalf, P.gHill), gHill2 = P.gHill === 2;
    const invRhoStar = 1 / P.rhoStar, vFloor = P.vFloor, sTens = P.sTens;
    const strainA = P.loadExp === 2 ? strain * strain : Math.pow(strain, P.loadExp);
    const sigN = P.sigmaP * Math.sqrt(dt), kLoadP = P.kLoadAlign * strainA * dt;
    const invMA2 = 1 / (P.mAlphaHalf * P.mAlphaHalf), rhoCrowdInv = 1 / P.rhoCrowd;
    const mBasalP = P.mBasal * (P.protExp === 2 ? protease * protease : Math.pow(protease, P.protExp));
    const hill2 = P.nHill === 2, crowd2 = P.depCrowd === 2, doCrowd = P.depCrowd > 0;
    const kappa = P.kappa, aE = P.aE, aG = P.aG, aSoft = P.aSoft, Esoft = P.Esoft;
    const sBasal = P.sBasal, sAct = P.sAct, polBase = P.polBase, polAct = P.polAct, kAlignP = P.kAlign * dt;
    const kGcell = P.kGcell, mAct = P.mAct, kGuideP = P.kGuide * dt, v0 = P.v0;
    let depTotal = 0, sumH = 0, sumGc = 0;

    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      const x = cx[i3], y = cx[i3 + 1], z = cx[i3 + 2];
      let ix = (x * invh) | 0, iy = (y * invh) | 0, iz = (z * invh) | 0;
      if (ix > Nm1) ix = Nm1; if (iy > Nm1) iy = Nm1; if (iz > Nm1) iz = Nm1;
      const v = (ix * N + iy) * N + iz;

      const Ev = E[v], rv = rho[v], gv = g[v];
      let a = alpha[i];

      // --- tension (stiffness × load) and activation
      const tau = Ev * invEref * (strain + kappa * a);
      const tauN = hill2 ? tau * tau : Math.pow(tau, P.nHill);
      const H = tauN / (1 + tauN);
      const gN = gHill2 ? gv * gv : Math.pow(gv, P.gHill);
      const gsat = gN / (gN + gHalfN);
      sumH += H; sumGc += gv;
      const soft = aSoft * Esoft / (Ev + Esoft);
      // TGF-β gates activation, tension potentiates it (Hinz): alphaStar = tanh(gsat·(aG + aE·H) − soft)
      let aStar = gsat * (aG + aE * H) - soft;
      aStar = aStar <= 0 ? 0 : Math.tanh(aStar); // soft saturation: settles, never pins at 1
      a += (aStar - a) * (aStar > a ? aUp : aDown);
      alpha[i] = a;

      // --- secretion into the voxel (oriented); synthesis is activation- and tension-dependent, crowding-limited
      let px = cp[i3], py = cp[i3 + 1], pz = cp[i3 + 2];
      let s = (sBasal + sAct * a * a) * (sTens + (1 - sTens) * H);
      if (doCrowd) {
        const q = 1 - rv * rhoCrowdInv;
        s *= q <= 0 ? 0 : (crowd2 ? q * q : Math.pow(q, P.depCrowd));
      }
      depTotal += s;
      const pol = polBase + polAct * a;
      const iso = (1 - pol) / 3 * s * dt, ani = pol * s * dt;
      let txx = Txx[v] + iso + ani * px * px, tyy = Tyy[v] + iso + ani * py * py, tzz = Tzz[v] + iso + ani * pz * pz;
      let txy = Txy[v] + ani * px * py, txz = Txz[v] + ani * px * pz, tyz = Tyz[v] + ani * py * pz;

      // --- traction realignment toward rho p pᵀ (trace-preserving)
      const kA = kAlignP * a;
      if (kA > 0) {
        const tr = txx + tyy + tzz;
        txx += kA * (tr * px * px - txx); tyy += kA * (tr * py * py - tyy); tzz += kA * (tr * pz * pz - tzz);
        txy += kA * (tr * px * py - txy); txz += kA * (tr * px * pz - txz); tyz += kA * (tr * py * pz - tyz);
      }
      Txx[v] = txx; Tyy[v] = tyy; Tzz[v] = tzz; Txy[v] = txy; Txz[v] = txz; Tyz[v] = tyz;

      // --- sources for the diffusible fields (§1.3)
      srcG[v] += kGcell * a * H; // autocrine / latent TGF-β activation by contractile cells on stiff matrix
      srcM[v] += mBasalP + mAct * (1 - H) / (1 + a * a * invMA2);
      aSum[v] += a;

      // --- polarity: contact guidance toward ±f, load alignment toward ±z, persistence noise
      const fxv = fx[v], fyv = fy[v], fzv = fz[v];
      const sg = (px * fxv + py * fyv + pz * fzv) >= 0 ? 1 : -1;
      const kG = kGuideP * fa[v];
      px += kG * (sg * fxv - px); py += kG * (sg * fyv - py); pz += kG * (sg * fzv - pz);
      const sz = pz >= 0 ? 1 : -1, kL = kLoadP * H; // cells align with the load only when they feel the tension
      px -= kL * px; py -= kL * py; pz += kL * (sz - pz);
      px += sigN * this._gauss(); py += sigN * this._gauss(); pz += sigN * this._gauss();
      let pn = Math.sqrt(px * px + py * py + pz * pz);
      if (pn < 1e-9) { px = 0; py = 0; pz = 1; pn = 1; }
      px /= pn; py /= pn; pz /= pn;
      cp[i3] = px; cp[i3 + 1] = py; cp[i3 + 2] = pz;

      // --- migration (§1.4): slower when activated or embedded; slow in near-empty matrix (nothing to grip)
      let grip = rv * invRhoStar; if (grip > 1) grip = 1;
      const speed = v0 * (1 - 0.6 * a) * (1 - 0.5 * rv / (rv + 0.5)) * (vFloor + (1 - vFloor) * grip);
      cx[i3] = x + speed * px * dt; cx[i3 + 1] = y + speed * py * dt; cx[i3 + 2] = z + speed * pz * dt;
    }

    // --- soft repulsion between cells closer than 2 rCell, via voxel binning
    //     (2 rCell = 0.06 L < h, so partners are in the same or an adjacent voxel: 27 bins per cell)
    if (n > 1) {
      const d0 = 2 * P.rCell, d02 = d0 * d0, kRep = P.kRep;
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
      for (let v = 0; v < NV; v++) binStart[v + 1] += binStart[v];
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

    // ------------------------------------------------------- ECM per voxel (§1.5) + derived fields (§1.2)
    const m = this.m;
    const kLF = P.kLoadFib * strainA * dt, kDeg = P.kDeg, rMat = P.rMat, mMin = P.mMin, kProtS = P.kProt * strain;
    const kMat0 = P.kMat0, kLox = P.kLox, kMatBase = P.kMatBase, eps = P.eps, eps2 = eps * eps, rhoMax = P.rhoMax;
    const strainFac = 1 + P.kStrain * strain, E0 = P.E0, Escale = P.Escale, kMatE = P.kMat;
    const doF = (this.stepCount % P.fEvery) === 0; // principal axis refresh (warm-started power iteration)
    let degTotal = 0;
    for (let v = 0; v < NV; v++) {
      let txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      let tr = txx + tyy + tzz;
      let rm = rhoMat[v];
      if (rm > tr) rm = tr; if (rm < 0) rm = 0;
      let dv = 0;
      if (tr > eps) {
        const rhoNew = tr - rm;
        const mEff = mMin + m[v];
        // degradation: new matrix is vulnerable, mature is protected (rMat), strained aligned fibres are shielded
        dv = kDeg * mEff * (rhoNew + rMat * rm) * (1 - kProtS * tzz / tr);
        let fac = 1 - (dv / tr) * dt;
        if (fac < 0) fac = 0;
        txx *= fac; tyy *= fac; tzz *= fac; txy *= fac; txz *= fac; tyz *= fac;
        // maturation of new matrix (LOX from activated cells in the voxel), proteolysis of mature matrix
        const mat = kMat0 * rhoNew * (kMatBase + kLox * aSum[v]);
        rm += (mat - kDeg * mEff * rMat * rm) * dt;
        tr *= fac;
        // passive load alignment toward z (trace-preserving)
        if (kLF > 0) {
          txx -= kLF * txx; tyy -= kLF * tyy; tzz += kLF * (tr - tzz);
          txy -= kLF * txy; txz -= kLF * txz; tyz -= kLF * tyz;
        }
        // trace clamp
        if (tr > rhoMax) {
          const sc = rhoMax / tr;
          txx *= sc; tyy *= sc; tzz *= sc; txy *= sc; txz *= sc; tyz *= sc; tr = rhoMax;
        }
        // PSD guard (cheap): non-negative diagonal, |Tij| ≤ sqrt(Tii Tjj)
        if (txx < 0) txx = 0; if (tyy < 0) tyy = 0; if (tzz < 0) tzz = 0;
        if (txy * txy > txx * tyy) txy = (txy < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tyy);
        if (txz * txz > txx * tzz) txz = (txz < 0 ? -0.999 : 0.999) * Math.sqrt(txx * tzz);
        if (tyz * tyz > tyy * tzz) tyz = (tyz < 0 ? -0.999 : 0.999) * Math.sqrt(tyy * tzz);
        if (rm > tr) rm = tr; if (rm < 0) rm = 0;
      } else {
        txx = 0; tyy = 0; tzz = 0; txy = 0; txz = 0; tyz = 0; tr = 0; rm = 0;
      }
      Txx[v] = txx; Tyy[v] = tyy; Tzz[v] = tzz; Txy[v] = txy; Txz[v] = txz; Tyz[v] = tyz;
      rhoMat[v] = rm; deg[v] = dv; degTotal += dv;

      // --- derived: rho, FA, principal axis, stiffness
      rho[v] = tr;
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
      const phi = tr > eps ? rm / tr : 0;
      E[v] = E0 + Escale * tr * tr * (1 + kMatE * phi) * strainFac;
    }

    // ------------------------------------------- diffusible fields (§1.3)
    this._diffuse(Gext, dt);

    this._lastDep = depTotal; this._lastDeg = degTotal;
    this._meanH = n > 0 ? sumH / n : 0; this._meanGcell = n > 0 ? sumGc / n : 0;
    this.time += dt; this.stepCount++;
  }

  /** Explicit 6-neighbour diffusion with zero-flux walls, sources, bath exchange, decay. */
  _diffuse(Gext, dt) {
    const P = this.params, N = this.N, h2 = this.h * this.h;
    const lamG = Math.min(P.Dg * dt / h2, 1 / 6), lamM = Math.min(P.Dm * dt / h2, 1 / 6);
    const g = this.g, m = this.m, g2 = this._g2, m2 = this._m2, srcG = this._srcG, srcM = this._srcM, deg = this._deg;
    const kBath = P.kBath, kGdec = P.kGdec, kGrel = P.kGrel, kMdec = P.kMdec;
    const inflam = this.inflam, wG = P.woundGrate, wM = P.woundMrate, inflDecay = Math.exp(-dt / P.tauInfl);
    const N2 = N * N, Nm1 = N - 1;
    for (let i = 0; i < N; i++) {
      const im = i > 0, ip = i < Nm1;
      for (let j = 0; j < N; j++) {
        const jm = j > 0, jp = j < Nm1;
        const base = (i * N + j) * N;
        for (let k = 0; k < N; k++) {
          const v = base + k;
          const gv = g[v], mv = m[v];
          let sg = 0, sm = 0, cnt = 0;
          if (im) { sg += g[v - N2]; sm += m[v - N2]; cnt++; }
          if (ip) { sg += g[v + N2]; sm += m[v + N2]; cnt++; }
          if (jm) { sg += g[v - N]; sm += m[v - N]; cnt++; }
          if (jp) { sg += g[v + N]; sm += m[v + N]; cnt++; }
          if (k > 0) { sg += g[v - 1]; sm += m[v - 1]; cnt++; }
          if (k < Nm1) { sg += g[v + 1]; sm += m[v + 1]; cnt++; }
          const inf = inflam[v];
          const ng = gv + lamG * (sg - cnt * gv) + dt * (kBath * (Gext - gv) + srcG[v] + kGrel * deg[v] - kGdec * gv + wG * inf);
          const nm = mv + lamM * (sm - cnt * mv) + dt * (srcM[v] - kMdec * mv + wM * inf);
          g2[v] = ng > 0 ? ng : 0; m2[v] = nm > 0 ? nm : 0;
          if (inf > 0) inflam[v] = inf > 1e-4 ? inf * inflDecay : 0;
        }
      }
    }
    this.g = g2; this._g2 = g; this.m = m2; this._m2 = m;
  }

  /** Full recomputation of rho, FA, principal axis (2 warm-started power iterations) and stiffness.
   *  Used after reset/injure; during stepping the same quantities are updated inside _step. */
  _derived() {
    const P = this.params, NV = this.NV;
    const Txx = this.Txx, Tyy = this.Tyy, Tzz = this.Tzz, Txy = this.Txy, Txz = this.Txz, Tyz = this.Tyz;
    const rho = this.rho, rhoMat = this.rhoMat, fa = this.fa, fx = this.fx, fy = this.fy, fz = this.fz, E = this.E;
    const strainFac = 1 + P.kStrain * this.dials.strain, eps = P.eps;
    for (let v = 0; v < NV; v++) {
      const txx = Txx[v], tyy = Tyy[v], tzz = Tzz[v], txy = Txy[v], txz = Txz[v], tyz = Tyz[v];
      const tr = txx + tyy + tzz;
      rho[v] = tr;
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
      const phi = tr > eps ? rhoMat[v] / tr : 0;
      E[v] = P.E0 + P.Escale * tr * tr * (1 + P.kMat * phi) * strainFac;
    }
  }

  // ------------------------------------------------------------- readouts

  get state() {
    const n = this.nCells, vw = this._views;
    if (vw.n !== n) {
      vw.n = n;
      vw.cx = this._cx.subarray(0, 3 * n); vw.cp = this._cp.subarray(0, 3 * n); vw.alpha = this._alpha.subarray(0, n);
    }
    return {
      N: this.N, L: this.params.L, h: this.h, time: this.time, dt: this.params.dt,
      scenario: this.scenario, dials: this.dials, nCells: n, wound: this.wound,
      Txx: this.Txx, Tyy: this.Tyy, Tzz: this.Tzz, Txy: this.Txy, Txz: this.Txz, Tyz: this.Tyz,
      rho: this.rho, rhoMat: this.rhoMat, fa: this.fa, fx: this.fx, fy: this.fy, fz: this.fz,
      g: this.g, m: this.m, E: this.E, inflam: this.inflam,
      cx: vw.cx, cp: vw.cp, alpha: vw.alpha,
    };
  }

  /** Scalar readouts (§1.8). deposition/degradation are total rates (density/day
   *  summed over voxels) for the last step — the "condensing ⟷ evaporating" gauge. */
  stats() {
    const NV = this.NV, n = this.nCells;
    const rho = this.rho, rhoMat = this.rhoMat, fa = this.fa, E = this.E, g = this.g, m = this.m, alpha = this._alpha;
    let sR = 0, sM = 0, sF = 0, sLE = 0, sE = 0, sG = 0, sMm = 0;
    let mxx = 0, myy = 0, mzz = 0, mxy = 0, mxz = 0, myz = 0;
    for (let v = 0; v < NV; v++) {
      sR += rho[v]; sM += rhoMat[v]; sF += fa[v]; sE += E[v]; sLE += Math.log10(E[v]); sG += g[v]; sMm += m[v];
      mxx += this.Txx[v]; myy += this.Tyy[v]; mzz += this.Tzz[v]; mxy += this.Txy[v]; mxz += this.Txz[v]; myz += this.Tyz[v];
    }
    let sA = 0;
    for (let i = 0; i < n; i++) sA += alpha[i];
    const meanRho = sR / NV, meanRhoMat = sM / NV;
    // FA of the mean tensor = coherence of alignment across the whole tissue
    const tr = mxx + myy + mzz, fro2 = mxx * mxx + myy * myy + mzz * mzz + 2 * (mxy * mxy + mxz * mxz + myz * myz);
    let gFA = 0;
    if (fro2 > 1e-12) { gFA = 1.5 * (fro2 - tr * tr / 3) / fro2; gFA = gFA <= 0 ? 0 : Math.sqrt(Math.min(1, gFA)); }
    return {
      t: this.time,
      meanRho, meanRhoNew: meanRho - meanRhoMat, meanRhoMat,
      phiMat: meanRho > 1e-9 ? meanRhoMat / meanRho : 0,
      meanFA: sF / NV, globalFA: gFA, meanFz: tr > 1e-9 ? mzz / tr : 1 / 3,
      meanLogE: sLE / NV, meanE: sE / NV,
      meanAlpha: n > 0 ? sA / n : 0,
      meanG: sG / NV, meanM: sMm / NV,
      deposition: this._lastDep, degradation: this._lastDeg,
      meanH: this._meanH, meanGcell: this._meanGcell,
      nCells: n,
    };
  }

  /** Mean rho / phiMat / FA inside the last wound sphere (null if no wound). */
  woundStats(wound = this.wound) {
    if (!wound) return null;
    const N = this.N, h = this.h, [cx, cy, cz] = wound.center, r2 = wound.radius * wound.radius;
    let sR = 0, sM = 0, sF = 0, sG = 0, sMm = 0, cnt = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * h - cx;
      for (let j = 0; j < N; j++) {
        const y = (j + 0.5) * h - cy;
        for (let k = 0; k < N; k++) {
          const z = (k + 0.5) * h - cz;
          if (x * x + y * y + z * z > r2) continue;
          const v = (i * N + j) * N + k;
          sR += this.rho[v]; sM += this.rhoMat[v]; sF += this.fa[v]; sG += this.g[v]; sMm += this.m[v]; cnt++;
        }
      }
    }
    // cells inside the wound
    let nc = 0, sA = 0;
    for (let i = 0; i < this.nCells; i++) {
      const x = this._cx[3 * i] - cx, y = this._cx[3 * i + 1] - cy, z = this._cx[3 * i + 2] - cz;
      if (x * x + y * y + z * z <= r2) { nc++; sA += this._alpha[i]; }
    }
    if (cnt === 0) return { meanRho: 0, phiMat: 0, meanFA: 0, meanG: 0, meanM: 0, nVox: 0, nCells: nc, meanAlpha: nc ? sA / nc : 0 };
    return { meanRho: sR / cnt, phiMat: sR > 1e-9 ? sM / sR : 0, meanFA: sF / cnt, meanG: sG / cnt, meanM: sMm / cnt, nVox: cnt,
      nCells: nc, meanAlpha: nc ? sA / nc : 0 };
  }

  /** One frame in the §1.10 export format (plain arrays, rounded). */
  snapshot() {
    const NV = this.NV, n = this.nCells;
    const phi = new Float32Array(NV);
    for (let v = 0; v < NV; v++) phi[v] = this.rho[v] > 1e-9 ? this.rhoMat[v] / this.rho[v] : 0;
    const f = new Float32Array(3 * NV);
    for (let v = 0; v < NV; v++) { f[3 * v] = this.fx[v]; f[3 * v + 1] = this.fy[v]; f[3 * v + 2] = this.fz[v]; }
    return {
      t: Math.round(this.time * 1000) / 1000,
      rho: tmRoundArray(this.rho, 3),
      fa: tmRoundArray(this.fa, 3),
      f: tmRoundArray(f, 3),
      phiMat: tmRoundArray(phi, 3),
      cells: {
        x: tmRoundArray(this._cx.subarray(0, 3 * n), 4),
        p: tmRoundArray(this._cp.subarray(0, 3 * n), 3),
        alpha: tmRoundArray(this._alpha.subarray(0, n), 3),
      },
    };
  }

  /** `meta` block of the §1.10 export. */
  exportMeta() {
    const P = this.params;
    return {
      N: this.N, L: P.L, K: P.K, dtDays: P.dt, scenario: this.scenario,
      dials: Object.assign({}, this.dials), seed: this.seed, version: TM_VERSION,
    };
  }
}
