#!/usr/bin/env python3
"""Check plots of the CSVs written by tools/run_headless.mjs — any tissue.

    python3 tools/plot_scenarios.py [--tissue cartilage] [--dir scratch/cartilage] [--out FILE.png]

Reads the generic CSV columns of docs/EXTENDING.md §3 (`t`, `species.<key>`, `fa`, `logE`,
`cells.a/b/c`, `fields.<key>`, `deposition`, `degradation`, `species.total`, `ratio`,
`dial.<key>`) plus, when the matching `<run>.json` trajectory is present, the species
labels and colours from its format-2 `meta`. Nothing here knows about a particular tissue:
the panels are built from the columns that exist.

Writes two figures:
  <out>                  one panel per readout series that is not flat zero (a species, a cell
                         state, a field, alignment, stiffness, flux), every scenario overlaid
  <out stem>_stack.png   one panel per scenario: the matrix composition as a stacked area
                         in the species' own colours, with the primary cell state on top

Requires matplotlib (pip install matplotlib --break-system-packages).
"""
import argparse
import csv
import glob
import json
import os
import sys

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:  # pragma: no cover
    sys.exit("matplotlib missing: pip install matplotlib --break-system-packages")

# Categorical palette in fixed slot order (validated, colour-blind safe in adjacent pairs).
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#00807a"]

GRID = dict(color="#e6e6e3", linewidth=0.6)
TEXT = "#0b0b0b"
MUTED = "#52514e"
FALLBACK_SPECIES = ["#9ec5d8", "#4cc4ae", "#c9bfa8", "#e0a24a", "#8f7ae0"]


def read_csv(path):
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        return {}
    cols = {}
    for k in rows[0].keys():
        vals = []
        for r in rows:
            v = r[k]
            try:
                vals.append(float(v) if v not in ("", None) else float("nan"))
            except ValueError:
                vals.append(float("nan"))
        cols[k] = vals
    return cols


def read_meta(path):
    """format-2 meta of the matching trajectory JSON, or None."""
    try:
        with open(path) as fh:
            return json.load(fh).get("meta")
    except (OSError, ValueError):
        return None


def run_label(name, meta):
    """The legend text for a run: the title run_headless.mjs wrote, else the tissue's own scenario
    title, else the file name. No table of run names lives here — a new scenario or a new tissue
    labels itself (docs/REVIEW.md D6)."""
    meta = meta or {}
    return meta.get("title") or meta.get("scenarioTitle") or meta.get("scenario") or name


def run_order(name, meta):
    """Runs come out in the order run_headless.mjs ran them; anything without an order lands last."""
    order = (meta or {}).get("order")
    return (order if isinstance(order, int) else 10_000, name)


def style(ax, title, ylabel=None, ylim=None):
    ax.set_title(title, fontsize=10.5, color=TEXT, loc="left", pad=5)
    ax.grid(True, **GRID)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#bdbdb8")
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.set_xlabel("days", fontsize=8.5, color=MUTED)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=8.5, color=MUTED)
    if ylim:
        ax.set_ylim(*ylim)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tissue", default=None, help="tissue key; sets the default --dir to scratch/<tissue>")
    ap.add_argument("--dir", default=None, help="directory of the run_headless CSVs")
    ap.add_argument("--out", default=None, help="output PNG (default <dir>/scenarios.png)")
    ap.add_argument("--only", default=None, help="comma list of run names to plot")
    a = ap.parse_args()
    d = a.dir or os.environ.get("TISSUE_OUT") or (f"scratch/{a.tissue}" if a.tissue else "scratch/model")
    out = a.out or os.path.join(d, "scenarios.png")
    only = set(a.only.split(",")) if a.only else None

    names = [os.path.splitext(os.path.basename(p))[0] for p in sorted(glob.glob(os.path.join(d, "*.csv")))]
    names = [n for n in names if not n.endswith("_traj") and (only is None or n in only)]
    metas = {n: read_meta(os.path.join(d, f"{n}.json")) for n in names}
    names.sort(key=lambda n: run_order(n, metas.get(n)))
    data = {}
    for n in names:
        cols = read_csv(os.path.join(d, f"{n}.csv"))
        if cols:
            data[n] = cols
    if not data:
        sys.exit(f"no CSVs found in {d}; run `node tools/run_headless.mjs --tissue {a.tissue or 'fibrous'} --out {d}` first")
    color = {n: PALETTE[i % len(PALETTE)] for i, n in enumerate(data)}
    dash = {n: ("-" if i < len(PALETTE) else "--") for i, n in enumerate(data)}
    label = {n: run_label(n, metas.get(n)) for n in data}
    meta = next((m for m in metas.values() if m), None)
    tissue = (meta or {}).get("tissue", a.tissue or "?")
    species = (meta or {}).get("species") or [
        {"key": k.split(".", 1)[1], "label": k.split(".", 1)[1], "color": FALLBACK_SPECIES[i % len(FALLBACK_SPECIES)]}
        for i, k in enumerate(c for c in next(iter(data.values())) if c.startswith("species.") and c != "species.total")]
    skeys = [s["key"] for s in species]
    fkeys = [c.split(".", 1)[1] for c in next(iter(data.values())) if c.startswith("fields.")]

    # ---------------------------------------------------------------- figure 1: panel per readout series
    panels = [("species.total", "Total matrix density", "1 ≈ native content")]
    panels += [(f"species.{k}", f"{s.get('label', k)}  ({k})", "density") for k, s in zip(skeys, species)]
    panels += [("logE", "Stiffness  log10 E", "log10 kPa"),
               ("globalFA", "Alignment, whole tissue (globalFA)", "0–1"),
               ("fa", "Local anisotropy (mean per-voxel FA)", "0–1")]
    panels += [(f"cells.{x}", f"Cell state {x}", "0–1") for x in ("a", "b", "c")]
    panels += [(f"fields.{k}", f"Field {k}", "field units") for k in fkeys]
    panels += [("flux", "Deposition (solid) vs degradation (dashed)", "density/day")]
    def used(key):
        """keep a panel only if some run has the column and it is not flat zero everywhere"""
        seen = False
        for cols in data.values():
            if key not in cols:
                continue
            seen = True
            if any(abs(v) > 1e-9 for v in cols[key]):
                return True
        return not seen and False
    panels = [p for p in panels if p[0] == "flux" or used(p[0])]

    ncol = 4
    nrow = (len(panels) + ncol - 1) // ncol
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.0 * ncol, 2.9 * nrow), dpi=130, squeeze=False)
    fig.patch.set_facecolor("#fcfcfb")
    ax = axes.ravel()
    for i, (key, title, unit) in enumerate(panels):
        for n, cols in data.items():
            if key == "flux":
                ax[i].plot(cols["t"], cols["deposition"], color=color[n], lw=1.8, ls=dash[n])
                ax[i].plot(cols["t"], cols["degradation"], color=color[n], lw=1.0, ls=":")
            elif key in cols:
                ax[i].plot(cols["t"], cols[key], color=color[n], lw=1.8, ls=dash[n], label=label[n])
        style(ax[i], title, unit)
        if key == "cells.a":
            ax[i].set_ylim(0, 1)
    for j in range(len(panels), len(ax)):
        ax[j].axis("off")
    handles = [plt.Line2D([], [], color=color[n], lw=2.2, ls=dash[n], label=label[n]) for n in data]
    ax[min(len(panels), len(ax) - 1)].legend(handles=handles, fontsize=8.5, frameon=False, loc="upper left") \
        if len(panels) < len(ax) else ax[0].legend(fontsize=7, frameon=False)
    fig.suptitle(f"Tissue Weather — headless scenario check: {tissue}", fontsize=13, color=TEXT, x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(out, facecolor=fig.get_facecolor())
    print("wrote", out)

    # ---------------------------------------------------------------- figure 2: composition per scenario
    runs = list(data)
    ncol2 = min(3, max(1, len(runs)))
    nrow2 = (len(runs) + ncol2 - 1) // ncol2
    fig2, axes2 = plt.subplots(nrow2, ncol2, figsize=(5.0 * ncol2, 3.4 * nrow2), dpi=130, squeeze=False)
    fig2.patch.set_facecolor("#fcfcfb")
    ax2 = axes2.ravel()
    top = 0.1
    for cols in data.values():
        top = max(top, max(cols["species.total"]))
    for i, n in enumerate(runs):
        cols = data[n]
        t = cols["t"]
        base = [0.0] * len(t)
        for k, sp in zip(skeys, species):
            col = f"species.{k}"
            if col not in cols:
                continue
            upper = [b + v for b, v in zip(base, cols[col])]
            ax2[i].fill_between(t, base, upper, color=sp.get("color", "#999999"), alpha=0.9, lw=0,
                                label=sp.get("label", k))
            base = upper
        ax2[i].plot(t, base, color=TEXT, lw=0.9)
        axb = ax2[i].twinx()
        axb.plot(t, cols["cells.a"], color="#8f2d9e", lw=1.4, ls="--", label="cell state a")
        if "cells.c" in cols:
            axb.plot(t, cols["cells.c"], color="#8f2d9e", lw=1.0, ls=":", label="cell state c")
        axb.set_ylim(0, 1.05)
        axb.tick_params(colors="#8f2d9e", labelsize=7.5)
        axb.spines["top"].set_visible(False)
        style(ax2[i], f"{label[n]}: composition", "density (stacked)", (0, top * 1.05))
        ax2[i].legend(fontsize=7.5, frameon=False, loc="upper left")
    for j in range(len(runs), len(ax2)):
        ax2[j].axis("off")
    fig2.suptitle(f"Tissue Weather — matrix composition per scenario: {tissue} "
                  "(dashed: cell state a, dotted: c, right axis)", fontsize=13, color=TEXT, x=0.01, ha="left")
    fig2.tight_layout(rect=(0, 0, 1, 0.97))
    out2 = os.path.splitext(out)[0] + "_stack.png"
    fig2.savefig(out2, facecolor=fig2.get_facecolor())
    print("wrote", out2)


if __name__ == "__main__":
    main()
