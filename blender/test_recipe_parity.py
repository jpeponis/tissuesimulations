#!/usr/bin/env python3
"""
test_recipe_parity.py -- does the Blender importer draw what the browser draws?

    python3 blender/test_recipe_parity.py [-v]

`blender/import_tissue.py` re-implements, in python, arithmetic that the web renderer owns:

  * the fiber layout and the per-frame fiber laws          src/recipe.js       (docs/REVIEW.md E2)
  * the cell colour ramp (OKLab, mid colour, LUT)          src/render.js       (docs/REVIEW.md E3)
  * the cell aspect law and the load-arrow normalisation   src/render.js       (docs/REVIEW.md E5)
  * the gel / scaffold / field haze constants and laws     src/render.js       (docs/REVIEW.md E5)

Two implementations of one recipe drift. This runs `node blender/recipe_dump.mjs`, which prints
what the REAL JS modules compute, and compares it against what this file's python computes:

  constants   RECIPE_FIBER, and the round trip through a `meta.render` block       <= 1e-9
  layout      N=2, K=1, seed 90210: rod offsets, random unit vectors and length/radius
              jitters, element by element                                        <= 1e-6
  laws        radius / length / fade over a grid of densities and anisotropies    <= 1e-6
  direction   d = normalize(sign(f.r)*FA*f + (1-FA)*r) over a spread of inputs    <= 1e-6
  one frame   a synthetic N^3 state through fiber_segments(): both endpoints and
              the radius of every rod, so a law used right on its own but composed
              wrong (half length as full, jitters swapped) still fails            <= 1e-6
  ramp        every entry of every cell type's colour LUT, and the sampled colours <= 1e-6, and
              at a = 0, 0.25, 0.5, 0.75, 1 -- the criterion E3 spells out             1/255 per
                                                                                      channel
  aspect      cell_transforms()' semi-axes r*A^0.8 / r*A^-0.2, and radiusBy       <= 1e-9
  arrows      the load dial normalised over meta.loadRange, and the fallbacks     <= 1e-9
  haze        the gel / scaffold / field constants (read out of the renderer's own
              opts) and the CLI defaults that mirror them, the gel jitter stream
              element by element, and the radius / alpha / shortening those laws
              give scaffold_struts() and gel_points()                             <= 1e-6

It prints one PASS or FAIL line per section, then a PASS / FAIL summary. Exit 0 = parity holds
(or node is not installed: the check prints SKIP and passes, like the python-less skips on the
JS side), exit 1 = a mismatch, with the first dozen printed. Verified by mutation: changing
offsetSpan, radiusScale, the half-length, CELL_ASPECT_EXP, the mid colour, the arrow
normalisation, the scaffold radius floor or the gel size jitter each fails the section that owns
it. `tests/recipe.test.mjs` spawns this file with no arguments and asserts the exit code.
"""
import json
import math
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import import_tissue as IT  # noqa: E402

TOL = 1e-6          # E2: "agrees with src/recipe.js within 1e-6"
TOL_TIGHT = 1e-9
TOL_8BIT = 1.0 / 255.0

VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv


class Checker:
    """Counts every comparison and every failure; keeps only the first few failure MESSAGES so a
    wholesale mismatch does not print thousands of lines. `nfail` is the count that matters --
    capping the message list must never make a later section look like it passed."""

    def __init__(self):
        self.fails = []          # sampled messages
        self.nfail = 0           # real failure count
        self.checks = 0
        self.worst = {}

    def _fail(self, msg):
        self.nfail += 1
        if len(self.fails) < 12:
            self.fails.append(msg)
        elif len(self.fails) == 12:
            self.fails.append("...")

    def close(self, name, got, want, tol):
        self.checks += 1
        d = abs(got - want)
        if d > self.worst.get(name, (-1.0, None))[0]:
            self.worst[name] = (d, tol)
        if not (d <= tol) or got != got or want != want:
            self._fail(f"{name}: python {got!r} vs js {want!r} (delta {d:.3g} > {tol:g})")
            return False
        return True

    def equal(self, name, got, want):
        self.checks += 1
        if got != want:
            self._fail(f"{name}: python {got!r} vs js {want!r}")
            return False
        return True

    def seq(self, name, got, want, tol):
        if len(got) != len(want):
            self._fail(f"{name}: python has {len(got)} values, js has {len(want)}")
            return False
        ok = True
        for i, (g, w) in enumerate(zip(got, want)):
            ok = self.close(f"{name}[{i}]", g, w, tol) and ok
        return ok


def run_node():
    node = shutil.which("node")
    if not node:
        return None
    dump = os.path.join(HERE, "recipe_dump.mjs")
    if not os.path.exists(dump):
        raise SystemExit(f"missing {dump}")
    out = subprocess.run([node, dump, "--N", "2", "--K", "1"], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"node {dump} failed ({out.returncode}):\n{out.stderr.strip()}")
    return json.loads(out.stdout)


def check_recipe(ck, js):
    """The constants themselves: a retune of src/recipe.js must be copied over, not guessed."""
    for key, want in js["recipe"].items():
        got = IT.RECIPE_FIBER.get(key)
        if got is None:
            ck.checks += 1
            ck._fail(f"RECIPE_FIBER is missing {key!r} (src/recipe.js has {want!r})")
        else:
            ck.close(f"RECIPE_FIBER.{key}", float(got), float(want), TOL_TIGHT)
    # meta.render round trip: the recipe an export carries must rebuild the same constants
    meta = {"render": js["renderMeta"]}
    rebuilt, src = IT.recipe_from_meta(meta)
    for key, want in js["recipe"].items():
        ck.close(f"recipe_from_meta({key})", float(rebuilt[key]), float(want), TOL_TIGHT)
    ck.equal("recipe_from_meta reports meta.render as the source", src, "meta.render")
    # ... and a file without it falls back to the constants, and says so
    ck.equal("recipe_from_meta({}) == RECIPE_FIBER", IT.recipe_from_meta({}), (dict(IT.RECIPE_FIBER), "built-in recipe"))
    # a block this reader will not honour must not be announced as if it had been (E, finding 4)
    ck.equal("recipe_from_meta(bogus recipe name) falls back",
             IT.recipe_from_meta({"render": {"recipe": "fiber-v2", "seed": 1}}),
             (dict(IT.RECIPE_FIBER), "built-in recipe"))


def check_layout(ck, js):
    lay = js["layout"]
    L = IT.FiberLayout(lay["N"], lay["K"], 1.0, lay["seed"])
    n = lay["count"]
    ck.equal("layout: rod count", len(L.offsets), n)
    ck.close("layout: h", L.h, lay["h"], TOL_TIGHT)
    base, rvec, jit = lay["base"], lay["rvec"], lay["jit"]
    # the JS `base` is the voxel centre plus the offset; python keeps them apart
    got_base, got_rvec, got_jit = [], [], []
    for q in range(n):
        v = q // lay["K"]
        c, o = L.centers[v], L.offsets[q]
        got_base.extend(c[d] + o[d] for d in range(3))
        got_rvec.extend(L.rvec[q])
        got_jit.extend(L.jit[q])
    ck.seq("layout.base", got_base, base, TOL)
    ck.seq("layout.rvec", got_rvec, rvec, TOL)
    ck.seq("layout.jit", got_jit, jit, TOL)
    # every rod's random vector is a unit vector (a draw consumed out of order shows up here)
    for q in range(n):
        ck.close(f"|rvec[{q}]|", math.hypot(*L.rvec[q]), 1.0, 1e-12)


def check_laws(ck, js):
    sc = IT.fiber_scales(js["scales"]["h"], IT.RECIPE_FIBER)
    for key, want in js["scales"].items():
        ck.close(f"scales.{key}", float(sc[key]), float(want), TOL_TIGHT)
    for i, row in enumerate(js["laws"]):
        tag = f"rho={row['rho']:g} fa={row['fa']:g}"
        ck.close(f"fade({tag})", IT.fiber_fade(row["rho"], sc), row["fade"], TOL)
        ck.close(f"radius({tag})", IT.fiber_radius(row["rho"], sc), row["radius"], TOL)
        ck.close(f"length({tag})", IT.fiber_length(row["fa"], sc), row["length"], TOL)
    for row in js["dirs"]:
        u, r, a = row["u"], row["r"], row["a"]
        got = IT.fiber_dir(u[0], u[1], u[2], a, r[0], r[1], r[2])
        ck.seq(f"dir(u={u} r={r} a={a:g})", got, row["d"], TOL)


def check_frame(ck, js):
    """End to end: one synthetic frame through `fiber_segments()` must place every rod exactly
    where the renderer's own composition puts it. The laws above are checked separately; this
    catches the ways of getting them right individually and wrong together — a half length used
    as a full one, a jitter applied to the wrong quantity, rods emitted in the wrong order."""
    fdata, lay = js["frame"], js["layout"]
    N, K = lay["N"], lay["K"]
    layout = IT.FiberLayout(N, K, 1.0, lay["seed"])
    meta = {"kinds": {"fiber": [{"key": "s", "kind": "fiber", "color": "#ffffff"}], "gel": [], "scaffold": []},
            "species": [{"key": "s", "kind": "fiber", "color": "#ffffff"}]}
    fr = {"species": {"s": list(fdata["rho"])}, "fields": {}, "fiber": list(fdata["rho"]),
          "fa": list(fdata["fa"]), "f": list(fdata["f"])}
    verts, edges, attrs = IT.fiber_segments(fr, meta, layout)
    want = fdata["rods"]
    if not ck.equal("fiber_segments: rod count", len(edges), len(want)):
        return
    rad = attrs["rad"][1]
    for i, w in enumerate(want):
        i0, i1 = edges[i]
        ck.seq(f"rod[{i}] (voxel {w['v']}, q {w['q']}) start", verts[i0], w["p0"], TOL)
        ck.seq(f"rod[{i}] (voxel {w['v']}, q {w['q']}) end", verts[i1], w["p1"], TOL)
        ck.close(f"rod[{i}] radius", rad[i0], w["radius"], TOL)
        ck.close(f"rod[{i}] radius (other end)", rad[i1], w["radius"], TOL)


def check_ramps(ck, js):
    """E3: the a = 0.5 colour of every cell-type pair, to 1/255 per channel — and, tighter, the
    whole LUT, so a mid colour or a lift that moved anywhere in the ramp is caught."""
    cell = js["cell"]
    ck.equal("RENDER_LUT_N", IT.RENDER_LUT_N, cell["lutN"])
    ck.equal("cellRamp mode", IT.CELL_RAMP_MODE, cell["mode"])
    ck.close("cellMidLift", IT.CELL_RAMP_LIFT, cell["lift"], TOL_TIGHT)
    ck.equal("cellColorMid", (IT.CELL_RAMP_MID or "null"), cell["mid"])
    ck.close("cellSaturation", IT.CELL_SATURATION, cell["saturation"], TOL_TIGHT)
    ck.close("cellAspectExp", IT.CELL_ASPECT_EXP, cell["aspectExp"], TOL_TIGHT)
    for pair in js["ramps"]:
        # through the real normalisation: a reader that truncates `colors` to two entries loses
        # the third one's meaning (it is the ramp's MID, src/render.js setTissue) and this fails
        ct = IT.normalise_cell_types([{"key": pair["key"], "colors": list(pair["colors"]),
                                       "shape": {"by": "a"}, "radius": 0.03}])[0]
        ck.equal(f"ramp[{pair['key']}] colours kept", ct["colors"], list(pair["colors"]))
        lut = IT.cell_ramp({}, ct)
        if pair.get("mid"):
            # a piecewise ramp passes exactly through its mid at t = 0.5: the sharpest statement
            # of "which colour is the middle of this ramp" there is
            ck.seq(f"ramp[{pair['key']}] mid colour at a=0.5", IT.ramp_sample(lut, 0.5)[:3], pair["mid"], TOL)
        flat = [c for entry in lut for c in entry]
        # the JS LUT is a Float32Array, so allow float32 rounding on top of the 8-bit criterion
        ck.seq(f"ramp[{pair['key']}]", flat, pair["lut"], 1e-6)
        n = len(lut) - 1
        for t in (0.0, 0.25, 0.5, 0.75, 1.0):
            got = IT.ramp_sample(lut, t)
            x = t * n
            i0, w = int(x), x - int(x)
            i1 = min(i0 + 1, n)
            for k in range(3):
                want = pair["lut"][3 * i0 + k] + (pair["lut"][3 * i1 + k] - pair["lut"][3 * i0 + k]) * w
                # compare where it matters: after encoding to 8-bit sRGB
                ck.close(f"ramp[{pair['key']}] a={t:g} channel {k} (8-bit sRGB)",
                         IT.linear_to_srgb(got[k]), IT.linear_to_srgb(want), TOL_8BIT)
        if VERBOSE:
            print(f"    {pair['key']}: a=0.5 -> {IT.linear_to_hex(IT.ramp_sample(lut, 0.5))} "
                  f"({pair['colors'][0]} -> {pair['colors'][1]})")


def check_aspect(ck, js):
    """The semi-axes `cell_transforms()` actually writes, against the JS law. Driven through the
    real function (one cell, aspectMin = aspectMax = A, so `s` cannot matter) rather than by
    re-deriving the formula here -- a wrong CELL_ASPECT_EXP must fail, not cancel out."""
    for row in js["aspects"]:
        a, r = row["aspect"], row["radius"]
        meta = {"cellTypes": [{"key": "c", "colors": ["#4ea3ff", "#ff7a3d"],
                               "shape": {"by": "a", "aspectMin": a, "aspectMax": a},
                               "radius": r, "radiusBy": None}]}
        fr = {"cx": [0.5, 0.5, 0.5], "cp": [0.0, 0.0, 1.0], "ca": [0.5], "cb": [0.25],
              "ctype": [0], "n_cells": 1}
        _, scale, _, _ = IT.cell_transforms(fr, meta, 1.0)
        ck.close(f"cell long axis (A={a:g}, r={r:g})", scale[0][0], row["long"], TOL_TIGHT)
        ck.close(f"cell short axis (A={a:g}, r={r:g})", scale[0][1], row["short"], TOL_TIGHT)
        ck.close(f"cell short axis 2 (A={a:g}, r={r:g})", scale[0][2], row["short"], TOL_TIGHT)
    # a state-dependent radius (meta.radiusBy) follows its state, as src/render.js does
    meta = {"cellTypes": [{"key": "c", "colors": ["#4ea3ff", "#ff7a3d"],
                           "shape": {"by": "a", "aspectMin": 1.0, "aspectMax": 1.0},
                           "radius": 0.032, "radiusBy": {"by": "a", "min": 0.032, "max": 0.0416}}]}
    for a_state, want_r in ((0.0, 0.032), (0.5, 0.0368), (1.0, 0.0416)):
        fr = {"cx": [0.5, 0.5, 0.5], "cp": [0.0, 0.0, 1.0], "ca": [a_state], "cb": [0.0],
              "ctype": [0], "n_cells": 1}
        _, scale, _, _ = IT.cell_transforms(fr, meta, 1.0)
        ck.close(f"cell radius by state a={a_state:g}", scale[0][0], want_r, TOL_TIGHT)


def check_haze(ck, js):
    """E5: the gel, scaffold and field haze. The laws live in instance methods the dump cannot
    run (they need a WebGL context), so what crosses over is their CONSTANTS -- read out of the
    renderer's own `opts` block and its `_buildGel` source -- plus the gel jitter STREAM, which
    is `recipeRng` driven by the renderer's own seed arithmetic. The composition is then driven
    through the real `scaffold_struts()` / `gel_points()` and checked against those constants,
    so a law applied to the wrong quantity fails here even though every constant is right."""
    hz = js["haze"]
    d = IT.parse_args([])          # the CLI defaults are part of the contract, not decoration
    for name, got, want in (
        ("GEL_SIZE", IT.GEL_SIZE, hz["gelSize"]),
        ("GEL_OPACITY / --gel-opacity", d.gel_opacity, hz["gelOpacity"]),
        ("GEL_CELL_FADE", IT.GEL_CELL_FADE, hz["gelCellFade"]),
        ("GEL_JITTER_SPAN", IT.GEL_JITTER_SPAN, hz["gelJitterSpan"]),
        ("GEL_SIZE_JITTER[0]", IT.GEL_SIZE_JITTER[0], hz["gelSizeJitter"][0]),
        ("GEL_SIZE_JITTER[1]", IT.GEL_SIZE_JITTER[1], hz["gelSizeJitter"][1]),
        ("GEL_SEED_XOR", IT.GEL_SEED_XOR, hz["gelSeedXor"]),
        ("--gel-min", d.gel_min, hz["gelMin"]),
        ("SCAFFOLD_RADIUS", IT.SCAFFOLD_RADIUS, hz["scaffoldRadius"]),
        ("SCAFFOLD_MIN_RADIUS", IT.SCAFFOLD_MIN_RADIUS, hz["scaffoldMinRadius"]),
        ("SCAFFOLD_RADIUS_EXP", IT.SCAFFOLD_RADIUS_EXP, hz["scaffoldRadiusExp"]),
        ("SCAFFOLD_ALPHA_EXP", IT.SCAFFOLD_ALPHA_EXP, hz["scaffoldAlphaExp"]),
        ("SCAFFOLD_OPACITY / --scaffold-opacity", d.scaffold_opacity, hz["scaffoldOpacity"]),
        ("SCAFFOLD_BREAK", IT.SCAFFOLD_BREAK, hz["scaffoldBreak"]),
        ("--scaffold-min", d.scaffold_min, hz["scaffoldMin"]),
        ("FIELD_SEED_XOR", IT.FIELD_SEED_XOR, hz["fieldSeedXor"]),
        ("--field-scale (pointSize)", d.field_scale, hz["pointSize"]),
        ("--field-opacity (pointOpacity)", d.field_opacity, hz["pointOpacity"]),
        ("--field-min (pointMin)", d.field_min, hz["pointMin"]),
    ):
        ck.close(name, float(got), float(want), TOL_TIGHT)
    ck.equal("field cloud seed stride", 7919, int(hz["fieldSeedStride"]))

    # the gel jitter stream, draw by draw (three offsets and a size factor per voxel)
    lay = js["layout"]
    N, seed = lay["N"], lay["seed"]
    got = [x for j in IT.gel_jitter(N, seed ^ IT.GEL_SEED_XOR) for x in j]
    ck.seq("gel_jitter stream", got, js["gelJit"], TOL)

    # --- the composition, through the real functions ------------------------------------------
    h, L = 1.0 / N, 1.0
    layout = IT.FiberLayout(N, 1, L, seed)
    dens = [0.0, 0.01, 0.05, 0.2, 0.35, 0.5, 0.9, 1.6][:N ** 3]
    sp = {"key": "s", "kind": "scaffold", "color": "#9ec5d8"}
    gp = {"key": "g", "kind": "gel", "color": "#7fe0c9"}
    meta = {"kinds": {"fiber": [], "gel": [gp], "scaffold": [sp]}, "species": [sp, gp]}
    fr = {"species": {"s": list(dens), "g": list(dens)}, "scaffold": list(dens), "gel": list(dens),
          "cx": [0.25, 0.25, 0.25], "n_cells": 1}
    r_mul, r_min = hz["scaffoldRadius"] * h, hz["scaffoldMinRadius"] * h
    verts, edges, a_d, _a_col, a_rad = IT.scaffold_struts(fr, meta, layout, hz["scaffoldMin"])
    ck.equal("scaffold: a strut carries one density", [a_d[2 * i] == a_d[2 * i + 1] for i in range(len(edges))],
             [True] * len(edges))
    for i, (i0, i1) in enumerate(edges):
        dd = min(1.0, a_d[2 * i])
        ck.close(f"strut[{i}] radius (d={dd:g})", a_rad[2 * i],
                 max(r_min, r_mul * dd ** hz["scaffoldRadiusExp"]), TOL)
        # the shortening is about the midpoint, so the drawn length is `f` x h or x h/2
        f = (0.3 + 0.7 * dd / hz["scaffoldBreak"]) if dd < hz["scaffoldBreak"] else 1.0
        span = math.dist(verts[i0], verts[i1]) / f
        ck.close(f"strut[{i}] length / shortening (d={dd:g})", min(abs(span - h), abs(span - 0.5 * h)), 0.0, TOL)
    ck.equal("scaffold: struts below scaffoldMin are dropped", len(edges),
             sum(1 for i in range(len(edges)) if a_d[2 * i] >= hz["scaffoldMin"]))

    jit = IT.gel_jitter(N, seed ^ IT.GEL_SEED_XOR)
    occ = IT.cell_occupancy(fr, N, L)
    ck.equal("cell_occupancy: the voxel holding the cell", occ, [1 if v == 0 else 0 for v in range(N ** 3)])
    pos, rad, _a_dens, alpha, _cols = IT.gel_points(fr, meta, layout, hz["gelMin"], 1.0, jit, occ)
    kept = [v for v in range(N ** 3) if dens[v] >= hz["gelMin"]]
    ck.equal("gel: voxels above gelMin", len(pos), len(kept))
    for i, v in enumerate(kept):
        dv = dens[v]
        ck.close(f"gel[{v}] radius", rad[i],
                 hz["gelSize"] * h * min(dv, 1.5) ** (1.0 / 3.0) * jit[v][3], TOL)
        ck.close(f"gel[{v}] alpha", alpha[i],
                 min(dv, 1.0) * ((1.0 - hz["gelCellFade"]) if occ[v] else 1.0), TOL)
        lo = min(rad[i], 0.5 * L)
        for k in range(3):
            want = min(max(layout.centers[v][k] + jit[v][k] * h, lo), L - lo)
            ck.close(f"gel[{v}] centre[{k}] (jittered, clamped)", pos[i][k], want, TOL)


def check_load_arrows(ck):
    """E5: the load dial is normalised over meta.loadRange, so a 0-0.2 compression dial and a
    0-1 stretch dial draw the same range of arrows. No JS dump needed — src/render.js
    `_updateLoad` is s = clamp((v - min) / (max - min)) and that is the whole law."""
    cases = [
        ({"dials": {"strain": 0.6}, "loadDial": "strain", "loadRange": [0, 1]}, "strain", 0.6, 0.6),
        ({"dials": {"amp": 0.1}, "loadDial": "amp", "loadRange": [0, 0.2]}, "amp", 0.1, 0.5),
        ({"dials": {"amp": 0.2}, "loadDial": "amp", "loadRange": [0, 0.2]}, "amp", 0.2, 1.0),
        ({"dials": {"amp": 0.1}, "loadDial": "amp"}, "amp", 0.1, 0.1),          # no loadRange -> 0..1
        ({"dials": {"strain": 0.5}}, "strain", 0.5, 0.5),                        # legacy: guess 'strain'
        ({"dials": {"x": 0.5}}, None, 0.0, 0.0),                                 # no load dial at all
    ]
    for meta, key, raw, want in cases:
        gk, graw, gs = IT.load_dial(meta)
        ck.equal(f"load_dial key {meta.get('loadDial')}", gk, key)
        ck.close(f"load_dial raw {key}", graw, raw, TOL_TIGHT)
        ck.close(f"load_dial normalised {key} over {meta.get('loadRange')}", gs, want, TOL_TIGHT)


def main():
    js = run_node()
    if js is None:
        print("SKIP blender/test_recipe_parity.py: node is not installed "
              "(the JS half of the comparison cannot run)")
        return 0
    print(f"comparing blender/import_tissue.py against {js['source']}")
    ck = Checker()
    for name, fn in (("recipe constants", check_recipe), ("fiber layout (N=2, K=1)", check_layout),
                     ("fiber laws", check_laws), ("one frame of rods, end to end", check_frame),
                     ("cell colour ramp", check_ramps), ("cell aspect law", check_aspect),
                     ("gel / scaffold / field haze", check_haze)):
        before = ck.nfail
        fn(ck, js)
        print(f"  {'FAIL' if ck.nfail > before else 'PASS'}  {name}"
              + (f" ({ck.nfail - before} failed)" if ck.nfail > before else ""))
    before = ck.nfail
    check_load_arrows(ck)
    print(f"  {'FAIL' if ck.nfail > before else 'PASS'}  load arrow normalisation")
    if VERBOSE:
        for name, (d, tol) in sorted(ck.worst.items(), key=lambda kv: -kv[1][0])[:8]:
            print(f"    worst {name}: {d:.3g} (tolerance {tol:g})")
    if ck.nfail:
        print(f"\nFAIL: {ck.nfail} mismatch(es) out of {ck.checks} comparisons"
              + (f" (showing the first {len(ck.fails) - 1})" if ck.fails and ck.fails[-1] == "..." else "") + ":")
        for f in ck.fails:
            print(f"  {f}")
        return 1
    print(f"\nPASS: parity holds -- {ck.checks} comparisons, worst deviation "
          f"{max(d for d, _ in ck.worst.values()):.3g}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
