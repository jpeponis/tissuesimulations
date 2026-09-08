# Extending Tissue Weather — the tissue-definition contract (v0.3)

Tissue Weather separates a **generic engine** (grid, fields, cells, orientation
tensor, numerics, stats, export) from **tissue definitions** (what the matrix is
made of, what the cells do, which dials exist, which scenarios to teach). The
default fibrous connective tissue (fibroblasts, provisional matrix → collagen I)
is one definition; articular cartilage in a degrading hydrogel is the second.
Adding a tissue means adding one file under `src/tissues/` and registering it.

This document is the contract. Engine, renderer, app, tools and tests are
written against it. If you change it, change them.

**What is new in v0.4** (`ENGINE_VERSION` and package.json are bumped to 0.4.0 when the release is
cut; everything below already runs. All of it is opt-in and additive: a v0.3 definition keeps
running bit-for-bit): per-field / per-species **integration modes** for the diffusive passes
(`fields[].mode`, `species[].mode`, §2.6) instead of a silent clamp on the diffusion number,
`engine.loadMode: 'compression'` (§2.4), honoured `cellTypes[].motile: false` plus optional
`cellTypes[].count` and `cellTypes[].rCell` (§1), `stats().cells.byType.<key>` (§3), a monotonic
`state.revision` for renderer dirty-checks (§3), resumable `warmFrom()` / `warmScenarios()`
pre-runs (§3), `fields` / `loadRange` / `tissueName` / `scenarioTitle` in the export (§5),
`TissueEngine.warnings()` (§7.1) and the normative step order in §2.5.

**What is new in v0.3** (engine `0.3.0`; everything is opt-in, so a v0.2
definition keeps running unchanged and bit-for-bit): species transport `D` /
`sink`, per-fiber-species deposition orientation `out.polS` / `out.alignS`,
extra per-voxel accumulators `out.vox[k]`, a third flux channel
`out.scaffoldLoss` → `stats().scaffoldFlux`, `stats().species.tissueTotal` /
`scaffold` / `cumDeposition` / `cumDegradation`, aggregated `checks`
(`at: [from, to]` + `agg`), `init.from.events` / `init.from.dials`,
`cellType.states` and a state-dependent `radius`, `loadDial` /
`cellCountDial` in the export meta, and `engine.scratch` for `makeRules`.

```
src/engine.js             generic simulation engine (no tissue knowledge)
src/tissues/fibrous.js    TISSUE_FIBROUS  (the v0.1 model, behaviour-identical)
src/tissues/cartilage.js  TISSUE_CARTILAGE
src/tissues/index.js      TISSUES registry { fibrous, cartilage, ... }  + TISSUE_DEFAULT
src/copy.js               shared copy helpers (equilibrium sentence, intro scaffolding)
src/plots.js, src/render.js, src/app.js   consume the definition, never a specific tissue
```

Build order for the single-file bundle (tools/build_single.mjs discovers
`src/tissues/*.js` automatically, `index.js` last among them):
copy → engine → tissues/* → tissues/index → plots → recipe → render → app.
All files: ES modules, named exports only, unique top-level identifiers,
local imports written on one line as `import { a, b } from './x.js';`.

## 1. Shape of a tissue definition

```js
export const TISSUE_FIBROUS = {
  key: 'fibrous',                       // URL/registry key, [a-z0-9-]
  name: 'Fibrous connective tissue',    // shown in the tissue picker
  short: 'Fibroblasts build, align and mature collagen under load',
  version: '0.2.0',

  // ---- matrix species: per-voxel scalar densities (0 .. ~1.5; 1 ≈ native-like content)
  species: [
    { key: 'new', label: 'Provisional matrix', kind: 'fiber', color: '#cfe8ff',
      describe: 'fibronectin / collagen III-like, immature' },
    { key: 'mat', label: 'Mature collagen I', kind: 'fiber', color: '#e0a24a' },
  ],
  // kind: 'fiber'    oriented; contributes to the shared orientation tensor T (trace = Σ fiber species)
  //       'gel'      isotropic, drawn as a haze (e.g. proteoglycan)
  //       'scaffold' isotropic, drawn as a fading lattice (e.g. hydrogel, porous scaffold)
  // Renderer colour for a fiber instance = density-weighted mix of fiber species colours.
  // Optional TRANSPORT (v0.3, §2.4). Both default to 0 = off:
  //   D: 0.04                         L²/day. Explicit 6-neighbour diffusion with zero-flux walls,
  //                                   run after the voxel pass; the per-face diffusion number is
  //                                   clamped at 1/6, so it is always stable. A fiber species
  //                                   carries its share of T with it (orientation travels).
  //   sink: 0.5, boundary: 'face:+z'  /day loss from the +z (medium) layer only: sink·rho·dt.
  //                                   'face:+z' is the only species boundary and the default when
  //                                   sink > 0. The loss lands in stats().degradation, or in
  //                                   stats().scaffoldFlux for a species of kind 'scaffold'.
  //   mode: 'auto'                    v0.4, §2.6: 'auto' | 'explicit' | 'subcycled' — how the
  //                                   transport is integrated. A species never gets a
  //                                   quasi-steady solve: transport moves mass, it does not relax.
  // The keys 'total', 'fiberTotal' and 'tissueTotal' are reserved by the stat paths.

  // ---- diffusible fields
  fields: [
    { key: 'g', label: 'Growth factor (TGF-β)', color: '#3fd6c4', D: 0.05, bath: 'Gext', kBath: 4, decay: 0 },
    { key: 'm', label: 'Protease (MMP)',        color: '#e05bd0', D: 0.05, bath: null,  kBath: 0, decay: 1.0 },
  ],
  // D in L²/day; bath: dial key whose value the field relaxes toward at rate kBath (/day);
  // decay /day. Sources come from rules (below). Optional `mode` (v0.4, §2.6) picks how the
  // field is integrated from its diffusion number lam = D·dt/h² — 'auto' (the default: explicit,
  // sub-cycled or quasi-steady as lam demands), 'explicit', 'subcycled' or 'quasiSteady'.
  // Optional boundary: 'bath' (default: relaxation toward the bath dial everywhere) or
  // 'face:+z' / 'face:-z' (Dirichlet: that z layer is held at the bath dial value after every
  // step, no bulk relaxation, all other walls zero-flux — e.g. oxygen entering from the medium
  // face; consumption is a negative cell fieldSrc, the field is clamped ≥ 0).

  // ---- cell types (one or more; each cell carries a type index)
  cellTypes: [
    { key: 'fibroblast', label: 'Fibroblast → myofibroblast',
      colors: ['#4ea3ff', '#ff7a3d'],     // colour lerped by the primary state a
      shape: { by: 'a', aspectMin: 1.0, aspectMax: 2.5 },  // ellipsoid aspect along polarity
      radius: 0.03, motile: true,         // motile: false → the cell never moves (v0.4, §2.5)
      // rCell: 0.03,                     // v0.4: this type's repulsion radius (engine.rCell by default)
      // count: 20,                       // v0.4: seed exactly 20 of this type (instead of `fraction`)
      init: { a: 0.05, b: 0, c: 0 },      // starting values of the three per-cell scalars (default 0)
      states: [                           // v0.3: label and range the cell scalars
        { key: 'a', label: 'activation' },
        { key: 'c', label: 'pericellular pool', range: [0, 3] },
      ] },
  ],
  // Each cell carries a type index and three scalars: a (primary, colour/shape), b (secondary)
  // and c (e.g. a pericellular pool of confined matrix that is released later).
  //
  // `motile: false` (v0.4) is honoured by the engine: the cell keeps its polarity and its
  // position — no contact guidance, no load alignment, no polarity noise (so it draws no random
  // numbers) and no migration — and soft repulsion moves only the motile partner of a pair, so a
  // non-motile cell acts as an obstacle. Its hooks still run and it still deposits.
  // `rCell` (v0.4) overrides `engine.rCell` for this type; the contact distance of a pair is
  // rCell_i + rCell_j. Keep 2·max(rCell) < h = L/N — the repulsion search only looks at the 27
  // neighbouring voxel bins, and validate() warns when it no longer holds.
  // `count` (v0.4) is an absolute number of cells of this type instead of a share of the total
  // (`fraction`; declaring both is an error). With a role:'cellCount' dial the dial still sets the
  // TOTAL: counted types are seeded first (scaled down together if they do not all fit) and the
  // rest share what is left by `fraction`; shrinking the total removes cells from the types that
  // are above their target first, and with no uncounted type to take a surplus it spills into the
  // counted ones. Without such a dial the tissue seeds Σ count cells.
  //
  // `states` is the documented way to label and range them. The older `stateLabels: { a, b, c }`
  // and `cRange: [lo, hi]` (the range of c) are still accepted aliases; `states` wins, and giving
  // both a states.c range and a contradicting cRange is a validation error.
  // TissueEngine.cellStates(cellType) merges the two forms into [{ key, label, range }] for the app.
  // Only c may have a range other than [0, 1] — the renderer maps a and b on [0, 1].
  //
  // `shape.aspect` is aspectMin at state 0 and aspectMax at state 1 and is interpolated linearly,
  // so aspectMin > aspectMax IS LEGAL and means "rounder as the state rises" (cartilage: a
  // chondrogenic cell is a sphere, a dedifferentiated one a spindle). Renderer and Blender
  // importer both compute aspectMin + (aspectMax − aspectMin)·s.
  // `radius` is a number, or { by: 'a'|'b', min, max } for a radius that follows a state. The
  // engine only validates it; the renderer consumes it, and exportMeta emits the state-0 value
  // as `radius` plus `radiusBy` (§5).

  // ---- dials (UI + engine). role: 'cellCount' is handled by the engine; role: 'load'
  //      marks the dial used for passive fiber alignment along z and the strain term.
  dials: [
    { key: 'Gext', label: 'Growth-factor bath', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'humidity', biology: '…', watch: '…' },
    { key: 'strain', label: 'Mechanical load', min: 0, max: 1, step: 0.01, default: 0.5, format: 'percent', role: 'load', metaphor: 'pressure', biology: '…', watch: '…' },
    { key: 'protease', label: 'Protease activity', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2', metaphor: 'temperature', biology: '…', watch: '…' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount', metaphor: 'droplet nuclei', biology: '…', watch: '…' },
  ],
  // format: 'fixed2' | 'percent' | 'cells' | 'int' | 'onoff' (0/1 toggle shown as Off/On) | (v) => string

  // ---- scenarios (ordered)
  scenarios: [
    { key: 'maturation', title: 'Scaffold to tissue', goal: '…', steps: ['…','…','…'], question: '…', expect: '…',
      dials: { Gext: 0.5, strain: 0.6, protease: 0.4, nCells: 160 },
      init: { species: { new: 0.15, mat: 0 }, jitter: 0.2 },        // uniform ± jitter·50 %
      checks: [                                                        // machine-checkable expectations
        { at: 60, stat: 'species.total', op: 'gt', value: 0.6 },
        { at: 60, stat: 'fa', op: 'gt', value: 0.45 },
        { at: 60, stat: 'species.mat.fraction', op: 'gt', value: 0.5 },
      ] },
    { key: 'unloading', title: 'Unloading', …,
      init: { from: { scenario: 'maturation', days: 60 } },            // pre-run another scenario
      //     from: { scenario, days, events: true, dials: { Gext: 0.9 } }
      //       events  replay the source scenario's events during the pre-run (default false)
      //       dials   override the source scenario's dials for the pre-run
      checks: [{ at: 60, stat: 'species.total', op: 'lt', value: 0.6 }, { at: 60, stat: 'cells.a', op: 'lt', value: 0.3 }] },
    …
  ],
  // stat paths: species.<key> | species.<key>.fraction | species.total (INCLUDES scaffold species) |
  //             species.tissueTotal (excludes them) | scaffold (their sum) | fiber.total |
  //             fa | globalFA | fz | logE | E | cells.a | cells.b | cells.c | cells.n | t |
  //             fields.<key> | deposition | degradation | ratio (dep/deg) | scaffoldFlux |
  //             cumDeposition | cumDegradation (integrals of deposition / degradation since reset)
  // ops: gt lt between (value: [lo, hi]) ; optional `rel: {stat, op, at?}` compares two stats.
  // A check may cover a RANGE of days instead of one:
  //   { at: [28, 56], agg: 'min', stat: 'logE', op: 'gt', value: 1.5 }      // never dips below 30 kPa
  //   { at: [0, 21], agg: 'mean', stat: 'ratio', op: 'lt', value: 0.9 }     // evaporating on average
  //   { at: [14, 42], agg: 'max', stat: 'cells.c', rel: { stat: 'cells.c', at: 0, op: 'gt' } }
  // agg is 'min' | 'max' | 'mean' | 'first' and is REQUIRED with a range (and rejected without one).
  // checkScenario samples the range every 0.5 d, endpoints included; with `rel` the reference day
  // defaults to the START of the range.

  // ---- readouts: which charts the panel shows (in order). type: 'stack' | 'lines' | 'log' | 'flux'
  readouts: [
    { key: 'density', label: 'Matrix density', unit: 'relative (1 ≈ dense tissue)', meaning: '…', type: 'stack',
      series: [{ stat: 'species.new', label: 'new matrix', color: '#3f97dc' }, { stat: 'species.mat', label: 'mature collagen', color: '#c4822a' }] },
    { key: 'align', label: 'Alignment & activation', unit: '0–1', meaning: '…', type: 'lines',
      series: [{ stat: 'fa', label: 'alignment', color: '#8f7ae0' }, { stat: 'cells.a', label: 'cell activation', color: '#e0602a' }] },
    { key: 'stiff', label: 'Stiffness', unit: 'kPa (log scale)', meaning: '…', type: 'log', series: [{ stat: 'logE', label: 'stiffness', color: '#8fb8d8' }], domain: [-1, 2.5] },
    { key: 'flux', label: 'Matrix flux', unit: 'density per day', meaning: '…', type: 'flux' },
  ],

  // ---- copy that is tissue-specific
  copy: {
    intro: { tagline: '…', paragraphs: ['…', '…', '…'] },
    metaphorBreaks: [{ claim: '…', reality: '…' }],
    legend: { fibers: '…', cells: '…', fields: { g: '…', m: '…' }, load: '…' },
    vocabulary: { matrix: 'collagen', cellsActive: 'activated cells are pumping out collagen', cellsQuiet: 'the cells are quiet' },
  },

  // ---- injury (optional; omit to hide the Injure button)
  injury: { radius: 0.25, clearSpecies: ['new', 'mat'], fieldBurst: { g: 0.6, m: 0.8 },
            inflammation: { sources: { g: 4, m: 1 }, tau: 5 } },

  // ---- engine-level numerics this tissue wants (all optional; engine defaults shown)
  engine: { N: 12, dt: 0.02, rhoMax: 2, kLoadFib: 0.06, loadExp: 2, fEvery: 4, rCell: 0.03, kRep: 0.5,
            trace: 'fiber',    // 'fiber': T trace = Σ fiber species; scaled on degradation
            loadMode: 'tension', // v0.4: 'tension' (T relaxes ONTO the load axis z) or
                               //       'compression' (T relaxes into the plane ⊥ to z)
            vox: 1 },          // number of per-voxel cell accumulators out.vox[0..vox−1] (1..4)

  // ---- tissue parameters (free-form; passed to makeRules)
  params: { … },

  // ---- the rules
  makeRules(engine, params) { return { cell(ctx) {…}, voxel(ctx) {…}, stiffness(ctx) {…} }; },
};
```

## 2. Rules: the hooks the engine calls

`makeRules(engine, params)` is called once per reset. It returns closures with
pre-resolved indices (`engine.speciesIndex.new`, `engine.fieldIndex.g`,
`engine.dialIndex.strain`) so the hot loops do no string lookups and no
allocation. The engine hands each hook a **reusable context object**; hooks
read inputs and write outputs into typed arrays on that object.

**Allocation.** `makeRules` itself runs once per reset, not per step, so it MAY
allocate (a lookup table, a scratch buffer). The *hooks* must not. To keep those
allocations across resets, cache them on `engine.scratch` — a plain object the
engine creates once per instance and never touches:

```js
makeRules(engine, p) {
  const sc = engine.scratch;
  sc.nbr = sc.nbr || tplNeighbourTable(engine.N);   // built once per engine, not per reset
  …
}
```

**The neighbour rule.** A hook may only read and write ITS OWN voxel or cell.
`ctx.rho` / `ctx.field` are copies of one voxel's values, and nothing in the
contract lets a hook reach a neighbour — reading `engine.species[s][v ± 1]`
inside a hook couples the result to the voxel visiting order and breaks as soon
as the engine changes it. Anything that has to move between voxels is **species
transport** (`D`, `sink` in §1, mechanics in §2.4), and anything a cell needs to
tell its own voxel goes through `out.vox[k]` (§2.1).

### 2.1 `cell(ctx)` — once per cell per step

Inputs (read-only):
```
ctx.i           cell index               ctx.type   cell type index
ctx.a, ctx.b, ctx.c  cell state scalars  ctx.dt
ctx.rho[s]      local species densities (Float32Array, per species index)
ctx.fiberTotal  Σ fiber species          ctx.fa, ctx.fz  local FA and |f_z| (principal axis)
ctx.field[f]    local field values       ctx.E      local stiffness (kPa, from last voxel pass)
ctx.dial[d]     dial values              ctx.load   value of the role:'load' dial (0 if none)
ctx.cellsInVoxel  count of cells in this voxel (from last step)
ctx.rng()       seeded uniform
```
Outputs (write; engine zeroes them before the call):
```
ctx.out.a, ctx.out.b        new state values (engine clamps to [0,1])
ctx.out.c                   third state value (engine clamps to cellType.cRange, default [0,1])
ctx.out.secrete[s]          deposition rate into this voxel, density/day, per species
ctx.out.pol                 orientation strength of fiber deposition (0 isotropic … 1 along polarity)
ctx.out.align               traction realignment rate of T toward polarity (/day)
ctx.out.fieldSrc[f]         field source (units of field/day, added to the voxel)
ctx.out.speed               migration speed (L/day; 0 for non-motile)
ctx.out.guide               contact-guidance rate toward ±f (/day, scaled by FA in the engine)
ctx.out.loadAlign           polarity alignment rate toward the load axis (/day)
ctx.out.noise               polarity noise (rad/√day)
ctx.out.aSum                contribution to the voxel's "cell activity" sum used by voxel() (default a)
ctx.out.vox[k]              k < engine.vox (≤ 4): contribution to the voxel's accumulator k, which
                            voxel() reads as ctx.vox[k]. vox[0] IS aSum (same default: out.vox[0],
                            else out.aSum, else the cell's new a); vox[1..3] default to 0.
ctx.out.usePolS             set true to use the per-species orientation arrays below
ctx.out.polS[s]             per-fiber-species `pol` (Float32Array by SPECIES index; NaN → out.pol)
ctx.out.alignS[s]           per-fiber-species `align`  (same; NaN → out.align)
```
The engine then: deposits `secrete[s]·dt` into species s (fiber species also
into T with orientation `pol`), applies `align`, updates polarity and position,
resolves repulsion and walls, and accumulates `fieldSrc` and the `vox`
accumulators per voxel.

**Per-species orientation.** One cell often makes two fiber species with
different orders — an isotropic felt and an aligned rope. With the single scalar
`pol` the engine can only deposit their SUM with one orientation strength, which
is exact only when one of them dominates. Set `out.usePolS = true` and write
`out.polS[s]` per fiber species; each is then deposited with its own orientation:

```js
out.usePolS = true;
out.polS[iCol2] = 0;                 // collagen II: a felt
out.polS[iCol1] = 0.8 * (1 - phi);   // collagen I: along the cell's polarity
```

T is *shared* by the fiber species, so realignment cannot be split the same way:
`alignS` is applied as ONE rate, the mean of `alignS[s]` weighted by the
post-deposition local density of species s (no fiber present ⇒ rate 0). Both
arrays are refilled with NaN after each cell that uses them, so a hook only has
to write the entries it cares about. Leaving `usePolS` false costs one store per
cell and keeps the v0.2 path exactly.

### 2.2 `voxel(ctx)` — once per voxel per step

Inputs:
```
ctx.v, ctx.dt, ctx.rho[s], ctx.fiberTotal, ctx.fa, ctx.Tzz_over_trace (alignment with load axis)
ctx.field[f], ctx.dial[d], ctx.load, ctx.aSum (Σ activity of cells in voxel), ctx.nCellsHere, ctx.inflam
ctx.vox[k]          the per-voxel accumulators the cells wrote (k < engine.vox); ctx.vox[0] = ctx.aSum
```
Outputs:
```
ctx.out.dRho[s]     net rate of change of species s EXCLUDING deposition (conversion, degradation,
                    hydrolysis, loss to the medium). Negative = loss. Engine integrates and clamps ≥ 0.
ctx.out.loss        total matrix LOSS rate this voxel (density/day, ≥ 0) — feeds the flux gauge and
                    field release
ctx.out.scaffoldLoss  dissolution rate of a 'scaffold' species (density/day, ≥ 0). It is neither
                    deposition nor degradation of TISSUE, so it is reported separately as
                    stats().scaffoldFlux — the third flux bar — and left out of `loss`.
ctx.out.mobility    0..1 (default 1): how freely species transport (§2.4) moves matrix INTO and OUT
                    of this voxel, e.g. `1 - conf` for a tight hydrogel mesh. Only read when some
                    species declares D; a face uses the mean of its two voxels.
ctx.out.E           stiffness (kPa) of this voxel now
```
Fiber species and T: when the total fiber density changes through `dRho`, the
engine scales T by (new total / old total), preserving orientation. Species
conversion between two fiber species (new → mat) is expressed purely through
`dRho` (−x on one, +x on the other); T is untouched because the trace is
unchanged.

### 2.3 `stiffness(ctx)` (optional)

If present, called after reset/injure to fill E without a full step (same
inputs as `voxel`). Otherwise the engine calls `voxel` with dt = 0.

### 2.4 Engine-owned mechanics (parameters in `engine`)

- passive alignment of T toward the load axis z: rate `kLoadFib · load^loadExp`
  (`engine.loadMode: 'compression'` instead relaxes T toward the plane PERPENDICULAR to z, and a
  cell's `out.loadAlign` then pulls its polarity into that plane; both forms preserve trace(T))
- polarity update, migration, wall reflection, voxel-binned repulsion (`rCell`, `kRep`)
- diffusion of fields with zero-flux walls, bath relaxation, decay, and the
  injury inflammation field, integrated in the mode §2.6 picks for each field
- **species transport** for every species with `D` or `sink` (§1), run after the
  voxel pass and before the field pass:
  1. explicit 6-neighbour diffusion, zero-flux walls, per-face coefficient
     `D·dt/h² · ½(mobility_v + mobility_w)`, sub-cycled when that number exceeds 1/6
     (§2.6; mass-conserving and never negative in either case);
  2. a **fiber** species carries its share of the orientation tensor: the tensor
     flux across a face is (mass flux)·T(source)/fiberTotal(source), so matrix
     that moves keeps its direction and trace(T) = Σ fiber species stays exact.
     After the pass T is rescaled onto the new fiber total and FA / the
     principal axis are refreshed on the usual `fEvery` cadence;
  3. `sink`: the +z layer loses `sink·rho·dt` (into `degradation`, or into
     `scaffoldFlux` for a scaffold species).
  Transport is the one engine mechanism that costs real time: at N = 12 a
  non-fiber species with `D` adds ≈ 0.06 ms/step and a fiber species ≈ 0.2 ms
  (it also carries the tensor and refreshes FA). Declare `D` where the movement
  is part of the story, not everywhere; `sink` alone is nearly free (≈ 0.01 ms).
- trace clamp `rhoMax`, PSD guard, FA and principal axis (power iteration every `fEvery` steps)
- cell count dial (`role: 'cellCount'`) → add/remove cells

### 2.5 Step order and input staleness (normative)

One `step()` runs exactly this, in this order. A hook may rely on it; anything not stated here
(in particular the order in which voxels are visited relative to cells of other voxels) is not
part of the contract.

1. **Zero the accumulators.** The per-voxel field sources and `out.vox[k]` sums start at 0.
2. **Cells, in index order 0 … n−1.** For each cell, in this order:
   1. its voxel is found from its CURRENT position;
   2. inputs are read (see the staleness table below) and `cell(ctx)` is called;
   3. `out.a` / `out.b` are clamped to [0, 1] and `out.c` to the type's range; a NaN leaves the
      old value;
   4. `out.secrete[s]·dt` is added to the voxel's species s — **immediately**, so a later cell in
      the same voxel and the same step sees it in `ctx.rho[s]`. Fiber species also go into T with
      orientation `out.pol` (or `out.polS[s]`), then the traction realignment `out.align`
      (or the density-weighted mean of `out.alignS`) is applied to T. Both preserve trace(T);
   5. `out.fieldSrc[f]` and `out.vox[k]` are accumulated onto the voxel;
   6. **motile cells only:** polarity ← contact guidance (`out.guide·dt·fa`, toward ±f), load
      alignment (`out.loadAlign·dt`, toward ±z, or into the ⊥ plane under `loadMode:
      'compression'`), polarity noise (`out.noise·√dt`), renormalise; then the cell moves by
      `out.speed·p·dt`. A `motile: false` cell skips this step entirely.
3. **Binning, repulsion, walls.** Cells are binned into voxels (this is the `ctx.cellsInVoxel`
   the NEXT step sees), every pair closer than its contact distance (`rCell_i + rCell_j`) is
   pushed apart — motile partners only — and positions/polarities are reflected off the walls.
4. **Voxels, in index order.** For each voxel: `voxel(ctx)` is called, then the engine
   integrates `out.dRho[s]·dt` and clamps each species ≥ 0; rescales T so trace(T) equals the new
   fiber total (orientation preserved); applies the passive load alignment; applies the `rhoMax`
   clamp to T **and** to the fiber species; applies the PSD guard; recomputes FA and — every
   `fEvery` steps — the principal axis (two warm-started power iterations); stores `out.E`.
5. **Species transport** (§2.4), for the species that declare `D` or `sink`.
6. **Fields** (§2.6), then the inflammation field decays.
7. `time += dt`, `stepCount++`, `revision++`.

What a hook sees, and how old it is:

| input | freshness |
|---|---|
| `ctx.rho[s]` (cell hook) | **live** — includes what earlier cells deposited this step |
| `ctx.rho[s]` (voxel hook) | live — after all deposition of this step |
| `ctx.fiberTotal`, `ctx.fa`, `ctx.fz`, `ctx.E` (cell hook) | one voxel pass old (end of the previous step) |
| `ctx.fa`, `ctx.Tzz_over_trace` (voxel hook) | previous step; `ctx.fiberTotal` is recomputed and live |
| `ctx.field[f]` | after the previous step's field pass |
| `ctx.cellsInVoxel` (cell hook) | the previous step's binning; `ctx.nCellsHere` (voxel hook) is this step's |
| `ctx.dial[d]`, `ctx.load` | current |
| `ctx.inflam` | set by `injure()`, decayed once per step |

**Randomness.** One mulberry32 stream per engine, re-seeded by `reset()` (an `init.from` pre-run
runs in its own engine seeded with `seed + 1`). It is consumed by: `reset` — 1 draw per voxel for
the density jitter (always drawn, even with `jitter: 0`) and 3 per voxel for the initial principal
axis; adding a cell — 3 draws for its position and 3 for its polarity; removing a cell — 1 draw;
`injure()` without a centre — 3 draws; and, per step, 9 draws per **motile** cell whose
`out.noise > 0` (three Gaussians, each the sum of three uniforms). Nothing else draws, so a rule
that changes whether it writes `noise` changes every later random number.

### 2.6 How the diffusive passes are integrated (fields and species)

Both the field pass and species transport are explicit 6-neighbour stencils, and an explicit
stencil is only stable while the diffusion number

    lam = D · dt / h²          (h = L / N)

stays below 1/6. Up to v0.3 the engine simply clamped it there, which is stable but silently
integrates a fast field with a smaller D than the definition declares (at N = 12, dt = 0.02 the
ceiling is D ≈ 0.174 L²/day — oxygen is three orders of magnitude above it). Since v0.4 the
engine instead picks an integration mode per field and per species **at construction**:

| mode | when `auto` picks it | what it does |
|---|---|---|
| `explicit` | lam ≤ 1/6 | one explicit step — bit-identical to v0.3 |
| `subcycled` | lam > 1/6, and ≤ 20 sub-steps are enough | `nSub = ceil(6·lam)` explicit sub-steps of `dt/nSub`; sources, bath, decay and the Dirichlet face are applied on every sub-step |
| `quasiSteady` | more than 20 sub-steps would be needed, and the steady problem is well posed | solves the steady state instead of stepping it |

`fields[].mode` / `species[].mode` override the choice: `'explicit'` pins the v0.3 behaviour
(**including the clamp**, so use it only to reproduce old results), `'subcycled'` forbids the
steady solve, `'quasiSteady'` asks for it wherever it is well posed. A species is never solved
quasi-steadily — transport moves mass rather than relaxing to a profile — and asking for it is a
validation error. `TissueEngine.validate()` prints one `console.warn` per definition naming the
field, its lam and the mode that was chosen; `engine.fieldModes` / `engine.speciesModes` expose
the same as data.

**The quasi-steady solve.** For a field whose diffusion is orders of magnitude faster than one
step, the profile is always at equilibrium with its sources, so the engine solves

    0 = D∇²g + kBath·(bath − g) + src − decay·g + wInf·inflam

on the same stencil (zero-flux walls; a `boundary: 'face:±z'` layer held at the bath dial) with
warm-started Gauss-Seidel sweeps (over-relaxed, at most 50 per step, stopped once no voxel moves
by more than 1e-4), clamped ≥ 0. It is only well posed when the flux has somewhere to go — a
Dirichlet face, `kBath > 0`, or `decay > 0`; without one of those `auto` keeps sub-cycling and an
explicit `'quasiSteady'` request falls back to sub-cycling with a warning.

Two consequences worth knowing when you write the rules:

- the sources are the ones your hooks wrote at the START of the step, so a source that depends on
  the field (Michaelis-Menten uptake, say) makes this a lagged fixed-point iteration. The engine
  therefore moves the field only half-way to each solve, which damps the "everything consumed /
  nothing consumed" oscillation and leaves the fixed point — the true steady state — unchanged.
  Expect a gradient to settle over a handful of steps rather than in one;
- the clamp at 0 means a consumption that exceeds what diffusion can supply empties a region
  instead of driving the field negative. Write consumption as a saturating rule
  (`-kO2·o2/(o2 + Km)`), not a constant sink, if you want the starved region to be physical.

## 3. Engine API (what app, tools and tests use)

```js
import { TissueEngine } from './engine.js';
import { TISSUES, TISSUE_DEFAULT } from './tissues/index.js';

const M = new TissueEngine(TISSUES.fibrous, { seed: 7, overrides: { N: 12 } });
M.reset('maturation');                  // scenario key (first scenario if omitted)
M.setDials({ strain: 0 });
M.step(50);
M.injure();                             // if tissue.injury exists
M.warmFrom(from, 500)                   // v0.4: advance an init.from pre-run by ≤ 500 steps
M.warmScenarios(200)                    // v0.4: same, for every scenario of the tissue
M.state                                 // typed arrays, see below
M.stats()                               // generic stats, see below
M.stat('species.mat.fraction')          // any stat path from §1
M.snapshot(), M.exportMeta()            // export format §5
M.tissue                                // the definition
M.speciesIndex, M.fieldIndex, M.dialIndex
M.scratch                               // a per-engine object makeRules() may cache arrays on
M.nVox                                  // number of per-voxel accumulators (engine.vox)
M.revision                              // v0.4: monotonic counter, bumped by step/reset/injure/setDials
M.fieldModes, M.speciesModes            // v0.4: [{ key, D, lam, mode, nSub }] — what §2.6 chose
TissueEngine.warnings(tissue, { overrides })  // v0.4: the notes validate() prints (§7.1)
TissueEngine.checkScenario(tissue, scenarioKey, { seed })  // runs the scenario, evaluates `checks`, returns [{check, value, ref, pass}]
TissueEngine.cellStates(cellType)       // [{ key, label, range }] merged from states / stateLabels / cRange
TissueEngine.statFrom(stats, path)      // one stat out of an existing stats() object
```

`state`:
```
N, L, h, time, dt, revision, dials{}, nCells, wound, tissue (key)
species: Float32Array[nSpecies] (each N³)       // by species index; state.speciesKeys
Txx..Tyz, fiberTotal (N³), fa, fx, fy, fz, E, inflam
fields: Float32Array[nFields] (each N³)          // by field index; state.fieldKeys
cx (3n), cp (3n), ca (n), cb (n), cc (n), ctype (Uint8Array n)
```
`stats()`:
```
t, species: { <key>: mean, total: Σ means (INCLUDING scaffold species), fiberTotal,
              tissueTotal: total − scaffold }, fraction: { <key>: mean/total },
scaffold      Σ means of the kind:'scaffold' species (0 when there are none)
fa, globalFA, fz, logE, E, fields: { <key>: mean },
cells: { a, b, c, n, byType: { <cellType key>: { n, a, b, c } } }   // byType is v0.4
deposition, degradation (both as MEAN density change per day over the tissue — already divided by N³),
ratio         deposition / degradation
scaffoldFlux  MEAN scaffold dissolution rate (Σ out.scaffoldLoss / N³) — the third flux bar
cumDeposition, cumDegradation           ∫ deposition dt and ∫ degradation dt since the last reset
                                        (a density, not a rate; both restart at 0 on reset)
```
`woundStats()` has the same species / fraction / fields shape (with tissueTotal) inside the wound.

`state.revision` (v0.4) counts every mutation of the state: `step()` bumps it once per simulated
step, `reset()`, `injure()` and a `setDials()` that resolved at least one dial bump it once.
A renderer or plot can skip its work while it is unchanged, and must fall back to "always update"
when it is `undefined` (an older engine, or a hand-built state object).

**Resumable pre-runs** (v0.4). `reset()` on a scenario with `init.from` runs the source scenario
synchronously — 3000 steps, ~0.8 s for fibrous — the first time. `warmFrom(from, maxSteps)`
advances that same pre-run by at most `maxSteps` steps and caches it when it finishes, so an app
can spread the cost over animation frames: it returns `{ done, scenario, steps, remaining }` and
is cheap to call again once `done`. `warmScenarios(maxSteps)` does it for every scenario of the
tissue, one slice per call, and returns `{ done: true, scenario: null, … }` when every pre-run is
cached. Slicing is bit-identical to the synchronous run (events fire on the same day boundaries),
the warmed engine's own state is untouched, and the cache key includes the seed — warm with the
seed the reset will use.

Determinism: same tissue, seed, dial sequence → identical results in node and browser.
A v0.2 definition runs bit-for-bit as it did before v0.3: every addition above is behind an
opt-in flag on the definition or a hook output that defaults to "not written".

Performance budget: ≤ 0.5 ms per step at N = 12, 160 cells, in node (was 0.25 ms
in v0.1; the hook indirection may cost ~30 %). Measured after v0.3: fibrous 0.22 ms,
cartilage 0.35 ms, the starter 0.20 ms.

## 4. Renderer contract

`new TissueRenderer(canvas, opts)`; `renderer.setTissue(tissue)` (re)builds
layers from `species` and `cellTypes`; `renderer.update(state, layers)` where
`layers` is `{ fibers, cells, scaffold, gel, fields: { g: true, … } }`. Layers
default: fibers/cells/scaffold/gel on, fields off.

- fiber layer: one InstancedMesh, K instances per voxel; radius from
  `fiberTotal`, direction from f/FA (v0.1 recipe), colour = Σ_s (rho_s/fiberTotal)·color_s.
- gel layer: one InstancedMesh of low-poly spheres, one per voxel, scale ∝
  density^(1/3), translucent, colour = species colour (one gel species; if
  several, mix by density).
- scaffold layer: fixed lattice of struts (3 per voxel along x, y, z),
  opacity/radius ∝ density, colour = species colour. Reads as a hydrogel that dissolves.
- cells: colour lerp by `a` between `colors`, aspect from `shape.by` (a or b),
  radius from the type.
- load arrows appear only if a `role: 'load'` dial exists.
- `renderer.legendSwatches()` returns `[{label, css}]` for the app's legend.

## 5. Export format (v0.2 shape, Blender-compatible)

```
{ "meta": { "format": 2, "tissue": "fibrous", "N":12, "L":1, "K":3, "dtDays":0.02, "scenario": "…",
            "dials": {...}, "loadDial": "strain", "cellCountDial": "nCells",
            "loadRange": [0, 1],                          // v0.4: [min, max] of the load dial
            "tissueName": "…", "scenarioTitle": "…",      // v0.4: display labels
            "species": [{key,label,kind,color}], "cellTypes": [{key,label,colors,shape,radius[,radiusBy]}],
            "fields": [{key,label,color}],                // v0.4: mirrors `species`, for the frame grids
            "exportEveryDays": 2 },
  "frames": [ { "t": 0,
      "species": { "new": [N³], "mat": [N³] },          // per species
      "fields": { "g": [N³], "m": [N³] },               // v0.4: one grid per declared field (4 dp)
      "fa": [N³], "f": [3N³],
      "rho": [N³], "phiMat": [N³],                      // kept for format-1 readers: rho = fiberTotal,
                                                        // phiMat = fraction of the LAST fiber species
      "cells": { "x": [3n], "p": [3n], "a": [n], "b": [n], "c": [n], "type": [n], "alpha": [n] } } ] }
```
`alpha` duplicates `a` for format-1 readers. The Blender importer reads
format 2 (species-coloured fibers, gel spheres, scaffold struts) and still
accepts format 1.

`loadDial` / `cellCountDial` name the dials carrying those roles (null when the
tissue has none), so a reader knows which dial to draw load arrows for instead of
guessing at `strain`, and `loadRange` (v0.4) is that dial's `[min, max]`, so a reader can
normalise it — a 0–0.2 compression dial should draw the same arrow range as a 0–1 stretch dial.
`fields` (v0.4) mirrors `species` for the per-frame field grids, which are rounded to four
decimals; a reader must tolerate a frame without them (older files) and a meta without
`fields` / `loadRange` / `tissueName` / `scenarioTitle`. A cell type with a state-dependent radius exports the
state-0 value as `radius` (readers that expect a number keep working) plus
`radiusBy: { by, min, max }`. Frames are unchanged from v0.2.

## 6. App contract

- Tissue picker at the top of the panel (segmented control); URL `?tissue=&scenario=&Gext=…`
  deep links; `history.replaceState` keeps the URL current (debounced).
- Dials, scenario cards, readouts, legend and About are generated from the
  definition. Injure button shown only when `tissue.injury` exists.
- Ghost traces: on Reset, the previous run's series stay as dashed reference
  lines until the next Reset (plots.js `setReference()`).
- Accessibility: every control labelled, one `aria-live="polite"` region — the visually
  hidden `#status` — for state changes, flash messages and the chart crosshair (the
  visible `#equilibrium` sentence carries no live role: it is rewritten too often),
  focus visible, `prefers-reduced-motion`
  disables auto-rotate, a "Table" toggle under the readouts renders the last
  values as an HTML table, canvas has `role="img"` and an `aria-label` that the
  app updates with a one-line description every few seconds.

## 7. Conformance: what a new tissue must pass

`node --test tests/*.test.mjs` runs, for every registered tissue (and for the
unregistered starter `src/tissues/_template.js`):
1. schema validation of the definition (keys, kinds, colours, dial roles, species `D` / `sink`,
   `states` / `radius`, `engine.vox`, scenario checks — ranges and `agg` included — well-formed),
   plus `exportMeta().loadDial` / `cellCountDial` matching the dial roles
2. determinism (two engines, same seed → identical stats after 200 steps)
3. invariants (no NaN, densities ≥ 0, FA ∈ [0,1], trace(T) = Σ fiber species, cells inside the box)
   through every scenario, with dial extremes and an injury
4. every scenario's `checks` (headless run to the latest `at`, events fired, ranges sampled every 0.5 d)
5. performance (< 1 ms/step at N = 12, 160 cells, node)
Plus the fibrous tissue's golden regression: `tests/golden/fibrous.json`
(recorded from v0.1 `model.js` with seed 7) must be matched within 3 % on
meanRho, meanRhoMat, meanFA, meanAlpha at every recorded day.
Plus a v0.3 feature suite on a throw-away fixture tissue (species `D` conserves mass and stays
bounded, `sink` drains only the +z layer, a fiber species carries T, `out.mobility` hinders
transport, `polS` / `alignS`, `out.vox[k]`, the scaffold flux and cumulative stats, aggregated
checks, `init.from.events` / `dials`, `exportMeta`, `cellStates`).
If a tissue uses a v0.3 feature, exercise it in a scenario `check`: the conformance suite has no
way to know that `D` should have spread something unless a check says so.

### 7.1 Warnings (v0.4)

`TissueEngine.validate(t)` still returns only hard errors, and prints — once per definition, with
`console.warn` — the notes `TissueEngine.warnings(t, { overrides })` finds. They are things the
engine works around silently but you should know about:

- a field or species whose `lam = D·dt/h²` is above 1/6, naming lam and the mode §2.6 chose
  (or, with `mode: 'explicit'`, the effective D the clamp leaves you with);
- a repulsion range `2·max(rCell)` that is no longer smaller than a voxel — the pair search only
  looks at the 27 neighbouring bins, so wider cells would miss each other;
- cell seeding with neither a `role: 'cellCount'` dial nor any `cellTypes[].count` (nothing will
  be seeded), or with both (the dial sets the total; see §1).

## 8. Adding a tissue in six steps

1. `node tools/new_tissue.mjs mytissue "My tissue name"` → copies the template to
   `src/tissues/mytissue.js` and registers it in `src/tissues/index.js`.
2. Fill in species, fields, cellTypes, dials, and at least two scenarios with `checks`.
   Decide there whether a species has to MOVE (`D`, `sink`) or a scalar has to be
   labelled or re-ranged (`states`) — both are one line in the definition, and doing
   them in `makeRules` instead is how the hooks end up reading their neighbours.
3. Write `makeRules`: start from the template's fibrous rules; change what the
   cells secrete and what the matrix does. Pre-resolve indices, allocate in
   `makeRules` (or on `engine.scratch`), never in a hook, and never read another voxel.
   If one cell makes several fiber species with different orders, use
   `out.usePolS` + `out.polS[s]`; if the voxel hook needs something only the cell
   knows, send it through `out.vox[k]` rather than overloading `aSum`.
4. `node tools/run_headless.mjs --tissue mytissue` and `python3 tools/plot_scenarios.py`
   to see curves; the CSV carries `cumDeposition`, `cumDegradation`, `scaffoldFlux`
   and `species.tissueTotal` next to the per-species columns.
5. Tune until `node --test tests/*.test.mjs` passes. Prefer a range check
   (`at: [from, to]` + `agg`) over a point check whenever the claim is really "it never
   drops below" or "it averages"; a point check on a noisy day is how a scenario gets
   re-tuned for the wrong reason.
6. `node tools/build_single.mjs`; open `index.html?tissue=mytissue`.
