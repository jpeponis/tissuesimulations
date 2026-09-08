#!/usr/bin/env node
// Playwright screenshot / performance harness for src/render.js (EXTENDING.md §4).
//
//   node tools/render_smoke.mjs --out /path/to/outdir [--port 8123] [--url http://host:port]
//        [--perf-seconds 5] [--width 1280] [--height 800] [--force-cache] [--no-cache] [--scenes a,b]
//        [--extra "name=params,name2=params2"] [--skip-functional] [--skip-perf]
//        [--proxy http://host:port]  (explicit proxy; default = Chromium's env pickup)
//
// Serves the repo root over http (ES modules do not load from file://), opens
// tools/render_smoke.html in headless Chromium with SwiftShader WebGL, takes
// screenshots of both fake tissues at three moments each (plus field / gel-style /
// wound variants), verifies frames are not blank, checks that three.js loads from
// jsdelivr (through any HTTPS_PROXY, with a local cache fallback), exercises the
// §4 API (setTissue, layers, legendSwatches, rebuild, dispose, framing at aspect
// 0.6 and 2.4, prefers-reduced-motion) and measures update() CPU time per layer
// set. Exit code 1 on failure.
//
// It also checks the v0.4 renderer work (docs/REVIEW.md §3 package B):
//   B1  with `state.revision` unchanged, update() uploads nothing — the instance buffers'
//       `.version` counters and stats.updates/skipped prove it — and a state WITHOUT
//       `revision` still rebuilds every frame (the fallback this page uses by default)
//   B2  the focused canvas orbits on the arrow keys, dollies on +/−, reframes on Home, and
//       leaves Space / R / I / digits to the app (no preventDefault, no camera move)
//   B3  a key press stops auto-rotate and fires opts.onAutoRotate
//   B4  the wound marker follows state.wound, decays to a persistent outline, and hides when
//       the state has no wound or the `wound` layer is off — and, in pixels, the outline really
//       reaches the screen, fresh AND after it has faded (the acceptance criterion itself)
//   B5  fields[].pointScale / fields[].style and the species `render` hints (minDensity /
//       radiusScale / opacity), including the warning for a hint key its kind cannot honour
//   §5  the field haze is instanced spheres by default (no gl_PointSize, whose ceiling is the
//       driver's), `opt.fieldStyle=points` still draws the v0.1 sprite cloud, and the two agree
//       on the blob diameter up to the documented `fieldSphereDiameter` factor
//   E2  renderer.layoutParams() is the src/recipe.js `meta.render` shape
//   E4  saturation factors default to 1.0 and TissueRenderer.toneMap() matches the GPU tone
//       curve (ACES / AgX / none) to ≤ 1/255 per channel, which is what legendSwatches() uses
import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { withHarness, routeCdnCache } from './lib/browser.mjs';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// ----------------------------------------------------------------------------
// args
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const has = (name) => args.includes('--' + name);
const outDir = resolve(opt('out', join(os.tmpdir(), 'tissue-render-smoke')));
const port = +opt('port', 8123);
const extUrl = opt('url', null);
const perfSeconds = +opt('perf-seconds', 5);
const width = +opt('width', 1280), height = +opt('height', 800);
const cacheDir = resolve(opt('cache-dir', join(outDir, 'cdn-cache')));
const sceneFilter = opt('scenes', null);
const extraScenes = opt('extra', null);
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const CDN_PROBE = CDN_ORIGIN + '/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';

// ----------------------------------------------------------------------------
const summary = { ok: true, startedAt: new Date().toISOString(), outDir, cdn: {}, gl: null, scenes: [], perf: null, problems: [] };
const problem = (m) => { summary.problems.push(m); console.log('PROBLEM:', m); };

/**
 * The whole run, inside a harness that owns the file server and the browser: `withHarness`
 * closes both whether this throws or not, so a failed assertion half-way down can no longer
 * leave a listening socket and a headless Chromium behind (docs/REVIEW.md D9).
 */
async function runSmoke({ browser, context, url }) {
  const baseUrl = extUrl || url;
  console.log('serving', extUrl ? '(external)' : repoRoot, 'at', baseUrl);
  console.log('chromium', browser.version(), opt('proxy', null) ? `via --proxy ${opt('proxy', null)}` : `env proxy: ${process.env.HTTPS_PROXY || 'none'}`);

  // --- 1. does jsdelivr load directly in this Chromium? --------------------------------
  let useCache = has('force-cache');
  if (!has('force-cache')) {
    const p = await context.newPage();
    const t0 = Date.now();
    try {
      const resp = await p.goto(CDN_PROBE, { timeout: 25000 });
      const body = await resp.text();
      summary.cdn.direct = { ok: resp.status() === 200 && body.length > 1000, status: resp.status(), bytes: body.length, ms: Date.now() - t0 };
    } catch (e) {
      summary.cdn.direct = { ok: false, error: e.message.split('\n')[0], ms: Date.now() - t0 };
    }
    await p.close();
    console.log('CDN direct from Chromium:', JSON.stringify(summary.cdn.direct));
    if (!summary.cdn.direct.ok) {
      problem(`jsdelivr not reachable from headless Chromium (${summary.cdn.direct.error || summary.cdn.direct.status})`);
      if (!has('no-cache')) useCache = true;
    }
  }
  if (useCache) {
    // Prove the CDN is reachable through the proxy at all (curl), then serve cached copies.
    try {
      const { stdout } = await execFileP('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '--max-time', '60', CDN_PROBE]);
      const [code, bytes] = stdout.trim().split(' ');
      summary.cdn.curl = { ok: code === '200', status: +code, bytes: +bytes };
    } catch (e) { summary.cdn.curl = { ok: false, error: e.message.split('\n')[0] }; }
    console.log('CDN via curl through proxy:', JSON.stringify(summary.cdn.curl));
    summary.cdn.mode = 'route-intercept-cache';
    // tools/lib/browser.mjs owns the cache: curl --fail into `<file>.part` and rename on success,
    // so a 404 page can never be served back as JavaScript (docs/REVIEW.md D9). `--cache-dir`
    // still decides where it lives, and a miss is a problem rather than a half-dressed page.
    await routeCdnCache(context, { origins: [CDN_ORIGIN], cacheDir, onMiss: (url, e) => problem(`cache fetch failed for ${url}: ${e.message.split('\n')[0]}`) });
  } else summary.cdn.mode = 'direct';

  // --- 2. scenes --------------------------------------------------------------------
  let scenes = [
    // fibrous connective tissue: three times
    { name: 'fibrous_01_t0_sparse', params: 'tissue=fibrous&t=0&strain=0.15' },
    { name: 'fibrous_02_t12_wounded', params: 'tissue=fibrous&t=12' },
    { name: 'fibrous_03_t60_dense_aligned', params: 'tissue=fibrous&t=60' },
    { name: 'fibrous_04_t25_fields_g_m', params: 'tissue=fibrous&t=25&fields=g,m' },
    { name: 'fibrous_05_t40_cells_only', params: 'tissue=fibrous&t=40&fibers=0' },
    { name: 'fibrous_06_t6_wound_marker', params: 'tissue=fibrous&t=6' },
    { name: 'fibrous_07_t45_wound_faded', params: 'tissue=fibrous&t=45' },
    // the same field haze in both styles, side by side: instanced spheres (the default) and the
    // v0.1 gl_PointSize sprite cloud, whose size a driver may clamp (docs/REVIEW.md §5)
    { name: 'fibrous_08_t25_fields_points', params: 'tissue=fibrous&t=25&fields=g,m&opt.fieldStyle=points' },
    // cartilage in a dissolving hydrogel: three times
    { name: 'cartilage_01_t0_scaffold', params: 'tissue=cartilage&t=0' },
    { name: 'cartilage_02_t20_dissolving', params: 'tissue=cartilage&t=20' },
    { name: 'cartilage_03_t60_gel_network', params: 'tissue=cartilage&t=60' },
    { name: 'cartilage_04_t30_fields', params: 'tissue=cartilage&t=30&fields=tgf,o2,cat&gel=0&scaffold=0' },
    { name: 'cartilage_05_t20_gel_points', params: 'tissue=cartilage&t=20&opt.gelStyle=points' },
    { name: 'cartilage_06_t20_scaffold_only', params: 'tissue=cartilage&t=20&gel=0&fibers=0&cells=0' },
    { name: 'cartilage_07_t45_radius_by_state', params: 'tissue=cartilage&t=45&gel=0&scaffold=0&fibers=0&radiusByState=1' },
    { name: 'cartilage_08_t30_fields_points', params: 'tissue=cartilage&t=30&fields=tgf,o2,cat&gel=0&scaffold=0&opt.fieldStyle=points' },
  ];
  if (extraScenes) for (const kv of extraScenes.split(',')) { const i = kv.indexOf('='); if (i > 0) scenes.push({ name: kv.slice(0, i), params: kv.slice(i + 1).replace(/;/g, '&') }); }
  scenes = scenes.filter((s) => !sceneFilter || sceneFilter.split(',').includes(s.name));

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { const line = `[${m.type()}] ${m.text()}`; if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(line); console.log('  console', line.slice(0, 300)); });
  page.on('pageerror', (e) => { consoleErrors.push('[pageerror] ' + e.message); console.log('  pageerror', e.message); });
  page.on('requestfailed', (r) => { const line = `[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}`; consoleErrors.push(line); console.log(' ', line); });

  const open = async (params, pg = page) => {
    const url = `${baseUrl}/tools/render_smoke.html?${params}${/(^|&)hud=/.test(params) ? '' : '&hud=0'}${/(^|&)auto=/.test(params) ? '' : '&auto=0'}`;
    await pg.goto(url, { waitUntil: 'load', timeout: 120000 });
    try {
      await pg.waitForFunction(() => window.__smoke !== undefined, null, { timeout: 45000 });
    } catch (e) {
      const dump = await pg.evaluate(() => ({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 300) })).catch(() => null);
      throw new Error(`smoke page did not initialise at ${url}: ${e.message.split('\n')[0]} page=${JSON.stringify(dump)}`);
    }
    await pg.evaluate(() => window.__smoke.ready);
    await pg.evaluate(() => window.__smoke.waitFrames(3));
    return url;
  };

  for (const sc of scenes) {
    const t0 = Date.now();
    const url = await open(sc.params);
    const file = join(outDir, sc.name + '.png');
    await page.screenshot({ path: file });
    const px = await page.evaluate(() => window.__smoke.probePixels());
    const st = await page.evaluate(() => window.__smoke.stats());
    if (!summary.gl) { summary.gl = await page.evaluate(() => window.__smoke.glInfo()); console.log('GL:', JSON.stringify(summary.gl)); }
    const blank = px.litFrac < 0.005;
    if (blank) problem(`${sc.name}: frame looks blank (litFrac ${px.litFrac})`);
    summary.scenes.push({ ...sc, url, file, pixels: px, fibersVisible: st.fibersVisible, cells: st.cells, gelVisible: st.gelVisible, strutsVisible: st.strutsVisible, ms: Date.now() - t0 });
    console.log(`scene ${sc.name}: ${file}  pixels=${JSON.stringify(px)} fibers=${st.fibersVisible} cells=${st.cells} gel=${st.gelVisible} struts=${st.strutsVisible}`);
  }

  // renderer.screenshot() data URL round-trip on the last scene
  if (scenes.length) {
    const shot = await page.evaluate(() => window.__smoke.renderer.screenshot());
    if (!/^data:image\/png;base64,/.test(shot) || shot.length < 5000) problem('renderer.screenshot() did not return a plausible PNG data URL');
    else {
      const file = join(outDir, 'renderer_screenshot_dataurl.png');
      await writeFile(file, Buffer.from(shot.split(',')[1], 'base64'));
      summary.screenshotDataUrl = { bytes: shot.length, file };
    }
  }

  // --- 2b. functional checks -------------------------------------------------------------
  const fn = {};
  if (!has('skip-functional')) {
    await open('tissue=fibrous&t=20&auto=1');
    fn.autoRotateBefore = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.mouse.up();
    fn.autoRotateAfterPointerDown = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    await page.evaluate(() => window.__smoke.renderer.setAutoRotate(true));
    fn.setAutoRotateTrue = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    if (!(fn.autoRotateBefore === true && fn.autoRotateAfterPointerDown === false && fn.setAutoRotateTrue === true))
      problem('autoRotate did not stop on pointerdown / setAutoRotate failed: ' + JSON.stringify(fn));

    // resize follows the parent; framing keeps the cube inside the viewport at aspect 0.6 and 2.4
    fn.framing = {};
    for (const [w, h] of [[600, 1000], [1440, 600], [900, 600]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => window.__smoke.waitFrames(2));
      const size = await page.evaluate(() => ({ w: window.__smoke.renderer.canvas.width, h: window.__smoke.renderer.canvas.height }));
      if (size.w !== w || size.h !== h) problem(`resize did not follow the parent at ${w}x${h}: ` + JSON.stringify(size));
      await page.evaluate(() => window.__smoke.setTime(60));
      await page.evaluate(() => window.__smoke.waitFrames(2));
      const px = await page.evaluate(() => window.__smoke.probePixels());
      await page.screenshot({ path: join(outDir, `framing_${w}x${h}.png`) });
      fn.framing[`${w}x${h}`] = px.bbox;
      const bb = px.bbox;
      if (!bb || bb.x0 < 0.01 || bb.x1 > 0.99 || bb.y0 < 0.005 || bb.y1 > 0.995) problem(`framing at ${w}x${h}: content touches the frame edge ${JSON.stringify(bb)}`);
    }
    await page.setViewportSize({ width, height });

    // tissue switch, rebuild on N change, capacity growth, layer toggles, legend
    fn.api = await page.evaluate(() => {
      const S = window.__smoke, r = S.renderer, mk = S.makeFakeState, out = {};
      r.update(mk(8, 50, 20, {}, 'fibrous')); r.render(); out.countN8 = r.fibers.count; out.cellsN8 = r.stats.cells;
      r.update(mk(12, 700, 20, {}, 'fibrous')); r.render(); out.countN12 = r.fibers.count; out.cells700 = r.stats.cells; out.capacity = r.cells.capacity;
      out.fibrousHasNoGel = r.gel === null && r.scaffold === null;
      out.fibrousLoadVisible = r.load.group.visible;
      r.update(mk(12, 160, 20, {}, 'fibrous'), { fibers: false, cells: true, fields: { g: true, m: true } }); r.render();
      out.fibersHidden = !r.fibers.mesh.visible; out.gVisible = r.fields[0].obj.visible; out.mVisible = r.fields[1].obj.visible;
      r.update(mk(12, 160, 20, {}, 'fibrous')); r.render(); out.gHiddenAgain = !r.fields[0].obj.visible;
      out.legendFibrous = r.legendSwatches().map((s) => s.key);
      // switch tissue
      S.setTissue('cartilage');
      const st = mk(12, 160, 20, {}, 'cartilage');
      r.update(st); r.render();
      out.cartilageGel = r.gel !== null && (r.gel.mesh || r.gel.points).visible; out.cartilageScaffold = r.scaffold !== null && r.scaffold.mesh.visible;
      out.gelVisible = r.stats.gelVisible; out.strutsVisible = r.stats.strutsVisible; out.strutCount = r.scaffold.count;
      out.cartilageLoadVisible = r.load.group.visible;
      r.update(st, { gel: false, scaffold: false }); r.render();
      out.gelHidden = !(r.gel.mesh || r.gel.points).visible; out.scaffoldHidden = !r.scaffold.mesh.visible;
      out.legendCartilage = r.legendSwatches().map((s) => `${s.kind}:${s.key}`);
      out.legendCssSample = r.legendSwatches().map((s) => s.css.slice(0, 60));
      // a tissue without a load dial hides the arrows
      r.setTissue({ key: 'x', species: [{ key: 'gag', kind: 'gel', color: '#b48cff' }], fields: [], cellTypes: [{ key: 'c', colors: ['#ffffff', '#000000'], radius: 0.02 }], dials: [] });
      r.update(st); r.render(); out.noLoadDialHidesArrows = !r.load.group.visible;
      out.stateWithoutKeysOk = (() => { try { r.setTissue(null); r.update({ N: 6, nCells: 0, species: [], fields: [] }); r.render(); return r.fibers.count === 6 * 6 * 6 * r.opts.K; } catch (e) { return 'threw: ' + e.message; } })();
      S.setTissue('fibrous');
      return out;
    });
    const a = fn.api;
    if (a.countN8 !== 8 * 8 * 8 * 3 || a.countN12 !== 12 * 12 * 12 * 3 || a.cells700 !== 700 || a.capacity < 700
        || !a.fibersHidden || !a.gVisible || !a.mVisible || !a.gHiddenAgain || !a.fibrousHasNoGel || !a.fibrousLoadVisible)
      problem('rebuild / capacity growth / layer toggles (fibrous) failed: ' + JSON.stringify(a));
    if (!a.cartilageGel || !a.cartilageScaffold || !(a.gelVisible > 100) || !(a.strutsVisible > 100) || a.strutCount !== 3 * 1728 + 3 * 144
        || !a.gelHidden || !a.scaffoldHidden || !a.cartilageLoadVisible || !a.noLoadDialHidesArrows || a.stateWithoutKeysOk !== true)
      problem('tissue switch / gel / scaffold checks failed: ' + JSON.stringify(a));
    const expectFib = ['species:new', 'species:mat', 'cell:fibroblast', 'field:g', 'field:m', 'load:strain'];
    if (JSON.stringify(a.legendFibrous) !== JSON.stringify(expectFib)) problem('legendSwatches (fibrous) mismatch: ' + JSON.stringify(a.legendFibrous));
    const expectCart = ['fiber:species:col2', 'fiber:species:col1', 'gel:species:gag', 'scaffold:species:scaffold', 'cell:cell:chondrocyte', 'field:field:tgf', 'field:field:o2', 'field:field:cat', 'load:load:load'];
    if (JSON.stringify(a.legendCartilage) !== JSON.stringify(expectCart)) problem('legendSwatches (cartilage) mismatch: ' + JSON.stringify(a.legendCartilage));

    // prefers-reduced-motion → autoRotate defaults off (explicit auto=1 still opts in)
    const rm = await context.newPage();
    await rm.emulateMedia({ reducedMotion: 'reduce' });
    await rm.goto(`${baseUrl}/tools/render_smoke.html?tissue=fibrous&t=10&hud=0`, { waitUntil: 'load', timeout: 120000 });
    await rm.waitForFunction(() => window.__smoke !== undefined, null, { timeout: 45000 });
    await rm.evaluate(() => window.__smoke.ready);
    fn.reducedMotionAutoRotate = await rm.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    await rm.goto(`${baseUrl}/tools/render_smoke.html?tissue=fibrous&t=10&hud=0&auto=1`, { waitUntil: 'load', timeout: 120000 });
    await rm.waitForFunction(() => window.__smoke !== undefined, null, { timeout: 45000 });
    await rm.evaluate(() => window.__smoke.ready);
    fn.reducedMotionExplicitOptIn = await rm.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    await rm.close();
    if (fn.reducedMotionAutoRotate !== false || fn.reducedMotionExplicitOptIn !== true) problem('prefers-reduced-motion default failed: ' + JSON.stringify({ a: fn.reducedMotionAutoRotate, b: fn.reducedMotionExplicitOptIn }));

    // --- B4: the wound marker follows state.wound and fades to a persistent outline -----------
    await open('tissue=fibrous&t=6');
    fn.wound = { fresh: await page.evaluate(() => window.__smoke.woundState()) };
    await page.evaluate(() => window.__smoke.setTime(45));
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.wound.old = await page.evaluate(() => window.__smoke.woundState());
    await page.evaluate(() => window.__smoke.setTime(1));            // before the injury: no wound
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.wound.none = await page.evaluate(() => window.__smoke.woundState());
    await open('tissue=fibrous&t=6&woundLayer=0');
    fn.wound.layerOff = await page.evaluate(() => window.__smoke.woundState());
    {
      const w = fn.wound, exp = (age) => 0.15 + 0.55 * Math.exp(-age / 7);
      if (!w.fresh.visible || Math.abs(w.fresh.opacity - exp(2)) > 1e-3 || Math.abs(w.fresh.scale - 0.24) > 1e-3
          || Math.abs(w.fresh.pos[0] - 0.72) > 1e-3 || Math.abs(w.fresh.pos[1] - 0.32) > 1e-3)
        problem('wound marker (fresh) wrong: ' + JSON.stringify(w.fresh));
      if (!w.old.visible || Math.abs(w.old.opacity - exp(41)) > 1e-3) problem('wound marker did not fade to the persistent outline: ' + JSON.stringify(w.old));
      if (w.none.visible) problem('wound marker shown for a state without a wound: ' + JSON.stringify(w.none));
      if (w.layerOff.visible) problem('wound marker shown with the wound layer off: ' + JSON.stringify(w.layerOff));
    }

    // --- B2/B3: keyboard camera on the focused canvas, and it stops auto-rotate ---------------
    await open('tissue=fibrous&t=20&auto=1');
    await page.evaluate(() => window.__smoke.focusCanvas());
    fn.keyboard = { focused: await page.evaluate(() => document.activeElement && document.activeElement.id) };
    fn.keyboard.autoRotateBefore = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
    // the first key stops the auto-rotation (B3); Home then puts the camera back on the default
    // framing, which is the fixed reference the orbit/dolly assertions below start from
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Home');
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.keyboard.start = await page.evaluate(() => window.__smoke.cameraState());
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.keyboard.afterRight = await page.evaluate(() => window.__smoke.cameraState());
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.keyboard.afterUp = await page.evaluate(() => window.__smoke.cameraState());
    await page.keyboard.press('-');
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.keyboard.afterMinus = await page.evaluate(() => window.__smoke.cameraState());
    await page.keyboard.press('+');
    await page.keyboard.press('Home');
    await page.evaluate(() => window.__smoke.waitFrames(2));
    fn.keyboard.afterHome = await page.evaluate(() => window.__smoke.cameraState());
    fn.keyboard.autoRotateEvents = await page.evaluate(() => window.__smoke.autoRotateEvents.slice());
    // keys the app owns must not be swallowed, and must not move the camera
    fn.keyboard.appKeys = await page.evaluate(async () => {
      const seen = [];
      const h = (e) => seen.push(`${e.key}:${e.defaultPrevented}`);
      window.addEventListener('keydown', h);
      const before = window.__smoke.cameraState();
      for (const k of [' ', 'r', 'i', '1']) window.__smoke.renderer.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      window.removeEventListener('keydown', h);
      const after = window.__smoke.cameraState();
      return { seen, moved: JSON.stringify(before.pos) !== JSON.stringify(after.pos) };
    });
    {
      const k = fn.keyboard, d = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
      if (k.focused !== 'c') problem('canvas did not take focus: ' + k.focused);
      if (!(d(k.start, k.afterRight) > 0.05) || Math.abs(k.afterRight.pos[2] - k.start.pos[2]) > 1e-3)
        problem('ArrowRight did not orbit around the up axis: ' + JSON.stringify([k.start, k.afterRight]));
      if (!(k.afterUp.pos[2] > k.afterRight.pos[2] + 0.05) || Math.abs(k.afterUp.dist - k.start.dist) > 1e-3)
        problem('ArrowUp did not lift the camera at a constant distance: ' + JSON.stringify([k.afterRight, k.afterUp]));
      if (!(k.afterMinus.dist > k.afterUp.dist * 1.05)) problem('"-" did not dolly out: ' + JSON.stringify([k.afterUp, k.afterMinus]));
      // OrbitControls' damping keeps bleeding a little of the stopped auto-rotation for a few
      // frames, so "back to the default framing" is within a fraction of a voxel, not exact
      if (d(k.afterHome, k.start) > 0.02) problem('Home did not restore the default framing: ' + JSON.stringify([k.start, k.afterHome]));
      if (k.autoRotateBefore !== true || k.afterRight.autoRotate !== false || k.autoRotateEvents[0] !== false)
        problem('a key press did not stop auto-rotate / fire onAutoRotate: ' + JSON.stringify([k.autoRotateBefore, k.autoRotateEvents]));
      if (k.appKeys.moved || k.appKeys.seen.some((x) => x.endsWith(':true')))
        problem('the renderer swallowed or acted on an app shortcut: ' + JSON.stringify(k.appKeys));
    }

    // --- B1: with state.revision unchanged, update() uploads nothing --------------------------
    await open('tissue=fibrous&t=20&revision=1&auto=0');
    await page.evaluate(() => window.__smoke.waitFrames(4));
    const b0 = await page.evaluate(() => window.__smoke.bufferVersions());
    await page.evaluate(() => window.__smoke.waitFrames(20));
    const b1 = await page.evaluate(() => window.__smoke.bufferVersions());
    await page.evaluate(() => window.__smoke.setTime(21));
    await page.evaluate(() => window.__smoke.waitFrames(3));
    const b2 = await page.evaluate(() => window.__smoke.bufferVersions());
    // layer toggles must not be skipped either
    await page.evaluate(() => window.__smoke.setLayers({ fibers: false }));
    await page.evaluate(() => window.__smoke.waitFrames(3));
    const b3 = await page.evaluate(() => window.__smoke.bufferVersions());
    fn.dirty = { paused: b1, afterTime: b2, afterLayer: b3, skippedFrames: b1.skipped - b0.skipped, updatesWhilePaused: b1.updates - b0.updates };
    if (!(fn.dirty.skippedFrames >= 15) || fn.dirty.updatesWhilePaused !== 0 || b1.fibers !== b0.fibers || b1.cells !== b0.cells)
      problem('paused frames still rebuilt instance buffers: ' + JSON.stringify(fn.dirty));
    // The buffer versions above are the EXACT proof that the skip path uploaded nothing; the
    // timing below is only a sanity check, and it is deliberately loose. Chromium quantises
    // performance.now() to 100 µs, so a skip reads as 0.0 or 0.1 ms and the old `<= 0.15` bound
    // failed on the very next tick — a scheduler wobble on a loaded CI runner turned a required
    // job red (round-3 review B, finding 6). A skip must simply cost less than a rebuild, and
    // the comparison is only made when the rebuild is big enough for the clock to resolve.
    fn.dirty.cost = await page.evaluate(() => window.__smoke.updateCost());
    if (!(b1.updateMs <= 1)) problem(`update() while paused took ${b1.updateMs} ms (expected ≈ 0, hard cap 1 ms)`);
    {
      const c = fn.dirty.cost;
      if (c.skipped !== c.n || c.rebuilt !== c.n) problem('updateCost() did not exercise both paths: ' + JSON.stringify(c));
      else if (!(c.skipMs < 0.5 * c.fullMs)) problem(`the skip path (${c.skipMs} ms) is not materially cheaper than a rebuild (${c.fullMs} ms)`);
    }
    if (b2.updates !== b1.updates + 1 || b2.fibers <= b1.fibers) problem('a new revision did not rebuild: ' + JSON.stringify([b1, b2]));
    if (b3.updates !== b2.updates + 1) problem('a layer change did not rebuild: ' + JSON.stringify([b2, b3]));
    // without `revision` (the default for this page) every frame must still update
    await open('tissue=fibrous&t=20&auto=0');
    const c0 = await page.evaluate(() => window.__smoke.bufferVersions());
    await page.evaluate(() => window.__smoke.waitFrames(10));
    const c1 = await page.evaluate(() => window.__smoke.bufferVersions());
    fn.dirty.fallbackUpdates = c1.updates - c0.updates;
    if (!(fn.dirty.fallbackUpdates >= 8) || c1.skipped !== c0.skipped)
      problem('a state without `revision` must always update: ' + JSON.stringify(fn.dirty));

    // --- E4: legend swatches carry the same tone curve the GPU applies ------------------------
    fn.tone = {};
    for (const mode of ['aces', 'agx', 'none']) {
      const r = await page.evaluate((m) => window.__smoke.toneCurveCheck(m, 1.08), mode);
      fn.tone[mode] = { maxDelta: r.maxDelta, sample: r.entries[0] };
      if (r.maxDelta > 1) problem(`CPU tone curve '${mode}' differs from the GPU by ${r.maxDelta}/255: ` + JSON.stringify(r.entries));
    }
    fn.saturationDefaults = await page.evaluate(() => {
      const o = window.__smoke.renderer.opts;
      return { fiber: o.fiberSaturation, cell: o.cellSaturation, gel: o.gelSaturation, scaffold: o.scaffoldSaturation };
    });
    if (Object.values(fn.saturationDefaults).some((v) => v !== 1))
      problem('saturation factors must default to 1.0 so the definition hex is the colour: ' + JSON.stringify(fn.saturationDefaults));

    // --- B5 / E2: field pointScale + style, species render hints, meta.render recipe ----------
    fn.hints = await page.evaluate(() => {
      const S = window.__smoke, r = S.renderer, out = {};
      const T = JSON.parse(JSON.stringify(S.tissues.cartilage));
      r.setTissue(T);
      r.update(S.makeFakeState(12, 160, 20, {}, 'cartilage'), { fields: { tgf: true } });
      out.fieldsDefault = S.fieldState();
      out.gelMinDefault = r.opts.gelMin;
      T.fields[0].pointScale = 2.5;
      T.fields[1].style = 'points';           // one field asks for the sprite cloud by itself
      T.species.find((s) => s.kind === 'gel').render = { minDensity: 0.4, radiusScale: 0.5, opacity: 0.5 };
      T.species.find((s) => s.kind === 'scaffold').render = { minDensity: 0.5 };
      // Hint keys the kind cannot honour must be reported, not silently dropped (review B, #4).
      // This is where the two `TissueRenderer: species 'col2' … is ignored` warnings in
      // summary.consoleErrors come from — they are the check passing, not a page problem.
      T.species.find((s) => s.kind === 'fiber').render = { opacity: 0.5, style: 'points', wobble: 3 };
      r.setTissue(T);
      r.update(S.makeFakeState(12, 160, 20, {}, 'cartilage'), { fields: { tgf: true, o2: true } });
      out.fieldsHinted = S.fieldState();
      out.gelOpacity = r.gelMat.uniforms.uOpacity.value;
      out.fiberOpacity = r.fiberMat.opacity;
      out.fiberTransparent = r.fiberMat.transparent;
      out.hintWarnings = r.hintWarnings.slice();
      out.gelVisibleHinted = r.stats.gelVisible;
      out.strutsVisibleHinted = r.stats.strutsVisible;
      out.recipe = r.layoutParams();
      S.setTissue('fibrous');
      r.update(S.makeFakeState(12, 160, 20, {}, 'fibrous'));
      out.fibrousRecipe = r.layoutParams();
      out.fibrousFiberOpaque = r.fiberMat.transparent === false && r.fiberMat.opacity === 1;
      out.fibrousNoWarnings = r.hintWarnings.length === 0;
      return out;
    });
    {
      const h = fn.hints, f0 = h.fieldsDefault[0], g0 = h.fieldsHinted[0], g1 = h.fieldsHinted[1];
      if (Math.abs(g0.size - f0.size * 2.5) > 1e-9) problem('fields[].pointScale ignored: ' + JSON.stringify([f0, g0]));
      if (g1.style !== 'points' || g0.style !== f0.style) problem('fields[].style ignored: ' + JSON.stringify(h.fieldsHinted));
      if (Math.abs(h.gelOpacity - 0.28 * 0.5) > 1e-9) problem('species render.opacity ignored: ' + JSON.stringify(h));
      if (!(h.gelVisibleHinted < 1728) || !(h.strutsVisibleHinted < 5616)) problem('species render.minDensity ignored: ' + JSON.stringify(h));
      // a fiber species' `opacity` is honoured; its `style` and an unknown key are reported
      if (h.fiberTransparent !== true || Math.abs(h.fiberOpacity - 0.5) > 1e-9) problem('fiber render.opacity ignored: ' + JSON.stringify(h));
      const warned = (k) => h.hintWarnings.some((w) => w.includes(`render.${k}`));
      if (!warned('style') || !warned('wobble') || warned('opacity'))
        problem('hintWarnings must name exactly the ignored keys: ' + JSON.stringify(h.hintWarnings));
      if (!h.fibrousFiberOpaque || !h.fibrousNoWarnings) problem('a tissue with no render hints must be left alone: ' + JSON.stringify(h));
      if (h.fibrousRecipe.recipe !== 'fiber-v1' || h.fibrousRecipe.K !== 3 || h.fibrousRecipe.seed !== 90210
          || Math.abs(h.fibrousRecipe.fiber.radiusScale - 0.6) > 1e-9)
        problem('layoutParams() is not the src/recipe.js shape: ' + JSON.stringify(h.fibrousRecipe));
    }

    // --- §5: the field haze is instanced spheres by default, and `opt.fieldStyle=points`
    // still draws the v0.1 sprite cloud (the size of which the driver may clamp) ---------------
    await open('tissue=fibrous&t=25&fields=g,m');
    fn.fieldStyleDefault = await page.evaluate(() => window.__smoke.fieldState());
    await open('tissue=fibrous&t=25&fields=g,m&opt.fieldStyle=points');
    fn.fieldStylePoints = await page.evaluate(() => window.__smoke.fieldState());
    {
      const d = fn.fieldStyleDefault, p2 = fn.fieldStylePoints;
      if (!d.length || d.some((L) => L.style !== 'spheres' || !L.visible || L.instances !== 1728))
        problem('fields are not instanced spheres by default: ' + JSON.stringify(d));
      if (!p2.length || p2.some((L) => L.style !== 'points' || !L.visible))
        problem('opt.fieldStyle=points did not select the sprite cloud: ' + JSON.stringify(p2));
      // The sphere is `fieldSphereDiameter` × the sprite: the sprite's square quad paints its
      // corners too, so an equal-width disc lays down less haze — 1.1 is the measured match
      // (single field, cartilage IL-1: mean luminance 40.3 and lit fraction 0.265 either way).
      fn.fieldSphereDiameter = await page.evaluate(() => window.__smoke.renderer.opts.fieldSphereDiameter);
      const k = fn.fieldSphereDiameter;
      if (Math.abs(d[0].size - p2[0].size * k) > 1e-9) problem('the two field styles disagree on the blob size: ' + JSON.stringify([d[0], p2[0], k]));
    }

    // --- B4 (pixels): the wound outline must actually reach the screen, faded or not ----------
    // The marker's transform and opacity are checked above; this is the acceptance criterion
    // itself ("the outline shows"): render the frame with the `wound` layer off and on and count
    // the pixels that changed. The faded case (age 41 d, opacity 0.15) is the hard one, and the
    // depth-test-off ghost pass with its opacity floor is what carries it (review B, finding 7).
    await open('tissue=fibrous&t=6');
    fn.woundPixels = { fresh: await page.evaluate(() => window.__smoke.layerPixelImpact('wound')) };
    await open('tissue=fibrous&t=45');
    fn.woundPixels.faded = await page.evaluate(() => window.__smoke.layerPixelImpact('wound'));
    {
      const w = fn.woundPixels;
      if (!(w.fresh.changed[20] >= 1200)) problem('the fresh wound outline barely reaches the screen: ' + JSON.stringify(w.fresh));
      if (!(w.faded.changed[8] >= 600) || !(w.faded.maxDelta >= 20)) problem('the healed wound outline is below the visibility floor: ' + JSON.stringify(w.faded));
    }
    await open('tissue=fibrous&t=20');

    fn.dispose = await page.evaluate(() => {
      try {
        const r = window.__smoke.renderer;
        r.dispose(); r.render(); r.update(window.__smoke.state); r.resize(); r.resetView();
        const before = JSON.stringify(window.__smoke.cameraState());
        r.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        return JSON.stringify(window.__smoke.cameraState()) === before ? 'ok' : 'key listener still attached after dispose()';
      } catch (e) { return 'threw: ' + e.message; }
    });
    if (fn.dispose !== 'ok') problem('dispose(): ' + fn.dispose);
    summary.functional = fn;
    console.log('functional:', JSON.stringify(fn));
  }

  // --- 3. perf: N=12, K=3, n=160 — update() per layer set, both tissues ------------------
  if (!has('skip-perf')) {
    const perf = {};
    for (const tissue of ['fibrous', 'cartilage']) {
      await open(`tissue=${tissue}&t=30&N=12&n=160&K=3&play=0`);
      await page.evaluate(() => window.__smoke.resetStats());
      await page.waitForTimeout(perfSeconds * 1000);
      const frame = await page.evaluate(() => window.__smoke.stats());
      const sets = tissue === 'fibrous'
        ? { fibers: { cells: false }, fibers_cells: {}, all_fields: { fields: { g: true, m: true } } }
        : { fibers: { cells: false, gel: false, scaffold: false }, fibers_cells: { gel: false, scaffold: false }, gel_only: { fibers: false, cells: false, scaffold: false },
            scaffold_only: { fibers: false, cells: false, gel: false }, all: {}, all_fields: { fields: { tgf: true, o2: true, cat: true } } };
      const isolated = await page.evaluate((sets) => {
        const r = window.__smoke.renderer, s = window.__smoke.state, out = {};
        for (const [name, L] of Object.entries(sets)) {
          for (let i = 0; i < 20; i++) r.update(s, L);
          const t0 = performance.now(); const n = 200;
          for (let i = 0; i < n; i++) r.update(s, L);
          out[name] = +((performance.now() - t0) / n).toFixed(3);
        }
        r.update(s, {});
        return out;
      }, sets);
      perf[tissue] = { frame, updateMsIsolated: isolated };
      console.log(`perf ${tissue}:`, JSON.stringify(perf[tissue]));
      if (isolated.all !== undefined && isolated.all > 1.0) problem(`update() with all layers took ${isolated.all} ms (> 1 ms target) for ${tissue}`);
    }
    summary.perf = { ...perf, seconds: perfSeconds, viewport: `${width}x${height}` };
  }

  summary.consoleErrors = consoleErrors;
  if (consoleErrors.some((l) => l.startsWith('[pageerror]') || /Failed to load|TypeError|ReferenceError|THREE\.WebGLProgram: Shader Error/.test(l))) problem('page reported errors: ' + consoleErrors.slice(0, 3).join(' | '));
  summary.ok = summary.problems.filter((p) => !p.startsWith('jsdelivr not reachable')).length === 0;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  // Proxy: by default rely on Chromium's own pickup of HTTPS_PROXY/no_proxy from the environment.
  // `--proxy` passes an explicit one as Chromium's own `--proxy-server` flag, which (unlike
  // playwright's `proxy` option) leaves loopback direct, so the local file server this harness
  // runs is still reachable — playwright's option adds `<-loopback>` to the bypass list and sends
  // 127.0.0.1 through the proxy too, which answers plain HTTP with 405.
  const proxyServer = opt('proxy', null);
  // cache: false — the CDN route is installed inside, and only when the direct probe failed.
  await withHarness({
    root: extUrl ? null : repoRoot, port, cache: false, page: false,
    width, height, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
    args: proxyServer ? [`--proxy-server=${proxyServer}`] : [],
  }, runSmoke);
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nSUMMARY', JSON.stringify({ ok: summary.ok, cdn: summary.cdn, perf: summary.perf, problems: summary.problems }, null, 1));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
