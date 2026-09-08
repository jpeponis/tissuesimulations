# Teaching with Tissue Weather

A lesson plan for the *Tissue Weather* interactive (see the [README](../README.md) to get it running) in an undergraduate or graduate tissue-engineering course. The session is built around **dynamic reciprocity**: the two-way loop in which cells build the extracellular matrix (ECM) and the matrix in turn instructs the cells (Bissell, Hall & Parry 1982). The cloud metaphor gets students in the door; the last ten minutes are about where it fails.

## Learning objectives

By the end of the session a student can:

1. **Define** dynamic reciprocity in one sentence and **label** both arrows of the loop on a diagram of the simulation (cells → matrix: deposition, degradation, alignment; matrix → cells: stiffness, tension, stored growth factor).
2. **Predict**, before pressing Play, which way the flux gauge will lean for a given dial setting, and **name** the readout that should move first.
3. **Explain** how the two activating inputs combine in this model — **TGF-β gates, tension potentiates** — using the activation trace as evidence (Tomasek et al. 2002; Hinz 2015). With the bath at 0 no amount of load activates anything (activation stays under 0.05); with the bath at 0.5 and the load at 0 the cells go about half way (0.49 → 0.53 over eight weeks); with both they reach ≈ 0.89.
4. **Distinguish** a static equilibrium from a homeostatic one using deposition and degradation rates, not density alone (Humphrey, Dufresne & Schwartz 2014).
5. **Describe** hysteresis in the fibrosis scenario and **give** one mechanism by which stiff, crosslinked matrix keeps cells activated after the growth factor is gone.
6. **List** three places the cloud metaphor breaks and three processes the model omits.

## 50-minute outline

- **0–5** Hook: run *Scaffold to tissue* on the projector. If fibers are droplets, what is the vapor? Students write a one-line answer.
- **5–12** Mini-lecture: the loop as two arrows, the dials as weather, the flux gauge as the equilibrium they push. Students draw the loop.
- **12–20** Experiment 1 (maturation) in pairs: which readout moved first?
- **20–28** Experiment 2 (unloading): predict, then run.
- **28–38** Experiment 3 (fibrosis), the key moment: sketch the up-and-down path.
- **38–44** Experiment 4 (wound), demonstrated at the front: name two scar-versus-neighbour differences.
- **44–48** Sandbox challenge: find dials for a busy steady state.
- **48–50** Exit ticket: one place the metaphor breaks.

The speed slider has three named presets: **Watch** (1 day per second), **Weeks** (5, the default — the one to teach on) and **Months** (20, for the eight-week stretches). **+7 days** jumps a week without waiting.

## Before class: the tissue picker and deep links

**The tissue picker** sits at the top of the panel. Tissue Weather runs more than one tissue on the same engine: the default **fibrous connective tissue** (fibroblasts, collagen I under load) that this lesson uses throughout, and **cartilage in a degrading hydrogel** (round chondrocytes, proteoglycan gel, a scaffold that has to disappear at the right speed). Switching tissue replaces the dials, the scenarios, the readouts and the legend, because all of them are generated from the tissue's own definition — so the same lesson structure works for either, but the specific experiments below are written for the fibrous tissue. The cartilage tissue makes a good second session or a graduate extension: the same two arrows of dynamic reciprocity, a matrix whose stiffness comes from osmotic swelling rather than fibre tension, and a scaffold that is itself one of the variables.

**Deep links** put the class where you want it in one click. The address bar keeps up with the current state — tissue, scenario, every dial and the playback speed — and the **Copy link** button copies it (use the button in embedded viewers, where the page is not allowed to rewrite the address bar). Paste those links into the slides, the LMS or the worksheet:

```
index.html?tissue=fibrous&scenario=maturation
index.html?tissue=fibrous&scenario=fibrosis&speed=20
index.html?tissue=fibrous&scenario=unloading&Gext=0.2&strain=0&protease=0.5&nCells=160
```

`tissue` and `scenario` take the keys shown in the picker and the scenario cards (`maturation`, `unloading`, `fibrosis`, `wound`, `sandbox`); each dial is set by its own key; `speed` is simulated days per real second. A value that does not exist is ignored and the scenario's own setting is used instead, so an old link never breaks a class.

Three uses worth planning for: hand each pair a *different* dial setting of the same scenario and compare results at the board; put the "wrong" setting in the worksheet so students have to explain why it misbehaves; and ask students to send back the link of a state they could not explain — it reproduces exactly, seed and all.

## Guided experiments

### 1. Scaffold to tissue (maturation)

**Setup.** Provisional isotropic matrix; bath 0.5, load 0.6, protease 0.4, 160 cells.
**Do.** Play for four weeks watching fiber colour, alignment and stiffness. Pause and ask which changed first.
**Expect.** The first two days *evaporate*: the cells start quiescent, so density dips from 0.150 to 0.134 before the flux bar crosses over on about day 3 — worth pausing on, because students predict a monotone rise. After that density climbs to ≈ 1.0 by day 60; fibers rotate toward the load arrows and turn amber over four to eight weeks; stiffness climbs from 0.9 to ≈ 80 kPa; cells shift from blue (0.05) to orange (0.88). Alignment leads maturity by a little — at day 7 the alignment trace has covered 38 % of its eventual rise and the mature fraction only 25 % — because load rotates fibers directly while crosslinking waits on time and on activated cells.
**Discuss.** Stiffness and activation rise together; which drives which? Students should propose a test: zero the load and see whether the bath alone activates the cells (it does, about half way — objective 3). The alignment rule caricatures models in which cell traction and applied stretch remodel collagen orientation in engineered tissues (Loerakker, Obbink-Huizer & Baaijens 2014).

### 2. Unloading (disuse atrophy)

**Setup.** Matured state; the preset moves **two** dials at once — load 0.6 → 0, bath 0.5 → 0.2 (protease 0.5).
**Do.** Predict the gauge and the cell colour before pressing Play. Run six weeks. Then run it twice more, changing one dial at a time: load 0 with the bath left at 0.5, and the bath at 0.2 with the load left at 0.6.
**Expect.** With both: cells fade toward blue within days (activation 0.88 → 0.55 by day 5 and 0.17 by four weeks); the gauge tips to evaporating on day 1; density falls 1.00 → 0.60 in six weeks and 0.48 by day 60; the pale new matrix is all but gone in two weeks (0.15 → 0.02) while the amber mature pool has lost only 4 % — amber outlasts pale.
With **load alone** removed the tissue does *not* atrophy: density holds at ≈ 1.0 for three months, the cells settle at 0.70 rather than 0.16, and what collapses instead is the alignment (whole-tissue coherence 0.58 → 0.11 in eight weeks). The headless variant `unloading_loadOnly` runs exactly this.
**Discuss.** Which dial did the work? In this model the growth-factor bath gates activation, and the load then sets how far the cells go — so unloading a tissue that is still bathed in TGF-β mostly costs it its *architecture*, not its mass. Under-tensioned cells do secrete more protease and less collagen, the mechanoregulation half of matrix homeostasis (Humphrey, Dufresne & Schwartz 2014), but here that alone is not enough to reverse the balance. Clinical analogue: a limb in a cast — where the growth-factor environment changes too. This is also a good moment to name a model limitation: real disuse atrophy does not need the growth factor to be withdrawn.

### 3. Fibrosis (runaway and hysteresis)

**Setup.** Provisional matrix; bath 0.9, load 0.3, protease 0.2.
**Do.** Run four weeks (the scripted event drops the bath on day 45 if you keep playing). Sketch stiffness, activation and the growth-factor haze against time.
**Expect.** Dense, stiff, poorly aligned matrix by week four: density 1.07, stiffness ≈ 80 kPa, activation 0.91, and note how *low* the alignment is (whole-tissue 0.19) — this is scar, not tendon. After the bath falls from 0.9 to 0.2, activation dips to 0.79 and settles there; stiffness does not dip at all and keeps climbing to ≈ 145 kPa. The tissue does not retrace its path.
**Discuss.** What holds the cells on, if not the bath? Switch on the growth-factor layer: the haze stays at ≈ 0.4, twice the bath value, because the cells are making it. Stiff matrix raises the tension the cells feel, contractile cells on stiff matrix free latent TGF-β, and that TGF-β keeps them contractile — Hinz (2015) argues this positive-feedback loop underlies fibrosis, and network models predict the same TGF-β–mechanics crosstalk (Zeigler et al. 2016). The model also releases growth factor when matrix is digested (Yu & Stamenkovic 2000), but that term supplies under 1 % of what holds the haze up here: the memory is autocrine, not stored. Ask what you would have to turn down to break the loop.

### 4. Wound healing

**Setup.** Mature tissue; press Injure (the wound is outlined by a wire sphere).
**Do.** Turn on the growth-factor and protease layers. Watch the wound for a week, compare inside and outside at three weeks, then run to eight.
**Expect.** A teal and magenta flare in the hole. The cells that were already there stay activated and *dim slightly* (0.88 → 0.82 over the first week) — nothing swims in, because this model has no chemotaxis and the wound holds no more cells afterwards than its share of the volume. Pale tangled fibers fill the gap within days (the hole is back to a fifth of the surrounding density after a week and two fifths after two). Alignment inside the patch lags clearly at three weeks — 0.40 against 0.54 outside — and then catches up: by eight weeks it is 0.49 against 0.54, and the density is 0.93 against 1.20.
**Discuss.** The patch nearly catches up here, which real scar never does (Xue & Jackson 2015): remodelling takes many months and the scar never regains the strength or flexibility of the original tissue. So ask what the model is missing — no crosslink history that locks in the wrong direction, no fibrin/provisional architecture, no immune phase, no collagen III→I ratio and no wound contraction. What it *does* show is the first half of the story: fibers laid into an empty hole have nothing to align with, so the patch starts isotropic and is pulled straight only by the load.

### 5. Sandbox

**Setup.** Nearly empty cube, all dials mid.
**Do.** Predict aloud, run one week, then adjust one dial at a time until the gauge sits near zero.
**Expect.** Several such settings exist: some idle (few cells, low bath), some busy (high deposition matched by high degradation).
**Discuss.** Which is a healthy tissue? Homeostasis is the busy one.

## Three common misconceptions

**1. "The matrix is inert scaffolding; the cells are the only actors."** Nothing in the unloading preset touches a cell directly — it changes the load on the matrix and the growth factor in the medium — yet the cells switch behaviour within days, because they read the matrix. The intro panel names the return arrow: stiffness, tension and stored growth factor are messages from the matrix (Bissell, Hall & Parry 1982; Hinz 2015). The cleanest demonstration is the load-only run of experiment 2: no dial reaches the cells, and their activation still drops from 0.88 to 0.70 as the matrix around them loses its tension.

**2. "Equilibrium means nothing is happening."** The gauge shows deposition and degradation separately, so a steady density with both rates high looks different from one with both near zero. The sandbox asks students to find both and decide which is a living tissue (Humphrey, Dufresne & Schwartz 2014).

**3. "Remove the cause and the effect reverses."** In fibrosis, students lower the bath and watch stiffness keep climbing while the equilibrium sentence reports that the cells are still activated. Two things hold: the cells now supply their own growth factor (switch on the growth-factor layer and watch the haze sit at twice the bath value), and mature matrix resists proteases as crosslinked collagen does. The way down is not the way up (Tomasek et al. 2002; Hinz 2015).

## Assessment: predict–observe–explain worksheet

Each pair gets a sheet with two scenarios, unloading and fibrosis, and three columns.

- **Predict** (before Play): sketch density, alignment, stiffness and activation over eight weeks; circle which way the gauge leans at day 1 and day 28.
- **Observe**: record the four readouts at days 0, 7, 28 and 56, plus the equilibrium sentence at day 28.
- **Explain**: for each readout that departed from the prediction, name the arrow of the loop responsible and the mechanism (tension → protease; stiffness → activation; activation on stiff matrix → the cells' own growth factor; crosslinking → protease resistance).

Grade only the Explain column: an honest wrong prediction plus a mechanistic explanation earns full credit, and a strong answer cites a specific readout as evidence.

Graduate extension: find the day on which deposition/degradation crossed 1. The **Table** button under the readouts prints the current deposition and degradation, so a student can bracket the crossing by stepping; for the exact day, run the scenario headless —

```bash
node tools/run_headless.mjs --tissue fibrous --only maturation --days 20 --csv-every 0.5
```

— and read the `ratio` column (deposition ÷ degradation) of `scratch/fibrous/maturation.csv`. It crosses 1 on day 3, because the cells start quiescent. The exported JSON trajectory carries the state per frame, not the rates, so it is the CSV that answers this question.

## What the model leaves out

- **The ECM is a summary, not a structure.** Each voxel stores density, anisotropy, orientation and a mature fraction, after the PhysiCell-ECM approach of Metzcar et al. (2025); there are no individual fibers, fibronectin, proteoglycans or basement membranes. Degradation thins a voxel without changing its alignment, by construction, and nothing records that a patch was ever a wound — which is why the model's scar slowly catches up with its neighbours where a real one does not.
- **One growth factor, one protease dial.** TGF-β stands in for all soluble signals and the protease dial lumps MMPs with TIMPs. There are no immune cells: the injury is a burst of growth factor and protease, so the model cannot show why fetal wounds heal without scarring (Xue & Jackson 2015).
- **Cells are simple.** Activation is one number relaxing toward a target set by tension and growth factor, a caricature of a 91-node signalling network (Zeigler et al. 2016). Cells do not divide, die, contract the tissue or follow gradients.
- **Load is static and uniaxial.** Real tissues see cyclic, multiaxial loading, and cells respond to cyclic stretch differently from static stretch. Compaction, central to Loerakker, Obbink-Huizer and Baaijens (2014), is absent.
- **Numbers are illustrative.** Rates were chosen to fit a lesson; adult collagen turns over in years, not weeks, and stiffness is a power law with no viscoelasticity. Read the traces qualitatively.
- **Randomness is seeded.** Runs are reproducible, but injury sites and cell positions differ between seeds.

## References

1. Bissell MJ, Hall HG, Parry G (1982). How does the extracellular matrix direct gene expression? *J Theor Biol* 99:31–68. https://doi.org/10.1016/0022-5193(82)90388-5
2. Tomasek JJ, Gabbiani G, Hinz B, Chaponnier C, Brown RA (2002). Myofibroblasts and mechano-regulation of connective tissue remodelling. *Nat Rev Mol Cell Biol* 3:349–363. https://doi.org/10.1038/nrm809
3. Humphrey JD, Dufresne ER, Schwartz MA (2014). Mechanotransduction and extracellular matrix homeostasis. *Nat Rev Mol Cell Biol* 15:802–812. https://doi.org/10.1038/nrm3896
4. Hinz B (2015). The extracellular matrix and transforming growth factor-β1: tale of a strained relationship. *Matrix Biol* 47:54–65. https://doi.org/10.1016/j.matbio.2015.05.006
5. Zeigler AC, Richardson WJ, Holmes JW, Saucerman JJ (2016). A computational model of cardiac fibroblast signaling predicts context-dependent drivers of myofibroblast differentiation. *J Mol Cell Cardiol* 94:72–81. https://doi.org/10.1016/j.yjmcc.2016.03.008
6. Loerakker S, Obbink-Huizer C, Baaijens FPT (2014). A physically motivated constitutive model for cell-mediated compaction and collagen remodeling in soft tissues. *Biomech Model Mechanobiol* 13:985–1001. https://doi.org/10.1007/s10237-013-0549-1
7. Metzcar J, Duggan BS, Fischer B, Murphy M, Heiland R, Macklin P (2025). A simple framework for agent-based modeling with extracellular matrix. *Bull Math Biol* 87:43. https://doi.org/10.1007/s11538-024-01408-8 (bioRxiv preprint 2022; `SPEC.md` labels it 2024)
8. Xue M, Jackson CJ (2015). Extracellular matrix reorganization during wound healing and its impact on abnormal scarring. *Adv Wound Care* 4:119–136. https://doi.org/10.1089/wound.2013.0485
