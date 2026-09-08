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

The importer is not a look-alike of the web renderer: where a number decides what is drawn,
it uses the same number. The fiber layout and its per-frame laws come from `src/recipe.js`
(one recipe, two implementations), and the cell colour ramp, the cell aspect law, the
load-arrow normalisation and the camera direction from `src/render.js`.
`python3 blender/test_recipe_parity.py` runs `blender/recipe_dump.mjs` under node and compares
the two, so a retune on the web side fails here instead of drifting quietly (section 7).

## 1. Trajectory formats

### Format 2 (docs/EXTENDING.md section 5)

```
{ "meta": { "format": 2, "tissue": "cartilage", "N": 12, "L": 1, "K": 3, "dtDays": 0.02,
            "scenario": "...", "dials": {...}, "loadDial": "amp",
            "loadRange": [0, 0.2],                       // v0.4: [min, max] of that dial
            "tissueName": "...", "scenarioTitle": "...", // v0.4: display labels
            "species":   [{ "key", "label", "kind": "fiber" | "gel" | "scaffold", "color": "#rrggbb" }, ...],
            "fields":    [{ "key", "label", "color": "#rrggbb" }, ...],   // v0.4: diffusible fields
            "cellTypes": [{ "key", "label", "colors": ["#..", "#.."], "shape": { "by": "a" | "b", "aspectMin", "aspectMax" },
                            "radius", "radiusBy": { "by", "min", "max" } }, ...],   // radiusBy: v0.4, optional
            "render": { "recipe": "fiber-v1", "seed", "K", "fiber": {...} },        // v0.4, optional: src/recipe.js
            "ramp":   { "mode", "lift", "mid", "saturation" },                      // optional: the cell ramp
            "exportEveryDays": 5 },
  "frames": [ { "t": 0,
      "species": { "<key>": [N^3], ... },              // one density array per species
      "fields":  { "<key>": [N^3], ... },              // v0.4: one grid per declared field (4 dp)
      "fa": [N^3], "f": [3 N^3],                       // orientation of the fiber species (shared tensor)
      "rho": [N^3], "phiMat": [N^3],                   // duplicates for format-1 readers (ignored here)
      "cells": { "x": [3n], "p": [3n], "a": [n], "b": [n], "c": [n], "type": [n], "alpha": [n] } } ] }
```

The importer reads `meta.species` / `meta.fields` / `meta.cellTypes` and, per frame,
`species[key]`, `fields[key]`, `fa`, `f`, `cells.a/b/c/type` (`c` is carried as a mesh attribute
and shown in the caption when it is ever nonzero; nothing is drawn from it). Tolerances: a species that appears
in the frames but not in `meta.species` is drawn as a fiber with a palette colour;
an unknown `kind` is drawn as a fiber; a species missing from a frame is zero; a
missing `cellTypes` falls back to the fibroblast look; `cells.b`, `cells.c` and
`cells.type` default to 0; cell type indices out of range are clamped. `meta.N` is inferred
from the array length when absent; `meta.K` defaults to 3, `meta.L` to 1.

Every v0.4 key is optional and an older file simply loses that feature: no `fields` in the
frames means nothing to draw with `--fields`; no `loadRange` means the load dial is read over
`[0, 1]`; no `render` means the built-in `RECIPE_FIBER` constants (a copy of `src/recipe.js`)
are used; no `ramp` means the renderer's own OKLab defaults; no `radiusBy` means a fixed cell
radius. Nothing warns except a field that `meta.fields` promises and the frames do not carry.

**Load arrows** are drawn only when `meta.dials` contains the dial named by
`meta.loadDial`; if `meta.loadDial` is absent (or names a dial that is not
there) the importer looks for a dial called `strain`. No such dial, no arrows.
Their length, thickness and opacity follow the **normalised** dial
`s = (value - min) / (max - min)` over `meta.loadRange`, exactly as `src/render.js` does, and
they are hidden below `s = 0.02`. Cartilage's `amp` runs 0-0.2, so at `amp 0.1` it draws the
same half-length arrows as fibrous at `strain 0.5` instead of a stub nobody can see.

**Diffusible fields** (`--fields`) are drawn as a haze of small emissive spheres in the field's
own colour, one cloud per field, diameter `--field-scale * h * (0.35+0.65*v)` and opacity
`--field-opacity * (0.2+0.8*v)` -- the web renderer's point sprite, as geometry. Values are
clamped to `[0, 1]` like the web view; `--field-norm max` divides each field by its own maximum
over the whole trajectory instead, which is what makes a low-tension oxygen field (0.05-0.24)
readable as a gradient rather than a uniform whisper.

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

* **Web app**: open About (the "?" section at the bottom of the panel) and press
  **Export trajectory (JSON for Blender)**. It writes format 2 with one frame every 2
  simulated days since the last reset.
* **Headless**: `node tools/run_headless.mjs` writes the same format, one frame every
  `--snap` days (default 5), and `--blender PATH` copies the first scenario's trajectory
  wherever you want it.
* **Synthetic** (no web app, no node):

  ```bash
  python3 blender/make_sample_trajectory.py                      # fibrous   -> blender/sample_synthetic_fibrous.json
  python3 blender/make_sample_trajectory.py --tissue cartilage   # cartilage -> blender/sample_synthetic_cartilage.json
  python3 blender/make_sample_trajectory.py --tissue cartilage --out my.json --frames 24 --days 90 --cells 200 --seed 3
  ```

  Pure Python, deterministic (mulberry32, like the engine), format 2. Flags:
  `--tissue fibrous|cartilage` (default fibrous), `--out` (default depends on the
  tissue, see above), `--N` (12), `--K` (3), `--frames` (12), `--days` (60),
  `--cells` (160), `--seed` (7), `--force` (overwrite; without it an existing
  output file is never touched). The 12-frame samples are ~1.1-1.4 MB. It cannot
  write diffusible fields -- use a real export to exercise `--fields`.

### The two committed fixtures

| file | what it is | regenerate with |
|---|---|---|
| `blender/sample_trajectory.json` | **a real engine export**: format 2, fibrous, the "Scaffold to tissue" scenario, 19 frames over 90 days at N=12, including the `g` and `m` field grids and `meta.loadRange` / `tissueName` / `scenarioTitle`. 2.2 MB. This is the importer's default input. | `node tools/run_headless.mjs --tissue fibrous --only maturation --blender blender/sample_trajectory.json` |
| `blender/sample_trajectory_cartilage.json` | **synthetic**: `make_sample_trajectory.py`'s cartilage tissue, 12 frames, all three species kinds and a non-`strain` load dial. No fields (the generator cannot make them). 1.4 MB. | `python3 blender/make_sample_trajectory.py --tissue cartilage --out blender/sample_trajectory_cartilage.json --force` |

`make_sample_trajectory.py`'s own defaults are `sample_synthetic_*.json`, so running it with no
arguments can never overwrite either fixture; `--force` is still required to overwrite anything.
For a *real* cartilage trajectory (with the oxygen field), export one:

```bash
node tools/run_headless.mjs --tissue cartilage --days 60 --out scratch/cartilage
python3 blender/import_tissue.py --input scratch/cartilage/race.json --fields o2 --dry-run
```

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
| `--layers L,L,...` | `fibers,cells,gel,scaffold` | which layers to build (e.g. `--layers fibers,cells` hides the haze and the lattice). Fields are **not** a layer here -- see `--fields` |
| `--fields K,K,...` | *(none)* | diffusible fields to draw as a haze, or `all`. Off by default, matching the web view, where the field layers start off. An unknown key is an error, not a silent no-op |
| `--field-scale F` | 1.8 | field haze: sphere diameter `F*h*(0.35+0.65*value)` (the web `pointSize`) |
| `--field-opacity F` | 0.45 | field haze: peak opacity of one sphere (the web `pointOpacity`) |
| `--field-min F` | 0.02 | hide field spheres below this value |
| `--field-norm M` | `clamp` | `clamp` values to [0,1] like the web view, or `max` = divide each field by its own maximum over the whole trajectory (use it for a faint field such as oxygen at a 24 % medium tension) |
| `--fiber-radius F` | `meta.render.fiber.radiusScale`, else 0.6 | the recipe's `radiusScale`: rod radius is `F*0.12*h*sqrt(rho)` with a `0.025*h` floor, times the per-rod jitter; ~0.4 gives a finer weave at high density |
| `--strut-radius F` | 1.0 | multiplies the scaffold strut radius `0.08*h*density` |
| `--view-transform V` | `Standard` | Blender colour management. `Standard` makes the definition hex the literal output colour; `AgX` / `Filmic` / `Khronos PBR Neutral` roll the highlights off instead (see section 3) |
| `--gel-mode M` | `auto` | `volume` (a Cycles fog from a Volume Cube density field; `auto` picks it when the node exists) or `spheres` (instanced translucent spheres, cheaper, works in Eevee) |
| `--gel-density F` | 1.5 | volume mode: scatter/absorption density per unit gel density (1.5 at gel 0.8 makes the far side of the cube ~30 % visible) |
| `--gel-emission F` | 0.6 | self-illumination of the haze, scaled by local density (0 = lit only by the lamps) |
| `--gel-step-rate F` | 2.0 | volume mode: Cycles volume step rate; larger renders faster and blurrier |
| `--gel-scale F` | 1.0 | spheres mode: multiplies the sphere radius `0.62*h*density^(1/3)` (larger = more overlap) |
| `--gel-opacity F` | 0.22 | spheres mode: peak opacity of one sphere seen face-on at density 1 |
| `--emission F` | 0.12 | emission strength on fibers (cells 0.8x, struts 0.5x) for the glow-on-dark look; 0 = purely lit |
| `--rho-min F` | recipe `minDensity` (0.03) | fibers fade out below this total fiber density and disappear at `minDensityRamp` (0.35) times it |
| `--gel-min F` | 0.02 | gel spheres below this density are omitted (the web `gelMin`) |
| `--scaffold-min F` | 0.025 | scaffold struts below this density are omitted (the web `scaffoldMin`) |
| `--dens-min F` | *(unset)* | sets `--gel-min` and `--scaffold-min` at once (the old name for both) |
| `--seed N` | `meta.render.seed`, else 90210 | seed of the fiber layout stream. **The layout recipe lives in `src/recipe.js`** and is mirrored in `RECIPE_FIBER` here: mulberry32(seed), voxels in index order, `K` rods each, and seven draws per rod -- three for the centre offset `(u-0.5)*0.9*h` per axis, two for the random unit vector (`z = 2u-1`, `phi = 2*pi*u`), one for the length factor `0.78+0.5u` and one for the radius factor `0.85+0.3u`. Change the order on either side and the two renders stop matching; `blender/test_recipe_parity.py` is what catches it |
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
  section 7); the volume gel is a Cycles look -- use `--gel-mode spheres` with
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
tissue hex colours come out as specified: an unlit surface of colour `#rrggbb` renders as
`#rrggbb`. `--view-transform AgX` (or `Filmic`, or `Khronos PBR Neutral`) switches it, and so
does the Colour Management panel in the GUI.

**The one place the two renderers still disagree** (docs/REVIEW.md E4). Material colours match:
the definition hex is the truth on both sides, all saturation factors are 1.0, and the cell
ramp is the same OKLab LUT. What differs is the *view transform*. three.js tone-maps the whole
frame with ACES, which desaturates and rolls off bright pixels; Blender's `Standard` does not.
So a Blender still is punchier in the highlights than the same frame in the browser -- a fully
activated orange cell reads brighter here, and a dense amber weave a little more saturated.
There is no ACES view transform in stock Blender (it needs an ACES OCIO config), so this is
documented rather than fixed; `--view-transform AgX` is the nearest filmic stand-in, and it
changes the mid-tones as well. Everything the two sides *compute* -- layout, geometry, colour
before the curve -- is checked by `blender/test_recipe_parity.py`.

## 4. How the scene is built (one object per layer per frame)

All densities and colours are precomputed per vertex in Python and stored as
mesh attributes; Geometry Nodes turn the light-weight base meshes into
geometry, and the materials read the attributes (`ShaderNodeAttribute`).

* **Fibers (kind `fiber`)** -- one mesh of `K` line segments per voxel (5184 for
  12^3 x 3) with per-vertex attributes `rad` (the finished rod radius), `rho` (= sum of the
  fiber species), `col` (FLOAT_COLOR: sum over fiber species of `rho_s/rho * colour_s`, in
  linear RGB), `fa`, and `frac_<key>` per species when there are several.
  **The recipe is `src/recipe.js`**, mirrored here in `RECIPE_FIBER` / `fiber_*()`:
  direction `d = normalize(sign(f.r_q)*FA*f + (1-FA)*r_q)`, length
  `h*1.35*(0.5+0.9*FA)` times the rod's own length factor, radius
  `max(0.025*h, 0.6*0.12*h*sqrt(min(rho,2)))` times the fade and the rod's own radius factor.
  The fade is 1 at `rho >= 0.03` and smoothsteps to 0 at `0.35*0.03`, so sparse fibers thin out
  instead of popping in at a hairline. Geometry Nodes `TW_FiberTubes`: Mesh to Curve -> Set
  Curve Radius (Named Attribute `rad`, no arithmetic -- python already finished it) -> Curve to
  Mesh with a 6-vertex circle -> Set Material. The material takes `col`, multiplies by
  `0.6+0.4*rho` and emits the same colour weakly.
  Fallback `--fiber-mode mesh`: the same hexagonal prisms built in Python.
* **Fields** (`--fields`, off by default) -- per frame and per field one point-cloud mesh with
  attributes `r` (sphere radius) and `val`, through the Geometry Nodes tree
  `TW_FieldSpheres_<key>` (Instance on Points, icosphere at 1 subdivision). Material
  `TW_field_<key>`: Mix(Transparent, Emission in the field colour) with
  `fac = --field-opacity * (0.2+0.8*val) * (1-facing)^1.5`, front faces only. Each field gets
  its own jittered cloud (the same `_jitterPoints` stream as the web renderer, offset per field
  index), so two hazes interleave instead of coinciding, and every sphere is clamped inside the
  cube. Like the gel, the haze is invisible to shadow and bounce rays.
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
  `a`, `b`, `c`, `col`, `scale` and `rot`. The colour is the type's **OKLab ramp** sampled at
  `a`: a 33-entry LUT from `colors[0]` to `colors[1]`, piecewise through the mid colour
  `#f1e3d3` (`meta.ramp` overrides mode / lift / mid / saturation), linearly interpolated
  between entries -- the port of `src/render.js`, because a straight linear-RGB lerp between
  blue and orange runs through a muddy purple that the web view has not shown since v0.2.
  Shape from the type's `shape`: `s` = `a` or `b` per `shape.by`,
  `A = aspectMin + (aspectMax-aspectMin)*s`, semi-axes `(r*A^0.8, r*A^-0.2, r*A^-0.2)` --
  volume-preserving, so a cell that stretches along its polarity thins across it, and `A < 1`
  (cartilage's chondrocyte rounding up as it differentiates) works without a special case.
  `r = radius*L`, or `radiusBy.min + (max-min)*state` when the meta carries a state-dependent
  radius; `rot` = XYZ Euler taking +x onto the polarity `p`. Geometry Nodes
  `TW_CellSpheres`: Instance on Points of an icosphere with Scale <- `scale` and
  Rotation <- Euler to Rotation(`rot`), Realize Instances (so `col` reaches the
  shader), Set Shade Smooth, Set Material. Fallbacks: `--cells-mode objects` (one
  object per cell, colour through Object Info > Color, <= 200 cells) and
  `--cells-mode baked` (one mesh with all icospheres).
* **Static**: wire cube (Wireframe modifier, `#4a5a70` -- the web `wireColor`), two translucent
  load cones on the z faces (`#d9c9a3`, the web `loadColor`) whose length `L*(0.10+0.22*s)` and
  opacity `0.35+0.45*s` follow the **normalised** load `s`, a 50 mm camera fitted to the cube
  along the web renderer's own default view direction `(0.64, -0.70, 0.32)` (a 3/4 view 18.6 deg
  above the horizon, so a still and an app screenshot show the same side of the cube), area key
  + area fill + sun rim, world `#0b0f14`, title and caption text parented to the camera. The
  caption also lists the mean of every drawn field.
* **Animation**: objects of trajectory frame `i` are visible on scene frames
  `[1+i*hold, 1+(i+1)*hold)` through `hide_render` / `hide_viewport`
  keyframes; the frame range is set to `1..N*hold`. `--turntable` keyframes a
  pivot empty (the camera's parent) from 0 to 360 degrees over that range.

## 5. Known limitations

* The view transform differs from the web renderer's (ACES there, `Standard` here); material
  colours match, rendered pixels do not. See the end of section 3.
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
* Cells are drawn from the exported frame only (no interpolation between frames). The web app's
  export cadence is fixed at one frame every 2 simulated days (there is no dial for it); for a
  smoother clip export headless with a smaller `--snap`, e.g.
  `node tools/run_headless.mjs --tissue fibrous --only maturation --snap 1 --blender my.json`.
* The field haze is instanced spheres, not the web's screen-space sprites (a sphere is brightest
  at its silhouette, the web sprite at its centre), so the two are the same colour and the same
  size but not pixel-identical. Like the web view it goes nearly opaque where the field
  approaches 1 -- a ray crosses ~30 overlapping spheres -- so turn `--field-opacity` down, or
  drop a layer with `--layers`, to see the matrix through it. And `--field-norm clamp`
  (the default, matching the web) leaves a field that never approaches 1 -- oxygen at a 24 %
  medium tension, say -- very faint. `--field-norm max` is the readable alternative and is
  *not* what the browser shows.
* `meta.render` is only written by an export that came from the app's renderer. A headless
  export (`tools/run_headless.mjs`) has no renderer and therefore no `meta.render`, so the
  importer falls back to its own copy of the recipe constants. They agree today
  (`blender/test_recipe_parity.py` proves it); they would not if someone passed non-default
  renderer options in the browser and exported from there.
* The bpy pip module cannot render with Eevee headless (see above) and the
  Blender binary in `--background` needs a GL-capable machine for Eevee too;
  Cycles always works.
* The one-object-per-cell fallback creates `cells x frames` objects; prefer the
  Geometry Nodes or baked modes for long trajectories.

## 6. Keeping the two renderers in step

```bash
python3 blender/test_recipe_parity.py        # add -v for the worst deviations and the a=0.5 colours
```

It runs `node blender/recipe_dump.mjs`, which imports `src/recipe.js` directly and lifts the
four pure colour statics out of `src/render.js`'s source, then compares them against this
directory's python:

| what | tolerance |
|---|---|
| `RECIPE_FIBER` constants, and the round trip through a `meta.render` block | 1e-9 |
| the whole layout for N=2, K=1, seed 90210: offsets, unit vectors, length/radius jitters | 1e-6 |
| the per-frame laws (fade, radius, length) over a grid of densities and anisotropies | 1e-6 |
| the direction law over a spread of axes, anisotropies and rod vectors | 1e-6 |
| every entry of every cell colour ramp, and the sampled `a` = 0, 0.25, 0.5, 0.75, 1 colours | 1e-6 / **1/255 per channel** after sRGB encoding |
| the volume-preserving cell aspect law | 1e-9 |
| the load-arrow normalisation over `meta.loadRange` (including the no-`loadRange` fallback) | 1e-9 |

Typical worst deviation is ~6e-8 -- the float32 arrays the JS side stores its layout in. Without
node installed the script prints `SKIP` and exits 0, the mirror image of the python-less skips
in `tests/export.test.mjs`. **If you retune `src/recipe.js` or the renderer's ramp/aspect
options, this test fails until `RECIPE_FIBER` / `CELL_RAMP_*` / `CELL_ASPECT_EXP` in
`blender/import_tissue.py` are updated to match.** The reverse check -- that the JS writers and
this reader still agree on the file format -- is `tests/export.test.mjs`, which runs
`import_tissue.py --dry-run` over a fresh export of every registered tissue.

A no-Blender sanity check of any trajectory:

```bash
python3 blender/import_tissue.py --input blender/sample_trajectory.json --dry-run --all-frames --fields all
```

It prints, per frame, the fiber/strut/gel/field counts, the per-species and per-field means, the
cell-state means, the `a = 0.5` colour of every cell ramp and what the load arrows would do.

## 7. Tested with

* **The v0.4 pass** (fields, shared recipe, OKLab ramp, normalised arrows), same wheel and
  container: `python3 blender/test_recipe_parity.py` green (1046 comparisons, worst deviation
  6e-8 -- the float32 arrays the JS side stores its layout in); `--dry-run --all-frames` on both
  committed fixtures and on fresh `run_headless` exports of both registered tissues, with
  `--fields all`; and two 960x540 Cycles stills (64 samples + denoise):
  * `blender/sample_trajectory.json` (the new format-2 engine export) at day 90 in 42 s -- a
    dense z-aligned amber weave, orange spindle cells at `a` 0.89, the `#4a5a70` wire cube and
    the `#d9c9a3` load arrows at `strain 0.6 -> 0.60`.
  * a fresh cartilage `race` export at day 20 with `--fields o2` in 216 s (the volume gel is
    most of that) -- teal GAG fog, white collagen II tubes, teal chondrocytes at `a` 0.95, and
    `amp 0.1 -> 0.50 of 0-0.2` arrows on both faces. With the gel layer off and
    `--field-norm max` (34 s) the oxygen haze reads as designed: bright at the +z medium face,
    fading to nothing in the deep half.
* Blender **4.2.23 LTS** as the `bpy` 4.2.23 pip wheel (Python 3.11, Linux,
  4 CPU cores, no GPU) -- the v0.3 pass: dry run (`--all-frames`) of the format-1 sample (19
  frames) and of both format-2 samples; scene build of all 12 cartilage frames
  with visibility keyframes and turntable (attributes `col`/`rho`/`fa`/`frac_*`,
  `col`/`dens`, `a`/`b`/`c`/`col` verified on the evaluated Geometry Nodes meshes
  of fibers, struts and cells; per-scene-frame visibility and pivot rotation
  checked in the saved `.blend`); build of the fallback paths (`--fiber-mode
  mesh` gives the same vertex/face counts as the node trees for fibers and
  struts, `--cells-mode baked` and `objects`, `--gel-mode spheres`); `--save`;
  and 1280x720 Cycles stills (64 samples + denoise): cartilage frames 0, 6 and
  11 with the volume gel in 160 s, 280 s and 210 s, the (then format-1) fibrous sample
  frames 0, 9 and 18 in 20-75 s, the synthetic format-2 fibrous sample frame 11 in 57 s.
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
