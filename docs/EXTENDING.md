# Extending Tissue Weather — the tissue-definition contract (v0.4)

Tissue Weather separates a **generic engine** (grid, fields, cells, orientation
tensor, numerics, stats, export) from **tissue definitions** (what the matrix is
made of, what the cells do, which dials exist, which scenarios to teach). The
default fibrous connective tissue (fibroblasts, provisional matrix → collagen I)
is one definition; articular cartilage in a degrading hydrogel is the second.
Adding a tissue means adding one file under `src/tissues/` and registering it.

This document is the contract. Engine, renderer, app, tools and tests are
written against it. If you change it, change them.

The contract is at **v0.4**; the code that implements it still reports `ENGINE_VERSION` /
package.json `0.3.0`, which is bumped to `0.4.0` when the release is cut. Everything described
here runs today.

**What is new in v0.4.** Per-field / per-species **integration modes** for the diffusive passes
(`fields[].mode`, `species[].mode`, §2.6) instead of a silent clamp on the diffusion number,
`engine.loadMode: 'compression'` (§2.4), honoured `cellTypes[].motile: false` plus optional
`cellTypes[].count` and `cellTypes[].rCell` (§1), `species[].carryTensor` (§2.4),
`stats().cells.byType.<key>` (§3), a monotonic `state.revision` for renderer dirty-checks (§3),
resumable `warmFrom()` / `warmScenarios()` pre-runs (§3), `snapshot({ fields: false })` (§5),
`fields` / `loadRange` / `tissueName` / `scenarioTitle` / `render` in the export (§5), richer
scenario `checks` (`rel.factor`, `agg: 'cross'`, §1), `TissueEngine.notes()` / `warnings()`
(§7.1), the renderer contract in §4 and the normative step order in §2.5.

**Upgrading a v0.3 definition.** Almost all of the above is opt-in and additive — a key you do
not write, or a hook output you do not set, changes nothing. **Four** things move without an
opt-in, and a golden recorded under v0.3 has to be re-recorded if the definition uses them:

| what changed | who is affected | how to keep the old numbers |
|---|---|---|
| `fields[].mode` / `species[].mode` default to `'auto'` (§2.6) | a field or species whose `lam = D·dt/h²` is above 1/6 — v0.3 silently clamped it, so it integrated with a smaller D (cartilage's `o2` moves ~1.6 % on its check stats, more on `globalFA`) | pin `mode: 'explicit'` |
| `cellTypes[].motile: false` is honoured (§1) | a definition that already carried the key: such a cell no longer moves AND draws no random numbers, so every later draw shifts | set `motile: true`, or drop the key — it is optional and defaults to true |
| species `sink` is gated by the voxel hook's `out.mobility` (§2.4) | a tissue that writes both `sink` and `out.mobility` — cartilage's aggrecan moves up to ~3 % on the flux stats (and further in RELATIVE terms on near-zero ones such as `globalFA`) | write `out.mobility = 1` |
| `out.scaffoldLoss` is capped by the scaffold density the voxel actually lost (§2.2) | a hook that reports more dissolution than the species had left | cap it yourself, as before |

The fibrous tissue uses none of them and is bit-for-bit unchanged: `tests/golden/fibrous.json`
(3 %) and `tests/golden/fibrous.engine.json` (1e-5) both still pass, and every column the engine
golden already had was verified byte-identical after each change — it was re-recorded only to
add columns (`globalFA`, `fz`, `E`, `ratio`, `cells.c`, `cells.n`, `cells.byType.*`), never to
accept a moved number. `tests/golden/cartilage.engine.json` was recorded fresh, after the four.

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
`src/tissues/*.js` automatically, `index.js` last among them; a file whose name starts with `_`
is skipped, which is how `_template.js` stays out of the bundle while the tests still run it):
copy → engine → tissues/* → tissues/index → plots → recipe → render → app.
All files: ES modules, named exports only, unique top-level identifiers,
local imports written on one line as `import { a, b } from './x.js';`.

## 1. Shape of a tissue definition

```js
export const TISSUE_FIBROUS = {
  key: 'fibrous',                       // URL/registry key, [a-z0-9-]. `TissueEngine.validate()` asks
                                        // only for that; tools/new_tissue.mjs additionally wants it to
                                        // START with a letter and refuses `index`, `template`,
                                        // `_template`, `total` and `fiber` — and do not take a key a
                                        // test fixture already uses (see §8 step 1)
  name: 'Fibrous connective tissue',    // shown in the tissue picker
  short: 'Fibroblasts build, align and mature collagen under load',
  version: '0.2.0',
  domainMicrons: 300,                   // OPTIONAL (v0.4): how wide the cube really is. A positive
                                        // number adds a "Cube edge ≈ 300 µm" row to the app legend
                                        // (≥ 1000 is shown in mm); omit it and there is no row.
                                        // Declaring it is a claim about the tissue, so say the same
                                        // number in the copy: tests/fidelity.test.mjs R7 checks that a
                                        // tissue with a declared scale states it in words, exactly as
                                        // the legend row prints it ("300 µm", "1.5 mm"). Both shipped
                                        // tissues declare 300; a tissue that declares none is not
                                        // making the claim and is not checked.

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
  //                                   run after the voxel pass; above the stability limit the pass
  //                                   is sub-cycled (§2.6), and the per-face number is clamped at
  //                                   1/6 either way, so it is always stable. A fiber species
  //                                   carries its share of T with it (orientation travels).
  //   sink: 0.5, boundary: 'face:+z'  /day loss from the +z (medium) layer only:
  //                                   sink·rho·dt·mobility (v0.4: the voxel hook's out.mobility
  //                                   gates the leak as it gates diffusion).
  //                                   'face:+z' is the only species boundary and the default when
  //                                   sink > 0. The loss lands in stats().degradation, or in
  //                                   stats().scaffoldFlux for a species of kind 'scaffold'.
  //   mode: 'auto'                    v0.4, §2.6: 'auto' | 'explicit' | 'subcycled' — how the
  //                                   transport is integrated. A species never gets a
  //                                   quasi-steady solve: transport moves mass, it does not relax.
  //   carryTensor: false              v0.4, FIBER species only (§2.4): move the mass without
  //                                   moving T. Cheaper (≈ 0.06 ms/step instead of ≈ 0.2 at
  //                                   N = 12) and the right model for a felt whose fibrils do not
  //                                   keep their direction while they travel; the arriving mass
  //                                   takes the destination voxel's orientation (isotropic where
  //                                   it has none). Default true: matrix that moves keeps its
  //                                   direction. Either way trace(T) = Σ fiber species stays exact.
  //   render: { minDensity, radiusScale, opacity, style }   OPTIONAL renderer hints (v0.4, §4).
  //                                   Per KIND, not per species: the renderer draws one layer per
  //                                   kind, so it takes the lowest `minDensity`, the mean
  //                                   `radiusScale` / `opacity` and the first `style` declared by
  //                                   the species of that kind. `style` ('spheres' | 'points') is
  //                                   honoured for kind 'gel' only; a key a kind does not honour
  //                                   is reported through `renderer.hintWarnings`, not dropped
  //                                   silently. The engine does not read `render` at all.
  // The keys 'total', 'fiberTotal' and 'tissueTotal' are reserved by the stat paths.
  // `describe` is DOCUMENTATION ONLY: it is for whoever reads the definition, and nothing in the
  // app, the renderer, the tools or the export renders it (`readouts[].key` below is the same —
  // required by validate(), read by nothing). Anything a student must see belongs in `copy`.

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
  // Two OPTIONAL renderer hints live here too (v0.4, §4; the engine ignores both):
  //   pointScale: 1.4                 × the diameter of this field's haze blobs
  //   style: 'spheres' | 'points'     how they are drawn (renderer default: spheres)

  // ---- cell types (one or more; each cell carries a type index)
  // REQUIRED per type: `key`, `label`, `colors`, `shape`, `radius`. Everything else below is
  // optional, with the default named beside it.
  cellTypes: [
    { key: 'fibroblast', label: 'Fibroblast → myofibroblast',
      colors: ['#4ea3ff', '#ff7a3d'],     // colour lerped by the primary state a
      shape: { by: 'a', aspectMin: 1.0, aspectMax: 2.5 },  // ellipsoid aspect along polarity
      radius: 0.03, motile: true,         // motile (optional, DEFAULT true): false → the cell never
                                          // moves (v0.4, §2.5); a non-boolean is a validation error
      // fraction: 0.7,                   // this type's share of the total cell count (default: equal
                                          // shares among the types that declare no `count`)
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
  // counted ones. Without such a dial the tissue seeds Σ count cells — and ONLY those: a type
  // that declares no `count` then has a share of nothing left and is never seeded, which
  // `TissueEngine.warnings()` says out loud. Give every type a count, or add a cellCount dial.
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
      metaphor: 'Humidity: how much vapor is available to condense.', biology: '…', watch: '…' },
    { key: 'strain', label: 'Mechanical load', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2', role: 'load', metaphor: 'Pressure: a steady push that shapes the cloud.', biology: '…', watch: '…' },
    { key: 'protease', label: 'Protease activity', min: 0, max: 1, step: 0.01, default: 0.5, format: 'fixed2', metaphor: 'Temperature: how fast everything is torn apart again.', biology: '…', watch: '…' },
    { key: 'nCells', label: 'Cell number', min: 40, max: 400, step: 10, default: 160, format: 'cells', role: 'cellCount', metaphor: 'Condensation nuclei: droplets need something to form on.', biology: '…', watch: '…' },
  ],
  // `metaphor` has a grammar: 'Tag: one sentence.' The text BEFORE the first colon becomes the small
  // (lower-cased, decorative) tag beside the dial label, and the rest becomes the "Like <tag>: <rest>"
  // note inside the dial's "Metaphor & what to watch" disclosure. With no colon there is a tag and NO
  // note — which is why all three shipped definitions use the colon form. `biology` and `watch` are
  // the other two lines of that disclosure.
  // format: 'fixed2' | 'percent' | 'cells' | 'int' | 'onoff' (0/1 toggle shown as Off/On) | (v) => string
  // `percent` means the value IS a fraction of something (multiplied by 100 and given a % sign),
  // so a dimensionless 0–1 load knob is 'fixed2': "0.60", not "60 %" of an unnamed quantity.

  // ---- scenarios (ordered)
  scenarios: [
    { key: 'maturation', title: 'Scaffold to tissue', goal: '…', steps: ['…','…','…'], question: '…', expect: '…',
      dials: { Gext: 0.5, strain: 0.6, protease: 0.4, nCells: 160 },
      init: { species: { new: 0.15, mat: 0 }, jitter: 0.2,          // uniform ± jitter·50 %
              fields: { g: 0.2 } },                                 // OPTIONAL starting field values:
      //   without `init.fields`, a field with a `bath` dial starts at that dial's value and every
      //   other field starts at 0; an entry here overrides that for one field (unknown key = error)
      events: [                                                     // OPTIONAL scripted protocol
        { at: 20, dials: { Gext: 0.1 } },                           //   day 20: turn the bath down
        { at: 30, injure: { center: [0.5, 0.5, 0.5], radius: 0.25 } },  // day 30: wound it
      ],
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
  // `events` is the scenario's SCRIPT — a protocol the tissue teaches, not a suggestion the reader
  // has to reconstruct from the `steps` prose. Each entry is
  //   { at: <day ≥ 0>, dials: { <dialKey>: value, … } }        change dials on day `at`
  //   { at: <day ≥ 0>, injure: true | { center?: [x, y, z], radius?: number } }
  // and may carry both. `injure` without a `tissue.injury` block is a validation error; an unknown
  // dial key is too. `injure: true` (or `{}`) wounds at a random spot with the injury's own radius.
  // WHEN they fire:
  //   TissueEngine.checkScenario()  as soon as the clock reaches day `at` (it samples every 0.5 d,
  //                                 so an `at` between two samples fires at the next one), BEFORE
  //                                 the checks of that moment are read; the run is always long
  //                                 enough to reach the last event, even past the last check
  //   tools/run_headless.mjs        at the CSV boundary that reaches `at` (`--events false` skips
  //                                 them all), and each firing is recorded in the trajectory's
  //                                 `meta.events`
  //   tools/make_golden.mjs         after stepping to the day that equals `at` — so use whole days
  //                                 in a scenario you intend to record a golden for
  //   the app                       ONLY with "Auto-apply scripted events" on. The toggle sits under
  //                                 the scenario card, is OFF by default, is remembered for the
  //                                 browser session (`sessionStorage['tw.autoEvents']`), and the card
  //                                 lists the events either way — off, they read as instructions
  //                                 ("Reference run … here you do it by hand"); on, the app splits
  //                                 its step block at each event day so a fast run still fires them
  //                                 in order, marks the time axis and announces what it did.
  // So: write `events` when the protocol IS the teaching (a bath drop at day 20, a wound at day 30),
  // and write the same instruction into `steps` so a student who never finds the toggle still does
  // it. `init.from.events: true` replays the SOURCE scenario's events during a pre-run.
  // stat paths: species.<key> | species.<key>.fraction | species.total (INCLUDES scaffold species) |
  //             species.tissueTotal (excludes them) | scaffold (their sum) |
  //             fiber.total | species.fiberTotal (the same number under both names) |
  //             fa | globalFA | fz | logE | E | cells.a | cells.b | cells.c | cells.n | t |
  //             cells.byType.<key>[.n|.a|.b|.c] | fields.<key> | deposition | degradation |
  //             ratio (dep/deg) | scaffoldFlux | cumDeposition | cumDegradation (integrals of
  //             deposition / degradation since reset)
  // `fz` is Tzz/trace of the tissue-MEAN tensor: 1/3 when the tissue is isotropic and 1 when
  // everything points along the load axis z. It is NOT the mean of the per-cell `ctx.fz` of §2.1,
  // which is |f_z| of that voxel's local principal axis (different scale, different floor).
  // EVERY per-voxel stat is a mean over ALL N³ voxels, empty ones included — `fields.m` is the
  // mean protease over the whole cube, not over the voxels that hold a cell, so a source of
  // s/day in n of N³ voxels against a decay k settles near s·n/(k·N³), not s/k (§3).
  // ops: gt lt between (value: [lo, hi]) ; optional `rel: {stat, op, at?, factor?}` compares two
  // stats: the reference is rel.stat(rel.at) · factor (default 1) + value (default 0), so
  //   { at: 56, stat: 'species.gag', rel: { stat: 'species.gag', at: 14, factor: 2, op: 'gt' } }
  // is "it more than doubled between day 14 and day 56" without naming a number.
  // A check may cover a RANGE of days instead of one:
  //   { at: [28, 56], agg: 'min', stat: 'logE', op: 'gt', value: 1.5 }      // never dips below 30 kPa
  //   { at: [0, 21], agg: 'mean', stat: 'ratio', op: 'lt', value: 0.9 }     // evaporating on average
  //   { at: [14, 42], agg: 'max', stat: 'cells.c', rel: { stat: 'cells.c', at: 0, op: 'gt' } }
  //   { at: [0, 5], agg: 'cross', stat: 'fields.o2', op: 'lt', threshold: 0.18 }   // WHEN, not how much
  // agg is 'min' | 'max' | 'mean' | 'first' | 'cross' and is REQUIRED with a range (and rejected
  // without one). checkScenario samples the range every 0.5 d, endpoints included; with `rel` the
  // reference day defaults to the START of the range.
  //
  // `agg: 'cross'` answers "how long does this take?". It reports the FIRST sampled day inside the
  // range where `stat op threshold` holds, and passes when there is one — so the range is the
  // deadline and the reported `value` is a DAY, not a density (`ref` is the threshold, and the
  // result also carries `crossed: { day, stat }` for a report). It takes no `rel` and no `value`.
  //
  // Careful with a range compared against its own first sample: the aggregate INCLUDES that
  // sample, so `{ at: [a, b], agg: 'max', stat: X, rel: { stat: X, op: 'lt' } }` — "the maximum
  // stays below where it started" — can never pass, and neither can agg 'min' with op 'gt'.
  // TissueEngine.warnings() flags both. Write what you mean instead:
  //   { at: [a, b], agg: 'min', stat: X, rel: { stat: X, op: 'lt' } }            // it dips below its start
  //   { at: [a, b], agg: 'max', stat: X, rel: { stat: X, at: 0, op: 'lt' } }     // reference BEFORE the range
  //   { at: [a, b], agg: 'max', stat: X, rel: { stat: X, op: 'lt', factor: 1.1 } }  // never rises by 10 %

  // ---- readouts: which charts the panel shows, in THIS order — except the `type: 'flux'` gauge,
  //      which the app always hoists to the top of the panel (it is the readout the scenarios point
  //      at first), so declaring it last, as both shipped tissues do, still draws it first.
  //      type: 'stack' | 'lines' | 'log' | 'flux'. `key` is required by validate() but is read by
  //      nothing — the app keys its series off `series[].stat` and its table rows off `label`.
  readouts: [
    { key: 'density', label: 'Matrix density', unit: 'relative (1 ≈ dense tissue)', meaning: '…', type: 'stack',
      series: [{ stat: 'species.new', label: 'new matrix', color: '#3f97dc' }, { stat: 'species.mat', label: 'mature collagen', color: '#c4822a' }] },
    { key: 'align', label: 'Alignment & activation', unit: '0–1', meaning: '…', type: 'lines',
      series: [
        { stat: 'globalFA', label: 'alignment (whole tissue)', color: '#8f7ae0', marker: 'circle' },
        { stat: 'fa', label: 'local anisotropy', color: '#c3b6f2' },
        { stat: 'cells.a', label: 'cell activation', color: '#e0602a' }] },
    { key: 'stiff', label: 'Stiffness', unit: 'kPa (log scale)', meaning: '…', type: 'log', series: [{ stat: 'logE', label: 'stiffness', color: '#8fb8d8' }], domain: [-1, 2.5] },
    { key: 'flux', label: 'Matrix flux', unit: 'density per day', meaning: '…', type: 'flux' },
  ],
  // The panel prints the READOUT's `unit` and `meaning` under its chart. A SERIES' own `unit` is
  // used for that series' row in the values table ("Table" under the readouts), falling back to the
  // readout's — so a per-series unit is worth setting when the rows of one chart differ. A series'
  // `meaning` renders nowhere today; put anything the reader must see in the readout's `meaning` or
  // in the series `label`.
  // `domain: [lo, hi]` (per readout) sets the y axis; for `type: 'log'` it is in log10 kPa. Default
  // [-1, 2.5] for a log readout and [0, 1] for every other type. The chart WIDENS the axis rather
  // than clipping when the data leaves the domain, so a wrong domain is cosmetic. Not validated.
  // A chart that draws two different measures on one axis must say which is which in those
  // labels: `globalFA` (the anisotropy of the SUMMED tensor — does the whole cube pull one way)
  // and `fa` (the mean of the per-voxel anisotropies — are the individual patches ordered) are
  // the pair most worth keeping apart. 'alignment' alone names neither.
  // Two OPTIONAL keys keep a pair of series apart WITHOUT colour (v0.4, app-side):
  //   marker: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross'
  //                                             endpoint glyph; the app cycles all five in that
  //                                             order, so up to five series never collide. Declare
  //                                             it on a pair whose colours are luminance twins, so
  //                                             a later insertion cannot re-pair them.
  //   pattern: 'hatch' | 'none'                 fill hatching for a band of a `stack`; by default
  //                                             the app hatches the TOP band of a multi-band stack,
  //                                             and `pattern: 'none'` opts that band out
  // Declaring `pattern` on any series of a stack turns the automatic choice off for that readout.

  // ---- copy that is tissue-specific
  copy: {
    // `intro.paragraphs[0]` does double duty: its FIRST TWO SENTENCES are the first-run hint the
    // app shows above the controls before the clock has ever run (`short` is the fallback when
    // there is no intro), so write them as "what is this cube", not as a preamble.
    intro: { tagline: '…', paragraphs: ['…', '…', '…'] },
    metaphorBreaks: [{ claim: '…', reality: '…' }],
    legend: { fibers: '…', cells: '…', fields: { g: '…', m: '…' }, load: '…' },
    gauge: { left: 'evaporating', right: 'condensing', ratio: 'deposition / degradation', scaffold: 'scaffold dissolving' },
    vocabulary: { matrix: 'collagen', cellsActive: 'activated cells are pumping out collagen', cellsQuiet: 'the cells are quiet' },
  },
  // `legend` is drawn key by key IN ITS OWN ORDER: every string value, plus every string inside a
  // nested object (that is how `fields` produces one line per field). The key names above are the
  // conventional ones, not a fixed set — an unrecognised key such as `wound: '…'` is rendered too.
  // The one key the app treats specially is `load`, which is SKIPPED when the tissue has no
  // `role: 'load'` dial (there are no arrows to explain). Nothing has to cover everything — a
  // tissue with no scaffold species simply omits `scaffold`, and a field with no line under
  // `fields` gets no sentence (the colour swatch above it is generated either way).
  // `gauge` (v0.4) renames the two sides of the flux gauge, the ratio caption (`ratio` is the name;
  // `caption` is an accepted alias and `ratio` wins) and the third bar; anything omitted keeps the
  // weather wording. `ratio` and `scaffold` reach the text VALUE beside the readout title as well as
  // the canvas (the app's `gaugeValueText()` delegates to `FluxGauge.describe()`), so they are what a
  // screen reader hears, not just what the bars are captioned.
  // The third bar can be named twice: `gauge.scaffold` OVERRIDES `vocabulary.scaffoldNoun` on the
  // gauge (and in the value beside its title), while the values-TABLE row is always
  // `vocabulary.scaffoldNoun`. Setting only `gauge.scaffold` therefore leaves the two disagreeing:
  // set `scaffoldNoun` (which both read), and `gauge.scaffold` only if the bar needs other words.
  // `vocabulary` fills the equilibrium sentence (src/copy.js). Only `matrix`, `cellsActive` and
  // `cellsQuiet` are required; the rest have defaults:
  //   cellsMid / cellStateNoun            the halfway clause, and the state's noun ('activation')
  //   activeStiff / activeSoftening       what follows `cellsActive` when the matrix is already
  //                                       stiff / still soft, and `stiffHigh` continues the first
  //   stillHint                           the clause used when there is almost no matrix yet
  //                                       (null → built from `matrix`)
  //   metaphor                            { still, condensing, evaporating, steady } — the four
  //                                       phrases naming the balance. A tissue that does not want
  //                                       the weather says { still: 'the tissue is idle', … }.
  //   thresholds                          { quiet, active, empty, stiffKPa, condensing,
  //                                       evaporating, still } — where the sentence switches.
  //                                       `empty` is measured on `species.tissueTotal`, so an
  //                                       undissolved scaffold does not count as matrix, and the
  //                                       "already stiff" clause additionally requires density ≥
  //                                       `empty` — a fresh trellis can no longer be credited to
  //                                       the cells. Set `stiffKPa` above the stiffest cast your
  //                                       tissue can start as, or that clause fires on day 0.
  //   equilibrium(stats, V)               a function that REPLACES the sentence outright; a falsy
  //                                       or non-string return falls back to the generic one
  //   scaffoldNoun                        what to call the third flux bar
  // `metaphor` and `thresholds` are merged key by key, so overriding one phrase keeps the others.

  // ---- injury (optional; omit to hide the Injure button)
  injury: { radius: 0.25, clearSpecies: ['new', 'mat'], fieldBurst: { g: 0.6, m: 0.8 },
            inflammation: { sources: { g: 4, m: 1 }, tau: 5 },
            flash: 'Wound inflicted. Watch the hole refill.' },   // OPTIONAL (v0.4) app announcement

  // ---- engine-level numerics this tissue wants (all optional; engine defaults shown).
  //      This is the COMPLETE list (ENGINE_DEFAULTS): a key that is not one of these is a hard
  //      validation error, so the list is the allow-list as well as the reference.
  engine: { N: 12, dt: 0.02, rhoMax: 2, kLoadFib: 0.06, loadExp: 2, fEvery: 4, rCell: 0.03, kRep: 0.5,
            L: 1,              // cube side in engine units (every D is in L²/day; domainMicrons says
                               // what it is in microns, and changing L rescales nothing else for you)
            K: 3,              // fiber instances drawn per voxel — renderer and export meta only
            nCellsMax: 400,    // minimum capacity of the cell arrays (the real capacity is the larger
                               // of this and the role:'cellCount' dial's max)
            eps: 1e-6,         // a voxel whose fiber total is ≤ eps has its tensor and fiber species
                               // zeroed (the guard against dividing by a vanished trace)
            trace: 'fiber',    // 'fiber': T trace = Σ fiber species; scaled on degradation.
                               // It is the ONLY accepted value — anything else is a validation error
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
ctx.out.loss        total matrix LOSS rate this voxel (density/day, ≥ 0) — this is the ONLY thing it
                    does: it is summed into stats().degradation, the evaporating side of the flux
                    gauge. The engine does not derive dRho from it and does not release any field
                    from it; a loss that should release something writes that itself into
                    out.fieldSrc (below), the way fibrous releases stored growth factor.
ctx.out.scaffoldLoss  dissolution rate of a 'scaffold' species (density/day, ≥ 0). It is neither
                    deposition nor degradation of TISSUE, so it is reported separately as
                    stats().scaffoldFlux — the third flux bar — and left out of `loss`.
                    v0.4: when the ≥ 0 clamp on `dRho` truncated a scaffold species this step, the
                    engine reports min(scaffoldLoss, what the scaffold species ACTUALLY lost / dt)
                    instead — a hook that keeps asking for dissolution after the network has gone
                    no longer keeps a bar lit. Below that cap nothing changes.
ctx.out.mobility    0..1 (default 1): how freely species transport (§2.4) moves matrix INTO and OUT
                    of this voxel, e.g. `1 - conf` for a tight hydrogel mesh. Read when any species
                    declares `D` or `sink`: a diffusive face uses the mean of its two voxels, and
                    (v0.4) a `sink` uses the face voxel's own value, so a sealed mesh (mobility 0)
                    also stops the leak to the medium.
ctx.out.fieldSrc[f] field source from the VOXEL itself (field/day), added to this voxel's source for
                    field f alongside everything the cells in it wrote through their own
                    out.fieldSrc. Negative is a sink (the field is clamped ≥ 0 afterwards). This is
                    how matrix-bound signal is released as the matrix is cut:
                      out.fieldSrc[iG] = kGrel * dv;      // src/tissues/fibrous.js
ctx.out.E           stiffness (kPa) of this voxel now
```
Fiber species and T: when the total fiber density changes through `dRho`, the
engine scales T by (new total / old total), preserving orientation. Species
conversion between two fiber species (new → mat) is expressed purely through
`dRho` (−x on one, +x on the other); T is untouched because the trace is
unchanged.

### 2.3 `stiffness(ctx)` (optional)

If present, called after reset/injure to fill E without a full step. Its inputs are the same as
`voxel`'s with three exceptions: `ctx.dt` is 0, `ctx.aSum` is 0 and every `ctx.vox[k]` is 0 (no
cell pass has run yet in that call; `ctx.nCellsHere` IS the real count). Only `out.E` is read —
every other output of that call is discarded. Without the hook the engine calls `voxel` itself
under exactly those conditions, which is why a `voxel` hook must not assume a positive `dt`.

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
     principal axis are refreshed on the usual `fEvery` cadence.
     `carryTensor: false` (v0.4) turns that half off for one fiber species: the mass
     still moves and trace(T) is still exact, but no tensor travels with it, so the
     arriving matrix takes whatever direction the destination voxel already had
     (isotropic where it had none). That is the model for a felt whose fibrils do not
     hold their direction while they creep, and it is the cheaper one — see below;
  3. `sink`: the +z layer loses `sink·rho·dt·mobility` (into `degradation`, or into
     `scaffoldFlux` for a scaffold species). v0.4: the mesh gates the leak, as it gates
     diffusion — mobility 0 seals the face.
  Transport is the one engine mechanism that costs real time: at N = 12 a
  non-fiber species (or a fiber species with `carryTensor: false`) with `D` adds
  ≈ 0.06 ms/step and a tensor-carrying fiber species ≈ 0.2 ms (it also carries six
  tensor components per face and refreshes FA). Declare `D` where the movement
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
   pushed apart, and positions/polarities are reflected off the walls. The overlap correction is
   split between the partners that can MOVE: half each for two motile cells, ALL of it to the
   motile one when its partner is `motile: false` (an obstacle pushes as hard as it is pushed),
   and a pair of non-motile cells is skipped.
4. **Voxels, in index order.** For each voxel: `voxel(ctx)` is called, then the engine
   integrates `out.dRho[s]·dt` and clamps each species ≥ 0 (and caps `out.scaffoldLoss` by what
   that clamp actually left behind, §2.2); rescales T so trace(T) equals the new
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
integrates a fast field with a smaller D than the definition declares (at N = 12, dt = 0.02,
lam = 2.88·D, so the ceiling is D ≈ 0.0579 L²/day — cartilage's declared oxygen D of 0.06 is
already just above it, at lam = 0.173, and a physiological oxygen D is three orders of magnitude
above it). Since v0.4 the
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
validation error. Below the stability limit `'subcycled'` runs as ONE sub-step, which is the same
arithmetic as `'explicit'`, and is reported as `'subcycled'` because that is what the definition
asked for. `engine.fieldModes` / `engine.speciesModes` report
`{ key, D, lam, mode, nSub, capped }` (fields also `steady`) for every field and species (§3);
`TissueEngine.validate()` prints a `console.warn` only when the engine is
doing something OTHER than what was asked (a clamped `'explicit'`, a sub-cycle that hit the cap, a
`'quasiSteady'` that fell back) — a correctly integrated fast field is not a warning, and its note
is still in `TissueEngine.warnings()` (§7.1).

**Choosing D for a fast field.** The mode is a numerical decision; the timescale is yours. Diffusion
crosses the cube in ≈ L²/D days, so a field that should equilibrate within a day of its sources
needs `D ≳ L²` per day — at L = 1 that is D ≳ 1, and a real small molecule is far above it (oxygen
in cartilage is ≈ 10³ L²/day for a 300 µm cube). Picking a D that "looks stable" instead is how a
gradient ends up forming over two simulated weeks: sub-cycling makes the declared D integrate
CORRECTLY, it does not make a slow D fast. Declare the physical D, let `auto` pick `quasiSteady`,
and let the concentration profile be an instantaneous function of the sources — which is what a
metabolite in a 300 µm cube is on a timescale of days.

**The quasi-steady solve.** For a field whose diffusion is orders of magnitude faster than one
step, the profile is always at equilibrium with its sources, so the engine solves

    0 = D∇²g + kBath·(bath − g) + src − decay·g + wInf·inflam

on the same stencil (zero-flux walls; a `boundary: 'face:±z'` layer held at the bath dial) with
warm-started Gauss-Seidel sweeps (over-relaxed, at most 50 per step, stopped once the ESTIMATED
remaining error — the sweep's largest change amplified by the contraction rate it is observing —
is under 1e-4 of the size of the field — a raw per-sweep increment is not an error bound), clamped
≥ 0. It is only well posed when the flux has somewhere to go — a Dirichlet face, `kBath > 0`, or
`decay > 0`; without one of those `auto` keeps sub-cycling and an explicit `'quasiSteady'` request
falls back to sub-cycling with a warning.

Two consequences worth knowing when you write the rules:

- the sources are the ones your hooks wrote at the START of the step, so a source that depends on
  the field (Michaelis-Menten uptake, say) makes this a lagged fixed-point iteration. The engine
  therefore moves the field only half-way to each solve, which damps the "everything consumed /
  nothing consumed" oscillation and leaves the fixed point — the true steady state — unchanged.
  A gradient held by a Dirichlet face settles over a handful of steps (measured against the
  analytic parabola: 2·10⁻⁶ absolute). A field with NO face, held only by `decay` with a decay
  length longer than the cube, is the slow case: its profile is nearly uniform, the sweeps have
  almost nothing left to grip, and it approaches `source/decay` over tens of steps rather than
  in one (within 0.05 % after 50 steps, on the bench case the test suite pins);
- the clamp at 0 means a consumption that exceeds what diffusion can supply empties a region
  instead of driving the field negative. Write consumption as a saturating rule
  (`-kO2·o2/(o2 + Km)`), not a constant sink, if you want the starved region to be physical.

## 3. Engine API (what app, tools and tests use)

```js
import { TissueEngine } from './engine.js';
import { TISSUES, TISSUE_DEFAULT } from './tissues/index.js';

const M = new TissueEngine(TISSUES.fibrous, { seed: 7, overrides: { N: 12 } });
M.reset('maturation');                  // scenario key (first scenario if omitted)
M.reset('maturation', { dials, init, seed })   // shallow overrides of the scenario's own dials / init
                                        // (a headless run config is exactly { scenario, dials, init })
M.setDials({ strain: 0 });
M.step(50);
M.injure();                             // if tissue.injury exists
M.warmFrom(from, 500)                   // v0.4: advance an init.from pre-run by ≤ 500 steps
M.warmScenarios(200)                    // v0.4: same, for every scenario of the tissue
M.state                                 // typed arrays, see below
M.stats()                               // generic stats, see below
M.stat('species.mat.fraction')          // any stat path from §1
M.snapshot(), M.exportMeta()            // export format §5
M.snapshot({ fields: false })           // v0.4: same frame without the per-field grids (§5)
M.tissue                                // the definition
M.speciesIndex, M.fieldIndex, M.dialIndex
M.scratch                               // a per-engine object makeRules() may cache arrays on
M.nVox                                  // number of per-voxel accumulators (engine.vox)
M.revision                              // v0.4: monotonic counter, bumped by step/reset/injure/setDials
M.fieldModes, M.speciesModes            // v0.4: what §2.6 chose. Field entries are
                                        // { key, D, lam, mode, nSub, capped, steady }, species entries
                                        // the same without `steady` (a species is never solved steadily);
                                        // `capped` = the diffusion number was clamped or the sub-step
                                        // count hit the cap, `steady` = a steady solve is well posed
TissueEngine.notes(tissue, { overrides })     // v0.4: [{ text, actionable }] — validate() prints the actionable ones (§7.1)
TissueEngine.warnings(tissue, { overrides })  // v0.4: the same notes as plain strings
TissueEngine.checkScenario(tissue, scenarioKey, { seed, engine })  // runs the scenario (firing its
                                        // `events`), evaluates `checks`, returns [{check, value, ref, pass}];
                                        // pass an `engine` of the SAME tissue to reuse its init.from cache
TissueEngine.cellStates(cellType)       // [{ key, label, range }] merged from states / stateLabels / cRange
TissueEngine.statFrom(stats, path)      // one stat out of an existing stats() object
```

`state`:
```
N, L, h, time, dt, revision, dials{}, nCells, wound, tissue (key), scenario (key)
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
fa, globalFA, fz, logE, E, fields: { <key>: mean over ALL N³ voxels — see below },
cells: { a, b, c, n, byType: { <cellType key>: { n, a, b, c } } }   // byType is v0.4
deposition, degradation (both as MEAN density change per day over the tissue — already divided by N³),
ratio         deposition / degradation
scaffoldFlux  MEAN scaffold dissolution rate (Σ out.scaffoldLoss / N³) — the third flux bar
cumDeposition, cumDegradation           ∫ deposition dt and ∫ degradation dt since the last reset
                                        (a density, not a rate; both restart at 0 on reset)
```
`woundStats()` has the same species / fraction / fields shape (with tissueTotal) inside the wound.

Every per-voxel stat — `species.<key>`, `fields.<key>`, `fa`, `E` — is a mean over **all N³
voxels**, the empty ones included, and `deposition` / `degradation` are likewise divided by N³.
A source that only a cell's own voxel sees is therefore diluted by the fraction of occupied
voxels: 160 cells at N = 12 sit in ~200 of 1728 voxels, so a per-cell source `s` against a decay
`k` shows up as roughly `s·200/1728/k`, not `s/k`. Tune a scenario check against a headless run
(§8 step 4), never against the naive single-voxel steady state.

`state.revision` (v0.4) counts every mutation of the state: `step()` bumps it once per simulated
step, `reset()`, `injure()` and a `setDials()` that resolved at least one dial bump it once.
A renderer or plot can skip its work while it is unchanged, and must fall back to "always update"
when it is `undefined` (an older engine, or a hand-built state object).

**Resumable pre-runs** (v0.4). `reset()` on a scenario with `init.from` runs the source scenario
synchronously — 3000 steps, ~0.8 s for fibrous — the first time. `warmFrom(from, maxSteps)`
advances that same pre-run by at most `maxSteps` steps and caches it when it finishes, so an app
can spread the cost over animation frames: it returns `{ done, key, scenario, steps, remaining }`
(`key` is the cache key, `scenario` the SOURCE scenario being pre-run) and is cheap to call again
once `done`. `warmScenarios(maxSteps)` does it for every scenario of the tissue, one slice per
call, and returns `{ done, scenario, from, steps, remaining }` — here `scenario` is the scenario
that is WAITING for the pre-run and `from` the one being run for it — or
`{ done: true, scenario: null, … }` when every pre-run is cached. Slicing is bit-identical to the
synchronous run (events fire on the same day boundaries),
the warmed engine's own state is untouched, and the cache key includes the seed — warm with the
seed the reset will use. The pre-run engine is built WITHOUT resetting it to `scenarios[0]`
first, so the first slice costs one slice even when `scenarios[0]` has an `init.from` of its own.

Determinism: same tissue, seed, dial sequence → identical results in node and browser. Every
v0.3 addition is behind an opt-in flag on the definition or a hook output that defaults to "not
written", so a v0.2 definition runs bit-for-bit as it did. Four v0.4 changes act on keys that
already existed and DO move such a definition — see the upgrade table at the top of this file.

Performance budget: ≤ 0.5 ms per step at N = 12, 160 cells, in node (was 0.25 ms
in v0.1; the hook indirection may cost ~30 %). Measured after the v0.4 work: fibrous 0.22 ms,
the starter 0.20 ms, cartilage 0.56 ms — cartilage is over the budget because it asks for four
species (two of them transported), three fields (one sub-cycled) and a wound; the conformance
suite's hard limit is 1 ms/step. If a tissue needs the budget back, `carryTensor: false` and a
larger `dt` (fewer, longer steps) are the two big levers.

## 4. Renderer contract

`new TissueRenderer(canvas, opts)`; `renderer.setTissue(tissue)` (re)builds the layers from
`species`, `fields`, `cellTypes` and the `role: 'load'` dial; `renderer.update(state, layers)`
draws one state; `renderer.dispose()` releases the GPU resources.

```js
renderer.update(state, layers)   // layers { fibers, cells, scaffold, gel, wound, fields: { g: true, … } }
                                 // fibers/cells/scaffold/gel/wound default on, fields default off.
                                 // With NO `fields` object the renderer also honours a top-level
                                 // per-field flag (`layers.g`), which is how an app that keeps one
                                 // flat checkbox map per layer works without reshaping it.
renderer.render()                // one frame (controls damping + auto-rotate + draw)
renderer.resize()                // fit the canvas to its parent, keep the cube framed
renderer.setAutoRotate(on)       // fires opts.onAutoRotate(on) when the value CHANGES
renderer.resetView()             // camera back to the default framing
renderer.orbit(dTheta, dPhi)     // orbit by radians       — the whole camera API is these three,
renderer.dolly(factor)           // distance × factor        so an on-screen orbit/zoom control
renderer.markDirty()             // force the next update() to rebuild   needs no internals
renderer.layoutParams()          // the fiber recipe in use → export meta.render (§5, src/recipe.js)
renderer.legendSwatches()        // [{ key, kind, label, css }] for the app legend
renderer.screenshot()            // PNG data URL
renderer.stats                   // { updateMs, updates, skipped, fibersVisible, cells, … }
renderer.hintWarnings            // [string]: `render` hints the last setTissue ignored
TissueRenderer.tissueFromState(state)   // fallback definition when no tissue was set
```

- fiber layer: one InstancedMesh, K instances per voxel; radius from
  `fiberTotal`, direction from f/FA (v0.1 recipe), colour = Σ_s (rho_s/fiberTotal)·color_s.
- gel layer: one InstancedMesh of low-poly spheres, one per voxel, scale ∝
  density^(1/3), translucent, colour = species colour (one gel species; if
  several, mix by density).
- scaffold layer: fixed lattice of struts (3 per voxel along x, y, z),
  opacity/radius ∝ density, colour = species colour. Reads as a hydrogel that dissolves.
- cells: colour lerp by `a` between `colors`, aspect from `shape.by` (a or b),
  radius from the type (a number, or `{ by, min, max }` — §1).
- field layers: one blob per voxel per shown field, diameter × `fields[i].pointScale`,
  drawn as spheres or `fields[i].style: 'points'` sprites.
- `wound` layer: the outline of the last `state.wound` sphere, brightest just after the injury
  and fading over about a week. It is O(1) and is refreshed even on a skipped update.
- load arrows appear only if a `role: 'load'` dial exists, and are normalised by that dial's
  `[min, max]`, so a 0–0.2 compression dial draws the same arrow range as a 0–1 stretch dial.
- **Dirty check (v0.4).** `update()` rebuilds the instance buffers only when something it draws
  changed: it compares `state.revision` (§3), N, the cell count and the layer set with the last
  call, and returns early otherwise (the load arrows and the wound marker are refreshed either
  way). A state WITHOUT `revision` always takes the full path, so anything that fed the renderer
  before v0.4 keeps working. `stats.updates` / `stats.skipped` count the two paths, and
  `markDirty()` forces the next call through.
- **Definition hints (v0.4).** `species[].render` and `fields[].pointScale` / `style` (§1) are
  read here and nowhere else. A hint key that a species' kind does not honour is collected in
  `hintWarnings` and logged once, rather than being silently dropped.
- `legendSwatches()` returns the definition's colours **through this renderer's exposure and tone
  curve** (and nothing else: no lighting, rim or fog), so a legend chip matches the pixels on
  screen to within 1/255.

## 5. Export format (v0.2 shape, Blender-compatible)

```
{ "meta": { "format": 2, "tissue": "fibrous", "N":12, "L":1, "K":3, "dtDays":0.02, "scenario": "…",
            "tissueVersion": "0.2.0", "engine": "0.3.0", "seed": 7,   // definition version, ENGINE_VERSION,
                                                                     // and the RNG seed of the run
            "dials": {...}, "loadDial": "strain", "cellCountDial": "nCells",
            "loadRange": [0, 1],                          // v0.4: [min, max] of the load dial
            "tissueName": "…", "scenarioTitle": "…",      // v0.4: display labels
            "species": [{key,label,kind,color}], "cellTypes": [{key,label,colors,shape,radius[,radiusBy]}],
            "fields": [{key,label,color[,pointScale][,style]}],   // v0.4: mirrors `species`, for the frame grids
            "render": { "recipe": "fiber-v1", "seed": 90210, "K": 3, "fiber": {…} },  // v0.4, optional
            "ramp": { "mode": "oklab", "lift": …, "mid": "#rrggbb"|null, "saturation": … },  // v0.4, optional
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

`tissueVersion` / `engine` are `tissue.version` and `ENGINE_VERSION`, and `seed` is the RNG seed the
run used — the three keys that make an export reproducible: same tissue version, same engine, same
seed, same dials → the same frames. `loadDial` / `cellCountDial` name the dials carrying those roles
(null when the tissue has none), so a reader knows which dial to draw load arrows for instead of
guessing at `strain`, and `loadRange` (v0.4) is that dial's `[min, max]`, so a reader can
normalise it — a 0–0.2 compression dial should draw the same arrow range as a 0–1 stretch dial.
`fields` (v0.4) mirrors `species` for the per-frame field grids, which are rounded to four
decimals, and carries a field's `pointScale` / `style` render hints (§1) when the definition
declares them — only then, so an export is byte-identical for a definition that sets neither, and
a reader treats an absent hint as the renderer default.

A FIBER species' `render.minDensity` and `render.radiusScale` DO travel: the renderer folds them
into the fiber laws it resolves, so they arrive inside `meta.render.fiber` (as `minDensity`, and as
a `radiusScale` already multiplied into the renderer's own factor), and a reader that honours
`render` reproduces them rod for rod. Nothing else travels yet — a fiber's `render.opacity` and
every gel / scaffold hint are honoured in the browser and drawn at the defaults offline.

A reader must tolerate a frame without the field grids (older files, and `snapshot({ fields:
false })` — a 120-frame export ring buffer is 26-38 % smaller without them) and a meta without
`fields` / `loadRange` / `tissueName` / `scenarioTitle`. A cell type with a state-dependent radius exports the
state-0 value as `radius` (readers that expect a number keep working) plus
`radiusBy: { by, min, max }`. Frames are unchanged from v0.2.

`render` (v0.4, optional) is the fiber recipe the browser actually drew with —
`renderer.layoutParams()` → `recipeRenderMeta()` in src/recipe.js: the layout stream (`seed`, `K`
and the five jitter constants, which nothing can override, so the block always describes the
layout that was drawn) plus the resolved per-frame laws (`radiusBase/Scale`, `minRadius`,
`lengthScale/Base/FA`, `minDensity`, `minDensityRamp`, `rhoMaxDraw`). An offline renderer that
honours it reproduces the browser's rods rod for rod; one that ignores it falls back to its own
copy of the defaults, which is why the key is optional. `recipe` names the layout so a reader can
refuse a stream it does not know.

`ramp` (v0.4, optional) is the cell colour ramp: `{ mode: 'oklab' | 'oklch' | 'rgb', lift, mid,
saturation }`, which is how `cellTypes[].colors` are interpolated between state 0 and state 1.
Nothing in this repo WRITES it yet — blender/import_tissue.py reads it so a deck of frames can
pin the ramp its figures were made with; without it a reader uses the web renderer's defaults.

A reader must ignore meta keys it does not know: the block grows.

## 6. App contract

- Tissue picker at the top of the panel (segmented control); deep links carry the whole view —
  `?tissue=&scenario=&<dial>=…&speed=&present=1&rotate=0&debug=1` (one parameter per dial of the
  definition, `speed` in simulated days per second, `present` presentation mode, `rotate=0` auto-
  rotate off, `debug` the diagnostics overlay); `history.replaceState` keeps the URL current
  (debounced), and every parameter it writes it also reads back.
- Dials, scenario cards, readouts, legend and About are generated from the
  definition. Injure button shown only when `tissue.injury` exists.
- Ghost traces: on Reset, the previous run's series stay as dashed reference
  lines until the next Reset (plots.js `setReference()`).
- Accessibility: every control labelled, and ONE POLITE announcing region — the visually
  hidden `aria-live="polite"` `#status` — for state changes, flash messages and the chart
  crosshair, plus ONE assertive `role="alert"` region (`#notice`) used only for a fatal notice
  such as WebGL being unavailable. The visible `#equilibrium` sentence carries no live role
  (it is rewritten too often), and every `<output>` (the dial values and the speed readout) carries an explicit
  `aria-live="off"`, because `<output>` maps to `role="status"` and would otherwise announce
  every frame of a slider drag. Focus visible; `prefers-reduced-motion` disables auto-rotate;
  a "Table" toggle under the readouts renders the last values as an HTML table.
  The canvas keeps `role="img"` with an `aria-label` the app refreshes every few seconds, plus
  `aria-describedby="view-keys-hint"` and `aria-keyshortcuts` naming the camera keys — both are
  withdrawn if WebGL never arrives, so the page never advertises keys it cannot honour. The
  single-character shortcuts (`r` `i` `p` `1`–`9`) have an off switch in About, remembered in
  `localStorage['tw.shortcuts']` (default on; Space is never gated), and turning them off also
  removes the `aria-keyshortcuts` that advertised them. When the stage is too short to open the
  legend clear of the HUD, the legend moves into the console (`body.legend-docked`).

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
6. the as-built parameter block: every registered tissue needs `docs/tissues/<key>.md` (or an entry
   in `PARAMS_DOCS`) whose generated block matches its `engine` / `params` — see §8 step 5
7. copy that agrees with the definition (tests/fidelity.test.mjs): among others, a tissue that
   declares `domainMicrons` must state that same size in its copy, in the words the legend prints
Plus the fibrous tissue's golden regression: `tests/golden/fibrous.json`
(recorded from v0.1 `model.js` with seed 7) must be matched at every recorded day on
meanRho, meanRhoMat, meanFA, meanAlpha, within 3 % relative or 0.01 absolute, whichever is larger
(the absolute floor is what keeps a stat that passes through zero from failing on noise).
Plus a feature suite on throw-away fixture tissues (species `D` conserves mass and stays
bounded, `sink` drains only the +z layer and is gated by `out.mobility`, a fiber species carries
T unless `carryTensor: false`, `out.mobility` hinders transport, `polS` / `alignS`, `out.vox[k]`,
the scaffold flux — including its cap — and the cumulative stats, aggregated checks, `rel.factor`,
`agg: 'cross'`, `init.from.events` / `dials`, `exportMeta`, `cellStates`, the §2.6 mode choice
against analytic solutions, `motile: false`, `cellTypes[].count` / `rCell`, `state.revision`,
`warmFrom` slices and `snapshot({ fields: false })`).
Plus the engine golden of every tissue whose numbers are meant to be stable:
`tests/golden/<tissue>.engine.json`, compared on every recorded stat path at 1e-5 relative or 1e-7
absolute, whichever is larger (fibrous and cartilage today). Recording one is the whole recipe —
`node tools/make_golden.mjs --tissue <key> --out tests/golden/<key>.engine.json`, or
`npm run golden` for fibrous — and NOTHING else: tests/engine.test.mjs discovers every
`tests/golden/*.engine.json` and registers a suite for it, so no test file is edited. A golden
whose tissue is no longer registered fails loudly rather than being skipped. Re-recording an
existing golden is a deliberate act and belongs in the commit message.
If a tissue uses an optional engine feature, exercise it in a scenario `check`: the conformance
suite has no way to know that `D` should have spread something unless a check says so.

### 7.1 Notes and warnings (v0.4)

`TissueEngine.validate(t)` still returns only hard errors. `TissueEngine.notes(t, { overrides })`
returns the non-fatal observations as `[{ text, actionable }]` (`TissueEngine.warnings()` is the
same list as plain strings), and validate() prints — once per definition object, with
`console.warn` — only the **actionable** ones: those where the engine is doing something other
than what the definition asks, or where a setting will not do what it looks like.

Printed (actionable):

- a field or species with `mode: 'explicit'` whose `lam = D·dt/h²` is above 1/6 — the diffusion
  number is CLAMPED, so it runs with a smaller D than declared, and the note says which;
- a sub-cycled field that hit the 20-sub-step cap, or a `'quasiSteady'` request that fell back
  because the steady problem is not well posed;
- a repulsion range `2·max(rCell)` that is no longer smaller than a voxel — the pair search only
  looks at the 27 neighbouring bins, so wider cells would miss each other;
- cell seeding with neither a `role: 'cellCount'` dial nor any `cellTypes[].count` (nothing will
  be seeded), or with `count` on some types and no dial, which leaves the types WITHOUT a count
  unseeded (§1);
- a windowed `check` whose aggregate is compared with its own first sample in the direction that
  can never pass (§1).

Kept as notes, not printed: the mode of a field or species the engine integrates correctly
(sub-cycled, or a well-posed quasi-steady solve), and a `role: 'cellCount'` dial together with
`cellTypes[].count`. They are documented behaviour, `engine.fieldModes` / `speciesModes` report
them as data, and a console line on a healthy tissue is how a reader learns to ignore the console.

## 8. Adding a tissue in seven steps

1. `node tools/new_tissue.mjs mytissue "My tissue name"` (`npm run new-tissue -- mytissue "My
   tissue name"` is the same tool) → copies the template to `src/tissues/mytissue.js`, registers it
   in `src/tissues/index.js`, and writes `docs/tissues/mytissue.md` with the as-built block of
   step 5 already generated. `--dry-run` prints what it would do and writes nothing. The scaffold
   passes the whole suite as it comes out, so run `node --test tests/*.test.mjs` once before you
   change anything: a failure then is the environment, not your biology.
   Pick a key no test fixture already uses: `tests/tools.test.mjs` scaffolds a throw-away tissue
   into a copy of `src/`, so a real `src/tissues/<that key>.js` makes the scaffolder refuse and
   the tools suite fail before you have written a line of biology. The reserved keys are
   `demotissue` and `demo-tissue`, chosen because no real tissue would want them; grep the tests
   for the key you want if `npm test` starts failing right after scaffolding.
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
4. `node tools/run_headless.mjs --tissue mytissue` and `python3 tools/plot_scenarios.py --tissue
   mytissue` to see curves; the CSV carries `cumDeposition`, `cumDegradation`, `scaffoldFlux`
   and `species.tissueTotal` next to the per-species columns. (Every flag of either tool is
   documented in the header comment at the top of the file, which is the only place they are.)
5. Write the prose of `docs/tissues/mytissue.md` — what the tissue is, where its numbers come
   from — around the generated block the scaffolder already put there between
   `<!-- params:mytissue -->` and `<!-- /params:mytissue -->`. After changing any `engine` or
   `params` value, re-run `node tools/check_params_doc.mjs --write`; the suite compares every
   number in that block with the code, so a parameter change without the rewrite fails.
   The checker resolves a tissue's document as `docs/tissues/<key>.md` by those markers, so
   NOTHING in `tools/` has to be edited (`PARAMS_DOCS` is only the exception list, for the two
   shipped tissues whose blocks live in `docs/MODEL.md` and `docs/tissues/cartilage-hydrogel.md`).
   Writing the document by hand works exactly as well: without one, `npm test` fails with "no
   as-built block for tissue 'mytissue'", and the message names the file and the two markers.
6. Tune until `node --test tests/*.test.mjs` passes. Prefer a range check
   (`at: [from, to]` + `agg`) over a point check whenever the claim is really "it never
   drops below" or "it averages"; use `agg: 'cross'` when the claim is about HOW LONG something
   takes. A point check on a noisy day is how a scenario gets re-tuned for the wrong reason.
7. `node tools/build_single.mjs`; open `index.html?tissue=mytissue`.
