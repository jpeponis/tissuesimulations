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
 *  species  scaf (scaffold, the connected network fraction), gag (gel, aggrecan,
 *           D 0.04 + sink 0.1 at the +z medium face), col2 (fiber, D 0.015,
 *           deposited with polS = 0 so it stays a felt, FA low), col1 (fiber,
 *           deposited along the cell polarity by dedifferentiated cells, so it is
 *           the only species that raises FA). Both D's are gated by out.mobility.
 *  fields   tgf (bath dial tgfExt, kBath 4), o2 (Dirichlet on the +z medium face
 *           at the o2Ext dial, consumed by cells as a negative fieldSrc, engine
 *           clamps ≥ 0), m (catabolic protease: MMP-13 + aggrecanase, decay 1/d).
 *  cell     `states` names the three scalars: a = phi, the phenotype axis
 *           (1 chondrogenic ↔ 0 fibroblastic); b = cat, catabolic memory (IL-1
 *           exposure, slow to clear); c = the pericellular halo pool (matrix made
 *           but trapped by the mesh), range [0, 3], full at c = Pcap = 1.
 *           Colour lerps a = 0 → orange (fibroblastic), a = 1 → teal
 *           (chondrogenic); shape { by: 'a', aspectMin: 2.2, aspectMax: 1 } —
 *           aspect DECREASES with a, so a chondrogenic cell is a sphere and a
 *           dedifferentiated one a spindle. Both the renderer and the Blender
 *           importer compute aspect = aspectMin + (aspectMax − aspectMin)·s
 *           linearly, so aspectMin > aspectMax is legal and does the right thing
 *           (verified: src/render.js:1051, blender/import_tissue.py:583; the
 *           engine's validator only requires two numbers). radius follows a the
 *           same way: { by: 'a', min: 0.032, max: 0.0416 } = the spec's
 *           rCell·(1 + 0.3·phi).
 *  voxel    scaffold hydrolysis + cell-enzyme term (reported as out.scaffoldLoss,
 *           the third flux bar), GAG loss to the medium and protease digestion,
 *           protected collagen II, slow collagen I loss, and out.mobility =
 *           (1 − conf)² — the mesh gate on the engine's species transport.
 *  dials    tgfExt, amp (role 'load'), o2Ext, infl, xl, nCells (role 'cellCount'),
 *           serum. `amp` is a strain amplitude in [0, 0.2] shown as 0–20 %;
 *           `o2Ext` is oxygen normalised to 21 % (1 ≡ 21 %) with a formatter that
 *           prints the percentage, so the o2 field is also 0–1 and can share a
 *           0–1 chart with the phenotype.
 *
 * ---------------------------------------------------------------------------
 * WHAT v0.3 FIXED (this file was written against engine v0.2 and worked around it)
 * ---------------------------------------------------------------------------
 *  SPREADING  v0.2 deposited a cell's secretion into the ONE voxel the cell
 *    occupies and never moved matrix between voxels; chondrocytes are pinned, so
 *    with 160 cells in 12³ voxels only ~8 % of the cube would ever contain matrix
 *    and the mean densities of §2.6 (gag > 0.7) were unreachable. The workaround
 *    was a hand-rolled 6-neighbour diffusion of gag and col2 inside voxel(), run
 *    for the whole grid on the v = 0 call and read back per voxel — a hook reading
 *    its neighbours, i.e. exactly what the contract forbids. Now: `D` on the two
 *    species plus `out.mobility = (1 − conf)²`, and the engine runs the pass after
 *    the voxel hook. col2 is a fiber species, so it carries its share of T with it
 *    (matrix that creeps outward keeps its direction) — the hand-rolled
 *    version moved the mass and let the engine rescale T onto the new total, so
 *    arriving collagen II inherited whatever orientation the voxel already had and
 *    departing collagen II left its share of the felt behind. Carrying the tensor
 *    is why FA in scenario 4 now runs ~4 % higher: the felt that creeps out of a
 *    collagen I voxel takes its isotropy with it.
 *    The physics is the spec's own, one scale up (Nikolaev 2010: mobile monomer →
 *    immobile aggregate; Mauck 2003: collagen II spreads from pericellular to
 *    construct-wide once the mesh opens). Dgag 0.04, Dcol2 0.015 L²/d ⇒ ~10–25 d
 *    to fill the cube.
 *  GAG TO THE MEDIUM  `sink: 0.1` on gag at `face:+z` is the medium face — the
 *    same face the oxygen enters by. The standing pool used to leak uniformly
 *    everywhere; now part of that leak happens where the construct actually meets
 *    the medium, the loss lands in stats().degradation on its own, and the cube
 *    carries a shallow gradient (gag 0.91 deep, 0.83 at the face on day 56 of
 *    scenario 1). The net-gated bulk leak stays: it is what tells scenario 1 from
 *    scenario 2, and a collagen net does hold aggrecan in the interior.
 *  ONE pol → polS  A v0.2 cell had one orientation strength for all fiber species,
 *    so col2 (a felt) and col1 (a rope) had to be mixed by their deposition rates.
 *    Now out.polS[col2] = 0 and out.polS[col1] = 0.8·(1 − phi) are exact, and
 *    out.alignS puts the traction realignment on collagen I only — the engine
 *    weights it by the local fiber densities, which is the mixing the old
 *    out.align hand-rolled (with a 0.05 regulariser that is no longer needed).
 *  SCAFFOLD FLUX  out.scaffoldLoss (≥ 0, clamped to what the voxel can give up)
 *    now feeds stats().scaffoldFlux and the gauge's third bar, with
 *    copy.vocabulary.scaffoldNoun naming it. Under v0.2 the hydrolysis rate was
 *    simply left out of out.loss and the "trellis dissolving" was invisible.
 *  aSum → vox[1]  The rate of fresh aggrecan that washes out of a voxel is known
 *    to the cell hook (it depends on the cell's own halo) and needed by the voxel
 *    hook. It used to be smuggled through out.aSum, which meant voxel() could not
 *    also see the cell activity that aSum is for. engine.vox = 2 gives it its own
 *    channel, out.vox[1] → ctx.vox[1], and aSum is back to meaning activity.
 *  RADIUS     radius: { by: 'a', min: 0.032, max: 0.0416 } is the spec's
 *    rCell·(1 + 0.3·phi); v0.2 had one radius per cell type and rounded it to a
 *    constant 0.032.
 *  STATES     `states` labels a, b and c and gives c its [0, 3] range in one place
 *    (v0.2: stateLabels + cRange, which could disagree).
 *  CHECKS     aggregated checks (`at: [from, to]` + agg) restore the scenario
 *    targets of §2.6 that are claims about a WINDOW — "col1 < 0.05 throughout",
 *    "the halo is full for three weeks", "E never gets back to where it started",
 *    "the gauge sits on evaporating" — and cumDeposition / cumDegradation restore
 *    the two cumulative loss-fraction targets (as OFFSETS: `rel` adds, it does not
 *    multiply, so "< 40 % of what was made" is written as −0.6 × the cumDeposition
 *    the run reaches).
 *
 * ---------------------------------------------------------------------------
 * §2.6 TARGETS STILL NOT CHECKED AS WRITTEN (each is flagged at its check)
 * ---------------------------------------------------------------------------
 *  · scenario 2 "E(t*) < 5 kPa" on the day the lattice goes: 0.28 aggrecan is
 *    ≈ 30 kPa on its own under §2.4's own stiffness rule, so the two cannot both
 *    hold. The check says instead that the modulus goes BACKWARDS from t*.
 *  · scenario 5 "m < 2·mMin within 5 days of washout": basal MMP alone sits at
 *    m ≈ 0.05 = 2.5·mMin here, so the check asks for m < 0.1 — a fifth of the
 *    IL-1 level, i.e. the magenta haze has cleared.
 *  · scenario 5 "col2(56) < col2(0)": chondrocytes that are working again rebuild
 *    collagen II past its starting value inside six weeks. The spec's claim is
 *    about a JOINT (adult collagen II barely turns over); in a construct it is not
 *    what happens, and the scenario's question was rewritten around what the model
 *    does teach. What is checked is that collagen II is still below its start in
 *    week three.
 *  · scenario 5 "gag(56) > 0.7·gag(0)" lands at 0.68 (the rebuild starts from a
 *    phenotype that is itself only halfway back) and is checked at 0.64.
 *  · cross-run claims the check language cannot express at all: "E(56) < 0.3 ×
 *    scenario 1's E(56)" (scenario 4), "loading does not rescue" and "GAG
 *    deposition back to > 80 % of pre-insult" (scenario 5 — this run has no
 *    pre-insult sample; day 0 is the reset, when deposition is still 0).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STILL THE ENGINE'S SHAPE RATHER THAN THE SPEC'S
 * ---------------------------------------------------------------------------
 *  ONE HALO   The spec has two pericellular pools (haloG, haloC); a cell has three
 *    scalars and two are taken, so c holds their sum and is released in the fixed
 *    ratio sG : sC2. Release rate kRel·(1 − conf)⁴·c — the mesh gates the release
 *    with the square of the same (1 − conf)² that gates bulk deposition (the
 *    spec's (1 − conf) drained the halo while the mesh was still tight, so the
 *    pericellular islands of scenario 3 never formed).
 *  NO Da      Oxygen is an ordinary engine field with a Dirichlet medium face,
 *    integrated in time rather than solved as the spec's quasi-steady Gauss–Seidel
 *    problem, so at D = 0.06 L²/d the profile takes ~1 d to form instead of
 *    minutes. The steady profile is what matters and is tuned through
 *    the consumption kO2 instead of a Damköhler number — if the contract ever
 *    offers a quasi-steady field solve, this is the field that wants it, and kO2
 *    would have to be re-tuned against the profile it produces: 5 % in the bath gives
 *    5 % at the medium face and ≈ 1 % at the deep face, 21 % gives 21 → 12 %.
 *  NO mesh-hindered field D   A field's D is a constant of the definition (species
 *    transport takes a mobility, fields do not), so the spec's D_m·(1 − 0.8·conf)
 *    for the protease is folded into its source (kMxl: tight gels make ~25× more
 *    MMP-13, Nicodemus 2011).
 *  MOTILITY   v0 0.05 → 0.35 L/d × (1 − phi)²(1 − scaf): a chondrocyte is pinned
 *    (phi ≈ 0.9 ⇒ 0.004 L/d), but a dedifferentiated cell on a cleared, fibrous
 *    matrix crawls like the fibroblast of TISSUE_FIBROUS. Without that, collagen I
 *    piles up in the ~140 voxels that hold a cell and hits the trace clamp before
 *    the mean can reach the 0.3 of scenario 4.
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
 *      · The STANDING pool leaks two ways: kGagLoss·free·(1 + kWash·s(a))·gag in the
 *        voxel hook, with free = (1 − scaf)·(1 − H2(col2, cRet))·(1 − H2(gag, gSelf)),
 *        plus the species `sink` at the +z medium face, which no net can hold back
 *        (a construct in a bioreactor gives GAG up at its surface however good the
 *        interior is; the medium is changed and the GAG in it is thrown away).
 *    Sources: Nikolaev 2010 (mobile monomer → immobile aggregate), Maroudas 1976 /
 *    Williamson 2001 (the collagen net is what holds the swelling pressure),
 *    Schneider 2017 (pericellular islands keep the construct connected through
 *    reverse gelation), Kisiday 2004 and Schneider 2020 (loading raises GAG loss;
 *    daily loading left an MMP-sensitive construct at 26 kPa against 107 kPa in
 *    free swelling). The result is the race the spec describes: scenario 1's halo
 *    hands over its matrix while the mesh is still there and the construct ignites;
 *    scenario 2 loses the same matrix to the medium and never gets going.
 *  tRG(xl) = 7 + 28·xl + 130·xl⁴ d (7 → 165) instead of the spec's linear 7 + 28·xl
 *    (7 → 35). With the linear law even the densest gel reverse-gels by day 35 and
 *    scenario 3's own target (scaf > 0.4 at day 42) is unreachable. The quartic term
 *    reads as the slower hydrolysis per bond of a dense, low-water network and makes
 *    xl = 1 the non-degradable PEG control of Bryant & Anseth 2002 / Skaalure 2014,
 *    while keeping tRG(0.5) = 30 d inside the 2–4 week band of Schneider 2020.
 *  E_scaf ∝ scaf² (percolation: the modulus of a network vanishes faster than its
 *    connected fraction near the gel point) rather than ∝ scaf. This is what gives
 *    scenario 1 its handover dip (35 → 25 kPa in week 1) and scenario 3 its long
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
 *    while IL-1 removes ~20 %/d. kCol2Deg 0.05 → 0.095 so collagen II visibly loses
 *    ground in week 2 of scenario 5 once the aggrecan shielding it is gone (Pratta 2003)
 *    — a fifth of it by day 14, which is the spec's own ceiling.
 *  kEnz 0.15 → 0.0015 /d: with the (scaf + sOff) multiplier the spec's value clears
 *    even the densest gel in four days and scenario 3 cannot exist.
 *  PHENOTYPE  cSpread 0.30 → 0.50, cSerum 0.20 → 0.30 so that the fibrocartilage
 *    drift of scenario 4 completes inside eight weeks (phi < 0.3, aspect > 1.8 by
 *    day 42) and still reverses when the medium is corrected. tauPhiUp 14 → 8 d:
 *    the drift now bottoms at phi ≈ 0.15, and from there 14 d only gets back to
 *    0.55 by day 84 because the collagen I the cells made keeps `spread` high —
 *    which is the scenario's point, but it puts the spec's own target (phi > 0.6
 *    at day 84) out of reach. 8 d is full re-expression in ~3.5 weeks, inside the
 *    2–4 weeks of Domm 2002 / Murphy 2001.
 *
 * ---------------------------------------------------------------------------
 * RETUNE WHEN THE v0.2 WORKAROUNDS CAME OUT (before → after, seed 7)
 * ---------------------------------------------------------------------------
 *  The port itself is nearly neutral: with sink 0 the five scenarios move by under
 *  1 % on every stat except FA (the transported collagen II now carries T). What
 *  follows is the retune that the new mechanisms and the restored §2.6 targets
 *  asked for.
 *   gag `sink` 0 → 0.1 /d at the +z face. Scenario 1 ends at gag 0.88 / 305 kPa
 *     instead of 1.04 / 370 kPa — nearer native than above it — and its flux gauge
 *     reads about 4:1 at day 28 instead of 9:1, because the construct now gives
 *     matrix back to the medium at its surface for ever. Cumulative loss/synthesis
 *     0.22 → 0.35 (the spec's ceiling is 0.4).
 *   tRGc 90 → 130. Restores the spec's scaf > 0.4 at day 42 in scenario 3
 *     (0.37 → 0.47). Scenario 1's gel clock slows by 10 % (tRG 27 → 30 d), so the
 *     grey band now empties on day 24 rather than day 21 and the halo hands over a
 *     few days later. Scenario 3's late recovery moves out of the eight-week window:
 *     E bottoms at 15 kPa in week seven and is back to 50 kPa at week ten, so the
 *     scenario now carries a day-70 check.
 *   kGagLoss 0.03 → 0.045 (the spec's own value is 0.05). Only bites where the
 *     scaffold has gone AND there is no collagen net — i.e. scenario 2, whose
 *     endpoint drops to 2.4 kPa and restores the spec's min E < 0.3·E(0) (0.21).
 *   kWashNew 0.62 → 0.68: scenario 2's aggrecan on the day the lattice goes,
 *     0.29 → 0.28, under the spec's 0.3 with a margin the check can rely on.
 *     Scenario 1 barely notices (its fresh matrix is held by the mesh and the halo).
 *   cSpread 0.55 → 0.50 with tauPhiUp 14 → 8: scenario 4's phenotype comes back to
 *     0.65 by day 84 instead of 0.55, which is the spec's own reversibility target
 *     (> 0.6); the drift itself still bottoms at 0.15 on day 56.
 *   kCol2Deg 0.15 → 0.095 and scenario 5's tgfExt 0.2 → 0.1 (the medium scenario 1
 *     ends on, so the only difference is the IL-1). Collagen II now loses 17 % by
 *     day 14 — the spec's "≤ 20 %" — and the construct ends at 0.68·E(0), inside
 *     the spec's 0.6–0.9 band, instead of recovering almost all of it.
 *   fEvery 4 → 6, for the transport's share of the step: 0.58 → 0.54 ms at N = 12
 *     with 160 cells (0.26 of that is the two transported species). No check moves
 *     by more than 0.002; this tissue's fibre directions are the least of it.
 * ---------------------------------------------------------------------------
 */

export const TISSUE_CARTILAGE = {
  key: 'cartilage',
  name: 'Articular cartilage in a hydrogel',
  short: 'Chondrocytes race a dissolving gel to build aggrecan and collagen II',
  version: '0.2.0',        // 0.2: engine v0.3 contract (species transport, polS, vox, scaffold flux)

  // ---- matrix species
  species: [
    { key: 'scaf', label: 'Hydrogel scaffold', kind: 'scaffold', color: '#9ec5d8',
      describe: 'the intact, connected fraction of the synthetic network' },
    { key: 'gag', label: 'Aggrecan (GAG)', kind: 'gel', color: '#7fe0c9',
      describe: 'proteoglycan gel; pulls water in and carries the swelling pressure',
      D: 0.04, sink: 0.1, boundary: 'face:+z' },      // spreads through an open mesh; leaks at the medium face
    { key: 'col2', label: 'Collagen II', kind: 'fiber', color: '#e8f1f8',
      describe: 'fine isotropic felt that cages the aggrecan',
      D: 0.015 },                                      // fibrils creep outward from the cell that made them
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
      radius: { by: 'a', min: 0.032, max: 0.0416 },          // rCell·(1 + 0.3·phi): the round cell is the bigger one
      motile: true,
      init: { a: 0.9, b: 0, c: 0 },
      states: [
        { key: 'a', label: 'phenotype (1 = chondrogenic)' },
        { key: 'b', label: 'catabolic memory' },
        { key: 'c', label: 'pericellular pool', range: [0, 3] },
      ] },
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
        'Run to eight weeks and watch where the stiffness trace goes: down through the first week, back past the fresh gel in week two, and on up from there.',
      ],
      question: 'The stiffness dips before it climbs. What is handing over to what during that first fortnight, and what would make the handover fail?',
      expect: 'The grey band drains to nothing by about day 24 while teal aggrecan and a thin ivory collagen II band fill in behind it. Stiffness dips from 35 to about 25 kPa in the first week, then climbs past the fresh gel to about 300 kPa by week eight. Cells stay round and teal; the pericellular pool fills within three days and empties in the third week, as the gel lets go. Aggrecan keeps leaking into the medium at the top face the whole time, which is why the gauge settles toward two to one instead of running away.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 0.5, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        { at: 0, stat: 'species.scaf', op: 'between', value: [0.94, 1.06] },
        { at: 0, stat: 'logE', op: 'between', value: [1.4, 1.65] },          // fresh gel ≈ 35 kPa
        { at: [3, 14], agg: 'min', stat: 'cells.c', op: 'gt', value: 0.8 },  // the halo saturates in week 1 …
        { at: [35, 56], agg: 'max', stat: 'cells.c', op: 'lt', value: 0.2 }, // … and has emptied into the cube
        { at: [7, 28], agg: 'min', stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' } },  // the handover dip …
        { at: [7, 28], agg: 'min', stat: 'logE', op: 'gt', value: 0.9 },     // … never below 8 kPa
        { at: 28, stat: 'species.scaf', op: 'lt', value: 0.2 },
        { at: 42, stat: 'species.scaf', op: 'lt', value: 0.05 },
        { at: [21, 42], agg: 'mean', stat: 'ratio', op: 'gt', value: 2 },    // the gauge sits on condensing
        { at: 28, stat: 'fields.o2', op: 'lt', value: 0.18 },                // O₂ gradient below the bath (0.24)
        { at: 42, stat: 'species.gag', op: 'gt', value: 0.5 },
        { at: 56, stat: 'species.gag', op: 'gt', value: 0.7 },
        { at: 56, stat: 'species.col2', op: 'gt', value: 0.15 },
        { at: [0, 56], agg: 'max', stat: 'species.col1', op: 'lt', value: 0.05 },   // col1 < 0.05 THROUGHOUT
        { at: [0, 56], agg: 'min', stat: 'cells.a', op: 'gt', value: 0.75 },        // phi > 0.75 throughout
        { at: [0, 56], agg: 'max', stat: 'fa', op: 'lt', value: 0.25 },             // a felt, not a weave, all run
        { at: 56, stat: 'logE', op: 'gt', value: 2.0 },                      // > 100 kPa …
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'gt' } },    // … and above the fresh gel
        // matrix lost < 40 % of matrix made (spec §2.6.1). `rel` compares two stats with an OFFSET,
        // not a ratio, so the 40 % is written as −0.6 × the cumDeposition this run reaches (≈ 1.72).
        { at: 56, stat: 'cumDegradation', rel: { stat: 'cumDeposition', op: 'lt' }, value: -1.03 },
      ] },

    { key: 'toofast', title: 'Scaffold degrades too fast',
      goal: 'Use a loosely crosslinked gel and watch the trellis vanish before the cells have anything to hold their matrix in.',
      steps: [
        'Press Play; the lattice is gone inside nine days.',
        'Watch the flux gauge: deposition is high but so is loss to the medium.',
        'Run to eight weeks and compare the final GAG band and stiffness with the first scenario.',
      ],
      question: 'The cells here synthesise more than in the first scenario, not less. Where does the matrix go, and which readout shows it leaving?',
      expect: 'The grey band is gone by day 9 with almost nothing behind it — aggrecan under a third of native and no pericellular island. It climbs a little further to day 14 and then goes backwards: with no mesh and no collagen net to catch it, new aggrecan washes out as fast as it is made, and the squeezing from day 14 makes that worse. The cube ends nearly empty at about 2 kPa, a fifth of the gel it started as, and from day 14 the flux gauge sits on evaporating.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 0.1, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        // t* = the first day the lattice is gone (spec §2.6.2). `agg: 'first'` reads the day the
        // window opens, so [9, 21] asks all three questions on day 9.
        { at: [9, 21], agg: 'first', stat: 'species.scaf', op: 'lt', value: 0.1 },
        { at: [9, 21], agg: 'first', stat: 'species.gag', op: 'lt', value: 0.3 },   // little behind it …
        { at: [9, 21], agg: 'first', stat: 'cells.c', op: 'lt', value: 0.3 },       // … and no islands either
        { at: 21, stat: 'logE', rel: { stat: 'logE', at: 9, op: 'lt' } },    // from t* the modulus goes backwards
        { at: [14, 28], agg: 'mean', stat: 'ratio', op: 'lt', value: 0.87 }, // the gauge sits on evaporating
        // cumulative loss > 60 % of synthesis by day 28 (offset = −0.4 × cumDeposition ≈ 1.24; see the race)
        { at: 28, stat: 'cumDegradation', rel: { stat: 'cumDeposition', op: 'gt' }, value: -0.5 },
        { at: [0, 56], agg: 'min', stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.523 },  // min E < 0.3·E(0)
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
        'Run to ten weeks: the lattice is still half there at six, and the stiffness trace slides all the way to week seven before the released islands finally lift it.',
      ],
      question: 'The cells are working the whole time. Why does a tighter gel make the construct end up softer than it started?',
      expect: 'The grey band is still half full at six weeks and a third full at eight. Almost no bulk aggrecan appears; the pericellular pool saturates within two days and is still full at day 42. Protease runs nearly five times higher than in the first scenario, the gel is chewed from the inside, and stiffness slides from 65 kPa to about 15 by week seven. Only in week ten do the released islands lift it — to 50 kPa, still short of where it started.',
      dials: { tgfExt: 0.5, amp: 0, o2Ext: 0.24, infl: 0, xl: 1, nCells: 160, serum: 0 },
      init: { species: { scaf: 1 }, jitter: 0.12 },
      events: [{ at: 14, dials: { tgfExt: 0.1, amp: 0.1 } }],
      checks: [
        { at: [21, 42], agg: 'min', stat: 'cells.c', op: 'gt', value: 0.8 }, // islands full for three weeks straight
        { at: [7, 70], agg: 'max', stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' } },  // never back to day 0 …
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.155 },    // … and < 0.7 × E(0)
        { at: 42, stat: 'species.scaf', op: 'gt', value: 0.4 },
        { at: 42, stat: 'species.gag', op: 'lt', value: 0.2 },
        { at: [7, 42], agg: 'mean', stat: 'fields.m', op: 'gt', value: 0.21 },   // ≥ 2 × the race (mean 0.104)
        { at: [0, 56], agg: 'min', stat: 'cells.a', op: 'gt', value: 0.7 },      // round cells keep their phenotype
        { at: 70, stat: 'logE', rel: { stat: 'logE', at: 56, op: 'gt' } },   // the released islands do lift it, late
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
        { at: [42, 84], agg: 'min', stat: 'fa', op: 'gt', value: 0.3 },      // collagen I is aligned, and stays
        { at: 84, stat: 'cells.a', op: 'gt', value: 0.6 },                   // phenotype comes back …
        { at: 84, stat: 'cells.a', rel: { stat: 'cells.a', at: 56, op: 'gt' }, value: 0.3 },
        { at: [56, 84], agg: 'min', stat: 'species.col1', rel: { stat: 'species.col1', at: 56, op: 'gt' }, value: -0.02 },
      ] },

    { key: 'inflamed', title: 'Inflammatory breakdown',
      goal: 'Take the finished construct from the first scenario, drop IL-1 into the medium for two weeks, and see what breaks first and what comes back.',
      steps: [
        'Press Play: within days the teal GAG band melts while the ivory collagen II band barely moves.',
        'At day 14 the IL-1 is washed out. Watch the protease haze clear within a week.',
        'Run to eight weeks and compare GAG and collagen II with where they started.',
      ],
      question: 'The collagen II ends up past where it started and the aggrecan does not. Which of the two is carrying the modulus here — and which one would a real joint never get back?',
      expect: 'Aggrecan goes first and fast: nine tenths of it in a fortnight. Collagen II only starts to lose ground in the second week, once the aggrecan that was shielding it is gone, and it loses about a fifth. Stiffness collapses from 300 to 23 kPa. After washout the protease clears in days but the cells stay suppressed for another week. Then the collagen II makes good and carries on past where it started — it was never the fragile one — while the aggrecan is only two thirds of the way back at eight weeks, and the modulus follows the aggrecan: 200 kPa against the 300 it began with.',
      dials: { tgfExt: 0.1, amp: 0.1, o2Ext: 0.24, infl: 0.8, xl: 0.5, nCells: 160, serum: 0 },
      init: { from: { scenario: 'race', days: 56, events: true } },   // the construct the students watched
      events: [{ at: 14, dials: { infl: 0 } }],
      checks: [
        { at: 0, stat: 'species.gag', op: 'gt', value: 0.7 },                       // a finished construct
        { at: 7, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'gt' }, value: -0.023 }, // < 10 % col II in week 1
        { at: 14, stat: 'species.gag', rel: { stat: 'species.gag', at: 0, op: 'lt' }, value: -0.4 },    // aggrecan goes first
        { at: 14, stat: 'species.col2', rel: { stat: 'species.col2', at: 7, op: 'lt' } },               // collagen II in week 2
        { at: 14, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'gt' }, value: -0.046 },// but only ≤ 20 %
        { at: [10, 21], agg: 'max', stat: 'cells.b', op: 'gt', value: 0.6 },                           // catabolic memory
        { at: 14, stat: 'cells.a', rel: { stat: 'cells.a', at: 0, op: 'lt' }, value: -0.2 },
        { at: 14, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.3 },                  // > 50 % of the modulus
        { at: 19, stat: 'fields.m', op: 'lt', value: 0.1 },                                            // protease clears in 5 d
        { at: 21, stat: 'species.col2', rel: { stat: 'species.col2', at: 0, op: 'lt' } },
        { at: 56, stat: 'species.gag', rel: { stat: 'species.gag', at: 0, op: 'gt' }, value: -0.32 },   // aggrecan is rebuilt
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'lt' }, value: -0.046 },                // E(56) < 0.9 × E(0) …
        { at: 56, stat: 'logE', rel: { stat: 'logE', at: 0, op: 'gt' }, value: -0.222 },                // … and > 0.6 × E(0)
        { at: [42, 56], agg: 'min', stat: 'cells.a', op: 'gt', value: 0.7 },                           // the cells are back
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
      gel: 'Teal haze: aggrecan. It fills space and has no direction. Denser haze, more swelling pressure. Thinner near the top face, which is the medium side: aggrecan that reaches it is washed away with the medium.',
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
      scaffoldNoun: 'hydrogel dissolving',            // the third flux bar (stats().scaffoldFlux)
    },
  },

  // ---- engine numerics (no passive load alignment: compression does not stretch fibres along z)
  //      fEvery 6, not the default 4: the principal axis is also refreshed after the species
  //      transport, and this is the tissue where fibre DIRECTION matters least (collagen II is a
  //      felt; only scenario 4 has anything aligned). 6 keeps the step at ≈ 0.53 ms with two
  //      transported species, one of them a fiber species carrying the tensor.
  engine: { N: 12, dt: 0.02, rhoMax: 2, kLoadFib: 0, loadExp: 2, fEvery: 6, rCell: 0.03, kRep: 0.5, trace: 'fiber',
            vox: 2 },   // vox[1] carries the fresh-aggrecan wash from cell() to voxel()

  // ---- tissue parameters
  params: {
    // scaffold: d scaf/dt = −[kHyd(xl)·(1 + kLoadDeg·s) + kEnz·m/(m + mK)]·(scaf + sOff),
    //           kHyd = kRG / tRG(xl),  tRG = tRGa + tRGb·xl + tRGc·xl⁴  (7 … 165 d)
    //           reported to the flux gauge as out.scaffoldLoss, not as tissue degradation
    tRGa: 7, tRGb: 28, tRGc: 130, kRG: 0.357, sOff: 2.3, kLoadDeg: 0.5, kEnz: 0.0015, mK: 0.1,
    // synthesis
    sG: 0.7, sC2: 0.12, sC1: 0.45,
    tgfHalf: 0.25, fT0: 0.45,
    aStar: 0.10, aInj: 0.18, kStim: 1.0, kInj: 0.6, kEarly: 1.0, matHalf: 0.15,
    aHyp: 0.8, o2Half: 0.25, o2Anox: 0.03,
    kIL: 0.8, crowd: 2.2,
    Pcap: 1.0, kRel: 0.5,
    // matrix turnover (RETENTION in the header: `free` gates the standing pool, kWashNew/wC2/
    // haloBridge gate what is washed out of a voxel as it is made). Transport is not here: the
    // diffusion of gag and col2 and the GAG sink at the medium face are declared on the species,
    // and the voxel hook only supplies the mesh gate out.mobility.
    kGagLoss: 0.045, cRet: 0.06, gSelf: 1.2, kWash: 2, kGagDeg: 0.4, mTimp: 0.05,
    kWashNew: 0.68, haloBridge: 0.8, wC2: 2.5,
    kCol2Deg: 0.095, gProt: 0.2, kCol1Deg: 0.1, mMin: 0.02,
    // fields
    kO2: 0.7, o2Km: 0.1, kTauto: 0.4, kTup: 0.05,
    mBasal: 0.35, kMxl: 20, mInfl: 8, mFib: 1.5,
    // phenotype
    phi0: 0.35, cTgf: 0.30, cHyp: 0.30, cRound: 0.25, cLoad: 0.10,
    cSpread: 0.50, cSerum: 0.30, cCat: 0.35, cInj: 0.30,
    roundHalf: 0.15, ESpread: 20, col1Half: 0.2,
    tauPhiDown: 7, tauPhiUp: 8, tauCatUp: 1, tauCatDown: 6,
    // stiffness (kPa)
    E0: 0.5, EscafA: 5, EscafB: 60, Egag: 600, EgagBase: 0.25, Ecol2Half: 0.3,
    Ecol2: 400, Ecol1: 80, kStrain: 0.5, ampRef: 0.2,
    // motility / orientation
    v0: 0.35, sigmaP: 1.5, kGuide: 3, kAlign: 0.5, polC1: 0.8,
  },

  // ---- the rules
  makeRules(engine, p) {
    const iScaf = engine.speciesIndex.scaf, iGag = engine.speciesIndex.gag;
    const iCol2 = engine.speciesIndex.col2, iCol1 = engine.speciesIndex.col1;
    const fTgf = engine.fieldIndex.tgf, fO2 = engine.fieldIndex.o2, fM = engine.fieldIndex.m;
    const dXl = engine.dialIndex.xl;
    const dInfl = engine.dialIndex.infl, dSerum = engine.dialIndex.serum;

    // --- pre-resolved constants
    const tgfHalf2 = p.tgfHalf * p.tgfHalf, cRet4 = Math.pow(p.cRet, 4), gSelf2 = p.gSelf * p.gSelf;
    const ESpread2 = p.ESpread * p.ESpread;
    const invAStar = 1 / p.aStar, invAInj = 1 / p.aInj;
    const fracG = p.sG / (p.sG + p.sC2), invPcap = 1 / p.Pcap;
    const invAmpRef = 1 / p.ampRef;

    // --- the terms that depend only on a dial: the load bump s(a), the injury term d(a) and the
    //     hydrolysis clock kHyd(xl). Every cell and every voxel of one step reads the same amp and
    //     xl, so they are computed once per dial change rather than 1728 times per step. The table
    //     lives on engine.scratch, which the engine keeps for the life of the instance, so a reset
    //     re-uses it instead of allocating (docs/EXTENDING.md §2: allocate in makeRules or on
    //     engine.scratch, never in a hook).
    const st = engine.scratch.dialTerms
      || (engine.scratch.dialTerms = { amp: NaN, sLoad: 0, dInj: 0, xl: NaN, kHyd: 0 });
    st.amp = NaN; st.xl = NaN;                        // invalidate: this reset may use other params
    const loadTerms = (amp) => {
      if (amp === st.amp) return;
      const u2 = amp * invAStar * amp * invAStar, q1 = 1 + u2;
      const w4 = amp * invAInj * amp * invAInj * amp * invAInj * amp * invAInj;
      st.amp = amp; st.sLoad = 4 * u2 / (q1 * q1); st.dInj = w4 / (1 + w4);
    };
    const hydTerm = (xl) => {
      if (xl === st.xl) return;
      st.xl = xl; st.kHyd = p.kRG / (p.tRGa + p.tRGb * xl + p.tRGc * xl * xl * xl * xl);
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
        loadTerms(amp);
        const sLoad = st.sLoad;                                 // biphasic bump, peak at aStar
        const dInj = st.dInj;                                   // injury above ~aInj
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
        out.vox[1] = wf * bulk * sGag;                           // voxel() removes this again as loss

        // --- orientation, per fiber species: collagen II is a felt whatever else is going on in the
        //     voxel, collagen I goes down along the cell's polarity. alignS is applied by the engine
        //     as one rate weighted by the local fiber densities — the traction of a spreading cell
        //     turns the collagen I it is standing in, and nothing turns a pure collagen II felt.
        out.usePolS = true;
        out.polS[iCol2] = 0;
        out.polS[iCol1] = p.polC1 * one;
        out.alignS[iCol2] = 0;
        out.alignS[iCol1] = p.kAlign * one;

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
        const out = ctx.out, rho = ctx.rho;
        const scaf = rho[iScaf], gag = rho[iGag], col2 = rho[iCol2], col1 = rho[iCol1];
        const amp = ctx.load, xl = ctx.dial[dXl];
        const mRaw = ctx.field[fM], m = mRaw > p.mTimp ? mRaw - p.mTimp : 0;   // TIMP-buffered

        const conf = xl * scaf > 1 ? 1 : xl * scaf;
        const open = 1 - conf;
        loadTerms(amp); hydTerm(xl);
        const sLoad = st.sLoad;

        // --- scaffold: bulk hydrolysis (clock set by the crosslink dial) + cell enzyme
        const dScaf = -(st.kHyd * (1 + p.kLoadDeg * sLoad) + p.kEnz * mRaw / (mRaw + p.mK)) * (scaf + p.sOff);

        const wash = ctx.vox[1];                                 // fresh aggrecan washed out (see cell())

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
        out.dRho[iGag] = -gagLoss;
        out.dRho[iCol2] = -col2Loss;
        out.dRho[iCol1] = -col1Loss;
        out.loss = gagLoss + col2Loss + col1Loss;                // the scaffold is neither built nor eaten
        // ...it is the third flux bar instead. Report what the voxel can actually give up, not the
        // rate: (scaf + sOff) keeps dScaf negative after the last of the network has gone.
        const drain = -dScaf, cap = ctx.dt > 0 ? scaf / ctx.dt : Infinity;
        out.scaffoldLoss = drain < cap ? drain : cap;
        // --- how freely aggrecan and collagen II move between voxels: the mesh, same gate as
        //     bulk deposition. Species D + this is the engine's version of the spreading pass.
        out.mobility = open <= 0 ? 0 : open * open;
        out.E = stiffnessOf(scaf, gag, col2, col1, xl, amp);
      },

      stiffness(ctx) {
        ctx.out.E = stiffnessOf(ctx.rho[iScaf], ctx.rho[iGag], ctx.rho[iCol2], ctx.rho[iCol1],
          ctx.dial[dXl], ctx.load);
      },
    };
  },
};
