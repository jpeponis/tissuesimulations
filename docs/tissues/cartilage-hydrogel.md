# Tissue definition: articular cartilage in a degrading hydrogel (v0.1 research spec)

Companion to `docs/SPEC.md` §1 and `docs/MODEL.md`. This document specifies a second **tissue
definition** for the Tissue Weather engine: chondrocytes photo-encapsulated in a synthetic
(PEG-like) hydrogel that degrades while the cells build a proteoglycan gel and a fine collagen II
network. It is deliberately the anti-fibrous case: round, non-motile cells; an isotropic matrix
whose stiffness comes from osmotic swelling rather than fibre tension; a scaffold that must
vanish; and dials (dynamic compression, oxygen, TGF-β3, crosslink density, inflammation) that
have no counterpart in the default fibroblast tissue. Every quantitative claim carries an inline
DOI. Engine vocabulary (voxel cube, species densities on a 0–1.5 scale with 1 ≈ native content,
diffusible fields with bath exchange, cell agents with a state axis, dials, scenarios, flux
gauge) is used throughout; §2 is written so it can be transcribed into a `tissue` object.

---

## 1. The biology in plain language

**The chondrocyte and its two matrices.** Hyaline cartilage is ~65–80 % water; its dry mass is
~60 % collagen (mostly type II) and 10–15 % of the wet weight is proteoglycan (aggrecan), with
chondrocytes occupying only ~2 % of the volume
([Sophia Fox et al. 2009](https://doi.org/10.1177/1941738109350438)). The two matrix families
do different jobs. Aggrecan's sulfated GAG chains carry a huge fixed negative charge that draws
water in; the resulting swelling pressure is resisted by the collagen II network, and compressive
stiffness arises from that balance ([Maroudas 1976](https://doi.org/10.1038/260808a0)). In
developing bovine cartilage the confined-compression modulus rises 180 % from fetus to adult with a
2–3-fold rise in collagen and *no* change in GAG, so collagen governs how well the GAG pressure is
converted into stiffness ([Williamson, Chen & Sah 2001](https://doi.org/10.1016/S0736-0266%2801%2900052-3)).
Native aggregate moduli are ~0.5–1 MPa
([Athanasiou et al. 1991](https://doi.org/10.1002/jor.1100090304); host cartilage 994 ± 280 kPa,
6.3 % w/w GAG in [Lima et al. 2007](https://doi.org/10.1016/j.joca.2007.03.008)).

**Chondrocytes are round and essentially do not move.** The cell plus its pericellular
microenvironment (the *chondron*) is the metabolic unit of cartilage
([Poole 1997](https://doi.org/10.1046/j.1469-7580.1997.19110001.x)). Chondrocyte translocation in
intact tissue has never been convincingly shown; isolated cells crawl slowly and only where the
collagen network is disrupted ([Morales 2007](https://doi.org/10.1016/j.joca.2007.02.022)). In the
engine this means `v0 ≈ 0` for chondrogenic cells: the "droplets" are pinned.

**Dedifferentiation is reversible and shape-driven.** Serial monolayer culture switches articular
chondrocytes from collagen II + aggrecan to a collagen I–dominated, fibroblast-like output; returned
to suspension in 0.5 % agarose they round up and fully re-express the collagen II phenotype
([Benya & Shaffer 1982](https://doi.org/10.1016/0092-8674%2882%2990027-7)). Freshly isolated human
chondrocytes lose collagen II and chondromodulin and switch to collagen I within the first
monolayer culture period ([Schnabel et al. 2002](https://doi.org/10.1053/joca.2001.0482)).
Stiffness acts on the same axis: 4 kPa polyacrylamide preserves collagen II/aggrecan and
suppresses collagen I relative to 10–100 kPa
([Schuh et al. 2010](https://doi.org/10.1089/ten.TEA.2009.0614)), yet a ~0.5 MPa substrate primes
TGF-β/Smad3 and is chondro-inductive
([Allen, Cooke & Alliston 2012](https://doi.org/10.1091/mbc.E12-03-0172)) — stiffness *per se* is
not the enemy; spreading on a stiff fibrous substrate is. IL-1β (half-maximal 2.5 pM) inverts the
II/I procollagen mRNA ratio from > 6 to < 1 within 7 days
([Goldring et al. 1988](https://doi.org/10.1172/JCI113823)). Clinical repair after microfracture
or ACI is often a collagen I/II fibrocartilage with low GAG and inferior mechanics
([Armiento, Alini & Stoddart 2019](https://doi.org/10.1016/j.addr.2018.12.015);
[Hunziker 2002](https://doi.org/10.1053/joca.2002.0801)); high-magnitude compression of hydrogel
constructs also favours collagen I
([Alizadeh Sardroud et al. 2022](https://doi.org/10.3389/fbioe.2021.787538)).

**Why the scaffold matters and why it must disappear (the "race").** PEG hydrogel mesh sizes are
tens of nanometres (≈ 60 nm for the MMP-sensitive gel of
[Schneider et al. 2020](https://doi.org/10.1039/c9tb02963j)); aggrecan aggregates and collagen
fibrils are > 200 nm, so in an intact gel secreted matrix cannot leave the pericellular shell. In
non-degrading PEG, GAG stays pericellular at swelling ratio q ≤ 5.2 and spreads at q = 9.3;
collagen II synthesis peaked at an intermediate modulus (360 kPa vs 30 and 960 kPa)
([Bryant & Anseth 2002](https://doi.org/10.1002/jbm.1217)). Tighter gels (60 → 320 → 590 kPa)
hold collagen II/VI, aggrecan, link protein and decorin pericellularly and raise MMP-1/-13
~25-fold ([Nicodemus, Skaalure & Bryant 2011](https://doi.org/10.1016/j.actbio.2010.08.021)); the
same tight gel under dynamic load *decreases* proteoglycan synthesis
([Bryant et al. 2004](https://doi.org/10.1023/b:abme.0000017535.00602.ca)). Hydrolytic PEG–lactide
crosslinks let collagen II fill the construct (2.4 vs 0.22 % w/w) and double DNA
([Bryant & Anseth 2003](https://doi.org/10.1002/jbm.a.10319)); degradation gave 2.3× more GAG and
2.9× more collagen but *lower* moduli, and four weeks of loading accelerated degradation into
tissue defects ([Roberts et al. 2011](https://doi.org/10.1007/s11999-011-1823-0)). The
Vernerey–Bryant mixture-theory models formalise the race: bulk hydrolysis releases ECM only after
the gel has largely lost its modulus (reverse gelation once crosslink density falls to 60–80 % of
initial), whereas cell-secreted enzyme can carve a sharp degradation front that moves away from the
cell with a neotissue front immediately behind it, preserving stiffness
([Dhote & Vernerey 2014](https://doi.org/10.1007/s10237-013-0493-0);
[Akalp, Bryant & Vernerey 2016](https://doi.org/10.1039/c6sm00583g)); the front is sharp when
cleavage outpaces enzyme diffusion. Experimentally, an MMP-sensitive gel started at 42 kPa, cell
clusters were cleared by day 13, the bulk reverse-gelled between weeks 2 and 4, and the modulus
dipped then recovered to 107 kPa at 6 weeks in free swelling but fell to 26 kPa under daily loading
([Schneider et al. 2020](https://doi.org/10.1039/c9tb02963j)). Cell clustering and pericellular
heterogeneity keep the construct connected through the transition
([Schneider et al. 2017](https://doi.org/10.1021/acsbiomaterials.7b00348);
[Chu et al. 2017](https://doi.org/10.1089/ten.TEA.2016.0490)); aggrecanase-sensitive gels degrade
only where cells are and yield collagen II with minimal collagen I/X, whereas non-degradable
controls accumulate collagens I and X ([Skaalure, Chu & Bryant 2014](https://doi.org/10.1002/adhm.201400277)).
Review: [Vernerey et al. 2021](https://doi.org/10.1021/acs.chemrev.1c00046).

**GAG accumulates in weeks; collagen lags.** Chondrocytes in agarose at ~10⁷ /mL synthesise a
mechanically functional matrix; by day 35 GAG, stiffness and streaming potential reached ~25 % of
calf cartilage, and most newly made proteoglycan stayed in the gel
([Buschmann et al. 1992](https://doi.org/10.1002/jor.1100100602)). With serum-free medium and
transient (2 week, 2.5–5 ng/mL) TGF-β3, agarose constructs reached native compressive modulus
(0.8 MPa) and 6–7 % w/w GAG in < 2 months, outperforming continuous dosing or serum
([Byers et al. 2008](https://doi.org/10.1089/ten.tea.2007.0222)). Collagen lags: after 8 weeks GAG
reached 1.74 % w/w vs 2.4 % native but collagen 2.64 % vs 21.5 %
([Hung et al. 2004](https://doi.org/10.1023/b:abme.0000007789.99565.42)). In vivo aggrecan
half-life is ~3.4 years and collagen ~117 years
([Sivan et al. 2006](https://doi.org/10.1074/jbc.M600296200);
[Verzijl et al. 2000](https://doi.org/10.1074/jbc.M006700200)); in a construct the relevant
timescale is *escape*, not turnover: free monomers diffuse out until immobilised into aggregates and
caged by collagen, which is how [Nikolaev et al. 2010](https://doi.org/10.1002/bit.22581) model
GAG leakage (mobile monomer → immobile aggregate, product inhibition at physiological GAG); see also
[DiMicco & Sah 2003](https://doi.org/10.1023/A:1020677829069) and
[Sengers et al. 2004](https://doi.org/10.1115/1.1645526). Bulk modulus depends less on the
pericellular-vs-bulk distribution than on the matrix's intrinsic organisation
([Sengers et al. 2004b](https://doi.org/10.1007/s10439-004-7824-3)), and dynamic loading raises GAG
loss to the medium even as net accumulation rises
([Kisiday et al. 2004](https://doi.org/10.1016/j.jbiomech.2003.10.005)).

**Why dynamic compression helps (and when it hurts).** Deformational loading at 10 %
peak-to-peak, 1 Hz, 3 × 1 h on/off per day gave a 6-fold higher aggregate modulus than free
swelling at 28 days (100 vs 15 kPa) with more GAG and hydroxyproline
([Mauck et al. 2000](https://doi.org/10.1115/1.429656)); with TGF-β1 or IGF-I the gain was
super-additive (+277 %) and collagen II spread from pericellular to construct-wide
([Mauck et al. 2003](https://doi.org/10.1089/107632703768247304)); denser seeding and serum let
loaded constructs reach E_Y ≈ 185 kPa
([Mauck et al. 2003b](https://doi.org/10.1016/j.joca.2003.08.006);
[Mauck et al. 2002](https://doi.org/10.1114/1.1512676)). In explants 1–5 % oscillatory strain
stimulates synthesis 20–40 % while static 25 % compression inhibits it ~20 %
([Sah et al. 1989](https://doi.org/10.1002/jor.1100070502);
[Grodzinsky et al. 2000](https://doi.org/10.1146/annurev.bioeng.2.1.691)). The response is
biphasic in timing and amplitude: loading concurrent with TGF-β3 cut properties by 90 %, the same
protocol after TGF-β3 withdrawal raised them (E_Y 1.3 MPa, 8.7 % w/w GAG)
([Lima et al. 2007](https://doi.org/10.1016/j.joca.2007.03.008)); injurious compression (50 %
strain at 0.1–1 s⁻¹, > 12–20 MPa) kills cells, releases GAG and abolishes the anabolic response
([Kurz et al. 2001](https://doi.org/10.1016/S0736-0266%2801%2900033-X);
[Loening et al. 2000](https://doi.org/10.1006/abbi.2000.1988)). Cyclic-loading TE models
([Bandeiras & Completo 2017](https://doi.org/10.1007/s10237-016-0843-9)) and multiphase cartilage
models ([Klika et al. 2016](https://doi.org/10.1016/j.jmbbm.2016.04.032)) use such strain-, flow-
and pressure-gated synthesis terms.

**Why hypoxia helps.** Chondrocytes consume ~10 nmol O₂/10⁶ cells/h above 5 % O₂ (less below),
producing steep profiles through cartilage ([Zhou, Cui & Urban 2004](https://doi.org/10.1002/art.20675));
constructs measure 2–5 % at their centre with D ≈ 3.8 × 10⁻¹⁰ m²/s
([Malda et al. 2004](https://doi.org/10.1002/bit.20038)), and clinically sized constructs deplete
severely unless the medium is mixed and oxygenated
([Sengers et al. 2005](https://doi.org/10.1021/bp0500157)). Low oxygen (1–5 %) drives the
chondrocyte phenotype via HIF-2α → SOX9 ([Lafont, Talma & Murphy 2007](https://doi.org/10.1002/art.22878));
HIF-1α is required for survival in the hypoxic interior
([Schipani et al. 2001](https://doi.org/10.1101/gad.934301)). Dedifferentiated chondrocytes in
alginate re-express collagen II only at 5 % O₂, with sulfate incorporation up to 8× higher than at
21 % ([Domm et al. 2002](https://doi.org/10.1053/joca.2001.0477);
[Domm et al. 2004](https://doi.org/10.1089/ten.2004.10.1796)); 5 % O₂ plus encapsulation restores
passaged cells to primary-level collagen II/aggrecan within 4 weeks
([Murphy & Sambanis 2001](https://doi.org/10.1089/107632701753337735)). Normoxia pushes hypertrophy
(MMP-13, COL10A1) while 2.5 % O₂ sustains ACAN/COL2A1/SOX9
([Leijten et al. 2012](https://doi.org/10.1371/journal.pone.0049896)).

**Inflammation (OA-like breakdown) and recovery.** IL-1 induces aggrecanases (ADAMTS-5 is the
primary one in murine OA; [Glasson et al. 2005](https://doi.org/10.1038/nature03369)) and MMP-13.
In IL-1-treated explants aggrecan is depleted in week 1 and collagen only in week 2, because intact
aggrecan shields collagen from MMPs ([Pratta et al. 2003](https://doi.org/10.1074/jbc.M303737200)).
After 3 days of 10 ng/mL IL-1α, GAG release normalises ~3 days after washout but synthesis is still
30 % inhibited at 8 days unless TGF-β or IGF-1 is present
([Rayan & Hardingham 1994](https://doi.org/10.1016/0945-053x%2894%2990190-2)); in vivo the lost GAG
is replaced over 3–4 weeks with a ~2× synthetic overshoot and no collagen damage
([Page Thomas et al. 1991](https://doi.org/10.1136/ard.50.2.75)). Dynamic compression counteracts
IL-1β-induced iNOS/COX-2 acutely ([Chowdhury et al. 2008](https://doi.org/10.1186/ar2389)) but 42
days of loading cannot rescue IL-1-treated constructs
([Lima et al. 2008](https://doi.org/10.1016/j.jbiomech.2008.06.015)); LPS lowers matrix output
without speeding gel degradation ([Skaalure et al. 2014](https://doi.org/10.1002/adhm.201400277)).

| Process | Timescale | Source |
|---|---|---|
| Pericellular scaffold clearance around cells (MMP-sensitive PEG) | ≤ 13 d | Schneider 2020 |
| Bulk reverse gelation (MMP-sensitive PEG); PEG-LA hydrolysis | 2–4 wk; 2–6 wk | Schneider 2020; Bryant & Anseth 2003 |
| GAG to native levels in agarose (serum-free, transient TGF-β3) | 6–8 wk | Byers 2008; Lima 2007 |
| Collagen to ~1/8 native | 8 wk | Hung 2004 |
| Modulus 6× vs free swelling under 10 % / 1 Hz loading | 28 d | Mauck 2000 |
| IL-1: aggrecan depleted / collagen lost | 1 wk / 2 wk | Pratta 2003 |
| Post-IL-1 recovery: degradation / synthesis / GAG content | 3 d / > 8 d / 3–4 wk | Rayan 1994; Page Thomas 1991 |
| Collagen II→I switch under IL-1 or monolayer | ~7 d – 2 wk | Goldring 1988; Schnabel 2002 |
| Redifferentiation in gel at 5 % O₂ | 2–4 wk | Domm 2002; Murphy 2001 |
| O₂ equilibration across a 1 mm construct | minutes | Malda 2004 |

---

## 2. Model specification (engine vocabulary)

Domain: the same `N³` cube, `L ≈ 300 µm`, `dt = 0.02 d`, run length 56–84 d. Each cell agent
stands for a small cluster (≈ 3–10 cells) so that 160 agents ≈ 20–60 × 10⁶ cells/mL, the seeding
range of [Mauck et al. 2003b](https://doi.org/10.1016/j.joca.2003.08.006). The collagen I species
reuses the engine's structure tensor `T`; all other species are scalar voxel fields.

### 2.1 Species

| key | label | kind | oriented | colour | stiffness contribution | degradability | source |
|---|---|---|---|---|---|---|---|
| `scaf` | hydrogel scaffold (intact-network fraction) | `scaffold` | no (regular lattice) | pale grey-blue `#aebfd6`, fading | `E_scaf0(xl) · scaf`, `E_scaf0 = 5 + 60·xl` kPa | hydrolysis (rate set by `xl`) + cell enzyme (Michaelis–Menten in `m`) | cast at t = 0 (`scaf = 1`) |
| `gag` | GAG / aggrecan gel | `gel` | no | translucent teal haze `#3fb8b0` | swelling pressure, effective only with collagen: `E_gag · gag^1.5 · (0.25 + 0.75·col2/(col2 + 0.3))` | aggrecanase/MMP field `m`; **loss to medium** at rate falling with `col2` and with intact mesh | chondrogenic cells (`phi²`) |
| `col2` | collagen II fibril network | `fiber` | isotropic (FA ≈ 0.1, fixed) | ivory `#efe6d2` | `E_col2 · col2²` | `m`, only once GAG is depleted (aggrecan protects) | chondrogenic cells, slow |
| `col1` | collagen I fibres (fibrocartilage) | `fiber` | yes — lives in `T` | amber `#e0a24a` | `E_col1 · col1² · (1 + kStrain·strain)` | as existing engine (`kDeg·(mMin+m)`) | dedifferentiated cells, `(1 − phi)²`, oriented along `p` |

`scaf` is the *connected* network fraction, `(ρx − ρc)/(ρx0 − ρc)` clamped to [0,1], so it reaches 0 at
reverse gelation (a real, abrupt event) rather than tailing off; the residual soluble polymer is not
tracked. Update per voxel:

```
d scaf/dt = −[ kHyd(xl)·(1 + kLoadDeg·s(a)) + kEnz·m/(m + mK) ] · (scaf + sOff),   clamp ≥ 0
kHyd(xl)  = 0.357 / tRG(xl),  tRG = 7 + 28·xl  days   (time to reverse gelation, 7–35 d)
```
`sOff = 2.3` encodes reverse gelation at 70 % of initial crosslink density for first-order cleavage
(Dhote & Vernerey 2014); `kLoadDeg = 0.5` reproduces load-accelerated degradation (Roberts 2011).
Mesh confinement `conf = xl · scaf` (0 = open, 1 = tight).

```
d gag/dt  = Σ_cells bulk deposition − kGagLoss·gag·(1 − R)·(1 + 0.5·s(a)) − kGagDeg·m·gag + halo release
R (retention) = 1 − (1 − col2/(col2 + cRet))·(1 − 0.8·conf)
d col2/dt = Σ_cells bulk deposition − kCol2Deg·m·col2·(1 − gag/(gag + gProt)) + halo release
d col1 (T)/dt = as engine §1.5 with the fibroblastic secretion below; maturation rule kept.
```
The GAG-loss term is the literal evaporation: it is highest when the network is immature and the
mesh is gone (Nikolaev 2010; Buschmann 1992; Kisiday 2004). `kGagDeg·m` at IL-1 levels of `m`
(≈ 0.5) removes ~20 %/d, matching week-1 aggrecan depletion; collagen II is protected until
`gag ≲ gProt` (Pratta 2003).

### 2.2 Fields

| field | diffusion | bath | sources | decay |
|---|---|---|---|---|
| `tgf` TGF-β3 (1 ≡ 10 ng/mL) | `D = 0.05 L²/d` (well mixed at this scale) | `kBath·(tgfExt − tgf)`, `kBath = 4 /d` everywhere (as engine) | small autocrine `kTauto·phi·s(a)` (stiffness/load-primed TGF-β, Allen 2012) | receptor uptake `kTup·n_cells` (0.05/d/agent) |
| `o2` oxygen (normalised to 21 %) | quasi-steady: `0 = ∇²o2 − Da·(n_local/n_ref)·o2/(o2 + Km)` solved by Gauss–Seidel sweeps each step (D ≈ 3.8 × 10⁻¹⁰ m²/s equilibrates in minutes; explicit Euler would need dt < 10⁻⁴ d) | Dirichlet `o2 = o2Ext/21` on the +z face ("medium side"), zero flux elsewhere ("deep side") | consumption only | — |
| `m` catabolic protease (MMP-13 + aggrecanase) | `0.05 L²/d`, hindered by mesh: `D·(1 − 0.8·conf)` | none (bath removes: `kMdec`) | per cell `mBasal·(1 + kMxl·conf) + mInfl·infl² + mFib·(1 − phi)`; `kMxl = 3` (MMP-13 ~25× in tight gels, Nicodemus 2011) | `kMdec = 1 /d`, `mMin = 0.02` |
| `infl` IL-1 (dial, 1 ≡ 10 ng/mL) | treated as a bath value (no field) | dial | — | — |
| `nut` nutrient (optional) | as `o2` with `Da_nut = 0.3·Da` | +z face | — | gates synthesis `nut/(nut + 0.1)` |

`Da = Q·H²/(D·C₀)`: with `Q` from Zhou 2004 (2.8 × 10⁻¹⁸ mol/cell/s), 20 × 10⁶ cells/mL,
`C₀ = 0.2 mol/m³` and a construct half-thickness `H = 1 mm`, `Da ≈ 0.75`; the default `Da = 3`
represents a ~2 mm-thick construct and yields a top-to-bottom gradient from 21 % to ~2–4 % at
21 % bath, matching Malda 2004. `Km = 0.1` (≈ 2 % O₂; Zhou 2004).

### 2.3 Cells

One type, `chondrocyte`, state `x`, `p` (polarity, used only for collagen I), `phi ∈ [0,1]`
(0 fibroblastic ↔ 1 chondrogenic), `cat ∈ [0,1]` (catabolic memory), `haloG`, `haloC` (pericellular
GAG and collagen II pools, capacity `Pcap` each). Motility `v = v0·(1 − phi)·(1 − scaf)`, `v0 = 0.05 L/d`
(only spread, dedifferentiated cells on a cleared, fibrous matrix crawl; Morales 2007). Shape:
aspect ratio `1 + 1.5·(1 − phi)` along `p`; radius `rCell·(1 + 0.3·phi)`.

**Modulating functions** (all dimensionless):

```
H2(x, k)  = x²/(x² + k²)
fT        = 0.45 + 0.55·H2(tgf, 0.25)                 TGF-β3 (basal synthesis without it: Mauck 2003 control ≈ 45 % of +TGF)
s(a)      = 4·(a/a*)² / (1 + (a/a*)²)²,  a* = 10 %     bump peaking at 10 % dynamic strain (Mauck 2000)
d(a)      = (a/aInj)⁴ / (1 + (a/aInj)⁴),  aInj = 18 %   injury (Kurz 2001; Loening 2000)
M         = (gag + col2 + halo)/((gag + col2 + halo) + 0.15)   matrix present to transmit load to the cell
fL        = 1 + kStim·s(a)·(1 − d(a))·M − kInj·d(a) − kEarly·s(a)·conf·(0.5 + 0.5·H2(tgf, 0.25))
fO        = (1 + aHyp·(1 − o2/(o2 + 0.25))) · o2/(o2 + 0.03)      hypoxia bonus × anoxia penalty
fI        = 1 − 0.8·cat                                          IL-1 suppresses synthesis
fCrowd    = (1 − (gag + col2)/1.6)²                              product inhibition (Nikolaev 2010)
```
`kStim = 1.0`, `kInj = 0.6`, `kEarly = 1.0` (loading inside a dense, TGF-β-rich gel is harmful:
Lima 2007, Bryant 2004), `aHyp = 0.8` (5 % vs 21 % O₂ gives a ~1.4× factor; Domm reports up to 3–8×
for sulfate incorporation in redifferentiating cells, so 0.8 is conservative).

**Synthesis** (density/day per agent, into the agent's voxel):

```
S_gag  = sG  · phi² · fT · fL · fO · fI · fCrowd            sG  = 0.30
S_col2 = sC2 · phi² · fT · fL · fO · fI · fCrowd            sC2 = 0.06   (collagen lags ~5× : Hung 2004)
S_col1 = sC1 · (1 − phi)² · (0.5 + 0.5·H2(tgf, 0.25)) · fI   sC1 = 0.5, orientation pol = 0.8·(1 − phi)
```
**Confinement (Vernerey):** the fraction reaching the voxel bulk is `b = (1 − conf)²`; the rest goes
to the pericellular pool until `haloG + haloC = Pcap` (halo saturated, radius ≈ 1.5 r_cell:
Schneider 2020); further confined synthesis is discarded (feedback inhibition). When the scaffold
clears, the halo is released into the voxel at `kRel·(1 − conf)·halo`, `kRel = 0.5 /d` — the moment
"islands merge into bulk".

**Phenotype dynamics:**

```
round  = clamp(scaf + gag/(gag + 0.15), 0, 1)                       encapsulated in a gel → round
spread = (1 − round) · H2(E_local, 20 kPa) · col1/(col1 + 0.2)        flat on stiff fibrous matrix
phi*   = clamp( 0.35 + 0.30·H2(tgf, 0.25) + 0.30·hyp + 0.25·round + 0.10·s(a)·(1 − d(a))
               − 0.30·spread − 0.20·serum − 0.35·cat − 0.30·d(a), 0, 1 ),   hyp = 1 − o2/(o2 + 0.25)
d phi/dt = (phi* − phi)/tau,  tau = 7 d when phi* < phi (Goldring 1988; Schnabel 2002),
                              14 d when phi* > phi (Domm 2002; Murphy 2001)
d cat/dt = (infl − cat)/tauC,  tauC = 1 d up, 6 d down (Rayan 1994: degradation recovers in 3 d,
                              synthesis still 30 % inhibited at 8 d)
```
The `spread` term is the fibrotic drift loop: dedifferentiated output (collagen I) stiffens a
fibrous matrix, which lets cells spread, which lowers `phi` further. Optional proliferation:
`dN/dt = 0.015·N·(1 − conf)·(1 − N/Nmax)` (DNA doubling over 6 weeks once the gel degrades:
Bryant & Anseth 2003); off by default so the story stays about the matrix.

### 2.4 Stiffness rule (kPa)

```
E = E0 + E_scaf0(xl)·scaf
      + E_gag · gag^1.5 · (0.25 + 0.75·col2/(col2 + 0.3))
      + E_col2 · col2²
      + E_col1 · col1² · (1 + kStrain·strain)
E0 = 0.5, E_scaf0 = 5 + 60·xl (5–65), E_gag = 600, E_col2 = 400, E_col1 = 80, strain = a/20
```
Worked values: fresh gel at `xl 0.5` → 35 kPa (Schneider 2020: 42 kPa). Scenario-1 endpoint
(`gag 0.85, col2 0.3, scaf 0`) → 0.5 + 600·0.78·0.625 + 36 ≈ 330 kPa, in the 100 kPa–1.3 MPa band of
engineered constructs (Mauck 2003b; Schneider 2020; Lima 2007). Native (`gag 1, col2 1`) → ~1 MPa.
Collagen-free GAG (`gag 1, col2 0`) → 150 kPa only: the GAG needs the net (Maroudas 1976;
Williamson 2001). Fibrocartilage (`col1 0.8, gag 0.2`) → ~60 kPa.

### 2.5 Dials

| dial | symbol | range | default | metaphor | biology | what to watch |
|---|---|---|---|---|---|---|
| TGF-β3 bath | `tgfExt` | 0–1 (1 ≡ 10 ng/mL) | 0.5 for d 0–14, then 0 (transient) | humidity | anabolic and pro-chondrogenic; transient serum-free dosing beats continuous (Byers 2008) | `phi`, GAG flux; try continuous vs transient |
| Dynamic compression amplitude | `amp` (a) | 0–20 % (1 Hz, 3 h/d implied) | 0 for d 0–14, then 10 % | pressure | ~10 % stimulates; > 15 % injures; harmful inside a dense gel with TGF-β3 (Lima 2007) | E and GAG rise after loading starts; GAG loss rises too; > 15 % → `phi` and GAG fall |
| Oxygen tension | `o2Ext` | 1–21 % | 5 % | altitude (thin air) | hypoxia → HIF-2α/SOX9 → collagen II, aggrecan; 21 % → hypertrophy/dedifferentiation; < 1 % starves | O₂ gradient layer; `phi` at 21 % vs 5 % |
| Inflammation (IL-1) | `infl` | 0–1 (1 ≡ 10 ng/mL) | 0 | temperature (heat evaporates) | IL-1 → ADAMTS-5/MMP-13, synthesis shut-down, collagen II→I | GAG melts first, collagen II a week later; slow recovery after 0 |
| Hydrogel crosslink density | `xl` | 0–1 | 0.5 | the trellis | mesh size, initial modulus (5–65 kPa) and time to reverse gelation (7–35 d) | pericellular islands (high) vs early collapse (low) |
| Cell number | `nCells` | 40–400 | 160 | droplet nuclei | seeding density 20–60 × 10⁶/mL; more cells → faster fronts and steeper O₂ gradients | time to bulk matrix; O₂ floor |
| Serum (toggle) | `serum` | 0/1 | 0 | smog | 10 % FBS: proliferation, dedifferentiation, blunts TGF-β3 effect (Byers 2008) | `phi` drift, collagen I |

### 2.6 Scenarios

Common initial state unless stated: `scaf = 1`, `gag = col2 = col1 = 0`, `phi = 0.9`, `cat = 0`,
halos empty, 160 agents at random positions. Statements are machine-checkable targets for
`tests/` (means over voxels; "day n" = simulated days).

1. **Hydrogel to cartilage (the race).** Dials: `xl 0.5`, `tgfExt 0.5 → 0 at day 14`, `amp 0 → 10 %
   at day 14`, `o2Ext 5`, `infl 0`, `serum 0`. Expect: `scaf < 0.2` by day 28 and `< 0.05` by day 42;
   `gag > 0.5` by day 42 and `> 0.7` by day 56; `col2 > 0.15` by day 56; `col1 < 0.05` throughout;
   `phi > 0.75` throughout; `E(t)` has a local minimum in days 7–28 that stays `> 8 kPa`, and
   `E(56) > 100 kPa > E(0)`; cumulative GAG lost to medium `< 40 %` of cumulative GAG synthesised;
   halo pools saturate (`mean halo > 0.8·Pcap`) before day 14 and empty (`< 0.2·Pcap`) by day 35.
2. **Scaffold degrades too fast.** As (1) but `xl 0.1` (soft, `tRG ≈ 10 d`). Expect: `scaf < 0.1` by
   day 14; at the first day `t*` with `scaf < 0.1`, `gag(t*) < 0.3` and `E(t*) < 5 kPa`; `min E < 0.3·E(0)`;
   cumulative GAG loss fraction `> 60 %` by day 28; `gag(56) < 0.5` and `E(56) < 60 kPa` (both below
   scenario 1 at the same day).
3. **Scaffold too dense / too slow.** As (1) but `xl 1.0` (`E_scaf0 65 kPa`, `tRG 35 d`). Expect:
   `scaf > 0.4` at day 42; bulk `gag < 0.2` at day 42 while `mean halo > 0.8·Pcap` by day 21 (pericellular
   islands); `m` mean `≥ 2×` scenario 1 over days 7–42; `E` declines monotonically until `scaf < 0.2`
   and `E(56) < 0.7·E(0)` (Skaalure 2014: 2-fold drop); `phi > 0.7` (round cells keep their phenotype).
4. **Fibrocartilage drift.** `xl 0.3`, `tgfExt 0.2` continuous, `serum 1`, `o2Ext 21`, `amp 0`,
   `infl 0`. Expect: `phi < 0.5` by day 28 and `< 0.3` by day 56; `col1 > col2` by day 42 and `col1 > 0.3`
   by day 56; `gag(56) < 0.3`; `10 kPa < E(56) < 80 kPa` and `E(56) < 0.3·E_scenario1(56)`; cell aspect
   ratio mean `> 1.8` by day 42. Reversibility check: at day 56 set `tgfExt 0.5, o2Ext 5, serum 0`;
   `phi > 0.6` by day 84 (re-expression, Benya & Shaffer 1982) but `col1(84) > 0.5·col1(56)` — the
   fibres outlive the phenotype (hysteresis).
5. **Inflammatory breakdown.** Start from the cached day-56 state of (1) (a `maturedCartilageState()`
   factory, as the engine's `maturedState()`); `infl 0.8` for days 0–14, then 0; `amp 10 %`
   throughout. Expect: `gag` falls `> 40 %` by day 14 (Pratta 2003: aggrecan first); `col2` loss `< 10 %`
   by day 7 and `≤ 20 %` by day 14; `E` falls `> 50 %` by day 14; `phi` falls by `≥ 0.2`; loading does
   not rescue (`gag(14)` with `amp 10 %` within 10 % of `amp 0`; Lima 2008). After washout: `m` returns
   to `< 2·mMin` within 5 days; GAG deposition flux back to `> 80 %` of pre-insult by day 28; `gag(56)
   > 0.7·gag(0)` (Page Thomas 1991: 3–4 weeks) but `col2(56) < col2(0)` and `E(56)` between `0.6` and
   `0.9·E(0)`.

### 2.7 Parameter table

This table is the **specification**: every value with the measurement it answers to and its source.
What the implementation actually runs is the generated block under it (rewritten by
`node tools/check_params_doc.mjs --write`, checked by `npm test`) — the two are allowed to differ,
because tuning a scenario against its `checks` is how a value earns its place, but the difference is
now visible instead of silent.

| symbol | value (engine units) | plausible real range | source |
|---|---|---|---|
| `L`, agents | 300 µm; 160 agents ≈ 3–10 cells each | 10–60 × 10⁶ cells/mL | Mauck 2003b; Buschmann 1992 |
| `E_scaf0(xl)` | 5 + 60·xl kPa | PEG gels 30–960 kPa (K); 42 kPa cell-laden MMP-gel | Bryant & Anseth 2002; Schneider 2020 |
| `tRG(xl)` | 7 + 28·xl d | clusters cleared ≤ 13 d; bulk 2–4 wk; PEG-LA 2–6 wk | Schneider 2020; Bryant & Anseth 2003 |
| `sOff` | 2.3 | reverse gelation at 60–80 % of initial ρx | Dhote & Vernerey 2014 |
| `kEnz`, `mK` | 0.15 /d, 0.05 | enzyme Michaelis–Menten, k_cat 0.05 s⁻¹ | Schneider 2020; Akalp 2016 |
| `kLoadDeg` | 0.5 | 4 wk loading accelerated degradation | Roberts 2011 |
| mesh vs ECM size | `conf = xl·scaf`; b = (1 − conf)² | mesh ~60 nm vs ECM r_m > 200 nm | Schneider 2020; Akalp 2016 |
| `Pcap` | 0.03 density units per agent | halo radius ≈ 1.5 r_cell | Schneider 2020 |
| `sG`, `sC2`, `sC1` | 0.30, 0.06, 0.5 /d per agent | GAG native in 6–8 wk; collagen ~1/8 native at 8 wk | Byers 2008; Hung 2004 |
| `fT` half-point | 0.25 (≈ 2.5 ng/mL) | 2.5–5 ng/mL transient suffices | Byers 2008 |
| `a*`, `aInj` | 10 %, 18 % | 10 % / 1 Hz optimal; 1–5 % stimulates explants; ≥ 50 % injurious | Mauck 2000; Sah 1989; Kurz 2001 |
| `kStim`, `kInj`, `kEarly` | 1.0, 0.6, 1.0 | 6× modulus; −90 % when concurrent with TGF-β3 | Mauck 2000; Lima 2007; Bryant 2004 |
| `Da`, `Km` | 3, 0.1 | Q = 10 nmol/10⁶ cells/h; D = 3.8 × 10⁻¹⁰ m²/s; 2–5 % at centre | Zhou 2004; Malda 2004 |
| `aHyp` | 0.8 | 5 % vs 21 %: 1.5–8× incorporation | Domm 2002/2004 |
| `kGagLoss`, `cRet` | 0.05 /d, 0.15 | most PG retained in agarose; loss ↑ with loading | Buschmann 1992; Kisiday 2004; Nikolaev 2010 |
| `kGagDeg` | 0.4 /d × m | 38 % GAG release in 3 d; aggrecan gone in 1 wk | Pratta 2003 |
| `kCol2Deg`, `gProt` | 0.05 /d × m, 0.2 | collagen lost in week 2, protected by aggrecan | Pratta 2003 |
| `mInfl`, `mFib`, `kMxl` | 20·infl², 3·(1 − phi), 3 | ADAMTS-5/MMP-13 induction; MMP-13 ~25× in tight gels | Glasson 2005; Nicodemus 2011 |
| `tau_phi` down / up | 7 d / 14 d | II→I switch ≈ 7 d; redifferentiation 2–4 wk | Goldring 1988; Domm 2002; Murphy 2001 |
| `tauC` up / down | 1 d / 6 d | degradation recovers 3 d, synthesis > 8 d | Rayan & Hardingham 1994 |
| `E_gag`, `E_col2`, `E_col1`, `E0` | 600, 400, 80, 0.5 kPa | native 0.5–1 MPa; constructs 0.1–1.3 MPa; fibrocartilage inferior | Athanasiou 1991; Lima 2007; Armiento 2019 |
| `v0` | 0.05 L/d × (1 − phi)(1 − scaf) | chondrocytes essentially stationary | Morales 2007 |
| `fCrowd` scale | 1.6 | product inhibition at physiological GAG | Nikolaev 2010 |

<!-- params:cartilage -->
<!-- Generated from src/tissues/cartilage.js by `node tools/check_params_doc.mjs --write`.
     Do not edit inside the markers: `npm test` compares every number with the code. -->
**As built** — what `src/tissues/cartilage.js` runs today (10 engine + 78 params). The sourced table in this
section says what the numbers have to answer to; this block says what they are.

```text
engine  N = 12            dt = 0.02         rhoMax = 2        kLoadFib = 0
        loadExp = 2       fEvery = 6        rCell = 0.03      kRep = 0.5
        trace = 'fiber'   vox = 2
params  tRGa = 7          tRGb = 28         tRGc = 130        kRG = 0.357
        sOff = 2.3        kLoadDeg = 0.5    kEnz = 0.0015     mK = 0.1
        sG = 0.7          sC2 = 0.12        sC1 = 0.45        tgfHalf = 0.25
        fT0 = 0.45        aStar = 0.1       aInj = 0.18       kStim = 1
        kInj = 0.6        kEarly = 1        matHalf = 0.15    aHyp = 0.8
        o2Half = 0.25     o2Anox = 0.03     kIL = 0.8         crowd = 2.2
        Pcap = 1          kRel = 0.5        kGagLoss = 0.045  cRet = 0.06
        gSelf = 1.2       kWash = 2         kGagDeg = 0.4     mTimp = 0.05
        kWashNew = 0.68   haloBridge = 0.8  wC2 = 2.5         kCol2Deg = 0.095
        gProt = 0.2       kCol1Deg = 0.1    mMin = 0.02       kO2 = 0.7
        o2Km = 0.1        kTauto = 0.4      kTup = 0.05       mBasal = 0.35
        kMxl = 20         mInfl = 8         mFib = 1.5        phi0 = 0.35
        cTgf = 0.3        cHyp = 0.3        cRound = 0.25     cLoad = 0.1
        cSpread = 0.5     cSerum = 0.3      cCat = 0.35       cInj = 0.3
        roundHalf = 0.15  ESpread = 20      col1Half = 0.2    tauPhiDown = 7
        tauPhiUp = 8      tauCatUp = 1      tauCatDown = 6    E0 = 0.5
        EscafA = 5        EscafB = 60       Egag = 600        EgagBase = 0.25
        Ecol2Half = 0.3   Ecol2 = 400       Ecol1 = 80        kStrain = 0.5
        ampRef = 0.2      v0 = 0.35         sigmaP = 1.5      kGuide = 3
        kAlign = 0.5      polC1 = 0.8
```
<!-- /params:cartilage -->

---

## 3. Readouts and chart mapping

- **Stacked density** (existing stacked-area chart): `scaf` (grey, drawn first so it visibly
  drains), `gag` (teal), `col2` (ivory), `col1` (amber). All on the 0–1.5 scale; the eye should see
  the grey band shrink while teal grows — the race — and, in scenario 2, a gap between them.
- **0–1 traces**: `phi` mean (phenotype), `o2` mean and `o2` minimum (bottom layer), collagen ratio
  `col2/(col1 + col2)`, halo fill `mean halo/Pcap`, `cat` mean. GAG retention fraction
  `1 − cumulative loss/cumulative synthesis` as a rolling 7-day value.
- **Log stiffness**: `log10 E` with reference lines at 35 kPa (fresh gel), 100 kPa (Mauck 2000
  loaded), 1 MPa (native). The dip-and-recover shape is the key teaching curve.
- **Flux gauge** ("condensing ⟷ evaporating"): left = bulk deposition of `gag + col2 + col1` plus
  halo release; right = protease degradation of all three + GAG loss to medium. Scaffold loss is a
  thin third bar (it is neither condensation nor evaporation: the trellis dissolving). The
  equilibrium sentence should name the dominant right-hand term ("GAG is leaking to the medium
  faster than collagen II can cage it").
- **Export**: add `scaf, gag, col2, phi, o2` per voxel and `phi, halo` per cell to the JSON frames
  so the Blender importer can drive haze density and lattice opacity.

## 4. Visual language (render.js)

- **Scaffold**: a regular cubic lattice of thin struts at voxel corners (InstancedMesh cylinders,
  fixed positions — it never rotates), opacity and radius `∝ scaf`, colour pale grey-blue, tighter
  `xl` drawn as thinner, more numerous struts. It should read as an engineered object, not a fibre:
  regularity is the cue that this is not biology.
- **GAG**: volumetric haze — a Points cloud per voxel with size and alpha `∝ gag`, teal, additive
  blending off (normal blending as in the engine); alternatively a translucent icosphere per voxel
  scaled by `gag^(1/3)`. It fills space; it has no direction.
- **Collagen II**: the engine's fibre instances but short (`0.4 h`), thin, ivory, direction from a
  fixed random vector (FA pinned ≈ 0.1) — a felt, not a weave. Hide below `col2 < 0.03`.
- **Collagen I**: the existing amber, longer, thicker fibres driven by `T` — appears only when
  dedifferentiated cells exist, and aligns only under load or along spindle cells.
- **Chondrocytes**: icospheres, colour lerp `#3fb8b0` (chondrogenic) → `#ff7a3d` (fibroblastic), a
  faint translucent halo sphere of radius `1.5 rCell` whose opacity `∝ halo/Pcap` — the
  pericellular island. As `phi` falls the sphere stretches along `p` (aspect `1 + 1.5·(1 − phi)`),
  the halo fades, and in a cleared voxel the cell may creep.
- **Oxygen**: optional layer, a vertical gradient of dark-blue haze from the deep face; toggle off by
  default but on in the O₂ "try this" prompt.
- **Load**: the existing z-face cones, pulsing at a visual (not physical) rate when `amp > 0`.

## 5. Where the cloud metaphor maps — and where it breaks

Maps well: GAG loss to the medium *is* evaporation — monomers leave a tissue whose net is not yet
tight enough to hold them, and the retention factor `R` is literally how well the cloud holds its
water. TGF-β3 remains humidity, IL-1 remains heat (it melts the GAG first), loading remains
pressure, cell number remains nuclei. The flux gauge keeps its meaning.

Breaks: (i) the scaffold has no weather analogue — it is a trellis the gardener builds and expects
to rot, and the whole lesson is a *race between two processes* rather than an equilibrium;
(ii) oxygen as "altitude" is a stretch: thin air here *helps* the cloud form; (iii) the matrix is
not made of droplets — GAG is an osmotic sponge whose stiffness only appears once a collagen net
restrains it, so "more cloud ≠ stiffer" until the net exists; (iv) the droplets have a mind: a
chondrocyte can decide to become a fibroblast and start making a different, aligned cloud, and that
choice outlives the conditions that caused it (scenario 4's hysteresis); (v) the cells do not move,
so patterns come from where they were seeded, not from where they went.

## 6. Known simplifications

1. Sub-voxel physics is lumped: the pericellular degradation front and the halo are cell attributes,
   not resolved fields; the Vernerey front is represented by `conf` and `Pcap`, not by mesh-size-
   dependent diffusivities.
2. One protease field stands for MMP-13, ADAMTS-4/5 and TIMPs; IL-1 is a dial, not a diffusing field;
   NO/PGE₂ signalling and the load–IL-1 interaction are folded into `fI` and `kInj`.
3. GAG is one species: monomer vs aggregate (Nikolaev 2010), link protein, hyaluronan and charge-
   dependent swelling are not tracked; `E_gag·gag^1.5` is a phenomenological stand-in for Donnan
   pressure.
4. Collagen II crosslink maturation, fibril diameter and the superficial/deep zonal organisation
   are absent; collagen II is isotropic and never aligns.
5. Hydrogel swelling on degradation (which lowers modulus and raises mesh size before reverse
   gelation) is not modelled; `scaf` jumps to zero at reverse gelation with no soluble-polymer tail.
6. Oxygen is quasi-steady with a single Damköhler number and one medium face; glucose/lactate/pH
   (Sengers 2005) are optional and off; hypoxia effects on MMP expression are ignored.
7. The superiority of *transient* over *continuous* TGF-β3 (Byers 2008) is not reproduced without an
   extra term (e.g. TGF-β-dependent inhibition of collagen network assembly); left as a tuning hook.
8. Hypertrophy (collagen X, mineralisation) at 21 % O₂ is folded into the same `phi` axis as
   fibroblastic dedifferentiation; they are distinct fates in reality.
9. No cell death except implicitly through `fO`; injurious loading does not remove cells.
10. Loading is a scalar amplitude at a fixed protocol; fluid flow, shear, frequency and duty cycle —
    the actual mechanobiological inputs in Bandeiras & Completo 2017 and Sengers 2004 — are not
    resolved.
