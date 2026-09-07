# Tissue Weather — review synthesis and improvement plan (v0.3 → next iteration)

Reviewed tree: branch `claude/tissue-models-blender-3d-25gzhp`, HEAD `3c040d4` (v0.3.0), working tree clean.
`node --test tests/*.test.mjs`: 74 pass / 0 fail. `node tools/check_dist.mjs`: **dist/ is stale** (rebuild and commit).

Many original findings were written against v0.1 (`src/model.js`, `src/copy.js` copy tables). Each was re-verified
against the current tree; the table below records the **corrected** severity and the current file:line. Items whose
premise no longer holds are listed in §5 (dropped) with the reason.

---

## 1. Executive summary

1. The engine/tissue split, generated UI, format-2 export, cartilage tissue, CI and conformance tests already exist; the plan below is a hardening pass, not a rewrite.
2. The single blocking defect for the cartilage goal is numerical: `_diffuse` silently clamps the diffusion number to 1/6 (`src/engine.js:1113`, also `:1003` for species transport), so any fast field (oxygen, D/L² ~10³/d) integrates with a wrong D and no warning. Fix with per-field mode (explicit / sub-cycled / quasi-steady) plus a validator warning.
3. Responsiveness: the 60-day `init.from` pre-run blocks the UI thread (~0.8 s node, 2–3 s Chromebook) on first Unloading/Wound click (`engine.js:563`); `frame()` clamps by step count, not time (`app.js:799`); the renderer rebuilds all instance buffers every frame even when paused (`render.js:872`). Three small, tissue-agnostic fixes.
4. Build robustness: `tools/build_single.mjs` cannot fail — it drops unresolved local imports and never syntax-checks its output, so a plugin author who factors helpers into `_utils.js` gets a green build and a dead page. Add resolve-check, leftover-syntax check and `node --check`.
5. Accessibility residue after the 98f74d6 pass: keyboard-inert 3D canvas and auto-rotate with no stop control; the live equilibrium sentence re-announces every 0.7 s while playing; Space after a mouse click re-fires the clicked button; control borders at 1.1–1.4:1; play/readouts ~1.6 screens below the fold at 1440×900.
6. Fidelity: five pieces of student-facing copy contradict the built model (unloading "load alone", objective 3 "tension AND TGF-β", wound scar persistence, "cells turn orange and wander in", hysteresis attributed to matrix release). All are copy-only fixes in `src/tissues/fibrous.js` and `docs/TEACHING.md`; do not retune parameters (golden regression).
7. Docs drift: SPEC §3 sandbox row wrong, `kAlign` 0.6 undocumented, MODEL.md §2/§3 still show spec equations/constants, cartilage-hydrogel.md §2.7 already diverges from `cartilage.js`. Add an as-built column checked by a small script in `npm test`.
8. Blender parity: fields are not exported, fiber layout/cell-colour/geometry recipes are independently hand-tuned, the committed fibrous fixture is format 1. Export fields + `loadRange`, share the fiber recipe, port the OKLab ramp, regenerate the fixture, add a python `--dry-run` contract test.
9. Regression safety: the fibrous golden is a 3 % check against v0.1; the engine already drifts 0.1–2.9 %. Record a tight format-2 reference from the current engine and assert near-exactly, so cartilage work cannot silently move fibrous.
10. Five packages (A engine, B renderer, C app/index, D docs/tooling/tests, E Blender) are file-disjoint except for three named additive touch points in `src/engine.js` (revision counter, `warmFrom`, fields/`loadRange` in export) which A owns and B/E consume behind `undefined` fallbacks.

---

## 2. Confirmed findings

Severity is the verifier-corrected severity. Effort S < ½ day, M 1–3 days. Pkg = work package in §3.

| id | sev | area | file:line | issue | fix | eff | pkg |
|---|---|---|---|---|---|---|---|
| A1 | high | numerics | `src/engine.js:1113` (`_diffuse`), `:1003` (species transport `lamMax`) | Diffusion number silently clamped to 1/6; O₂ field (lam ≈ 4·10³) would run ~10⁴× too slow; cartilage o2 D=0.06 already clamped 4 % | Per-field mode from lam at construction: explicit (≤1/6, bit-identical), sub-cycled (≤~20), quasi-steady Gauss-Seidel (fast); delete `Math.min`; `console.warn` in `validate`; tests vs analytic decay length / parabola | M | A |
| A2 | med | responsiveness | `src/engine.js:563` `_loadFrom`, `src/app.js:376` `loadScenario` | 3000-step synchronous pre-run behind a 30 ms `setTimeout`; UI frozen 0.8–3 s on first Unloading/Wound | `warmFrom(from, maxSteps)` + `warmScenarios(n)` resumable in `_fromCache`; app warms ~40 steps/frame after `setTissue`; sync fallback unchanged | M | A + C |
| A3 | low-med | responsiveness | `src/app.js:799-801` | `maxSteps = 60` is a step count, not a time budget; tissue-dependent per-step cost | Wall-clock budget (~8 ms), always ≥1 step, drop backlog, show "sim slowed" in `#fps` | S | C |
| A4 | med | engine generality | `src/engine.js:888` (`kLF` toward +z), `:161` | Passive load alignment is tension-toward-+z only; cartilage sidesteps with `kLoadFib: 0` | Optional `engine.loadMode: 'tension'|'compression'` (default tension → golden unchanged); validate enum | S | A |
| A5 | low-med | engine generality | `src/engine.js:1529` (`motile` validated, never read), reset seeding ~`:362`, repulsion `~:673/705` | `motile` is dead metadata; cellCount dial mandatory only via test; global `rCell` not per-type; no per-type stats | Honour `motile:false` (skip polarity/migration; repulsion pushes motile partner only); optional `cellTypes[].count`; per-type radius with `2·max(r) < h` check; `cells.byType.<key>` stats; document in EXTENDING §1 | M | A |
| A6 | med | contract docs | `docs/EXTENDING.md` §2.1/§2.2 (lines 216–300) | Step order and hook-input staleness (ctx.rho live, fiberTotal/fa/E stale; dRho→clamp→T rescale→rhoMax clamp; RNG consumption) live only in engine.js header | Add normative §2.5 "Step order and input staleness" (text in finding), fix §2.1/§2.2 sentences | S | D |
| B1 | low-med | render perf | `src/render.js:872` `update()`, `:914` `_updateFibers` | Rebuilds all instance matrices/colours and re-uploads ~394 KB every rAF, even paused | Engine `revision` counter (bump in step/reset/injure/setDials, expose in `state`); renderer skips when revision/N/layer-key/tissue unchanged, still runs `_updateLoad`; fallback when `revision === undefined` (render_smoke) | S | A (counter) + B |
| B2 | med | a11y keyboard | `src/render.js:244` (pointerdown only), `src/app.js` onKey `:210` | Canvas is focusable but inert: no orbit/zoom/reset by keyboard (WCAG 2.1.1) | `_onCanvasKey` on canvas (arrows orbit via Spherical, +/- dolly, Home `resetView()`), remove in dispose; "Reset view" button; hint via `aria-describedby`; do NOT use `listenToKeyEvents`/private `rotateLeft` (r160) or bind R | M | B |
| B3 | low-med | a11y motion | `src/render.js:244`, `src/app.js:622` `buildLayers` | Auto-rotate stoppable only by pointerdown or OS reduced-motion; no toggle (WCAG 2.2.2) | `onAutoRotate` callback in renderer opts; keydown on canvas also stops it; `auto-rotate` chip (aria-pressed) in `#layers`; optional `rotate=0` URL param | S | B + C |
| B4 | med | feedback | `src/render.js` (no wound object), `src/engine.js` state.wound, `src/tissues/fibrous.js:208` | Injure gives no visible marker; copy says "find the hole" | Wireframe sphere driven by `state.wound` (scale by 1/L), opacity 0.15+0.55·e^(−age/7) persistent; optional `wound` layer; copy "outlined by a wire sphere"; no `confirm()`, no camera move | S | B |
| B5 | low-med | a11y colour | `src/plots.js:119` draw, `src/app.js:491` keys row, `src/render.js:806` fields | Series pairs are luminance twins (1.01–1.03); hazes differ by hue only; keys are colour squares | `series[].marker` (circle/square/diamond), `series[].pattern: 'hatch'` for upper stack band, line-width split; key `<i>` mirrors; `fields[].pointScale` → `_makePointMaterial` size; defaults keep current look; do NOT dash live series ([4,3] = ghost) | M | B + C |
| C1 | med | ui wiring | `src/app.js:210-212` onKey | Space after a mouse click re-activates the focused scenario/Injure/Reset button instead of play/pause | Delegated `click` listener: `if (b && e.detail > 0 && b !== btn-play) b.blur()`; keep native Space for keyboard-focused buttons | S | C |
| C2 | med | page load | `index.html:224` importmap, `:8` preconnect | Unminified 1.27 MB three.module.js at end of a 4-hop waterfall (dynamic `import('./render.js')`); no modulepreload; fonts.gstatic not preconnected | `three.module.min.js` (mirror in `tools/render_smoke.html`, `docs/SPEC.md`, `APP_OFFLINE_HTML`); `modulepreload` for three + OrbitControls with `crossorigin`; `preconnect fonts.gstatic.com crossorigin`; no `media=print onload` trick (CSP) | S | C |
| C3 | med | a11y live regions | `index.html:236` `#equilibrium` role=status, `src/app.js:827` `sample`, `:887` `flash` | Live sentence rewritten every 700 ms with changing rates → screen-reader flood; `#busy` text not announced; scenario swaps silent | Dedicated `<div id="status" class="sr-only" role="status">`; `announce()` on state-change/pause/step/≤15 s cadence, busy text, "Scenario X loaded"; remove live role from `#equilibrium` (stays visual); no programmatic focus moves | M | C |
| C4 | low-med | a11y plots | `src/app.js:491` buildReadouts (gauge `.val` never filled), `src/plots.js:76` pointermove only | Gauge has no DOM number; crosshair pointer-only; table shows current values only | Fill `gaugeVal` in `sample()`; canvas `tabindex=0`, `hoverI` with ←/→/Home/End/Esc, `onHover(lines)` mirrored to `#status`; optional 5-day history `<details>` table | M | C |
| C5 | low | a11y names | `src/app.js:457` | Metaphor tag inside `<label>` → name "Growth-factor bath humidity" | `'aria-hidden': 'true'` on the metaphor span; note in EXTENDING §1 that format/biology/watch/metaphor are expected | S | C |
| C6 | low | contrast / stale dist | `index.html:26-27` (already `--faint #7d8ea6`, `--deco`), `dist/*.html` | Source passes AA; shipped dist still carries `--faint #5d6d82` and pre-98f74d6 code | `npm run build`, commit dist; optional `tools/check_contrast.mjs` in `npm test` (text tokens ≥ 4.5:1 on surface tokens, `--deco` never in `color:`) | S | D |
| C7 | low-med | contrast controls | `index.html` `.chip`, `.scenario-btn`, `.transport button`, `.share`, `.about .tools` (all `1px solid var(--rule)`) | Control boundaries 1.08–1.36:1 against panel (WCAG 1.4.11) | Add `--control-border: #60758f` (3.2–3.8:1) for interactive borders; keep `--rule` for dividers; reserved-space ✓ glyph on pressed layer chips; rebuild dist | S | C |
| C8 | high | layout | `index.html:265-290` Run/Readouts sections, `src/app.js:439` buildDials | Play/Reset/Injure ~1.6 screens and flux gauge ~2.4 screens below the fold at 1440×900 (measured); dial hints 70 px each; cartilage has 7 dials | Move Run `<section>` after Tissue picker with `position: sticky; top:-16px; background: var(--panel)`; wrap metaphor+Watch in `<details class="dial-more">` (keep biology visible for `aria-describedby`); render `type:'flux'` readout first; no HUD gauge duplicate | M | C |
| C9 | med | offline | `tools/build_single.mjs`, `README.md:46` | dist single file still imports three from jsdelivr; vendoring "next to the page" fails on file:// | `--vendor` mode: emit a vendored module (`three.module.js` with export block → `window.__TISSUE_THREE`, OrbitControls import rewritten), drop importmap, from `dist/cdn-cache`/node_modules/curl; keep 20 s watchdog; README wording | M | D |
| C10 | med | time controls | `src/app.js:31` `APP_SPEEDS [2,8,20]`, `:135` default 2, `index.html:275`, `src/tissues/fibrous.js:142`, `docs/TEACHING.md:27` | Copy says "5 days per second"/"5 and 20", presets are 2/8/20, default 2; clock in days while copy speaks in weeks; only `+1 day` | Default 5 and presets 1/5/20 (or rewrite copy to preset names); `+7 days` via non-blocking `stopAt`; `(week N.N)` beside `#day`; remove hard-coded speeds from plugin copy | S | C |
| C11 | low | comparison | `src/plots.js` (no marks), `src/app.js:464` setDial, `:431` injure | Ghost traces exist; dial changes/injury leave no tick on the time axis | `mark(t, label, key)` debounced on sim time, drawn dashed 1 px with letter, included in tooltip; call from `setDial` (when `ready`) and `injure` | S | C |
| C12 | low-med | projection | `index.html` (`.equilibrium` 15 px, `.clock` 13 px, legend 12 px, `--panel-w 392px`), `src/app.js` | No presentation mode; browser zoom at 1280 px flips to the stacked mobile layout | `body.present` CSS block (24 px sentence with backdrop, 18 px clock, hide hints, 460 px panel), `#btn-present` chip + `?present=1` + `P`; hide `#fps` via CSS (`body.debug` shows it, keep writing it for screenshot_app); `fontPx` option in plots.js | S/M | C |
| C13 | low-med | onboarding | `index.html:252` `#hint`, `:295` `#about`, `src/app.js:652` buildLegend, `fibrous.js` legend copy | Scale/"what am I looking at" text only in closed About at panel bottom; chip row has no visible label; no scale cue | `buildHint()` fills `#hint` from `copy.intro.paragraphs[0]` + controls line + "What am I looking at?" button opening About; visible `show` label before chips; optional `domainMicrons` in definition → legend row "Cube edge ≈ 300 µm"; legend copy points at the chips | S | C |
| C14 | low | layout | `index.html` `#legend` (cap only in ≤900 px block) | On wide/short screens an open legend + guide can reach the top HUD | Move `max-height: min(45vh, calc(100vh - 220px)); overflow-y:auto` to the base `#legend` rule | S | C |
| C15 | low-med | copy generality | `src/copy.js:106-111`, `src/app.js:503` (`FluxGauge` without tissue labels), `src/tissues/cartilage.js` vocabulary | Equilibrium tails still bake fibrous mechanobiology + cloud metaphor + fixed thresholds (30 kPa); cartilage hits wrong sentences | Extend `COPY_VOCABULARY_DEFAULT` with `stillHint`, `metaphor{}`, `activeStiff`, `activeSoftening`, `thresholds{}`; `V.equilibrium(stats)` override; pass `tissue.copy.gauge` labels; cartilage supplies its own; test fibrous sentence unchanged | S | C |
| D1 | med | build | `tools/build_single.mjs:9-25` | Unresolved local imports (e.g. `./_utils.js`, anything outside src/ or src/tissues/) dropped silently; multi-line/re-export forms leak; no output syntax check | Resolve every local specifier and throw if not in `order`; throw on leftover `^\s*(import|export)\b`; `node --check` the assembled module; test with a scratch tissue importing `./_helper.js`; keep byte-identical output, no esbuild, no reorder | M | D |
| D2 | low-med | tests | `tests/engine.test.mjs:142-199`, `tests/golden/fibrous.json`, `tools/make_golden.mjs` | 3 % golden vs v0.1 sits at the noise floor (engine already 0.1–2.9 % off); cannot detect further drift | Keep v0.1 file at 3 %; record `tests/golden/fibrous.engine.json` (format 2) from current engine; tol 1e-5 rel for format 2; optional snapshot digests; CONTRIBUTING note | S | D |
| D3 | med | docs | `docs/SPEC.md:263` (sandbox "as built ρ 0.15"), `:133` kAlign 0.4 vs `fibrous.js:336` 0.6, `docs/MODEL.md:296` | SPEC §3 contradicts the app preset (0.02); kAlign 0.6 unlogged anywhere | Fix sandbox row; add kAlign row; add to fibrous.js tuning log; rebuild dist | S | D |
| D4 | low-med | docs | `docs/TEACHING.md:98` | "export the JSON trajectory and find the day deposition/degradation crossed 1" — export has no rates | Point at Table view + `run_headless --only fibrosis` `ratio` column; optional `stats` block in `snapshot()` (engine, documented in EXTENDING §5) | S | D |
| D5 | med | docs | `docs/MODEL.md` §2 (186–250) §3 (263–296), `docs/tissues/cartilage-hydrogel.md` §2.7 | Parameter values in 3–4 places; MODEL.md shows spec equations/constants; cartilage doc already ~14 values stale | "as built" column with `key = value` inside `<!-- params:<tissue> -->` markers; built equations beside spec ones; `tools/check_params_doc.mjs` wired into `tests/tools.test.mjs`; SPEC §3 and fibrous.js header become pointers | M | D |
| D6 | low | docs/tools | `blender/README.md:65,295`, `tools/run_headless.mjs:133` (`_traj.json` duplicate), arg parser | Wrong button name; non-existent `exportEveryDays` knob; duplicate multi-MB file; no `--help`, no `--k=v`, silent `--only` typo | Fix README lines; `--help`, `--k=v`, validate `--only` (exit 2); write `_traj.json` only for `--blender`; `meta.title` label in plot_scenarios.py, drop RUNS dict | S | D |
| D7 | low | tests | (none) — no python contract test | JS writers vs `blender/import_tissue.py` reader never exercised | `tests/export.test.mjs`: per tissue build `{meta: exportMeta(), frames}` in tmp, assert shape, spawn `python3 blender/import_tissue.py --dry-run` (skip if no python3); dry-run both fixtures; CI step | S | D |
| D8 | low-med | CI | `.github/workflows/ci.yml:105` (index.html only), `:72,90` continue-on-error | dist bundle never executed in a browser; render_smoke not in CI; no node-vs-browser determinism check | Second screenshot run `--page dist/tissue-weather.html --no-interact`; `render_smoke.mjs --perf-seconds 1`; optional stats compare vs `TissueEngine` seed 12345 | S | D |
| D9 | low-med | tooling | `tools/screenshot_app.mjs` (curl no `--fail`, python http.server + 700 ms sleep, no try/finally), `tools/render_smoke.mjs` | Duplicated harness code; poisoned CDN cache; orphaned server; three version pinned in 5 places | `tools/lib/browser.mjs` (loadPlaywright, serveDir, launchChromium, routeCdnCache with `--fail` + temp/rename); cache in `os.tmpdir()`; keep `dist/shots/`; test that three@ pins agree | M | D |
| F1 | high | fidelity | `src/tissues/fibrous.js:164,170`, `docs/TEACHING.md:52,59,84` | "Removing load alone" flips cells — false: load-only from matured state keeps ρ 0.99, a 0.69; bath drop is the co-driver | Copy: "off load and out of its growth-factor bath"; question "which of the three dials matters most — test each alone"; fix misconception 1; `unloading_loadOnly` headless variant; no retune | S | D |
| F2 | med-high | fidelity | `docs/TEACHING.md:11` objective 3, `:52`; `docs/MODEL.md:49,204`, §2.3 formula | Model is "TGF-β gates, tension potentiates" (bath alone → a 0.52–0.80), not AND | Rewrite objective 3 and MODEL §1.3/§2.3 to the as-built tanh law; pin test (strain 0 → 0.4<a<0.65; Gext 0 → a<0.05) | S | D |
| F3 | med | fidelity | `src/tissues/fibrous.js:210,213`, `docs/TEACHING.md:71-73`, `docs/SPEC.md:185` | Scar "without regaining alignment" — wound FA catches up (0.49 vs 0.54 at 8 wk); gap is visible at ~3 wk | Step 3 → compare at ~3 weeks then watch it catch up ("unlike real scar"); extend test with 8-week gap < 0.1; no kLoadFib gating (breaks golden) | S | D |
| F4 | med | fidelity | `src/tissues/fibrous.js:213`, `src/app.js:435`, `docs/TEACHING.md:72` | "Nearby cells turn orange and wander in" — cells already at a 0.88, dim to 0.80 inside hole; no chemotaxis | Copy: cells slacken slightly; flash tissue-agnostic ("Watch the hole refill", optional `injury.flash`); note no chemotaxis | S | D |
| F5 | med | fidelity | `docs/TEACHING.md:66,97`, `src/tissues/fibrous.js:191,286` | Hysteresis attributed to matrix-release (kGrel, <1 % of source); real memory is autocrine kGcell·a·H | Rewrite Discuss/mechanism list/question ("if not the bath?"); optional MODEL.md note that kGrel is minor | S | D |
| F6 | low-med | mislabel | `src/tissues/fibrous.js:129` | "Above the middle, enzymes outnumber inhibitors"; dial 0 still degrades (mAct, mMin) | Biology/watch text per finding; keep key/format; mirror label in EXTENDING:79, SPEC:163, render_smoke.html:76 | S | D |
| F7 | low-med | units | `docs/MODEL.md:170-172,288-289`, `src/tissues/fibrous.js:259` | Maturation ends ≈125 kPa, fibrosis ≈145 (hypertrophic-scar range); MODEL says rho=1→80 kPa, kStrain 1 vs 0.5; log-mean labelled as kPa | Docs to as-built numbers; unit "kPa (log scale; geometric mean)"; no rescale (breaks golden, copy threshold) | S | D |
| F8 | med | mislabel | `src/tissues/fibrous.js:254`, `src/tissues/_template.js:148`, `docs/EXTENDING.md:156`, `src/app.js:873` | "alignment" readout plots per-voxel FA but copy defines whole-tissue coherence (`globalFA`); fibrosis 0.33 vs 0.13 | Headline series `globalFA` "alignment (whole tissue)", optional thinner `fa` "local anisotropy"; sentence uses globalFA; leave checks/tests/golden on `fa` | S | D |
| F9 | low-med | units | `src/tissues/fibrous.js:123`, `src/tissues/_template.js:79`, `docs/EXTENDING.md:114` | Load index shown as "60 %" reads as engineering strain | `format: 'fixed2'`, biology text "0–1 load index (not engineering strain…)"; keep key `strain` and `percent` format for cartilage `amp` | S | D |
| E1 | med | blender export | `src/engine.js:1337` snapshot, `:1373` exportMeta, `blender/import_tissue.py` LAYERS | Diffusible fields never exported; no field layer in Blender (blocks O₂ haze) | `fields{key: rounded}` per frame + `meta.fields[{key,label,color}]` (additive, `this.fieldKeys`); python `normalise_fields`, `field_points`, `--fields` flag default off; EXTENDING §5; sample generator emits fields | M | A (export) + E |
| E2 | low | blender parity | `src/render.js:665` `_buildFibers`, `:914`, `blender/import_tissue.py:373-391` FiberLayout | Different seed/offset width/jitter draws/length & radius factors | One recipe in `src/recipe.js` (constants) imported by render.js, exported as `meta.render`; python consumes 7 uniforms per instance, per-vertex `r` attribute; parity test N=2,K=1 (skip w/o python3); reword "pixel-parity" | S/M | E |
| E3 | low-med | blender colour | `blender/import_tissue.py:590` (linear-RGB lerp), `src/render.js:541` (OKLab LUT + saturation) | Half-activated cell colour differs (#c68ec4 vs #ccacbc) | Port `_toOklab/_fromOklab/_saturate/_rampLUT` to python; per-type LUT; apply saturation factors; honour optional `ramp` in meta; do not change `cellTypes` key set (test asserts it) | S | E |
| E4 | low-med | colour pipeline | `src/render.js:149` (aces), `:160/165/178` saturation, `:1187` legendSwatches, `blender/import_tissue.py:1539` (Standard) | One hex → three colours (legend, 3D view, Blender) | Set saturation factors to 1.0 (bake into hex if wanted); unify tone curve (AgX both sides, or document); CPU tone curve in `_css` for legend swatches | S | B + E |
| E5 | low-med | blender geometry | `blender/import_tissue.py:587-589` cells, `:1373` load arrows, `:125-126` colours, `:1391` camera; `src/engine.js:1373` | Cell aspect law differs; Blender uses raw load dial (cartilage amp 0–0.2 → invisible arrows); colours/camera differ | Volume-preserving aspect (`A^0.8`, `A^-0.2`); `loadRange` in exportMeta + normalised `s` in `load_dial()`; `#d9c9a3`, `#4a5a70`, 42°/18.6°; split `--gel-min/--scaffold-min` | S | A (loadRange) + E |
| E6 | low | fixtures | `blender/sample_trajectory.json` (format 1, v0.1), `blender/make_sample_trajectory.py:403` no-overwrite | Default Blender input and README example are stale format 1 | Regenerate via `node tools/run_headless.mjs --tissue fibrous --only maturation --blender blender/sample_trajectory.json`; README/docstring; `tissueName`/`scenarioTitle` optional in exportMeta; fixture dry-run in D7 test | S | E |

Cross-cutting: **every change to `index.html` or `src/**` requires `npm run build` and committing `dist/*.html`** (`npm run check-dist` fails today).

---

## 3. Work packages (file ownership, parallel-safe)

Ownership rule: a package edits only the files listed; shared touch points are additive and named. Order of landing: A's three additive engine changes (revision, `warmFrom`, export fields/`loadRange`) go in first and small so B/C/E can rebase; everything else is independent.

### Package A — engine: solver modes, warm-up, generality (`src/engine.js`, `src/tissues/fibrous.js` params/rules only, `src/tissues/_template.js` schema comments, `tests/engine.test.mjs` engine describes)

Goals
- Make the field solver correct for any D (A1), the pre-run non-blocking (A2), and the cell/load models honest about what the schema promises (A4, A5).
- Add the three small additive hooks other packages consume: `revision` (B1), `warmFrom/warmScenarios` (A2), `fields` + `loadRange` (+ `tissueName`, `scenarioTitle`) in `snapshot()/exportMeta()` (E1, E5, E6).

Resolves: A1, A2 (engine half), A4, A5, B1 (counter), E1 (export half), E5 (`loadRange`).

Acceptance criteria
- `tests/golden/fibrous.json` (3 %) and the new `fibrous.engine.json` (1e-5) pass unchanged: at fibrous defaults lam = 0.144 → explicit mode, `nSub = 1`, `motile: true`, `loadMode: 'tension'` → bit-identical arithmetic.
- New tests: N=16 and dt=0.05 pure-diffusion decay length within a few % of analytic; synthetic field D=1000, `face:+z`, uniform consumption → parabola within tolerance; `validate` warns once naming field, lam and mode; `warmFrom` in 7×500-step slices deepEquals one synchronous `reset('unloading')`, `_fromCache.size === 1`; `state.revision` increments on step/reset/injure/setDials; `snapshot().fields` keys equal `meta.fields.map(f=>f.key)` and each array has N³ entries; `meta.loadRange` equals the load dial `[min,max]`.
- Cartilage o2 (D 0.06) selects sub-cycled/quasi-steady mode and its hypoxic gradient forms in ≲1 simulated day instead of 1–2 weeks (headless z-profile check in `cartilage.js` checks).
- `motile:false` cells have zero displacement after the first repulsion settle; fibrous unchanged.

Risks
- Quasi-steady solve with negative (consumption) sources can go negative → clamp ≥0 or saturable rule; document in EXTENDING.
- Per-cell polarity noise skipped for non-motile types changes RNG consumption → any future non-motile golden must be recorded after this lands; fibrous unaffected.
- `exportMeta` key additions: `tests/engine.test.mjs:346` asserts the exact `cellTypes[0]` key set — add new keys at top level (`fields`, `loadRange`, `tissueName`, `scenarioTitle`), never inside `cellTypes[]`.
- Sub-cycling cost for moderate-lam fields; cap nSub and warn.

### Package B — renderer: data-driven layers, keyboard camera, dirty-check (`src/render.js`, `tools/render_smoke.html`, `tools/render_smoke.mjs`)

Goals
- Stop redundant per-frame work (B1); make the 3D view keyboard-operable and stoppable (B2, B3); give injury a visible, tissue-agnostic marker (B4); let definitions carry non-colour cues and per-field sprite scale (B5, render side); make the definition hex the single colour truth (E4).

Resolves: B1 (consumer), B2, B3 (renderer half), B4, B5 (`fields[].pointScale`), E4 (saturation → 1.0, tone-curve for legend swatches).

Acceptance criteria
- With the sim paused and camera still, `stats.updateMs` ≈ 0 and no `instanceMatrix.needsUpdate` per frame; `render_smoke.html` (fake state, no `revision`) still updates every frame.
- Focused canvas: ←/→/↑/↓ orbit, +/− zoom, Home reframes; Space/R/I/1-9 still reach the app handler; listener removed in `dispose()`; `renderer.resetView()` exists; `setAutoRotate` fires `opts.onAutoRotate`; keydown on canvas stops rotation.
- `state.wound` non-null → wire sphere at `center/L`, radius `radius/L`, opacity decays to a faint persistent outline; `wound: null` (reset, render_smoke) hides it; `INJURE=1 node tools/screenshot_app.mjs` shows the outline.
- `fields[i].pointScale` and `species[i].render` hints are optional with defaults; fibrous renders unchanged when absent.
- `legendSwatches()` returns colours that match the lit view within a documented tolerance; `fiber/cell/gelSaturation` default 1.0 (hex values in tissue definitions re-baked if the owner wants the old punch).

Risks
- three r160 OrbitControls: `rotateLeft/dollyIn` are closure-private and `listenToKeyEvents` is a no-op with `enablePan=false` — manipulate `camera.position` via `Spherical` as specified.
- Skipping `renderer.render()` when idle is out of scope (damping, autoRotate, resize).
- AgX vs ACES retune needs the owner's eyes; ship the saturation/legend fix first, tone-curve change behind `?tm=` A/B.

### Package C — app shell and page: accessibility + usability (`src/app.js`, `index.html`, `src/copy.js`, `src/plots.js`, copy strings in `src/tissues/*.js` `copy`/`dials` blocks only)

Goals
- Remove the interaction traps (C1), the announcement flood (C3), the below-the-fold layout (C8), and the time-control mismatch (C10); add presentation mode (C12), orientation (C13), plot marks and keyboard crosshair (C4, C11); faster and more robust page load (C2); contrast and layout polish (C7, C14, C5); shell copy that a second tissue can override (C15); time-budgeted stepping and idle warm-up (A2 app half, A3); auto-rotate chip (B3 app half); series markers/patterns in plots and keys (B5 app/plots half).

Resolves: C1–C5, C7, C8, C10–C15, A2 (app), A3, B3 (chip), B5 (plots/keys).

Acceptance criteria
- `node tools/screenshot_app.mjs` passes all `check()`s at 1440×900 and 1280×720; `#btn-play` at y<200 in the panel; flux gauge reachable with one short scroll; no slider without `aria-valuetext`; canvas role/label unchanged; `#fps` still written (hidden via CSS).
- Click a scenario chip with the mouse, press Space → play toggles (no reload); Tab then Space on a chip still activates it.
- Screen-reader trace while playing: `#status` announces at most every ~15 s plus on trend change/pause/step/scenario load; flash messages and busy text announced once; `#equilibrium` has no live role.
- `frame()` never exceeds ~8 ms of stepping; "sim slowed" appears in `#fps` when backlog is dropped; first Unloading click after ≥3 s idle is instant (cache warmed via `engine.warmScenarios`).
- Speed default matches the copy (5 d/s or copy rewritten to preset names); `+7 days` pauses at the target without a synchronous 350-step stall; clock shows `(week N.N)`; `screenshot_app` `/day/` label check passes.
- `?present=1`/`P` toggles `body.present`; copied link keeps `present=1`; `.readout canvas` text scales via `fontPx`.
- Contrast script (D) passes with `--control-border`; dist rebuilt.
- `copyEquilibriumSentence` for fibrous is byte-identical to today for a fixed stats object; cartilage supplies its own `stillHint`/thresholds/`equilibrium()`; `FluxGauge` gets `tissue.copy.gauge`.

Risks
- `position: sticky` needs opaque background, z-index and negative margins matching `#panel` padding (16/18 px) or content peeks through.
- Do not hide the `${id}-hint` node the slider's `aria-describedby` points at; collapse only metaphor + Watch.
- Programmatic focus moves in `loadScenario` are unsafe (called from `setTissue` on load and radio change) — announce only.
- `media="print" onload` for fonts may be blocked by the artifact CSP — skip.
- Modulepreload of `./src/*.js` for the dev page must be stripped by `build_single.mjs` or omitted.
- Marks: debounce on simulated time (range inputs fire dozens of events per drag); don't dash live series.

### Package D — docs, tooling, CI, tests, fidelity copy (`docs/**`, `tools/*.mjs`, `tools/plot_scenarios.py`, `tools/lib/`, `tests/**`, `.github/workflows/ci.yml`, `README.md`, `CONTRIBUTING.md`, `blender/README.md`; **copy-only** edits to scenario/dial/readout strings in `src/tissues/fibrous.js` (lines ~115–300) and `_template.js` coordinated with C)

Goals
- Make the build fail loudly and the shipped page verified (D1, D8, C9 vendored offline build, C6 dist rebuild).
- Give the refactor a tight regression signal (D2) and a written step-order contract (A6).
- Reconcile every student/instructor-facing claim with the built model (F1–F9, D3–D5) and make the parameter record single-sourced and machine-checked (D5).
- Tool ergonomics and shared harness code (D6, D7, D9).

Resolves: A6, C6, C9, D1–D9, F1–F9.

Acceptance criteria
- `node tools/build_single.mjs` throws (with file:line) for: a local import whose target is not bundled; any surviving `import`/`export default|{|*`; a syntax error or duplicate declaration in the assembled module (`node --check`). Output bytes unchanged for the current tree → `check-dist` green after one rebuild.
- `tests/golden/fibrous.engine.json` exists and is compared at rel 1e-5 / abs 1e-7; v0.1 file still compared at 3 %; CONTRIBUTING says which file is re-recorded when.
- `tests/export.test.mjs` runs `python3 blender/import_tissue.py --dry-run` on a fresh export per tissue and on both fixtures (skips without python3); CI headless job runs the same dry-run.
- CI screenshot job runs against `dist/tissue-weather.html` too, and `render_smoke.mjs`; a `three@` version-agreement test covers `index.html`, `tools/render_smoke.html`, `docs/SPEC.md`.
- `dist/tissue-weather.offline.html` (or `--vendor` output) renders the 3D view with the network disabled; README "Run it" points classroom users at it.
- `tools/check_params_doc.mjs` (in `npm test`) parses `<!-- params:fibrous -->`/`<!-- params:cartilage -->` blocks in MODEL.md / cartilage-hydrogel.md and fails on any numeric mismatch with `TISSUES[k].params`/`.engine`; SPEC §3 sandbox and kAlign rows corrected; MODEL §2 shows as-built equations.
- TEACHING.md/MODEL.md/fibrous.js copy no longer claims: load alone causes atrophy; tension AND TGF-β required; scar never regains alignment; cells turn orange and wander into the wound; matrix release drives hysteresis; alignment readout = whole-tissue coherence unless the series is `globalFA`. Pin tests added for F2 (strain 0 → 0.4<a<0.65; Gext 0 → a<0.05) and F3 (8-week wound gap <0.1).
- `run_headless.mjs --help` prints usage and exits 0; `--only typo` exits 2 listing runs; `--days=40` works; `_traj.json` written only with `--blender`; `plot_scenarios.py` labels from `meta.title`.
- `screenshot_app.mjs` and `render_smoke.mjs` import `tools/lib/browser.mjs`; curl uses `--fail` with temp/rename; no orphan server after a failure.

Risks
- Any edit to `fibrous.js` (even a comment) makes dist stale — rebuild in the same PR.
- Never retune parameters to fix copy (F1–F3, F7): breaks the golden, scenario checks and hysteresis behaviour. If the owner wants load-driven atrophy or a true AND gate, that is a separate v0.4 model decision with a re-recorded golden.
- Do not re-record `tests/golden/fibrous.json`; do not adopt esbuild; do not reorder bundle files.
- The vendored build must rewrite three's trailing `export {…}` and OrbitControls' `import … from 'three'`; keep MIT header; artifact host CSP blocks `data:`/`blob:` scripts, so keep the CDN artifact variant.

### Package E — Blender parity (`blender/import_tissue.py`, `blender/make_sample_trajectory.py`, `blender/sample_trajectory*.json`, `blender/README.md` §format/§limits, new `src/recipe.js` shared with B)

Goals
- Consume everything the engine now exports (fields, `loadRange`, `tissueName`, `scenarioTitle`) and render it with the same recipes as the web view.

Resolves: E1 (python half), E2, E3, E4 (python half), E5 (python half), E6.

Acceptance criteria
- `--dry-run` on a fresh fibrous export prints `format 2, tissue 'fibrous'`, field counts, and `2 load arrows (strain …)`; on a cartilage export the arrows scale with `(amp − min)/(max − min)` and the o2 haze appears with `--fields o2`.
- Fiber instance parity test (N=2, K=1, seed 90210) agrees with `src/recipe.js` within 1e-6 for offsets, unit vectors and jitters; `--seed`/`--fiber-radius` default to `meta.render` values.
- Cell colour at a=0.5 for the fibroblast pair equals the web LUT entry (OKLab, lift 0.06, saturation as web) within 1/255 per channel; optional `ramp` honoured.
- `blender/sample_trajectory.json` is a format-2 engine export (regenerated via `run_headless --blender`), documented as such; `make_sample_trajectory.py` writes synthetic output to a distinct name or only with `--force`; README §5 limitation line about fields removed.
- Cell aspect law, arrow colour, wire colour and camera direction match `render.js` defaults; gel/scaffold opacity laws documented as per-renderer.

Risks
- `import_tissue.py` must tolerate frames without `fields` and meta without `render`/`loadRange` (older files, headless exports without a renderer).
- `--fields` must default off (matches the web); adding "fields" to `LAYERS` would turn it on via the `--layers` default.
- Depends on A landing the export additions first; until then implement against `make_sample_trajectory.py` output.

---

## 4. Extensibility contract proposal (distilled)

Most of this exists in `docs/EXTENDING.md`; the deltas are marked **new**.

### 4.1 What a tissue definition supplies

```
{
  key, name, version, short, domainMicrons (new, optional — legend scale row),
  species:   [{ key, label, kind: 'fiber'|'gel'|'scaffold', color,
                render: { minDensity, radiusScale, opacity, style } (new, optional, per-kind defaults) }],
  fields:    [{ key, label, color, D, bath: dialKey|null, kBath, decay, boundary: 'bath'|'face:±z',
                mode: 'auto'|'explicit'|'quasiSteady' (new), pointScale (new, render hint) }],
  cellTypes: [{ key, label, colors: [q, a], radius, shape: { by, aspectMin, aspectMax },
                motile (honoured, new), init: { a, b, c }, fraction | count (new), cRange }],
  dials:     [{ key, label, min, max, step, default, format, role?: 'load'|'cellCount',
                biology, watch, metaphor? (optional, aria-hidden in the label) }],
  scenarios: [{ key, title, goal, steps[], question, expect,
                init: { species, from: { scenario, days } }, dials, events[], checks[] }],
  readouts:  [{ key, label, type: 'stack'|'lines'|'log'|'flux', meaning,
                series: [{ stat, label, color, unit, meaning, marker?, pattern? (new) }] }],
  copy:      { intro, legend, metaphorBreaks,
               vocabulary: { matrix, cellsActive, cellsQuiet, cellsMid, stillHint, metaphor{}, activeStiff,
                             activeSoftening, thresholds{ quiet, active, empty, stiffKPa }, equilibrium(stats)? } (new slots),
               gauge: { left, right, caption }? (new) },
  injury:    { radius, fieldBurst, inflam, flash? (new) } | undefined,
  params:    {...frozen numerics},
  engine:    { N, L, K, dt, rCell, kRep, kLoadFib, loadExp, loadMode: 'tension'|'compression' (new), fEvery, eps, rhoMax },
  makeRules(engine, params) -> { cell(ctx), voxel(ctx), stiffness?(ctx) }
}
```

Rules see `ctx.rho[s]` live (includes same-step earlier deposits), `ctx.fiberTotal/fa/fz/E/cellsInVoxel` one voxel-pass stale, `ctx.field[f]`, `ctx.load` (normalised dial), and write `secrete[s]`, `align`, `noise`, `speed`, `dRho[s]`, `fieldSrc[f]`, `E`, `loss`. This is the normative §2.5 (A6): zero accumulators → cells in index order (deposit → align → polarity guide/load/noise → move) → binning/repulsion/walls → voxels (voxel rule → integrate dRho with ≥0 clamp → rescale T to fiber total → passive load alignment → rhoMax clamp on T and fiber species → PSD guard → FA/f/E) → fields (per-field mode). RNG consumption per operation is listed there.

### 4.2 What the engine exposes

- Lifecycle: `new TissueEngine(tissue, { seed, overrides })`, `reset(scenario, { dials, init })`, `step(n)`, `injure(center?)`, `setDials(obj)`, **new** `warmFrom(from, maxSteps)`, `warmScenarios(maxStepsPerCall)`.
- State: `state` getter with typed arrays (`species[i]`, `fields[i]`, `T*`, `fa`, `f`, `E`, `cx/cp/ca/cb/cc/ctype`, `wound`, `dials`, `time`, `L`, `N`) plus **new** `revision` (monotonic; bumped by step/reset/injure/setDials). Renderers/plots key their dirty-checks on it and fall back to "always update" when absent.
- Stats: nested `stats()` (`species.<key>`, `fraction`, `fa`, `globalFA`, `fz`, `logE`, `E`, `cells.{a,b,c,n}`, **new** `cells.byType.<key>`, `fields.<key>`, `deposition`, `degradation`, `ratio`), `stat(path)`, `statFrom`, `woundStats()`.
- Export: `snapshot()` (adds **`fields`**, optional `stats`), `exportMeta(extra)` (adds **`fields`, `loadRange`, `tissueName`, `scenarioTitle`**; optional `render` recipe from the app), format 2 documented in EXTENDING §5.
- Validation: `static validate(t)` returns errors + **new** warnings (field mode/lam, `2·max(radius) < h`, cellCount dial xor `count`); `static checkScenario`.
- Renderer contract: `setTissue(tissue)`, `update(state, layers)` (skips when `revision` unchanged), `setAutoRotate(on)` + `opts.onAutoRotate`, `resetView()`, `legendSwatches()` (tone-mapped), `layoutParams()` (fiber recipe for `meta.render`), wound marker driven by `state.wound`.
- App contract: UI generated from the definition; shell text from `copy.vocabulary`/`copy.gauge` with fibrous-identical defaults; `?tissue=&scenario=&<dial>=&speed=&present=&rotate=`.

### 4.3 Migration order

1. **D first (no behaviour change):** record `tests/golden/fibrous.engine.json`; write EXTENDING §2.5; add build fail-loud checks and `node --check`; rebuild dist. This gives every later step a 1e-5 red/green signal.
2. **A additive hooks:** `revision`, `warmFrom/warmScenarios`, `fields`/`loadRange`/`tissueName`/`scenarioTitle` in export, `loadMode` default `'tension'`, `motile` honoured (fibrous is `motile:true`), `validate` warnings. Golden byte-identical.
3. **A solver modes (A1):** explicit branch unchanged for lam ≤ 1/6; sub-cycle/quasi-steady for others; cartilage o2 check updated. Fibrous golden byte-identical; cartilage checks re-tuned once.
4. **B / C / E in parallel** on top of 2: renderer dirty-check, keyboard camera, wound marker, markers/patterns; app layout/a11y/time controls; Blender consumers.
5. **D fidelity copy and docs** anytime (copy-only), each followed by `npm run build`.
6. Optional later: baked matured snapshot asset (`scenario.init.fromAsset`), Web Worker — only after measuring, and never for the artifact build (CSP).

### 4.4 Regression strategy

- Fibrous: `fibrous.engine.json` at 1e-5 rel (bit-level for explicit-mode fibrous) + v0.1 `fibrous.json` at 3 % (behaviour-similar). Any deliberate model change re-records only the engine file and says so in CONTRIBUTING.
- Cartilage and every registered tissue: conformance suite (schema, determinism, invariants, scenario `checks`, <1 ms/step) already in `tests/engine.test.mjs`; record `cartilage.engine.json` once its o2 solver mode lands.
- New engine tests: diffusion analytic checks (A1), `warmFrom` slice equivalence (A2), `revision` semantics (B1), export shape incl. `fields`/`loadRange` (E1/E5), pin tests for F2/F3.
- Shipped artefacts: `tests/build.test.mjs` + `check-dist` (structure/staleness), CI screenshot run on `dist/tissue-weather.html` (runtime), `render_smoke.mjs` (renderer), python `--dry-run` per tissue and per fixture (Blender contract), params-doc checker (docs/code agreement), contrast checker (palette).
- Manual A/B for visual changes (tone curve, saturation, present mode): `tools/render_smoke.html?tm=…`, `?present=1` screenshot added to `screenshot_app.mjs`.

---

## 5. Dropped findings (one line each)

- **maturedState cache never invalidated (model.js)** — `src/model.js` no longer exists; `TissueEngine._loadFrom` keys the cache by `scenario|days|seed` and params are frozen.
- **Global Space shortcut hijacks `<summary>`/`<a>`** — `onKey` (`app.js:210`) already returns early for BUTTON/A/SUMMARY/INPUT/SELECT/TEXTAREA; shortcuts are documented in About and `aria-keyshortcuts`.
- **Legend hidden below 900 px / title-only descriptions / unlabelled chips** — legend is a `<details>` at all widths with visible guide text; `#layers` has `role=group aria-label`.
- **Every scenario load and Reset auto-plays (`wasPlaying || true`)** — replaced in 98f74d6 by `setPlaying(o.autoplay ?? wasPlaying)`; first load is paused (survives only in the stale dist → C6).
- **No deep-linkable state** — `?tissue=&scenario=&<dial>=&speed=` parsing, debounced `replaceState` and a Copy-link button exist (`app.js` constructor, `buildUrl`, `copyLink`).
- **Fibroblast rules inlined in `_step`; no engine/tissue split** — implemented in ce76881 (`src/engine.js` + `src/tissues/*`), with template, registry and per-tissue conformance tests.
- **Renderer hard-codes two-colour ramps, no gel/scaffold layer** — b40ec17 made the renderer definition-driven (gel, scaffold, per-type LUTs, per-field point clouds, `legendSwatches`).
- **App hard-codes dial order/ranges/legend/series; injure fibrous-specific** — UI is generated from the definition; `#btn-injure` toggled by `tissue.injury`; export meta is format 2.
- **Test suite fibrous-only / no conformance harness (two findings)** — `tests/engine.test.mjs` iterates `TISSUES` + `_template` through the six EXTENDING §7 checks; 74 tests pass.
- **EXTENDING.md documents a non-existent architecture; README does not link it** — all named artefacts exist; README links EXTENDING twice.
- **No LICENSE / CITATION** — `LICENSE` (MIT + CC BY 4.0 clause), `CITATION.cff`, `CONTRIBUTING.md` exist; README has Citing and Licence sections.
- **README lacks prerequisites/quick-start/limitations/tool inventory** — README now has instructor and student quick starts, tool table, Node ≥ 20, browser support and known limitations; `scratch/` is ignored.
- **No package.json / CI** — both exist (21dad47) with test, check-dist, build, headless and screenshot jobs; the proposed replacement would drop scripts and add an unwanted dependency.
- **dist/ never verified against src** — `tools/check_dist.mjs` + CI `git diff --exit-code -- dist` exist (dist is merely stale right now → C6).
- **Golden data recorded but no test reads it** — `tests/engine.test.mjs:142-199` replays all five runs (subsumed by D2's tightening).
- **Performance assertions 10–30× too loose** — cited `model.test.mjs` is gone; current bound is `< 1 ms/step` (measured 0.25–0.37 ms), matured-state test asserts a cache ratio.
- **Export meta lacks the load-dial key** — `exportMeta()` already emits `loadDial`/`cellCountDial` with tests (`engine.test.mjs:677-689`); `loadRange` is the remaining gap (E5).
- **Flat stats keys consumed everywhere** — nested `stats()`, `stat(path)`, generic `woundStats`, `--tissue`, definition-derived CSV columns and meta-driven plots already exist; only run labels remain (D6).

### Unverified low-severity items — triage

| item | disposition |
|---|---|
| Reset always resumes playback (`wasPlaying \|\| true`) | stale — dropped (see above) |
| Stiffness readout prints `1.5e+2 kPa` | fold into C (verify `toPrecision` still used in `yFormat`/`.val`; add `fmtKPa`) |
| Browser export misses t=0 frame, meta lacks seed/L | partly stale (meta now from `exportMeta`); check `captureExport()` on reset → C |
| Repulsion assumes `2·rCell < h` unchecked | fold into A5 (`validate` warning) |
| Export ring buffer 7.4 MB / 8.5 MB stringify | defer; revisit if Worker/asset work happens |
| `stats()` + 4 DOM writes every frame | fold into A3/B1 (compute stats only when `revision` changed, at plot cadence) |
| Plots force layout per draw, unthrottled pointermove | fold into C4 (ResizeObserver-cached size, rAF-throttled hover) |
| MSAA at DPR 2, no adaptive resolution | fold into B (start at `min(dpr,1.5)`, adaptive pixel ratio, quality chip) — low priority |
| Step profile / padded-grid diffusion | informs A1 design (branch-free padded stencil per field); not a separate item |
| Landmarks: controls in `<aside>`, subtitle in h1, readout titles `<b>` | fold into C (make `#panel` the `<main>`, `<h3>` readout titles, skip link) — verify current markup first |
| Export buried/misnamed, no CSV/PNG | defer; D4 fixes the doc mismatch, `renderer.screenshot()` exposure optional |
| Weather metaphor hard-wired in shell | subsumed by C15 (vocabulary/gauge slots, optional metaphor) |
| Tablet/phone: legend, touch targets, tap-to-pin | partly stale (legend present); `@media (pointer: coarse)` targets and tap-to-pin → C, low |
| Single-file build fixed list / prefix convention | stale (tissues auto-discovered); residual = D1 |
| Blender importer format-1 only | stale (format 2 implemented in 8a0b8f0); residual = E1 |
| `model.js` header test command | stale (file removed; `npm test` exists) |
| TEACHING expectations: fibrosis "dip", wound "within days", Metzcar year | fold into D fidelity pass (verify numbers on current engine) |
| SPEC.md speed range / §0 layout / §1.10 meta keys | fold into D3 |
| Orphaned/oversized docs/img screenshots | fold into D (embed or delete `wound-day20.png`, downscale to ≤200 KB) |
| Metaphor words collide with culture variables | subsumed by C5/C15 (optional metaphor, aria-hidden) |
| Maturation card hides 2–3 day evaporation dip; "alignment leads maturity" | fold into D fidelity pass (verify with `run_headless`) |
| Unloading step 3 points at 3D colour rather than density plot | fold into D fidelity pass |
| Fibers pop in at fixed hairline radius (minRho 0.03, floor 0.025h) | fold into B (ramp instead of hard cut; per-species `render.minDensity`) |
| Field haze via `gl_PointSize` device-dependent | fold into B, after B5; instanced-sphere haze shared with gel is the long-term path |
| Render kinds registry + CSS palette from definition | fold into B (kind table) and C (`--accent`/`--cool`/`--cell-*` set in `setTissue`) — design item for the next renderer pass |
