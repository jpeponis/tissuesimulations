/*
 * src/tissues/cartilage.js — TISSUE_CARTILAGE: articular cartilage engineered in
 * a degrading hydrogel (docs/tissues/cartilage-hydrogel.md §2–§3), written for
 * the generic engine of docs/EXTENDING.md.
 *
 * The anti-fibrous case: round, pinned cells; an isotropic matrix whose
 * stiffness comes from osmotic swelling restrained by a collagen net; a
 * scaffold that must vanish on time; and a phenotype that can flip and stay
 * flipped. The story is a RACE — the hydrogel dissolves on its own clock while
 * the cells try to replace it — not an equilibrium.
 *
 * ---------------------------------------------------------------------------
 * HOW THE SPEC MAPS ONTO THE HOOKS
 * ---------------------------------------------------------------------------
 *  species  scaf (scaffold, the connected network fraction), gag (gel, aggrecan),
 *           col2 (fiber, deposited with pol ≈ 0 so it stays a felt, FA low),
 *           col1 (fiber, deposited along the cell polarity by dedifferentiated
 *           cells, so it is the only species that raises FA).
 *  fields   tgf (bath dial tgfExt, kBath 4), o2 (Dirichlet on the +z medium face
 *           at the o2Ext dial, consumed by cells as a negative fieldSrc, engine
 *           clamps ≥ 0), m (catabolic protease: MMP-13 + aggrecanase, decay 1/d).
 *  cell     a = phi, the phenotype axis (1 chondrogenic ↔ 0 fibroblastic);
 *           b = cat, catabolic memory (IL-1 exposure, slow to clear);
 *           c = the pericellular halo pool (matrix made but trapped by the mesh),
 *           cRange [0, 3], full at c = Pcap = 1.
 *           Colour lerps a = 0 → orange (fibroblastic), a = 1 → teal
 *           (chondrogenic); shape { by: 'a', aspectMin: 2.2, aspectMax: 1 } —
 *           aspect DECREASES with a, so a chondrogenic cell is a sphere and a
 *           dedifferentiated one a spindle. Both the renderer and the Blender
 *           importer compute aspect = aspectMin + (aspectMax − aspectMin)·s
 *           linearly, so aspectMin > aspectMax is legal and does the right thing
 *           (verified: src/render.js:1051, blender/import_tissue.py:583; the
 *           engine's validator only requires two numbers).
 *  voxel    scaffold hydrolysis + cell-enzyme term, GAG loss to the medium and
 *           protease digestion, protected collagen II, slow collagen I loss, and
 *           the pericellular → bulk SPREADING of gag and col2 (see below).
 *  dials    tgfExt, amp (role 'load'), o2Ext, infl, xl, nCells (role 'cellCount'),
 *           serum. `amp` is a strain amplitude in [0, 0.2] shown as 0–20 %;
 *           `o2Ext` is oxygen normalised to 21 % (1 ≡ 21 %) with a formatter that
 *           prints the percentage, so the o2 field is also 0–1 and can share a
 *           0–1 chart with the phenotype.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ENGINE FORCED (deviations from docs/tissues/cartilage-hydrogel.md)
 * ---------------------------------------------------------------------------
 *  SPREADING  The engine deposits a cell's secretion into the ONE voxel the cell
 *    occupies and never moves matrix between voxels. Chondrocytes are pinned, so
 *    with 160 cells in 12³ voxels only ~8 % of the cube would ever contain
 *    matrix and the mean densities of §2.6 (gag > 0.7) would be unreachable.
 *    The voxel hook therefore runs an explicit 6-neighbour diffusion of gag and
 *    col2 (computed for the whole grid on the v = 0 call, then read back per
 *    voxel), gated by the same mesh factor as the halo: mobility (1 − conf)².
 *    This is the physics the spec already describes at the sub-voxel scale
 *    (Nikolaev 2010: mobile monomer → immobile aggregate; Mauck 2003: collagen II
 *    spreads from pericellular to construct-wide once the mesh opens), lifted to
 *    the voxel scale. Dgag 0.04, Dcol2 0.015 L²/d ⇒ ~10–25 d to fill the cube.
 *  ONE HALO   The spec has two pericellular pools (haloG, haloC); the engine has
 *    one spare cell scalar, so c holds their sum and is released in the fixed
 *    ratio sG : sC2. Release rate kRel·(1 − conf)⁴·c — the mesh gates the release
 *    with the square of the same (1 − conf)² that gates bulk deposition (the
 *    spec's (1 − conf) drained the halo while the mesh was still tight, so the
 *    pericellular islands of scenario 3 never formed).
 *  ONE pol    A cell has one orientation strength for all fiber species. col2
 *    (pol 0) and col1 (pol 0.8·(1 − phi)) are mixed by their deposition rates,
 *    which is exact whenever a cell is making mostly one of them — the usual case.
 *  NO Da      Oxygen is the engine's explicit-Euler field, not a quasi-steady
 *    Gauss–Seidel solve; the engine caps the diffusion number at 1/6, so the
 *    effective D is h²/(6·dt) = 0.058 L²/d and the profile takes ~1 d to form
 *    instead of minutes. The steady profile is what matters and is tuned through
 *    the consumption kO2 instead of a Damköhler number: 5 % in the bath gives
 *    5 % at the medium face and ≈ 1 % at the deep face, 21 % gives 21 → 12 %.
 *  NO mesh-hindered field D   A field's D is a constant of the definition, so the
 *    spec's D_m·(1 − 0.8·conf) for the protease is folded into its source
 *    (kMxl: tight gels make ~25× more MMP-13, Nicodemus 2011).
 *  SCAFFOLD FLUX  out.loss feeds the flux gauge, which has two bars; scaffold
 *    hydrolysis is neither deposition nor degradation of TISSUE, so it is left
 *    out of `loss` (the spec asked for a third bar). The stacked chart still
 *    shows the grey band draining.
 *  MOTILITY   v0 0.05 → 0.35 L/d × (1 − phi)²(1 − scaf): a chondrocyte is pinned
 *    (phi ≈ 0.9 ⇒ 0.004 L/d), but a dedifferentiated cell on a cleared, fibrous
 *    matrix crawls like the fibroblast of TISSUE_FIBROUS. Without that, collagen I
 *    piles up in the ~140 voxels that hold a cell and hits the trace clamp before
 *    the mean can reach the 0.3 of scenario 4.
 *  RADIUS     one radius per cell type, so the spec's rCell·(1 + 0.3·phi) is a
 *    constant 0.032.
 *  aSum       the per-voxel "cell activity" accumulator carries the rate of fresh
 *    aggrecan that washed out of this voxel (see RETENTION below): the cell hook
 *    knows the halo and the voxel hook does not, and there is no other channel
 *    from cell() to voxel().
 *
 * ---------------------------------------------------------------------------
 * PARAMETER / EQUATION CHANGES (the spec's constants are placeholders, and two of
 * its scenario targets contradict its own parameter table; verified with
 * tools/run_headless.mjs + tools/plot_scenarios.py + the scenario checks)
 * ---------------------------------------------------------------------------
 *  RETENTION (the biggest change).  The spec's single escape term
 *    R = 1 − (1 − col2/(col2+cRet))·(1 − 0.8·conf) cannot tell scenario 1 from
 *    scenario 2: by week four both have conf = 0 and similar col2, so they end in
 *    the same place whatever the rate constant. Retention is split in two here.
 *      · FRESH matrix (cell hook) has to be caught where it is made. hold =
 *        scaf + (1 − scaf)·[1 − (1 − H2(col2, cRet))·(1 − H2(gag, gSelf))·(1 − 0.8·halo/Pcap)]:
 *        an intact network, a collagen II net, aggrecan already aggregated, or the
 *        cell's own pericellular island will each do. A fraction
 *        wf = kWashNew·(1 − hold)·(1 + kWash·s(a)) (≤ 0.9) of new aggrecan is lost
 *        at once, and wC2·wf of new procollagen II — collagen has to be assembled
 *        into fibrils at the cell surface, so it is the more fragile of the two.
 *      · The STANDING pool (voxel hook) leaks at kGagLoss·free·(1 + kWash·s(a))·gag
 *        with free = (1 − scaf)·(1 − H2(col2, cRet))·(1 − H2(gag, gSelf)).
 *    Sources: Nikolaev 2010 (mobile monomer → immobile aggregate), Maroudas 1976 /
 *    Williamson 2001 (the collagen net is what holds the swelling pressure),
 *    Schneider 2017 (pericellular islands keep the construct connected through
 *    reverse gelation), Kisiday 2004 and Schneider 2020 (loading raises GAG loss;
 *    daily loading left an MMP-sensitive construct at 26 kPa against 107 kPa in
 *    free swelling). The result is the race the spec describes: scenario 1's halo
 *    hands over its matrix while the mesh is still there and the construct ignites;
 *    scenario 2 loses the same matrix to the medium and never gets going.
 *  tRG(xl) = 7 + 28·xl + 90·xl⁴ d (7 → 125) instead of the spec's linear 7 + 28·xl
 *    (7 → 35). With the linear law even the densest gel reverse-gels by day 35 and
 *    scenario 3's own target (scaf > 0.4 at day 42) is unreachable. The quartic term
 *    reads as the slower hydrolysis per bond of a dense, low-water network and makes
 *    xl = 1 the non-degradable PEG control of Bryant & Anseth 2002 / Skaalure 2014,
 *    while keeping tRG(0.5) = 27 d inside the 2–4 week band of Schneider 2020.
 *  E_scaf ∝ scaf² (percolation: the modulus of a network vanishes faster than its
 *    connected fraction near the gel point) rather than ∝ scaf. This is what gives
 *    scenario 1 its handover dip (35 → 24 kPa in week 1) and scenario 3 its long
 *    slide from 65 to 15 kPa.
 *  SYNTHESIS  sG 0.30 → 0.7, sC2 0.06 → 0.12 per agent. With the spec's rates and
 *    the losses above, scenario 1 reaches gag ≈ 0.35 in eight weeks instead of the
 *    0.7 of §2.6; the ratio sG : sC2 (collagen lags ~5×, Hung 2004) is kept.
 *    fCrowd scale 1.6 → 2.2: at 1.6 product inhibition shuts synthesis down at
 *    gag + col2 ≈ 1.1 and no loss at all could be balanced.
 *  PROTEASE  mBasal 0.35 per agent (m ≈ 0.05 in a cleared gel), kMxl 3 → 20 (m ≈ 0.6
 *    in a tight one; Nicodemus 2011 report ~25× MMP-13), mFib 3 → 1.5, mInfl 20 → 8
 *    (20 gives m ≈ 1.2 at IL-1 0.8, which strips the whole GAG pool in three days;
 *    8 gives ≈ 0.5, the level the spec's kGagDeg was written against). Degradation
 *    uses the protease in EXCESS of a TIMP pool, max(0, m − mTimp), mTimp 0.05, so
 *    basal MMP does not eat a healthy construct (aggrecan half-life is years in vivo)
 *    while IL-1 removes ~20 %/d. kCol2Deg 0.05 → 0.15 so collagen II visibly loses
 *    ground in week 2 of scenario 5 once the aggrecan shielding it is gone (Pratta 2003).
 *  kEnz 0.15 → 0.0015 /d: with the (scaf + sOff) multiplier the spec's value clears
 *    even the densest gel in four days and scenario 3 cannot exist.
 *  PHENOTYPE  cSpread 0.30 → 0.55, cSerum 0.20 → 0.30 so that the fibrocartilage
 *    drift of scenario 4 completes inside eight weeks (phi < 0.3, aspect > 1.8 by
 *    day 42) and still reverses when the medium is corrected.
 * ---------------------------------------------------------------------------
 */

export const TISSUE_CARTILAGE = {
  key: 'cartilage',
  name: 'Articular cartilage in a hydrogel',
  short: 'Chondrocytes race a dissolving gel to build aggrecan and collagen II',
  version: '0.1.0',

  // ---- matrix species
  species: [
    { key: 'scaf', label: 'Hydrogel scaffold', kind: 'scaffold', color: '#9ec5d8',
      describe: 'the intact, connected fraction of the synthetic network' },
    { key: 'gag', label: 'Aggrecan (GAG)', kind: 'gel', color: '#7fe0c9',
      describe: 'proteoglycan gel; pulls water in and carries the swelling pressure' },
    { key: 'col2', label: 'Collagen II', kind: 'fiber', color: '#e8f1f8',
      describe: 'fine isotropic felt that cages the aggrecan' },
    { key: 'col1', label: 'Collagen I', kind: 'fiber', color: '#e0a24a',
      describe: 'fibrocartilage: coarse aligned fibres from dedifferentiated cells' },
  ],

  // ---- diffusible fields
  fields: [
    { key: 'tgf', label: 'Growth factor (TGF-β3)', color: '#3fd6c4', D: 0.05, bath: 'tgfExt', kBath: 4, decay: 0 },
    { key: 'o2', label: 'Oxygen', color: '#6f9ce8', D: 0.06, bath: 'o2Ext', kBath: 0, decay: 0, boundary: 'face:+z' },
    { key: 'm', label: 'Protease (MMP-13 / aggrecanase)', color: '#e05bd0', D: 0.05, bath: null, kBath: 0, decay: 1.0 },
  ],

  // ---- cell types
  cellTypes: [
    { key: 'chondrocyte', label: 'Chondrocyte ↔ dedifferentiated cell',
      colors: ['#ff7a3d', '#3fb8b0'],                        // a = 0 fibroblastic, a = 1 chondrogenic
      shape: { by: 'a', aspectMin: 2.2, aspectMax: 1.0 },    // aspect FALLS with a: round when chondrogenic
      radius: 0.032, motile: true,
      init: { a: 0.9, b: 0, c: 0 },
      cRange: [0, 3],
      stateLabels: { a: 'phenotype (1 = chondrogenic)', b: 'catabolic memory', c: 'pericellular pool' } },
  ],

  // ---- dials
  dials: [
    { key: 'tgfExt', label: 'TGF-β3 bath', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'Humidity: how much vapor is available to condense.',
      biology: 'TGF-β3 in the medium (1 ≈ 10 ng/mL). It drives aggrecan and collagen II synthesis and holds cells in the chondrocyte phenotype.',
      watch: 'The teal haze thickens within a day; the GAG band starts climbing about a week later. Two weeks of it is usually enough.' },
    { key: 'amp', label: 'Dynamic compression', min: 0, max: 0.2, step: 0.01, default: 0, format: 'percent', role: 'load',
      metaphor: 'Pressure: a steady squeeze, on and off, three hours a day.',
      biology: 'Peak-to-peak strain of a 1 Hz squeeze. Around 10 % it stimulates synthesis; past 15 % it injures cells; inside a still-dense gel it does harm instead of good.',
      watch: 'Started after the gel has opened, stiffness and GAG climb faster. Started too early, or turned past 15 %, both fall.' },
    { key: 'o2Ext', label: 'Oxygen tension', min: 0.05, max: 1, step: 0.01, default: 0.24,
      format: (v) => `${Math.round(v * 21)} %`,
      metaphor: 'Altitude: thin air — except that up here the cloud forms better.',
      biology: 'Oxygen in the medium, 1–21 %. Cartilage is avascular; 5 % keeps cells chondrogenic, 21 % pushes them toward collagen I and hypertrophy, and under 1 % they starve.',
      watch: 'Switch on the oxygen layer: the medium face stays bright and the deep half goes dark. Phenotype follows the deep value, not the dial.' },
    { key: 'infl', label: 'Inflammation (IL-1)', min: 0, max: 1, step: 0.01, default: 0, format: 'fixed2',
      metaphor: 'Temperature: heat turns droplets back into vapor.',
      biology: 'IL-1β in the medium (1 ≈ 10 ng/mL). It switches on aggrecanase and MMP-13 and shuts synthesis down, and the cells stay suppressed after it is gone.',
      watch: 'The teal GAG band melts within days; the ivory collagen II band only starts to go in the second week. Recovery takes weeks.' },
    { key: 'xl', label: 'Crosslink density', min: 0, max: 1, step: 0.05, default: 0.5, format: 'fixed2',
      metaphor: 'The trellis: a frame the gardener builds and expects to rot.',
      biology: 'How tightly the hydrogel is crosslinked. It sets the starting stiffness (5–65 kPa), the mesh size, and how long the gel takes to fall apart (1–11 weeks).',
      watch: 'High: matrix stays trapped as pericellular islands and the cube stays grey. Low: the lattice is gone before there is anything to replace it.' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount',
      metaphor: 'Condensation nuclei: droplets need something to form on.',
      biology: 'Seeding density, 20–60 million cells per mL. Each agent stands for a small cluster. More cells fill the gel sooner but pull the oxygen down deeper.',
      watch: 'Few cells: islands that never merge. Many cells: faster GAG, but the deep half of the cube goes dark on the oxygen layer.' },
    { key: 'serum', label: 'Serum', min: 0, max: 1, step: 1, default: 0, format: 'onoff',
      metaphor: 'Smog: extra stuff in the air that fouls the droplets.',
      biology: '10 % fetal bovine serum. It carries mitogens that push chondrocytes toward a fibroblast-like state and blunt the TGF-β3 response; defined serum-free medium works better.',
      watch: 'Cells drift orange and stretch out, the amber collagen I band appears, and the teal GAG band stalls.' },
  ],

  // ---- scenarios
  scenarios: [
    { key: 'race', title: 'Hydrogel to cartilage (the race)',
      goal: 'Watch a synthetic gel dissolve on its own clock while the cells inside it try to build cartilage before the gel is gone.',
      steps: [
        'Press Play and watch the grey lattice fade while the teal haze grows.',
        'At day 14 the TGF-β3 comes down and the squeezing starts: keep an eye on the stiffness trace.',
        'Run to eight weeks and watch where the stiffness trace goes: down through the first fortnight, then past the fresh gel by week three.',
      ],
      question: 'The stiffness dips before it climbs. What is handing over to what during those two weeks, and what would make the handover fail?',
      expect: 'The grey band drains to nothing by about day 21 while teal aggrecan and a thin ivory collagen II band fill in behind it. Stiffness dips from 35 to about 24 kPa in the first fortnight, then climbs past the fresh gel to a few hundred kPa by week eight. Cells stay round and teal, and the pericellular pool fills in week one and empties around day 20.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 0.5, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        { at: 0, stat: 'species.scaf', op: 'between', value: [0.94, 1.06] },
        { at: 0, stat: 'logE', op: 'between', value: [1.4, 1.65] },          // fresh gel ≈ 35 kPa
        { at: 7, stat: 'cells.c', op: 'gt', value: 0.8 },                    // halo saturates in week 1
        { at: 7, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' } },     // handover dip …
        { at: 7, stat: 'logE', op: 'gt', value: 0.9 },                       // … but never below 8 kPa
        { at: 28, stat: 'species.scaf', op: 'lt', value: 0.2 },
        { at: 28, stat: 'ratio', op: 'gt', value: 2 },
        { at: 28, stat: 'fields.o2', op: 'lt', value: 0.18 },                // O₂ gradient below the bath (0.24)
        { at: 35, stat: 'cells.c', op: 'lt', value: 0.2 },                   // halo emptied into the cube
        { at: 42, stat: 'species.scaf', op: 'lt', value: 0.05 },
        { at: 42, stat: 'species.gag', op: 'gt', value: 0.5 },
        { at: 56, stat: 'species.gag', op: 'gt', value: 0.7 },
        { at: 56, stat: 'species.col2', op: 'gt', value: 0.15 },
        { at: 56, stat: 'species.col1', op: 'lt', value: 0.05 },
        { at: 56, stat: 'cells.a', op: 'gt', value: 0.75 },
        { at: 56, stat: 'logE', op: 'gt', value: 2.0 },                      // > 100 kPa …
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'gt' } },    // … and above the fresh gel
        { at: 56, stat: 'fa', op: 'lt', value: 0.25 },                       // collagen II is a felt, not a weave
      ] },

    { key: 'toofast', title: 'Scaffold degrades too fast',
      goal: 'Use a loosely crosslinked gel and watch the trellis vanish before the cells have anything to hold their matrix in.',
      steps: [
        'Press Play; the lattice is gone inside ten days.',
        'Watch the flux gauge: deposition is high but so is loss to the medium.',
        'Run to eight weeks and compare the final GAG band and stiffness with the first scenario.',
      ],
      question: 'The cells here synthesise more than in the first scenario, not less. Where does the matrix go, and which readout shows it leaving?',
      expect: 'The grey band is gone by day 10 with almost nothing behind it. Aggrecan climbs to about a third of native by day 14 and then goes backwards: with no mesh, no pericellular island and no collagen net to catch it, new aggrecan washes out as fast as it is made, and the squeezing from day 14 makes that worse. The cube ends nearly empty at a few kPa, and the flux gauge sits on evaporating the whole time.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 0.1, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        { at: 14, stat: 'species.scaf', op: 'lt', value: 0.1 },
        { at: 14, stat: 'cells.c', op: 'lt', value: 0.3 },                   // no mesh, so no pericellular pool
        { at: 21, stat: 'species.gag', op: 'lt', value: 0.3 },
        { at: 28, stat: 'ratio', op: 'lt', value: 0.87 },                    // the flux gauge sits on evaporating
        { at: 42, stat: 'logE', rel: { stat: 'logE', at: 14, op: 'lt' }, value: -0.3 },
        { at: 56, stat: 'species.gag', op: 'lt', value: 0.45 },
        { at: 56, stat: 'species.col2', op: 'lt', value: 0.1 },
        { at: 56, stat: 'logE', op: 'lt', value: 1.78 },                     // < 60 kPa
        { at: 56, stat: 'cells.a', op: 'gt', value: 0.6 },                   // still chondrocytes, just poor ones
      ] },

    { key: 'toodense', title: 'Scaffold too dense',
      goal: 'Crosslink the gel as tightly as it will go and watch the matrix get stuck around the cells that made it.',
      steps: [
        'Press Play and watch the cells, not the cube: a pale ring builds around each one.',
        'Follow the pericellular trace — it fills up and stays full.',
        'Run to eight weeks: the lattice is still there at six, and the stiffness trace slides the whole time before a late, partial recovery.',
      ],
      question: 'The cells are working the whole time. Why does a tighter gel make the construct end up softer than it started?',
      expect: 'The grey band is still a third full at six weeks. Almost no bulk aggrecan appears; the pericellular pool saturates in week one and is still full at day 42. Protease runs six times higher than in the first scenario, the gel is chewed from the inside, and stiffness slides from 65 kPa to about 15 before the released islands finally lift it — still short of where it started.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 1, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        { at: 21, stat: 'cells.c', op: 'gt', value: 0.8 },                   // pericellular islands, full …
        { at: 42, stat: 'cells.c', op: 'gt', value: 0.8 },                   // … and still full three weeks later
        { at: 35, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' } },    // stiffness only ever goes down …
        { at: 42, stat: 'species.scaf', op: 'gt', value: 0.25 },
        { at: 42, stat: 'species.gag', op: 'lt', value: 0.2 },
        { at: 42, stat: 'fields.m', op: 'gt', value: 0.12 },                 // ≥ 2 × the race (0.047)
        { at: 56, stat: 'cells.a', op: 'gt', value: 0.7 },                   // round cells keep their phenotype
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.15 },   // … and ends < 0.7 × E(0)
      ] },

    { key: 'drift', title: 'Fibrocartilage drift',
      goal: 'Give the cells everything cartilage does not want — serum, room air, a thin trickle of growth factor — and watch them become something else.',
      steps: [
        'Press Play and watch the cell colour and shape rather than the matrix.',
        'By four weeks the cells are orange spindles and amber fibres are appearing.',
        'At day 56 the medium is corrected back to 5 % oxygen, serum-free, full TGF-β3. Run four more weeks and see what comes back.',
      ],
      question: 'The phenotype recovers after you fix the medium, but the tissue does not. What does that tell you about scar in a joint?',
      expect: 'The teal aggrecan band never gets going. Cells drift orange, stretch into spindles, start crawling, and lay down aligned amber collagen I (alignment reaches 0.4, which cartilage never does). Correcting the medium at day 56 brings the phenotype most of the way back within a month — but the collagen I they already made is still there, and there is more of it.',
      dials: { tgfExt: 0.2, amp: 0, o2Ext: 1, infl: 0, xl: 0.3, nCells: 160, serum: 1 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 56, dials: { tgfExt: 0.5, o2Ext: 0.24, serum: 0 } }],
      checks: [
        { at: 28, stat: 'cells.a', op: 'lt', value: 0.5 },
        { at: 42, stat: 'cells.a', op: 'lt', value: 0.34 },                  // aspect ratio > 1.8: spindles
        { at: 42, stat: 'species.col1', rel: { stat: 'species.col2', op: 'gt' } },
        { at: 56, stat: 'cells.a', op: 'lt', value: 0.3 },
        { at: 56, stat: 'species.col1', op: 'gt', value: 0.3 },
        { at: 56, stat: 'species.gag', op: 'lt', value: 0.3 },
        { at: 56, stat: 'logE', op: 'between', value: [1, 1.9] },            // 10–80 kPa: fibrocartilage
        { at: 56, stat: 'fa', op: 'gt', value: 0.3 },                        // collagen I is aligned
        { at: 84, stat: 'cells.a', op: 'gt', value: 0.5 },                   // phenotype comes back …
        { at: 84, stat: 'cells.a', rel: { stat: 'cells.a', at: 56, op: 'gt' }, value: 0.3 },
        { at: 84, stat: 'species.col1', rel: { stat: 'species.col1', at: 56, op: 'gt' } },   // … the fibres do not go
      ] },

    { key: 'inflamed', title: 'Inflammatory breakdown',
      goal: 'Take the finished construct from the first scenario, drop IL-1 into the medium for two weeks, and see what breaks first and what comes back.',
      steps: [
        'Press Play: within days the teal GAG band melts while the ivory collagen II band barely moves.',
        'At day 14 the IL-1 is washed out. Watch the protease haze clear within a week.',
        'Run to eight weeks and compare GAG and collagen II with where they started.',
      ],
      question: 'GAG comes back and collagen II does not. Which of the two would you rather have kept, and why does the joint agree with you?',
      expect: 'Aggrecan goes first and fast: nine tenths of it in a fortnight. Collagen II only starts to lose ground in the second week, once the aggrecan that was shielding it is gone, and it loses about a fifth. Stiffness collapses from 420 to 30 kPa. After washout the protease clears in days but the cells stay suppressed for another week; the aggrecan is rebuilt over a month, the collagen II takes the rest of the run to make good, and the construct ends a little short of where it began.',
      dials: { tgfExt: 0.2, amp: 0.1, o2Ext: 0.24, infl: 0.8, xl: 0.5, nCells: 160, serum: 0 },
      init: { from: { scenario: 'race', days: 56 } },
      events: [{ at: 14, dials: { infl: 0 } }],
      checks: [
        { at: 0, stat: 'species.gag', op: 'gt', value: 0.7 },                       // a finished construct
        { at: 7, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'gt' }, value: -0.03 },  // < 10 % col II lost in week 1
        { at: 14, stat: 'species.gag', rel: { stat: 'species.gag', at: 0, op: 'lt' }, value: -0.4 },    // aggrecan goes first
        { at: 14, stat: 'species.col2', rel: { stat: 'species.col2', at: 7, op: 'lt' } },               // collagen II goes in week 2
        { at: 14, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'gt' }, value: -0.06 }, // but only ≈ 20 %
        { at: 14, stat: 'cells.b', op: 'gt', value: 0.6 },
        { at: 14, stat: 'cells.a', rel: { stat: 'cells.a', at: 0, op: 'lt' }, value: -0.2 },
        { at: 14, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.3 },                  // > 50 % of the modulus
        { at: 19, stat: 'fields.m', op: 'lt', value: 0.1 },                                            // protease clears in 5 d
        { at: 21, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'lt' } },
        { at: 56, stat: 'species.gag', rel: { stat: 'species.gag', at: 0, op: 'gt' }, value: -0.4 },    // aggrecan is rebuilt
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' } },                               // stiffness is not, quite
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'gt' }, value: -0.3 },
        { at: 56, stat: 'cells.a', op: 'gt', value: 0.7 },
      ] },
  ],

  // ---- readouts
  readouts: [
    { key: 'density', label: 'Matrix composition', unit: 'relative (1 ≈ native cartilage)',
      meaning: 'What the cube is made of: the hydrogel scaffold draining away, and the aggrecan, collagen II and collagen I the cells put in its place.',
      type: 'stack', domain: [0, 1.5],
      series: [
        { stat: 'species.scaf', label: 'hydrogel', color: '#9ec5d8' },
        { stat: 'species.gag', label: 'aggrecan', color: '#4cc4ae' },
        { stat: 'species.col2', label: 'collagen II', color: '#c9bfa8' },
        { stat: 'species.col1', label: 'collagen I', color: '#e0a24a' },
      ] },
    { key: 'state', label: 'Phenotype, oxygen and the pericellular pool', unit: '0–1',
      meaning: 'Phenotype is 1 for a round chondrocyte and 0 for a fibroblast-like cell. Oxygen is the mean through the cube, 1 ≡ 21 %. The pericellular pool is how full the halo around each cell is.',
      type: 'lines', domain: [0, 1],
      series: [
        { stat: 'cells.a', label: 'phenotype', color: '#3fb8b0', unit: '0–1 (mean over cells)',
          meaning: '1 = chondrogenic (aggrecan and collagen II), 0 = fibroblastic (collagen I).' },
        { stat: 'fields.o2', label: 'oxygen', color: '#6f9ce8', unit: '0–1 (1 ≡ 21 %)',
          meaning: 'Mean oxygen. The medium face is held at the dial; the deep half is whatever is left after the cells have breathed.' },
        { stat: 'cells.c', label: 'pericellular pool', color: '#b9a4e0', unit: '0–1 (1 = full)',
          meaning: 'Matrix made but trapped by the mesh around the cell. It empties into the cube as the gel clears.' },
        { stat: 'cells.b', label: 'catabolic memory', color: '#e05bd0', unit: '0–1 (mean over cells)',
          meaning: 'How far the cells are into an IL-1 programme. It outlasts the IL-1 itself.' },
      ] },
    { key: 'stiff', label: 'Stiffness', unit: 'kPa (log scale)',
      meaning: 'Compressive modulus. A fresh gel is 5–65 kPa, a good construct a few hundred, native cartilage about 1 MPa. Aggrecan only stiffens once collagen restrains it.',
      type: 'log', domain: [-0.5, 3],
      series: [{ stat: 'logE', label: 'stiffness', color: '#8fb8d8' }] },
    { key: 'flux', label: 'Matrix flux', unit: 'density per day',
      meaning: 'Building against losing. Losing means aggrecan escaping to the medium and protease cutting matrix; the scaffold dissolving is counted as neither.',
      type: 'flux' },
  ],

  // ---- copy
  copy: {
    intro: {
      tagline: 'A gel that has to disappear, and cells racing to replace it.',
      paragraphs: [
        'You are looking at a cube of synthetic hydrogel about a third of a millimetre across, with chondrocytes photo-encapsulated in it. The grey lattice is the gel. The teal haze is aggrecan: sugar-coated protein that pulls water in and holds the swelling pressure. The pale ivory felt is collagen II, the net that stops the aggrecan from simply swelling away. Amber fibres are collagen I, and they are bad news here.',
        'Unlike fibroblasts, these cells do not crawl and do not pull. A chondrocyte sits in the hole it was cast into, round and teal, and secretes. Everything it makes has to fit through the mesh of the gel; while the mesh is tight, the matrix stays pinned around the cell as a pericellular island. That is why the crosslink dial matters as much as the growth factor: it sets how long the trellis takes to rot, and nothing becomes bulk tissue until it does.',
        'The lesson is a race, not a balance. Dissolve the gel too fast and there is nothing to hold the new matrix, so it washes into the medium. Dissolve it too slowly and the matrix never leaves the cells that made it. In between, the construct hands stiffness over from gel to tissue, dips in the middle, and comes out stiffer than it started.',
      ],
    },
    metaphorBreaks: [
      { claim: 'Evaporation is a figure of speech for matrix breakdown.',
        reality: 'Here it is literal. Aggrecan monomers that are not yet aggregated and caged by collagen diffuse out of the construct and are thrown away with the medium. The construct really does dry out.' },
      { claim: 'Weather acts on a cloud from outside; the cloud has no scaffolding.',
        reality: 'The hydrogel has no counterpart in the metaphor at all. It is a trellis a gardener builds and expects to rot, and the whole story is whether the plant grows before the trellis falls.' },
      { claim: 'Thin air at altitude makes it harder for a cloud to form.',
        reality: 'Cartilage has no blood supply. At 5 % oxygen the cells make more aggrecan and more collagen II than at room air; 21 % is the abnormal condition, and it pushes them toward collagen I.' },
      { claim: 'More cloud means a stiffer, heavier cloud.',
        reality: 'Aggrecan alone is nearly worthless mechanically. It is an osmotic sponge, and it only becomes stiffness once a collagen net exists to resist the swelling. Same amount of matrix, six times the modulus, depending on the net.' },
      { claim: 'Droplets are droplets: they do not decide what to be.',
        reality: 'A chondrocyte can become a fibroblast-like cell, and then it makes a different, aligned matrix. Put the medium right again and the cell comes back — but the collagen I it laid down stays.' },
    ],
    legend: {
      fibers: 'Grey lattice: the hydrogel scaffold, fading as it dissolves. Teal haze: aggrecan. Pale ivory rods: collagen II, short and pointing every which way — a felt, not a weave. Amber rods: collagen I, longer and lined up, made only by dedifferentiated cells.',
      scaffold: 'Grey lattice: the hydrogel scaffold. Regular, because it was engineered rather than grown; it fades as it hydrolyses.',
      gel: 'Teal haze: aggrecan. It fills space and has no direction. Denser haze, more swelling pressure.',
      cells: 'Cells: teal and round while chondrogenic, orange and spindle-shaped once they have dedifferentiated. Round cells stay where they were cast; spindles crawl.',
      fields: {
        tgf: 'Teal haze: TGF-β3. Denser haze, stronger signal. Off by default; toggle it on.',
        o2: 'Blue haze: oxygen. Bright at the medium face on top, dark in the deep half where the cells have used it up.',
        m: 'Magenta haze: protease — aggrecanase and MMP-13 together. Where it is thick, aggrecan is being cut.',
      },
      load: 'Translucent arrows on the top and bottom faces: dynamic compression, three hours a day. Longer arrows, bigger squeeze.',
    },
    vocabulary: {
      matrix: 'proteoglycan and collagen',
      cellsActive: 'the chondrocytes are pumping out aggrecan',
      cellsQuiet: 'the chondrocytes have stopped making cartilage matrix',
    },
  },

  // ---- engine numerics (no passive load alignment: compression does not stretch fibres along z)
  engine: { N: 12, dt: 0.02, rhoMax: 2, kLoadFib: 0, loadExp: 2, fEvery: 4, rCell: 0.03, kRep: 0.5, trace: 'fiber' },

  // ---- tissue parameters
  params: {
    // scaffold: d scaf/dt = −[kHyd(xl)·(1 + kLoadDeg·s) + kEnz·m/(m + mK)]·(scaf + sOff),
    //           kHyd = kRG / tRG(xl),  tRG = tRGa + tRGb·xl + tRGc·xl⁴  (7 … 125 d)
    tRGa: 7, tRGb: 28, tRGc: 90, kRG: 0.357, sOff: 2.3, kLoadDeg: 0.5, kEnz: 0.0015, mK: 0.1,
    // synthesis
    sG: 0.7, sC2: 0.12, sC1: 0.45,
    tgfHalf: 0.25, fT0: 0.45,
    aStar: 0.10, aInj: 0.18, kStim: 1.0, kInj: 0.6, kEarly: 1.0, matHalf: 0.15,
    aHyp: 0.8, o2Half: 0.25, o2Anox: 0.03,
    kIL: 0.8, crowd: 2.2,
    Pcap: 1.0, kRel: 0.5,
    // matrix turnover and transport (RETENTION in the header: `free` gates the standing pool,
    // kWashNew/wC2/haloBridge gate what is washed out of a voxel as it is made)
    kGagLoss: 0.03, cRet: 0.06, gSelf: 1.2, kWash: 2, kGagDeg: 0.4, mTimp: 0.05,
    kWashNew: 0.62, haloBridge: 0.8, wC2: 2.5,
    kCol2Deg: 0.15, gProt: 0.2, kCol1Deg: 0.1, mMin: 0.02,
    Dgag: 0.04, Dcol2: 0.015,
    // fields
    kO2: 0.7, o2Km: 0.1, kTauto: 0.4, kTup: 0.05,
    mBasal: 0.35, kMxl: 20, mInfl: 8, mFib: 1.5,
    // phenotype
    phi0: 0.35, cTgf: 0.30, cHyp: 0.30, cRound: 0.25, cLoad: 0.10,
    cSpread: 0.55, cSerum: 0.30, cCat: 0.35, cInj: 0.30,
    roundHalf: 0.15, ESpread: 20, col1Half: 0.2,
    tauPhiDown: 7, tauPhiUp: 14, tauCatUp: 1, tauCatDown: 6,
    // stiffness (kPa)
    E0: 0.5, EscafA: 5, EscafB: 60, Egag: 600, EgagBase: 0.25, Ecol2Half: 0.3,
    Ecol2: 400, Ecol1: 80, kStrain: 0.5, ampRef: 0.2,
    // motility / orientation
    v0: 0.35, sigmaP: 1.5, kGuide: 3, kAlign: 0.5, polC1: 0.8,
    eps: 1e-6,
  },

  // ---- the rules
  makeRules(engine, p) {
    const iScaf = engine.speciesIndex.scaf, iGag = engine.speciesIndex.gag;
    const iCol2 = engine.speciesIndex.col2, iCol1 = engine.speciesIndex.col1;
    const fTgf = engine.fieldIndex.tgf, fO2 = engine.fieldIndex.o2, fM = engine.fieldIndex.m;
    const dXl = engine.dialIndex.xl;
    const dInfl = engine.dialIndex.infl, dSerum = engine.dialIndex.serum;
    const NV = engine.NV, N = engine.N;

    // --- pre-resolved constants
    const tgfHalf2 = p.tgfHalf * p.tgfHalf, cRet4 = Math.pow(p.cRet, 4), gSelf2 = p.gSelf * p.gSelf;
    const ESpread2 = p.ESpread * p.ESpread;
    const invAStar = 1 / p.aStar, invAInj = 1 / p.aInj;
    const fracG = p.sG / (p.sG + p.sC2), invPcap = 1 / p.Pcap;
    const invAmpRef = 1 / p.ampRef, eps = p.eps;

    // --- 6-neighbour table (zero-flux walls), shared by every engine with this N
    const nbr = cartNeighbours(N);
    // --- scratch for the pericellular → bulk spreading pass (one per reset)
    const dGag = new Float64Array(NV), dCol2 = new Float64Array(NV), mob = new Float64Array(NV);
    const spScaf = engine.species[iScaf], spGag = engine.species[iGag], spCol2 = engine.species[iCol2];
    const invh2 = 1 / (engine.h * engine.h);

    /** Explicit, mass-conserving diffusion of gag and col2 over the whole grid (see header). */
    const spreadPass = (xl) => {
      for (let v = 0; v < NV; v++) {
        const c = xl * spScaf[v], q = c >= 1 ? 0 : 1 - c;
        mob[v] = q * q;
        dGag[v] = 0; dCol2[v] = 0;
      }
      for (let v = 0; v < NV; v++) {
        const g0 = spGag[v], c0 = spCol2[v], m0 = mob[v], b = 6 * v;
        for (let d = 0; d < 6; d += 2) {           // only the +x, +y, +z neighbours: each face once
          const w = nbr[b + d];
          if (w < 0) continue;
          const k = 0.5 * (m0 + mob[w]) * invh2;
          const fg = p.Dgag * k * (spGag[w] - g0), fc = p.Dcol2 * k * (spCol2[w] - c0);
          dGag[v] += fg; dGag[w] -= fg;
          dCol2[v] += fc; dCol2[w] -= fc;
        }
      }
    };

    const stiffnessOf = (scaf, gag, col2, col1, xl, amp) => {
      const net = p.EgagBase + (1 - p.EgagBase) * col2 / (col2 + p.Ecol2Half);
      return p.E0 + (p.EscafA + p.EscafB * xl) * scaf * scaf   // percolation: E ~ (connected fraction)²
        + p.Egag * gag * Math.sqrt(gag) * net
        + p.Ecol2 * col2 * col2
        + p.Ecol1 * col1 * col1 * (1 + p.kStrain * amp * invAmpRef);
    };

    return {
      cell(ctx) {
        const out = ctx.out, dt = ctx.dt, rho = ctx.rho;
        const scaf = rho[iScaf], gag = rho[iGag], col2 = rho[iCol2], col1 = rho[iCol1];
        const tgf = ctx.field[fTgf], o2 = ctx.field[fO2];
        const amp = ctx.load, xl = ctx.dial[dXl], infl = ctx.dial[dInfl], serum = ctx.dial[dSerum];
        let phi = ctx.a, cat = ctx.b, halo = ctx.c;

        // --- mesh confinement: 0 open, 1 tight
        const conf = xl * scaf > 1 ? 1 : xl * scaf;
        const open = 1 - conf, bulk = open * open;

        // --- modulating functions
        const hT = tgf * tgf / (tgf * tgf + tgfHalf2);
        const fT = p.fT0 + (1 - p.fT0) * hT;
        const u = amp * invAStar, u2 = u * u, q1 = 1 + u2;
        const sLoad = 4 * u2 / (q1 * q1);                       // biphasic bump, peak at aStar
        const w2 = amp * invAInj * amp * invAInj, w4 = w2 * w2;
        const dInj = w4 / (1 + w4);                             // injury above ~aInj
        const mHere = gag + col2 + halo;
        const matPresent = mHere / (mHere + p.matHalf);
        let fL = 1 + p.kStim * sLoad * (1 - dInj) * matPresent - p.kInj * dInj
          - p.kEarly * sLoad * conf * (0.5 + 0.5 * hT);
        if (fL < 0) fL = 0;
        const hyp = 1 - o2 / (o2 + p.o2Half);
        const fO = (1 + p.aHyp * hyp) * o2 / (o2 + p.o2Anox);
        const fI = 1 - p.kIL * cat;
        let fC = 1 - (gag + col2) / p.crowd;
        fC = fC <= 0 ? 0 : fC * fC;

        // --- synthesis (density/day into this voxel, or into the halo while the mesh is tight)
        const anab = phi * phi * fT * fL * fO * fI * fC;
        const sGag = p.sG * anab, sCol2 = p.sC2 * anab;
        const one = 1 - phi;
        const sCol1 = p.sC1 * one * one * (0.5 + 0.5 * hT) * fI * fC;

        const rel = p.kRel * bulk * bulk * halo;                  // halo → voxel as the mesh opens
        let toHalo = (1 - bulk) * (sGag + sCol2);
        if (halo >= p.Pcap) toHalo = 0;                          // saturated: further confined synthesis is wasted
        out.c = halo + (toHalo - rel) * dt;

        // --- fresh matrix has to be caught by something: the intact mesh, the pericellular island
        //     the cell is sitting in, or a collagen II network. What is not caught washes out, and
        //     a squeeze washes out more (Schneider 2017/2020, Kisiday 2004, Roberts 2011).
        //     Procollagen II is the more fragile of the two: it has to be assembled into fibrils
        //     where it is made, so a factor wC2 more of it is lost from an unsupported voxel.
        const hc = halo * invPcap * p.haloBridge;
        const c22 = col2 * col2, c2n = c22 * c22 / (c22 * c22 + cRet4), gn = gag * gag / (gag * gag + gSelf2);
        const hold = scaf + (1 - scaf) * (1 - (1 - c2n) * (1 - gn) * (1 - hc));
        let wf = p.kWashNew * (1 - hold) * (1 + p.kWash * sLoad);
        wf = wf <= 0 ? 0 : (wf > 0.9 ? 0.9 : wf);
        let wf2 = wf * p.wC2;
        if (wf2 > 0.95) wf2 = 0.95;

        out.secrete[iGag] = bulk * sGag + rel * fracG;            // deposited, then washed by voxel()
        out.secrete[iCol2] = bulk * sCol2 * (1 - wf2) + rel * (1 - fracG);
        out.secrete[iCol1] = sCol1;
        out.aSum = wf * bulk * sGag;                             // voxel() removes this again as loss

        // --- orientation: collagen II is laid down isotropically, collagen I along the polarity
        const fib = bulk * sCol2 + rel * (1 - fracG) + sCol1;
        out.pol = fib > eps ? p.polC1 * one * sCol1 / fib : 0;
        out.align = p.kAlign * one * col1 / (col1 + col2 + 0.05);

        // --- fields: TGF-β3 uptake and autocrine release, oxygen consumption, protease
        out.fieldSrc[fTgf] = p.kTauto * phi * sLoad - p.kTup * tgf;
        out.fieldSrc[fO2] = -p.kO2 * o2 / (o2 + p.o2Km);
        out.fieldSrc[fM] = p.mBasal * (1 + p.kMxl * conf) + p.mInfl * infl * infl + p.mFib * one;

        // --- phenotype: round in a gel, spread on a stiff fibrous matrix
        let round = scaf + gag / (gag + p.roundHalf);
        round = round > 1 ? 1 : round;
        const Ev = ctx.E;
        const spread = (1 - round) * (Ev * Ev / (Ev * Ev + ESpread2)) * col1 / (col1 + p.col1Half);
        let phiStar = p.phi0 + p.cTgf * hT + p.cHyp * hyp + p.cRound * round
          + p.cLoad * sLoad * (1 - dInj)
          - p.cSpread * spread - p.cSerum * serum - p.cCat * cat - p.cInj * dInj;
        phiStar = phiStar < 0 ? 0 : (phiStar > 1 ? 1 : phiStar);
        const tauPhi = phiStar < phi ? p.tauPhiDown : p.tauPhiUp;
        phi += (phiStar - phi) * (dt / tauPhi < 1 ? dt / tauPhi : 1);
        const tauC = infl > cat ? p.tauCatUp : p.tauCatDown;
        cat += (infl - cat) * (dt / tauC < 1 ? dt / tauC : 1);
        out.a = phi; out.b = cat;

        // --- motility: chondrocytes are pinned; dedifferentiated cells on cleared matrix crawl
        out.speed = p.v0 * one * one * (1 - (scaf > 1 ? 1 : scaf));
        out.guide = p.kGuide * one;
        out.noise = p.sigmaP * one;
      },

      voxel(ctx) {
        const out = ctx.out, rho = ctx.rho, v = ctx.v;
        const scaf = rho[iScaf], gag = rho[iGag], col2 = rho[iCol2], col1 = rho[iCol1];
        const amp = ctx.load, xl = ctx.dial[dXl];
        const mRaw = ctx.field[fM], m = mRaw > p.mTimp ? mRaw - p.mTimp : 0;   // TIMP-buffered
        if (v === 0) spreadPass(xl);                             // whole-grid pass, once per step

        const conf = xl * scaf > 1 ? 1 : xl * scaf;
        const u = amp * invAStar, u2 = u * u, q1 = 1 + u2, sLoad = 4 * u2 / (q1 * q1);

        // --- scaffold: bulk hydrolysis (clock set by the crosslink dial) + cell enzyme
        const kHyd = p.kRG / (p.tRGa + p.tRGb * xl + p.tRGc * xl * xl * xl * xl);
        const dScaf = -(kHyd * (1 + p.kLoadDeg * sLoad) + p.kEnz * mRaw / (mRaw + p.mK)) * (scaf + p.sOff);

        const wash = ctx.aSum;                                   // fresh aggrecan washed out (see cell())

        // --- aggrecan: escape of the standing pool to the medium (the literal evaporation) + protease
        const c22 = col2 * col2;
        const free = (1 - scaf) * (1 - c22 * c22 / (c22 * c22 + cRet4))
          * (1 - gag * gag / (gag * gag + gSelf2));
        const gagLoss = p.kGagLoss * free * (1 + p.kWash * sLoad) * gag + p.kGagDeg * m * gag + wash;
        // --- collagen II: slow, and shielded while there is aggrecan around it
        const col2Loss = p.kCol2Deg * m * col2 * (1 - gag / (gag + p.gProt));
        // --- collagen I: as in the fibrous tissue, slow
        const col1Loss = p.kCol1Deg * (p.mMin + m) * col1;

        out.dRho[iScaf] = dScaf;
        out.dRho[iGag] = dGag[v] - gagLoss;
        out.dRho[iCol2] = dCol2[v] - col2Loss;
        out.dRho[iCol1] = -col1Loss;
        out.loss = gagLoss + col2Loss + col1Loss;                // the scaffold is neither built nor eaten
        out.E = stiffnessOf(scaf, gag, col2, col1, xl, amp);
      },

      stiffness(ctx) {
        ctx.out.E = stiffnessOf(ctx.rho[iScaf], ctx.rho[iGag], ctx.rho[iCol2], ctx.rho[iCol1],
          ctx.dial[dXl], ctx.load);
      },
    };
  },
};

/** 6-neighbour index table for an N³ grid (−1 at a wall), cached per N. */
const CART_NBR = new Map();
function cartNeighbours(N) {
  let t = CART_NBR.get(N);
  if (t) return t;
  const N2 = N * N, NV = N2 * N;
  t = new Int32Array(6 * NV);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        const v = (i * N + j) * N + k, b = 6 * v;
        t[b] = i < N - 1 ? v + N2 : -1; t[b + 1] = i > 0 ? v - N2 : -1;
        t[b + 2] = j < N - 1 ? v + N : -1; t[b + 3] = j > 0 ? v - N : -1;
        t[b + 4] = k < N - 1 ? v + 1 : -1; t[b + 5] = k > 0 ? v - 1 : -1;
      }
    }
  }
  CART_NBR.set(N, t);
  return t;
}
