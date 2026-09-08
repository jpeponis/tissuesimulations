/*
 * src/tissues/fibrous.js — TISSUE_FIBROUS: fibrous connective tissue
 * (fibroblasts, provisional matrix → mature collagen I). This is the v0.1
 * model (src/model.js, docs/SPEC.md §1, docs/MODEL.md) expressed as rules for
 * the generic engine; it reproduces v0.1 within the golden tolerance
 * (tests/golden/fibrous.json, seed 7).
 *
 * ---------------------------------------------------------------------------
 * HOW v0.1 MAPS ONTO THE HOOKS (and the v0.1 details that were kept on purpose)
 * ---------------------------------------------------------------------------
 *  cell()   activation  α* = tanh( gsat·(aG + aE·H) − aSoft·Esoft/(E+Esoft) ),
 *                       gsat = g²/(g²+gHalf²),  H = τ²/(1+τ²),  τ = (E/Eref)(strain + κα),
 *                       asymmetric relaxation τUp / τDown; the NEW α is used for
 *                       everything below (as in v0.1) and reported as aSum.
 *           secretion   s = (sBasal + sAct·α²)·(sTens + (1−sTens)·H)·(1 − rho/rhoCrowd)²
 *                       into the 'new' species with pol = polBase + polAct·α,
 *                       where rho is ctx.fiberTotal (the voxel total from the last
 *                       voxel pass, exactly what v0.1 read).
 *           align       kAlign·α (the engine multiplies by dt)
 *           fieldSrc    g: kGcell·α·H (latent TGF-β activation), m: mBasal·P³ + mAct·(1−H)/(1+(α/αHalf)²)
 *           polarity    guide = kGuide (× FA in the engine), loadAlign = kLoadAlign·strain²·H, noise = σP
 *           speed       v0·(1 − 0.6α)·(1 − 0.5·rho/(rho+0.5))·(vFloor + (1−vFloor)·min(1, rho/rhoStar))
 *  voxel()  with tr = ctx.fiberTotal (= new + mat), mEff = mMin + m, shield = 1 − kProt·strain·Tzz/tr:
 *             dv     = kDeg·mEff·(new + rMat·mat)·shield          total loss (v0.1 `dv`)
 *             degMat = kDeg·mEff·rMat·mat                          UNshielded (v0.1 updated rhoMat with this)
 *             mat    = kMat0·new·(kMatBase + kLox·aSum)            cross-linking needs LOX from activated cells
 *             dRho[mat] = mat − degMat ;  dRho[new] = −dv − mat + degMat ;  loss = dv ;  fieldSrc[g] = kGrel·dv
 *           v0.1 scaled the tensor by (1 − dv/tr·dt) and updated rhoMat with the unshielded
 *           mature loss, so the shield acted on the total but not on the new/mature split.
 *           That split is reproduced exactly here (deg_new_effective = dv − degMat).
 *           E is evaluated at the POST-update densities (v0.1 computed E after the ECM
 *           update of the same step): E = E0 + Escale·tr²·(1 + kMat·phi)·(1 + kStrain·strain).
 *           When tr ≤ eps: E = E0 and nothing else happens (the engine zeroes the voxel).
 *  engine   passive alignment kLoadFib·strain², trace clamp rhoMax, PSD guard, FA/axis every
 *           fEvery steps, diffusion (g: bath Gext at kBath 4; m: decay 1 /d), the inflammation
 *           field (sources g 4, m 1 per day, τ 5 d), repulsion, walls, cell count.
 *  scenarios `events` (fibrosis: Gext → 0.2 at day 45; wound: injure at day 5) encode the
 *           protocol of the headless runs and the checks; the app treats them as suggestions.
 *  readouts  the 'align' chart combines the v0.1 alignment and cell-activation charts (as the
 *           v0.1 app drew them); each series carries the verbatim v0.1 unit/meaning.
 *  copy.legend keeps the v0.1 swatch labels (fiberNew, fiberMature, cellQuiescent,
 *           cellActivated) next to the contract's fibers/cells/fields/load.
 *
 * ---------------------------------------------------------------------------
 * PARAMETER / EQUATION CHANGES RELATIVE TO docs/SPEC.md (v0.1 tuning log, kept)
 * ---------------------------------------------------------------------------
 * The spec's constants are order-of-magnitude placeholders. Put together as
 * written they cannot produce the scenario behaviour the spec describes;
 * everything below was changed deliberately and verified with
 * tools/run_headless.mjs + the tests. Reviewer items from docs/MODEL.md §4 are
 * marked [MODEL.md #n].
 *
 *  SECRETION  sAct 0.05 → 2.5, sBasal 0.004 → 0.005. Deposition goes into the ONE voxel the
 *    cell occupies, so the mean rate is (n/N³)·s ≈ 0.093·s at 160 cells; with the spec's
 *    s ≤ 0.054 the tissue cannot reach rho 0.6 in 60 d [MODEL.md #9]. α² (not α): collagen
 *    synthesis is strongly activation dependent. sTens 0.5 (new): relaxed cells synthesize
 *    less [MODEL.md #10]. rhoCrowd 1.6, depCrowd 2 (new): crowding/feedback inhibition lets a
 *    loaded tissue SETTLE at rho ≈ 1 instead of running to the trace clamp.
 *  ACTIVATION  growth factor GATES activation and tension potentiates it (multiplicative,
 *    Hinz) instead of the spec's additive sum (no low state, no hysteresis otherwise). tanh
 *    instead of clamp (α settles at ≈ 0.85–0.9 instead of pinning at 1). Hill-2 on g
 *    (gHalf 0.3 → 0.5) [MODEL.md #8] and on tension (nHill 2) [MODEL.md #4]. The load
 *    dependence of τ is KEPT (a pure stiffness gate abolishes disuse atrophy); stiffness
 *    half-point Eref/(strain+κα) ≈ 14 kPa at strain 0.6. aE 0.8 → 0.6, aG 0.8 → 1.15.
 *    kappa → 0.12: contractility must be a minor part of tension or an unloaded matured
 *    tissue holds itself up. aSoft 0.2 → 0.1, Esoft 1 → 0.5 kPa, smooth instead of a step.
 *    tauAlpha 1 d → tauAlphaUp 2 d / tauAlphaDown 4 d [MODEL.md #5].
 *  MMP SOURCE per cell  mBasal·P³ + mAct·(1−H)/(1 + (α/mAlphaHalf)²): convex dial → active
 *    MMP map (TIMP folded into the dial); activated cells stop making MMP (TGF-β induces
 *    TIMP). kMdec 1 /d (field decay), mMin 0.02 background protease.
 *  GROWTH FACTOR  dg/dt = kBath(Gext − g) + kGcell·α·H per cell + kGrel·deg + D∇²g, kBath 4 /d,
 *    kGcell 12, kGrel 2, D 0.05 L²/d [MODEL.md #7]. Release ∝ α·H: latent TGF-β is activated
 *    by contractile cells on stiff matrix [MODEL.md #4, Wipff 2007] — the autocrine memory
 *    that keeps a fibrotic tissue activated after Gext is lowered.
 *  DEGRADATION  deg = kDeg·(mMin+m)·(rhoNew + rMat·rhoMat)·(1 − kProt·strain·Tzz/rho); kDeg 0.5,
 *    rMat 0.15 → 0.05 [MODEL.md #3], kProt 0.5 (new): strained aligned fibres resist proteolysis.
 *  MATURATION  mat = kMat0·rhoNew·(kMatBase + kLox·Σα in voxel); kMat0 1/14, kLox 12, kMatBase 0.1.
 *  ALIGNMENT / MOTILITY  kLoadFib 0.5 → 0.06 × strain²; kLoadAlign 1.5 → 10 × strain² × H;
 *    kGuide 2 → 6, sigmaP 0.6 → 2.5 rad/√d [MODEL.md #2]; v0 0.7 L/d (≈ 9 µm/h) [MODEL.md #1]
 *    × grip factor; kRep 0.5. The Metzcar tent [MODEL.md #6] was tried and rejected.
 *    kAlign 0.4 → 0.6 /d (traction realignment of T toward the cell's own axis; cells reorganise
 *    a gel in hours to a day, so the spec's 0.4 was already at the slow end). It is NOT a lever on
 *    the alignment readout: at the maturation preset, FA at day 60 is 0.60 with 0.6 and 0.62 with
 *    0.4 — traction pulls fibres onto each CELL's axis, and only kLoadFib pulls them onto the load
 *    axis. Density is unchanged either way; 0.6 is the value both goldens were recorded with.
 *  STIFFNESS  kStrain 1 → 0.5.  INJURY  bursts (g 0.6, m 0.8) plus an inflammation field
 *    (g 4, m 1 per day, τ 5 d).  SCENARIOS  wound dials = Gext 0.5, strain 0.45, protease 0.4;
 *    sandbox rho 0.02.  NUMERICS  fEvery 4, matured state = 60 d of the maturation preset.
 * ---------------------------------------------------------------------------
 */

export const TISSUE_FIBROUS = {
  key: 'fibrous',
  name: 'Fibrous connective tissue',
  short: 'Fibroblasts build, align and mature collagen under load',
  version: '0.2.0',

  // ---- matrix species
  species: [
    { key: 'new', label: 'Provisional matrix', kind: 'fiber', color: '#cfe8ff',
      describe: 'fibronectin / collagen III-like, immature' },
    { key: 'mat', label: 'Mature collagen I', kind: 'fiber', color: '#e0a24a',
      describe: 'crosslinked, protease-resistant' },
  ],

  // ---- diffusible fields
  fields: [
    { key: 'g', label: 'Growth factor (TGF-β)', color: '#3fd6c4', D: 0.05, bath: 'Gext', kBath: 4, decay: 0 },
    { key: 'm', label: 'Protease (MMP)', color: '#e05bd0', D: 0.05, bath: null, kBath: 0, decay: 1.0 },
  ],

  // ---- cell types
  cellTypes: [
    { key: 'fibroblast', label: 'Fibroblast → myofibroblast',
      colors: ['#4ea3ff', '#ff7a3d'],
      shape: { by: 'a', aspectMin: 1.0, aspectMax: 2.5 },
      radius: 0.03, motile: true,
      init: { a: 0.05, b: 0 },
      stateLabels: { a: 'activation', b: null } },
  ],

  // ---- dials
  dials: [
    { key: 'Gext', label: 'Growth-factor bath', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'Humidity: how much vapor is available to condense.',
      biology: 'TGF-β-like signal in the medium. It pushes fibroblasts to activate and lay down more collagen.',
      watch: 'Cells turn orange as they activate, then the flux bar tips toward condensing a day or two later.' },
    { key: 'strain', label: 'Mechanical load', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2', role: 'load',
      metaphor: 'Pressure: a steady push that shapes the cloud.',
      biology: 'Static stretch along the vertical axis, as a 0–1 load index — not engineering strain (a real tissue tears well below 100 % stretch; 1 here means "as loaded as this lesson goes"). Cells feel more tension, and fibers and cells line up with it.',
      watch: 'Fibers swing toward the arrows and the alignment trace rises; stiffness jumps at once, activation follows over days.' },
    { key: 'protease', label: 'Protease activity', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'Temperature: heat turns droplets back into vapor.',
      biology: 'Balance of matrix-cutting enzymes (MMPs) against their inhibitors (TIMPs). It scales the enzyme cells make on top of a background that is always there, so at 0 the matrix is still being cut — slowly — and under-tensioned cells add more of their own.',
      watch: 'Flux bar leans toward evaporating as you raise it. Pale new fibers thin first; amber mature ones resist. Switch on the protease haze.' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount',
      metaphor: 'Condensation nuclei: droplets need something to form on.',
      biology: 'Seeding density. Each cell builds and digests matrix, so more cells amplify whichever way the balance leans.',
      watch: 'Few cells: the matrix barely changes for weeks. Many cells: the cube fills in faster, and so does breakdown.' },
  ],

  // ---- scenarios (ordered as in the panel)
  scenarios: [
    { key: 'maturation', title: 'Scaffold to tissue',
      goal: 'Watch a loose provisional scaffold turn into dense, aligned, mature tissue while the cells inside it change too.',
      steps: [
        'Press Play and let about four weeks pass (the Weeks speed preset, or +7 days four times).',
        'Watch the fiber colour and the alignment trace, then check stiffness.',
        'Pause and note which changed first: density, alignment, or maturity.',
      ],
      question: 'Stiffness and activation both rise. Which one is driving the other, and how would you test that with the dials?',
      expect: 'Density climbs, fibers swing toward the load arrows and turn amber over four to eight weeks, the stiffness trace climbs steadily, and cells shift from blue toward orange.',
      dials: { Gext: 0.5, strain: 0.6, protease: 0.4, nCells: 160 },
      init: { species: { new: 0.15, mat: 0 }, jitter: 0.2 },
      checks: [
        { at: 0, stat: 'species.total', op: 'between', value: [0.13, 0.17] },
        { at: 60, stat: 'species.total', op: 'gt', value: 0.6 },
        { at: 60, stat: 'fa', op: 'gt', value: 0.45 },
        { at: 60, stat: 'fz', op: 'gt', value: 0.5 },
        { at: 60, stat: 'species.mat.fraction', op: 'gt', value: 0.5 },
        { at: 60, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'gt' }, value: 1 },
        { at: 60, stat: 'cells.a', op: 'gt', value: 0.5 },
        { at: 60, stat: 'cells.a', rel: { stat: 'cells.a', at: 0, op: 'gt' }, value: 0.3 },
        { at: 90, stat: 'cells.a', op: 'lt', value: 0.97 },
        { at: 90, stat: 'cells.a', rel: { stat: 'cells.a', at: 45, op: 'lt' }, value: 0.08 },
        { at: 90, stat: 'cells.a', rel: { stat: 'cells.a', at: 45, op: 'gt' }, value: -0.08 },
      ] },
    { key: 'unloading', title: 'Unloading',
      goal: 'Take a mature tissue off load and out of its growth-factor bath, and watch a matrix that took weeks to build come apart.',
      steps: [
        'Note that two dials moved at once: load is at 0 and the bath has dropped from 0.5 to 0.2. Press Play.',
        'Watch the flux bar and the cell colour during the first few days.',
        'Run for six weeks, then test the dials one at a time: put the load back at 0.6, or the bath back at 0.5, and reset.',
      ],
      question: 'Two things were taken away at once. Which one causes the atrophy — try each alone and watch the density trace, not just the colour.',
      expect: 'Cells fade back toward blue within days, the flux bar tips to evaporating, density and alignment fall over weeks, and amber mature fibers outlast the pale new ones. Take away only the load and the story is different: alignment decays, but the density holds and the cells stay mostly switched on.',
      dials: { Gext: 0.2, strain: 0.0, protease: 0.5, nCells: 160 },
      init: { from: { scenario: 'maturation', days: 60 } },
      checks: [
        { at: 0, stat: 'species.total', op: 'gt', value: 0.6 },
        { at: 60, stat: 'species.total', op: 'lt', value: 0.6 },
        { at: 60, stat: 'species.total', rel: { stat: 'species.total', at: 0, op: 'lt' }, value: -0.4 },
        { at: 60, stat: 'cells.a', op: 'lt', value: 0.3 },
        { at: 60, stat: 'fa', rel: { stat: 'fa', at: 0, op: 'lt' }, value: -0.1 },
        { at: 60, stat: 'species.mat.fraction', rel: { stat: 'species.mat.fraction', at: 0, op: 'gt' }, value: 0.05 },
        { at: 60, stat: 'fields.m', rel: { stat: 'fields.m', at: 0, op: 'gt' } },
        { at: 10, stat: 'ratio', op: 'lt', value: 0.87 },
      ] },
    { key: 'fibrosis', title: 'Fibrosis',
      goal: 'Push the growth-factor bath high and find out whether turning it back down undoes what it started.',
      steps: [
        'Press Play with the bath at 0.9 and run for four weeks.',
        'Drop the bath to 0.2 without pausing and keep running.',
        'Wait another four weeks and compare stiffness and activation with where they started.',
      ],
      question: 'You returned the bath to its starting value, yet the growth-factor haze stays thick. Where is that growth factor coming from, and what would you turn down to break the loop?',
      expect: 'Dense, stiff, poorly aligned matrix by week four. After you lower the bath, activation dips a little and settles back; stiffness does not dip at all but keeps climbing. The tissue does not retrace its path.',
      dials: { Gext: 0.9, strain: 0.3, protease: 0.2, nCells: 160 },
      init: { species: { new: 0.15, mat: 0 }, jitter: 0.2 },
      events: [{ at: 45, dials: { Gext: 0.2 } }],
      checks: [
        { at: 45, stat: 'species.total', op: 'gt', value: 0.9 },
        { at: 90, stat: 'species.total', rel: { stat: 'species.total', at: 45, op: 'gt' }, value: -0.1 },
        { at: 90, stat: 'species.total', op: 'gt', value: 1.0 },
        { at: 90, stat: 'logE', op: 'gt', value: 2.0 },
        { at: 90, stat: 'fa', op: 'lt', value: 0.5 },
        { at: 90, stat: 'cells.a', op: 'gt', value: 0.5 },
        { at: 90, stat: 'fields.g', op: 'gt', value: 0.3 },
      ] },
    { key: 'wound', title: 'Wound healing',
      goal: 'Injure a mature tissue and follow the repair from inflammatory burst to scar.',
      steps: [
        'Press Play, then click Injure and find the hole — it is outlined by a wire sphere.',
        'Switch on the growth-factor and protease layers and watch the wound for a week.',
        'Compare fiber direction inside and outside the hole at three weeks, then keep running to eight and watch the gap close.',
      ],
      question: 'By eight weeks the patch has nearly caught up with its neighbours here, which real scars never do. Which of the things that keep a scar a scar is this model missing?',
      expect: 'A teal and magenta flare fills the hole; the cells already there dim slightly and keep building where they stand (nothing swims in). Pale tangled fibers appear within days: three weeks after the injury the patch is still a tangle against its aligned neighbours, and by eight weeks it has almost caught them up.',
      dials: { Gext: 0.5, strain: 0.45, protease: 0.4, nCells: 160 },
      init: { from: { scenario: 'maturation', days: 60 } },
      events: [{ at: 5, injure: { center: [0.5, 0.5, 0.5] } }],
      checks: [
        { at: 5, stat: 'species.total', rel: { stat: 'species.total', at: 4, op: 'lt' }, value: -0.03 },
        { at: 5, stat: 'fa', rel: { stat: 'fa', at: 4, op: 'lt' }, value: -0.01 },
        { at: 5, stat: 'fields.g', rel: { stat: 'fields.g', at: 4, op: 'gt' } },
        { at: 5, stat: 'fields.m', rel: { stat: 'fields.m', at: 4, op: 'gt' } },
        { at: 26, stat: 'species.total', op: 'gt', value: 0.9 },
        { at: 90, stat: 'fa', rel: { stat: 'fa', at: 5, op: 'gt' } },
        { at: 90, stat: 'fa', op: 'lt', value: 0.62 },
      ] },
    { key: 'sandbox', title: 'Sandbox',
      goal: 'Start from almost nothing and find a set of dials that grows a tissue you would be willing to implant.',
      steps: [
        'Choose dial settings and predict, out loud, which way the flux bar will tip.',
        'Press Play and check your prediction after one simulated week.',
        'Change one dial at a time and find a setting where the flux bar sits near zero.',
      ],
      question: 'When the flux bar sits at zero, is the tissue idle or busy, and which readout would tell you?',
      expect: 'There is no single right answer. You should be able to find settings that condense, settings that evaporate, and at least one steady balance that still shows active turnover.',
      dials: { Gext: 0.5, strain: 0.5, protease: 0.5, nCells: 160 },
      init: { species: { new: 0.02, mat: 0 }, jitter: 0.2 },
      checks: [
        { at: 0, stat: 'species.total', op: 'between', value: [0.015, 0.025] },
        { at: 0, stat: 'cells.a', op: 'between', value: [0.04, 0.06] },
        { at: 30, stat: 'species.total', op: 'lt', value: 0.5 },
      ] },
  ],

  // ---- readouts
  readouts: [
    { key: 'density', label: 'Matrix density', unit: 'relative (1 ≈ dense mature tissue)',
      meaning: 'Total fiber mass per volume, split into pale new matrix and amber mature crosslinked matrix.',
      type: 'stack', domain: [0, 1],
      series: [{ stat: 'species.new', label: 'new matrix', color: '#3f97dc' }, { stat: 'species.mat', label: 'mature collagen', color: '#c4822a' }] },
    { key: 'align', label: 'Alignment & activation', unit: '0–1',
      meaning: 'How strongly the tissue as a whole shares one fiber direction: 0 is a random tangle, 1 is a perfectly parallel bundle. The faint trace is the same measure inside single voxels, which stays high even when neighbouring voxels point different ways.',
      type: 'lines', domain: [0, 1],
      series: [
        { stat: 'globalFA', label: 'alignment (whole tissue)', color: '#8f7ae0', unit: '0–1 (anisotropy of the summed tensor)',
          meaning: 'How strongly the WHOLE cube shares one fiber direction: 0 is a random tangle, 1 is a perfectly parallel bundle.' },
        { stat: 'fa', label: 'local anisotropy', color: '#c3b6f2', unit: '0–1 (mean per-voxel fractional anisotropy)',
          meaning: 'The same measure taken inside each voxel and averaged. A tissue of small aligned patches pointing every which way scores high here and low on the whole-tissue trace.' },
        { stat: 'cells.a', label: 'cell activation', color: '#e0602a', unit: '0–1 (mean over cells)',
          meaning: 'How far cells have shifted from quiet fibroblast toward contractile, collagen-pumping myofibroblast.' },
      ] },
    { key: 'stiff', label: 'Stiffness', unit: 'kPa (log scale; geometric mean)',
      meaning: 'How hard the matrix resists stretching, as the geometric mean over the voxels. Rises with density, maturity and load; cells sense it and respond. A matured tissue lands near 80 kPa and a fibrotic one above 140 — hypertrophic-scar country, not normal dermis.',
      type: 'log', domain: [-1, 2.5],
      series: [{ stat: 'logE', label: 'stiffness', color: '#8fb8d8' }] },
    { key: 'flux', label: 'Matrix flux', unit: 'density per day',
      meaning: 'Deposition against degradation right now. The bar leans toward condensing when building wins and evaporating when breakdown wins.',
      type: 'flux' },
  ],

  // ---- tissue-specific copy
  copy: {
    intro: {
      tagline: 'A cloud of matrix and the cells that make it, in dynamic equilibrium.',
      paragraphs: [
        'You are looking at a cube of tissue about a third of a millimetre across. The rods are bundles of extracellular matrix fibers: pale blue when freshly laid down, amber once crosslinked and mature. The small bodies among them are fibroblasts. Blue ones are resting; orange ones have activated into contractile, collagen-producing myofibroblasts and stretch into spindles.',
        'The four dials are the weather. Growth-factor bath is humidity: the signal available to drive cells. Load is pressure: a steady stretch along the arrows. Protease is temperature: how fast matrix breaks back down. Cell number is the supply of condensation nuclei. Three act only through the cells; load also pulls on the fibers directly.',
        'Dynamic reciprocity, a phrase from Bissell, Hall and Parry in 1982, means the conversation runs both ways. Cells build and digest the matrix; the matrix, through its stiffness, alignment and stored growth factor, tells the cells what to become. Turn a dial and you nudge that loop. Sometimes it settles back; sometimes, as in fibrosis, it locks in.',
      ],
    },
    metaphorBreaks: [
      { claim: 'A cloud reshapes itself in seconds when the weather changes.',
        reality: 'Matrix turnover takes weeks in a dish and years in adult tissue. Cells respond to a dial within a day; fibers follow much later.' },
      { claim: 'Droplets and vapor are the same water; condensation can always be reversed by evaporation.',
        reality: 'Crosslinked collagen resists proteases and does not become provisional matrix again. Fibrosis keeps its shape after the growth factor is gone: hysteresis.' },
      { claim: 'Droplets are passive; the weather acts on them and they simply obey.',
        reality: 'Cells rewrite their own rules. A stiffer matrix activates them, and activated cells build stiffer matrix. That loop is the reciprocity.' },
      { claim: 'Humidity, pressure and temperature are set from outside; the cloud cannot change its own weather.',
        reality: 'Activated cells pulling on stiff matrix release growth factor themselves, and that is what keeps a fibrotic tissue switched on after you turn the bath down: it is making its own humidity. Digesting matrix frees a little more, but next to the cells\' own output that term is a rounding error.' },
    ],
    legend: {
      fibers: 'Fibers: pale blue when new, amber once mature and crosslinked. Thicker rods mean denser matrix; rods that share a direction mean aligned matrix.',
      fiberNew: 'New matrix (provisional, collagen III-like)',
      fiberMature: 'Mature matrix (crosslinked collagen I)',
      cells: 'Cells: blue and round when quiet, orange and spindle-shaped when activated into myofibroblasts.',
      cellQuiescent: 'Quiescent fibroblast',
      cellActivated: 'Activated myofibroblast',
      fields: {
        g: 'Teal haze: growth factor (TGF-β-like). Denser haze, stronger signal. Off by default; toggle it on.',
        m: 'Magenta haze: protease (MMP) activity. Where it is thick, matrix is being cut. Off by default; toggle it on.',
      },
      load: 'Translucent arrows on the top and bottom faces: mechanical load along the vertical axis. Longer arrows, more stretch.',
    },
    vocabulary: {
      matrix: 'collagen',
      cellsActive: 'activated cells are pumping out collagen',
      cellsQuiet: 'the cells are quiet',
    },
  },

  // ---- injury
  injury: {
    radius: 0.25, clearSpecies: ['new', 'mat'], fieldBurst: { g: 0.6, m: 0.8 },
    inflammation: { sources: { g: 4, m: 1 }, tau: 5 },
  },

  // ---- engine numerics (v0.1 values)
  engine: { N: 12, dt: 0.02, rhoMax: 2, kLoadFib: 0.06, loadExp: 2, fEvery: 4, rCell: 0.03, kRep: 0.5, trace: 'fiber' },

  // ---- tissue parameters (v0.1 DEFAULT_PARAMS minus what moved to engine / fields / injury)
  params: {
    // stiffness: E = E0 + Escale·rho²·(1 + kMat·phiMat)·(1 + kStrain·strain)   [kPa]
    E0: 0.3, Escale: 20, kMat: 3, kStrain: 0.5, Eref: 10,
    // field sources
    kGcell: 12,           // autocrine / latent-TGF-β activation per cell × α × H(tension)
    kGrel: 2,             // g released per unit matrix degraded
    mBasal: 20,           // per-cell MMP source × proteaseDial^protExp
    protExp: 3,
    mAct: 3.5,            // per-cell MMP source × (1 − H) × activation suppression
    mAlphaHalf: 0.25,
    mMin: 0.02,           // background protease activity (always present)
    // cells
    kappa: 0.12,          // cell contractility as equivalent strain
    nHill: 2,             // Hill exponent on tension
    aE: 0.6, aG: 1.15, gHalf: 0.5, gHill: 2, aSoft: 0.1, Esoft: 0.5,
    tauAlphaUp: 2, tauAlphaDown: 4,
    sBasal: 0.005, sAct: 2.5, sTens: 0.5, rhoCrowd: 1.6, depCrowd: 2,
    polBase: 0.2, polAct: 0.6,
    kAlign: 0.6,          // /day traction realignment
    v0: 0.7,              // L/day
    rhoStar: 0.5, vFloor: 0.5,
    sigmaP: 2.5,          // rad/√day polarity noise
    kGuide: 6, kLoadAlign: 10,
    // ECM
    kDeg: 0.5, rMat: 0.05, kProt: 0.5,
    kMat0: 1 / 14, kMatBase: 0.1, kLox: 12,
    eps: 1e-6,
  },

  // ---- the rules
  makeRules(engine, p) {
    const iNew = engine.speciesIndex.new, iMat = engine.speciesIndex.mat;
    const iG = engine.fieldIndex.g, iM = engine.fieldIndex.m;
    const dStrain = engine.dialIndex.strain, dProt = engine.dialIndex.protease;
    // pre-resolved constants
    const invEref = 1 / p.Eref, kappa = p.kappa, aE = p.aE, aG = p.aG, aSoft = p.aSoft, Esoft = p.Esoft;
    const gHalfN = Math.pow(p.gHalf, p.gHill), gHill2 = p.gHill === 2, hill2 = p.nHill === 2, nHill = p.nHill, gHill = p.gHill;
    const tauUp = p.tauAlphaUp, tauDown = p.tauAlphaDown;
    const sBasal = p.sBasal, sAct = p.sAct, sTens = p.sTens, rhoCrowdInv = 1 / p.rhoCrowd, depCrowd = p.depCrowd;
    const doCrowd = p.depCrowd > 0, crowd2 = p.depCrowd === 2;
    const polBase = p.polBase, polAct = p.polAct, kAlign = p.kAlign, kGcell = p.kGcell;
    const mBasal = p.mBasal, protExp = p.protExp, mAct = p.mAct, invMA2 = 1 / (p.mAlphaHalf * p.mAlphaHalf);
    const kGuide = p.kGuide, kLoadAlign = p.kLoadAlign, sigmaP = p.sigmaP;
    const v0 = p.v0, invRhoStar = 1 / p.rhoStar, vFloor = p.vFloor;
    const kDeg = p.kDeg, rMat = p.rMat, kProt = p.kProt, mMin = p.mMin, kGrel = p.kGrel;
    const kMat0 = p.kMat0, kMatBase = p.kMatBase, kLox = p.kLox, eps = p.eps;
    const E0 = p.E0, Escale = p.Escale, kMatE = p.kMat, kStrain = p.kStrain;

    const stiffnessOf = (tr, rm, strain) => {
      const phi = tr > eps ? rm / tr : 0;
      return E0 + Escale * tr * tr * (1 + kMatE * phi) * (1 + kStrain * strain);
    };

    return {
      cell(ctx) {
        const dt = ctx.dt, out = ctx.out;
        const strain = ctx.dial[dStrain], protease = ctx.dial[dProt];
        const Ev = ctx.E, rv = ctx.fiberTotal, gv = ctx.field[iG];
        let a = ctx.a;

        // --- tension (stiffness × load) and activation
        const tau = Ev * invEref * (strain + kappa * a);
        const tauN = hill2 ? tau * tau : Math.pow(tau, nHill);
        const H = tauN / (1 + tauN);
        const gN = gHill2 ? gv * gv : Math.pow(gv, gHill);
        const gsat = gN / (gN + gHalfN);
        const soft = aSoft * Esoft / (Ev + Esoft);
        let aStar = gsat * (aG + aE * H) - soft;
        aStar = aStar <= 0 ? 0 : Math.tanh(aStar);
        const aUp = dt / tauUp < 1 ? dt / tauUp : 1, aDown = dt / tauDown < 1 ? dt / tauDown : 1;
        a += (aStar - a) * (aStar > a ? aUp : aDown);
        out.a = a;
        out.aSum = a;

        // --- secretion of provisional matrix: activation- and tension-dependent, crowding-limited
        let s = (sBasal + sAct * a * a) * (sTens + (1 - sTens) * H);
        if (doCrowd) {
          const q = 1 - rv * rhoCrowdInv;
          s *= q <= 0 ? 0 : (crowd2 ? q * q : Math.pow(q, depCrowd));
        }
        out.secrete[iNew] = s;
        out.pol = polBase + polAct * a;
        out.align = kAlign * a;

        // --- field sources
        out.fieldSrc[iG] = kGcell * a * H;
        const mBasalP = mBasal * Math.pow(protease, protExp);
        out.fieldSrc[iM] = mBasalP + mAct * (1 - H) / (1 + a * a * invMA2);

        // --- polarity and migration
        const strainA = strain * strain;
        out.guide = kGuide;
        out.loadAlign = kLoadAlign * strainA * H;   // cells align with the load only when they feel it
        out.noise = sigmaP;
        let grip = rv * invRhoStar; if (grip > 1) grip = 1;
        out.speed = v0 * (1 - 0.6 * a) * (1 - 0.5 * rv / (rv + 0.5)) * (vFloor + (1 - vFloor) * grip);
      },

      voxel(ctx) {
        const out = ctx.out, tr = ctx.fiberTotal, strain = ctx.dial[dStrain];
        const rn = ctx.rho[iNew], rm = ctx.rho[iMat];
        if (tr > eps) {
          const mEff = mMin + ctx.field[iM];
          const shield = 1 - kProt * strain * ctx.Tzz_over_trace;
          const dv = kDeg * mEff * (rn + rMat * rm) * shield;     // total loss (new vulnerable, mature protected, strained aligned fibres shielded)
          const degMat = kDeg * mEff * rMat * rm;                 // mature loss applied to the split (unshielded, as v0.1)
          const mat = kMat0 * rn * (kMatBase + kLox * ctx.aSum);  // cross-linking by LOX from activated cells
          const dMat = mat - degMat, dNew = -dv - mat + degMat;
          out.dRho[iMat] = dMat; out.dRho[iNew] = dNew;
          out.loss = dv;
          out.fieldSrc[iG] = kGrel * dv;                          // growth factor stored in the matrix is released as it is cut
          // stiffness at the post-update densities (v0.1 order: ECM update, then E)
          const dt = ctx.dt;
          let rn1 = rn + dNew * dt, rm1 = rm + dMat * dt;
          if (rn1 < 0) rn1 = 0; if (rm1 < 0) rm1 = 0;
          out.E = stiffnessOf(rn1 + rm1, rm1, strain);
        } else {
          out.E = E0;
        }
      },

      stiffness(ctx) {
        ctx.out.E = stiffnessOf(ctx.fiberTotal, ctx.rho[iMat], ctx.dial[dStrain]);
      },
    };
  },
};
