# Tissue Weather

A browser-based 3D interactive for teaching **dynamic reciprocity** and
**tissue maturation** in tissue engineering. A small cube of tissue is
simulated as a cloud of extracellular-matrix (ECM) fibers and a population of
fibroblast-like cells. Students turn four "weather" dials — growth-factor bath,
mechanical load, protease activity, cell number — and watch the matrix
condense, align, mature, scar, or evaporate as the cells respond to the very
matrix they are building.

The teaching metaphor: a tissue is like a cloud. Fibers are the droplets,
soluble precursors and fragments are the vapour, and the environmental dials
push the deposition ⟷ degradation equilibrium one way or the other. The
interactive also shows where that metaphor breaks (slow turnover, crosslink
irreversibility and hysteresis, cells as active agents that rewrite their own
rules).

## Run it

- **No install:** open `dist/tissue-weather.html` in a modern browser (Chrome,
  Edge, Firefox, Safari 16.4+). It loads Three.js from jsdelivr, so it needs
  internet access the first time.
- **From source:** serve the repository root over HTTP (ES modules do not load
  from `file://`) and open `index.html`:
  ```
  python3 -m http.server 8000
  # then http://localhost:8000/
  ```
- **GitHub Pages:** Settings → Pages → *Deploy from a branch* → this branch,
  folder `/ (root)`. `index.html` is Pages-ready as is.

Keyboard: space toggles play/pause. Drag to orbit, wheel to zoom.

## What is in the box

| path | what |
|---|---|
| `index.html`, `src/` | the app: `model.js` (simulation, no DOM), `render.js` (Three.js scene), `plots.js` (readouts), `copy.js` (student-facing text), `app.js` (wiring) |
| `dist/tissue-weather.html` | single-file build of the app (`node tools/build_single.mjs`) |
| `docs/SPEC.md` | the design specification the code implements |
| `docs/MODEL.md` | equations, biology, parameter table with sources, known simplifications |
| `docs/TEACHING.md` | learning objectives, 50-minute lesson, guided experiments, misconceptions, assessment |
| `blender/` | `import_tissue.py` turns an exported trajectory into an animated Blender scene for cinematic renders; see `blender/README.md` |
| `tools/run_headless.mjs` | runs the scenarios in Node, writes CSV stats and JSON trajectories |
| `tools/plot_scenarios.py` | matplotlib panel of the headless runs |
| `tests/` | `node --test tests/*.test.mjs` — invariants and qualitative scenario checks |

## The model in one paragraph

Each ECM voxel carries a structure tensor (density + fiber orientation +
anisotropy), a mature-collagen fraction, and two diffusible fields (a TGF-β–like
growth factor and MMP-like protease activity). Cells sense local stiffness,
growth factor and tension, and integrate them into an activation level
(fibroblast → myofibroblast). Activation sets how much oriented matrix a cell
deposits, how strongly it realigns fibers by traction, how fast it moves, and
how much protease and growth factor it releases. Deposited matrix stiffens the
voxel, which feeds back on activation — the loop that makes fibrosis
self-sustaining and unloading self-defeating. Mechanical load aligns fibers and
cells along the load axis and raises sensed tension. Details and sources are in
`docs/MODEL.md`; the scenario expectations are checked in `tests/`.

## Blender

Export a trajectory from the app (About → *Export trajectory*), then:

```
blender --background --python blender/import_tissue.py -- --input tissue-weather-maturation-day60.json --out render.png --all-frames
```

See `blender/README.md` for the GUI workflow, renderer switches and limits.

## Scientific anchors

- Metzcar et al. 2024, *A simple framework for agent-based modeling with
  extracellular matrix*, Bull. Math. Biol. — ECM elements with density,
  anisotropy and orientation remodelled by cells.
- Zeigler, Richardson, Holmes & Saucerman 2016 — fibroblast signalling network:
  TGF-β and mechanical input → collagen and MMP output.
- Loerakker, Ristori & Baaijens 2016 — strain-driven collagen alignment in
  engineered tissue.
- Bissell, Hall & Parry 1982 — dynamic reciprocity.

## Licence

MIT for the code. Course text under CC BY 4.0.
