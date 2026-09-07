# Teaching with Tissue Weather

A lesson plan for the *Tissue Weather* interactive (`docs/SPEC.md`) in an undergraduate or graduate tissue-engineering course. The session is built around **dynamic reciprocity**: the two-way loop in which cells build the extracellular matrix (ECM) and the matrix in turn instructs the cells (Bissell, Hall & Parry 1982). The cloud metaphor gets students in the door; the last ten minutes are about where it fails.

## Learning objectives

By the end of the session a student can:

1. **Define** dynamic reciprocity in one sentence and **label** both arrows of the loop on a diagram of the simulation (cells → matrix: deposition, degradation, alignment; matrix → cells: stiffness, tension, stored growth factor).
2. **Predict**, before pressing Play, which way the flux gauge will lean for a given dial setting, and **name** the readout that should move first.
3. **Explain** why fibroblasts become myofibroblasts only when tension and TGF-β act together, using the activation trace as evidence (Tomasek et al. 2002; Hinz 2015).
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

Use 5 days per second for watching and 20 for the eight-week stretches.

## Guided experiments

### 1. Scaffold to tissue (maturation)

**Setup.** Provisional isotropic matrix; bath 0.5, load 0.6, protease 0.4, 160 cells.
**Do.** Play for four weeks watching fiber colour, alignment and stiffness. Pause and ask which changed first.
**Expect.** Density rises; fibers rotate toward the load arrows and turn amber over four to eight weeks; stiffness climbs; cells shift from blue to orange. Alignment leads maturity, because load rotates fibers directly while crosslinking waits on time and activated cells.
**Discuss.** Stiffness and activation rise together; which drives which? Students should propose a test: zero the load and see whether the bath alone activates the cells. The alignment rule caricatures models in which cell traction and applied stretch remodel collagen orientation in engineered tissues (Loerakker, Obbink-Huizer & Baaijens 2014).

### 2. Unloading (disuse atrophy)

**Setup.** Matured state; load 0, bath 0.2, protease 0.5.
**Do.** Predict the gauge and the cell colour before pressing Play. Run six weeks.
**Expect.** Cells fade toward blue within days; the gauge tips to evaporating; density falls and alignment slowly decays; amber fibers outlast pale ones.
**Discuss.** Nothing was added to the dish, so why do the same cells switch from building to dismantling? Under-tensioned cells secrete more protease and less collagen, the mechanoregulation half of matrix homeostasis (Humphrey, Dufresne & Schwartz 2014). Clinical analogue: a limb in a cast.

### 3. Fibrosis (runaway and hysteresis)

**Setup.** Provisional matrix; bath 0.9, load 0.3, protease 0.2.
**Do.** Run four weeks. Without pausing, drop the bath to 0.2 and run four more. Sketch stiffness and activation against time.
**Expect.** Dense, stiff, poorly aligned matrix by week four. After the bath falls, activation and stiffness may dip but stay high; the tissue does not retrace its path.
**Discuss.** What holds the cells on, if not the growth factor? Two things: stiff matrix raises the tension cells feel, and degrading matrix releases growth factor stored inside it. Hinz (2015) describes latent TGF-β1 held in the matrix and activated by cell contraction against a stiff substrate, a positive-feedback loop he argues underlies fibrosis; network models predict the same TGF-β–mechanics crosstalk (Zeigler et al. 2016).

### 4. Wound healing

**Setup.** Mature tissue; press Injure.
**Do.** Turn on the growth-factor and protease layers. Watch the wound for a week, then run eight weeks.
**Expect.** A teal and magenta flare in the hole; nearby cells activate and wander in; pale tangled fibers fill the gap within days and mature slowly without regaining their neighbours' alignment.
**Discuss.** The hole refills, so why is it a scar? In skin, remodelling takes many months and the scar never regains the strength or flexibility of the original tissue (Xue & Jackson 2015). The model shows one reason: fibers laid into an empty hole have nothing to align with.

### 5. Sandbox

**Setup.** Nearly empty cube, all dials mid.
**Do.** Predict aloud, run one week, then adjust one dial at a time until the gauge sits near zero.
**Expect.** Several such settings exist: some idle (few cells, low bath), some busy (high deposition matched by high degradation).
**Discuss.** Which is a healthy tissue? Homeostasis is the busy one.

## Three common misconceptions

**1. "The matrix is inert scaffolding; the cells are the only actors."** Unloading changes only the load on the matrix, nothing about the cells directly, yet the cells switch behaviour within days. The intro panel names the return arrow: stiffness, tension and stored growth factor are messages from the matrix (Bissell, Hall & Parry 1982; Hinz 2015).

**2. "Equilibrium means nothing is happening."** The gauge shows deposition and degradation separately, so a steady density with both rates high looks different from one with both near zero. The sandbox asks students to find both and decide which is a living tissue (Humphrey, Dufresne & Schwartz 2014).

**3. "Remove the cause and the effect reverses."** In fibrosis, students lower the bath and watch stiffness stay up while the equilibrium sentence reports that the cells are still activated, and why. Mature matrix resists proteases, as crosslinked collagen does, so the way down is not the way up (Tomasek et al. 2002; Hinz 2015).

## Assessment: predict–observe–explain worksheet

Each pair gets a sheet with two scenarios, unloading and fibrosis, and three columns.

- **Predict** (before Play): sketch density, alignment, stiffness and activation over eight weeks; circle which way the gauge leans at day 1 and day 28.
- **Observe**: record the four readouts at days 0, 7, 28 and 56, plus the equilibrium sentence at day 28.
- **Explain**: for each readout that departed from the prediction, name the arrow of the loop responsible and the mechanism (tension → protease; stiffness → activation; crosslinking → protease resistance; degradation → growth-factor release).

Grade only the Explain column: an honest wrong prediction plus a mechanistic explanation earns full credit, and a strong answer cites a specific readout as evidence. Graduate extension: export the JSON trajectory and find the day deposition/degradation crossed 1.

## What the model leaves out

- **The ECM is a summary, not a structure.** Each voxel stores density, anisotropy, orientation and a mature fraction, after the PhysiCell-ECM approach of Metzcar et al. (2025); there are no individual fibers, fibronectin, proteoglycans or basement membranes. Degradation thins a voxel without changing its alignment, by construction.
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
