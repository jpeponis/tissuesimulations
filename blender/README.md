# Blender companion for Tissue Weather

`blender/import_tissue.py` turns a trajectory exported by the web app (or by
`tools/run_headless.mjs`) into a Blender 4.2 LTS scene that follows the visual
language of `docs/SPEC.md` section 1.9 and the renderer contract of
`docs/EXTENDING.md` section 4: fiber species as a cloud of tubes whose
thickness follows density and whose colour is the density-weighted mix of the
species colours; gel species as a translucent haze; scaffold species as a strut
lattice that dissolves as it degrades; spindle- or sphere-shaped cells coloured
by state, one look per cell type; a wire cube for the domain; load arrows on the
z faces; a dark background. With `--all-frames` every trajectory frame becomes
its own set of objects with visibility keyframes, so scrubbing the timeline
replays the simulation (and `--turntable` orbits the camera while it does).

`blender/make_sample_trajectory.py` writes synthetic trajectories in the same
format (a fibrous tissue and a cartilage-in-hydrogel tissue) so the Blender side
can be exercised without a browser or node.

## 1. Trajectory formats

### Format 2 (docs/EXTENDING.md section 5, v0.2)

```
{ "meta": { "format": 2, "tissue": "cartilage", "N": 12, "L": 1, "K": 3, "dtDays": 0.02,
            "scenario": "...", "dials": {...}, "loadDial": "compression",
            "species":   [{ "key", "label", "kind": "fiber" | "gel" | "scaffold", "color": "#rrggbb" }, ...],
            "cellTypes": [{ "key", "label", "colors": ["#..", "#.."], "shape": { "by": "a" | "b", "aspectMin", "aspectMax" }, "radius" }, ...],
            "exportEveryDays": 5 },
  "frames": [ { "t": 0,
      "species": { "<key>": [N^3], ... },              // one density array per species
      "fa": [N^3], "f": [3 N^3],                       // orientation of the fiber species (shared tensor)
      "rho": [N^3], "phiMat": [N^3],                   // duplicates for format-1 readers (ignored here)
      "cells": { "x": [3n], "p": [3n], "a": [n], "b": [n], "c": [n], "type": [n], "alpha": [n] } } ] }
```

The importer reads `meta.species` / `meta.cellTypes` and, per frame,
`species[key]`, `fa`, `f`, `cells.a/b/c/type` (`c` is carried as a mesh attribute
and shown in the caption when it is ever nonzero; nothing is drawn from it). Tolerances: a species that appears
in the frames but not in `meta.species` is drawn as a fiber with a palette colour;
an unknown `kind` is drawn as a fiber; a species missing from a frame is zero; a
missing `cellTypes` falls back to the fibroblast look; `cells.b`, `cells.c` and
`cells.type` default to 0; cell type indices out of range are clamped. `meta.N` is inferred
from the array length when absent; `meta.K` defaults to 3, `meta.L` to 1.

**Load arrows** are drawn only when `meta.dials` contains the dial named by
`meta.loadDial`; if `meta.loadDial` is absent (or names a dial that is not
there) the importer looks for a dial called `strain`. No such dial, no arrows.

**Title and caption**: the title shows `meta.tissueName` (or `meta.tissue`), the
scenario and the dial values; the per-frame caption shows the day, the mean of
every species (by key, in `meta.species` order), the mean alignment and the mean
cell states (`a`; `b` when any type shapes by it or it is nonzero; `c` when nonzero).

### Format 1 (docs/SPEC.md section 1.10, v0.1) -- still accepted

`{"meta": {...}, "frames": [{"t", "rho", "fa", "f", "phiMat", "cells": {"x", "p",
"alpha"}}, ...]}`. It is read as two implicit fiber species, `new = rho*(1-phiMat)`
(#cfe8ff) and `mat = rho*phiMat` (#e0a24a), with one fibroblast cell type
(#4ea3ff -> #ff7a3d by `alpha`, aspect 1 -> 2.5), so a v0.1 export renders exactly
as before. `phimat` / `phi_mat` key spellings and nested `[[x,y,z],...]` arrays are
tolerated, as are missing `fa` / `f` / `phiMat` / `cells`.

### Getting a file

* **Web app**: run a scenario and press **Export JSON** (format 2 in v0.2).
* **Headless**: `node tools/run_headless.mjs` writes the same format.
* **Synthetic** (no web app needed):

  ```bash
  python3 blender/make_sample_trajectory.py                      # fibrous   -> blender/sample_trajectory.json
  python3 blender/make_sample_trajectory.py --tissue cartilage   # cartilage -> blender/sample_trajectory_cartilage.json
  python3 blender/make_sample_trajectory.py --tissue cartilage --out my.json --frames 24 --days 90 --cells 200 --seed 3
  ```

  Pure Python, deterministic (mulberry32, like the engine), format 2. Flags:
  `--tissue fibrous|cartilage` (default fibrous), `--out` (default depends on the
  tissue, see above), `--N` (12), `--K` (3), `--frames` (12), `--days` (60),
  `--cells` (160), `--seed` (7), `--force` (overwrite; without it an existing
  output file is never touched). The 12-frame samples are ~1.1-1.4 MB.

  * *fibrous* imitates "Scaffold to tissue": species `new` / `mat` (both fiber
    kind), total density 0.19 -> 1.1, mature fraction lagging ~2 weeks, alignment
    FA 0.13 -> 0.70 toward z, 160 fibroblasts activate (`a`), elongate (shape by
    `a`) and random-walk. Dials `Gext 0.5, strain 0.6, protease 0.4, nCells`,
    `loadDial: strain`.
  * *cartilage* imitates chondrocytes in a degrading hydrogel: `scaffold` (kind
    scaffold, #9ec5d8) 1.0 -> 0.05 over 60 days, faster next to cells; `gag`
    (kind gel, #7fe0c9) 0 -> ~0.85, pericellular first; `col2` (fiber, #e8f1f8)
    0 -> ~0.5 and isotropic (FA stays below 0.2); `col1` (fiber, #e0a24a)
    0 -> ~0.06 appearing after day 40; one cell type `chondrocyte` (#7fd1ff ->
    #ff9a6b by `a`, shape by `b` with aspect 1 -> 1.8, radius 0.035), 160 cells that
    barely move, `a` rising early, `b` (hypertrophy) late, `c` (a pericellular pool)
    filling by day 15 and released by day 40. Dials `Gext 0.5,
    compression 0.3, protease 0.2, nCells`, `loadDial: compression` (exercises the
    non-`strain` load dial path).

A quick validation that needs no Blender at all (prints per-frame counts of fiber
segments, struts and gel spheres plus the per-species means):

```bash
python3 blender/import_tissue.py --input blender/sample_trajectory_cartilage.json --dry-run --all-frames
```

## 2. Running the importer

### Headless with the Blender binary (renders a PNG)

```bash
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory_cartilage.json --out /tmp/cartilage_day60.png

# a specific trajectory frame (0-based, negative counts from the end)
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --out /tmp/tissue_day0.png --frame 0

# all frames keyframed (timeline 1..N*hold), turntable camera, save the .blend, render the still of frame 8
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory.json --all-frames --hold 6 --turntable \
    --frame 8 --out /tmp/tissue.png --save /tmp/tissue.blend

# render the whole timeline as a PNG sequence next to --out (tissue_0001.png ...)
blender --background --python blender/import_tissue.py -- \
    --input blender/sample_trajectory_cartilage.json --all-frames --hold 6 --turntable \
    --out /tmp/seq/tissue.png --animation --cycles
```

Everything after `--` belongs to the script; `--help` after `--` lists all
options.

### Headless with the `bpy` pip module (no Blender install)

Python 3.11 can `pip install bpy==4.2.*` (about 350 MB). The script detects
module mode (`bpy.app.binary_path == ""`), reads its arguments directly and
otherwise behaves the same:

```bash
python3 blender/import_tissue.py --input blender/sample_trajectory_cartilage.json --out /tmp/cartilage.png
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
   the Geometry Nodes trees (`TW_FiberTubes`, `TW_ScaffoldStruts`, `TW_GelSpheres`,
   `TW_CellSpheres`) and materials (`TW_fiber`, `TW_scaffold`, `TW_gel`, `TW_cell`,
   ...) are ordinary editable data, and every per-vertex attribute the shaders
   read (`col`, `rho`, `dens`, `fa`, `frac_<species>`, `a`, `b`) is on the meshes.

You can also start the GUI with arguments: `blender --python blender/import_tissue.py -- --input my.json --all-frames --turntable`.

### Options that change the look

| flag | default | effect |
|---|---|---|
| `--layers L,L,...` | `fibers,cells,gel,scaffold` | which layers to build (e.g. `--layers fibers,cells` hides the haze and the lattice) |
| `--fiber-radius F` | 1.0 | multiplies the fiber radius `0.12*h*sqrt(rho)`; ~0.7 gives a finer weave at high density |
| `--strut-radius F` | 1.0 | multiplies the scaffold strut radius `0.08*h*density` |
| `--gel-mode M` | `auto` | `volume` (a Cycles fog from a Volume Cube density field; `auto` picks it when the node exists) or `spheres` (instanced translucent spheres, cheaper, works in Eevee) |
| `--gel-density F` | 1.5 | volume mode: scatter/absorption density per unit gel density (1.5 at gel 0.8 makes the far side of the cube ~30 % visible) |
| `--gel-emission F` | 0.6 | self-illumination of the haze, scaled by local density (0 = lit only by the lamps) |
| `--gel-step-rate F` | 2.0 | volume mode: Cycles volume step rate; larger renders faster and blurrier |
| `--gel-scale F` | 1.0 | spheres mode: multiplies the sphere radius `0.62*h*density^(1/3)` (larger = more overlap) |
| `--gel-opacity F` | 0.22 | spheres mode: peak opacity of one sphere seen face-on at density 1 |
| `--emission F` | 0.12 | emission strength on fibers (cells 0.8x, struts 0.5x) for the glow-on-dark look; 0 = purely lit |
| `--rho-min F` | 0.03 | fibers below this total fiber density are omitted (SPEC "hide when rho < 0.03") |
| `--dens-min F` | 0.01 | gel spheres / struts below this density are omitted |
| `--seed N` | 1234 | seed of the fixed per-fiber jitter: mulberry32(seed); for every voxel in `idx` order and `j = 0..K-1`, three uniforms give the offset `(u-0.5)*0.8*h` per axis, then `z = 2u-1`, `phi = 2*pi*u` give `r_j` (mirror this in render.js for pixel-parity) |
| `--res WxH` | 1280x720 | render size |
| `--samples N` | 32 Eevee / 64 Cycles | render samples |
| `--no-label` | | drop the title and per-frame caption |
| `--hold N` | 1 | scene frames per trajectory frame with `--all-frames` (use 6-12 for a watchable clip at 24 fps) |

## 3. Renderers

* **Eevee (Eevee Next, `BLENDER_EEVEE_NEXT`)** is the default: fast, 32 TAA
  samples. In 4.2 the legacy Eevee is gone; the script tries
  `BLENDER_EEVEE_NEXT` first and `BLENDER_EEVEE` (older/newer Blenders) second.
  The sphere gel material uses the `BLENDED` surface method and the scaffold
  `DITHERED`, so both are transparent in Eevee as well (untested here, see
  section 6); the volume gel is a Cycles look -- use `--gel-mode spheres` with
  Eevee.
* **Cycles**: `--cycles` (64 samples, adaptive sampling, OpenImageDenoise,
  persistent data, transparent bounces raised to 48 because a view ray crosses
  up to N gel spheres plus semi-transparent struts, volume step rate from
  `--gel-step-rate`). CPU by default; enable a
  GPU in Preferences > System or set `bpy.context.scene.cycles.device = 'GPU'`
  in your own startup. A 1280x720 frame takes 20-75 s on 4 CPU cores for a
  fiber/cell tissue and about 4-5 min for a frame with a volume gel (the fog is
  what costs; `--gel-mode spheres` brings it back to ~80 s).
* If Eevee raises at render time (no GL context on a headless server) the
  script retries the still with Cycles.

Colour management is set to the **Standard** view transform (not AgX) so the
tissue hex colours come out as specified; switch back to AgX in the Colour
Management panel if you prefer the filmic look.

## 4. How the scene is built (one object per layer per frame)

All densities and colours are precomputed per vertex in Python and stored as
mesh attributes; Geometry Nodes turn the light-weight base meshes into
geometry, and the materials read the attributes (`ShaderNodeAttribute`).

* **Fibers (kind `fiber`)** -- one mesh of `K` line segments per voxel (5184 for
  12^3 x 3) with per-vertex attributes `rho` (= sum of the fiber species),
  `col` (FLOAT_COLOR: sum over fiber species of `rho_s/rho * colour_s`, in
  linear RGB), `fa`, and `frac_<key>` per species when there are several.
  Recipe per SPEC 1.9: `d = normalize(FA*f_signed + (1-FA)*r_j)`, length
  `h*(0.5+0.9*FA)`, hidden when `rho < 0.03`. Geometry Nodes `TW_FiberTubes`:
  Mesh to Curve -> Set Curve Radius (Named Attribute `rho` -> power 0.5 -> x
  `0.12*h`) -> Curve to Mesh with a 6-vertex circle -> Set Material. The material
  takes `col`, multiplies by `0.6+0.4*rho` and emits the same colour weakly.
  Fallback `--fiber-mode mesh`: the same hexagonal prisms built in Python.
* **Gel (kind `gel`)** -- a haze. Default (`--gel-mode volume`): one object per
  gel species per frame, a point cloud of all voxel centres with the attribute
  `dens`; Geometry Nodes `TW_GelVolume_<key>` turns it into a **Volume Cube** over
  `[0,L]^3` with `3N` cells per axis whose density field is `dens` of the nearest
  voxel centre (Sample Nearest -> Sample Index, 7 taps at +-h/2 averaged so the
  voxel field is lightly blurred) -> Set Material. Material `TW_gel_<key>`:
  Principled Volume in the species colour, density = `--gel-density` x grid,
  emission strength = `--gel-emission` x local density (Volume Info). The fog
  ends flush with the cube faces and several gel species simply overlap. The gel
  object is visible to camera and transmission rays only
  (`visible_shadow/diffuse/glossy = False`), so the haze neither shadows nor
  tints the fibers and cells inside it. It costs render time: roughly 4-5x the
  sphere mode in Cycles at the default step rate.
  Alternative (`--gel-mode spheres`, also the fallback when the Volume Cube node
  is missing): one point per voxel above `--dens-min` with `r =
  0.62*h*density^(1/3)`, `dens`, `col` (density-weighted mix when several gel
  species exist); Geometry Nodes `TW_GelSpheres`: Instance on Points (icosphere,
  2 subdivisions, Scale <- `r`) -> Realize Instances -> Set Shade Smooth -> Set
  Material; material `TW_gel`: Mix Shader between Transparent and (Emission +
  Diffuse) of the species colour with factor `opacity * (0.3+0.7*dens) *
  (1-facing)^1.5`, back faces fully transparent so a ray pays once per sphere.
  Cheap and Eevee-friendly, but the outermost spheres protrude past the cube
  faces, so the boundary looks scalloped.
* **Scaffold (kind `scaffold`)** -- a fixed lattice: from every voxel centre one
  strut along +x, +y and +z to the neighbouring centre (to the cube face for the
  last voxel, plus a half strut to the face for the first), 5616 struts for
  N = 12, with per-vertex `dens` (the density of the voxel at that end, so struts
  taper between voxels) and `col`. Geometry Nodes `TW_ScaffoldStruts` is the same
  tube tree with radius `0.09*h*dens^1`; material `TW_scaffold` is a glossy
  Principled with alpha `clamp(0.15 + 1.6*dens)`, so struts both thin and fade as
  the scaffold hydrolyses, and disappear below `--dens-min`.
* **Cells** -- per frame one point-cloud mesh (a vertex per cell) with attributes
  `a`, `b`, `c`, `col` (lerp of the type's two colours by `a`, linear RGB), `scale` and
  `rot`. Shape from the type's `shape`: `s` = `a` or `b` per `shape.by`,
  `aspect = aspectMin + (aspectMax-aspectMin)*s`, scale
  `(r*aspect, r*c, r*c)` with `c = max(0.35, 1-0.2*(aspect-1))`, `r = radius*L`
  (for the fibroblast type this is the v0.1 spindle `(r(1+1.5a), r(1-0.3a),
  r(1-0.3a))`); `rot` = XYZ Euler taking +x onto the polarity `p`. Geometry Nodes
  `TW_CellSpheres`: Instance on Points of an icosphere with Scale <- `scale` and
  Rotation <- Euler to Rotation(`rot`), Realize Instances (so `col` reaches the
  shader), Set Shade Smooth, Set Material. Fallbacks: `--cells-mode objects` (one
  object per cell, colour through Object Info > Color, <= 200 cells) and
  `--cells-mode baked` (one mesh with all icospheres).
* **Static**: wire cube (Wireframe modifier), two translucent load cones on the
  z faces scaled by the load dial value, a 50 mm camera fitted to the cube from
  a 3/4 view, area key + area fill + sun rim, world `#0b0f14`, title and caption
  text parented to the camera.
* **Animation**: objects of trajectory frame `i` are visible on scene frames
  `[1+i*hold, 1+(i+1)*hold)` through `hide_render` / `hide_viewport`
  keyframes; the frame range is set to `1..N*hold`. `--turntable` keyframes a
  pivot empty (the camera's parent) from 0 to 360 degrees over that range.

## 5. Known limitations

* Growth-factor / protease fields are not in the export format, so they are not
  drawn.
* The volume gel is a nearest-voxel density field (lightly blurred), so at
  `3N` grid cells per axis the voxel structure is still faintly visible inside the
  fog; several gel species become overlapping fogs rather than one mixed-colour
  fog. It renders only in Cycles at a useful quality and costs about 5x the
  sphere mode; the sphere mode is the Eevee-friendly, fast alternative but shows a
  scalloped boundary. `--gel-density` / `--gel-emission` / `--gel-step-rate`
  (volume) and `--gel-opacity` / `--gel-scale` (spheres) tune the look.
* Struts and gel spheres are built for every frame with `--all-frames`
  (5616 struts + 1728 spheres per frame at N = 12); the Geometry Nodes trees
  evaluate only for the visible frame, so this costs memory, not render time.
* Fiber count scales as `N^3*K*frames`; N=12, K=3, 60 frames is 311k segments
  and builds in a few seconds, but long trajectories are best previewed with
  `--frame` before `--all-frames`.
* Cells are drawn from the exported frame only (no interpolation between
  frames); use a smaller `exportEveryDays` in the app for smoother motion.
* The bpy pip module cannot render with Eevee headless (see above) and the
  Blender binary in `--background` needs a GL-capable machine for Eevee too;
  Cycles always works.
* The one-object-per-cell fallback creates `cells x frames` objects; prefer the
  Geometry Nodes or baked modes for long trajectories.

## 6. Tested with

* Blender **4.2.23 LTS** as the `bpy` 4.2.23 pip wheel (Python 3.11, Linux,
  4 CPU cores, no GPU): dry run (`--all-frames`) of the format-1 sample (19
  frames) and of both format-2 samples; scene build of all 12 cartilage frames
  with visibility keyframes and turntable (attributes `col`/`rho`/`fa`/`frac_*`,
  `col`/`dens`, `a`/`b`/`c`/`col` verified on the evaluated Geometry Nodes meshes
  of fibers, struts and cells; per-scene-frame visibility and pivot rotation
  checked in the saved `.blend`); build of the fallback paths (`--fiber-mode
  mesh` gives the same vertex/face counts as the node trees for fibers and
  struts, `--cells-mode baked` and `objects`, `--gel-mode spheres`); `--save`;
  and 1280x720 Cycles stills (64 samples + denoise): cartilage frames 0, 6 and
  11 with the volume gel in 160 s, 280 s and 210 s, the format-1 fibrous sample
  frames 0, 9 and 18 in 20-75 s, the format-2 fibrous sample frame 11 in 57 s.
  Day 0 of the cartilage sample is a crisp pale-blue lattice with round blue
  cells and the `compression` load arrow; day 33 a half-dissolved lattice of
  thin struts inside a soft teal fog with short white collagen II tubes and
  salmon cells; day 60 the lattice is gone, the fog denser, the isotropic
  collagen II dense and the cells orange and elongated (`b` 0.42). The fibrous
  samples render as in v0.1: a sparse blue-white cloud with round blue cells
  turning into a dense z-aligned amber weave with orange spindle cells, the
  fiber colour now the density-weighted `new`/`mat` mix. The same code paths run
  under the `blender --background --python` binary; that invocation and Eevee
  rendering could not be exercised in the development container (no Blender
  binary, no GL), so treat Eevee output as untuned: if it looks too bright or
  too dark, adjust `--emission`, `--gel-emission` or the three `TW_*` light
  energies in `build_scene`, and use `--gel-mode spheres` there.
* API notes for maintainers: node-tree sockets are created with
  `tree.interface.new_socket(...)` (4.0+); the Named Attribute node has a
  single dynamic `Attribute` output; a float linked to Instance on Points'
  `Scale` (vector) socket is broadcast to (s, s, s); FLOAT_COLOR point
  attributes survive Mesh to Curve -> Curve to Mesh and Realize Instances, so a
  precomputed per-vertex colour is the simplest way to get species mixes into a
  shader; Points to Volume's `Density` input is a single value, not a field
  (linking an attribute to it silently yields an empty volume), which is why the
  fog uses Volume Cube whose `Density` is a field, sampled with Sample Nearest +
  Sample Index; a Geometry Nodes volume on a mesh object is invisible to Python
  (`evaluated_get().data` stays a Mesh, `bound_box` is zero) but Cycles renders
  it; Set Material after Instance on Points leaves an empty first material
  slot (indices point at slot 1 -- harmless); Instance on Points' `Rotation` is a
  Rotation socket (fed by `FunctionNodeEulerToRotation`); `ShaderNodeMix` and
  `ShaderNodeMixShader` carry same-named sockets, so look them up by (name,
  type) or index; Cycles ignores `use_backface_culling`, hence the Geometry >
  Backfacing term in the gel shader; `Object.matrix_world` is stale until a
  depsgraph update, so the camera fit builds matrices by hand;
  `Material.surface_render_method = 'BLENDED' | 'DITHERED'` replaces
  `blend_method` in 4.2; the static `engine` enum only lists
  `BLENDER_EEVEE_NEXT` - Cycles is a dynamic item, so the script sets engines
  inside try/except.
