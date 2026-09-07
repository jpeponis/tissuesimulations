#!/usr/bin/env python3
"""
make_sample_trajectory.py -- synthetic "Tissue Weather" trajectory in the
SPEC section 1.10 export format, for exercising blender/import_tissue.py
without a browser or node.

Pure Python (no numpy). Deterministic: uses the same mulberry32 PRNG family
as src/model.js so a given --seed always yields the same file.

The synthetic trajectory imitates scenario 1 ("Scaffold to tissue"):
  * fiber density rho rises from a sparse provisional scaffold (~0.15) toward
    dense tissue (~0.9), faster where cells are seeded and in the core;
  * fibers align to the load axis z (fa 0.08 -> ~0.75, principal axis f
    rotates from random toward +z);
  * maturity phiMat rises with a ~2 week lag (0 -> ~0.8);
  * ~160 cells activate (alpha 0.05 -> ~0.85), elongate and polarise along z
    while doing a persistent random walk.

Usage:
  python3 blender/make_sample_trajectory.py                   # writes blender/sample_trajectory.json
  python3 blender/make_sample_trajectory.py --out X.json --frames 12 --days 60 --cells 160 --seed 7
Never overwrites an existing file unless --force is given.
"""
import argparse
import json
import math
import os
import sys

MASK32 = 0xFFFFFFFF


def mulberry32(seed):
    """Return a callable producing uniform floats in [0,1) -- port of the JS
    mulberry32 used by src/model.js (bit-exact for the same 32-bit seed)."""
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


def r4(v):
    return round(v, 4)


def generate(N=12, K=3, frames=12, days=60.0, n_cells=160, seed=7, L=1.0):
    rnd = mulberry32(seed)
    h = L / N
    n_vox = N * N * N

    # ---------- per-voxel fixed structure ----------
    noise_rho = smooth_noise(rnd)
    noise_fa = smooth_noise(rnd)
    noise_mat = smooth_noise(rnd)
    centers = []
    for i in range(N):
        for j in range(N):
            for k in range(N):
                centers.append(((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h))
    rand_axis = [random_unit(rnd) for _ in range(n_vox)]
    # flip so the axis has +z sign (a fiber axis is sign-free anyway)
    rand_axis = [(a[0], a[1], a[2]) if a[2] >= 0 else (-a[0], -a[1], -a[2]) for a in rand_axis]

    # ---------- cells: seeding and per-cell traits ----------
    cell_x = [[0.05 + 0.9 * rnd() * L for _ in range(3)] for _ in range(n_cells)]
    cell_q = [random_unit(rnd) for _ in range(n_cells)]           # initial polarity
    cell_u = [rnd() for _ in range(n_cells)]                       # responsiveness trait
    cell_lag = [3.0 * (rnd() - 0.5) for _ in range(n_cells)]       # days of activation lag

    # deposition weight: where cells were seeded (they build the matrix)
    cell_weight = [0.0] * n_vox
    for v in range(n_vox):
        cx, cy, cz = centers[v]
        w = 0.0
        for x in cell_x:
            dx, dy, dz = x[0] - cx, x[1] - cy, x[2] - cz
            d2 = dx * dx + dy * dy + dz * dz
            w += math.exp(-d2 / (2.0 * 0.12 * 0.12))
        cell_weight[v] = w
    mean_w = sum(cell_weight) / n_vox
    cell_weight = [w / max(mean_w, 1e-9) for w in cell_weight]

    core = []
    for cx, cy, cz in centers:
        r2 = ((cx - 0.5 * L) ** 2 + (cy - 0.5 * L) ** 2 + (cz - 0.5 * L) ** 2) / (0.75 * L * L)
        core.append(1.0 - 0.35 * r2)

    dt_frame = days / max(frames - 1, 1)
    out_frames = []
    for fi in range(frames):
        t = fi * dt_frame
        S_rho = logistic(t, 25.0, 8.0)
        S_fa = logistic(t, 22.0, 9.0)
        S_mat = logistic(t, 30.0, 10.0)
        S_act = logistic(t, 15.0, 6.0)

        rho = [0.0] * n_vox
        fa = [0.0] * n_vox
        f = [0.0] * (3 * n_vox)
        phi = [0.0] * n_vox
        for v in range(n_vox):
            cx, cy, cz = centers[v]
            n1 = noise_rho(cx, cy, cz)
            n2 = noise_fa(cx, cy, cz)
            n3 = noise_mat(cx, cy, cz)
            rho0 = 0.15 * (1.0 + 0.5 * n1)
            grow = 0.85 * S_rho * (0.55 + 0.45 * core[v]) * (0.7 + 0.5 * cell_weight[v]) * (1.0 + 0.25 * n1)
            r = clamp(rho0 + grow, 0.0, 2.0)
            rho[v] = r
            a = clamp(0.08 + 0.72 * S_fa * (0.8 + 0.2 * n2) + 0.05 * n2 + 0.08 * (r - 0.5) * S_fa, 0.0, 0.95)
            fa[v] = a
            w_align = clamp((a - 0.08) / 0.7, 0.0, 1.0) ** 0.7
            ax = rand_axis[v]
            d = normalize(((1.0 - w_align) * ax[0], (1.0 - w_align) * ax[1], (1.0 - w_align) * ax[2] + w_align))
            f[3 * v], f[3 * v + 1], f[3 * v + 2] = d
            phi[v] = clamp(0.85 * S_mat * (0.8 + 0.25 * n3) * (0.85 + 0.15 * core[v]), 0.0, 1.0)

        # cells
        xs, ps, alphas = [], [], []
        for c in range(n_cells):
            alpha = clamp(0.05 + 0.85 * logistic(t - cell_lag[c], 15.0, 6.0) * (0.75 + 0.35 * cell_u[c]), 0.0, 1.0)
            if fi > 0:
                # persistent random walk, slower when activated / embedded
                step = 0.16 * L * (1.0 - 0.6 * alpha) * (1.0 - 0.5 * S_rho)
                jitter = random_unit(rnd)
                for ax_i in range(3):
                    cell_x[c][ax_i] += step * (0.6 * jitter[ax_i] + 0.4 * cell_q[c][ax_i])
                    # reflect at walls
                    if cell_x[c][ax_i] < 0.03 * L:
                        cell_x[c][ax_i] = 0.06 * L - cell_x[c][ax_i]
                    if cell_x[c][ax_i] > 0.97 * L:
                        cell_x[c][ax_i] = 1.94 * L - cell_x[c][ax_i]
                    cell_x[c][ax_i] = clamp(cell_x[c][ax_i], 0.03 * L, 0.97 * L)
            q = cell_q[c]
            sign = 1.0 if q[2] >= 0 else -1.0
            w_p = clamp(0.9 * S_act * (0.7 + 0.3 * cell_u[c]), 0.0, 1.0)
            p = normalize(((1.0 - w_p) * q[0], (1.0 - w_p) * q[1], (1.0 - w_p) * q[2] + w_p * sign))
            xs.extend(r4(x) for x in cell_x[c])
            ps.extend(r4(x) for x in p)
            alphas.append(r4(alpha))

        out_frames.append({
            "t": r4(t),
            "rho": [r4(x) for x in rho],
            "fa": [r4(x) for x in fa],
            "f": [r4(x) for x in f],
            "phiMat": [r4(x) for x in phi],
            "cells": {"x": xs, "p": ps, "alpha": alphas},
        })

    meta = {
        "N": N, "L": L, "K": K, "dtDays": 0.02,
        "scenario": "Scaffold to tissue (maturation) -- synthetic sample",
        "dials": {"Gext": 0.5, "strain": 0.6, "proteaseDial": 0.4, "nCells": n_cells},
        "exportEvery": r4(dt_frame),
        "generator": "blender/make_sample_trajectory.py",
        "seed": seed,
        "synthetic": True,
    }
    return {"meta": meta, "frames": out_frames}


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(here, "sample_trajectory.json"))
    ap.add_argument("--N", type=int, default=12)
    ap.add_argument("--K", type=int, default=3)
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--days", type=float, default=60.0)
    ap.add_argument("--cells", type=int, default=160)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = ap.parse_args(argv)

    if os.path.exists(args.out) and not args.force:
        print(f"[make_sample_trajectory] {args.out} already exists; not overwriting (use --force).")
        return 0

    data = generate(N=args.N, K=args.K, frames=args.frames, days=args.days, n_cells=args.cells, seed=args.seed)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    fr = data["frames"]
    mean = lambda xs: sum(xs) / len(xs)
    print(f"[make_sample_trajectory] wrote {args.out}: N={args.N} K={args.K} frames={len(fr)} "
          f"days={args.days:g} cells={args.cells} size={os.path.getsize(args.out)/1e6:.2f} MB")
    for i in (0, len(fr) // 2, len(fr) - 1):
        f = fr[i]
        print(f"  frame {i:2d} t={f['t']:5.1f} d  rho={mean(f['rho']):.3f}  fa={mean(f['fa']):.3f}  "
              f"phiMat={mean(f['phiMat']):.3f}  alpha={mean(f['cells']['alpha']):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
