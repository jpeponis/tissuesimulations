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
| `npm run build` | `node tools/build_single.mjs` — writes `dist/tissue-weather.html` and `dist/tissue-weather.artifact.html`. It throws (with a `src/file:line`) on a local import the bundle does not carry, on any `import`/`export` statement that survived the strip, and on a bundle that does not `node --check` |
| `node tools/build_single.mjs --vendor` | also writes `dist/tissue-weather.offline.html` with Three.js inlined — the copy for a room with no network. Git-ignored on purpose (a megabyte of vendored library); CI rebuilds it on every push and uploads it as the `offline-page` artifact |
| `npm run check-dist` | rebuilds into a temp directory and fails if the committed `dist/` is stale |
| `npm run headless` | `node tools/run_headless.mjs` — every scenario in Node → CSV + trajectory JSON under `scratch/<tissue>/` |
| `node tools/make_golden.mjs --tissue <key> --out tests/golden/<key>.engine.json` | re-record an engine golden (read the section below first). `npm run golden` on its own refuses: its default target is `tests/golden/fibrous.json`, the v0.1 reference that is never regenerated |
| `node tools/check_params_doc.mjs --write` | regenerate the `<!-- params:<tissue> -->` as-built blocks in the docs after changing a parameter (`npm test` fails while they disagree) |
| `npm run new-tissue -- <key> "<Name>"` | scaffold and register a new tissue definition |
| `npm run screenshot` | drive the real app in headless Chromium and save screenshots (`--dsf 2` with a halved `--width`/`--height` reproduces 200 % browser zoom) |
| `npm run serve` | `python3 -m http.server 8000` from the repository root |

Extra flags go after `--`, e.g. `npm run headless -- --tissue fibrous --days 40 --only maturation`
(`--key=value` works too, and `--help` prints the options and the runs). Every tool also runs
directly (`node tools/run_headless.mjs …`); its flags are documented in the header comment at the
top of the file, which is the only place they are documented.

`tools/screenshot_app.mjs` and `tools/render_smoke.mjs` drive a real headless Chromium; the plumbing
they share (finding Playwright, serving the repo, the CDN cache, closing everything again) lives in
`tools/lib/browser.mjs` — see `tools/lib/README.md`. The cache defaults to `os.tmpdir()`, but both
tools override it: `screenshot_app.mjs` uses `dist/cdn-cache` (which is where
`build_single.mjs --vendor` looks for the library) and `render_smoke.mjs` uses `<out>/cdn-cache`. A third tool that needs a
browser starts from `withHarness()`, not from a third copy: `tests/tools.test.mjs` checks that both
of these still import the module and that neither has grown its own server again.

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
node --test tests/engine.test.mjs               # conformance only: schema, determinism, your checks
npm run headless -- --tissue mytissue           # curves, without a browser
python3 tools/plot_scenarios.py --tissue mytissue
$EDITOR docs/tissues/mytissue.md                # the two params: markers — see "the as-built block"
node tools/check_params_doc.mjs --write
npm test                                        # the whole suite, once the document exists
npm run build && npm run check-dist             # then open index.html?tissue=mytissue
```

Every tissue must satisfy `docs/EXTENDING.md` §7: it validates, it is deterministic, its state
stays finite and bounded, **every scenario has `checks` and they pass**, and it runs inside the
performance budget. The `checks` are the specification of the teaching claim — if a scenario
says the tissue evaporates without load, write the check that says so.

**The as-built block is not optional.** `npm test` fails for a registered tissue that has no
`<!-- params:<key> -->` … `<!-- /params:<key> -->` pair in a document, because a tissue whose
numbers are nowhere written down cannot be reviewed. The document is `docs/tissues/<key>.md`
(`docs/MODEL.md` for the fibrous tissue, by exception); put the two markers where the values
belong, write the surrounding prose — the sources, the ranges, the reasoning — yourself, and let
`node tools/check_params_doc.mjs --write` fill the block between them. Nothing in `tools/` has to
be edited to add a tissue.

Two keys are **reserved for the test fixtures**: `demotissue` and `demo-tissue`. `tests/tools.test.mjs`
scaffolds them inside a throw-away copy of this repository, and that copy carries the real
`src/tissues/`, so a tissue of the same name would make the scaffolder refuse and three tests fail.

Behaviour claims in the docs need a source. `docs/MODEL.md` and
`docs/tissues/cartilage-hydrogel.md` carry DOIs for their numbers; keep that habit.

## Running things

```bash
npm test                                   # everything; ~25 s
node --test tests/engine.test.mjs          # just the simulation
node --test --test-name-pattern 'golden' tests/engine.test.mjs

npm run headless                           # fibrous, 90 days, all scenarios + variants
npm run headless -- --tissue fibrous --days 20 --out scratch/fibrous
python3 tools/plot_scenarios.py --tissue fibrous     # or --dir scratch/fibrous, the same directory
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

`scratch/`, `dist/shots/`, `dist/cdn-cache/` and `dist/tissue-weather.offline.html` are
git-ignored. `dist/tissue-weather.html` and `dist/tissue-weather.artifact.html` are **not**: they
are committed build artifacts, because they are what GitHub Pages serves and what an instructor
downloads. Run `npm run build` whenever you change `index.html` or anything in `src/`, and commit
the result — `npm run check-dist` (and CI) will tell you if you forget. The offline page stays out
of the repository because it carries a megabyte of vendored Three.js; CI rebuilds it on every push
and uploads it as the `offline-page` artifact, which is also where a non-developer gets it.

## The two golden regressions

There are two reference files for the fibrous tissue, and they answer different questions.

| file | recorded from | tolerance | question it answers | re-record? |
|---|---|---|---|---|
| `tests/golden/fibrous.json` | the **v0.1 `model.js`**, seed 7 | 3 % relative or 0.01 absolute | "is this still the same **model**?" | **Never.** The 3 % agreement with v0.1 *is* the claim, and no tool here can reproduce that recording — `make_golden.mjs` would simply write down the engine as it is today. If it fails, the model moved |
| `tests/golden/fibrous.engine.json` | the **current engine**, seed 7 | 1e-5 relative / 1e-7 absolute, on every recorded stat path | "is this still the same **arithmetic**?" | Yes, deliberately, when a change is *meant* to move the numbers |

The tight file is what makes a refactor safe: a change that is supposed to preserve behaviour has
to leave it bit-identical, and 0.1 % of drift shows up immediately instead of hiding inside the
3 % band.

```bash
node --test --test-name-pattern 'golden' tests/engine.test.mjs        # just the goldens
node tools/make_golden.mjs --tissue fibrous --out tests/golden/fibrous.engine.json   # re-record the tight one
node tools/make_golden.mjs --tissue mytissue                          # a golden for a new tissue
```

**Re-recording `*.engine.json` is legitimate when** you deliberately changed the model, its
parameters or the engine arithmetic and can say, in the PR, what changed and why the new curves are
right; when you add a tissue and want a golden of its own; or when the recorded format changes.
**It is not legitimate** as a way to make a failing test pass. A mismatch after a refactor that was
supposed to preserve behaviour is the test doing its job: find the difference instead. If you do
re-record, say so explicitly in the PR description, include the before/after numbers for the days
that moved most, and check that the scenario `checks`, `docs/TEACHING.md` and
`tests/fidelity.test.mjs` still describe what the simulation now does.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run build` run, and `npm run check-dist` passes (i.e. `dist/*.html` is committed and current).
- [ ] Changes to `src/` respect the four constraints above (`tests/build.test.mjs` is the referee).
- [ ] A change to the engine/renderer/app/export contract is reflected in `docs/EXTENDING.md`, and the file map in `docs/ARCHITECTURE.md` still matches reality.
- [ ] A new or changed tissue has at least two scenarios, each with `checks` that encode the teaching claim.
- [ ] `tests/golden/fibrous.json` (the v0.1 reference) was **not** regenerated, and if `fibrous.engine.json` was, the PR says what changed in the model and why.
- [ ] A parameter change was followed by `node tools/check_params_doc.mjs --write`, and a **new** tissue also has its own `docs/tissues/<key>.md` with the two `params:` markers in it.
- [ ] A change to a teaching claim is measured, not asserted: `tests/fidelity.test.mjs` says what the model actually does.
- [ ] New biology claims carry a DOI in `docs/MODEL.md` or the tissue's spec under `docs/tissues/`.
- [ ] Student-facing copy stays plain, second person and concrete; the app still works with the keyboard and reads correctly to a screen reader (`node tools/screenshot_app.mjs` probes both).
- [ ] Screenshots in `docs/img/` updated if the look changed materially.

## Reporting problems

Open an issue with the deep link that reproduces it (the app keeps the URL current: tissue,
scenario, every dial and the speed), your browser and OS, and whether the same thing happens in
`dist/tissue-weather.html`. For simulation questions, a `npm run headless` CSV is worth more
than a description.
