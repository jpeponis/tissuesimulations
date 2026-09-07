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
// screenshots of both fake tissues at three moments each (plus field / gel-style
// variants), verifies frames are not blank, checks that three.js loads from
// jsdelivr (through any HTTPS_PROXY, with a local cache fallback), exercises the
// §4 API (setTissue, layers, legendSwatches, rebuild, dispose, framing at aspect
// 0.6 and 2.4, prefers-reduced-motion) and measures update() CPU time per layer
// set. Exit code 1 on failure.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, extname, resolve, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

// ----------------------------------------------------------------------------
// tiny static server for the repo root
function startServer(root, port) {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
        let file = join(root, rel);
        if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
        let st = await stat(file).catch(() => null);
        if (st && st.isDirectory()) { file = join(file, 'index.html'); st = await stat(file).catch(() => null); }
        if (!st) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(await readFile(file));
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    srv.on('error', rejectP);
    srv.listen(port, '127.0.0.1', () => resolveP({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ----------------------------------------------------------------------------
// playwright: bare import, else the global install (npm root -g)
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const { stdout } = await execFileP('npm', ['root', '-g']);
  const root = stdout.trim();
  const candidates = [join(root, 'playwright', 'index.mjs'), join(root, 'playwright-core', 'index.mjs')];
  for (const c of candidates) if (existsSync(c)) return import(pathToFileURL(c).href);
  throw new Error('playwright not found: run `npm i playwright@1` or `npm i -g playwright`');
}

// CDN fallback cache: fetch with curl (honours HTTPS_PROXY + CA bundle) once, then serve locally.
async function cdnCached(url) {
  const u = new URL(url);
  const file = join(cacheDir, u.hostname, u.pathname.replace(/[^A-Za-z0-9._@/-]/g, '_'));
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await execFileP('curl', ['-sSL', '--fail', '--max-time', '90', '-o', file, url]);
  }
  return readFile(file);
}

// ----------------------------------------------------------------------------
async function main() {
  await mkdir(outDir, { recursive: true });
  const summary = { ok: true, startedAt: new Date().toISOString(), outDir, cdn: {}, gl: null, scenes: [], perf: null, problems: [] };
  const problem = (m) => { summary.problems.push(m); console.log('PROBLEM:', m); };

  let server = null, baseUrl = extUrl;
  if (!baseUrl) { server = await startServer(repoRoot, port); baseUrl = server.url; }
  console.log('serving', repoRoot, 'at', baseUrl);

  const { chromium } = await loadPlaywright();
  // Proxy: by default rely on Chromium's own pickup of HTTPS_PROXY/no_proxy from the
  // environment. Playwright's `proxy` option would add `<-loopback>` to the bypass list and
  // force 127.0.0.1 through the proxy too (which answers plain HTTP with 405). `--proxy`
  // opts in to the explicit option with that forcing disabled.
  const proxyServer = opt('proxy', null);
  const launchOpts = {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  };
  if (proxyServer) {
    process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
    launchOpts.proxy = { server: proxyServer, bypass: 'localhost,127.0.0.1' };
  }
  const browser = await chromium.launch(launchOpts);
  console.log('chromium', browser.version(), proxyServer ? `via --proxy ${proxyServer}` : `env proxy: ${process.env.HTTPS_PROXY || 'none'}`);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });

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
  const installCache = async (ctx) => {
    await ctx.route(CDN_ORIGIN + '/**', async (route) => {
      const url = route.request().url();
      try {
        const body = await cdnCached(url);
        await route.fulfill({ status: 200, body, headers: { 'content-type': MIME[extname(new URL(url).pathname)] || 'text/javascript', 'access-control-allow-origin': '*' } });
      } catch (e) { problem(`cache fetch failed for ${url}: ${e.message.split('\n')[0]}`); await route.abort(); }
    });
  };
  if (useCache) {
    // Prove the CDN is reachable through the proxy at all (curl), then serve cached copies.
    try {
      const { stdout } = await execFileP('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '--max-time', '60', CDN_PROBE]);
      const [code, bytes] = stdout.trim().split(' ');
      summary.cdn.curl = { ok: code === '200', status: +code, bytes: +bytes };
    } catch (e) { summary.cdn.curl = { ok: false, error: e.message.split('\n')[0] }; }
    console.log('CDN via curl through proxy:', JSON.stringify(summary.cdn.curl));
    summary.cdn.mode = 'route-intercept-cache';
    await installCache(context);
  } else summary.cdn.mode = 'direct';

  // --- 2. scenes --------------------------------------------------------------------
  let scenes = [
    // fibrous connective tissue: three times
    { name: 'fibrous_01_t0_sparse', params: 'tissue=fibrous&t=0&strain=0.15' },
    { name: 'fibrous_02_t12_wounded', params: 'tissue=fibrous&t=12' },
    { name: 'fibrous_03_t60_dense_aligned', params: 'tissue=fibrous&t=60' },
    { name: 'fibrous_04_t25_fields_g_m', params: 'tissue=fibrous&t=25&fields=g,m' },
    { name: 'fibrous_05_t40_cells_only', params: 'tissue=fibrous&t=40&fibers=0' },
    // cartilage in a dissolving hydrogel: three times
    { name: 'cartilage_01_t0_scaffold', params: 'tissue=cartilage&t=0' },
    { name: 'cartilage_02_t20_dissolving', params: 'tissue=cartilage&t=20' },
    { name: 'cartilage_03_t60_gel_network', params: 'tissue=cartilage&t=60' },
    { name: 'cartilage_04_t30_fields', params: 'tissue=cartilage&t=30&fields=tgf,o2,cat&gel=0&scaffold=0' },
    { name: 'cartilage_05_t20_gel_points', params: 'tissue=cartilage&t=20&opt.gelStyle=points' },
    { name: 'cartilage_06_t20_scaffold_only', params: 'tissue=cartilage&t=20&gel=0&fibers=0&cells=0' },
    { name: 'cartilage_07_t45_radius_by_state', params: 'tissue=cartilage&t=45&gel=0&scaffold=0&fibers=0&radiusByState=1' },
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
      out.fibersHidden = !r.fibers.mesh.visible; out.gVisible = r.fields[0].points.visible; out.mVisible = r.fields[1].points.visible;
      r.update(mk(12, 160, 20, {}, 'fibrous')); r.render(); out.gHiddenAgain = !r.fields[0].points.visible;
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

    fn.dispose = await page.evaluate(() => { try { const r = window.__smoke.renderer; r.dispose(); r.render(); r.update(window.__smoke.state); r.resize(); return 'ok'; } catch (e) { return 'threw: ' + e.message; } });
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

  await browser.close();
  if (server) server.srv.close();
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nSUMMARY', JSON.stringify({ ok: summary.ok, cdn: summary.cdn, perf: summary.perf, problems: summary.problems }, null, 1));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
