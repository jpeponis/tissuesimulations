# Changelog

What changed, in plain language, for the person teaching with it. Each entry says what a class
notices first and what moved under the hood second; nothing here assumes you read the code.

Two version numbers travel together and are easy to confuse:

- the **release** — `package.json`, `CITATION.cff` and the About panel — currently **0.3.0**;
- the **tissue-definition contract** — [`EXTENDING.md`](EXTENDING.md) — currently **v0.4**, which
  only matters if you are writing a tissue of your own.

The contract runs ahead: it is bumped when the engine gains a feature, the release when a version
is cut. `docs/REVIEW.md` is the audit these last rounds work from, finding by finding.

---

## Unreleased — the review rounds (still released as 0.3.0; contract v0.4)

A hardening pass, not a rewrite. Nothing about the biology or the scenarios changed on purpose;
what changed is that the words now match the model, the page survives a room with no Wi-Fi, and
the tools fail loudly instead of quietly.

### What a class notices

- **The offline page is a download, not a build step.** `dist/tissue-weather.offline.html` has
  Three.js inlined and makes no network requests at all. CI rebuilds it on every push, so you can
  take it from the `offline-page` artifact of the latest run without installing anything; a USB
  stick then works in a room with no Wi-Fi.
- **The teaching copy says what the model does.** Every numeric claim in the scenario cards and in
  [`TEACHING.md`](TEACHING.md) was re-measured on the running model and rewritten where the two
  disagreed; `tests/fidelity.test.mjs` now measures the important ones on every test run, so they
  cannot drift back:
  - *Unloading* names **all three** dials the preset moves — load 0.6 → 0, bath 0.5 → 0.2 **and
    protease 0.4 → 0.5** — and its control experiment says which values to put back. It also gets
    the order right: **Reset restores the preset's dials**, so a dial you move before Reset is
    thrown away. Change one *after* it, then press Play.
  - *Scaffold to tissue* warns about the first two days: the cells start quiescent, so density
    **dips** from 0.15 to 0.13 before the flux bar tips over around day 3. Students predict a
    straight climb, and the dip is the lesson.
  - *Fibrosis* quotes week-four numbers at week four (density 0.82, ≈ 37 kPa, activation 0.88,
    whole-tissue alignment 0.13); the old text quoted the day-45 values. The card also says the
    bath drop is **yours to make** unless you switch on *Auto-apply scripted events*.
  - "Alignment leads maturity" is now stated on the trace it is true of — the faint *local
    anisotropy* line (38 % of its rise by day 7) rather than the headline whole-tissue line
    (26 %, next to a mature fraction of 25 %).
  - The cube is **300 µm** on every page and in the app, and the colour key prints
    "Cube edge ≈ 300 µm" instead of leaving the scale to be guessed.
- **The panel, the charts and the 3D view had an accessibility pass**: the view can be orbited,
  zoomed and reframed from the keyboard, the charts can be read with a crosshair, and the
  single-character shortcuts (`R`, `I`, `P`, `1`–`9`) can be switched off in About for anyone who
  types into the page with voice control. `README.md` lists the current keys and buttons.
- **Cartilage runs on the same engine as the fibrous tissue** — the second tissue is no longer a
  slightly different machine — and the Blender export carries the fields and the load range, so a
  rendered animation shows what the browser showed.

### Under the hood

- The single-file build **refuses to write a broken bundle**: an unresolved local import, a
  surviving `import`/`export` statement or a duplicate top-level name is now an error naming
  `src/file:line`. It also tokenizes each source first, so an `import` line quoted **inside a
  string, a template literal or a comment** is left alone — it used to be deleted, silently, from
  the copy that quoted it.
- The engine's diffusion no longer clamps a fast field silently; a definition picks an
  integration mode and the validator says when a choice is being overridden.
- Scenario pre-runs are warmed a few steps per frame instead of freezing the page for a second or
  three when you first click Unloading or Wound.
- **Two golden references**: the original 3 % agreement with the v0.1 model, plus a tight
  (1e-5) recording of the current engine, so a refactor that was meant to change nothing has to
  prove it.
- Developer tools fail fast: `run_headless.mjs` rejects `--only` with no list (it used to run all
  eleven runs) and checks `--blender` before the first simulated day; `check_params_doc.mjs` finds
  a tissue's parameter block by its markers, so **adding a tissue no longer means editing a tool**.
- CI: the vendored offline page is built in its own advisory job, so a CDN outage cannot fail the
  deterministic test job; the built page itself is now driven in a headless browser; and
  `dist/tissue-weather.offline.html` is git-ignored so it can never be committed by accident.

---

## 0.3.0 — a second tissue

### What a class notices

- **Articular cartilage in a degrading hydrogel** joins the fibrous connective tissue in the
  tissue picker: round chondrocytes, an aggrecan gel whose stiffness comes from osmotic swelling,
  a collagen II net, and a scaffold that has to dissolve at the right speed. Five scenarios — the
  race, scaffold too fast, scaffold too dense, fibrocartilage drift, inflammatory breakdown — and
  the deliberate contrast with fibrosis: here alignment is *not* the goal.
- The **load dial reads 0–1**, not a percentage, because 60 % engineering strain is not a thing a
  tissue survives; the live sentence describes the state it is in rather than reciting numbers;
  each scenario card carries an *Auto-apply scripted events* chip; and the speed slider gained the
  named **Watch / Weeks / Months** presets a lesson can be planned around.

### Under the hood

- Engine v0.3: matrix species can be transported, each species can carry its own orientation, and
  scenario `checks` can aggregate over a window (`min`, `max`, `mean`) instead of testing one day.

---

## 0.2.0 — one engine, many tissues

### What a class notices

- The page is **generated from the tissue definition**: dials, scenario cards, readouts, the
  colour key and the About text all come from the tissue you picked, so a second tissue is a
  second lesson rather than a second app.
- A first accessibility and ease-of-use pass: keyboard operation, a live sentence that says which
  way the equilibrium is leaning, and the **Table** button that prints the readouts as text for
  the back row and for a screen reader.
- **Export trajectory (JSON for Blender)** and `blender/import_tissue.py`: a run can be turned
  into a rendered animation for a lecture slide.

### Under the hood

- The simulation was split into a generic engine (`src/engine.js`) and tissue definitions
  (`src/tissues/*.js`), with [`EXTENDING.md`](EXTENDING.md) as the contract between them, a
  conformance suite every registered tissue must pass, the golden regression against v0.1, the
  headless runner, the single-file build and CI.

---

## 0.1.0 — the fibrous tissue

Fibroblasts building, aligning and maturing collagen I under load, as one page with a 3D view, the
weather dials, the readouts and five scenarios; the model, its equations and its sources are in
[`MODEL.md`](MODEL.md) and the original design record in [`SPEC.md`](SPEC.md).
