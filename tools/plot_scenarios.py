#!/usr/bin/env python3
"""Check plots of the CSVs written by tools/run_headless.mjs.

    python3 tools/plot_scenarios.py [--dir scratch/model] [--out scratch/model/scenarios.png]

Writes two figures:
  <out>                 2x3 panel: mean rho, mature fraction, FA, log10 E, alpha, deposition vs degradation
  <out stem>_stack.png  per-scenario stacked new/mature density (the unloading "mature decays slower" check),
                        the wound-region refill, and the protease / growth-factor comparisons.
Requires matplotlib (pip install matplotlib --break-system-packages).
"""
import argparse
import csv
import os
import sys

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:  # pragma: no cover
    sys.exit("matplotlib missing: pip install matplotlib --break-system-packages")

# Categorical palette in fixed slot order (validated, colour-blind safe in adjacent pairs).
SERIES = {
    "maturation": ("#2a78d6", "Scaffold to tissue"),
    "unloading": ("#eb6834", "Unloading"),
    "fibrosis": ("#1baf7a", "Fibrosis (Gext→0.2 @45 d)"),
    "wound": ("#eda100", "Wound (injure @5 d)"),
    "sandbox": ("#e87ba4", "Sandbox, dials 0"),
    "maturation_lowG": ("#2a78d6", "Maturation, Gext 0.2"),
    "fibrosis_lowG": ("#1baf7a", "Fibrosis, Gext 0.2"),
    "fibrosis_nodrop": ("#1baf7a", "Fibrosis, no drop"),
    "maturation_protease0": ("#4a3aa7", "Maturation, protease 0"),
    "maturation_protease1": ("#e34948", "Maturation, protease 1"),
}
MAIN = ["maturation", "unloading", "fibrosis", "wound", "sandbox"]
GRID = dict(color="#e6e6e3", linewidth=0.6)
TEXT = "#0b0b0b"
MUTED = "#52514e"


def read_csv(path):
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    cols = {}
    for k in rows[0].keys():
        vals = []
        for r in rows:
            v = r[k]
            vals.append(float(v) if v not in ("", None) else float("nan"))
        cols[k] = vals
    return cols


def style(ax, title, ylabel=None, ylim=None):
    ax.set_title(title, fontsize=11, color=TEXT, loc="left", pad=6)
    ax.grid(True, **GRID)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#bdbdb8")
    ax.tick_params(colors=MUTED, labelsize=8.5)
    ax.set_xlabel("days", fontsize=9, color=MUTED)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=9, color=MUTED)
    if ylim:
        ax.set_ylim(*ylim)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.environ.get("TISSUE_OUT", "scratch/model"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = a.out or os.path.join(a.dir, "scenarios.png")
    data = {}
    for name in SERIES:
        p = os.path.join(a.dir, f"{name}.csv")
        if os.path.exists(p):
            data[name] = read_csv(p)
    if not data:
        sys.exit(f"no CSVs found in {a.dir}; run `node tools/run_headless.mjs --out {a.dir}` first")

    # ---------------------------------------------------------------- figure 1
    fig, axes = plt.subplots(2, 3, figsize=(15, 8.5), dpi=130)
    fig.patch.set_facecolor("#fcfcfb")
    ax = axes.ravel()

    def lines(axis, key, names, lw=2.0, dashed=(), label=True):
        for n in names:
            if n not in data:
                continue
            c, lab = SERIES[n]
            axis.plot(data[n]["t"], data[n][key], color=c, lw=lw, ls="--" if n in dashed else "-",
                      label=lab if label else None)

    # (a) mean rho: all runs; variants dashed / dotted in the same hue as their parent
    lines(ax[0], "meanRho", MAIN)
    lines(ax[0], "meanRho", ["maturation_lowG", "fibrosis_lowG"], lw=1.4, dashed=("maturation_lowG", "fibrosis_lowG"))
    if "fibrosis_nodrop" in data:
        ax[0].plot(data["fibrosis_nodrop"]["t"], data["fibrosis_nodrop"]["meanRho"], color=SERIES["fibrosis"][0], lw=1.0, ls=":",
                   label=SERIES["fibrosis_nodrop"][1])
    ax[0].axvline(45, color="#bdbdb8", lw=0.8, ls=":")
    ax[0].axvline(5, color="#bdbdb8", lw=0.8, ls=":")
    style(ax[0], "Mean fibre density ρ  (dashed: Gext 0.2 from the start)", "ρ (1 ≈ dense tissue)", (0, 1.7))
    ax[0].legend(fontsize=7.5, frameon=False, ncol=2, loc="upper left")

    lines(ax[1], "phiMat", MAIN)
    style(ax[1], "Mature (cross-linked) fraction φ", "φ = ρ_mat / ρ", (0, 1))

    lines(ax[2], "meanFA", MAIN)
    style(ax[2], "Fibre alignment (mean FA)", "FA", (0, 1))

    lines(ax[3], "meanLogE", MAIN)
    style(ax[3], "Stiffness (mean log10 E, kPa)", "log10 E", (-0.6, 2.5))

    lines(ax[4], "meanAlpha", MAIN)
    style(ax[4], "Cell activation α", "α", (0, 1))

    for n in MAIN:
        if n not in data:
            continue
        c, lab = SERIES[n]
        ax[5].plot(data[n]["t"], data[n]["deposition"], color=c, lw=2.0, label=f"{lab} — deposition")
        ax[5].plot(data[n]["t"], data[n]["degradation"], color=c, lw=1.2, ls="--")
    style(ax[5], "Deposition (solid) vs degradation (dashed), total ρ/day", "ρ / day summed over voxels")
    ax[5].legend(fontsize=7, frameon=False)
    fig.suptitle("Tissue Weather — headless scenario check", fontsize=13, color=TEXT, x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(out, facecolor=fig.get_facecolor())
    print("wrote", out)

    # ---------------------------------------------------------------- figure 2: stacked new/mature + comparisons
    fig2, axes2 = plt.subplots(2, 3, figsize=(15, 8.5), dpi=130)
    fig2.patch.set_facecolor("#fcfcfb")
    ax2 = axes2.ravel()
    stack_runs = ["maturation", "unloading", "fibrosis", "wound"]
    for i, n in enumerate(stack_runs):
        if n not in data:
            continue
        d = data[n]
        t = d["t"]
        mat = d["meanRhoMat"]
        tot = d["meanRho"]
        ax2[i].fill_between(t, 0, mat, color="#e0a24a", alpha=0.85, lw=0, label="mature (cross-linked)")
        ax2[i].fill_between(t, mat, tot, color="#9cc9f2", alpha=0.9, lw=0, label="new (provisional)")
        ax2[i].plot(t, tot, color=TEXT, lw=1.0)
        if n == "wound" and "woundRho" in d:
            ax2[i].plot(t, d["woundRho"], color="#e34948", lw=2.0, label="ρ inside the wound sphere")
            ax2[i].plot(t, d["woundFA"], color="#e34948", lw=1.2, ls="--", label="FA inside the wound")
            ax2[i].plot(t, d["meanFA"], color=MUTED, lw=1.2, ls="--", label="FA whole tissue")
        if n == "fibrosis":
            ax2[i].axvline(45, color="#bdbdb8", lw=0.8, ls=":")
            ax2[i].text(45.5, 1.3, "Gext 0.9 → 0.2", fontsize=8, color=MUTED)
        style(ax2[i], f"{SERIES[n][1]}: new vs mature density", "ρ", (0, 1.45))
        ax2[i].legend(fontsize=7.5, frameon=False, loc="upper left")

    # protease comparison
    for n in ["maturation_protease0", "maturation", "maturation_protease1"]:
        if n in data:
            c, lab = SERIES[n]
            ax2[4].plot(data[n]["t"], data[n]["meanRho"], color=c, lw=2.0, label=lab if n != "maturation" else "Maturation, protease 0.4")
    style(ax2[4], "Protease dial: plateaus differ", "ρ", (0, 1.45))
    ax2[4].legend(fontsize=7.5, frameon=False)

    # hysteresis
    for n, ls in [("fibrosis", "-"), ("fibrosis_lowG", "--"), ("fibrosis_nodrop", ":")]:
        if n in data:
            ax2[5].plot(data[n]["t"], data[n]["meanRho"], color=SERIES[n][0], lw=2.0 if ls == "-" else 1.4, ls=ls, label=SERIES[n][1])
    for n, ls in [("maturation", "-"), ("maturation_lowG", "--")]:
        if n in data:
            ax2[5].plot(data[n]["t"], data[n]["meanRho"], color=SERIES[n][0], lw=1.4, ls=ls, label=SERIES[n][1])
    ax2[5].axvline(45, color="#bdbdb8", lw=0.8, ls=":")
    style(ax2[5], "Hysteresis: same Gext 0.2 after day 45, two tissues", "ρ", (0, 1.45))
    ax2[5].legend(fontsize=7.5, frameon=False)
    fig2.suptitle("Tissue Weather — composition, wound refill, protease and hysteresis checks", fontsize=13, color=TEXT, x=0.01, ha="left")
    fig2.tight_layout(rect=(0, 0, 1, 0.97))
    out2 = os.path.splitext(out)[0] + "_stack.png"
    fig2.savefig(out2, facecolor=fig2.get_facecolor())
    print("wrote", out2)


if __name__ == "__main__":
    main()
