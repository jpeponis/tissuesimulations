# Blender companion for Tissue Weather

`blender/import_tissue.py` turns a trajectory exported by the web app (or by
`tools/run_headless.mjs`) into a Blender 4.2 LTS scene that follows the visual
language of `docs/SPEC.md` section 1.9: a cloud of fibers whose thickness follows
density, whose colour turns from provisional blue-white to mature amber, and whose
direction follows the local fiber axis; spindle-shaped cells coloured by
activation; a wire cube for the domain; load arrows on the z faces; a dark
background. With `--all-frames` every trajectory frame becomes its own set of
objects with visibility keyframes, so scrubbing the timeline replays the
simulation (and `--turntable` orbits the camera while it does).

`blender/make_sample_trajectory.py` writes a synthetic trajectory in the same
format so the Blender side can be exercised without a browser or node.

## 1. Getting a trajectory JSON

* **Web app**: run a scenario and press **Export JSON**. The download is the
  format of SPEC section 1.10: `{"meta": {...}, "frames": [{"t", "rho", "fa", "f",
  "phiMat", "cells": {"x", "p", "alpha"}}, ...]}` with one frame every
  `exportEvery` simulated days.
* **Headless**: `node tools/run_headless.mjs` writes the same format (see that
  tool's `--help` for scenario / duration flags).
* **Synthetic** (no web app needed):

  ```bash
  python3 blender/make_sample_trajectory.py            # -> blender/sample_trajectory.json
  python3 blender/make_sample_trajectory.py --out my.json --frames 24 --days 90 --cells 200 --seed 3
  ```

  Pure Python, deterministic (mulberry32, like `src/model.js`). It imitates the
  "Scaffold to tissue" scenario: density rises 0.19 -> 1.1, alignment FA 0.13 ->
  0.70 toward z, maturity 0.03 -> 0.63, 160 cells activate. The default command
  never overwrites an existing file (`--force` does).

The importer tolerates a few variations: missing `fa`/`f`/`phiMat`/`cells`
(defaults to isotropic / random / immature / none), `phimat` or `phi_mat` as
the key name, and nested `[[x,y,z],...]` arrays instead of flat ones. `meta.N`
is inferred from `len(rho)` when absent; `meta.K` defaults to 3, `meta.L` to 1.

A quick validation that needs no Blender at all:

```bash
python3 blender/import_tissue.py --input blender/sample_trajectory.json --dry-run --all-frames
```

## 2. Running the importer

### Headless with the Blender binary (renders a PNG)

```bash
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --out /tmp/tissue_day60.png

# a specific trajectory frame (0-based, negative counts from the end)
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --out /tmp/tissue_day0.png --frame 0

# all frames keyframed (timeline 1..N*hold), turntable camera, save the .blend, render the still of frame 8
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --all-frames --hold 6 --turntable \
    --frame 8 --out /tmp/tissue.png --save /tmp/tissue.blend

# render the whole timeline as a PNG sequence next to --out (tissue_0001.png ...)
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --all-frames --hold 6 --turntable \
    --out /tmp/seq/tissue.png --animation --cycles
```

Everything after `--` belongs to the script; `--help` after `--` lists all
options.

### Headless with the `bpy` pip module (no Blender install)

Python 3.11 can `pip install bpy==4.2.*` (about 350 MB). The script detects
module mode (`bpy.app.binary_path == ""`), reads its arguments directly and
otherwise behaves the same:

```bash
python3 blender/import_tissue.py --input blender/sample_trajectory.json --out /tmp/tissue.png
```

Eevee needs a GPU/OpenGL context, which the pip module cannot create without a
display (it aborts the process with `Couldn't open libEGL.so.1` rather than
raising), so in module mode without `$DISPLAY` the script switches to Cycles
automatically and says so; `--eevee` insists.

### In the Blender GUI

1. Open Blender 4.2, switch to the **Scripting** workspace, open
   `blender/import_tissue.py` in the Text editor and press **Run Script**.
2. With no CLI arguments it loads `$TISSUE_JSON` if set, otherwise
   `blender/sample_trajectory.json` next to the script, builds **all** frames
   with visibility keyframes (6 scene frames per trajectory frame) and does not
   render. Scrub the timeline or press Space to play; F12 renders the current
   frame; re-running the script replaces the previous `TissueWeather`
   collection.
3. Alternatively build headless with `--save scene.blend` and open that file:
   the Geometry Nodes trees (`TW_FiberTubes`, `TW_CellSpheres`) and materials
   (`TW_fiber`, `TW_cell`, ...) are ordinary editable data.

You can also start the GUI with arguments: `blender --python blender/import_tissue.py -- --input my.json --all-frames --turntable`.

### Options that change the look

| flag | default | effect |
|---|---|---|
| `--fiber-radius F` | 1.0 | multiplies the SPEC radius `0.12*h*sqrt(rho)`; 1.0 matches the web app, ~0.7 gives a finer, more thread-like weave at high density |
| `--emission F` | 0.12 | emission strength on fibers (cells use 0.8x) for the glow-on-dark look; 0 = purely lit |
| `--rho-min F` | 0.03 | fibers below this density are omitted (SPEC "hide when rho < 0.03") |
| `--seed N` | 1234 | seed of the fixed per-fiber jitter: mulberry32(seed); for every voxel in `idx` order and `j = 0..K-1`, three uniforms give the offset `(u-0.5)*0.8*h` per axis, then `z = 2u-1`, `phi = 2*pi*u` give `r_j` (mirror this in render.js for pixel-parity) |
| `--res WxH` | 1280x720 | render size |
| `--samples N` | 32 Eevee / 64 Cycles | render samples |
| `--no-label` | | drop the title (scenario + dials) and per-frame caption (day, mean rho, FA, maturity, activation) |
| `--hold N` | 1 | scene frames per trajectory frame with `--all-frames` (use 6-12 for a watchable clip at 24 fps) |

## 3. Renderers

* **Eevee (Eevee Next, `BLENDER_EEVEE_NEXT`)** is the default: fast, 32 TAA
  samples. In 4.2 the legacy Eevee is gone; the script tries
  `BLENDER_EEVEE_NEXT` first and `BLENDER_EEVEE` (older/newer Blenders) second.
* **Cycles**: `--cycles` (64 samples, adaptive sampling, OpenImageDenoise,
  persistent data). CPU by default; enable a GPU in Preferences > System or
  set `bpy.context.scene.cycles.device = 'GPU'` in your own startup. A
  1280x720 frame of the sample trajectory takes about a minute on 4 CPU cores.
* If Eevee raises at render time (no GL context on a headless server) the
  script retries the still with Cycles.

Colour management is set to the **Standard** view transform (not AgX) so the
SPEC hex colours come out as specified; switch back to AgX in the Colour
Management panel if you prefer the filmic look.

## 4. How the scene is built

* **Fibers** - per frame one mesh of `K` line segments per voxel (5184 for the
  default 12^3 x 3) with per-vertex float attributes `rho`, `phimat`, `fa`.
  Recipe per SPEC 1.9: `d = normalize(FA*f_signed + (1-FA)*r_j)`, length
  `h*(0.5+0.9*FA)`, hidden when `rho < 0.03`. A Geometry Nodes modifier
  (`TW_FiberTubes`) does Mesh to Curve -> Set Curve Radius (Named Attribute
  `rho` -> sqrt -> x `0.12*h`) -> Curve to Mesh with a 6-vertex circle profile
  (the SPEC's low-poly cylinder) -> Set Material. The material mixes
  `#cfe8ff -> #e0a24a` by the `phimat` attribute and multiplies by
  `0.6+0.4*rho` (Attribute nodes), and emits the same colour weakly.
  Fallback `--fiber-mode mesh`: the same hexagonal prisms are built directly
  in Python with the same attributes (bigger files, no modifier).
* **Cells** - per frame one point-cloud mesh (a vertex per cell) with
  attributes `alpha`, `scale` = `(rCell*(1+1.5a), rCell*(1-0.3a), rCell*(1-0.3a))`
  and `rot` = XYZ Euler taking +x onto the polarity `p`. Geometry Nodes
  (`TW_CellSpheres`): Instance on Points of an icosphere with Scale <- `scale`
  and Rotation <- Euler to Rotation(`rot`), Realize Instances (so `alpha`
  reaches the shader), Set Shade Smooth, Set Material; colour
  `#4ea3ff -> #ff7a3d` by `alpha`. Fallbacks: `--cells-mode objects` (one
  object per cell, colour through Object Info > Color, used automatically only
  for <= 200 cells) and `--cells-mode baked` (one mesh with all icospheres).
* **Static**: wire cube (Wireframe modifier), two translucent load cones on the
  z faces scaled by `meta.dials.strain`, a 50 mm camera fitted to the cube from
  a 3/4 view, area key + area fill + sun rim, world `#0b0f14`, title and caption
  text parented to the camera.
* **Animation**: objects of trajectory frame `i` are visible on scene frames
  `[1+i*hold, 1+(i+1)*hold)` through `hide_render` / `hide_viewport`
  keyframes; the frame range is set to `1..N*hold`. `--turntable` keyframes a
  pivot empty (the camera's parent) from 0 to 360 degrees over that range.

## 5. Known limitations

* Growth-factor / protease point clouds (the optional web layers) are not in
  the export format, so they are not drawn.
* Fiber count scales as `N^3*K*frames`; N=12, K=3, 60 frames is 311k segments
  and builds in a few seconds, but each visible frame evaluates its Geometry
  Nodes tree on demand, so long trajectories are best previewed with
  `--frame` before `--all-frames`.
* Cells are drawn from the exported frame only (no interpolation between
  frames); use a smaller `exportEvery` in the app for smoother motion.
* The bpy pip module cannot render with Eevee headless (see above) and the
  Blender binary in `--background` needs a GL-capable machine for Eevee too;
  Cycles always works.
* The one-object-per-cell fallback creates `cells x frames` objects (1920 for
  the sample); prefer the Geometry Nodes or baked modes for long trajectories.

## 6. Tested with

* Blender **4.2.23 LTS** as the `bpy` 4.2.23 pip wheel (Python 3.11, Linux,
  4 CPU cores, no GPU): dry run, scene build in all fiber/cell modes,
  Geometry Nodes evaluation (attributes verified on the evaluated meshes),
  visibility keyframes and turntable (checked per scene frame in the saved
  `.blend`), `--save`, `--animation`, and 1280x720 Cycles renders (64 samples +
  denoise, about 70 s per frame) of trajectory frames 0, 6 and 11 of the
  synthetic sample: day 0 reads as a sparse blue-white cloud with round blue
  cells, day 60 as a dense z-aligned amber weave with orange spindle cells.
  The same code paths run under the `blender --background --python` binary;
  that invocation and Eevee rendering could not be exercised in the
  development container (no Blender binary, no GL), so treat Eevee output as
  untuned: if it looks too bright or too dark, adjust `--emission` or the
  three `TW_*` light energies in `build_scene`.
* API notes for maintainers: node-tree sockets are created with
  `tree.interface.new_socket(...)` (4.0+); the Named Attribute node has a
  single dynamic `Attribute` output; Instance on Points' `Rotation` is a
  Rotation socket (fed by `FunctionNodeEulerToRotation`); `ShaderNodeMix`
  colour sockets are looked up by (name, type) because the node carries
  several same-named sockets; `Object.matrix_world` is stale until a
  depsgraph update, so the camera fit builds matrices by hand;
  `Material.surface_render_method = 'BLENDED'` replaces `blend_method` in
  4.2; the static `engine` enum only lists `BLENDER_EEVEE_NEXT` - Cycles is a
  dynamic item, so the script sets engines inside try/except.
