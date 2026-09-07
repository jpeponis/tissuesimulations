# Tissue Weather — specification (v0.1)

An interactive 3D simulation for teaching **dynamic reciprocity** and **tissue
maturation / decay** in a tissue-engineering course. Students turn a few
environmental "weather" dials (growth-factor bath, mechanical load, protease
activity, cell number) and watch a cloud of extracellular-matrix (ECM) fibers
condense, align, mature, or evaporate as the cells inside respond to the very
matrix they are building.

Metaphor used in class: a tissue is like a cloud. Water droplets (ECM fibers)
are in dynamic equilibrium with vapor (soluble precursors / degraded fragments);
temperature, pressure and humidity push that equilibrium and the cloud changes
shape. Here the dials are biological, the metaphor is a label and a hint.

Scientific anchors (see docs/MODEL.md for citations and numbers):
- Metzcar et al. 2024 (PhysiCell-ECM): mesoscale ECM elements with density,
  anisotropy, orientation; cells deposit / degrade / reorient; ECM biases motility.
- Zeigler / Saucerman fibroblast network: TGF-β and mechanical tension drive
  collagen vs MMP outputs; fibroblast → myofibroblast activation.
- Tensional homeostasis / Murray–Oster mechanochemistry: cell traction ↔ matrix
  as one coupled system; stiffness feeds back on activation.
- Loerakker / Baaijens: strain-driven collagen alignment under load.

## 0. Repository layout and build constraints

```
index.html            app shell: viewport + control panel + teaching text (repo version)
src/model.js          pure simulation, ES module, runs in browser AND node (no DOM, no three)
src/render.js         Three.js scene: fibers, cells, fields, load arrows; consumes model state
src/plots.js          2D canvas time-series + flux gauge (no deps)
src/copy.js           student-facing text: dial explanations, scenarios, "try this" prompts
src/app.js            wires model ↔ render ↔ UI; scenario presets; export JSON
tools/build_single.mjs  inlines src/*.js into dist/tissue-weather.html (single-file artifact)
tools/run_headless.mjs  node: run scenarios, dump CSV + JSON trajectory
tools/plot_scenarios.py matplotlib check plots of the CSVs
tests/model.test.mjs  node --test tests/*.test.mjs: invariants (mass ≥ 0, FA ∈ [0,1], scenarios diverge as expected)
blender/import_tissue.py  bpy script: JSON trajectory → animated fibers + cells (Blender 4.2 LTS)
docs/MODEL.md         equations, biology, parameter table with sources
docs/TEACHING.md      lesson plan, guided experiments, misconception checks, where the metaphor breaks
```

Hard constraints (the single-file artifact build depends on them):
- Every `src/*.js` is an ES module with **named exports only**, **unique
  top-level identifiers across all files**, and local imports written exactly as
  `import { a, b } from './model.js';` on one line. The build strips `export `
  and local `import` lines and concatenates in order: copy, model, plots,
  render, app.
- Three.js is loaded via an import map from
  `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js` and
  `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/` (addons). No other
  external hosts. No external CSS/images. Everything else inline.
- `model.js` must not touch `window`, `document`, `performance`, or `Math.random`
  directly — use an injected seeded PRNG (mulberry32) so runs are reproducible.
- Target 60 fps in a laptop browser with default settings (grid 12³, 160 cells).

## 1. Model

### 1.1 Domain
Cube side `L = 1` (think ~300 µm). ECM grid `N` per side (default 12 → 1728
voxels, voxel size `h = L/N`). Time unit: **days**. Default `dt = 0.02 d`;
the app runs `stepsPerFrame` steps per rendered frame to hit the chosen
speed (days per real second).

Index of voxel (i,j,k): `idx = (i*N + j)*N + k`. All voxel fields are
`Float32Array(N³)`; the structure tensor has 6 components stored as separate
arrays `Txx,Tyy,Tzz,Txy,Txz,Tyz`.

### 1.2 ECM state per voxel
- Structure tensor `T` (symmetric 3×3, PSD). `rho = trace(T)` is total fiber
  density (dimensionless, 1 ≈ dense mature tissue; clamp trace ≤ 2).
  Deposition adds oriented mass; degradation scales `T` down isotropically
  (so alignment survives thinning); traction and load rotate `T` toward an axis
  without changing its trace.
- `rhoMat`: mature (crosslinked collagen I) fraction of the mass, as a density
  (`0 ≤ rhoMat ≤ rho`). New mass is deposited immature (provisional matrix /
  collagen III–like). `phiMat = rhoMat / max(rho, eps)` is the maturity fraction.
- Derived: fractional anisotropy
  `FA = sqrt(3/2) * ||T - (rho/3) I||_F / ||T||_F` (0 isotropic, 1 one axis);
  principal axis `f` by 2 warm-started power iterations on `T` (store `fx,fy,fz`).
  Stiffness (kPa):
  `E = E0 + Escale * rho^2 * (1 + kMat*phiMat) * (1 + kStrain*strain)`.
  Defaults `E0 = 0.3`, `Escale = 20`, `kMat = 3`, `kStrain = 1` (so rho=1
  mature ≈ 80 kPa; scar-like; provisional ≈ 5–20 kPa; empty ≈ 0.3 kPa).

### 1.3 Diffusible fields (explicit 6-neighbour diffusion, zero-flux walls)
- `g`: growth factor (TGF-β–like), 0..~1. Sources: external bath dial
  `Gext` relaxes `g` toward `Gext` at rate `kBath` everywhere (the "humidity");
  autocrine release `kGcell * alpha` per activated cell; release on matrix
  degradation `kGrel * degradationRate` (latent TGF-β stored in ECM). Decay `kGdec`.
- `m`: protease (MMP) activity, 0..~1. Sources per cell:
  `mBasal * proteaseDial + mAct * (1 - tensionSat)` (unloaded / under-tensioned
  cells produce more MMP) + inflammation burst on injury. Decay `kMdec`.
  TIMP is folded into `proteaseDial` (dial < 0.5 = TIMP-dominated).

### 1.4 Cells (agents)
State: position `x` (Float32Array 3n), polarity unit vector `p` (3n), activation
`alpha ∈ [0,1]` (n). Sensing uses trilinear-free nearest voxel (cheap).
- Local tension the cell feels: `tension = E_local/E_ref * (strain + kappa*alpha)`,
  `tensionSat = tension/(1+tension)`. `E_ref = 10 kPa`.
- Activation target (Saucerman-flavoured Hill sum, saturating):
  `alphaStar = clamp( aE * tensionSat + aG * g/(g+gHalf) - aSoft*(E_local<Esoft) , 0, 1)`
  defaults `aE = 0.8, aG = 0.8, gHalf = 0.3, aSoft = 0.2, Esoft = 1 kPa`.
  `d alpha/dt = (alphaStar - alpha)/tauAlpha`, `tauAlpha = 1 d`.
- Secretion into the cell's voxel: rate `s = sBasal + sAct*alpha` (density/day,
  per cell, spread over the voxel) with orientation
  `D = (1-pol) I/3 + pol * p p^T`, where `pol = polBase + polAct*alpha`
  (activated spindle cells lay oriented fibers). `sBasal = 0.004, sAct = 0.05,
  polBase = 0.2, polAct = 0.6`.
- Traction realignment of the local voxel: `T += kAlign * alpha * (rho * p p^T - T) * dt`
  restricted to the traceless part (implement as: target = rho * p p^T; T += kAlign*alpha*(target - T)*dt,
  then rescale T to keep trace). `kAlign = 0.4 /d`.
- Migration: speed `v = v0 * (1 - 0.6*alpha) * (1 - 0.5*rho/(rho+0.5))` (activated
  and embedded cells move less; `v0 = 30 µm/h ≈ 0.72 L/day` at L≈300 µm → use
  `v0 = 0.7 L/d`). Direction: persistent random walk (`p` rotates by noise with
  `sigma = 0.6 rad/sqrt(d)`), contact guidance pulls `p` toward `±f` by
  `kGuide * FA` (choose the sign closer to current p), and under load pulls `p`
  toward the load axis `z` by `kLoadAlign * strain`. `kGuide = 2 /d`,
  `kLoadAlign = 1.5 /d`. Soft repulsion between cells closer than `2 rCell`
  (`rCell = 0.03 L`), O(n²) is fine for n ≤ 400. Walls: reflect.
- Cell number is a dial; on change, add cells at random positions or remove
  random cells. No proliferation/death in v0.1 (keep the story about the ECM).

### 1.5 ECM update per voxel per step
Let `depos = Σ_cells_in_voxel s_i D_i` (tensor), `deg = kDeg * m * (rhoNew + rMat*rhoMat)`
with `rhoNew = rho - rhoMat`, `kDeg = 0.5 /d`, `rMat = 0.15` (mature matrix
resists proteolysis). Maturation `mat = kMat0 * rhoNew * (1 + kLox*alphaLocal)`,
`kMat0 = 1/14 /d`, `kLox = 2`.
- `T += depos*dt - (deg/rho) * T * dt` (if rho>eps)
- `rhoMat += (mat - kDeg*m*rMat*rhoMat) * dt`
- Load alignment: `T += kLoadFib * strain * (rho * z z^T - T) * dt` traceless-preserving
  as above. `kLoadFib = 0.5 /d`. (Fibers align along a static uniaxial load.)
- `strain` (dial 0..1) also contributes to stiffness (1.2) and to cell tension (1.4).
  Unloading (strain → 0) is the disuse-atrophy lever.
- Clamp: trace ≤ 2, rhoMat ∈ [0, rho].

### 1.6 Dials (UI) and their physical meaning
| dial | symbol | range | metaphor | biology |
|---|---|---|---|---|
| Growth-factor bath | `Gext` | 0..1 | humidity | TGF-β / serum in the medium; drives activation & secretion |
| Mechanical load | `strain` | 0..1 | pressure | static uniaxial strain along z: aligns fibers/cells, raises sensed tension & stiffness |
| Protease activity | `proteaseDial` | 0..1 | temperature | MMP vs TIMP balance / inflammation; sets basal degradation |
| Cell number | `nCells` | 40..400 | droplet nuclei | seeding density |
| Speed | days/s | 0.5..20 | — | — |

Buttons: Play/Pause, Step, Reset (current scenario), Injure (spherical wound
of radius 0.25 L at a random spot: zero T and rhoMat, add `g += 0.6`, `m += 0.8`
in the wound), Export JSON (trajectory snapshot every `exportEvery` days).

### 1.7 Scenarios (presets: initial ECM + dial settings + suggested prompt)
1. **Scaffold to tissue (maturation)** — provisional isotropic matrix rho=0.15,
   Gext=0.5, strain=0.6, protease=0.4, 160 cells. Expect: density rises, fibers
   align along z, colour turns amber (mature) over ~4–8 weeks, stiffness climbs.
2. **Unloading (disuse atrophy)** — start from the mature aligned state of (1)
   (precomputed by running 60 d headless, or by a `maturedState()` factory),
   strain=0, Gext=0.2, protease=0.5. Expect: activation falls, MMP rises,
   density and alignment decay over weeks; mature matrix decays slower than new.
3. **Fibrosis (runaway)** — start from (1)'s initial state but Gext=0.9,
   strain=0.3, protease=0.2. Expect: stiffness → activation → more collagen →
   stiffness positive feedback; dense, poorly aligned, stiff, stays high even if
   you later lower Gext (hysteresis — the key teaching moment).
4. **Wound healing** — mature tissue, then Injure. Expect: local burst of g and m,
   cells activate near wound, fill with immature isotropic matrix, slowly matures;
   alignment may never fully recover (scar).
5. **Empty sandbox** — rho=0.02, all dials mid; free play.

### 1.8 Readouts (plots.js)
Time series (rolling 90 d window): mean `rho` split into new/mature (stacked
area), mean FA, mean log10 E, mean alpha. Flux gauge: total deposition rate vs
total degradation rate this step, rendered as a two-sided bar
("condensing ⟷ evaporating") — this is the equilibrium the dials push.

### 1.9 Rendering (render.js)
- Fibers: `InstancedMesh` of a 6-sided low-poly cylinder, `K = 3` instances
  per voxel (total 3N³). Instance j of voxel v has a fixed pseudo-random offset
  within the voxel and a fixed random unit vector `r_j`. Direction
  `d = normalize(FA * f_signed + (1-FA) * r_j)` where `f_signed = f * sign(f·r_j)`.
  Length `h * (0.5 + 0.9*FA)`, radius `0.12 h * sqrt(rho)`; hide (scale 0) when
  `rho < 0.03`. Colour lerp new→mature: `#cfe8ff` → `#e0a24a`; multiply by
  0.6+0.4*rho for depth cue. Material MeshStandardMaterial, vertex colors via
  `setColorAt`.
- Cells: `InstancedMesh` icosphere; scale `(rCell*(1+1.5*alpha), rCell*(1-0.3*alpha), rCell*(1-0.3*alpha))`
  oriented along p (quaternion from +x to p). Colour lerp `#4ea3ff` (quiescent) →
  `#ff7a3d` (activated).
- Optional layers (toggles): growth factor `g` as a point cloud (Points, size
  by g, colour teal, opacity), protease `m` as magenta points. Off by default.
- Load: two translucent arrows/cones at z faces scaled by `strain`; a thin
  wire cube for the domain. Background near-black; hemisphere + directional light.
- OrbitControls with damping; slow autoRotate that stops on first user drag.
- `render.update(state, opts)` copies state → instance matrices/colors each
  frame; must avoid per-instance allocations (reuse Matrix4/Quaternion/Color).
- Expose `render.screenshot()` returning a data URL (used by tests).

### 1.10 Export JSON (for Blender)
```
{ "meta": {"N":12, "L":1, "K":3, "dtDays":0.02, "scenario":"...", "dials":{...}},
  "frames": [ {"t": 0.0,
     "rho": [N³ floats], "fa": [N³], "f": [3N³], "phiMat": [N³],
     "cells": {"x": [3n], "p": [3n], "alpha": [n]} }, ... ] }
```
`tools/run_headless.mjs` writes the same format so Blender work never needs a browser.

## 2. Pedagogy (copy.js / docs/TEACHING.md)
- Every dial has: a one-line biology label, the weather-metaphor hint, and a
  "what to watch" note. Scenario cards: goal, 3 steps, 1 question.
- An always-visible "equilibrium" sentence generated from state, e.g.
  "Deposition 0.12/d > degradation 0.05/d — the cloud is condensing; stiffness
  is climbing and activating the cells that build it."
- A "Where the metaphor breaks" panel: ECM turnover is slow (weeks, not
  seconds); crosslinked collagen is nearly irreversible (hysteresis); cells are
  not passive droplets, they change their own rules (alpha) — that is the
  "reciprocity".

## 3. Implementation notes — v0.1 as built

The code departs from sections 1.2–1.5 where the spec's first-guess constants
could not produce the scenario behaviours of 1.7. `src/model.js` carries the
full tuning log in its header comment; `docs/MODEL.md` §4 lists the biology
reviewer's recommendations and which were adopted. Summary of the deviations:

| item | spec | as built | why |
|---|---|---|---|
| secretion per cell | `sBasal + sAct·α` (0.004, 0.05) | `(0.005 + 2.5·α²)·(0.5 + 0.5·H)·(1 − ρ/1.6)²` | spec gain ~50× too low to reach ρ≈1 in 60 d; α² keeps quiescent cells from filling a low-GF tissue; crowding term gives a steady state |
| activation target | additive Hill sum, `aE + aG = 1.6` | `tanh(gsat·(1.15 + 0.6·H) − 0.1·0.5/(E+0.5))`, `gsat = g²/(g²+0.25)`, `H = τ²/(1+τ²)`, `τ = (E/10)(strain + 0.12·α)` | additive form has no low state at Gext 0.2, so no hysteresis; multiplicative TGF-β × tension gating (Hinz) gives bistability. `kappa` (undefined in spec) = 0.12 |
| τα | 1 d | 2 d up / 4 d down | asymmetric activation kinetics (MODEL.md §4) |
| MMP source per cell | `mBasal·P + mAct·(1 − τSat)` | `20·P³ + 3.5·(1 − H)/(1 + (α/0.25)²)`, `kMdec = 1/d` | P³ folds TIMP in; activated cells suppress MMP |
| growth factor | constants unspecified | `kBath 4/d`, `kGdec 0`, autocrine `12·α·H`, `kGrel 2`, `D = 0.05 L²/d` (diffusion number clamped ≤ 1/6) | H-gated release = latent TGF-β activation by contractile cells on stiff matrix; the local autocrine cloud is the fibrosis memory |
| degradation | `kDeg·m·(ρnew + 0.15·ρmat)` | `0.5·(0.02 + m)·(ρnew + 0.05·ρmat)·(1 − 0.5·strain·Tzz/ρ)` | mature matrix far less degradable; loaded aligned fibres protected |
| maturation | `(1/14)·ρnew·(1 + 2·α)` | `(1/14)·ρnew·(0.1 + 12·Σα_cells in voxel)` | crosslinking needs LOX from activated cells; otherwise a cell-free gel matures and can never evaporate |
| load → fibres | `0.5·strain` | `0.06·strain²` | spec value aligns fibres to FA≈1 in days without cells |
| load → cell polarity | `1.5·strain` | `10·strain²·H` | cells align with load only when they feel tension, so wounds fill with isotropic scar |
| contact guidance / noise | `kGuide 2`, `σ 0.6` | `6`, `2.5 rad/√d` | polarity memory of hours, not days |
| speed | as spec | × grip `0.5 + 0.5·min(1, ρ/0.5)`; comment fixed: 0.7 L/d ≈ 9 µm/h | Metzcar-style tent rejected: cells left sparse regions and wounds never refilled |
| kStrain | 1 | 0.5 | |
| injury | instantaneous g/m bursts | bursts + inflammation field (g source 4/d, m source 1/d, τ 5 d) | bath exchange erases a burst in hours |
| wound dials | unspecified | Gext 0.5, strain 0.45, protease 0.4 | |
| sandbox init | ρ 0.02 | ρ 0.15 | so "evaporates" is a visible event |

Spec inconsistencies found by the implementers, kept here for the record:
`kappa` undefined; 30 µm/h at L = 300 µm is 2.4 L/d, not 0.7; `kBath, kGcell,
kGrel, kGdec, mBasal, mAct, kMdec, D` undefined; explicit diffusion needs
`D ≤ h²/(6 dt)`; `node --test tests/` does not work on Node ≥ 21 (use
`node --test tests/*.test.mjs`). The renderer uses `fiberRadiusScale 0.6` and
`fiberLengthScale 1.35` relative to 1.9 (radius 1.0 read as matchsticks), a
radius floor of 0.025 h, and normal rather than additive blending for the
field point clouds.
