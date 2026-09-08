#!/usr/bin/env python3
"""
make_sample_trajectory.py -- synthetic "Tissue Weather" trajectories in the
format-2 export (docs/EXTENDING.md section 5), for exercising
blender/import_tissue.py without a browser or node.

Pure Python (no numpy). Deterministic: uses the same mulberry32 PRNG family
as the engine, so a given --seed always yields the same file.

Two synthetic tissues:

  --tissue fibrous (default) imitates "Scaffold to tissue" (fibroblasts):
    * species new / mat (both kind fiber): total density rises from a sparse
      provisional scaffold (~0.15) toward dense tissue (~0.9), faster where
      cells are seeded and in the core; the mature fraction lags ~2 weeks;
    * fibers align to the load axis z (fa 0.08 -> ~0.75);
    * ~160 fibroblasts activate (a 0.05 -> ~0.85), elongate (shape by a) and
      polarise along z while doing a persistent random walk.

  --tissue cartilage imitates chondrocytes in a degrading hydrogel:
    * scaffold (kind scaffold, #9ec5d8) 1.0 -> 0.05 over 60 d, faster near cells;
    * gag (kind gel, #7fe0c9) 0 -> ~0.8, pericellular first;
    * col2 (kind fiber, #e8f1f8) 0 -> ~0.5, isotropic (fa stays < 0.2);
    * col1 (kind fiber, #e0a24a) 0 -> ~0.1, appearing late;
    * one cell type 'chondrocyte' (#7fd1ff -> #ff9a6b by a, shape by b,
      radius 0.035): 160 cells that barely move; a rises early, b late, c (a
      pericellular pool) fills by day 15 and is released by day 40.

Usage:
  python3 blender/make_sample_trajectory.py                     # -> blender/sample_synthetic_fibrous.json
  python3 blender/make_sample_trajectory.py --tissue cartilage  # -> blender/sample_synthetic_cartilage.json
  python3 blender/make_sample_trajectory.py --out X.json --frames 12 --days 60 --cells 160 --seed 7
Never overwrites an existing file unless --force is given.

NOTE (docs/REVIEW.md E6): the default output names are deliberately NOT the committed fixtures.
`blender/sample_trajectory.json` is a real engine export -- regenerate it with

    node tools/run_headless.mjs --tissue fibrous --only maturation --blender blender/sample_trajectory.json

-- and `blender/sample_trajectory_cartilage.json` is this generator's cartilage output, written
once with `--tissue cartilage --out blender/sample_trajectory_cartilage.json --force`. Neither
can be clobbered by running this script with no arguments any more.

What this generator CANNOT produce: diffusible fields (frames[i].fields / meta.fields, v0.4).
Use a real export if you want to exercise `import_tissue.py --fields`.
"""
import argparse
import json
import math
import os
import sys

MASK32 = 0xFFFFFFFF

TISSUES = {
    "fibrous": {
        "key": "fibrous",
        "name": "Fibrous connective tissue",
        "scenario": "Scaffold to tissue (maturation) -- synthetic sample",
        "species": [
            {"key": "new", "label": "Provisional matrix", "kind": "fiber", "color": "#cfe8ff"},
            {"key": "mat", "label": "Mature collagen I", "kind": "fiber", "color": "#e0a24a"},
        ],
        "cellTypes": [
            {"key": "fibroblast", "label": "Fibroblast -> myofibroblast", "colors": ["#4ea3ff", "#ff7a3d"],
             "shape": {"by": "a", "aspectMin": 1.0, "aspectMax": 2.5}, "radius": 0.03},
        ],
        "dials": {"Gext": 0.5, "strain": 0.6, "protease": 0.4},
        "loadDial": "strain",
        "loadRange": [0.0, 1.0],
        "default_out": "sample_synthetic_fibrous.json",
    },
    "cartilage": {
        "key": "cartilage",
        "name": "Articular cartilage in a hydrogel",
        "scenario": "Hydrogel to cartilage (chondrogenesis) -- synthetic sample",
        "species": [
            {"key": "scaffold", "label": "Hydrogel scaffold", "kind": "scaffold", "color": "#9ec5d8"},
            {"key": "gag", "label": "Proteoglycan (GAG)", "kind": "gel", "color": "#7fe0c9"},
            {"key": "col2", "label": "Collagen II", "kind": "fiber", "color": "#e8f1f8"},
            {"key": "col1", "label": "Collagen I", "kind": "fiber", "color": "#e0a24a"},
        ],
        "cellTypes": [
            {"key": "chondrocyte", "label": "Chondrocyte", "colors": ["#7fd1ff", "#ff9a6b"],
             "shape": {"by": "b", "aspectMin": 1.0, "aspectMax": 1.8}, "radius": 0.035},
        ],
        "dials": {"Gext": 0.5, "compression": 0.3, "protease": 0.2},
        "loadDial": "compression",
        "loadRange": [0.0, 0.5],
        "default_out": "sample_synthetic_cartilage.json",
    },
}


def mulberry32(seed):
    """Return a callable producing uniform floats in [0,1) -- port of the JS
    mulberry32 used by the engine (bit-exact for the same 32-bit seed)."""
    state = seed & MASK32

    def rnd():
        nonlocal state
        state = (state + 0x6D2B79F5) & MASK32
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & MASK32
        t = (((t + (((t ^ (t >> 7)) * (t | 61)) & MASK32)) & MASK32) ^ t) & MASK32
        return ((t ^ (t >> 14)) & MASK32) / 4294967296.0

    return rnd


def logistic(t, t50, width):
    return 1.0 / (1.0 + math.exp(-(t - t50) / width))


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def normalize(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n < 1e-12:
        return (0.0, 0.0, 1.0)
    return (v[0] / n, v[1] / n, v[2] / n)


def random_unit(rnd):
    z = 2.0 * rnd() - 1.0
    phi = 2.0 * math.pi * rnd()
    r = math.sqrt(max(0.0, 1.0 - z * z))
    return (r * math.cos(phi), r * math.sin(phi), z)


def smooth_noise(rnd, n_waves=4):
    """Return f(x,y,z) in [-1,1]: a sum of a few random plane waves (cheap,
    smooth, deterministic)."""
    waves = []
    for _ in range(n_waves):
        k = random_unit(rnd)
        freq = 1.0 + 2.0 * rnd()  # cycles per unit length
        phase = 2.0 * math.pi * rnd()
        waves.append((k[0] * freq, k[1] * freq, k[2] * freq, phase))

    def f(x, y, z):
        s = 0.0
        for kx, ky, kz, ph in waves:
            s += math.sin(2.0 * math.pi * (kx * x + ky * y + kz * z) + ph)
        return s / n_waves

    return f


def r3(v):
    return round(v, 3)


def r4(v):
    return round(v, 4)


# --------------------------------------------------------------------------
# shared spatial scaffolding
# --------------------------------------------------------------------------


def voxel_centers(N, h):
    return [((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h) for i in range(N) for j in range(N) for k in range(N)]


def cell_density_weight(centers, cell_x, sigma=0.12):
    """Per voxel: Gaussian-smoothed cell count, normalised to mean 1 (cells build the matrix)."""
    n_vox = len(centers)
    w_all = [0.0] * n_vox
    for v in range(n_vox):
        cx, cy, cz = centers[v]
        w = 0.0
        for x in cell_x:
            dx, dy, dz = x[0] - cx, x[1] - cy, x[2] - cz
            w += math.exp(-(dx * dx + dy * dy + dz * dz) / (2.0 * sigma * sigma))
        w_all[v] = w
    mean_w = sum(w_all) / n_vox
    return [w / max(mean_w, 1e-9) for w in w_all]


def core_weight(centers, L):
    out = []
    for cx, cy, cz in centers:
        r2 = ((cx - 0.5 * L) ** 2 + (cy - 0.5 * L) ** 2 + (cz - 0.5 * L) ** 2) / (0.75 * L * L)
        out.append(1.0 - 0.35 * r2)
    return out


def reflect_walls(x, L):
    for ax_i in range(3):
        if x[ax_i] < 0.03 * L:
            x[ax_i] = 0.06 * L - x[ax_i]
        if x[ax_i] > 0.97 * L:
            x[ax_i] = 1.94 * L - x[ax_i]
        x[ax_i] = clamp(x[ax_i], 0.03 * L, 0.97 * L)


# --------------------------------------------------------------------------
# fibrous connective tissue (the v0.1 sample, now as two fiber species)
# --------------------------------------------------------------------------


def generate_fibrous(N, frames, days, n_cells, seed, L):
    rnd = mulberry32(seed)
    h = L / N
    n_vox = N * N * N
    noise_rho = smooth_noise(rnd)
    noise_fa = smooth_noise(rnd)
    noise_mat = smooth_noise(rnd)
    centers = voxel_centers(N, h)
    rand_axis = [random_unit(rnd) for _ in range(n_vox)]
    rand_axis = [(a[0], a[1], a[2]) if a[2] >= 0 else (-a[0], -a[1], -a[2]) for a in rand_axis]

    cell_x = [[0.05 + 0.9 * rnd() * L for _ in range(3)] for _ in range(n_cells)]
    cell_q = [random_unit(rnd) for _ in range(n_cells)]           # initial polarity
    cell_u = [rnd() for _ in range(n_cells)]                       # responsiveness trait
    cell_lag = [3.0 * (rnd() - 0.5) for _ in range(n_cells)]       # days of activation lag
    cell_weight = cell_density_weight(centers, cell_x)
    core = core_weight(centers, L)

    dt_frame = days / max(frames - 1, 1)
    out = []
    for fi in range(frames):
        t = fi * dt_frame
        S_rho = logistic(t, 25.0, 8.0)
        S_fa = logistic(t, 22.0, 9.0)
        S_mat = logistic(t, 30.0, 10.0)
        S_act = logistic(t, 15.0, 6.0)

        new, mat, fa, f = [0.0] * n_vox, [0.0] * n_vox, [0.0] * n_vox, [0.0] * (3 * n_vox)
        for v in range(n_vox):
            cx, cy, cz = centers[v]
            n1, n2, n3 = noise_rho(cx, cy, cz), noise_fa(cx, cy, cz), noise_mat(cx, cy, cz)
            rho0 = 0.15 * (1.0 + 0.5 * n1)
            grow = 0.85 * S_rho * (0.55 + 0.45 * core[v]) * (0.7 + 0.5 * cell_weight[v]) * (1.0 + 0.25 * n1)
            r = clamp(rho0 + grow, 0.0, 2.0)
            a = clamp(0.08 + 0.72 * S_fa * (0.8 + 0.2 * n2) + 0.05 * n2 + 0.08 * (r - 0.5) * S_fa, 0.0, 0.95)
            fa[v] = a
            w_align = clamp((a - 0.08) / 0.7, 0.0, 1.0) ** 0.7
            ax = rand_axis[v]
            d = normalize(((1.0 - w_align) * ax[0], (1.0 - w_align) * ax[1], (1.0 - w_align) * ax[2] + w_align))
            f[3 * v], f[3 * v + 1], f[3 * v + 2] = d
            phi = clamp(0.85 * S_mat * (0.8 + 0.25 * n3) * (0.85 + 0.15 * core[v]), 0.0, 1.0)
            new[v], mat[v] = r * (1.0 - phi), r * phi

        xs, ps, a_list, b_list = [], [], [], []
        for c in range(n_cells):
            act = clamp(0.05 + 0.85 * logistic(t - cell_lag[c], 15.0, 6.0) * (0.75 + 0.35 * cell_u[c]), 0.0, 1.0)
            if fi > 0:
                step = 0.16 * L * (1.0 - 0.6 * act) * (1.0 - 0.5 * S_rho)   # persistent random walk
                jitter = random_unit(rnd)
                for ax_i in range(3):
                    cell_x[c][ax_i] += step * (0.6 * jitter[ax_i] + 0.4 * cell_q[c][ax_i])
                reflect_walls(cell_x[c], L)
            q = cell_q[c]
            sign = 1.0 if q[2] >= 0 else -1.0
            w_p = clamp(0.9 * S_act * (0.7 + 0.3 * cell_u[c]), 0.0, 1.0)
            p = normalize(((1.0 - w_p) * q[0], (1.0 - w_p) * q[1], (1.0 - w_p) * q[2] + w_p * sign))
            xs.extend(r4(x) for x in cell_x[c])
            ps.extend(r4(x) for x in p)
            a_list.append(r4(act))
            b_list.append(0.0)
        out.append({"t": t, "species": {"new": new, "mat": mat}, "fa": fa, "f": f,
                    "cells": {"x": xs, "p": ps, "a": a_list, "b": b_list, "c": [0.0] * n_cells, "type": [0] * n_cells}})
    return out, dt_frame


# --------------------------------------------------------------------------
# articular cartilage in a degrading hydrogel
# --------------------------------------------------------------------------


def generate_cartilage(N, frames, days, n_cells, seed, L):
    rnd = mulberry32(seed)
    h = L / N
    n_vox = N * N * N
    noise_s = smooth_noise(rnd)     # scaffold heterogeneity
    noise_g = smooth_noise(rnd)     # GAG
    noise_c = smooth_noise(rnd)     # collagen II
    noise_fa = smooth_noise(rnd)
    centers = voxel_centers(N, h)
    rand_axis = [random_unit(rnd) for _ in range(n_vox)]
    rand_axis = [(a[0], a[1], a[2]) if a[2] >= 0 else (-a[0], -a[1], -a[2]) for a in rand_axis]

    cell_x = [[0.06 + 0.88 * rnd() * L for _ in range(3)] for _ in range(n_cells)]
    cell_p = [random_unit(rnd) for _ in range(n_cells)]            # fixed polarity (round cells)
    cell_u = [rnd() for _ in range(n_cells)]                        # anabolic trait
    cell_lag = [4.0 * (rnd() - 0.5) for _ in range(n_cells)]
    cell_hyp = [rnd() for _ in range(n_cells)]                      # propensity to hypertrophy (b)
    cell_weight = cell_density_weight(centers, cell_x, sigma=0.10)
    core = core_weight(centers, L)

    # scaffold hydrolysis: earlier where cells sit and where the gel is looser
    lag = [clamp(3.0 * noise_s(*centers[v]) - 4.0 * (cell_weight[v] - 1.0), -8.0, 8.0) for v in range(n_vox)]

    dt_frame = days / max(frames - 1, 1)
    out = []
    for fi in range(frames):
        t = fi * dt_frame
        S_gag = logistic(t, 20.0, 7.0)
        S_c2 = logistic(t, 26.0, 8.0)
        S_c1 = logistic(t, 46.0, 5.0)

        sca, gag, col2, col1 = [0.0] * n_vox, [0.0] * n_vox, [0.0] * n_vox, [0.0] * n_vox
        fa, f = [0.0] * n_vox, [0.0] * (3 * n_vox)
        for v in range(n_vox):
            cx, cy, cz = centers[v]
            ns, ng, nc, nf = noise_s(cx, cy, cz), noise_g(cx, cy, cz), noise_c(cx, cy, cz), noise_fa(cx, cy, cz)
            edge = 1.0 - core[v]
            S_deg = logistic(t - lag[v], 28.0, 7.0)
            sca[v] = clamp(0.05 + 0.95 * (1.0 - S_deg) * (1.0 + 0.04 * ns), 0.03, 1.05)
            gag[v] = clamp(0.8 * S_gag * (0.7 + 0.4 * cell_weight[v]) * (1.0 + 0.15 * ng), 0.0, 1.3)
            col2[v] = clamp(0.5 * S_c2 * (0.8 + 0.2 * core[v]) * (0.85 + 0.25 * cell_weight[v]) * (1.0 + 0.15 * nc), 0.0, 1.0)
            col1[v] = clamp(0.1 * S_c1 * (0.5 + 1.5 * edge) * (1.0 + 0.3 * nc), 0.0, 0.5)
            # isotropic: FA stays low, creeping up a little where collagen I appears
            fa[v] = clamp(0.06 + 0.05 * nf + 0.6 * col1[v], 0.0, 0.25)
            f[3 * v], f[3 * v + 1], f[3 * v + 2] = rand_axis[v]

        xs, ps, a_list, b_list, c_list = [], [], [], [], []
        for c in range(n_cells):
            act = clamp(0.1 + 0.7 * logistic(t - cell_lag[c], 14.0, 6.0) * (0.8 + 0.3 * cell_u[c]), 0.0, 1.0)
            hyp = clamp(0.5 * logistic(t - cell_lag[c], 42.0, 6.0) * (0.3 + 1.2 * cell_hyp[c]), 0.0, 1.0)
            # pericellular pool of confined GAG: fills by ~day 15, released as the scaffold opens up
            pool = clamp(0.7 * logistic(t - cell_lag[c], 10.0, 4.0) * (1.0 - logistic(t - cell_lag[c], 30.0, 7.0)) * (0.7 + 0.6 * cell_u[c]), 0.0, 1.0)
            if fi > 0:  # nearly static: a tiny Brownian shiver inside the lacuna
                jitter = random_unit(rnd)
                for ax_i in range(3):
                    cell_x[c][ax_i] += 0.004 * L * jitter[ax_i]
                reflect_walls(cell_x[c], L)
            xs.extend(r4(x) for x in cell_x[c])
            ps.extend(r4(x) for x in cell_p[c])
            a_list.append(r4(act))
            b_list.append(r4(hyp))
            c_list.append(r4(pool))
        out.append({"t": t, "species": {"scaffold": sca, "gag": gag, "col2": col2, "col1": col1}, "fa": fa, "f": f,
                    "cells": {"x": xs, "p": ps, "a": a_list, "b": b_list, "c": c_list, "type": [0] * n_cells}})
    return out, dt_frame


# --------------------------------------------------------------------------
# packing into the format-2 export
# --------------------------------------------------------------------------


def pack(tissue, raw_frames, dt_frame, N, K, L, n_cells, seed):
    fiber_keys = [s["key"] for s in tissue["species"] if s["kind"] == "fiber"]
    last_fiber = fiber_keys[-1] if fiber_keys else None
    frames = []
    for fr in raw_frames:
        n_vox = len(fr["fa"])
        total = [0.0] * n_vox
        for key in fiber_keys:
            arr = fr["species"][key]
            for v in range(n_vox):
                total[v] += arr[v]
        phi = [0.0] * n_vox
        if last_fiber:
            arr = fr["species"][last_fiber]
            phi = [(arr[v] / total[v]) if total[v] > 1e-9 else 0.0 for v in range(n_vox)]
        cells = fr["cells"]
        frames.append({
            "t": r4(fr["t"]),
            "species": {key: [r3(x) for x in arr] for key, arr in fr["species"].items()},
            "fa": [r3(x) for x in fr["fa"]],
            "f": [r3(x) for x in fr["f"]],
            "rho": [r3(x) for x in total],          # format-1 readers: rho = fiber total
            "phiMat": [r3(x) for x in phi],         # format-1 readers: fraction of the last fiber species
            "cells": {"x": cells["x"], "p": cells["p"], "a": cells["a"], "b": cells["b"], "c": cells["c"],
                      "type": cells["type"], "alpha": list(cells["a"])},   # alpha: format-1 readers
        })
    dials = dict(tissue["dials"])
    dials["nCells"] = n_cells
    meta = {
        "format": 2,
        "tissue": tissue["key"],
        "tissueName": tissue["name"],
        "N": N, "L": L, "K": K, "dtDays": 0.02,
        "scenario": tissue["scenario"],
        "dials": dials,
        "loadDial": tissue["loadDial"],
        "loadRange": list(tissue["loadRange"]),   # v0.4: the reader normalises the arrows over it
        "species": tissue["species"],
        "cellTypes": tissue["cellTypes"],
        "exportEveryDays": r4(dt_frame),
        "generator": "blender/make_sample_trajectory.py",
        "seed": seed,
        "synthetic": True,
    }
    return {"meta": meta, "frames": frames}


def generate(tissue_key="fibrous", N=12, K=3, frames=12, days=60.0, n_cells=160, seed=7, L=1.0):
    tissue = TISSUES[tissue_key]
    gen = generate_fibrous if tissue_key == "fibrous" else generate_cartilage
    raw, dt_frame = gen(N, frames, days, n_cells, seed, L)
    return pack(tissue, raw, dt_frame, N, K, L, n_cells, seed)


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tissue", choices=sorted(TISSUES), default="fibrous")
    ap.add_argument("--out", help="output JSON (default: blender/sample_synthetic_fibrous.json for fibrous, "
                                  "blender/sample_synthetic_cartilage.json for cartilage; the committed "
                                  "sample_trajectory*.json fixtures are never the default target)")
    ap.add_argument("--N", type=int, default=12)
    ap.add_argument("--K", type=int, default=3)
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--days", type=float, default=60.0)
    ap.add_argument("--cells", type=int, default=160)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = ap.parse_args(argv)
    out_path = args.out or os.path.join(here, TISSUES[args.tissue]["default_out"])

    if os.path.exists(out_path) and not args.force:
        print(f"[make_sample_trajectory] {out_path} already exists; not overwriting (use --force).")
        return 0

    data = generate(args.tissue, N=args.N, K=args.K, frames=args.frames, days=args.days, n_cells=args.cells, seed=args.seed)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    fr = data["frames"]
    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0
    print(f"[make_sample_trajectory] wrote {out_path}: format 2, tissue={args.tissue} N={args.N} K={args.K} "
          f"frames={len(fr)} days={args.days:g} cells={args.cells} size={os.path.getsize(out_path)/1e6:.2f} MB")
    keys = [s["key"] for s in data["meta"]["species"]]
    for i in (0, len(fr) // 2, len(fr) - 1):
        f = fr[i]
        sp = "  ".join(f"{k}={mean(f['species'][k]):.3f}" for k in keys)
        print(f"  frame {i:2d} t={f['t']:5.1f} d  {sp}  fa={mean(f['fa']):.3f}  "
              f"a={mean(f['cells']['a']):.3f}  b={mean(f['cells']['b']):.3f}  c={mean(f['cells']['c']):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
