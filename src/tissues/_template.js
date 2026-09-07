/*
 * src/tissues/_template.js — a heavily commented STARTER tissue definition.
 *
 * Copy this file (or run `node tools/new_tissue.mjs mykey "My tissue"`), rename
 * TISSUE_TEMPLATE → TISSUE_MYKEY, change the key, and register it in
 * src/tissues/index.js. It is NOT registered itself, but tests/engine.test.mjs
 * runs the conformance suite on it so the starter is always known to pass.
 *
 * The story: cells seeded in a hydrolysing hydrogel replace it with a fibrous
 * matrix of their own. Two species (a 'scaffold' that only dissolves, a
 * 'fiber' that the cells build), one diffusible field (a growth-factor bath),
 * one cell type, three dials, two scenarios with machine-checkable `checks`.
 *
 * Every top-level identifier in this file must be unique across src/ (the
 * single-file build concatenates all sources): prefix helpers with `tpl`.
 *
 * Read docs/EXTENDING.md alongside: §1 for the shape, §2 for what the hooks
 * receive and may write, §7 for what the tests demand.
 */

export const TISSUE_TEMPLATE = {
  key: 'template',                              // registry/URL key: [a-z0-9-]
  name: 'Template tissue',                      // tissue picker
  short: 'Cells replace a dissolving hydrogel with their own fibrous matrix',
  version: '0.1.0',

  // ---- matrix species: per-voxel scalar densities (0 .. ~1.5; 1 ≈ native-like content).
  //      kind 'fiber' species are oriented and share the tensor T; 'gel' is an isotropic
  //      haze; 'scaffold' is drawn as a fading lattice. Colours are #rrggbb.
  species: [
    { key: 'gel', label: 'Hydrogel scaffold', kind: 'scaffold', color: '#9fb7c9',
      describe: 'carrier gel that hydrolyses at a fixed rate' },
    { key: 'fib', label: 'Fibrous matrix', kind: 'fiber', color: '#e0a24a',
      describe: 'cell-made oriented matrix' },
  ],

  // ---- diffusible fields. D in L²/day; `bath` names a dial the field relaxes toward at
  //      kBath (/day); `decay` /day. Sources come from the rules (cell and voxel fieldSrc).
  //      Optional `boundary: 'face:+z'` holds the top z layer at the bath value instead
  //      (e.g. oxygen entering from the medium face); default 'bath' relaxes everywhere.
  fields: [
    { key: 'g', label: 'Growth factor', color: '#3fd6c4', D: 0.05, bath: 'Gext', kBath: 4, decay: 0 },
  ],

  // ---- cell types. Each cell carries a type index and three state scalars a, b, c
  //      (a, b ∈ [0,1]; c ∈ cRange, default [0,1]). `init` sets the starting values.
  //      With several types, `fraction` sets their shares (default equal).
  cellTypes: [
    { key: 'cell', label: 'Matrix-building cell',
      colors: ['#4ea3ff', '#ff7a3d'],                      // colour lerped by a
      shape: { by: 'a', aspectMin: 1.0, aspectMax: 2.0 },  // ellipsoid aspect along the polarity
      radius: 0.03, motile: true,
      init: { a: 0.05, b: 0, c: 0 },
      stateLabels: { a: 'activation', b: null, c: null } },
  ],

  // ---- dials. role 'cellCount' is handled by the engine (adds/removes cells); role 'load'
  //      marks the dial used for the passive fiber alignment along z (ctx.load in the hooks).
  //      format: 'fixed2' | 'percent' | 'cells' | 'int' | 'onoff' | (v) => string
  //      metaphor / biology / watch are the three lines of the dial's hint.
  dials: [
    { key: 'Gext', label: 'Growth-factor bath', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'Humidity: how much vapor is available to condense.',
      biology: 'Signal in the medium that activates the cells and drives matrix synthesis.',
      watch: 'Cells turn orange, then the flux bar tips toward condensing a day or two later.' },
    { key: 'strain', label: 'Mechanical load', min: 0, max: 1, step: 0.01, default: 0.5, format: 'percent', role: 'load',
      metaphor: 'Pressure: a steady push that shapes the cloud.',
      biology: 'Static stretch along the vertical axis; fibers and cells line up with it.',
      watch: 'Fibers swing toward the arrows and the alignment trace rises.' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount',
      metaphor: 'Condensation nuclei: droplets need something to form on.',
      biology: 'Seeding density. More cells build (and remodel) faster.',
      watch: 'Few cells: the gel dissolves before much matrix appears. Many cells: the cube fills in.' },
  ],

  // ---- scenarios (ordered as in the panel). `init.species` are uniform densities with one
  //      jitter draw per voxel (± jitter·50 %); `init.from` pre-runs another scenario instead.
  //      Optional `events` (dial changes / injuries at day `at`) are applied by the tests and
  //      the headless tools. `checks` are evaluated by TissueEngine.checkScenario():
  //        { at, stat, op: 'gt'|'lt'|'between', value }            absolute
  //        { at, stat, rel: { stat, op: 'gt'|'lt', at? }, value? }  relative to another stat / day
  //      stat paths: species.<key> | species.<key>.fraction | species.total | fiber.total | fa |
  //                  globalFA | fz | logE | E | cells.a | cells.b | cells.c | fields.<key> |
  //                  deposition | degradation | ratio
  scenarios: [
    { key: 'replace', title: 'Scaffold replacement',
      goal: 'Watch cells replace a dissolving hydrogel with a matrix of their own.',
      steps: [
        'Press Play and let four weeks pass.',
        'Watch the lattice fade while amber fibers appear around the cells.',
        'Check whether the stiffness trace dips before it climbs.',
      ],
      question: 'The gel dissolves at a fixed rate. What sets whether the cells win the race to replace it?',
      expect: 'The lattice fades over about a month; fibrous matrix appears and aligns with the load; stiffness dips, then recovers.',
      dials: { Gext: 0.6, strain: 0.5, nCells: 160 },
      init: { species: { gel: 0.8, fib: 0.02 }, jitter: 0.2 },
      checks: [
        { at: 0, stat: 'species.gel', op: 'between', value: [0.7, 0.9] },
        { at: 30, stat: 'species.gel', op: 'lt', value: 0.4 },
        { at: 60, stat: 'species.fib', op: 'gt', value: 0.4 },
        { at: 60, stat: 'fa', op: 'gt', value: 0.2 },
        { at: 60, stat: 'cells.a', op: 'gt', value: 0.5 },
        { at: 60, stat: 'logE', rel: { stat: 'logE', at: 10, op: 'gt' } },
      ] },
    { key: 'starve', title: 'No growth factor',
      goal: 'Remove the growth factor and see the scaffold dissolve with little to replace it.',
      steps: [
        'Confirm the bath is at zero and press Play.',
        'Watch the flux bar: it should lean toward evaporating.',
        'Run for eight weeks and compare the final density with the replacement scenario.',
      ],
      question: 'Nothing digests the fibers faster here. Why does the tissue still end up nearly empty?',
      expect: 'The lattice fades as before, the cells stay blue and quiet, and only a thin fibrous matrix remains.',
      dials: { Gext: 0.0, strain: 0.5, nCells: 160 },
      init: { species: { gel: 0.8, fib: 0.02 }, jitter: 0.2 },
      checks: [
        { at: 60, stat: 'species.gel', op: 'lt', value: 0.2 },
        { at: 60, stat: 'species.fib', op: 'lt', value: 0.2 },
        { at: 60, stat: 'cells.a', op: 'lt', value: 0.2 },
        { at: 30, stat: 'ratio', op: 'lt', value: 0.87 },
      ] },
  ],

  // ---- readouts: the charts of the panel, in order. type 'stack' | 'lines' | 'log' | 'flux'.
  readouts: [
    { key: 'density', label: 'Matrix density', unit: 'relative (1 ≈ dense tissue)',
      meaning: 'Hydrogel scaffold and cell-made fibrous matrix per volume.', type: 'stack', domain: [0, 1],
      series: [{ stat: 'species.gel', label: 'hydrogel', color: '#9fb7c9' }, { stat: 'species.fib', label: 'fibrous matrix', color: '#c4822a' }] },
    { key: 'align', label: 'Alignment & activation', unit: '0–1',
      meaning: 'How strongly fibers share one direction, and how activated the cells are.', type: 'lines', domain: [0, 1],
      series: [{ stat: 'fa', label: 'alignment', color: '#8f7ae0' }, { stat: 'cells.a', label: 'cell activation', color: '#e0602a' }] },
    { key: 'stiff', label: 'Stiffness', unit: 'kPa (log scale)',
      meaning: 'Gel plus fiber stiffness; cells sense it and respond.', type: 'log', domain: [-1, 2.5],
      series: [{ stat: 'logE', label: 'stiffness', color: '#8fb8d8' }] },
    { key: 'flux', label: 'Matrix flux', unit: 'density per day',
      meaning: 'Deposition against loss right now (gel hydrolysis counts as loss).', type: 'flux' },
  ],

  // ---- tissue-specific copy (the app generates the About panel and legend from it)
  copy: {
    intro: {
      tagline: 'A hydrogel dissolves while the cells inside it build their replacement.',
      paragraphs: [
        'You are looking at a cube of hydrogel seeded with cells. The fading lattice is the gel; the amber rods are the fibrous matrix the cells lay down; the small bodies are the cells, blue when quiet and orange when activated.',
        'Two of the three dials act through the cells (growth factor, cell number); the load also pulls on the fibers directly.',
      ],
    },
    metaphorBreaks: [
      { claim: 'A cloud reshapes itself in seconds when the weather changes.',
        reality: 'Gel hydrolysis and matrix synthesis take weeks; the cells respond to a dial within a day.' },
    ],
    legend: {
      fibers: 'Amber rods: cell-made fibrous matrix. Thicker rods mean denser matrix; rods that share a direction mean aligned matrix.',
      scaffold: 'Grey lattice: the hydrogel scaffold. It fades as it hydrolyses.',
      cells: 'Cells: blue and round when quiet, orange and elongated when activated.',
      fields: { g: 'Teal haze: growth factor. Denser haze, stronger signal.' },
      load: 'Translucent arrows on the top and bottom faces: mechanical load along the vertical axis.',
    },
    vocabulary: { matrix: 'matrix', cellsActive: 'activated cells are laying down matrix', cellsQuiet: 'the cells are quiet' },
  },

  // ---- injury: omitted → no Injure button. (See fibrous.js for the shape.)

  // ---- engine numerics this tissue wants (all optional; see ENGINE_DEFAULTS in src/engine.js)
  engine: { N: 12, dt: 0.02 },

  // ---- tissue parameters, passed to makeRules as `p`
  params: {
    kGel: 0.05,                       // /day hydrolysis of the scaffold
    kDeg: 0.1,                        // /day loss of fibrous matrix
    E0: 0.3, EGel: 1.5, Escale: 20, kStrain: 0.5, Eref: 10, // E = E0 + EGel·gel + Escale·fib²·(1 + kStrain·strain)
    kappa: 0.12, aG: 1.2, aE: 0.6, gHalf: 0.4,              // activation (fibrous-like: growth factor gates, tension potentiates)
    tauUp: 2, tauDown: 4,
    sBasal: 0.005, sAct: 2.5, rhoCrowd: 1.4,                // secretion of fiber
    polBase: 0.2, polAct: 0.6, kAlign: 0.6,
    v0: 0.7, vFloor: 0.5, sigmaP: 2.5, kGuide: 6, kLoadAlign: 10,
    kGcell: 4,                        // autocrine growth factor from activated cells
  },

  // ---- the rules: called once per reset; pre-resolve every index here, allocate nothing in the hooks
  makeRules(engine, p) {
    const iGel = engine.speciesIndex.gel, iFib = engine.speciesIndex.fib;
    const iG = engine.fieldIndex.g;
    const dStrain = engine.dialIndex.strain;
    const invEref = 1 / p.Eref, gHalf2 = p.gHalf * p.gHalf, rhoCrowdInv = 1 / p.rhoCrowd;

    return {
      // once per cell per step — read ctx.*, write ctx.out.* (see EXTENDING.md §2.1)
      cell(ctx) {
        const out = ctx.out, dt = ctx.dt, strain = ctx.dial[dStrain];
        const Ev = ctx.E, rho = ctx.fiberTotal, gv = ctx.field[iG];
        let a = ctx.a;
        // tension (stiffness × load) and growth-factor gated activation
        const tau = Ev * invEref * (strain + p.kappa * a), tau2 = tau * tau, H = tau2 / (1 + tau2);
        const gsat = gv * gv / (gv * gv + gHalf2);
        let aStar = gsat * (p.aG + p.aE * H);
        aStar = aStar <= 0 ? 0 : Math.tanh(aStar);
        a += (aStar - a) * (aStar > a ? Math.min(1, dt / p.tauUp) : Math.min(1, dt / p.tauDown));
        out.a = a;                                            // engine clamps to [0,1]
        // secretion of fiber into this voxel, crowding-limited; oriented along the polarity when activated
        const q = 1 - rho * rhoCrowdInv;
        out.secrete[iFib] = (p.sBasal + p.sAct * a * a) * (q <= 0 ? 0 : q * q);
        out.pol = p.polBase + p.polAct * a;
        out.align = p.kAlign * a;
        // autocrine growth factor
        out.fieldSrc[iG] = p.kGcell * a * H;
        // polarity dynamics and migration (the engine applies dt, FA and the noise draws)
        out.guide = p.kGuide;
        out.loadAlign = p.kLoadAlign * strain * strain * H;
        out.noise = p.sigmaP;
        out.speed = p.v0 * (1 - 0.6 * a) * (p.vFloor + (1 - p.vFloor) * Math.min(1, rho / 0.5));
      },

      // once per voxel per step — matrix processes EXCLUDING deposition (see EXTENDING.md §2.2)
      voxel(ctx) {
        const out = ctx.out, gel = ctx.rho[iGel], fib = ctx.rho[iFib], strain = ctx.dial[dStrain];
        const lossGel = p.kGel * gel, lossFib = p.kDeg * fib;
        out.dRho[iGel] = -lossGel;
        out.dRho[iFib] = -lossFib;
        out.loss = lossGel + lossFib;
        // stiffness "now" (no `stiffness` hook here: after reset the engine calls voxel() with dt = 0)
        out.E = p.E0 + p.EGel * gel + p.Escale * fib * fib * (1 + p.kStrain * strain);
      },
    };
  },
};
