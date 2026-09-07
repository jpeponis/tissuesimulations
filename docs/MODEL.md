# Tissue Weather — scientific grounding of the model (v0.1)

Companion to `docs/SPEC.md` §1. Section 2 transcribes the equations of SPEC §1.2–1.5 and annotates
each term with the process it stands for and the papers that justify its form. Section 3 tabulates
every parameter against measured ranges. Section 4 lists concrete changes where the spec's defaults
or functional forms are inconsistent with the literature. All links resolve to a DOI or PubMed record.

---

## 1. The biology in plain language

### 1.1 Dynamic reciprocity
Bissell, Hall and Parry (1982) proposed that the extracellular matrix (ECM) acts on the cell through
transmembrane receptors and the cytoskeleton to change gene expression, and that the changed cell then
rebuilds the ECM, "which would affect the cell, which…" — they named the loop *dynamic reciprocity*
([J Theor Biol 99:31](https://doi.org/10.1016/0022-5193%2882%2990388-5)). Integrins, discovered shortly
after, are the predicted receptors ([Xu, Boudreau & Bissell 2009](https://doi.org/10.1007/s10555-008-9178-z));
Schultz et al. (2011) recast the whole wound-healing cascade as dynamic reciprocity
([Wound Repair Regen 19:134](https://doi.org/10.1111/j.1524-475X.2011.00673.x)). In the simulation the
loop is literal: cells read `rho`, `E`, `g` (§2.3) and write `T`, `rhoMat`, `g`, `m` (§2.2–2.4).

### 1.2 Tensional homeostasis
Fibroblasts embedded in 3D collagen actively regulate matrix tension: an externally imposed load
increase is answered within minutes by reduced cell contraction, a decrease by increased contraction
(Brown et al. 1998, [J Cell Physiol 175:323](https://doi.org/10.1002/%28SICI%291097-4652%28199806%29175:3%3C323::AID-JCP10%3E3.0.CO;2-6)).
Reviews: [Humphrey, Dufresne & Schwartz 2014](https://doi.org/10.1038/nrm3896);
[Eichinger et al. 2021](https://doi.org/10.1007/s10237-021-01433-9) (the homeostatic tension of tissue
equivalents rises with collagen concentration and cell density); [Stamenović & Smith 2020](https://doi.org/10.1039/d0sm00763c).
Loss of tension is catabolic: fibroblasts in free-floating versus restrained collagen lattices show
4× higher collagenase activity and 4–6× lower collagen synthesis (Lambert et al. 1992, Lab Invest 66:444,
[PMID 1316527](https://pubmed.ncbi.nlm.nih.gov/1316527/)); restrained lattices induce a "synthetic"
programme that simultaneously suppresses proteolysis ([Kessler et al. 2001](https://doi.org/10.1074/jbc.M101602200));
stress-deprived tendon cells up-regulate MMP-13 within 24–48 h and shift their mechanostat set point
([Arnoczky et al. 2008](https://doi.org/10.1007/s11999-008-0264-x)); cyclic stretch synergises with
biochemical agonists to suppress MMP secretion by cardiac fibroblasts
([Rogers et al. 2021](https://doi.org/10.1016/j.mbplus.2020.100055)). The spec's `tensionSat`
variable and the `mAct·(1 − tensionSat)` protease source encode exactly this "under-tension → MMP" arm.

### 1.3 Fibroblast → myofibroblast activation
Two inputs are required: TGF-β1 **and** a mechanically resistant matrix
([Tomasek et al. 2002](https://doi.org/10.1038/nrm809); [Younesi et al. 2024](https://doi.org/10.1038/s41580-024-00716-0)).
TGF-β1 induces α-smooth-muscle actin (α-SMA) in vivo and in vitro
([Desmoulière et al. 1993](https://doi.org/10.1083/jcb.122.1.103)); in cardiac fibroblasts 40–600 pM
(≈1–15 ng/mL) raises α-SMA ~3-fold and collagen output ~2-fold after 24–48 h, and the switch is not
reversed by withdrawal ([Petrov et al. 2002](https://doi.org/10.1161/hy0202.103268)). α-SMA is recruited
to stress fibres only above a stiffness threshold: substrates ≤ 11 kPa keep it cytosolic, while rat
granulation tissue measures ~18 kPa at day 7 rising to ~29 kPa at day 9
([Goffin et al. 2006](https://doi.org/10.1083/jcb.200506179)); the working thresholds are ~3–5 kPa
(proto-myofibroblast) and ~16–20 kPa (α-SMA-positive myofibroblast)
([Hinz 2010](https://doi.org/10.1016/j.jbiomech.2009.09.020)). Myofibroblast contraction itself frees
latent TGF-β1 from the matrix, but only on substrates ≥ 9 kPa, not on 5 kPa "normal dermis"
([Wipff et al. 2007](https://doi.org/10.1083/jcb.200704042)); pre-strained matrix releases more
([Klingberg et al. 2014](https://doi.org/10.1083/jcb.201402006)); MMP-2/-9 also cleave the latent complex
(Yu & Stamenkovic 2000, Genes Dev 14:163, [PMID 10652271](https://pubmed.ncbi.nlm.nih.gov/10652271/)).
Stiffness additionally removes the autocrine COX-2/PGE₂ brake
([Liu et al. 2010](https://doi.org/10.1083/jcb.201004082)) — the "feedback amplification" that scenario 3
is built to show ([Hinz 2015](https://doi.org/10.1016/j.matbio.2015.05.006)).

Timing and reversibility: splinting a wound makes myofibroblast markers appear earlier and persist;
releasing tension removes F-actin in 2 d, α-SMA in 3 d and ED-A fibronectin in 5 d
([Hinz et al. 2001](https://doi.org/10.1016/S0002-9440%2810%2961776-2)). In normal wounds myofibroblasts
appear around day 4–7 and disappear by apoptosis at 2–4 weeks as granulation tissue becomes scar
(Desmoulière et al. 1995, [PMID 7856739](https://pubmed.ncbi.nlm.nih.gov/7856739/)). Activation has
memory: 3 weeks on stiff substrates keeps lung fibroblasts fibrotic for ≥ 2 weeks after return to soft
([Balestrini et al. 2012](https://doi.org/10.1039/c2ib00149g)); chronically activated human cardiac
myofibroblasts do not revert on 2 kPa or under TGF-β-receptor inhibition
([Hall et al. 2023](https://doi.org/10.1038/s41598-023-39369-y)), whereas in growing microtissues the
transition reverses within ~10 µm of the tensed growth front
([Kollmannsberger et al. 2018](https://doi.org/10.1126/sciadv.aao4881)).
Activated cells migrate less ([Rønnov-Jessen & Petersen 1996](https://doi.org/10.1083/jcb.134.1.67)) and pull
harder ([Hinz et al. 2001, Mol Biol Cell](https://doi.org/10.1091/mbc.12.9.2730)) — the basis of
`v = v0(1 − 0.6·alpha)` and of the `kappa·alpha` self-tension term.

### 1.4 ECM maturation sequence and the MMP/TIMP balance
Fibrin/fibronectin provisional matrix (hours–days) → fibroblast invasion and collagen-III-rich granulation
tissue (days 3–7) → collagen I accumulation (weeks) → lysyl-oxidase (LOX) cross-linking and remodelling
(months to a year) ([Gurtner et al. 2008](https://doi.org/10.1038/nature07039);
[Xue & Jackson 2015](https://doi.org/10.1089/wound.2013.0485)). Normal adult dermis is ~20% type III
([Clore et al. 1979](https://doi.org/10.3181/00379727-161-40548)); granulation tissue is III-enriched for
weeks ([Merkel et al. 1988](https://doi.org/10.3181/00379727-187-42694)); in human excisional wounds the
III/I ratio rises to 6 weeks and is still 70% above baseline at 6 months, while the mature cross-link
HHL falls 4-fold and pyridinoline slowly rises ([Robins et al. 2003](https://doi.org/10.1046/j.1523-1747.2003.12373.x)).
Collagen synthesis in rat wounds stays elevated for months while content plateaus by ~3 weeks
(Madden & Peacock 1968, Surgery 64:288, [PMID 5658731](https://pubmed.ncbi.nlm.nih.gov/5658731/)) —
scar is a high-turnover steady state, the "cloud" of the metaphor. Tensile strength reaches ~50% of its
final value at 6 weeks and plateaus near 80% of unwounded skin by ~3 months
([Levenson et al. 1965](https://doi.org/10.1097/00000658-196502000-00019)).

Cross-linking: LOX forms immature Schiff-base cross-links within a day; 0.1 cross-link per molecule
already gives 2–3× resistance to collagenase ([Vater, Harris & Siegel 1979](https://doi.org/10.1042/bj1810639));
maturation to trivalent pyridinoline/HHL takes weeks to months
([Bailey et al. 1998](https://doi.org/10.1016/s0047-6374%2898%2900119-5); [Eyre et al. 1984](https://doi.org/10.1146/annurev.bi.53.070184.003441));
TGF-β1 induces LOX in fibroblasts (Hong et al. 1999, [PMID 10616214](https://pubmed.ncbi.nlm.nih.gov/10616214/));
LOX cross-linking stiffens matrix ([Levental et al. 2009](https://doi.org/10.1016/j.cell.2009.10.027)).
Mature collagen is then extraordinarily long-lived: half-life ~15 y in skin, 117 y in cartilage
([Verzijl et al. 2000](https://doi.org/10.1074/jbc.M006700200)); the adult Achilles core is essentially not
renewed ([Heinemeier et al. 2013](https://doi.org/10.1096/fj.12-225599)); 34–198 y in equine tendons
([Thorpe et al. 2010](https://doi.org/10.1074/jbc.M109.077503)).

Proteolysis: MMPs are secreted as zymogens, activated by other proteases and inhibited 1:1 by TIMPs
(k_on ≈ 10⁵ M⁻¹s⁻¹, [Olson et al. 1997](https://doi.org/10.1074/jbc.272.47.29975); kinetics in
[Vempati et al. 2007](https://doi.org/10.1074/jbc.M611500200); wound biology in
[Caley et al. 2015](https://doi.org/10.1089/wound.2014.0581)). Post-injury MMP-9 bursts clear within ~1 week
([Kaden et al. 2003](https://doi.org/10.1159/000070670)); TIMP-1 plasma half-life is ~1 h
([Batra et al. 2012](https://doi.org/10.1371/journal.pone.0050028)). Strained fibrils resist collagenase
([Bhole et al. 2009](https://doi.org/10.1098/rsta.2009.0093); [Flynn et al. 2010](https://doi.org/10.1371/journal.pone.0012337)).

**Representative timescales**

| Process | Timescale | Source |
|---|---|---|
| Fibrin clot → provisional matrix invaded by fibroblasts | hours – 3 d | Gurtner 2008 |
| Active TGF-β1 half-life in plasma (latent complex) | 2–3 min (>100 min) | [Wakefield 1990](https://doi.org/10.1172/JCI114932) |
| α-SMA induction by TGF-β1 in vitro | 24–48 h | Petrov 2002 |
| Loss of myofibroblast markers after tension release | 2–5 d | Hinz 2001 |
| MMP-13 induction on stress deprivation | 24–48 h | Arnoczky 2008 |
| Myofibroblasts appear / cleared by apoptosis (wound) | day 4–7 / 2–4 wk | Desmoulière 1995 |
| Granulation tissue stiffens to 18–30 kPa | day 7–9 | Goffin 2006 |
| Wound collagen content plateau (rat) | ~3 wk | Madden 1968 |
| Wound strength 50% / plateau (~80%) | 6 wk / 3 mo | Levenson 1965 |
| Collagen III excess normalises | > 6 mo | Robins 2003 |
| Immature → mature cross-links | weeks – months | Bailey 1998 |
| Mature collagen half-life | 15 y (skin) – centuries (tendon) | Verzijl 2000; Heinemeier 2013 |
| Mechanical memory of myofibroblasts | ≥ 2 wk after 3-wk priming | Balestrini 2012 |

---

## 2. Model equations (SPEC §1.2–1.5), annotated

Notation: voxel fields are functions of position; cells are indexed by $i$; $\varepsilon$ is the load dial
`strain`; $P$ the protease dial; $\hat z$ the load axis; $\delta_i$ the indicator of cell $i$'s voxel;
time in days.

### 2.1 ECM state per voxel (§1.2)

Structure tensor $T$ (symmetric, positive semi-definite, 3×3), density and anisotropy:

$$\rho = \operatorname{tr} T,\qquad
\mathrm{FA} = \sqrt{\tfrac32}\;\frac{\lVert T - \tfrac{\rho}{3} I\rVert_F}{\lVert T\rVert_F},\qquad
\hat f = \text{principal eigenvector of } T .$$

*Annotation.* $T = \rho\,\Omega$ with $\Omega$ (trace 1) the fibre orientation tensor of
[Barocas & Tranquillo 1997](https://doi.org/10.1115/1.2796072) and of the Eindhoven remodelling models
([Driessen et al. 2008](https://doi.org/10.1007/s10237-007-0078-x)). FA is the diffusion-tensor-imaging
fractional anisotropy. The three Metzcar ECM-element variables map one-to-one — density $\rho \leftrightarrow \operatorname{tr}T$,
anisotropy $a \leftrightarrow \mathrm{FA}$, orientation $f \leftrightarrow \hat f$
([Metzcar et al. 2024](https://doi.org/10.1007/s11538-024-01408-8)) — in one rotation-invariant object.
Degradation scales $T$ isotropically (alignment survives thinning), deposition adds oriented mass,
traction and load rotate $T$ at fixed trace.

Maturity: $\rho_{mat}\in[0,\rho]$ (cross-linked collagen-I-like pool), $\phi_{mat}=\rho_{mat}/\rho$.
Stiffness (kPa):

$$E = E_0 + E_{scale}\,\rho^{2}\,(1 + k_{Mat}\,\phi_{mat})\,(1 + k_{Strain}\,\varepsilon).$$

*Annotation.* $E\propto\rho^2$: acellular collagen gels follow $E\propto c^{2.1-2.2}$ over 0.5–12 kPa
([Raub et al. 2010](https://doi.org/10.1016/j.actbio.2010.07.004)); fibrin rigidity $\propto c^{2}$
([Fukada & Kaibara 1973](https://doi.org/10.3233/bir-1973-10207)), exponent ~1–1.2 at ≤3 mg/mL
([Benkherourou et al. 2000](https://doi.org/10.1109/10.880098)). Cross-link factor: Levental 2009, Vater 1979.
Strain factor: linearised strain-stiffening of biopolymer networks
([Storm et al. 2005](https://doi.org/10.1038/nature03521)). With the defaults: $\rho=0.15$ immature → 0.75 kPa
(fibrin-like), $\rho=0.5$ → 5 kPa (dermis-like), $\rho=1$ immature → 20 kPa (granulation tissue),
$\rho=1$ mature → 80 kPa (scar), see §3.

### 2.2 Diffusible fields (§1.3)

$$\partial_t g = D_g\nabla^2 g + k_{bath}(G_{ext}-g) + k_{Gcell}\sum_i \alpha_i\,\delta_i + k_{Grel}\,\mathrm{deg} - k_{Gdec}\,g$$

$$\partial_t m = D_m\nabla^2 m + \sum_i\big[m_{basal}P + m_{act}(1-\mathrm{tensionSat}_i)\big]\delta_i + (\text{injury burst}) - k_{Mdec}\,m$$

*Annotation.* `g` is active, cell-available TGF-β1: bath = exogenous TGF-β/serum (Desmoulière 1993);
autocrine term = contraction-mediated release by activated cells on stiff matrix (Wipff 2007; Hinz 2015);
release on degradation = MMP-2/-9 liberation of matrix-stored latent TGF-β (Yu & Stamenkovic 2000);
decay = minutes-scale clearance of the active form (Wakefield 1990). `m` is net MMP activity: basal
production scaled by the MMP/TIMP dial (Caley 2015); the under-tension term is Lambert 1992 / Arnoczky 2008 /
Rogers 2021; the injury burst is neutrophil MMP-8/-9 and platelet TGF-β (Xue & Jackson 2015). Zero-flux
walls, explicit 6-neighbour diffusion — see §4.7 for the stability constraint this imposes on $D$.

### 2.3 Cells (§1.4)

Sensed tension and activation:

$$\mathrm{tension}_i = \frac{E_{loc}}{E_{ref}}\,(\varepsilon + \kappa\,\alpha_i),\qquad
\mathrm{tensionSat}_i = \frac{\mathrm{tension}_i}{1+\mathrm{tension}_i}$$

$$\alpha_i^{*} = \operatorname{clamp}\!\Big(a_E\,\mathrm{tensionSat}_i + a_G\,\frac{g}{g+g_{half}} - a_{soft}\,[E_{loc}<E_{soft}],\;0,\;1\Big),\qquad
\frac{d\alpha_i}{dt} = \frac{\alpha_i^{*}-\alpha_i}{\tau_\alpha}.$$

*Annotation.* Cell-sensed stress ≈ stiffness × (imposed + self-generated strain) is the tensional-homeostasis
picture (Brown 1998; Humphrey 2014); $\kappa\alpha$ is the higher traction of α-SMA-positive cells
(Hinz 2001, Mol Biol Cell). The activation target is an OR-type sum of saturating inputs — the
normalized-Hill logic (defaults $n=1.4$, $EC_{50}=0.5$, $\tau=1$) of
[Kraeutler et al. 2010](https://doi.org/10.1186/1752-0509-4-157) that underlies the 91-node cardiac fibroblast
network of [Zeigler et al. 2016](https://doi.org/10.1016/j.yjmcc.2016.03.008), which predicted and validated
tension–TGF-β cross-talk. The two-input requirement (TGF-β AND stiffness) is Tomasek 2002 / Wipff 2007;
the soft-matrix penalty stands for the 3–5 / 16–20 kPa thresholds (Goffin 2006; Hinz 2010).

Secretion into the cell's voxel:

$$s_i = s_{basal} + s_{act}\,\alpha_i,\qquad
D_i = (1-\mathrm{pol}_i)\,\tfrac{I}{3} + \mathrm{pol}_i\,\hat p_i\hat p_i^{\mathsf T},\qquad
\mathrm{pol}_i = \mathrm{pol}_{base} + \mathrm{pol}_{act}\,\alpha_i .$$

*Annotation.* TGF-β/myofibroblast collagen output ~2× (Petrov 2002), restrained vs relaxed 4–6× (Lambert 1992).
Deposition oriented along the cell axis is the one rule that reproduces in-vivo alignment heterogeneity in the
Holmes infarct agent-based model ([Richardson & Holmes 2016](https://doi.org/10.1016/j.bpj.2016.04.014)) and is
used in the Eindhoven heart-valve model ([Ristori et al. 2018](https://doi.org/10.1016/j.actbio.2018.08.040)).

Traction realignment of the local voxel (trace-preserving):

$$\frac{dT}{dt}\Big|_{traction} = k_{Align}\,\alpha_i\,\big(\rho\,\hat p_i\hat p_i^{\mathsf T} - T\big).$$

*Annotation.* Cell traction reorganises fibres along the cell axis — the mechanochemical coupling of
[Murray & Oster 1984](https://doi.org/10.1007/BF00277099) reduced to its kinematic consequence. The same
relaxation-to-target form is Dallon's $d\theta/dt = \kappa\lVert f\rVert\sin(\phi-\theta)$
([Dallon, Sherratt & Maini 1999](https://doi.org/10.1006/jtbi.1999.0971)) and Metzcar's SM Eqs. 5–6,
$df/dt = -r_{f0}\,s_{cell}(1-a)(f-\hat d)$, $da/dt = r_{a0}\,s_{cell}(1-a)$ — driven by *migration speed*
there, by *activation* here (contractile myofibroblasts remodel most; Rouillard & Holmes 2012).

Migration:

$$v_i = v_0\,(1-0.6\,\alpha_i)\Big(1 - \tfrac{0.5\,\rho}{\rho+0.5}\Big),\qquad
d\hat p_i = \sigma\,d\mathbf W_\perp + k_{Guide}\,\mathrm{FA}\,(\pm\hat f - \hat p_i)\,dt + k_{LoadAlign}\,\varepsilon\,(\hat z - \hat p_i)\,dt .$$

*Annotation.* Slower when activated (Rønnov-Jessen 1996) and when embedded in dense matrix (Zaman 2006).
Persistent random walk plus contact guidance weighted by anisotropy: Dickinson, Guido & Tranquillo 1994
([Ann Biomed Eng 22:342](https://doi.org/10.1007/BF02368241)); Barocas & Tranquillo 1997; Metzcar SM Eq. 8–9,
$d_{actual} = (1-\gamma)C_1 d_\perp + C_2 f$ with $\gamma = a\cdot s$. Cells align with a static uniaxial
constraint/stretch in 3D ([Eastwood et al. 1998](https://doi.org/10.1002/%28SICI%291097-0169%281998%2940:1%3C13::AID-CM2%3E3.0.CO;2-G);
[Foolen et al. 2012](https://doi.org/10.1016/j.biomaterials.2012.06.103) — *cyclic* stretch on 2D or at free
surfaces gives perpendicular "stretch avoidance" instead, which the static model does not cover).
[Rouillard & Holmes 2012](https://doi.org/10.1113/jphysiol.2012.229484) showed the mechanical cue must
dominate to reproduce infarct collagen alignment.

### 2.4 ECM update per voxel (§1.5)

$$\mathrm{depos} = \sum_{i\in\text{voxel}} s_i D_i,\qquad
\mathrm{deg} = k_{Deg}\,m\,(\rho_{new} + r_{Mat}\rho_{mat}),\quad \rho_{new}=\rho-\rho_{mat},\qquad
\mathrm{mat} = k_{Mat0}\,\rho_{new}\,(1 + k_{Lox}\,\alpha_{local})$$

$$\frac{dT}{dt} = \mathrm{depos} - \frac{\mathrm{deg}}{\rho}\,T + k_{LoadFib}\,\varepsilon\,\big(\rho\,\hat z\hat z^{\mathsf T} - T\big)_{\text{trace-preserving}},\qquad
\frac{d\rho_{mat}}{dt} = \mathrm{mat} - k_{Deg}\,m\,r_{Mat}\,\rho_{mat},$$

with clamps $\operatorname{tr}T\le 2$, $0\le\rho_{mat}\le\rho$.

*Annotation.* First-order MMP kinetics on matrix density (Dallon et al. 2001,
[Wound Repair Regen 9:278](https://doi.org/10.1046/j.1524-475x.2001.00278.x);
[McDougall et al. 2006](https://doi.org/10.1098/rsta.2006.1773)); protease resistance of cross-linked collagen
(Vater 1979); LOX-dependent, TGF-β/myofibroblast-enhanced maturation (Hong 1999). The load term is the
strain-based remodelling law of the Eindhoven group — fibres align with the tensile principal-strain direction,
relaxing toward it with a remodelling time constant ([Driessen et al. 2003](https://doi.org/10.1115/1.1590361);
Driessen 2008; [Loerakker et al. 2014](https://doi.org/10.1007/s10237-013-0549-1)) — written as a
relaxation of $T$ toward $\rho\hat z\hat z^{\mathsf T}$. Loerakker 2014 and Ristori 2018 additionally make
*degradation decrease with fibre stretch*, which the spec omits (§4.3).

---

## 3. Parameter table

Physical conversions assume $L = 300\ \mu$m, so $h = 25\ \mu$m (about one fibroblast body width;
cells in 3D are spindles 50–100 µm long) and 1 L/d = 12.5 µm/h.

| Symbol | Spec default | Units | Plausible real range | Source / note |
|---|---|---|---|---|
| `nCells` | 160 (40–400) | cells per (300 µm)³ = 5.9×10³ /mm³ (1.5–15×10³) | dermis 2.1–4.1×10³ /mm³; engineered constructs 1–20×10⁶ /mL (≥8×10⁶ /cm³ favours matrix production) | [Miller et al. 2003](https://doi.org/10.1034/j.1600-0625.2003.00023.x); [Bueno et al. 2007](https://doi.org/10.1016/j.jbiotec.2007.01.005) |
| `rho` | 0–2, 1 ≈ dense tissue | — | native connective tissue ≈ 200 mg/mL collagen; gels 1–10 mg/mL; fibrin clot 0.3% protein | Raub 2010 |
| `E0` | 0.3 | kPa | fibrin 2–4 mg/mL ≈ 0.1–1 kPa; 7.5–30 mg/mL → 7.7–31 kPa; collagen 3–9 mg/mL → 0.5–12 kPa | Benkherourou 2000; [Duong et al. 2009](https://doi.org/10.1089/ten.tea.2008.0319); [PMC9164127](https://pmc.ncbi.nlm.nih.gov/articles/PMC9164127/); Raub 2010 |
| `Escale` (E at ρ=1, immature) | 20 | kPa | granulation tissue ~18 → 29 kPa (d 7–9); normal dermis ~5 kPa; fibrotic lung ≈ 6× normal | Goffin 2006; Wipff 2007; Liu 2010 |
| `kMat` (→ 80 kPa mature) | 3 | — | burn scar 43 vs 10 kPa skin; pathological scars up to 130–170 kPa (elastography); tendon 1.2 GPa (out of range by design) | [JBCR 2019 abstract](https://academic.oup.com/jbcr/article/40/Supplement_1/S215/5372229); [Hang et al. 2021](https://doi.org/10.1038/s41598-021-02730-0); [Maganaris & Paul 1999](https://doi.org/10.1111/j.1469-7793.1999.00307.x) |
| `kStrain` | 1 | — | networks stiffen ≥10× between 0 and 10–20% strain; linear factor is a mild stand-in | Storm 2005 |
| `E_ref`, `Esoft`, `aSoft` | 10 kPa, 1 kPa, 0.2 | — | α-SMA thresholds 3–5 / 16–20 kPa; contraction-activated TGF-β off at 5, on ≥ 9 kPa | Hinz 2010; Goffin 2006; Wipff 2007 — see §4.4 |
| `kappa` | unspecified | — | myofibroblast lattice contraction 63% vs 41% (≈1.5–2×); supermature FA stress ≈4× | Hinz 2001 MBC; Goffin 2006 |
| `aE`, `aG`, `gHalf` | 0.8, 0.8, 0.3 | — | if g=1 ≡ 10 ng/mL (400 pM) then gHalf ≡ 3 ng/mL; effective 40–600 pM; normalized-Hill defaults n=1.4, EC50=0.5 | Petrov 2002; Kraeutler 2010 |
| `tauAlpha` | 1 | d | onset 1–2 d in vitro, day 4–7 in vivo; decay 2–5 d after unloading; memory ≥ weeks | Petrov 2002; Hinz 2001; Balestrini 2012 — see §4.5 |
| `sBasal`, `sAct` | 0.004, 0.05 | ρ·voxel/d/cell | TGF-β ×2, restrained-lattice ×4–6 (ratio 12.5 is high); gross mean deposition ≤ 0.005 ρ/d at full activation — see §4.9 | Petrov 2002; Lambert 1992 |
| `polBase`, `polAct` | 0.2, 0.6 | — | oriented deposition along cell axis required for in-vivo alignment patterns | Richardson & Holmes 2016 |
| `kAlign` | 0.4 | /d | Metzcar reorientation 1–4 min⁻¹ at 0.25–1.25 µm/min (near-instant); cells realign gels within hours–1 d | Metzcar 2024 SM; Eastwood 1998 |
| `v0` | 0.7 L/d = 8.8 µm/h (spec comment says 30 µm/h — **arithmetic error**, 30 µm/h = 2.4 L/d) | L/d | 3D fibroblast speeds 10–30 µm/h: 29.5 µm/h in cell-derived matrix; 0.23 µm/min (14 µm/h) in 0.58 mg/mL collagen under a weak DC field; Metzcar defaults 0.25–1.25 µm/min | [Hakkinen et al. 2011](https://doi.org/10.1089/ten.tea.2010.0273); [Sun et al. 2004](https://doi.org/10.1089/ten.2004.10.1548) |
| `sigma` | 0.6 rad/√d → persistence 2.8–5.6 d | — | directional persistence of fibroblasts in 3D gels: tens of minutes to a few hours | [Burgess et al. 2000](https://doi.org/10.1114/1.259); Dickinson 1994 — see §4.2 |
| `kGuide`, `kLoadAlign` | 2, 1.5 | /d | Metzcar γ = a·s with s ∈ [0,1] (cells fully fibre-guided when a=s=1); mechanical cue must dominate | Metzcar 2024; Rouillard & Holmes 2012 |
| `rCell` | 0.03 L = 9 µm | — | fibroblast body radius 5–10 µm (Holmes ABM uses 5 µm) | Richardson & Holmes 2016 |
| `kDeg`, `rMat` | 0.5 /d, 0.15 | — | new matrix t½ = 1.4 d at m=1 (fibrin cleared in days: ok); mature t½ = 9 d at m=1 vs 15 y in skin, ≥ 6 mo scar remodelling | Verzijl 2000; Robins 2003; Vater 1979 — see §4.3 |
| `kMat0`, `kLox` | 1/14 /d, 2 | — | Schiff-base cross-links ≤ 1–2 d; strength 50% at 6 wk; trivalent cross-links months; TGF-β induces LOX | Vater 1979; Levenson 1965; Bailey 1998; Hong 1999 |
| `kLoadFib` | 0.5 /d | — | remodelling time constants of days–weeks; TE constructs align in 1–3 wk | Driessen 2003/2008; Loerakker 2014 |
| `strain` dial | 0–1 | normalised load | physiological strains 1–8% (tendon 2.5% at maximal isometric load); 1% cyclic strain suppresses MMP-13 | Maganaris 1999; Arnoczky 2008 — dial is a load index, not engineering strain |
| `kBath`, `kGcell`, `kGrel`, `kGdec`, `D_g` | unspecified | — | active TGF-β t½ 2–3 min; free cytokine D ≈ 100 µm²/s; matrix/GAG-bound effective D ≈ 5×10⁻⁴ µm²/s; diffusion strongly restricted near fibroblast-condensed collagen | Wakefield 1990; [Ansorge et al. 2017](https://doi.org/10.1038/s41598-017-05912-x); [Kihara et al. 2013](https://doi.org/10.1371/journal.pone.0082382) |
| `mBasal`, `mAct`, `kMdec`, `D_m` | unspecified | — | TIMP binding fast (k_on 10⁵ M⁻¹s⁻¹); TIMP-1 t½ ≈ 1 h; MMP-9 burst clears in ~days | Olson 1997; Batra 2012; Kaden 2003 → `kMdec` ≈ 1–3 /d |

---

## 4. Recommended changes

1. **Fix the migration-speed conversion.** 30 µm/h is 720 µm/d = 2.4 L/d at L = 300 µm, not 0.7 L/d.
   Keep `v0 = 0.7 L/d` (≈ 9 µm/h, the low end of 3D fibroblast speeds; Hakkinen 2011, Sun 2004) and
   correct the comment, or raise to 1–2 L/d; do not leave the two inconsistent.
2. **Persistence noise is ~50× too weak.** With $\sigma = 0.6$ rad/√d the polarity decorrelation time is
   $1/\sigma^2$ to $2/\sigma^2$ = 2.8–5.6 d; measured fibroblast persistence in 3D gels is tens of minutes
   to hours (Burgess 2000). Use $\sigma \approx 4$–6 rad/√d (τ_p ≈ 1–3 h) and, because $\sigma\sqrt{dt}\approx 0.6$–0.85 rad
   per 0.02 d step, apply it as an exponentially-correlated rotation rather than one large kick.
3. **Mature matrix is far too degradable.** `rMat = 0.15` gives a mature half-life of 9 d at full protease and
   ~1 month at m ≈ 0.3, whereas dermal collagen turns over in ~15 y (Verzijl 2000) and scar keeps remodelling
   for > 6 months (Robins 2003). Set `rMat ≈ 0.01–0.03` (≥ 30–100× protection); Vater's 2–3× is only the
   first day of cross-linking. Add strain protection of aligned, loaded fibres,
   $\mathrm{deg} \leftarrow \mathrm{deg}\,[1 - k_{prot}\,\varepsilon\,(\hat f\cdot\hat z)^2]$ with $k_{prot}\approx 0.5$
   (Flynn 2010; Bhole 2009; Loerakker 2014) — this is also what makes the "unloading" scenario shed
   unloaded fibres first.
4. **Replace the 1 kPa step and the 10 kPa normaliser with one stiffness gate.**
   $H_E = E^n/(E^n + E_{1/2}^n)$ with $E_{1/2}\approx 12$ kPa, $n = 2$–3 reproduces "off at 5 kPa, on at
   ≥ 16–20 kPa" (Goffin 2006; Wipff 2007; Hinz 2010). Use $H_E$ both in `alphaStar` (in place of
   `aSoft·(E<Esoft)`) and to gate the autocrine/ECM TGF-β release, $k_{Gcell}\,\alpha\,H_E$ (Wipff 2007;
   Klingberg 2014). The resulting $E \to \alpha \to g \to \alpha$ loop with $n \ge 2$ is what produces
   genuine bistability/hysteresis in scenario 3; with the current linear-saturating terms the hysteresis
   will be weak (Kraeutler 2010 notes bistability requires nonlinear activation).
5. **Slow and asymmetric activation.** `tauAlpha = 1 d` is 2–3× too fast: α-SMA needs 24–48 h to appear and
   2–5 d to disappear after unloading (Petrov 2002; Hinz 2001). Use τ_on ≈ 2 d, τ_off ≈ 4–5 d, and add a
   slow memory variable (τ ≈ 21 d) that lowers $E_{1/2}$ for primed cells (Balestrini 2012; Hall 2023) so
   that fibrotic tissue does not relax merely because `Gext` is lowered.
6. **Speed–density law should be biphasic.** Fibroblasts cannot move in near-empty matrix (nothing to grip)
   and are blocked by very dense matrix; Metzcar uses a tent $s(\rho)$ with $\rho_l=0,\ \rho_{ideal}=0.5,\ \rho_h=1$;
   in 1–4 mg/mL collagen migration *increased* with concentration (Miron-Mendoza 2010; Zaman 2006). Use
   $v = v_0(1-0.6\alpha)\max\{0.2,\,1-|\rho-\rho^*|/\rho^*\}$, $\rho^*\approx 0.5$ (the floor keeps the
   empty-sandbox scenario alive).
7. **Diffusion: state $D$ and respect stability, or go implicit.** The explicit 6-neighbour scheme requires
   $D \le h^2/(6\,dt) = 0.058\ L^2/d \approx 0.06\ \mu m^2/s$, three orders below free TGF-β diffusion
   (~100 µm²/s, Ansorge 2017 — which would homogenise a 300 µm cube in ~2–3 min). Treat `g` as
   matrix-bound/available TGF-β with small effective $D$ and fast decay (decay length
   $\sqrt{D_g/k_{Gdec}}$ ≈ 1–3 voxels, $k_{Gdec}\approx 5$–20 /d), or sub-step / solve implicitly; likewise
   `kMdec ≈ 1–3 /d` for `m`. These constants are unspecified in the spec and must be fixed for reproducibility.
8. **Hill exponent on `g`.** $g/(g+g_{half})$ is $n = 1$; the normalized-Hill default $n = 1.4$, $EC_{50} = 0.5$
   (Kraeutler 2010) or $n = 2$ gives the switch-like TGF-β response seen experimentally (no effect at
   ≤ 40 pM, full at ≥ 600 pM; Petrov 2002).
9. **Check the deposition/degradation budget before trusting scenario 1.** With 160 fully activated cells,
   1728 voxels and `sAct = 0.05`, gross deposition averages ≤ 0.005 ρ/d per voxel; with $k_{Deg}m\approx 0.2$/d
   the immature pool saturates near 0.02 and the mature pool near 0.1, so "provisional → dense in 4–8 weeks"
   may not happen. Target a net ≈ 0.015–0.02 ρ/d (wound strength 50% at 6 weeks; Levenson 1965) by raising
   `sAct` to ~0.1–0.15 or lowering `kDeg` to ~0.2 /d, and verify with `tools/run_headless.mjs`.
10. **Couple secretion to tension too.** Relaxed lattices cut collagen synthesis 4–6× as well as raising
    collagenase (Lambert 1992; Kessler 2001): $s_i \leftarrow s_i\,(0.3 + 0.7\,\mathrm{tensionSat}_i)$ makes
    unloading shrink the cloud from both sides.

---

## 5. Known simplifications (and what relaxing each would take)

- **No proliferation or apoptosis.** Fibroblast doubling time is 2–6 d depending on matrix stiffness
  ([Hadjipanayi et al. 2009](https://doi.org/10.1002/term.136)) and myofibroblasts are cleared by apoptosis
  at 2–4 weeks (Desmoulière 1995): add stiffness-gated division and tension-loss-gated death.
- **Static uniaxial load, no mechanics.** Strain is a dial, not a solved field: coupling to a coarse
  spring-network/finite-element solve would give heterogeneous strain, stress shielding by dense voxels,
  and cyclic-stretch avoidance (Foolen 2012).
- **One growth factor.** TGF-β stands for the whole cytokine milieu: adding PDGF (chemotaxis),
  IL-1/TNF (inflammatory MMP induction) and PGE₂ (autocrine brake; Liu 2010) would separate wound-phase
  behaviours the spec now lumps into `Gext` and the injury burst.
- **Nearest-voxel sensing.** A 50–100 µm spindle spans 2–4 voxels of 25 µm: trilinear sampling or a line
  integral along $\hat p$ would remove grid artefacts in contact guidance.
- **No fluid, oxygen or nutrient transport.** Diffusion-limited viability sets in at 200 µm–2 mm in
  avascular constructs; an O₂ field would bound `nCells` and add necrotic cores.
- **Lumped MMP/TIMP without zymogen activation.** A pro-MMP/MMP/TIMP triplet
  (Vempati 2007) would give the delayed, biphasic protease bursts seen after injury.
- **Isotropic degradation.** Real proteolysis spares strained, aligned fibrils (Flynn 2010); §4.3 gives
  the one-line anisotropic fix.
- **Provisional matrix = "immature collagen".** Fibrin is not collagen (different integrins, plasmin
  clearance, 0.1–1 kPa): a separate fibrin field would let the fibrin → collagen III → I sequence be shown
  explicitly.
- **Scalar stiffness, single cell type.** $E$ ignores anisotropy (a transversely isotropic
  $E_\parallel > E_\perp$ from $T$ is straightforward; Barocas & Tranquillo 1997), and the injury burst
  stands in for the macrophage agents that trigger fibroblast deposition in Metzcar's fibrosis vignette.

---

## 6. Mapping the cloud metaphor

| Weather dial | Model quantity | Biology |
|---|---|---|
| Temperature | protease/deposition ratio (`proteaseDial`, `m`) | MMP vs TIMP balance, inflammation: high "temperature" evaporates fibres |
| Pressure | `strain` | mechanical load; compresses the cloud into aligned "streaks", raises sensed tension |
| Humidity | `Gext`, `g` | TGF-β/serum supply; the vapour from which droplets condense |
| Condensation nuclei | cells (`nCells`) | fibroblasts as the sites where matrix condenses |
| Droplets / vapour | `T`, `rho` / degraded fragments and soluble precursors | ECM in dynamic equilibrium with its monomers |

Where the analogy breaks — the points to make explicitly in class:

1. **Turnover is slow, and slower as the cloud matures.** Water re-equilibrates in seconds; provisional
   matrix in days, scar over months, mature collagen over decades to centuries (Verzijl 2000; Heinemeier
   2013). The `rhoMat` pool exists to give the cloud a memory of its own history.
2. **Cross-linking is one-way.** LOX cross-links are covalent; a cross-linked fibre does not "evaporate"
   when humidity drops, it must be cut (Vater 1979). This asymmetry — plus mechanical memory of the
   cells (Balestrini 2012) — is why scenario 3 shows hysteresis: lowering `Gext` does not undo fibrosis.
3. **The droplets change the weather.** Cells are not passive nuclei: they raise their own "humidity"
   (autocrine TGF-β), release humidity stored in the cloud by pulling on it (latent TGF-β, Wipff 2007),
   and change their own rules (`alpha`) in response to the cloud they built. That feedback — dynamic
   reciprocity (Bissell 1982) — has no atmospheric counterpart.
4. **Clouds have no grain; tissue does.** Fibre alignment (`FA`, $\hat f$) follows load and cell traction
   (Driessen 2003; Richardson & Holmes 2016) and, once set, steers the cells that made it (contact
   guidance, Dickinson 1994).
5. **Scale.** Weather variables are averages over cubic kilometres; here a 25 µm voxel is written by one
   or two cells, so the "cloud" is granular and stochastic by construction.
