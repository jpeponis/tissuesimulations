# Contributing to Tissue Weather

Thanks for looking. This is a teaching interactive, so two things matter more than usual: the
simulation has to stay **deterministic and defensible** (every scenario has machine-checkable
expectations, and the biology has sources), and the page has to stay **one file with no build
dependencies**, so an instructor can download it and it works.

Read [`docs/EXTENDING.md`](docs/EXTENDING.md) before touching `src/` — it is the contract
between the engine and a tissue definition. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is
the map of the repository.

## Setup

There is nothing to install for the core workflow.

| you need | for | notes |
|---|---|---|
| **Node ≥ 20** | tests, build, headless runs, scaffolding | the repo has **no dependencies**; `npm install` is not required and there is no lockfile. Node 20 is the CI baseline; the test runner needs `node --test` with a glob argument |
| **Python 3 with matplotlib** *(optional)* | `tools/plot_scenarios.py`, `python3 -m http.server` | `pip install matplotlib` (on Debian/Ubuntu you may need `--break-system-packages`) |
| **Blender 4.2 LTS** *(optional)* | `blender/import_tissue.py` | or `pip install bpy==4.2.*` for the module mode; see [`blender/README.md`](blender/README.md) |
| **Playwright + Chromium** *(optional)* | `tools/screenshot_app.mjs`, `tools/render_smoke.mjs` | `npm i -g playwright && npx playwright install chromium` |

A modern browser with WebGL is enough to run the app; Three.js is loaded from a CDN through the
import map in `index.html`, so the first load needs network access.

```bash
git clone https://github.com/jpeponis/tissuesimulations
cd tissuesimulations
npm test          # ~25 s, no install needed
npm run serve     # http://localhost:8000/  (ES modules do not load from file://)
```

## Commands

| command | what it does |
|---|---|
| `npm test` | `node --test tests/*.test.mjs` — conformance for every registered tissue, the golden regression, the engine API, the build constraints and the tools |
| `npm run build` | `node tools/build_single.mjs` — writes `dist/tissue-weather.html` and `dist/tissue-weather.artifact.html` |
| `npm run check-dist` | rebuilds into a temp directory and fails if the committed `dist/` is stale |
| `npm run headless` | `node tools/run_headless.mjs` — every scenario in Node → CSV + trajectory JSON under `scratch/<tissue>/` |
| `npm run golden` | `node tools/make_golden.mjs` — re-record the golden reference (read the section below first) |
| `npm run new-tissue -- <key> "<Name>"` | scaffold and register a new tissue definition |
| `npm run screenshot` | drive the real app in headless Chromium and save screenshots |
| `npm run serve` | `python3 -m http.server 8000` from the repository root |

Extra flags go after `--`, e.g. `npm run headless -- --tissue fibrous --days 40 --only maturation`.
Every tool also runs directly (`node tools/run_headless.mjs …`); its flags are documented in the
header comment at the top of the file, which is the only place they are documented.

## Coding constraints (docs/EXTENDING.md §0) — and why

`tools/build_single.mjs` concatenates every file under `src/` into **one**
`<script type="module">`. There is no bundler, no module graph and no name mangling; the build
strips text with regexes. That is what makes the single-file page possible, and it means three
rules are load-bearing rather than stylistic:

1. **Named exports only.** The build strips the leading `export ` from
   `const | let | var | function | class | async function` declarations. `export default`,
   `export { … }` and `export *` survive into the bundle and break it.
2. **Unique top-level identifiers across all of `src/`.** After concatenation there is one
   scope, so two files declaring `const clamp` redeclare each other. Prefix everything:
   `TissueEngine` / `ENGINE_` / `tm` in the engine, `app` / `APP_` in the app, `copy` / `COPY_`
   in the copy helpers, `TISSUE_<KEY>` and a short lower-case prefix in a tissue file.
3. **Local imports on one line**, written exactly as `import { a, b } from './x.js';`. The
   build deletes matching lines whole; a statement split over two lines leaves its second half
   behind as a syntax error. External imports (Three.js) are hoisted instead, so they may only
   appear at the top level.

Two more rules with teeth:

4. **`src/engine.js` and every file under `src/tissues/` must not touch `document`, `window`,
   `performance` or `Math.random`.** They run in Node for the tests and the headless tools, and
   all randomness comes from the seeded mulberry32 PRNG so runs are reproducible.
5. **The hot loops allocate nothing.** `makeRules()` resolves indices once
   (`engine.speciesIndex.new`, `engine.fieldIndex.g`, `engine.dialIndex.strain`); the hooks read
   `ctx.*` and write `ctx.out.*` into arrays the engine reuses. The budget is ≤ 0.5 ms/step at
   N = 12 with 160 cells, and the tests enforce < 1 ms.

`tests/build.test.mjs` checks 1–4 with regexes, so you find out in `npm test` rather than in a
blank page. Style otherwise: 2-space indent, semicolons, single quotes, comments that say
*why*, and a header comment in every file explaining what it owns.

## Adding or changing a tissue

```bash
npm run new-tissue -- mytissue "My tissue"     # copies the starter, registers it
$EDITOR src/tissues/mytissue.js
npm test                                        # the conformance suite now includes it
npm run headless -- --tissue mytissue           # curves, without a browser
python3 tools/plot_scenarios.py --dir scratch/mytissue
npm run build && npm run check-dist             # then open index.html?tissue=mytissue
```

Every tissue must satisfy `docs/EXTENDING.md` §7: it validates, it is deterministic, its state
stays finite and bounded, **every scenario has `checks` and they pass**, and it runs inside the
performance budget. The `checks` are the specification of the teaching claim — if a scenario
says the tissue evaporates without load, write the check that says so.

Behaviour claims in the docs need a source. `docs/MODEL.md` and
`docs/tissues/cartilage-hydrogel.md` carry DOIs for their numbers; keep that habit.

## Running things

```bash
npm test                                   # everything; ~25 s
node --test tests/engine.test.mjs          # just the simulation
node --test --test-name-pattern 'golden' tests/engine.test.mjs

npm run headless                           # fibrous, 90 days, all scenarios + variants
npm run headless -- --tissue fibrous --days 20 --out scratch/fibrous
python3 tools/plot_scenarios.py --dir scratch/fibrous
```

`run_headless.mjs` builds its CSV header from the tissue definition (`t`, `species.<key>…`, `fa`,
`logE`, `cells.a`, `fields.<key>…`, `deposition`, `degradation`, …), while `plot_scenarios.py`
asks for a fixed list of columns. If the two drift apart the script stops with a `KeyError` naming
the missing column — fix the script, not the CSV, and keep it tolerant of tissues whose species
it does not know.

```bash
npm run screenshot -- --tissue fibrous --scenario maturation --days 40 --out dist/shots
node tools/screenshot_app.mjs --page dist/tissue-weather.html    # test the built file
node tools/render_smoke.mjs --out /tmp/render                    # renderer only
```

`scratch/`, `dist/shots/` and `dist/cdn-cache/` are git-ignored working directories. The two
`dist/*.html` files are **not**: they are committed build artifacts, because they are what
GitHub Pages serves and what an instructor downloads. Run `npm run build` whenever you change
`index.html` or anything in `src/`, and commit the result — `npm run check-dist` (and CI) will
tell you if you forget.

## The golden regression

`tests/golden/fibrous.json` holds reference statistics recorded from the v0.1 model with seed 7.
The test replays every recorded run and compares `species.total`, `species.mat`, `fa` and
`cells.a` at every recorded day, within 3 % relative or 0.01 absolute — whichever is larger.
It exists so that refactors (the v0.1 `model.js` → engine + tissue split, for one) cannot
quietly change the biology the lesson is built on.

```bash
node tools/make_golden.mjs                     # rewrites tests/golden/fibrous.json
node tools/make_golden.mjs --tissue mytissue   # a new golden for a new tissue
```

**Regenerating it is legitimate when** you deliberately changed the fibrous model or its
parameters and can say, in the PR, what changed in the biology and why the new curves are
right; when you add a tissue and want a golden of its own; or when the recorded format changes
(the current file is format 2). **It is not legitimate** as a way to make a failing test pass.
A golden mismatch after a refactor that was supposed to preserve behaviour is the test doing
its job: find the difference instead. If you do regenerate, say so explicitly in the PR
description, include the before/after numbers for the days that moved most, and check that the
scenario `checks` and `docs/TEACHING.md` still describe what the simulation now does.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run build` run, and `npm run check-dist` passes (i.e. `dist/*.html` is committed and current).
- [ ] Changes to `src/` respect the four constraints above (`tests/build.test.mjs` is the referee).
- [ ] A change to the engine/renderer/app/export contract is reflected in `docs/EXTENDING.md`, and the file map in `docs/ARCHITECTURE.md` still matches reality.
- [ ] A new or changed tissue has at least two scenarios, each with `checks` that encode the teaching claim.
- [ ] The golden was not regenerated — or it was, and the PR says what changed in the model and why.
- [ ] New biology claims carry a DOI in `docs/MODEL.md` or the tissue's spec under `docs/tissues/`.
- [ ] Student-facing copy stays plain, second person and concrete; the app still works with the keyboard and reads correctly to a screen reader (`node tools/screenshot_app.mjs` probes both).
- [ ] Screenshots in `docs/img/` updated if the look changed materially.

## Reporting problems

Open an issue with the deep link that reproduces it (the app keeps the URL current: tissue,
scenario, every dial and the speed), your browser and OS, and whether the same thing happens in
`dist/tissue-weather.html`. For simulation questions, a `npm run headless` CSV is worth more
than a description.
