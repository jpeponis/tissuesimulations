#!/usr/bin/env python3
"""
import_tissue.py -- Tissue Weather trajectory (JSON) -> Blender 4.2 LTS scene.

Reads the format-2 export of docs/EXTENDING.md section 5 (meta.format == 2:
meta.species / meta.cellTypes, frames[i].species[key], cells.a/b/c/type) and still
accepts the v0.1 format 1 of docs/SPEC.md section 1.10 (rho / fa / f / phiMat,
cells.alpha). Per frame it builds:

  * fiber species  -> tubes: total fiber density = sum of the fiber species; K rods per
                      voxel laid out by the SHARED recipe of src/recipe.js (offset, random
                      unit vector and length/radius jitter from one seeded stream, 7 draws
                      per rod), direction d = normalize(FA*f_signed + (1-FA)*r_q), length
                      h*1.35*(0.5+0.9*FA)*lenJit, radius max(0.025h, 0.072h*sqrt(rho))
                      *fade*radJit, faded out below rho 0.03 and dropped below 0.0105;
                      colour = density-weighted mix of the fiber species colours x (0.6+0.4*rho)
  * gel species    -> a haze: a Volume Cube fog per gel species whose density field is the voxel
                      density (nearest voxel centre, lightly blurred), Principled Volume in the
                      species colour with emission following density; --gel-mode spheres draws
                      instanced translucent spheres (radius 0.62*h*density^(1/3)) instead
  * scaffold species -> a lattice: struts along x, y, z between neighbouring voxel
                      centres (half struts to the faces), radius 0.08*h*density and alpha
                      fading with density, so the scaffold dissolves as it degrades
  * fields         -> a haze of small emissive spheres per diffusible field (meta.fields +
                      frames[i].fields), OFF by default: --fields g,o2 (or --fields all)
  * cells          -> icospheres per cell type: colour from the type's OKLab ramp (the web
                      renderer's LUT, ported below) indexed by `a`, long axis along polarity
                      p with aspect from shape.by ('a' or 'b'): aspectMin..aspectMax and the
                      volume-preserving semi-axes r*A^0.8 / r*A^-0.2, radius per type (a
                      state-dependent meta.radiusBy is followed)
  * static         -> wire cube, load arrows (only when meta.dials holds the dial named by
                      meta.loadDial, or 'strain' when that is absent; the arrow length is the
                      dial NORMALISED over meta.loadRange), camera, lights,
                      world, title (tissue, scenario, dials) and a caption per frame
                      (day, per-species means, alignment, cell state means).

Parity with the web renderer (docs/REVIEW.md E2-E5): the fiber layout constants and laws are
src/recipe.js, mirrored here and checked to 1e-6 by blender/test_recipe_parity.py; the cell
colour ramp, the cell aspect law, the load-arrow normalisation and the camera direction come
from src/render.js. The residual difference is the view transform: three.js tone-maps the whole
frame with ACES, Blender's default here is the plain 'Standard' sRGB view (--view-transform
changes it), so a Blender still is more saturated in the highlights than the same frame in the
browser. Material colours agree; pixels do not.

Headless (Blender binary):
  blender --background --python blender/import_tissue.py -- \
      --input blender/sample_trajectory_cartilage.json --out /tmp/render.png [--frame 8] [--all-frames] [--cycles]

Headless (pip "bpy" module, Python 3.11):
  python3 blender/import_tissue.py --input blender/sample_trajectory.json --out /tmp/render.png
  (Eevee needs a GPU/display; without one the script switches to Cycles automatically.)

GUI: open Blender, Scripting workspace, open this file in the Text editor and Run Script.
  Without CLI arguments it loads $TISSUE_JSON or blender/sample_trajectory.json, builds
  every frame with visibility keyframes (scrub the timeline) and does not render.

No render / bpy needed for a sanity check of a JSON file:
  python3 blender/import_tissue.py --input traj.json --dry-run [--all-frames]
"""
import argparse
import json
import math
import os
import sys
import time

try:
    import bpy  # noqa: F401
    import mathutils
    HAVE_BPY = True
except ImportError:  # --dry-run works without Blender
    bpy = None
    mathutils = None
    HAVE_BPY = False

SCRIPT_TAG = "[import_tissue]"
T0 = time.time()

# --------------------------------------------------------------------------
# small utilities
# --------------------------------------------------------------------------


def log(msg):
    print(f"{SCRIPT_TAG} {time.time() - T0:6.1f}s  {msg}", flush=True)


MASK32 = 0xFFFFFFFF


def mulberry32(seed):
    """Uniform [0,1) generator, bit-exact port of the JS mulberry32 used by the engine."""
    state = seed & MASK32

    def rnd():
        nonlocal state
        state = (state + 0x6D2B79F5) & MASK32
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & MASK32
        t = (((t + (((t ^ (t >> 7)) * (t | 61)) & MASK32)) & MASK32) ^ t) & MASK32
        return ((t ^ (t >> 14)) & MASK32) / 4294967296.0

    return rnd


def random_unit(rnd):
    z = 2.0 * rnd() - 1.0
    phi = 2.0 * math.pi * rnd()
    r = math.sqrt(max(0.0, 1.0 - z * z))
    return (r * math.cos(phi), r * math.sin(phi), z)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def hex_ok(c):
    if not isinstance(c, str):
        return False
    h = c.lstrip("#")
    return len(h) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in h)


def srgb_to_linear(c):
    """sRGB channel (0..1) -> linear, with three.js's constants (ColorManagement.SRGBToLinear),
    so a colour crosses into the linear working space here exactly as it does in the browser."""
    return c * 0.0773993808 if c < 0.04045 else (c * 0.9478672986 + 0.0521327014) ** 2.4


def linear_to_srgb(c):
    """Inverse of srgb_to_linear (three.js LinearToSRGB) — for printing a linear colour as hex."""
    if c < 0.0:
        return 0.0
    return c * 12.92 if c < 0.0031308 else 1.055 * (c ** 0.41666) - 0.055


def hex_to_linear(hex_str, alpha=1.0):
    """'#rrggbb' (sRGB) -> linear RGBA tuple, as Blender node colours / attributes expect."""
    h = hex_str.lstrip("#")
    return tuple([srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)] + [alpha])


def linear_to_hex(rgb):
    """Linear RGB triple -> '#rrggbb' (for logs and the parity test)."""
    return "#" + "".join(f"{max(0, min(255, round(linear_to_srgb(c) * 255))):02x}" for c in rgb[:3])


def lerp_colour(ca, cb, t):
    return tuple(ca[k] * (1.0 - t) + cb[k] * t for k in range(4))


# --------------------------------------------------------------------------
# colour ramp: the web renderer's OKLab LUT (src/render.js, docs/REVIEW.md E3)
#
# A cell's colour is NOT a linear-RGB lerp between the type's two hex values (that runs through
# a muddy purple half-way between blue and orange). src/render.js builds a 33-entry lookup table
# in OKLab, optionally piecewise through an explicit mid colour, and samples it with linear
# interpolation. These four functions are the port; blender/test_recipe_parity.py checks them
# against src/render.js's own code to <= 1/255 per channel.
# --------------------------------------------------------------------------

RENDER_LUT_N = 33                 # src/render.js RENDER_LUT_N
CELL_RAMP_MODE = "oklab"          # opts.cellRamp
CELL_RAMP_LIFT = 0.06             # opts.cellMidLift  (only used without an explicit mid colour)
CELL_RAMP_MID = "#f1e3d3"         # opts.cellColorMid (None/"" = straight OKLab lerp + lift)
CELL_SATURATION = 1.0             # opts.cellSaturation — 1.0: the definition hex IS the colour (E4)
CELL_ASPECT_EXP = 0.8             # opts.cellAspectExp — semi-axes r*A^exp and r*A^(exp-1)


def saturate_linear(rgb, sat):
    """Scale saturation of a linear-RGB triple around its luminance (1 = unchanged)."""
    if not (sat > 0) or sat == 1.0:
        return tuple(rgb[:3])
    l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return tuple(max(0.0, l + (x - l) * sat) for x in rgb[:3])


def to_oklab(rgb):
    l = (0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]) ** (1.0 / 3.0)
    m = (0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]) ** (1.0 / 3.0)
    s = (0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]) ** (1.0 / 3.0)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def from_oklab(lab):
    l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]
    m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]
    s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2]
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    return (max(0.0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            max(0.0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            max(0.0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))


def ramp_lut(c0, c1, mode=CELL_RAMP_MODE, lift=CELL_RAMP_LIFT, mid=None, n=RENDER_LUT_N):
    """src/render.js TissueRenderer._rampLUT: n entries of linear RGB from c0 to c1.
    'rgb' = straight lerp; 'oklch' = perceptual with hue on the shorter arc; anything else =
    OKLab lerp with a bell-shaped lightness lift. An explicit `mid` (linear RGB) makes the ramp
    piecewise through it in OKLab and the lift is not used, exactly as in the renderer."""
    A, B = to_oklab(c0), to_oklab(c1)
    M = to_oklab(mid) if mid else None
    h0, h1 = math.atan2(A[2], A[1]), math.atan2(B[2], B[1])
    if h1 - h0 > math.pi:
        h1 -= 2.0 * math.pi
    elif h0 - h1 > math.pi:
        h1 += 2.0 * math.pi
    C0, C1 = math.hypot(A[1], A[2]), math.hypot(B[1], B[2])
    out = []
    for i in range(n):
        t = i / (n - 1)
        if mode == "rgb" and M is None:
            rgb = tuple(c0[k] + (c1[k] - c0[k]) * t for k in range(3))
        elif M is not None:
            P, Q = (A, M) if t < 0.5 else (M, B)
            w = t * 2.0 if t < 0.5 else t * 2.0 - 1.0
            rgb = from_oklab(tuple(P[k] + (Q[k] - P[k]) * w for k in range(3)))
        elif mode == "oklch":
            L = A[0] + (B[0] - A[0]) * t
            C = C0 + (C1 - C0) * t
            hh = h0 + (h1 - h0) * t
            rgb = from_oklab((L + lift * math.sin(math.pi * t), C * math.cos(hh), C * math.sin(hh)))
        else:
            rgb = from_oklab((A[0] + (B[0] - A[0]) * t + lift * math.sin(math.pi * t),
                              A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t))
        out.append(rgb)
    return out


def ramp_sample(lut, t, alpha=1.0):
    """Linear interpolation inside a ramp LUT, as the renderer's instance-colour loop does."""
    n = len(lut) - 1
    x = clamp(t, 0.0, 1.0) * n
    i0 = int(x)
    i1 = i0 + 1 if i0 < n else i0
    w = x - i0
    a, b = lut[i0], lut[i1]
    return (a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w, alpha)


COL_BACKGROUND = "#0b0f14"
COL_WIRE = "#4a5a70"      # src/render.js opts.wireColor
COL_TEXT = "#d8dee6"
COL_ARROW = "#d9c9a3"     # src/render.js opts.loadColor

# Default camera direction: src/render.js `_viewDir` (a 3/4 view from the front-right, above).
VIEW_DIR = (0.64, -0.70, 0.32)

KINDS = ("fiber", "gel", "scaffold")
LAYERS = ("fibers", "cells", "gel", "scaffold")
# `fields` is deliberately NOT in LAYERS: the web view has the field hazes off by default and
# --layers defaults to all of LAYERS, so listing it there would turn every haze on.
# format-1 files carry rho / phiMat: the two implicit fiber species of the v0.1 model
FORMAT1_SPECIES = [
    {"key": "new", "label": "Provisional matrix", "kind": "fiber", "color": "#cfe8ff"},
    {"key": "mat", "label": "Mature collagen I", "kind": "fiber", "color": "#e0a24a"},
]
FORMAT1_CELL_TYPE = {"key": "fibroblast", "label": "Fibroblast -> myofibroblast", "colors": ["#4ea3ff", "#ff7a3d"],
                     "shape": {"by": "a", "aspectMin": 1.0, "aspectMax": 2.5}, "radius": 0.03}
PALETTE = ["#cfe8ff", "#e0a24a", "#7fe0c9", "#9ec5d8", "#f2a6d8", "#b8f27f", "#ffd27f"]
# src/render.js tissueFromState() hues, for a field the meta forgot to describe
FIELD_PALETTE = ["#3fd6c4", "#e05bd0", "#ffd166", "#7cc7ff", "#ff8a80"]

# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def script_argv():
    """Arguments meant for this script.  `blender ... --python x.py -- a b` puts
    them after '--'; `python3 x.py a b` (bpy module) has no '--'."""
    argv = sys.argv
    if "--" in argv:
        return argv[argv.index("--") + 1:]
    if bpy is None or not bpy.app.binary_path:  # plain python / bpy module
        return argv[1:]
    return []  # Blender GUI/CLI without script args


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="import_tissue.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="trajectory JSON (format 2 or 1). Default: $TISSUE_JSON or sample_trajectory.json next to this script")
    ap.add_argument("--out", help="PNG path for the still render (no render if omitted)")
    ap.add_argument("--frame", type=int, default=-1, help="trajectory frame index to show/render (negative counts from the end; default -1 = last)")
    ap.add_argument("--all-frames", action="store_true", help="build every frame and keyframe visibility so the timeline scrubs the trajectory")
    ap.add_argument("--hold", type=int, default=1, help="scene frames per trajectory frame when --all-frames (default 1)")
    ap.add_argument("--animation", action="store_true", help="also render the whole timeline as a PNG sequence (uses --out as a prefix)")
    ap.add_argument("--cycles", action="store_true", help="render with Cycles (64 samples, CPU/GPU as configured) instead of Eevee")
    ap.add_argument("--eevee", action="store_true", help="force Eevee even under the bpy module (crashes without a GPU/display)")
    ap.add_argument("--samples", type=int, default=None, help="render samples (default 32 Eevee / 64 Cycles)")
    ap.add_argument("--res", default="1280x720", help="render resolution WxH (default 1280x720)")
    ap.add_argument("--turntable", action="store_true", help="camera orbits the cube once over the frame range")
    ap.add_argument("--no-label", action="store_true", help="omit the on-screen title and per-frame caption")
    ap.add_argument("--layers", default=",".join(LAYERS), help=f"comma list of layers to draw (default all: {','.join(LAYERS)})")
    ap.add_argument("--fields", default="", help="comma list of diffusible fields to draw as a haze, or 'all' "
                                                 "(default: none, matching the web view where the field layers start off)")
    ap.add_argument("--seed", type=int, default=None,
                    help=f"PRNG seed of the fiber layout stream (default: meta.render.seed, else {RECIPE_FIBER['seed']})")
    ap.add_argument("--fiber-mode", choices=["auto", "geonodes", "mesh"], default="auto",
                    help="fiber/strut tubes via Geometry Nodes (default) or pre-built hexagonal prisms")
    ap.add_argument("--cells-mode", choices=["auto", "geonodes", "objects", "baked"], default="auto",
                    help="cells via Geometry Nodes instancing (default), one object per cell (<=200), or one baked mesh")
    ap.add_argument("--fiber-radius", type=float, default=None,
                    help=f"multiplier on the recipe's fiber radius (default: meta.render.fiber.radiusScale, "
                         f"else {RECIPE_FIBER['radiusScale']}; the radius is radiusScale*0.12*h*sqrt(rho))")
    ap.add_argument("--strut-radius", type=float, default=1.0, help="multiplier on the scaffold strut radius 0.08*h*density (default 1)")
    ap.add_argument("--gel-scale", type=float, default=1.0, help="spheres mode: multiplier on the sphere radius 0.62*h*density^(1/3) (default 1)")
    ap.add_argument("--gel-opacity", type=float, default=0.22, help="spheres mode: peak opacity of one sphere seen face-on at density 1 (default 0.22)")
    ap.add_argument("--gel-emission", type=float, default=0.6, help="emission strength of the gel haze (default 0.6)")
    ap.add_argument("--gel-mode", choices=["auto", "volume", "spheres"], default="auto",
                    help="gel haze as a Points-to-Volume fog (default when the node exists) or as instanced translucent spheres")
    ap.add_argument("--gel-density", type=float, default=1.5, help="volume gel: scatter/absorption density per unit gel density (default 1.5)")
    ap.add_argument("--gel-step-rate", type=float, default=2.0, help="volume gel: Cycles volume step rate, larger = faster and blurrier fog (default 2)")
    ap.add_argument("--field-scale", type=float, default=1.8,
                    help="field haze: sphere diameter = this * h * (0.35+0.65*value) (default 1.8, the web pointSize)")
    ap.add_argument("--field-opacity", type=float, default=0.45,
                    help="field haze: peak opacity of one sphere (default 0.45, the web pointOpacity)")
    ap.add_argument("--field-min", type=float, default=0.02, help="hide field spheres below this value (default 0.02)")
    ap.add_argument("--field-norm", choices=["clamp", "max"], default="clamp",
                    help="field values: 'clamp' to [0,1] like the web view (default), or 'max' = divide each "
                         "field by its own maximum over the whole trajectory (a faint field then fills the range)")
    ap.add_argument("--emission", type=float, default=0.12, help="emission strength added to fibers/cells for the glow look (default 0.12)")
    ap.add_argument("--rho-min", type=float, default=None,
                    help=f"fade fibers out below this fiber density (default: the recipe's minDensity, {RECIPE_FIBER['minDensity']}; "
                         f"they disappear at minDensityRamp x that)")
    ap.add_argument("--gel-min", type=float, default=0.02, help="hide gel spheres below this density (default 0.02, the web gelMin)")
    ap.add_argument("--scaffold-min", type=float, default=0.025, help="hide scaffold struts below this density (default 0.025, the web scaffoldMin)")
    ap.add_argument("--dens-min", type=float, default=None, help="set --gel-min and --scaffold-min at once (old name for both)")
    ap.add_argument("--view-transform", default="Standard",
                    help="Blender colour management view transform (default Standard: the tissue hex values come "
                         "out as specified; AgX / Filmic / 'Khronos PBR Neutral' give a filmic roll-off)")
    ap.add_argument("--save", help="save the built scene as this .blend")
    ap.add_argument("--dry-run", action="store_true", help="parse + validate the JSON and print counts; no Blender needed")
    ap.add_argument("--keep-scene", action="store_true", help="do not wipe the startup scene first (GUI runs never wipe)")
    return ap.parse_args(argv)


# --------------------------------------------------------------------------
# trajectory loading / validation (format 2 and format 1)
# --------------------------------------------------------------------------


def _flat(seq):
    if seq and isinstance(seq[0], (list, tuple)):
        return [float(v) for row in seq for v in row]
    return [float(v) for v in seq]


def normalise_species(defs, frame_keys):
    """meta.species -> [{key,label,kind,color}] with defaults; frame keys missing from meta become fibers."""
    out, seen = [], set()
    for i, d in enumerate(defs or []):
        if isinstance(d, str):
            d = {"key": d}
        key = str(d.get("key") or f"s{i}")
        kind = str(d.get("kind") or "fiber")
        if kind not in KINDS:
            log(f"WARNING species {key!r}: unknown kind {kind!r}; drawing it as fiber")
            kind = "fiber"
        color = d.get("color") if hex_ok(d.get("color")) else PALETTE[len(out) % len(PALETTE)]
        out.append({"key": key, "label": str(d.get("label") or key), "kind": kind, "color": color})
        seen.add(key)
    for key in frame_keys:
        if key not in seen:
            log(f"WARNING species {key!r} is in the frames but not in meta.species; drawing it as fiber")
            out.append({"key": key, "label": key, "kind": "fiber", "color": PALETTE[len(out) % len(PALETTE)]})
    return out


def _pos(value, dflt):
    """A strictly positive float, or the default (src/render.js treats <= 0 the same way)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return dflt
    return v if v > 0.0 and math.isfinite(v) else dflt


def normalise_fields(defs, frame_keys):
    """meta.fields -> [{key,label,color}] (v0.4, docs/EXTENDING.md section 5). Absent in older
    exports and in any file whose frames carry no `fields`, in which case this returns []; a key
    that appears in the frames but not in meta gets a palette colour."""
    out, seen = [], set()
    for i, d in enumerate(defs or []):
        if isinstance(d, str):
            d = {"key": d}
        if not isinstance(d, dict):
            continue
        key = str(d.get("key") or f"f{i}")
        color = d.get("color") if hex_ok(d.get("color")) else FIELD_PALETTE[len(out) % len(FIELD_PALETTE)]
        out.append({"key": key, "label": str(d.get("label") or key), "color": color})
        seen.add(key)
    for key in frame_keys:
        if key not in seen:
            log(f"WARNING field {key!r} is in the frames but not in meta.fields; giving it a palette colour")
            out.append({"key": key, "label": key, "color": FIELD_PALETTE[len(out) % len(FIELD_PALETTE)]})
    return out


def normalise_cell_types(defs):
    out = []
    for i, d in enumerate(defs or []):
        if not isinstance(d, dict):
            continue
        colors = list(d.get("colors") or [])
        if len(colors) < 2 or not all(hex_ok(c) for c in colors[:2]):
            log(f"WARNING cell type {d.get('key', i)!r}: needs two hex colours; using the fibroblast pair")
            colors = FORMAT1_CELL_TYPE["colors"]
        shape = dict(d.get("shape") or {})
        by = shape.get("by") if shape.get("by") in ("a", "b") else "a"
        # a state-dependent radius exports the state-0 value as `radius` plus radiusBy {by,min,max}
        rb = d.get("radiusBy") if isinstance(d.get("radiusBy"), dict) else None
        r0 = float(d.get("radius", 0.03) or 0.03)
        radius_by = None
        if rb:
            r_min, r_max = float(rb.get("min", r0) or r0), float(rb.get("max", r0) or r0)
            radius_by = {"by": rb.get("by") if rb.get("by") in ("a", "b") else "a", "min": r_min, "max": r_max}
            r0 = r_min
        out.append({"key": str(d.get("key") or f"type{i}"), "label": str(d.get("label") or d.get("key") or f"type{i}"),
                    "colors": [colors[0], colors[1]],
                    "shape": {"by": by, "aspectMin": _pos(shape.get("aspectMin"), 1.0),
                              "aspectMax": _pos(shape.get("aspectMax"), 2.5)},
                    "radius": r0, "radiusBy": radius_by})
    if not out:
        ft = json.loads(json.dumps(FORMAT1_CELL_TYPE))
        ft["radiusBy"] = None
        out.append(ft)
    return out


def cell_ramp(meta, cell_type):
    """The type's colour ramp LUT, as the web renderer builds it (src/render.js setTissue).
    An optional `meta.ramp` block overrides the renderer defaults ported at the top of this
    file: { mode: 'oklab'|'oklch'|'rgb', lift, mid: '#rrggbb'|null, saturation }."""
    r = meta.get("ramp") if isinstance(meta.get("ramp"), dict) else {}
    mode = r.get("mode") if r.get("mode") in ("oklab", "oklch", "rgb") else CELL_RAMP_MODE
    lift = float(r["lift"]) if isinstance(r.get("lift"), (int, float)) else CELL_RAMP_LIFT
    sat = float(r["saturation"]) if isinstance(r.get("saturation"), (int, float)) else CELL_SATURATION
    mid_hex = r.get("mid", CELL_RAMP_MID) if "mid" in r else CELL_RAMP_MID
    mid = saturate_linear(hex_to_linear(mid_hex), 1.0) if hex_ok(mid_hex) else None
    cols = cell_type["colors"]
    c0 = saturate_linear(hex_to_linear(cols[0]), sat)
    c1 = saturate_linear(hex_to_linear(cols[1] if len(cols) > 1 else cols[0]), sat)
    return ramp_lut(c0, c1, mode, lift, mid)


def load_trajectory(path):
    with open(path) as fh:
        data = json.load(fh)
    meta = dict(data.get("meta", {}))
    frames = data.get("frames")
    if not frames:
        raise SystemExit(f"{path}: no frames")
    first = frames[0]

    fmt = int(meta.get("format") or (2 if isinstance(first.get("species"), dict) else 1))
    if fmt >= 2 and not isinstance(first.get("species"), dict):
        if "rho" in first:
            log(f"WARNING meta.format={fmt} but frames carry rho/phiMat only; reading as format 1")
            fmt = 1
        else:
            raise SystemExit(f"{path}: frames[0] has neither 'species' (format 2) nor 'rho' (format 1)")
    if fmt == 1:
        if "rho" not in first:
            raise SystemExit(f"{path}: frames[0] has no 'rho'")
        n_vox = len(first["rho"])
        species_defs = json.loads(json.dumps(FORMAT1_SPECIES))
    else:
        species_defs = normalise_species(meta.get("species"), list(first["species"].keys()))
        if not species_defs:
            raise SystemExit(f"{path}: no species defined")
        ref = first["species"].get(species_defs[0]["key"]) or next(iter(first["species"].values()))
        n_vox = len(ref)
    N = int(meta.get("N") or round(n_vox ** (1.0 / 3.0)))
    if N ** 3 != n_vox:
        raise SystemExit(f"{path}: {n_vox} voxels is not N^3 for N={N}")
    meta["format"] = fmt
    meta["N"] = N
    meta["L"] = float(meta.get("L", 1.0) or 1.0)
    meta["K"] = int(meta.get("K", 3) or 3)
    meta.setdefault("dials", {})
    if not isinstance(meta["dials"], dict):
        meta["dials"] = {}
    meta.setdefault("scenario", os.path.basename(path))
    meta["species"] = species_defs
    meta["cellTypes"] = normalise_cell_types(meta.get("cellTypes"))
    meta["kinds"] = {kind: [s for s in species_defs if s["kind"] == kind] for kind in KINDS}
    n_types = len(meta["cellTypes"])
    # v0.4 diffusible fields; absent in format 1 and in every export before them (E1)
    field_src = first.get("fields") if isinstance(first.get("fields"), dict) else {}
    field_defs = normalise_fields(meta.get("fields"), list(field_src.keys())) if fmt >= 2 else []
    dropped = [f["key"] for f in field_defs if f["key"] not in field_src]
    if dropped:
        log(f"WARNING meta.fields declares {', '.join(dropped)} but the frames carry no grid for them; not drawn")
    meta["fields"] = [f for f in field_defs if f["key"] in field_src]

    out = []
    for i, fr in enumerate(frames):
        species = {}
        if fmt == 1:
            rho = _flat(fr["rho"])
            phi = _flat(fr.get("phiMat") or fr.get("phimat") or fr.get("phi_mat") or [0.0] * n_vox)
            if len(rho) != n_vox or len(phi) != n_vox:
                raise SystemExit(f"frame {i}: len(rho)={len(rho)} len(phiMat)={len(phi)} != {n_vox}")
            species["new"] = [r * (1.0 - clamp(p, 0.0, 1.0)) for r, p in zip(rho, phi)]
            species["mat"] = [r * clamp(p, 0.0, 1.0) for r, p in zip(rho, phi)]
        else:
            src = fr.get("species") or {}
            for s in species_defs:
                arr = src.get(s["key"])
                arr = _flat(arr) if arr else [0.0] * n_vox
                if len(arr) != n_vox:
                    raise SystemExit(f"frame {i}: len(species.{s['key']})={len(arr)} != {n_vox}")
                species[s["key"]] = arr
        fields = {}
        fsrc = fr.get("fields") if isinstance(fr.get("fields"), dict) else {}
        for fd in meta["fields"]:
            arr = fsrc.get(fd["key"])
            arr = _flat(arr) if arr else [0.0] * n_vox
            if len(arr) != n_vox:
                raise SystemExit(f"frame {i}: len(fields.{fd['key']})={len(arr)} != {n_vox}")
            fields[fd["key"]] = arr
        fa = _flat(fr.get("fa") or [0.0] * n_vox)
        f = _flat(fr.get("f") or [0.0, 0.0, 1.0] * n_vox)
        for name, arr, want in (("fa", fa, n_vox), ("f", f, 3 * n_vox)):
            if len(arr) != want:
                raise SystemExit(f"frame {i}: len({name})={len(arr)} != {want}")
        totals = {}
        for kind in KINDS:
            tot = [0.0] * n_vox
            for s in meta["kinds"][kind]:
                arr = species[s["key"]]
                for v in range(n_vox):
                    tot[v] += arr[v]
            totals[kind] = tot

        cells = fr.get("cells") or {}
        cx = _flat(cells.get("x") or [])
        n = len(cx) // 3
        cp = _flat(cells.get("p") or [1.0, 0.0, 0.0] * n)
        ca = _flat(cells.get("a") if cells.get("a") is not None else (cells.get("alpha") or [0.0] * n))
        cb = _flat(cells.get("b") or [0.0] * n)
        cc = _flat(cells.get("c") or [0.0] * n)
        ctype = [int(t) for t in (cells.get("type") or [0] * n)]
        if len(cp) != 3 * n or len(ca) != n or len(cb) != n or len(cc) != n or len(ctype) != n:
            raise SystemExit(f"frame {i}: cells arrays inconsistent (x:{len(cx)} p:{len(cp)} a:{len(ca)} b:{len(cb)} c:{len(cc)} type:{len(ctype)})")
        if any(t < 0 or t >= n_types for t in ctype):
            log(f"WARNING frame {i}: cell type index outside 0..{n_types - 1}; clamping")
            ctype = [clamp(t, 0, n_types - 1) for t in ctype]
        out.append({"t": float(fr.get("t", i)), "species": species, "fields": fields,
                    "fiber": totals["fiber"], "gel": totals["gel"], "scaffold": totals["scaffold"],
                    "fa": fa, "f": f, "cx": cx, "cp": cp, "ca": ca, "cb": cb, "cc": cc, "ctype": ctype, "n_cells": n})
    meta["uses_b"] = any(any(b != 0.0 for b in fr["cb"]) for fr in out) or \
        any(ct["shape"]["by"] == "b" for ct in meta["cellTypes"])
    meta["uses_c"] = any(any(c != 0.0 for c in fr["cc"]) for fr in out)
    return meta, out


def frame_stats(fr, meta):
    mean = lambda xs: (sum(xs) / len(xs)) if xs else 0.0
    return {"species": {s["key"]: mean(fr["species"][s["key"]]) for s in meta["species"]},
            "fields": {f["key"]: mean(fr["fields"].get(f["key"]) or []) for f in meta.get("fields") or []},
            "fa": mean(fr["fa"]), "a": mean(fr["ca"]), "b": mean(fr["cb"]), "c": mean(fr["cc"]), "n_vox": len(fr["fa"])}


def caption_text(fr, meta, field_keys=()):
    st = frame_stats(fr, meta)
    sp = "  ".join(f"{k} {v:.2f}" for k, v in st["species"].items())
    cells = f"a {st['a']:.2f}" + (f"  b {st['b']:.2f}" if meta.get("uses_b") else "") + \
        (f"  c {st['c']:.2f}" if meta.get("uses_c") else "")
    fl = "  ".join(f"{k} {st['fields'][k]:.2f}" for k in field_keys if k in st["fields"])
    return (f"day {fr['t']:.1f}   |   {sp}   |   alignment {st['fa']:.2f}   |   cells {cells}"
            + (f"   |   {fl}" if fl else ""))


def load_dial(meta):
    """(key, raw value, normalised value) of the load dial: meta.loadDial if that dial is
    present, else 'strain', else (None, 0, 0).

    The arrows show the NORMALISED value s = (v - min) / (max - min) over meta.loadRange
    (docs/EXTENDING.md section 5), the way src/render.js `_updateLoad` does: cartilage's 0-0.2
    compression dial then draws the same range of arrows as fibrous' 0-1 stretch dial instead of
    a stub nobody can see. Without `loadRange` the range falls back to [0, 1], which is what
    every pre-v0.4 file implied."""
    dials = meta.get("dials") or {}
    key = meta.get("loadDial")
    if not key or key not in dials:
        key = "strain" if "strain" in dials else None
    if key is None:
        return None, 0.0, 0.0
    try:
        raw = float(dials.get(key) or 0.0)
    except (TypeError, ValueError):
        raw = 0.0
    lo, hi = 0.0, 1.0
    rng = meta.get("loadRange")
    if isinstance(rng, (list, tuple)) and len(rng) == 2:
        try:
            lo, hi = float(rng[0]), float(rng[1])
        except (TypeError, ValueError):
            lo, hi = 0.0, 1.0
    span = hi - lo if hi > lo else 1.0
    return key, raw, clamp((raw - lo) / span, 0.0, 1.0)


def fmt_range(meta):
    """'0-0.2 (meta.loadRange)' / '0-1 (assumed)' — what the load dial was normalised over."""
    rng = meta.get("loadRange")
    if isinstance(rng, (list, tuple)) and len(rng) == 2:
        try:
            return f"{float(rng[0]):g}-{float(rng[1]):g} (meta.loadRange)"
        except (TypeError, ValueError):
            pass
    return "0-1 (assumed: no meta.loadRange)"


# --------------------------------------------------------------------------
# geometry recipes, pure Python
# --------------------------------------------------------------------------


# The fiber recipe: one definition, two implementations. Keep these in step with
# src/recipe.js RECIPE_FIBER -- blender/test_recipe_parity.py compares the two to 1e-6.
RECIPE_FIBER = {
    "seed": 90210,          # mulberry32 seed of the layout stream
    "K": 3,                 # rods per voxel
    "offsetSpan": 0.9,      # rod centre jitter inside the voxel, x h, uniform in +-offsetSpan/2
    "lenJitterMin": 0.78, "lenJitterSpan": 0.5,     # per-rod length factor
    "radJitterMin": 0.85, "radJitterSpan": 0.3,     # per-rod radius factor
    "radiusBase": 0.12,     # SPEC radius 0.12*h*sqrt(rho) ...
    "radiusScale": 0.6,     # ... x this
    "minRadius": 0.025,     # x h: floor so sparse fibers stay visible hairlines
    "lengthScale": 1.35,    # x h
    "lengthBase": 0.5, "lengthFA": 0.9,             # length prop. to (lengthBase + lengthFA*FA)
    "minDensity": 0.03,     # full-strength fibers at or above this total fiber density
    "minDensityRamp": 0.35, # fade in from minDensity*this (1 = the v0.1 hard cut)
    "rhoMaxDraw": 2,        # rho used for the radius is clamped here
}


def recipe_from_meta(meta):
    """RECIPE_FIBER overridden by `meta.render` when the writer put the recipe it used in the
    export (src/recipe.js recipeRenderMeta / renderer.layoutParams). Unknown recipe names and
    missing/!finite values fall back to the constants above, so an older file still reads."""
    out = dict(RECIPE_FIBER)
    r = meta.get("render") if isinstance(meta.get("render"), dict) else None
    if not r:
        return out
    name = r.get("recipe")
    if name and name != "fiber-v1":
        log(f"WARNING meta.render.recipe is {name!r}, not 'fiber-v1'; using the built-in constants")
        return out
    for key, src in [("seed", r), ("K", r)] + [(k, r.get("fiber") or {}) for k in RECIPE_FIBER if k not in ("seed", "K")]:
        v = src.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            out[key] = int(v) if key in ("seed", "K") else float(v)
    return out


class FiberLayout:
    """The per-instance fiber layout of src/recipe.js recipeFiberLayout(), in world units.

    One mulberry32 stream, voxels in index order (i outermost, k innermost), K rods each and
    SEVEN draws per rod in a fixed order: three for the centre offset, two for the random unit
    vector r_q, one for the length factor and one for the radius factor. Nothing else may
    consume this stream, or the Blender rods stop matching the browser's.

    The recipe is written for the unit cube the web renderer draws in (h = 1/N); everything
    here is that layout multiplied by L, so an export with L != 1 still lands in [0, L]^3.
    """

    def __init__(self, N, K, L, seed, recipe=None):
        R = recipe or RECIPE_FIBER
        self.N, self.K, self.L, self.recipe = N, K, L, R
        self.h = L / N
        rnd = mulberry32(seed)
        span = R["offsetSpan"] * self.h
        self.centers = []
        for i in range(N):
            for j in range(N):
                for k in range(N):
                    self.centers.append(((i + 0.5) * self.h, (j + 0.5) * self.h, (k + 0.5) * self.h))
        self.offsets = []
        self.rvec = []
        self.jit = []            # (length factor, radius factor) per rod
        for v in range(N * N * N):
            for _ in range(K):
                self.offsets.append(((rnd() - 0.5) * span, (rnd() - 0.5) * span, (rnd() - 0.5) * span))
                self.rvec.append(random_unit(rnd))
                self.jit.append((R["lenJitterMin"] + R["lenJitterSpan"] * rnd(),
                                 R["radJitterMin"] + R["radJitterSpan"] * rnd()))
        self.scales = fiber_scales(self.h, R)


def fiber_scales(h, R):
    """src/recipe.js recipeFiberScales(): the per-grid constants of the per-frame laws."""
    min_density = max(0.0, R["minDensity"])
    ramp = clamp(R["minDensityRamp"], 0.0, 1.0)
    return {"h": h,
            "rMul": R["radiusBase"] * h * R["radiusScale"],
            "rMin": R["minRadius"] * h,
            "lMul": h * R["lengthScale"],
            "lengthBase": R["lengthBase"], "lengthFA": R["lengthFA"],
            "rhoMaxDraw": R["rhoMaxDraw"],
            "minDensity": min_density, "rampLo": min_density * ramp}


def fiber_radius(rho, sc):
    """src/recipe.js recipeFiberRadius(): rod radius for a voxel's total fiber density."""
    r = sc["rhoMaxDraw"] if rho > sc["rhoMaxDraw"] else (rho if rho > 0.0 else 0.0)
    rad = sc["rMul"] * math.sqrt(r)
    return rad if rad > sc["rMin"] else sc["rMin"]


def fiber_length(fa, sc):
    """src/recipe.js recipeFiberLength(): rod length (full, not half) for a voxel's FA."""
    return sc["lMul"] * (sc["lengthBase"] + sc["lengthFA"] * fa)


def fiber_fade(rho, sc):
    """src/recipe.js recipeFiberFade(): 0 below rampLo, smoothstep up to 1 at minDensity.
    It multiplies the radius, so sparse fibers thin out instead of popping in and out."""
    if rho >= sc["minDensity"]:
        return 1.0
    if not (rho > sc["rampLo"]) or not (sc["minDensity"] > sc["rampLo"]):
        return 0.0
    u = (rho - sc["rampLo"]) / (sc["minDensity"] - sc["rampLo"])
    return u * u * (3.0 - 2.0 * u)


def fiber_dir(ux, uy, uz, a, rx, ry, rz):
    """src/recipe.js recipeFiberDir(): the voxel's principal axis mixed with the rod's own
    random unit vector by the voxel's FA, signed so a rod never flips 180 deg between frames."""
    s = -a if (ux * rx + uy * ry + uz * rz) < 0.0 else a
    ia = 1.0 - a
    dx, dy, dz = s * ux + ia * rx, s * uy + ia * ry, s * uz + ia * rz
    dl = dx * dx + dy * dy + dz * dz
    if dl < 1e-10:
        return (rx, ry, rz)
    inv = 1.0 / math.sqrt(dl)
    return (dx * inv, dy * inv, dz * inv)


def jitter_points(N, centers, seed, margin, L=1.0):
    """src/render.js TissueRenderer._jitterPoints(): one jittered point per voxel, clamped so a
    sprite of half-size `margin` stays inside the block. Three draws per voxel, in index order."""
    h = L / N
    rnd = mulberry32(seed)
    lo = 0.5 * L if margin > 0.5 * L else (margin if margin > 0.0 else 0.0)
    hi = L - lo
    out = []
    for v in range(N * N * N):
        p = []
        for d in range(3):
            x = centers[v][d] + (rnd() - 0.5) * 0.55 * h
            p.append(lo if x < lo else (hi if x > hi else x))
        out.append(tuple(p))
    return out


def species_colours(defs):
    """Species colours, straight from the definition hex (docs/REVIEW.md E4). The web renderer's
    fiber / gel / scaffold saturation factors are all 1.0, so there is nothing to apply here --
    if one of them is ever moved off 1.0, `saturate_linear()` is the matching operation."""
    return [hex_to_linear(s["color"]) for s in defs]


def mixed_colour(arrays, cols, v, total, fallback):
    """Density-weighted mix of species colours at voxel v (linear RGBA)."""
    if total <= 1e-12:
        return fallback
    r = g = b = 0.0
    for arr, c in zip(arrays, cols):
        w = arr[v] / total
        r += w * c[0]
        g += w * c[1]
        b += w * c[2]
    return (r, g, b, 1.0)


def fiber_segments(fr, meta, layout, rho_min=None):
    """One frame -> (verts, edges, {attr: per-vertex values}) for the fiber rods.

    The layout (where each rod sits, which way its own random vector points, its length and
    radius jitter) is fixed per (N, K, seed) and comes from `layout`; the per-frame laws — how
    the voxel's density and FA become a direction, a length and a radius — are src/recipe.js.
    `rho_min` overrides the recipe's fade-in threshold (None = the recipe's own minDensity).

    Attributes: `rad` (the finished rod radius, so the tube tree needs no arithmetic of its
    own), `rho` (the material's density brightness cue), `col`, `fa` and `frac_<key>`.
    """
    N, K = layout.N, layout.K
    sc = layout.scales
    if rho_min is not None and rho_min != sc["minDensity"]:      # --rho-min overrides the recipe
        ramp = sc["rampLo"] / sc["minDensity"] if sc["minDensity"] > 0 else 0.35
        sc = dict(sc, minDensity=rho_min, rampLo=rho_min * ramp)
    defs = meta["kinds"]["fiber"]
    arrays = [fr["species"][s["key"]] for s in defs]
    cols = species_colours(defs)
    fallback = cols[0] if cols else (1.0, 1.0, 1.0, 1.0)
    rho, fa, f = fr["fiber"], fr["fa"], fr["f"]
    verts, edges, a_rad, a_rho, a_col, a_fa = [], [], [], [], [], []
    fracs = {s["key"]: [] for s in defs} if len(defs) > 1 else {}
    centers, offsets, rvec, jit = layout.centers, layout.offsets, layout.rvec, layout.jit
    for v in range(N * N * N):
        r = rho[v]
        fade = fiber_fade(r, sc) if r == r else 0.0        # r != r skips NaN
        if not (fade > 0.0):
            continue
        A = clamp(fa[v], 0.0, 1.0)
        fx, fy, fz = f[3 * v], f[3 * v + 1], f[3 * v + 2]
        fl = fx * fx + fy * fy + fz * fz
        if not (fl > 1e-12):                               # no principal axis -> fully random rods
            A, fx, fy, fz = 0.0, 0.0, 0.0, 1.0
        elif abs(fl - 1.0) > 1e-4:
            inv = 1.0 / math.sqrt(fl)
            fx, fy, fz = fx * inv, fy * inv, fz * inv
        cx, cy, cz = centers[v]
        rad0 = fiber_radius(r, sc) * fade
        len0 = fiber_length(A, sc)
        col = mixed_colour(arrays, cols, v, r, fallback)
        base = v * K
        for j in range(K):
            ox, oy, oz = offsets[base + j]
            rx, ry, rz = rvec[base + j]
            dx, dy, dz = fiber_dir(fx, fy, fz, A, rx, ry, rz)
            half = 0.5 * len0 * jit[base + j][0]
            rad = rad0 * jit[base + j][1]
            mx, my, mz = cx + ox, cy + oy, cz + oz
            i0 = len(verts)
            verts.append((mx - dx * half, my - dy * half, mz - dz * half))
            verts.append((mx + dx * half, my + dy * half, mz + dz * half))
            edges.append((i0, i0 + 1))
            a_rad.extend((rad, rad))
            a_rho.extend((r, r))
            a_col.extend((col, col))
            a_fa.extend((A, A))
            for key, lst in fracs.items():
                w = fr["species"][key][v] / r
                lst.extend((w, w))
    attrs = {"rad": ("FLOAT", a_rad), "rho": ("FLOAT", a_rho), "col": ("FLOAT_COLOR", a_col), "fa": ("FLOAT", a_fa)}
    for key, vals in fracs.items():
        attrs[f"frac_{key}"] = ("FLOAT", vals)
    return verts, edges, attrs


def scaffold_struts(fr, meta, layout, dens_min):
    """One frame -> (verts, edges, density, colour per vertex) for the strut lattice:
    from every voxel centre one strut along +x, +y, +z to the next centre (or to the
    cube face on the last voxel), plus a half strut to the face on the first voxel."""
    N, h, L = layout.N, layout.h, layout.L
    defs = meta["kinds"]["scaffold"]
    arrays = [fr["species"][s["key"]] for s in defs]
    cols = species_colours(defs)
    fallback = cols[0] if cols else (1.0, 1.0, 1.0, 1.0)
    dens = fr["scaffold"]
    centers = layout.centers
    verts, edges, a_d, a_col = [], [], [], []

    def add(p0, p1, v0, v1):
        d0, d1 = dens[v0], dens[v1]
        if d0 < dens_min and d1 < dens_min:
            return
        i0 = len(verts)
        verts.append(p0)
        verts.append(p1)
        edges.append((i0, i0 + 1))
        a_d.extend((d0, d1))
        a_col.extend((mixed_colour(arrays, cols, v0, d0, fallback), mixed_colour(arrays, cols, v1, d1, fallback)))

    for i in range(N):
        for j in range(N):
            for k in range(N):
                v = (i * N + j) * N + k
                c = centers[v]
                for axis, idx in enumerate((i, j, k)):
                    if idx + 1 < N:
                        v2 = v + (N * N, N, 1)[axis]
                        add(c, centers[v2], v, v2)
                    else:
                        p = list(c)
                        p[axis] = L
                        add(c, tuple(p), v, v)
                    if idx == 0:
                        p = list(c)
                        p[axis] = 0.0
                        add(c, tuple(p), v, v)
    return verts, edges, a_d, a_col


def gel_points(fr, meta, layout, dens_min, scale):
    """One frame -> (positions, sphere radius, density, colour) per voxel with gel."""
    N, h = layout.N, layout.h
    defs = meta["kinds"]["gel"]
    arrays = [fr["species"][s["key"]] for s in defs]
    cols = species_colours(defs)
    fallback = cols[0] if cols else (1.0, 1.0, 1.0, 1.0)
    dens = fr["gel"]
    pos, rad, a_d, a_col = [], [], [], []
    for v in range(N * N * N):
        d = dens[v]
        if not (d >= dens_min):
            continue
        pos.append(layout.centers[v])
        rad.append(0.62 * h * (min(d, 1.5) ** (1.0 / 3.0)) * scale)
        a_d.append(min(d, 1.5))
        a_col.append(mixed_colour(arrays, cols, v, d, fallback))
    return pos, rad, a_d, a_col


def gel_species_points(fr, key, layout, dens_min):
    """One gel species -> (all voxel centres, density clipped to [0, 1.5]; below dens_min -> 0) and
    the number of voxels above dens_min. The volume path samples the nearest centre, so every voxel
    must be present."""
    arr = fr["species"][key]
    dens = [(min(d, 1.5) if d >= dens_min else 0.0) for d in arr]
    return list(layout.centers), dens, sum(1 for d in dens if d > 0.0)


def field_points(fr, key, layout, positions, min_val=0.02, size=None, scale=1.0):
    """One diffusible field of one frame -> (positions, sphere radius, value) per voxel above
    `min_val`, following the web renderer's field sprites: the sprite's world size (and here the
    sphere's diameter) is `size * (0.35 + 0.65*v)` and its opacity `0.2 + 0.8*v`, with v the
    field value clamped to [0, 1] (see --field-norm for what sets v). `positions` is the fixed
    per-voxel jittered cloud (src/render.js _jitterPoints), one per field, so two hazes
    interleave instead of coinciding.
    """
    arr = fr.get("fields", {}).get(key)
    if not arr:
        return [], [], []
    if size is None:
        size = 1.8 * layout.h
    pos, rad, val = [], [], []
    for v in range(len(arr)):
        x = arr[v] * scale
        x = clamp(x, 0.0, 1.0)
        if not (x >= min_val):
            continue
        pos.append(positions[v])
        rad.append(0.5 * size * (0.35 + 0.65 * x))
        val.append(x)
    return pos, rad, val


def tube_mesh_from_segments(verts, edges, radii, attrs, sides=6):
    """Fallback for the Geometry Nodes path: hexagonal prisms built directly, radius per
    end vertex (so struts taper). attrs: {name: (type, per-vertex values)} -> replicated."""
    tverts, tfaces = [], []
    tattrs = {name: (atype, []) for name, (atype, _) in attrs.items()}
    ang = [2.0 * math.pi * s / sides for s in range(sides)]
    cs = [(math.cos(a), math.sin(a)) for a in ang]
    for (i0, i1) in edges:
        ax, ay, az = verts[i0]
        bx, by, bz = verts[i1]
        ux, uy, uz = bx - ax, by - ay, bz - az
        n = math.sqrt(ux * ux + uy * uy + uz * uz) or 1.0
        ux, uy, uz = ux / n, uy / n, uz / n
        if abs(uz) < 0.9:
            vx, vy, vz = -uy, ux, 0.0
        else:
            vx, vy, vz = 0.0, -uz, uy
        n = math.sqrt(vx * vx + vy * vy + vz * vz) or 1.0
        vx, vy, vz = vx / n, vy / n, vz / n
        wx, wy, wz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        base = len(tverts)
        for (px, py, pz), iv in (((ax, ay, az), i0), ((bx, by, bz), i1)):
            r = radii[iv]
            for c, s in cs:
                tverts.append((px + r * (c * vx + s * wx), py + r * (c * vy + s * wy), pz + r * (c * vz + s * wz)))
            for name, (atype, values) in attrs.items():
                tattrs[name][1].extend([values[iv]] * sides)
        for s in range(sides):
            s2 = (s + 1) % sides
            tfaces.append((base + s, base + s2, base + sides + s2, base + sides + s))
        tfaces.append(tuple(base + s for s in reversed(range(sides))))
        tfaces.append(tuple(base + sides + s for s in range(sides)))
    return tverts, tfaces, tattrs


def cell_transforms(fr, meta, L):
    """Per cell: position, semi-axis triple, XYZ-euler rotating +x onto polarity p, colour.

    Shape (src/render.js _updateCells, docs/REVIEW.md E5): aspect A = aspectMin +
    (aspectMax-aspectMin)*s with s = a or b per shape.by, then the semi-axes are the
    volume-preserving pair (r*A^0.8, r*A^-0.2, r*A^-0.2) -- a cell that stretches along its
    polarity thins across it instead of keeping its cross-section, and A < 1 (cartilage's
    chondrocyte rounds up as it differentiates) works out of the box. The radius is the type's,
    or follows a cell state when the meta carries `radiusBy` (E5).

    Colour is the type's OKLab ramp sampled at `a` (E3), not a linear-RGB lerp.
    """
    types = meta["cellTypes"]
    luts = [cell_ramp(meta, t) for t in types]
    pos, scale, rot, cols = [], [], [], []
    xs, ps, al, bl, tl = fr["cx"], fr["cp"], fr["ca"], fr["cb"], fr["ctype"]
    for c in range(fr["n_cells"]):
        ct = types[tl[c]]
        a = clamp(al[c], 0.0, 1.0)
        b = clamp(bl[c], 0.0, 1.0)
        s = b if ct["shape"]["by"] == "b" else a
        rb = ct.get("radiusBy")
        r = ct["radius"] if not rb else rb["min"] + (rb["max"] - rb["min"]) * (b if rb["by"] == "b" else a)
        r *= L
        aspect = ct["shape"]["aspectMin"] + (ct["shape"]["aspectMax"] - ct["shape"]["aspectMin"]) * s
        long_ax = r * (aspect ** CELL_ASPECT_EXP)
        short_ax = r * (aspect ** (CELL_ASPECT_EXP - 1.0))
        pos.append((xs[3 * c], xs[3 * c + 1], xs[3 * c + 2]))
        scale.append((long_ax, short_ax, short_ax))
        cols.append(ramp_sample(luts[tl[c]], a))
        if mathutils is None:
            rot.append((0.0, 0.0, 0.0))
            continue
        p = mathutils.Vector((ps[3 * c], ps[3 * c + 1], ps[3 * c + 2]))
        if p.length < 1e-9:
            p = mathutils.Vector((1.0, 0.0, 0.0))
        q = mathutils.Vector((1.0, 0.0, 0.0)).rotation_difference(p.normalized())
        e = q.to_euler("XYZ")
        rot.append((e.x, e.y, e.z))
    return pos, scale, rot, cols


# --------------------------------------------------------------------------
# Blender helpers
# --------------------------------------------------------------------------


def nsock(node, name, kind="out", stype=None):
    """Find an enabled socket by name (and optional type) -- robust to nodes that
    carry several same-named sockets of different types (Mix, Named Attribute)."""
    col = node.outputs if kind == "out" else node.inputs
    for s in col:
        if s.name == name and s.enabled and (stype is None or s.type == stype):
            return s
    for s in col:  # tolerate disabled but matching (type-switch nodes)
        if s.name == name and (stype is None or s.type == stype):
            return s
    raise KeyError(f"{node.bl_idname}: no {kind}put socket {name!r} ({stype})")


def new_mesh_object(name, verts, edges, faces, collection, attrs=None, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, edges, faces)
    if smooth and faces:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    for aname, (atype, values) in (attrs or {}).items():
        attr = me.attributes.new(name=aname, type=atype, domain="POINT")
        if atype == "FLOAT":
            attr.data.foreach_set("value", values)
        elif atype == "FLOAT_VECTOR":
            attr.data.foreach_set("vector", [c for v in values for c in v])
        elif atype == "FLOAT_COLOR":
            attr.data.foreach_set("color", [c for v in values for c in v])
        else:
            raise ValueError(atype)
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob


def make_collection(name, parent):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    if col.name not in parent.children:
        parent.children.link(col)
    return col


def remove_previous(root_name):
    """Delete objects/collections/data from an earlier run (GUI re-runs)."""
    root = bpy.data.collections.get(root_name)
    if root is None:
        return
    cols = [root]
    stack = [root]
    while stack:
        c = stack.pop()
        for ch in c.children:
            cols.append(ch)
            stack.append(ch)
    for c in cols:
        for ob in list(c.objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0:
                for coll in (bpy.data.meshes, bpy.data.curves, bpy.data.lights, bpy.data.cameras):
                    if data.name in coll and coll[data.name] is data:
                        coll.remove(data)
                        break
    for c in reversed(cols):
        bpy.data.collections.remove(c)
    for ng in [g for g in bpy.data.node_groups if g.name.startswith("TW_")]:
        bpy.data.node_groups.remove(ng)
    for m in [m for m in bpy.data.materials if m.name.startswith("TW_") and m.users == 0]:
        bpy.data.materials.remove(m)


def set_blend(mat, method):
    """Eevee transparency method; Cycles ignores it. 'BLENDED' / 'DITHERED' (4.2), BLEND/HASHED before."""
    if hasattr(mat, "surface_render_method"):      # Blender 4.2+
        mat.surface_render_method = method
    else:                                          # older API
        mat.blend_method = "BLEND" if method == "BLENDED" else "HASHED"


def principled_material(name, roughness=0.45):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:  # 4.x name; keep highlights soft on thin tubes
        bsdf.inputs["Specular IOR Level"].default_value = 0.3
    return mat, nodes, links, bsdf


def attribute_node(nodes, name, location):
    at = nodes.new("ShaderNodeAttribute")
    at.attribute_name = name
    at.attribute_type = "GEOMETRY"
    at.location = location
    return at


def attribute_colour_material(name, col_attr, emission, depth_attr=None, roughness=0.45):
    """Base colour = colour attribute [* (0.6+0.4*depth_attr)], same colour emitted weakly."""
    mat, nodes, links, bsdf = principled_material(name, roughness)
    at = attribute_node(nodes, col_attr, (-700, 200))
    colour_out = nsock(at, "Color")
    if depth_attr:
        at2 = attribute_node(nodes, depth_attr, (-700, -100))
        madd = nodes.new("ShaderNodeMath")
        madd.operation = "MULTIPLY_ADD"
        madd.inputs[1].default_value = 0.4
        madd.inputs[2].default_value = 0.6
        madd.use_clamp = True  # SPEC: 0.6 + 0.4*rho, capped at 1
        madd.location = (-450, -100)
        links.new(nsock(at2, "Fac"), madd.inputs[0])
        scale = nodes.new("ShaderNodeVectorMath")
        scale.operation = "SCALE"
        scale.location = (-250, 100)
        links.new(colour_out, scale.inputs[0])
        links.new(madd.outputs[0], nsock(scale, "Scale", "in"))
        colour_out = scale.outputs[0]
    links.new(colour_out, bsdf.inputs["Base Color"])
    links.new(colour_out, bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = emission
    return mat


def scaffold_material(name, emission):
    """Glassy struts: colour attribute 'col', alpha = clamp(0.15 + 1.6*dens) so thin, degraded
    struts fade out on top of shrinking (radius follows density in the node tree)."""
    mat, nodes, links, bsdf = principled_material(name, 0.3)
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.5
    at = attribute_node(nodes, "col", (-700, 200))
    links.new(nsock(at, "Color"), bsdf.inputs["Base Color"])
    links.new(nsock(at, "Color"), bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = emission
    ad = attribute_node(nodes, "dens", (-700, -150))
    madd = nodes.new("ShaderNodeMath")
    madd.operation = "MULTIPLY_ADD"
    madd.inputs[1].default_value = 1.6
    madd.inputs[2].default_value = 0.15
    madd.use_clamp = True
    madd.location = (-450, -150)
    links.new(nsock(ad, "Fac"), madd.inputs[0])
    links.new(madd.outputs[0], bsdf.inputs["Alpha"])
    set_blend(mat, "DITHERED")
    return mat


def gel_material(name, emission, opacity):
    """Haze: Mix(Transparent, Emission + Diffuse) with
    fac = opacity * (0.3 + 0.7*dens) * (1 - facing)^1.5 * (front faces only)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        if n.bl_idname != "ShaderNodeOutputMaterial":
            nodes.remove(n)
    out = nodes.get("Material Output") or nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    at = attribute_node(nodes, "col", (-900, 300))
    ad = attribute_node(nodes, "dens", (-900, 0))
    emis = nodes.new("ShaderNodeEmission"); emis.location = (-200, 300)
    emis.inputs["Strength"].default_value = emission
    diff = nodes.new("ShaderNodeBsdfDiffuse"); diff.location = (-200, 150)
    diff.inputs["Roughness"].default_value = 1.0
    add = nodes.new("ShaderNodeAddShader"); add.location = (50, 250)
    transp = nodes.new("ShaderNodeBsdfTransparent"); transp.location = (50, 50)
    links.new(nsock(at, "Color"), emis.inputs["Color"])
    links.new(nsock(at, "Color"), diff.inputs["Color"])
    links.new(emis.outputs[0], add.inputs[0])
    links.new(diff.outputs[0], add.inputs[1])
    lw = nodes.new("ShaderNodeLayerWeight"); lw.location = (-900, -250)
    lw.inputs["Blend"].default_value = 0.5
    inv = nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.location = (-700, -250)
    inv.inputs[0].default_value = 1.0
    links.new(nsock(lw, "Facing"), inv.inputs[1])
    soft = nodes.new("ShaderNodeMath"); soft.operation = "POWER"; soft.location = (-500, -250)
    soft.inputs[1].default_value = 1.5
    links.new(inv.outputs[0], soft.inputs[0])
    dm = nodes.new("ShaderNodeMath"); dm.operation = "MULTIPLY_ADD"; dm.location = (-700, 0)
    dm.inputs[1].default_value = 0.7
    dm.inputs[2].default_value = 0.3
    dm.use_clamp = True
    links.new(nsock(ad, "Fac"), dm.inputs[0])
    op = nodes.new("ShaderNodeMath"); op.operation = "MULTIPLY"; op.location = (-300, -100)
    links.new(soft.outputs[0], op.inputs[0])
    links.new(dm.outputs[0], op.inputs[1])
    opk = nodes.new("ShaderNodeMath"); opk.operation = "MULTIPLY"; opk.location = (-100, -100)
    opk.inputs[1].default_value = opacity
    links.new(op.outputs[0], opk.inputs[0])
    geo = nodes.new("ShaderNodeNewGeometry"); geo.location = (-300, -400)
    back = nodes.new("ShaderNodeMath"); back.operation = "SUBTRACT"; back.location = (-100, -400)
    back.inputs[0].default_value = 1.0
    links.new(nsock(geo, "Backfacing"), back.inputs[1])
    op2 = nodes.new("ShaderNodeMath"); op2.operation = "MULTIPLY"; op2.location = (100, -200)
    links.new(opk.outputs[0], op2.inputs[0])
    links.new(back.outputs[0], op2.inputs[1])
    mix = nodes.new("ShaderNodeMixShader"); mix.location = (350, 0)
    links.new(op2.outputs[0], mix.inputs[0])
    links.new(transp.outputs[0], mix.inputs[1])
    links.new(add.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs["Surface"])
    set_blend(mat, "BLENDED")
    mat.use_backface_culling = True
    return mat


def field_material(name, hex_col, opacity, emission=1.0):
    """A diffusible field's haze (docs/REVIEW.md E1): small self-lit spheres in the field's own
    colour whose opacity follows the field value, `fac = opacity * (0.2 + 0.8*val) *
    (1-facing)^1.5`, front faces only. That is the web renderer's point sprite — colour straight
    from the definition, brightness from the value, no scene lighting — as geometry, so it
    renders in both Cycles and Eevee and sits correctly among the fibers and cells."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        if n.bl_idname != "ShaderNodeOutputMaterial":
            nodes.remove(n)
    out = nodes.get("Material Output") or nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    col = hex_to_linear(hex_col)
    emis = nodes.new("ShaderNodeEmission"); emis.location = (-200, 300)
    emis.inputs["Color"].default_value = col
    emis.inputs["Strength"].default_value = emission
    transp = nodes.new("ShaderNodeBsdfTransparent"); transp.location = (-200, 100)
    av = attribute_node(nodes, "val", (-900, 0))
    dm = nodes.new("ShaderNodeMath"); dm.operation = "MULTIPLY_ADD"; dm.location = (-700, 0)
    dm.inputs[1].default_value = 0.8
    dm.inputs[2].default_value = 0.2
    dm.use_clamp = True
    links.new(nsock(av, "Fac"), dm.inputs[0])
    lw = nodes.new("ShaderNodeLayerWeight"); lw.location = (-900, -250)
    lw.inputs["Blend"].default_value = 0.5
    inv = nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.location = (-700, -250)
    inv.inputs[0].default_value = 1.0
    links.new(nsock(lw, "Facing"), inv.inputs[1])
    soft = nodes.new("ShaderNodeMath"); soft.operation = "POWER"; soft.location = (-500, -250)
    soft.inputs[1].default_value = 1.5
    links.new(inv.outputs[0], soft.inputs[0])
    op = nodes.new("ShaderNodeMath"); op.operation = "MULTIPLY"; op.location = (-300, -100)
    links.new(dm.outputs[0], op.inputs[0])
    links.new(soft.outputs[0], op.inputs[1])
    opk = nodes.new("ShaderNodeMath"); opk.operation = "MULTIPLY"; opk.location = (-100, -100)
    opk.inputs[1].default_value = opacity
    links.new(op.outputs[0], opk.inputs[0])
    geo = nodes.new("ShaderNodeNewGeometry"); geo.location = (-300, -400)
    back = nodes.new("ShaderNodeMath"); back.operation = "SUBTRACT"; back.location = (-100, -400)
    back.inputs[0].default_value = 1.0
    links.new(nsock(geo, "Backfacing"), back.inputs[1])
    op2 = nodes.new("ShaderNodeMath"); op2.operation = "MULTIPLY"; op2.location = (150, -200)
    links.new(opk.outputs[0], op2.inputs[0])
    links.new(back.outputs[0], op2.inputs[1])
    mix = nodes.new("ShaderNodeMixShader"); mix.location = (400, 0)
    links.new(op2.outputs[0], mix.inputs[0])
    links.new(transp.outputs[0], mix.inputs[1])
    links.new(emis.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs["Surface"])
    set_blend(mat, "BLENDED")
    mat.use_backface_culling = True
    return mat


def gel_volume_material(name, hex_col, emission, density_scale):
    """Fog: Principled Volume reading the 'density' grid; scatter/absorption colour and emission
    colour = species colour, emission strength = gel_emission * local density (Volume Info)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        if n.bl_idname != "ShaderNodeOutputMaterial":
            nodes.remove(n)
    out = nodes.get("Material Output") or nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    col = hex_to_linear(hex_col)
    pv = nodes.new("ShaderNodeVolumePrincipled"); pv.location = (100, 0)
    pv.inputs["Color"].default_value = col
    pv.inputs["Density"].default_value = density_scale
    pv.inputs["Anisotropy"].default_value = 0.0
    pv.inputs["Emission Color"].default_value = col
    vi = nodes.new("ShaderNodeVolumeInfo"); vi.location = (-400, -200)
    mul = nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.location = (-200, -200)
    mul.inputs[1].default_value = emission
    links.new(nsock(vi, "Density"), mul.inputs[0])
    links.new(mul.outputs[0], pv.inputs["Emission Strength"])
    links.new(pv.outputs["Volume"], out.inputs["Volume"])
    return mat


def make_volume_geonodes(name, material, L, N, res_per_voxel=3, h=None):
    """Points (voxel centres with 'dens') -> Volume Cube over [0,L]^3 at N*res_per_voxel cells per
    axis whose density field samples 'dens' of the nearest voxel centre (7 taps at +-h/2, so the
    fog is a slightly blurred version of the voxel field) -> Set Material (volume shader).
    Points to Volume is not used: its Density socket is a single value, not a field."""
    h = h or (L / N)
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = tree.nodes, tree.links
    n_in = nodes.new("NodeGroupInput"); n_in.location = (-1400, 0)
    n_out = nodes.new("NodeGroupOutput"); n_out.location = (600, 0)
    na_d = nodes.new("GeometryNodeInputNamedAttribute"); na_d.location = (-1400, -300)
    na_d.data_type = "FLOAT"
    na_d.inputs["Name"].default_value = "dens"
    pos = nodes.new("GeometryNodeInputPosition"); pos.location = (-1400, 300)
    taps = [((0.0, 0.0, 0.0), 0.4)]
    for axis in range(3):
        for sign in (-0.5, 0.5):
            off = [0.0, 0.0, 0.0]
            off[axis] = sign * h
            taps.append((tuple(off), 0.1))
    acc = None
    for k, (off, w) in enumerate(taps):
        y = 300 - 160 * k
        add = nodes.new("ShaderNodeVectorMath"); add.operation = "ADD"; add.location = (-1150, y)
        add.inputs[1].default_value = off
        links.new(pos.outputs["Position"], add.inputs[0])
        near = nodes.new("GeometryNodeSampleNearest"); near.location = (-900, y)
        near.domain = "POINT"
        links.new(n_in.outputs[0], near.inputs["Geometry"])
        links.new(add.outputs["Vector"], near.inputs["Sample Position"])
        samp = nodes.new("GeometryNodeSampleIndex"); samp.location = (-650, y)
        samp.data_type = "FLOAT"
        samp.domain = "POINT"
        links.new(n_in.outputs[0], samp.inputs["Geometry"])
        links.new(nsock(na_d, "Attribute"), nsock(samp, "Value", "in", "VALUE"))
        links.new(near.outputs["Index"], samp.inputs["Index"])
        mul = nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.location = (-400, y)
        mul.inputs[1].default_value = w
        links.new(nsock(samp, "Value", "out", "VALUE"), mul.inputs[0])
        if acc is None:
            acc = mul
        else:
            s_ = nodes.new("ShaderNodeMath"); s_.operation = "ADD"; s_.location = (-200, y)
            links.new(acc.outputs[0], s_.inputs[0])
            links.new(mul.outputs[0], s_.inputs[1])
            acc = s_
    cube = nodes.new("GeometryNodeVolumeCube"); cube.location = (100, 0)
    cube.inputs["Background"].default_value = 0.0
    cube.inputs["Min"].default_value = (0.0, 0.0, 0.0)
    cube.inputs["Max"].default_value = (L, L, L)
    for ax in "XYZ":
        cube.inputs[f"Resolution {ax}"].default_value = N * res_per_voxel
    links.new(acc.outputs[0], cube.inputs["Density"])
    set_m = nodes.new("GeometryNodeSetMaterial"); set_m.location = (350, 0)
    set_m.inputs["Material"].default_value = material
    links.new(cube.outputs["Volume"], set_m.inputs["Geometry"])
    links.new(set_m.outputs["Geometry"], n_out.inputs[0])
    return tree


def object_colour_material(name, emission, roughness=0.35):
    """Fallback for one-object-per-cell: colour comes from Object > Viewport Display colour."""
    mat, nodes, links, bsdf = principled_material(name, roughness)
    info = nodes.new("ShaderNodeObjectInfo")
    info.location = (-400, 200)
    links.new(info.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(info.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = emission
    return mat


def emissive_material(name, hex_col, strength=1.0, alpha=1.0, unlit=False):
    """Self-lit flat colour; unlit=True removes the diffuse term so lights cannot shade it (text)."""
    mat, nodes, links, bsdf = principled_material(name, 0.5)
    col = hex_to_linear(hex_col)
    bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0) if unlit else col
    if unlit and "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    bsdf.inputs["Emission Color"].default_value = col
    bsdf.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        set_blend(mat, "BLENDED")
        mat.use_backface_culling = True
    return mat


def make_tube_geonodes(name, radius_attr, mult, exponent, material):
    """Mesh (edges) -> Mesh to Curve -> Set Curve Radius (mult * attr^exponent from the
    named float attribute) -> Curve to Mesh (6-vertex circle) -> Set Material.
    Fibers: attr 'rad', mult 1, exponent 1 -- fiber_segments() already applied the whole
    src/recipe.js radius law per rod, jitter and fade included, so nothing is left to do here.
    Scaffold: attr 'dens', 0.08*h, exponent 1 (a per-renderer law, not shared with the web)."""
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = tree.nodes, tree.links
    n_in = nodes.new("NodeGroupInput"); n_in.location = (-900, 0)
    n_out = nodes.new("NodeGroupOutput"); n_out.location = (700, 0)
    m2c = nodes.new("GeometryNodeMeshToCurve"); m2c.location = (-650, 0)
    named = nodes.new("GeometryNodeInputNamedAttribute"); named.location = (-650, -250)
    named.data_type = "FLOAT"
    named.inputs["Name"].default_value = radius_attr
    pw = nodes.new("ShaderNodeMath"); pw.operation = "POWER"; pw.location = (-450, -250)
    pw.inputs[1].default_value = exponent
    mul = nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.location = (-250, -250)
    mul.inputs[1].default_value = mult
    mul.label = "radius scale"
    set_r = nodes.new("GeometryNodeSetCurveRadius"); set_r.location = (-50, 0)
    circle = nodes.new("GeometryNodeCurvePrimitiveCircle"); circle.location = (-50, -250)
    circle.mode = "RADIUS"
    circle.inputs["Resolution"].default_value = 6
    circle.inputs["Radius"].default_value = 1.0
    c2m = nodes.new("GeometryNodeCurveToMesh"); c2m.location = (200, 0)
    c2m.inputs["Fill Caps"].default_value = True
    smooth = nodes.new("GeometryNodeSetShadeSmooth"); smooth.location = (400, 0)
    set_m = nodes.new("GeometryNodeSetMaterial"); set_m.location = (550, 0)
    set_m.inputs["Material"].default_value = material
    links.new(n_in.outputs[0], m2c.inputs["Mesh"])
    links.new(m2c.outputs["Curve"], set_r.inputs["Curve"])
    links.new(nsock(named, "Attribute"), pw.inputs[0])
    links.new(pw.outputs[0], mul.inputs[0])
    links.new(mul.outputs[0], set_r.inputs["Radius"])
    links.new(set_r.outputs["Curve"], c2m.inputs["Curve"])
    links.new(circle.outputs["Curve"], c2m.inputs["Profile Curve"])
    links.new(c2m.outputs["Mesh"], smooth.inputs["Geometry"])
    links.new(smooth.outputs["Geometry"], set_m.inputs["Geometry"])
    links.new(set_m.outputs["Geometry"], n_out.inputs[0])
    return tree


def make_sphere_geonodes(name, radius_attr, material, subdiv=2):
    """Points -> Instance on Points (icosphere, Scale <- float attribute) -> Realize Instances
    (so 'col' / 'dens' reach the shader) -> Set Shade Smooth -> Set Material."""
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = tree.nodes, tree.links
    n_in = nodes.new("NodeGroupInput"); n_in.location = (-800, 0)
    n_out = nodes.new("NodeGroupOutput"); n_out.location = (700, 0)
    ico = nodes.new("GeometryNodeMeshIcoSphere"); ico.location = (-500, -150)
    ico.inputs["Radius"].default_value = 1.0
    ico.inputs["Subdivisions"].default_value = subdiv
    na = nodes.new("GeometryNodeInputNamedAttribute"); na.location = (-500, -350)
    na.data_type = "FLOAT"
    na.inputs["Name"].default_value = radius_attr
    iop = nodes.new("GeometryNodeInstanceOnPoints"); iop.location = (-200, 0)
    realize = nodes.new("GeometryNodeRealizeInstances"); realize.location = (100, 0)
    smooth = nodes.new("GeometryNodeSetShadeSmooth"); smooth.location = (300, 0)
    set_m = nodes.new("GeometryNodeSetMaterial"); set_m.location = (500, 0)
    set_m.inputs["Material"].default_value = material
    links.new(n_in.outputs[0], iop.inputs["Points"])
    links.new(ico.outputs["Mesh"], iop.inputs["Instance"])
    links.new(nsock(na, "Attribute"), iop.inputs["Scale"])   # float -> (s, s, s)
    links.new(iop.outputs["Instances"], realize.inputs["Geometry"])
    links.new(realize.outputs["Geometry"], smooth.inputs["Geometry"])
    links.new(smooth.outputs["Geometry"], set_m.inputs["Geometry"])
    links.new(set_m.outputs["Geometry"], n_out.inputs[0])
    return tree


def make_cell_geonodes(material):
    """Points -> Instance on Points (icosphere; Scale <- 'scale', Rotation <- Euler('rot'))
    -> Realize Instances (so 'col' reaches the shader) -> smooth -> Set Material."""
    tree = bpy.data.node_groups.new("TW_CellSpheres", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = tree.nodes, tree.links
    n_in = nodes.new("NodeGroupInput"); n_in.location = (-800, 0)
    n_out = nodes.new("NodeGroupOutput"); n_out.location = (700, 0)
    ico = nodes.new("GeometryNodeMeshIcoSphere"); ico.location = (-500, -150)
    ico.inputs["Radius"].default_value = 1.0
    ico.inputs["Subdivisions"].default_value = 2
    na_scale = nodes.new("GeometryNodeInputNamedAttribute"); na_scale.location = (-500, -350)
    na_scale.data_type = "FLOAT_VECTOR"
    na_scale.inputs["Name"].default_value = "scale"
    na_rot = nodes.new("GeometryNodeInputNamedAttribute"); na_rot.location = (-500, -550)
    na_rot.data_type = "FLOAT_VECTOR"
    na_rot.inputs["Name"].default_value = "rot"
    iop = nodes.new("GeometryNodeInstanceOnPoints"); iop.location = (-200, 0)
    if hasattr(bpy.types, "FunctionNodeEulerToRotation"):
        e2r = nodes.new("FunctionNodeEulerToRotation"); e2r.location = (-350, -550)
        links.new(nsock(na_rot, "Attribute"), e2r.inputs["Euler"])
        links.new(e2r.outputs["Rotation"], iop.inputs["Rotation"])
    else:  # < 4.0: rotation socket is a plain vector
        links.new(nsock(na_rot, "Attribute"), iop.inputs["Rotation"])
    realize = nodes.new("GeometryNodeRealizeInstances"); realize.location = (100, 0)
    smooth = nodes.new("GeometryNodeSetShadeSmooth"); smooth.location = (300, 0)
    set_m = nodes.new("GeometryNodeSetMaterial"); set_m.location = (500, 0)
    set_m.inputs["Material"].default_value = material
    links.new(n_in.outputs[0], iop.inputs["Points"])
    links.new(ico.outputs["Mesh"], iop.inputs["Instance"])
    links.new(nsock(na_scale, "Attribute"), iop.inputs["Scale"])
    links.new(iop.outputs["Instances"], realize.inputs["Geometry"])
    links.new(realize.outputs["Geometry"], smooth.inputs["Geometry"])
    links.new(smooth.outputs["Geometry"], set_m.inputs["Geometry"])
    links.new(set_m.outputs["Geometry"], n_out.inputs[0])
    return tree


def icosphere_pydata(subdiv=2):
    """Unit icosphere as (verts, faces) via bmesh (used by the non-GN cell / gel modes)."""
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    verts = [tuple(v.co) for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


def baked_spheres(ico_verts, ico_faces, pos, scale, rot, per_point_attrs):
    """One mesh with one transformed icosphere per point; attrs replicated per vertex."""
    bv, bf = [], []
    out_attrs = {name: (atype, []) for name, (atype, _) in per_point_attrs.items()}
    for c in range(len(pos)):
        sc = scale[c] if isinstance(scale[c], (tuple, list)) else (scale[c],) * 3
        m = mathutils.Matrix.LocRotScale(mathutils.Vector(pos[c]),
                                         mathutils.Euler(rot[c] if rot else (0.0, 0.0, 0.0), "XYZ"),
                                         mathutils.Vector(sc))
        base = len(bv)
        bv.extend(tuple(m @ mathutils.Vector(v)) for v in ico_verts)
        bf.extend(tuple(base + k for k in f) for f in ico_faces)
        for name, (atype, values) in per_point_attrs.items():
            out_attrs[name][1].extend([values[c]] * len(ico_verts))
    return bv, bf, out_attrs


def cone_pydata(radius, height, z0, up=True, segments=24):
    """Cone with base at z0, apex at z0 +/- height, centred on the cube's z axis."""
    apex_z = z0 + (height if up else -height)
    verts = [(0.5 + radius * math.cos(2 * math.pi * s / segments), 0.5 + radius * math.sin(2 * math.pi * s / segments), z0)
             for s in range(segments)]
    verts.append((0.5, 0.5, apex_z))
    apex = segments
    faces = [(s, (s + 1) % segments, apex) if up else ((s + 1) % segments, s, apex) for s in range(segments)]
    faces.append(tuple(reversed(range(segments))) if up else tuple(range(segments)))
    return verts, faces


def look_at(obj, target):
    """Aim obj's -Z axis at target (camera/light convention). Returns the rotation quaternion."""
    direction = mathutils.Vector(target) - mathutils.Vector(obj.location)
    quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = quat.to_euler()
    return quat


def fit_camera(cam_obj, cam, center, corners, aspect, view_dir, margin=0.90):
    """Place the camera along view_dir from center so that all corners fit in frame."""
    sensor_w = cam.sensor_width
    sensor_h = sensor_w / aspect if aspect >= 1.0 else sensor_w
    if aspect < 1.0:
        sensor_w = sensor_h * aspect
    tan_h = 0.5 * sensor_w / cam.lens
    tan_v = 0.5 * sensor_h / cam.lens
    vd = mathutils.Vector(view_dir).normalized()
    c = mathutils.Vector(center)

    def fits(dist):
        cam_obj.location = c + vd * dist
        quat = look_at(cam_obj, c)
        # matrix_world only refreshes on a depsgraph update, so build the matrix by hand
        inv = mathutils.Matrix.LocRotScale(cam_obj.location, quat, None).inverted()
        for p in corners:
            q = inv @ mathutils.Vector(p)
            if q.z >= -1e-6:
                return False
            if abs(q.x / -q.z) > tan_h * margin or abs(q.y / -q.z) > tan_v * margin:
                return False
        return True

    lo, hi = 0.5, 50.0
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if fits(mid):
            hi = mid
        else:
            lo = mid
    fits(hi)
    return hi, tan_h, tan_v


def add_text(name, body, collection, material, size, parent, local_xy, depth, align_y="BOTTOM"):
    cu = bpy.data.curves.new(name, type="FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "LEFT"
    cu.align_y = align_y
    cu.materials.append(material)
    ob = bpy.data.objects.new(name, cu)
    collection.objects.link(ob)
    ob.parent = parent
    ob.location = (local_xy[0], local_xy[1], -depth)
    ob.rotation_euler = (0.0, 0.0, 0.0)
    return ob


def set_visibility_keyframes(objs, i, n_frames, hold):
    """Objects of trajectory frame i are visible on scene frames [1+i*hold, 1+(i+1)*hold)."""
    start = 1 + i * hold
    end = 1 + (i + 1) * hold
    for ob in objs:
        for prop in ("hide_render", "hide_viewport"):
            if i > 0:
                setattr(ob, prop, True)
                ob.keyframe_insert(prop, frame=1)
            setattr(ob, prop, False)
            ob.keyframe_insert(prop, frame=start)
            if i < n_frames - 1:
                setattr(ob, prop, True)
                ob.keyframe_insert(prop, frame=end)


def haze_visibility(ob):
    """The gel haze is seen by camera/transmission rays only: no shadows, no bounce light,
    so it cannot darken or tint the fibers and cells inside it."""
    for prop in ("visible_shadow", "visible_diffuse", "visible_glossy", "visible_volume_scatter"):
        if hasattr(ob, prop):
            setattr(ob, prop, False)


# --------------------------------------------------------------------------
# scene construction
# --------------------------------------------------------------------------


def build_scene(meta, frames, args, module_mode):
    scene = bpy.context.scene
    N, L, K = meta["N"], meta["L"], meta["K"]
    layout = FiberLayout(N, K, L, args.seed, args.recipe)
    h = layout.h
    n_frames = len(frames)
    layers = args.layer_set
    if args.all_frames:
        frame_ids = list(range(n_frames))
    else:
        frame_ids = [args.frame % n_frames]
    hold = max(1, args.hold)
    fiber_defs, gel_defs, scaffold_defs = meta["kinds"]["fiber"], meta["kinds"]["gel"], meta["kinds"]["scaffold"]
    draw_fibers = "fibers" in layers and bool(fiber_defs)
    draw_gel = "gel" in layers and bool(gel_defs)
    draw_scaffold = "scaffold" in layers and bool(scaffold_defs)
    draw_cells = "cells" in layers
    field_defs = [f for f in meta["fields"] if f["key"] in args.field_set]

    root = make_collection("TissueWeather", scene.collection)
    static = make_collection("TW_static", root)

    # ---- materials
    fiber_mat = attribute_colour_material("TW_fiber", "col", args.emission, depth_attr="rho", roughness=0.65)
    cell_mat = attribute_colour_material("TW_cell", "col", args.emission * 0.8, roughness=0.45)
    scaffold_mat = scaffold_material("TW_scaffold", args.emission * 0.5) if draw_scaffold else None
    gel_mat = None
    cell_obj_mat = None
    wire_mat = emissive_material("TW_wire", COL_WIRE, strength=0.8)
    text_mat = emissive_material("TW_text", COL_TEXT, strength=1.0, unlit=True)
    # arrow length/thickness/opacity follow the NORMALISED load dial (src/render.js _updateLoad),
    # so a 0-0.2 compression dial and a 0-1 stretch dial draw the same range of arrows (E5)
    load_key, load_raw, load = load_dial(meta)
    arrow_mat = emissive_material("TW_arrow", COL_ARROW, strength=0.4, alpha=0.35 + 0.45 * load)

    # ---- fiber / strut / gel / cell pipelines (Geometry Nodes, with fallbacks)
    fiber_mode = args.fiber_mode
    fiber_tree = strut_tree = gel_tree = None
    if fiber_mode in ("auto", "geonodes"):
        try:
            # the rod radius is already finished per vertex (src/recipe.js, attribute 'rad'),
            # so the tube tree only has to read it: no power, no scale of its own
            fiber_tree = make_tube_geonodes("TW_FiberTubes", "rad", 1.0, 1.0, fiber_mat)
            if draw_scaffold:
                strut_tree = make_tube_geonodes("TW_ScaffoldStruts", "dens", 0.08 * h * args.strut_radius, 1.0, scaffold_mat)
            fiber_mode = "geonodes"
        except Exception as exc:  # pragma: no cover - depends on Blender version
            if args.fiber_mode == "geonodes":
                raise
            log(f"WARNING tube Geometry Nodes setup failed ({exc}); falling back to pre-built tubes")
            fiber_mode = "mesh"
    gel_mode = "off"
    gel_trees = {}
    if draw_gel:
        gel_mode = args.gel_mode
        if gel_mode == "auto":
            gel_mode = "volume" if hasattr(bpy.types, "GeometryNodeVolumeCube") else "spheres"
        if gel_mode == "volume":
            try:
                for s in gel_defs:
                    vm = gel_volume_material(f"TW_gel_{s['key']}", s["color"], args.gel_emission, args.gel_density)
                    gel_trees[s["key"]] = make_volume_geonodes(f"TW_GelVolume_{s['key']}", vm, L, N, 3, h)
            except Exception as exc:  # pragma: no cover
                log(f"WARNING gel volume setup failed ({exc}); using translucent spheres")
                gel_mode, gel_trees = "spheres", {}
        if gel_mode == "spheres":
            gel_mat = gel_material("TW_gel", args.gel_emission, args.gel_opacity)
            try:
                gel_tree = make_sphere_geonodes("TW_GelSpheres", "r", gel_mat, subdiv=2)
            except Exception as exc:  # pragma: no cover
                log(f"WARNING gel Geometry Nodes setup failed ({exc}); baking gel spheres into one mesh")
                gel_mode = "baked"
    field_trees, field_pos = {}, {}
    if field_defs:
        size = args.field_scale * h
        for i, fd in enumerate(meta["fields"]):
            if fd["key"] not in args.field_set:
                continue
            fm = field_material(f"TW_field_{fd['key']}", fd["color"], args.field_opacity)
            try:
                field_trees[fd["key"]] = make_sphere_geonodes(f"TW_FieldSpheres_{fd['key']}", "r", fm, subdiv=1)
            except Exception as exc:  # pragma: no cover
                log(f"WARNING field haze Geometry Nodes setup failed ({exc}); {fd['key']} is not drawn")
                continue
            # the web renderer gives each field its own jittered, clamped cloud so two hazes
            # interleave instead of coinciding (src/render.js _buildFields)
            field_pos[fd["key"]] = jitter_points(N, layout.centers, (args.seed ^ 0x1b873593) + 7919 * i, 0.5 * size, L)
    cells_mode = args.cells_mode
    cell_tree = None
    max_cells = max(fr["n_cells"] for fr in frames)
    if cells_mode == "auto":
        cells_mode = "geonodes"
    if cells_mode == "geonodes":
        try:
            cell_tree = make_cell_geonodes(cell_mat)
        except Exception as exc:  # pragma: no cover
            if args.cells_mode == "geonodes":
                raise
            cells_mode = "objects" if max_cells <= 200 else "baked"
            log(f"WARNING cell Geometry Nodes setup failed ({exc}); falling back to {cells_mode}")
    if cells_mode == "objects" and max_cells > 200:
        log(f"cells-mode objects asked for {max_cells} cells (>200); using one baked mesh instead")
        cells_mode = "baked"
    if cells_mode == "objects":
        cell_obj_mat = object_colour_material("TW_cell_object", args.emission * 0.8)
    need_ico = cells_mode in ("objects", "baked") or gel_mode == "baked"
    ico_verts, ico_faces = icosphere_pydata(2) if need_ico else (None, None)
    log(f"species: " + ", ".join(f"{s['key']}[{s['kind']}]" for s in meta["species"]) +
        f"; cell types: {', '.join(t['key'] for t in meta['cellTypes'])}")
    log(f"tube path: {fiber_mode}; cell path: {cells_mode}; gel path: {gel_mode}; "
        f"layers: {','.join(l for l in LAYERS if l in layers)}"
        + (f"; fields: {','.join(field_trees)}" if field_trees else "; fields: none")
        + f"; frames to build: {len(frame_ids)} (hold {hold})")

    def tubes_object(name, fcol, verts, edges, attrs, radius_attr, mult, exponent, tree, material):
        if tree is not None:
            ob = new_mesh_object(name, verts, edges, [], fcol, attrs=attrs)
            mod = ob.modifiers.new("Tubes", "NODES")
            mod.node_group = tree
        else:
            radii = [mult * (max(v, 0.0) ** exponent) for v in attrs[radius_attr][1]]
            tv, tf, tattrs = tube_mesh_from_segments(verts, edges, radii, attrs)
            ob = new_mesh_object(name, tv, [], tf, fcol, attrs=tattrs, smooth=True)
            ob.data.materials.append(material)
        return ob

    # ---- per-frame objects
    per_frame_objs = []
    counts = {"fibers": 0, "struts": 0, "gel": 0, "fields": 0}
    for i in frame_ids:
        fr = frames[i]
        fcol = make_collection(f"TW_frame_{i:03d}", root)
        objs = []
        n_fib = n_str = n_gel = n_fld = 0
        if draw_fibers:
            verts, edges, attrs = fiber_segments(fr, meta, layout, args.rho_min)
            n_fib = len(edges)
            if edges:
                objs.append(tubes_object(f"TW_fibers_{i:03d}", fcol, verts, edges, attrs, "rad",
                                         1.0, 1.0, fiber_tree, fiber_mat))
        if draw_scaffold:
            sv, se, s_d, s_col = scaffold_struts(fr, meta, layout, args.scaffold_min)
            n_str = len(se)
            if se:
                attrs = {"dens": ("FLOAT", s_d), "col": ("FLOAT_COLOR", s_col)}
                objs.append(tubes_object(f"TW_scaffold_{i:03d}", fcol, sv, se, attrs, "dens",
                                         0.08 * h * args.strut_radius, 1.0, strut_tree, scaffold_mat))
        if draw_gel and gel_mode == "volume":
            for s in gel_defs:
                gp, g_d, n_on = gel_species_points(fr, s["key"], layout, args.gel_min)
                n_gel += n_on
                if n_on:
                    ob = new_mesh_object(f"TW_gel_{s['key']}_{i:03d}", gp, [], [], fcol,
                                         attrs={"dens": ("FLOAT", g_d)})
                    mod = ob.modifiers.new("GelVolume", "NODES")
                    mod.node_group = gel_trees[s["key"]]
                    haze_visibility(ob)
                    objs.append(ob)
        elif draw_gel:
            gp, gr, g_d, g_col = gel_points(fr, meta, layout, args.gel_min, args.gel_scale)
            n_gel = len(gp)
            if gp:
                if gel_mode == "spheres":
                    ob = new_mesh_object(f"TW_gel_{i:03d}", gp, [], [], fcol,
                                         attrs={"r": ("FLOAT", gr), "dens": ("FLOAT", g_d), "col": ("FLOAT_COLOR", g_col)})
                    mod = ob.modifiers.new("GelSpheres", "NODES")
                    mod.node_group = gel_tree
                else:
                    bv, bf, battrs = baked_spheres(ico_verts, ico_faces, gp, gr, None,
                                                   {"dens": ("FLOAT", g_d), "col": ("FLOAT_COLOR", g_col)})
                    ob = new_mesh_object(f"TW_gel_{i:03d}", bv, [], bf, fcol, attrs=battrs, smooth=True)
                    ob.data.materials.append(gel_mat)
                haze_visibility(ob)
                objs.append(ob)

        for key, tree in field_trees.items():
            fp, fr_rad, fv = field_points(fr, key, layout, field_pos[key], args.field_min,
                                          args.field_scale * h, args.field_scale_of.get(key, 1.0))
            n_fld += len(fp)
            if fp:
                ob = new_mesh_object(f"TW_field_{key}_{i:03d}", fp, [], [], fcol,
                                     attrs={"r": ("FLOAT", fr_rad), "val": ("FLOAT", fv)})
                mod = ob.modifiers.new("FieldSpheres", "NODES")
                mod.node_group = tree
                haze_visibility(ob)
                objs.append(ob)

        if draw_cells and fr["n_cells"]:
            pos, scale, rot, ccols = cell_transforms(fr, meta, L)
            if cells_mode == "geonodes":
                ob = new_mesh_object(f"TW_cells_{i:03d}", pos, [], [], fcol,
                                     attrs={"a": ("FLOAT", list(fr["ca"])), "b": ("FLOAT", list(fr["cb"])),
                                            "c": ("FLOAT", list(fr["cc"])),
                                            "col": ("FLOAT_COLOR", ccols), "scale": ("FLOAT_VECTOR", scale),
                                            "rot": ("FLOAT_VECTOR", rot)})
                mod = ob.modifiers.new("CellSpheres", "NODES")
                mod.node_group = cell_tree
                objs.append(ob)
            elif cells_mode == "baked":
                bv, bf, battrs = baked_spheres(ico_verts, ico_faces, pos, scale, rot,
                                               {"a": ("FLOAT", list(fr["ca"])), "col": ("FLOAT_COLOR", ccols)})
                ob = new_mesh_object(f"TW_cells_{i:03d}", bv, [], bf, fcol, attrs=battrs, smooth=True)
                ob.data.materials.append(cell_mat)
                objs.append(ob)
            else:  # objects
                shared = bpy.data.meshes.get("TW_icosphere")
                if shared is None:
                    shared = bpy.data.meshes.new("TW_icosphere")
                    shared.from_pydata(ico_verts, [], ico_faces)
                    shared.polygons.foreach_set("use_smooth", [True] * len(shared.polygons))
                    shared.update()
                    shared.materials.append(cell_obj_mat)
                for c in range(fr["n_cells"]):
                    cob = bpy.data.objects.new(f"TW_cell_{i:03d}_{c:04d}", shared)
                    cob.location = pos[c]
                    cob.rotation_euler = rot[c]
                    cob.scale = scale[c]
                    cob.color = ccols[c]
                    fcol.objects.link(cob)
                    objs.append(cob)

        if not args.no_label:
            objs.append(("caption", caption_text(fr, meta, list(field_trees)), f"TW_caption_{i:03d}", fcol))
        per_frame_objs.append((i, objs))
        counts["fibers"] += n_fib
        counts["struts"] += n_str
        counts["gel"] += n_gel
        counts["fields"] += n_fld
        log(f"frame {i:3d} (t={fr['t']:.1f} d): {n_fib} fibers, {n_str} struts, {n_gel} gel voxels, "
            + (f"{n_fld} field points, " if field_trees else "") + f"{fr['n_cells']} cells")

    # ---- static: wire cube, load arrows, camera, lights, world
    cube_v = [(x * L, y * L, z * L) for x in (0, 1) for y in (0, 1) for z in (0, 1)]
    cube_f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    wire = new_mesh_object("TW_domain", cube_v, [], cube_f, static)
    wmod = wire.modifiers.new("Wire", "WIREFRAME")
    wmod.thickness = 0.004 * L
    wmod.use_replace = True
    wire.data.materials.append(wire_mat)

    fit_pts = list(cube_v)
    if load >= 0.02:
        height, radius = L * (0.10 + 0.22 * load), L * (0.05 + 0.07 * load)
        for name, z0, up in (("TW_load_top", 1.03 * L, True), ("TW_load_bottom", -0.03 * L, False)):
            cv, cf = cone_pydata(radius, height, z0, up=up)
            cone = new_mesh_object(name, cv, [], cf, static, smooth=True)
            cone.data.materials.append(arrow_mat)
            fit_pts.append((0.5 * L, 0.5 * L, z0 + (height if up else -height)))   # keep the tip in frame
        log(f"load arrows from dial {load_key!r} = {load_raw:g} -> {load:.3f} of {fmt_range(meta)}")
    elif load_key:
        log(f"load dial {load_key!r} = {load_raw:g} normalises to {load:.3f} of {fmt_range(meta)}: no load arrows")
    else:
        log("no load dial in meta.dials (meta.loadDial / 'strain'): no load arrows")

    center = (0.5 * L, 0.5 * L, 0.5 * L)
    cam = bpy.data.cameras.new("TW_camera")
    cam.lens = 50.0
    cam.sensor_fit = "AUTO"
    cam.clip_start = 0.01
    cam.clip_end = 100.0
    cam_obj = bpy.data.objects.new("TW_camera", cam)
    static.objects.link(cam_obj)
    aspect = args.res_x / args.res_y
    # the web renderer's default framing direction, verbatim (src/render.js `_viewDir`): a 3/4
    # view from the front-right, 18.6 deg above the horizon, so a Blender still and a screenshot
    # of the app show the cube from the same side (docs/REVIEW.md E5)
    dv = math.sqrt(sum(c * c for c in VIEW_DIR)) or 1.0
    view_dir = tuple(c / dv for c in VIEW_DIR)
    dist, tan_h, tan_v = fit_camera(cam_obj, cam, center, fit_pts, aspect, view_dir, margin=0.86)
    scene.camera = cam_obj
    log(f"camera at distance {dist:.2f} L from the cube centre (3/4 view along "
        f"{view_dir[0]:.3f},{view_dir[1]:.3f},{view_dir[2]:.3f}, lens 50 mm)")

    pivot = bpy.data.objects.new("TW_pivot", None)
    pivot.empty_display_type = "PLAIN_AXES"
    pivot.empty_display_size = 0.2
    pivot.location = center
    static.objects.link(pivot)
    cam_obj.parent = pivot
    # keep the camera's world placement; pivot.matrix_world is stale before a depsgraph update
    cam_obj.matrix_parent_inverse = mathutils.Matrix.Translation(mathutils.Vector(center)).inverted()

    def add_light(name, kind, loc, energy, colour, **kw):
        li = bpy.data.lights.new(name, kind)
        li.energy = energy
        li.color = colour
        for k, v in kw.items():
            setattr(li, k, v)
        ob = bpy.data.objects.new(name, li)
        ob.location = (center[0] + loc[0] * L, center[1] + loc[1] * L, center[2] + loc[2] * L)
        look_at(ob, center)
        static.objects.link(ob)
        return ob

    add_light("TW_key", "AREA", (1.6, -1.9, 1.8), 110.0, (1.0, 0.96, 0.9), size=1.8 * L)
    add_light("TW_fill", "AREA", (-2.4, -0.8, 0.6), 30.0, (0.75, 0.85, 1.0), size=3.0 * L)
    add_light("TW_rim", "SUN", (-1.0, 1.6, 1.3), 0.8, (0.8, 0.9, 1.0), angle=math.radians(6))

    world = bpy.data.worlds.get("TW_world") or bpy.data.worlds.new("TW_world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = hex_to_linear(COL_BACKGROUND)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world

    # ---- labels (parented to the camera so they stay put during a turntable)
    if not args.no_label:
        depth = 1.6
        half_h = depth * tan_v
        half_w = depth * tan_h
        size = 0.07 * half_h
        dials = meta.get("dials", {})
        dial_txt = "   ".join(f"{k} {v:g}" if isinstance(v, (int, float)) else f"{k} {v}" for k, v in dials.items())
        tissue_name = meta.get("tissueName") or meta.get("tissue") or ""
        head = f"{tissue_name}   |   {meta.get('scenario', '')}" if tissue_name else str(meta.get("scenario", ""))
        title = f"{head}\n{dial_txt}".strip()
        texts = [add_text("TW_title", title, static, text_mat, size, cam_obj, (-half_w * 0.92, half_h * 0.90), depth,
                          align_y="TOP")]
        for i, objs in per_frame_objs:
            for k, item in enumerate(objs):
                if isinstance(item, tuple) and item[0] == "caption":
                    _, body, name, fcol = item
                    objs[k] = add_text(name, body, fcol, text_mat, size, cam_obj, (-half_w * 0.92, -half_h * 0.92), depth)
                    texts.append(objs[k])
        # shrink any line that would run past the right edge of the frame
        bpy.context.view_layer.update()
        avail = 2.0 * half_w * 0.92
        for tob in texts:
            w = tob.dimensions.x
            if w > avail > 0:
                tob.scale = (avail / w,) * 3

    # ---- timeline
    scene.frame_start = 1
    if args.all_frames:
        scene.frame_end = n_frames * hold
        for i, objs in per_frame_objs:
            set_visibility_keyframes(objs, frame_ids.index(i), len(frame_ids), hold)
        log(f"visibility keyframed: scene frames 1..{scene.frame_end} ({hold} per trajectory frame)")
    else:
        scene.frame_end = 1
    if args.turntable and scene.frame_end > scene.frame_start:
        pivot.rotation_euler = (0.0, 0.0, 0.0)
        pivot.keyframe_insert("rotation_euler", index=2, frame=scene.frame_start)
        pivot.rotation_euler = (0.0, 0.0, 2.0 * math.pi)
        pivot.keyframe_insert("rotation_euler", index=2, frame=scene.frame_end + 1)
        for fc in pivot.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        log("turntable: camera pivot rotates 360 deg over the frame range")
    elif args.turntable:
        log("turntable requested but the frame range is a single frame; nothing to orbit")

    shown = args.frame % n_frames
    scene.frame_set(1 + frame_ids.index(shown) * hold if shown in frame_ids else 1)
    log(f"built {sum(len(o) for _, o in per_frame_objs)} frame objects: {counts['fibers']} fiber segments, "
        f"{counts['struts']} struts, {counts['gel']} gel voxels"
        + (f", {counts['fields']} field points" if field_trees else "") + " total")
    return {"fiber_mode": fiber_mode, "cells_mode": cells_mode, "gel_mode": gel_mode, "shown_frame": shown}


# --------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------


def choose_engine(args, module_mode):
    scene = bpy.context.scene
    want_cycles = args.cycles
    if module_mode and not args.cycles and not args.eevee and not os.environ.get("DISPLAY"):
        log("running as the bpy module without a display: Eevee cannot create a GPU context here, using Cycles "
            "(pass --eevee to insist)")
        want_cycles = True
    if want_cycles:
        scene.render.engine = "CYCLES"
        cy = scene.cycles
        cy.samples = args.samples or 64
        cy.use_adaptive_sampling = True
        cy.use_denoising = True
        try:
            cy.denoiser = "OPENIMAGEDENOISE"
        except TypeError:
            pass
        cy.max_bounces = 6
        cy.transparent_max_bounces = 48   # a view ray crosses up to ~N gel spheres + struts
        cy.volume_step_rate = args.gel_step_rate
        cy.volume_preview_step_rate = args.gel_step_rate
        cy.caustics_reflective = False
        cy.caustics_refractive = False
        scene.render.use_persistent_data = True
        return f"Cycles ({cy.samples} samples, device {cy.device})"
    for ident in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = ident
            break
        except TypeError:
            continue
    scene.eevee.taa_render_samples = args.samples or 32
    if hasattr(scene.eevee, "use_shadows"):
        scene.eevee.use_shadows = True
    return f"{scene.render.engine} ({scene.eevee.taa_render_samples} samples)"


def setup_render(args, module_mode):
    scene = bpy.context.scene
    scene.render.resolution_x = args.res_x
    scene.render.resolution_y = args.res_y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.fps = 24
    # The tissue colours are sRGB hex values and the definition hex is the truth (docs/REVIEW.md
    # E4), so the default view transform here is the plain sRGB "Standard" one: an unlit surface
    # of colour #rrggbb comes out as #rrggbb. The web view differs — three.js tone-maps the whole
    # frame with ACES — so highlights in the browser are softer and less saturated than here.
    # --view-transform AgX (or Filmic) buys that roll-off back at the cost of the literal hex.
    want = args.view_transform
    try:
        scene.view_settings.view_transform = want
        scene.view_settings.look = "None"
    except TypeError:
        log(f"WARNING view transform {want!r} is not available in this Blender; leaving "
            f"{scene.view_settings.view_transform!r}")
    return choose_engine(args, module_mode)


def render_still(path):
    scene = bpy.context.scene
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    scene.render.filepath = path
    t = time.time()
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as exc:
        if scene.render.engine != "CYCLES":
            log(f"WARNING Eevee render failed ({exc}); retrying with Cycles")
            scene.render.engine = "CYCLES"
            scene.cycles.samples = 64
            bpy.ops.render.render(write_still=True)
        else:
            raise
    log(f"wrote {path} ({time.time() - t:.1f} s, {scene.render.engine})")


def render_animation(prefix):
    scene = bpy.context.scene
    prefix = os.path.abspath(prefix)
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)
    scene.render.filepath = prefix
    t = time.time()
    bpy.ops.render.render(animation=True)
    log(f"wrote animation frames {prefix}#### ({scene.frame_end - scene.frame_start + 1} frames, {time.time() - t:.1f} s)")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def default_input():
    env = os.environ.get("TISSUE_JSON")
    if env:
        return env
    here = None
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:  # Blender text editor
        try:
            here = os.path.dirname(bpy.context.space_data.text.filepath)
        except Exception:
            here = os.getcwd()
    return os.path.join(here, "sample_trajectory.json")


def resolve_recipe(meta, args):
    """Fill the fiber-layout options the CLI left at their "ask the file" default (E2): the seed
    and the radius scale come from `meta.render` (what the web renderer actually used) when the
    export carries it, and from the RECIPE_FIBER constants otherwise. An explicit flag wins."""
    recipe = recipe_from_meta(meta)
    src = "meta.render" if isinstance(meta.get("render"), dict) else "built-in recipe"
    if args.seed is None:
        args.seed = recipe["seed"]
    else:
        recipe["seed"] = args.seed
    if args.fiber_radius is not None:
        recipe["radiusScale"] = args.fiber_radius
    args.fiber_radius = recipe["radiusScale"]
    if args.rho_min is None:
        args.rho_min = recipe["minDensity"]
    args.recipe = recipe
    if recipe["K"] != meta["K"]:
        # meta.K is what the frames were written for; meta.render.K is what the renderer drew.
        # They can only differ if the app was run with a non-default renderer K.
        log(f"WARNING meta.render.K is {recipe['K']} but meta.K is {meta['K']}; laying out {meta['K']} rods per voxel")
    log(f"fiber recipe from {src}: seed {recipe['seed']}, K {meta['K']}, radiusScale {recipe['radiusScale']:g}, "
        f"lengthScale {recipe['lengthScale']:g}, minDensity {recipe['minDensity']:g} (ramp {recipe['minDensityRamp']:g})")
    return recipe


def resolve_fields(meta, frames, args):
    """Turn --fields into the set of field keys to draw and apply --field-norm.

    Fields are OFF by default, like the web view. `--fields all` takes every field the file
    carries; unknown names are an error rather than a silent no-op. With `--field-norm max`
    each field gets a scale factor 1/max so a field that never reaches 1 (oxygen at a 24 %
    medium tension, say) still fills the haze's range; the default 'clamp' matches the web.
    The maximum is taken over EVERY frame in the file, not just the ones being built, so
    --frame 3 and --all-frames give the same voxel the same colour.
    """
    have = [f["key"] for f in meta["fields"]]
    want = [s.strip() for s in (args.fields or "").split(",") if s.strip()]
    if want and want != ["none"]:
        if want == ["all"]:
            keys = list(have)
            if not keys:
                log("WARNING --fields all: this trajectory carries no field grids (older export, or format 1)")
        else:
            unknown = [k for k in want if k not in have]
            if unknown:
                raise SystemExit(f"--fields: unknown {sorted(unknown)}; this file has "
                                 + (", ".join(have) if have else "no fields at all (older export, or format 1)"))
            keys = [k for k in have if k in want]
    else:
        keys = []
    args.field_set = keys
    args.field_scale_of = {}
    for k in have:
        hi = 0.0
        for fr in frames:
            arr = fr["fields"].get(k) or []
            for v in arr:
                if v > hi:
                    hi = v
        args.field_scale_of[k] = (1.0 / hi if hi > 0 else 1.0) if args.field_norm == "max" else 1.0
        if k in keys:
            log(f"field {k}: max {hi:.4f} over {len(frames)} frame(s), draw scale {args.field_scale_of[k]:.3g} "
                f"({args.field_norm})")
    return keys


def dry_run(meta, frames, args):
    N, K, L = meta["N"], meta["K"], meta["L"]
    layout = FiberLayout(N, K, L, args.seed, args.recipe)
    layers = args.layer_set
    print(f"{SCRIPT_TAG} dry run: format {meta['format']}, tissue {(meta.get('tissue') or '?')!r}"
          + (f" ({meta['tissueName']})" if meta.get("tissueName") else "") + ", "
          f"N={N} (h={layout.h:.4f}) K={K} L={L} frames={len(frames)} scenario={meta.get('scenario')!r} dials={meta.get('dials')}")
    print(f"  species: " + ", ".join(f"{s['key']} [{s['kind']} {s['color']}]" for s in meta["species"]) +
          "; cell types: " + ", ".join(f"{t['key']} (colours {t['colors'][0]}->{t['colors'][1]} by a, shape by {t['shape']['by']}, r {t['radius']:g})"
                                       for t in meta["cellTypes"]))
    if meta["fields"]:
        drawn = ", ".join(f"{f['key']} [{f['color']}]" + ("" if f["key"] in args.field_set else " (off)") for f in meta["fields"])
        print(f"  fields: {drawn}"
              + ("" if args.field_set else "   (--fields <keys> or --fields all draws them; off by default, as in the web view)"))
    else:
        print("  fields: none in this trajectory")
    # a=0.5 of each cell ramp: the number blender/test_recipe_parity.py checks against src/render.js
    print("  cell ramp (OKLab" + (f", mid {CELL_RAMP_MID}" if hex_ok(CELL_RAMP_MID) else f", lift {CELL_RAMP_LIFT:g}") + "): "
          + ", ".join(f"{t['key']} a=0.5 -> {linear_to_hex(ramp_sample(cell_ramp(meta, t), 0.5))}" for t in meta["cellTypes"]))
    load_key, load_raw, load = load_dial(meta)
    tot = {"fibers": 0, "struts": 0, "gel": 0, "fields": 0}
    last = None
    for i, fr in enumerate(frames):
        n_fib = len(fiber_segments(fr, meta, layout, args.rho_min)[1]) if "fibers" in layers and meta["kinds"]["fiber"] else 0
        n_str = len(scaffold_struts(fr, meta, layout, args.scaffold_min)[1]) if "scaffold" in layers and meta["kinds"]["scaffold"] else 0
        n_gel = len(gel_points(fr, meta, layout, args.gel_min, args.gel_scale)[0]) if "gel" in layers and meta["kinds"]["gel"] else 0
        n_fld = 0
        for key in args.field_set:
            arr = fr["fields"].get(key) or []
            n_fld += sum(1 for v in arr if clamp(v * args.field_scale_of.get(key, 1.0), 0.0, 1.0) >= args.field_min)
        st = frame_stats(fr, meta)
        last = (n_fib, n_str, n_gel, n_fld)
        tot["fibers"] += n_fib
        tot["struts"] += n_str
        tot["gel"] += n_gel
        tot["fields"] += n_fld
        sp = "  ".join(f"{k}={v:.3f}" for k, v in st["species"].items())
        fl = "  ".join(f"{k}={v:.3f}" for k, v in st["fields"].items())
        print(f"  frame {i:3d} t={fr['t']:6.1f} d  fibers={n_fib:6d} (of {N**3*K})  struts={n_str:5d}  gel={n_gel:4d}  "
              + (f"field pts={n_fld:5d}  " if args.field_set else "")
              + f"cells={fr['n_cells']:4d}  |  {sp}  fa={st['fa']:.3f}  a={st['a']:.3f}" + (f"  b={st['b']:.3f}" if meta.get("uses_b") else "")
              + (f"  c={st['c']:.3f}" if meta.get("uses_c") else "") + (f"  |  {fl}" if fl else ""))
    n_build = len(frames) if args.all_frames else 1
    per_frame = [name for name, on in (("fiber", "fibers" in layers and meta["kinds"]["fiber"]),
                                       ("scaffold", "scaffold" in layers and meta["kinds"]["scaffold"]),
                                       ("gel", "gel" in layers and meta["kinds"]["gel"]),
                                       ("field", bool(args.field_set)),
                                       ("cell", "cells" in layers)) if on]
    src = tot if args.all_frames else dict(zip(("fibers", "struts", "gel", "fields"), last))
    seg = f"{src['fibers']} fiber segments, {src['struts']} struts, {src['gel']} gel voxels"
    if args.field_set:
        seg += f", {src['fields']} field points"
    print(f"{SCRIPT_TAG} would build {n_build} frame(s) x ({', '.join(per_frame)}) object(s)"
          f"{'' if args.no_label else ' + caption'}; {seg}; plus wire cube, "
          + (f"2 load arrows ({load_key} {load_raw:g} -> {load:.2f} of {fmt_range(meta)}), " if load >= 0.02 else "no load arrows, ")
          + "camera, 3 lights")


def main():
    args = parse_args(script_argv())
    try:
        w, hgt = args.res.lower().split("x")
        args.res_x, args.res_y = int(w), int(hgt)
    except ValueError:
        raise SystemExit(f"--res expects WxH, got {args.res!r}")
    args.layer_set = {l.strip() for l in args.layers.split(",") if l.strip()}
    bad = args.layer_set - set(LAYERS)
    if bad:
        raise SystemExit(f"--layers: unknown {sorted(bad)}; choose from {','.join(LAYERS)}"
                         + ("; diffusible fields are drawn with --fields, not --layers" if "fields" in bad else ""))
    if args.dens_min is not None:
        args.gel_min = args.scaffold_min = args.dens_min
    if not args.input:
        args.input = default_input()
    if not os.path.exists(args.input):
        raise SystemExit(f"input not found: {args.input} (generate one with blender/make_sample_trajectory.py)")
    log(f"loading {args.input}")
    meta, frames = load_trajectory(args.input)
    resolve_recipe(meta, args)
    resolve_fields(meta, frames, args)
    log(f"format {meta['format']}, {len(frames)} frames, N={meta['N']}, K={meta['K']}, cells={frames[0]['n_cells']}, "
        f"species={[s['key'] for s in meta['species']]}, "
        + (f"fields={[f['key'] for f in meta['fields']]}, " if meta["fields"] else "")
        + f"scenario={meta.get('scenario')!r}")
    if args.dry_run or not HAVE_BPY:
        if not HAVE_BPY and not args.dry_run:
            log("bpy is not importable here: running the dry run only (use Blender or `pip install bpy`)")
        dry_run(meta, frames, args)
        return

    module_mode = not bpy.app.binary_path  # pip 'bpy' wheel
    gui_mode = not bpy.app.background
    if gui_mode and not script_argv():
        args.all_frames = True
        args.hold = max(args.hold, 6)
    if not args.all_frames and args.animation:
        log("--animation implies --all-frames")
        args.all_frames = True

    if gui_mode or args.keep_scene:
        remove_previous("TissueWeather")
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    mode = "GUI" if gui_mode else ("bpy module" if module_mode else "Blender background")
    log(f"Blender {bpy.app.version_string} [{mode}]")

    info = build_scene(meta, frames, args, module_mode)
    engine = setup_render(args, module_mode)
    log(f"render engine: {engine}, {args.res_x}x{args.res_y}")

    if args.save:
        path = os.path.abspath(args.save)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=path)
        log(f"saved {path}")
    if args.out and not gui_mode:
        render_still(args.out)
        if args.animation:
            stem, _ = os.path.splitext(os.path.abspath(args.out))
            render_animation(stem + "_")
    elif args.out:
        log("GUI run: scene built; press F12 to render (skipping automatic render)")
    log(f"done: tubes via {info['fiber_mode']}, cells via {info['cells_mode']}, gel via {info['gel_mode']}, "
        f"showing trajectory frame {info['shown_frame']}")


if __name__ == "__main__":
    main()
