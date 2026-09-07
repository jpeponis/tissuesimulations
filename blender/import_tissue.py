#!/usr/bin/env python3
"""
import_tissue.py -- Tissue Weather trajectory (JSON, docs/SPEC.md section 1.10)
-> Blender 4.2 LTS scene: fibers as tubes, cells as oriented icospheres,
optional per-frame visibility animation, camera/lights/world, PNG render.

Headless (Blender binary):
  blender --background --python blender/import_tissue.py -- \
      --input blender/sample_trajectory.json --out /tmp/render.png [--frame 8] [--all-frames] [--cycles]

Headless (pip "bpy" module, Python 3.11):
  python3 blender/import_tissue.py --input blender/sample_trajectory.json --out /tmp/render.png
  (Eevee needs a GPU/display; without one the script switches to Cycles automatically.)

GUI: open Blender, Scripting workspace, open this file in the Text editor and Run Script.
  Without CLI arguments it loads $TISSUE_JSON or blender/sample_trajectory.json, builds
  every frame with visibility keyframes (scrub the timeline) and does not render.

No render / bpy needed for a sanity check of a JSON file:
  python3 blender/import_tissue.py --input traj.json --dry-run

Visual language (SPEC 1.9): K fiber segments per voxel with a fixed seeded jitter;
direction d = normalize(FA*f_signed + (1-FA)*r_j); length h*(0.5+0.9*FA);
radius 0.12*h*sqrt(rho); hidden when rho < 0.03; colour #cfe8ff (new) -> #e0a24a
(mature) by phiMat, times 0.6+0.4*rho. Cells: icosphere scaled
(rCell*(1+1.5a), rCell*(1-0.3a), rCell*(1-0.3a)) with +x aligned to polarity p,
colour #4ea3ff -> #ff7a3d by activation a.
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
    """Uniform [0,1) generator, bit-exact port of the JS mulberry32 in src/model.js."""
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


def hex_to_linear(hex_str, alpha=1.0):
    """'#rrggbb' (sRGB) -> linear RGBA tuple, as Blender node colours expect."""
    h = hex_str.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], alpha)


COL_FIBER_NEW = "#cfe8ff"
COL_FIBER_MATURE = "#e0a24a"
COL_CELL_QUIET = "#4ea3ff"
COL_CELL_ACTIVE = "#ff7a3d"
COL_BACKGROUND = "#0b0f14"
COL_WIRE = "#6b7785"
COL_TEXT = "#d8dee6"
COL_ARROW = "#ffb060"

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
    ap.add_argument("--input", help="trajectory JSON (SPEC 1.10). Default: $TISSUE_JSON or sample_trajectory.json next to this script")
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
    ap.add_argument("--seed", type=int, default=1234, help="PRNG seed for the fixed fiber jitter (default 1234)")
    ap.add_argument("--fiber-mode", choices=["auto", "geonodes", "mesh"], default="auto",
                    help="fiber tubes via Geometry Nodes (default) or pre-built hexagonal prisms")
    ap.add_argument("--cells-mode", choices=["auto", "geonodes", "objects", "baked"], default="auto",
                    help="cells via Geometry Nodes instancing (default), one object per cell (<=200), or one baked mesh")
    ap.add_argument("--fiber-radius", type=float, default=1.0, help="multiplier on the SPEC radius 0.12*h*sqrt(rho) (default 1)")
    ap.add_argument("--emission", type=float, default=0.12, help="emission strength added to fibers/cells for the glow look (default 0.12)")
    ap.add_argument("--rho-min", type=float, default=0.03, help="hide fibers below this density (default 0.03)")
    ap.add_argument("--save", help="save the built scene as this .blend")
    ap.add_argument("--dry-run", action="store_true", help="parse + validate the JSON and print counts; no Blender needed")
    ap.add_argument("--keep-scene", action="store_true", help="do not wipe the startup scene first (GUI runs never wipe)")
    return ap.parse_args(argv)


# --------------------------------------------------------------------------
# trajectory loading / validation
# --------------------------------------------------------------------------


def _flat(seq):
    if seq and isinstance(seq[0], (list, tuple)):
        return [float(v) for row in seq for v in row]
    return [float(v) for v in seq]


def load_trajectory(path):
    with open(path) as fh:
        data = json.load(fh)
    meta = dict(data.get("meta", {}))
    frames = data.get("frames")
    if not frames:
        raise SystemExit(f"{path}: no frames")
    first = frames[0]
    if "rho" not in first:
        raise SystemExit(f"{path}: frames[0] has no 'rho'")
    n_vox = len(first["rho"])
    N = int(meta.get("N") or round(n_vox ** (1.0 / 3.0)))
    if N ** 3 != n_vox:
        raise SystemExit(f"{path}: len(rho)={n_vox} is not N^3 for N={N}")
    meta["N"] = N
    meta["L"] = float(meta.get("L", 1.0))
    meta["K"] = int(meta.get("K", 3))
    meta.setdefault("dials", {})
    meta.setdefault("scenario", os.path.basename(path))

    out = []
    for i, fr in enumerate(frames):
        rho = _flat(fr["rho"])
        if len(rho) != n_vox:
            raise SystemExit(f"frame {i}: len(rho)={len(rho)} != {n_vox}")
        fa = _flat(fr.get("fa") or [0.0] * n_vox)
        f = _flat(fr.get("f") or [0.0, 0.0, 1.0] * n_vox)
        phi = _flat(fr.get("phiMat") or fr.get("phimat") or fr.get("phi_mat") or [0.0] * n_vox)
        for name, arr, want in (("fa", fa, n_vox), ("f", f, 3 * n_vox), ("phiMat", phi, n_vox)):
            if len(arr) != want:
                raise SystemExit(f"frame {i}: len({name})={len(arr)} != {want}")
        cells = fr.get("cells") or {}
        cx = _flat(cells.get("x") or [])
        cp = _flat(cells.get("p") or [1.0, 0.0, 0.0] * (len(cx) // 3))
        ca = _flat(cells.get("alpha") or [0.0] * (len(cx) // 3))
        n = len(cx) // 3
        if len(cp) != 3 * n or len(ca) != n:
            raise SystemExit(f"frame {i}: cells arrays inconsistent (x:{len(cx)} p:{len(cp)} alpha:{len(ca)})")
        out.append({"t": float(fr.get("t", i)), "rho": rho, "fa": fa, "f": f, "phi": phi,
                    "cx": cx, "cp": cp, "ca": ca, "n_cells": n})
    return meta, out


def frame_stats(fr):
    n = len(fr["rho"])
    mean = lambda xs: (sum(xs) / len(xs)) if xs else 0.0
    return {"rho": mean(fr["rho"]), "fa": mean(fr["fa"]), "phi": mean(fr["phi"]), "alpha": mean(fr["ca"]), "n_vox": n}


# --------------------------------------------------------------------------
# fiber recipe (SPEC 1.9), pure Python
# --------------------------------------------------------------------------


class FiberLayout:
    """Fixed per-instance jitter: offset inside the voxel and random unit vector r_j.
    Deterministic for (N, K, seed); identical for every frame so fibers do not jump."""

    def __init__(self, N, K, L, seed):
        self.N, self.K, self.L = N, K, L
        self.h = L / N
        rnd = mulberry32(seed)
        n = N * N * N
        self.centers = []
        for i in range(N):
            for j in range(N):
                for k in range(N):
                    self.centers.append(((i + 0.5) * self.h, (j + 0.5) * self.h, (k + 0.5) * self.h))
        self.offsets = []
        self.rvec = []
        for _ in range(n * K):
            self.offsets.append(((rnd() - 0.5) * 0.8 * self.h, (rnd() - 0.5) * 0.8 * self.h, (rnd() - 0.5) * 0.8 * self.h))
            self.rvec.append(random_unit(rnd))


def fiber_segments(fr, layout, rho_min):
    """Return (verts, edges, rho_per_vertex, phimat_per_vertex, fa_per_vertex) for one frame."""
    N, K, h = layout.N, layout.K, layout.h
    rho, fa, f, phi = fr["rho"], fr["fa"], fr["f"], fr["phi"]
    verts, edges, a_rho, a_phi, a_fa = [], [], [], [], []
    centers, offsets, rvec = layout.centers, layout.offsets, layout.rvec
    for v in range(N * N * N):
        r = rho[v]
        if not (r >= rho_min):  # also skips NaN
            continue
        A = clamp(fa[v], 0.0, 1.0)
        fx, fy, fz = f[3 * v], f[3 * v + 1], f[3 * v + 2]
        cx, cy, cz = centers[v]
        half = 0.5 * h * (0.5 + 0.9 * A)
        p = clamp(phi[v], 0.0, 1.0)
        base = v * K
        for j in range(K):
            ox, oy, oz = offsets[base + j]
            rx, ry, rz = rvec[base + j]
            s = 1.0 if (fx * rx + fy * ry + fz * rz) >= 0.0 else -1.0
            dx = A * fx * s + (1.0 - A) * rx
            dy = A * fy * s + (1.0 - A) * ry
            dz = A * fz * s + (1.0 - A) * rz
            nrm = math.sqrt(dx * dx + dy * dy + dz * dz)
            if nrm < 1e-9:
                dx, dy, dz = rx, ry, rz
            else:
                dx, dy, dz = dx / nrm, dy / nrm, dz / nrm
            mx, my, mz = cx + ox, cy + oy, cz + oz
            i0 = len(verts)
            verts.append((mx - dx * half, my - dy * half, mz - dz * half))
            verts.append((mx + dx * half, my + dy * half, mz + dz * half))
            edges.append((i0, i0 + 1))
            a_rho.extend((r, r))
            a_phi.extend((p, p))
            a_fa.extend((A, A))
    return verts, edges, a_rho, a_phi, a_fa


def tube_mesh_from_segments(verts, edges, a_rho, a_phi, h, radius_scale, sides=6):
    """Fallback for the Geometry Nodes path: hexagonal prisms built directly.
    Returns (tverts, tfaces, t_rho, t_phi) with per-vertex attributes."""
    tverts, tfaces, t_rho, t_phi = [], [], [], []
    ang = [2.0 * math.pi * s / sides for s in range(sides)]
    cs = [(math.cos(a), math.sin(a)) for a in ang]
    for (i0, i1) in edges:
        ax, ay, az = verts[i0]
        bx, by, bz = verts[i1]
        ux, uy, uz = bx - ax, by - ay, bz - az
        n = math.sqrt(ux * ux + uy * uy + uz * uz) or 1.0
        ux, uy, uz = ux / n, uy / n, uz / n
        # perpendicular frame
        if abs(uz) < 0.9:
            vx, vy, vz = -uy, ux, 0.0
        else:
            vx, vy, vz = 0.0, -uz, uy
        n = math.sqrt(vx * vx + vy * vy + vz * vz) or 1.0
        vx, vy, vz = vx / n, vy / n, vz / n
        wx, wy, wz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        r = 0.12 * h * math.sqrt(max(a_rho[i0], 0.0)) * radius_scale
        base = len(tverts)
        for (px, py, pz) in ((ax, ay, az), (bx, by, bz)):
            for c, s in cs:
                tverts.append((px + r * (c * vx + s * wx), py + r * (c * vy + s * wy), pz + r * (c * vz + s * wz)))
        t_rho.extend([a_rho[i0]] * (2 * sides))
        t_phi.extend([a_phi[i0]] * (2 * sides))
        for s in range(sides):
            s2 = (s + 1) % sides
            tfaces.append((base + s, base + s2, base + sides + s2, base + sides + s))
        tfaces.append(tuple(base + s for s in reversed(range(sides))))
        tfaces.append(tuple(base + sides + s for s in range(sides)))
    return tverts, tfaces, t_rho, t_phi


def cell_transforms(fr, L):
    """Per cell: position, scale triple and XYZ-euler rotating +x onto polarity p."""
    r_cell = 0.03 * L
    pos, scale, rot = [], [], []
    xs, ps, al = fr["cx"], fr["cp"], fr["ca"]
    for c in range(fr["n_cells"]):
        a = clamp(al[c], 0.0, 1.0)
        pos.append((xs[3 * c], xs[3 * c + 1], xs[3 * c + 2]))
        scale.append((r_cell * (1.0 + 1.5 * a), r_cell * (1.0 - 0.3 * a), r_cell * (1.0 - 0.3 * a)))
        p = mathutils.Vector((ps[3 * c], ps[3 * c + 1], ps[3 * c + 2]))
        if p.length < 1e-9:
            p = mathutils.Vector((1.0, 0.0, 0.0))
        q = mathutils.Vector((1.0, 0.0, 0.0)).rotation_difference(p.normalized())
        e = q.to_euler("XYZ")
        rot.append((e.x, e.y, e.z))
    return pos, scale, rot


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


def principled_material(name, roughness=0.45):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:  # 4.x name; keep highlights soft on thin tubes
        bsdf.inputs["Specular IOR Level"].default_value = 0.3
    return mat, nodes, links, bsdf


def attribute_mix_material(name, attr_name, col_a, col_b, emission, depth_attr=None, roughness=0.45):
    """Base colour = mix(col_a, col_b, attr) [* (0.6+0.4*depth_attr)], same colour emitted."""
    mat, nodes, links, bsdf = principled_material(name, roughness)
    at = nodes.new("ShaderNodeAttribute")
    at.attribute_name = attr_name
    at.attribute_type = "GEOMETRY"
    at.location = (-700, 200)
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MIX"
    mix.clamp_factor = True
    mix.location = (-450, 200)
    nsock(mix, "A", "in", "RGBA").default_value = hex_to_linear(col_a)
    nsock(mix, "B", "in", "RGBA").default_value = hex_to_linear(col_b)
    links.new(nsock(at, "Fac"), nsock(mix, "Factor", "in", "VALUE"))
    colour_out = nsock(mix, "Result", "out", "RGBA")
    if depth_attr:
        at2 = nodes.new("ShaderNodeAttribute")
        at2.attribute_name = depth_attr
        at2.attribute_type = "GEOMETRY"
        at2.location = (-700, -100)
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
        if hasattr(mat, "surface_render_method"):      # Blender 4.2+
            mat.surface_render_method = "BLENDED"
        else:                                          # older API
            mat.blend_method = "BLEND"
        mat.use_backface_culling = True
    return mat


def make_fiber_geonodes(h, radius_scale, material):
    """Mesh (edges) -> Mesh to Curve -> Set Curve Radius (0.12*h*sqrt(rho) from the
    named attribute 'rho') -> Curve to Mesh (6-vertex circle) -> Set Material."""
    tree = bpy.data.node_groups.new("TW_FiberTubes", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes, links = tree.nodes, tree.links
    n_in = nodes.new("NodeGroupInput"); n_in.location = (-900, 0)
    n_out = nodes.new("NodeGroupOutput"); n_out.location = (700, 0)
    m2c = nodes.new("GeometryNodeMeshToCurve"); m2c.location = (-650, 0)
    named = nodes.new("GeometryNodeInputNamedAttribute"); named.location = (-650, -250)
    named.data_type = "FLOAT"
    named.inputs["Name"].default_value = "rho"
    sqrt = nodes.new("ShaderNodeMath"); sqrt.operation = "SQRT"; sqrt.location = (-450, -250)
    mul = nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.location = (-250, -250)
    mul.inputs[1].default_value = 0.12 * h * radius_scale
    mul.label = "0.12 * h * scale"
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
    links.new(nsock(named, "Attribute"), sqrt.inputs[0])
    links.new(sqrt.outputs[0], mul.inputs[0])
    links.new(mul.outputs[0], set_r.inputs["Radius"])
    links.new(set_r.outputs["Curve"], c2m.inputs["Curve"])
    links.new(circle.outputs["Curve"], c2m.inputs["Profile Curve"])
    links.new(c2m.outputs["Mesh"], smooth.inputs["Geometry"])
    links.new(smooth.outputs["Geometry"], set_m.inputs["Geometry"])
    links.new(set_m.outputs["Geometry"], n_out.inputs[0])
    return tree


def make_cell_geonodes(material):
    """Points -> Instance on Points (icosphere; Scale <- 'scale', Rotation <- Euler('rot'))
    -> Realize Instances (so 'alpha' reaches the shader) -> smooth -> Set Material."""
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
    """Unit icosphere as (verts, faces) via bmesh (used by the non-GN cell modes)."""
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    verts = [tuple(v.co) for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


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


# --------------------------------------------------------------------------
# scene construction
# --------------------------------------------------------------------------


def build_scene(meta, frames, args, module_mode):
    scene = bpy.context.scene
    N, L, K = meta["N"], meta["L"], meta["K"]
    layout = FiberLayout(N, K, L, args.seed)
    h = layout.h
    n_frames = len(frames)
    if args.all_frames:
        frame_ids = list(range(n_frames))
    else:
        frame_ids = [args.frame % n_frames]
    hold = max(1, args.hold)

    root = make_collection("TissueWeather", scene.collection)
    static = make_collection("TW_static", root)

    # ---- materials
    fiber_mat = attribute_mix_material("TW_fiber", "phimat", COL_FIBER_NEW, COL_FIBER_MATURE, args.emission,
                                       depth_attr="rho", roughness=0.65)
    cell_mat = attribute_mix_material("TW_cell", "alpha", COL_CELL_QUIET, COL_CELL_ACTIVE, args.emission * 0.8,
                                      roughness=0.45)
    cell_obj_mat = None
    wire_mat = emissive_material("TW_wire", COL_WIRE, strength=0.8)
    text_mat = emissive_material("TW_text", COL_TEXT, strength=1.0, unlit=True)
    arrow_mat = emissive_material("TW_arrow", COL_ARROW, strength=0.4, alpha=0.35)

    # ---- fiber / cell pipelines (Geometry Nodes, with fallbacks)
    fiber_mode = args.fiber_mode
    fiber_tree = None
    if fiber_mode in ("auto", "geonodes"):
        try:
            fiber_tree = make_fiber_geonodes(h, args.fiber_radius, fiber_mat)
            fiber_mode = "geonodes"
        except Exception as exc:  # pragma: no cover - depends on Blender version
            if args.fiber_mode == "geonodes":
                raise
            log(f"WARNING fiber Geometry Nodes setup failed ({exc}); falling back to pre-built tubes")
            fiber_mode = "mesh"
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
    ico_verts, ico_faces = (icosphere_pydata(2) if cells_mode in ("objects", "baked") else (None, None))
    log(f"fiber path: {fiber_mode}; cell path: {cells_mode}; frames to build: {len(frame_ids)} (hold {hold})")

    # ---- per-frame objects
    per_frame_objs = []
    total_segments = 0
    for i in frame_ids:
        fr = frames[i]
        fcol = make_collection(f"TW_frame_{i:03d}", root)
        objs = []
        verts, edges, a_rho, a_phi, a_fa = fiber_segments(fr, layout, args.rho_min)
        total_segments += len(edges)
        if fiber_mode == "geonodes":
            ob = new_mesh_object(f"TW_fibers_{i:03d}", verts, edges, [], fcol,
                                 attrs={"rho": ("FLOAT", a_rho), "phimat": ("FLOAT", a_phi), "fa": ("FLOAT", a_fa)})
            mod = ob.modifiers.new("FiberTubes", "NODES")
            mod.node_group = fiber_tree
        else:
            tv, tf, t_rho, t_phi = tube_mesh_from_segments(verts, edges, a_rho, a_phi, h, args.fiber_radius)
            ob = new_mesh_object(f"TW_fibers_{i:03d}", tv, [], tf, fcol,
                                 attrs={"rho": ("FLOAT", t_rho), "phimat": ("FLOAT", t_phi)}, smooth=True)
            ob.data.materials.append(fiber_mat)
        objs.append(ob)

        if fr["n_cells"]:
            pos, scale, rot = cell_transforms(fr, L)
            if cells_mode == "geonodes":
                ob = new_mesh_object(f"TW_cells_{i:03d}", pos, [], [], fcol,
                                     attrs={"alpha": ("FLOAT", list(fr["ca"])), "scale": ("FLOAT_VECTOR", scale),
                                            "rot": ("FLOAT_VECTOR", rot)})
                mod = ob.modifiers.new("CellSpheres", "NODES")
                mod.node_group = cell_tree
                objs.append(ob)
            elif cells_mode == "baked":
                bv, bf, b_alpha = [], [], []
                for c in range(fr["n_cells"]):
                    m = mathutils.Matrix.LocRotScale(mathutils.Vector(pos[c]), mathutils.Euler(rot[c], "XYZ"),
                                                     mathutils.Vector(scale[c]))
                    base = len(bv)
                    bv.extend(tuple(m @ mathutils.Vector(v)) for v in ico_verts)
                    bf.extend(tuple(base + k for k in f) for f in ico_faces)
                    b_alpha.extend([fr["ca"][c]] * len(ico_verts))
                ob = new_mesh_object(f"TW_cells_{i:03d}", bv, [], bf, fcol, attrs={"alpha": ("FLOAT", b_alpha)}, smooth=True)
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
                ca, cb = hex_to_linear(COL_CELL_QUIET), hex_to_linear(COL_CELL_ACTIVE)
                for c in range(fr["n_cells"]):
                    cob = bpy.data.objects.new(f"TW_cell_{i:03d}_{c:04d}", shared)
                    cob.location = pos[c]
                    cob.rotation_euler = rot[c]
                    cob.scale = scale[c]
                    a = clamp(fr["ca"][c], 0.0, 1.0)
                    cob.color = tuple(ca[k] * (1 - a) + cb[k] * a for k in range(4))
                    fcol.objects.link(cob)
                    objs.append(cob)

        if not args.no_label:
            st = frame_stats(fr)
            caption = (f"day {fr['t']:.1f}   |   density {st['rho']:.2f}   alignment {st['fa']:.2f}   "
                       f"mature {st['phi']:.2f}   activation {st['alpha']:.2f}")
            objs.append(("caption", caption, f"TW_caption_{i:03d}", fcol))
        per_frame_objs.append((i, objs))
        log(f"frame {i:3d} (t={fr['t']:.1f} d): {len(edges)} fibers, {fr['n_cells']} cells")

    # ---- static: wire cube, load arrows, camera, lights, world
    cube_v = [(x * L, y * L, z * L) for x in (0, 1) for y in (0, 1) for z in (0, 1)]
    cube_f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    wire = new_mesh_object("TW_domain", cube_v, [], cube_f, static)
    wmod = wire.modifiers.new("Wire", "WIREFRAME")
    wmod.thickness = 0.004 * L
    wmod.use_replace = True
    wire.data.materials.append(wire_mat)

    strain = float(meta.get("dials", {}).get("strain", 0.0) or 0.0)
    if strain > 0.0:
        height, radius = L * (0.05 + 0.22 * strain), L * (0.05 + 0.07 * strain)
        for name, z0, up in (("TW_load_top", 1.03 * L, True), ("TW_load_bottom", -0.03 * L, False)):
            cv, cf = cone_pydata(radius, height, z0, up=up)
            cone = new_mesh_object(name, cv, [], cf, static, smooth=True)
            cone.data.materials.append(arrow_mat)

    center = (0.5 * L, 0.5 * L, 0.5 * L)
    cam = bpy.data.cameras.new("TW_camera")
    cam.lens = 50.0
    cam.sensor_fit = "AUTO"
    cam.clip_start = 0.01
    cam.clip_end = 100.0
    cam_obj = bpy.data.objects.new("TW_camera", cam)
    static.objects.link(cam_obj)
    aspect = args.res_x / args.res_y
    view_dir = (math.sin(math.radians(36)) * math.cos(math.radians(24)),
                -math.cos(math.radians(36)) * math.cos(math.radians(24)),
                math.sin(math.radians(24)))
    dist, tan_h, tan_v = fit_camera(cam_obj, cam, center, cube_v, aspect, view_dir, margin=0.86)
    scene.camera = cam_obj
    log(f"camera at distance {dist:.2f} L from the cube centre (3/4 view, lens 50 mm)")

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
        title = f"{meta.get('scenario', '')}\n{dial_txt}".strip()
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
    log(f"built {sum(len(o) for _, o in per_frame_objs)} frame objects, {total_segments} fiber segments total")
    return {"fiber_mode": fiber_mode, "cells_mode": cells_mode, "shown_frame": shown}


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
    # the SPEC colours are sRGB hex values -> use the plain sRGB view, not AgX/Filmic
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except TypeError:
        pass
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


def dry_run(meta, frames, args):
    N, K, L = meta["N"], meta["K"], meta["L"]
    layout = FiberLayout(N, K, L, args.seed)
    print(f"{SCRIPT_TAG} dry run: N={N} (h={layout.h:.4f}) K={K} L={L} frames={len(frames)} "
          f"scenario={meta.get('scenario')!r} dials={meta.get('dials')}")
    total = 0
    for i, fr in enumerate(frames):
        verts, edges, *_ = fiber_segments(fr, layout, args.rho_min)
        st = frame_stats(fr)
        total += len(edges)
        print(f"  frame {i:3d} t={fr['t']:6.1f} d  fibers={len(edges):6d} (of {N**3*K})  cells={fr['n_cells']:4d}  "
              f"mean rho={st['rho']:.3f} fa={st['fa']:.3f} phiMat={st['phi']:.3f} alpha={st['alpha']:.3f}")
    n_build = len(frames) if args.all_frames else 1
    print(f"{SCRIPT_TAG} would build {n_build} frame(s): {n_build} fiber object(s), {n_build} cell object(s)"
          f"{'' if args.no_label else f', {n_build} caption(s)'}; {total if args.all_frames else len(edges)} fiber segments; "
          f"plus wire cube, {'2 load arrows, ' if float(meta.get('dials', {}).get('strain', 0) or 0) > 0 else ''}"
          f"camera, 3 lights")


def main():
    args = parse_args(script_argv())
    try:
        w, hgt = args.res.lower().split("x")
        args.res_x, args.res_y = int(w), int(hgt)
    except ValueError:
        raise SystemExit(f"--res expects WxH, got {args.res!r}")
    if not args.input:
        args.input = default_input()
    if not os.path.exists(args.input):
        raise SystemExit(f"input not found: {args.input} (generate one with blender/make_sample_trajectory.py)")
    log(f"loading {args.input}")
    meta, frames = load_trajectory(args.input)
    log(f"{len(frames)} frames, N={meta['N']}, K={meta['K']}, cells={frames[0]['n_cells']}, scenario={meta.get('scenario')!r}")
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
    log(f"done: fibers via {info['fiber_mode']}, cells via {info['cells_mode']}, showing trajectory frame {info['shown_frame']}")


if __name__ == "__main__":
    main()
