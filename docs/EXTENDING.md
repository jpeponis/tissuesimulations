# Extending Tissue Weather — the tissue-definition contract (v0.2)

Tissue Weather separates a **generic engine** (grid, fields, cells, orientation
tensor, numerics, stats, export) from **tissue definitions** (what the matrix is
made of, what the cells do, which dials exist, which scenarios to teach). The
default fibrous connective tissue (fibroblasts, provisional matrix → collagen I)
is one definition; articular cartilage in a degrading hydrogel is the second.
Adding a tissue means adding one file under `src/tissues/` and registering it.

This document is the contract. Engine, renderer, app, tools and tests are
written against it. If you change it, change them.

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
copy → engine → tissues/* → tissues/index → plots → render → app.
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

  // ---- diffusible fields
  fields: [
    { key: 'g', label: 'Growth factor (TGF-β)', color: '#3fd6c4', D: 0.05, bath: 'Gext', kBath: 4, decay: 0 },
    { key: 'm', label: 'Protease (MMP)',        color: '#e05bd0', D: 0.05, bath: null,  kBath: 0, decay: 1.0 },
  ],
  // D in L²/day (engine clamps the diffusion number to 1/6); bath: dial key whose value the
  // field relaxes toward at rate kBath (/day); decay /day. Sources come from rules (below).

  // ---- cell types (one or more; each cell carries a type index)
  cellTypes: [
    { key: 'fibroblast', label: 'Fibroblast → myofibroblast',
      colors: ['#4ea3ff', '#ff7a3d'],     // colour lerped by the primary state a
      shape: { by: 'a', aspectMin: 1.0, aspectMax: 2.5 },  // ellipsoid aspect along polarity
      radius: 0.03, motile: true,
      stateLabels: { a: 'activation', b: null } },
  ],

  // ---- dials (UI + engine). role: 'cellCount' is handled by the engine; role: 'load'
  //      marks the dial used for passive fiber alignment along z and the strain term.
  dials: [
    { key: 'Gext', label: 'Growth-factor bath', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2',
      metaphor: 'humidity', biology: '…', watch: '…' },
    { key: 'strain', label: 'Mechanical load', min: 0, max: 1, step: 0.01, default: 0.5, format: 'percent', role: 'load', metaphor: 'pressure', biology: '…', watch: '…' },
    { key: 'protease', label: 'Protease activity', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2', metaphor: 'temperature', biology: '…', watch: '…' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount', metaphor: 'droplet nuclei', biology: '…', watch: '…' },
  ],
  // format: 'fixed2' | 'percent' | 'cells' | 'int' | (v) => string

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
      checks: [{ at: 60, stat: 'species.total', op: 'lt', value: 0.6 }, { at: 60, stat: 'cells.a', op: 'lt', value: 0.3 }] },
    …
  ],
  // stat paths: species.<key> | species.<key>.fraction | species.total | fiber.total | fa | globalFA
  //             logE | E | cells.a | cells.b | fields.<key> | deposition | degradation | ratio (dep/deg)
  // ops: gt lt between (value: [lo, hi]) ; optional `rel: {stat, op}` compares two stats.

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
            trace: 'fiber' },   // 'fiber': T trace = Σ fiber species; scaled on degradation

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

### 2.1 `cell(ctx)` — once per cell per step

Inputs (read-only):
```
ctx.i           cell index               ctx.type   cell type index
ctx.a, ctx.b    primary/secondary state  ctx.dt
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
ctx.out.secrete[s]          deposition rate into this voxel, density/day, per species
ctx.out.pol                 orientation strength of fiber deposition (0 isotropic … 1 along polarity)
ctx.out.align               traction realignment rate of T toward polarity (/day)
ctx.out.fieldSrc[f]         field source (units of field/day, added to the voxel)
ctx.out.speed               migration speed (L/day; 0 for non-motile)
ctx.out.guide               contact-guidance rate toward ±f (/day, scaled by FA in the engine)
ctx.out.loadAlign           polarity alignment rate toward the load axis (/day)
ctx.out.noise               polarity noise (rad/√day)
ctx.out.aSum                contribution to the voxel's "cell activity" sum used by voxel() (default a)
```
The engine then: deposits `secrete[s]·dt` into species s (fiber species also
into T with orientation `pol`), applies `align`, updates polarity and position,
resolves repulsion and walls, and accumulates `fieldSrc` and `aSum` per voxel.

### 2.2 `voxel(ctx)` — once per voxel per step

Inputs:
```
ctx.v, ctx.dt, ctx.rho[s], ctx.fiberTotal, ctx.fa, ctx.Tzz_over_trace (alignment with load axis)
ctx.field[f], ctx.dial[d], ctx.load, ctx.aSum (Σ activity of cells in voxel), ctx.nCellsHere, ctx.inflam
```
Outputs:
```
ctx.out.dRho[s]     net rate of change of species s EXCLUDING deposition (conversion, degradation,
                    hydrolysis, loss to the medium). Negative = loss. Engine integrates and clamps ≥ 0.
ctx.out.loss        total matrix LOSS rate this voxel (density/day, ≥ 0) — feeds the flux gauge and
                    field release
ctx.out.fieldSrc[f] field sources from matrix processes (e.g. growth-factor release ∝ loss)
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
- polarity update, migration, wall reflection, voxel-binned repulsion (`rCell`, `kRep`)
- diffusion of fields with zero-flux walls, bath relaxation, decay, and the
  injury inflammation field
- trace clamp `rhoMax`, PSD guard, FA and principal axis (power iteration every `fEvery` steps)
- cell count dial (`role: 'cellCount'`) → add/remove cells

## 3. Engine API (what app, tools and tests use)

```js
import { TissueEngine } from './engine.js';
import { TISSUES, TISSUE_DEFAULT } from './tissues/index.js';

const M = new TissueEngine(TISSUES.fibrous, { seed: 7, overrides: { N: 12 } });
M.reset('maturation');                  // scenario key (first scenario if omitted)
M.setDials({ strain: 0 });
M.step(50);
M.injure();                             // if tissue.injury exists
M.state                                 // typed arrays, see below
M.stats()                               // generic stats, see below
M.stat('species.mat.fraction')          // any stat path from §1
M.snapshot(), M.exportMeta()            // export format §5
M.tissue                                // the definition
M.speciesIndex, M.fieldIndex, M.dialIndex
TissueEngine.checkScenario(tissue, scenarioKey, { seed })  // runs the scenario, evaluates `checks`, returns [{check, value, pass}]
```

`state`:
```
N, L, h, time, dt, dials{}, nCells, wound, tissue (key)
species: Float32Array[nSpecies] (each N³)       // by species index; state.speciesKeys
Txx..Tyz, fiberTotal (N³), fa, fx, fy, fz, E, inflam
fields: Float32Array[nFields] (each N³)          // by field index; state.fieldKeys
cx (3n), cp (3n), ca (n), cb (n), ctype (Uint8Array n)
```
`stats()`:
```
t, species: { <key>: mean, total: Σ means, fiberTotal }, fraction: { <key>: mean/total },
fa, globalFA, fz, logE, E, cells: { a, b, n }, fields: { <key>: mean },
deposition, degradation (both as MEAN density change per day over the tissue — already divided by N³),
ratio
```
Determinism: same tissue, seed, dial sequence → identical results in node and browser.

Performance budget: ≤ 0.5 ms per step at N = 12, 160 cells, in node (was 0.25 ms
in v0.1; the hook indirection may cost ~30 %).

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

## 5. Export format (v0.2, Blender-compatible)

```
{ "meta": { "format": 2, "tissue": "fibrous", "N":12, "L":1, "K":3, "dtDays":0.02, "scenario": "…",
            "dials": {...}, "species": [{key,label,kind,color}], "cellTypes": [{key,label,colors,shape,radius}],
            "exportEveryDays": 2 },
  "frames": [ { "t": 0,
      "species": { "new": [N³], "mat": [N³] },          // per species
      "fa": [N³], "f": [3N³],
      "rho": [N³], "phiMat": [N³],                      // kept for format-1 readers: rho = fiberTotal,
                                                        // phiMat = fraction of the LAST fiber species
      "cells": { "x": [3n], "p": [3n], "a": [n], "b": [n], "type": [n], "alpha": [n] } } ] }
```
`alpha` duplicates `a` for format-1 readers. The Blender importer reads
format 2 (species-coloured fibers, gel spheres, scaffold struts) and still
accepts format 1.

## 6. App contract

- Tissue picker at the top of the panel (segmented control); URL `?tissue=&scenario=&Gext=…`
  deep links; `history.replaceState` keeps the URL current (debounced).
- Dials, scenario cards, readouts, legend and About are generated from the
  definition. Injure button shown only when `tissue.injury` exists.
- Ghost traces: on Reset, the previous run's series stay as dashed reference
  lines until the next Reset (plots.js `setReference()`).
- Accessibility: every control labelled, `aria-live="polite"` region for the
  equilibrium sentence and flash messages, focus visible, `prefers-reduced-motion`
  disables auto-rotate, a "Table" toggle under the readouts renders the last
  values as an HTML table, canvas has `role="img"` and an `aria-label` that the
  app updates with a one-line description every few seconds.

## 7. Conformance: what a new tissue must pass

`node --test tests/*.test.mjs` runs, for every registered tissue:
1. schema validation of the definition (keys, kinds, colours, dial roles, scenario checks well-formed)
2. determinism (two engines, same seed → identical stats after 200 steps)
3. invariants (no NaN, densities ≥ 0, FA ∈ [0,1], cells inside the box)
4. every scenario's `checks` (headless run to the latest `at`)
5. performance (< 1 ms/step at N = 12, 160 cells, node)
Plus the fibrous tissue's golden regression: `tests/golden/fibrous.json`
(recorded from v0.1 `model.js` with seed 7) must be matched within 3 % on
meanRho, meanRhoMat, meanFA, meanAlpha at every recorded day.

## 8. Adding a tissue in five steps

1. `node tools/new_tissue.mjs mytissue "My tissue name"` → copies the template to
   `src/tissues/mytissue.js` and registers it in `src/tissues/index.js`.
2. Fill in species, fields, cellTypes, dials, and at least two scenarios with `checks`.
3. Write `makeRules`: start from the template's fibrous rules; change what the
   cells secrete and what the matrix does.
4. `node tools/run_headless.mjs --tissue mytissue` and `python3 tools/plot_scenarios.py`
   to see curves; tune until `node --test tests/*.test.mjs` passes.
5. `node tools/build_single.mjs`; open `index.html?tissue=mytissue`.
