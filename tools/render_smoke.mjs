#!/usr/bin/env node
// Playwright screenshot / performance harness for src/render.js.
//
//   node tools/render_smoke.mjs --out /path/to/outdir [--port 8123] [--url http://host:port]
//        [--perf-seconds 5] [--width 1280] [--height 800] [--force-cache] [--no-cache] [--scenes a,b]
//        [--proxy http://host:port]  (explicit proxy; default = Chromium's env pickup)
//
// Serves the repo root over http (ES modules do not load from file://), opens
// tools/render_smoke.html in headless Chromium with SwiftShader WebGL, takes
// screenshots of several fake-state moments, verifies the frame is not blank,
// checks that three.js loads from jsdelivr (through any HTTPS_PROXY), and
// measures fps plus TissueRenderer.update() CPU time. Exit code 1 on failure.
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
  if (useCache) {
    // Prove the CDN is reachable through the proxy at all (curl), then serve cached copies.
    try {
      const { stdout } = await execFileP('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '--max-time', '60', CDN_PROBE]);
      const [code, bytes] = stdout.trim().split(' ');
      summary.cdn.curl = { ok: code === '200', status: +code, bytes: +bytes };
    } catch (e) { summary.cdn.curl = { ok: false, error: e.message.split('\n')[0] }; }
    console.log('CDN via curl through proxy:', JSON.stringify(summary.cdn.curl));
    summary.cdn.mode = 'route-intercept-cache';
    await context.route(CDN_ORIGIN + '/**', async (route) => {
      const url = route.request().url();
      try {
        const body = await cdnCached(url);
        await route.fulfill({ status: 200, body, headers: { 'content-type': MIME[extname(new URL(url).pathname)] || 'text/javascript', 'access-control-allow-origin': '*' } });
      } catch (e) { problem(`cache fetch failed for ${url}: ${e.message.split('\n')[0]}`); await route.abort(); }
    });
  } else summary.cdn.mode = 'direct';

  // --- 2. scenes --------------------------------------------------------------------
  const scenes = [
    { name: '01_sparse_isotropic', params: 't=0&strain=0.15' },
    { name: '02_mid_wounded', params: 't=12' },
    { name: '03_dense_aligned_mature', params: 't=60' },
    { name: '04_fields_g_m', params: 't=25&g=1&m=1' },
    { name: '04b_field_g_only', params: 't=25&g=1' },
    { name: '05_cells_only', params: 't=40&fibers=0' },
  ].filter((s) => !sceneFilter || sceneFilter.split(',').includes(s.name));

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { const line = `[${m.type()}] ${m.text()}`; if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(line); console.log('  console', line.slice(0, 300)); });
  page.on('pageerror', (e) => { consoleErrors.push('[pageerror] ' + e.message); console.log('  pageerror', e.message); });
  page.on('requestfailed', (r) => { const line = `[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}`; consoleErrors.push(line); console.log(' ', line); });

  const open = async (params) => {
    const url = `${baseUrl}/tools/render_smoke.html?${params}&hud=0&auto=0`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    try {
      await page.waitForFunction(() => window.__smoke !== undefined, null, { timeout: 45000 });
    } catch (e) {
      const dump = await page.evaluate(() => ({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 300) })).catch(() => null);
      throw new Error(`smoke page did not initialise at ${url}: ${e.message.split('\n')[0]} page=${JSON.stringify(dump)}`);
    }
    await page.evaluate(() => window.__smoke.ready);
    await page.evaluate(() => window.__smoke.waitFrames(3));
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
    summary.scenes.push({ ...sc, url, file, pixels: px, fibersVisible: st.fibersVisible, cells: st.cells, ms: Date.now() - t0 });
    console.log(`scene ${sc.name}: ${file}  pixels=${JSON.stringify(px)} fibers=${st.fibersVisible} cells=${st.cells}`);
  }

  // renderer.screenshot() data URL round-trip on the last scene
  const shot = await page.evaluate(() => window.__smoke.renderer.screenshot());
  if (!/^data:image\/png;base64,/.test(shot) || shot.length < 5000) problem('renderer.screenshot() did not return a plausible PNG data URL');
  else {
    const file = join(outDir, 'renderer_screenshot_dataurl.png');
    await writeFile(file, Buffer.from(shot.split(',')[1], 'base64'));
    summary.screenshotDataUrl = { bytes: shot.length, file };
  }

  // --- 2b. functional checks -------------------------------------------------------------
  const fn = {};
  await open('t=20&auto=1');
  fn.autoRotateBefore = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
  await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.mouse.up();
  fn.autoRotateAfterPointerDown = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
  await page.evaluate(() => window.__smoke.renderer.setAutoRotate(true));
  fn.setAutoRotateTrue = await page.evaluate(() => window.__smoke.renderer.controls.autoRotate);
  if (!(fn.autoRotateBefore === true && fn.autoRotateAfterPointerDown === false && fn.setAutoRotateTrue === true))
    problem('autoRotate did not stop on pointerdown / setAutoRotate failed: ' + JSON.stringify(fn));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => window.__smoke.waitFrames(2));
  fn.canvasAfterResize = await page.evaluate(() => ({ w: window.__smoke.renderer.canvas.width, h: window.__smoke.renderer.canvas.height }));
  if (fn.canvasAfterResize.w !== 900 || fn.canvasAfterResize.h !== 600) problem('resize did not follow the parent: ' + JSON.stringify(fn.canvasAfterResize));
  await page.setViewportSize({ width, height });
  fn.rebuild = await page.evaluate(() => {
    const r = window.__smoke.renderer, mk = window.__smoke.makeFakeState, out = {};
    r.update(mk(8, 50, 20)); r.render(); out.countN8 = r.fibers.count; out.cellsN8 = r.stats.cells;
    r.update(mk(12, 700, 20)); r.render(); out.countN12 = r.fibers.count; out.cells700 = r.stats.cells; out.capacity = r.cells.capacity;
    r.update(mk(12, 160, 20), { fibers: false, cells: true, g: true, m: true }); r.render();
    out.fibersHidden = !r.fibers.mesh.visible; out.gVisible = r.fields.g.points.visible; out.mVisible = r.fields.m.points.visible;
    r.update(mk(12, 160, 20)); r.render(); out.gHiddenAgain = !r.fields.g.points.visible;
    return out;
  });
  if (fn.rebuild.countN8 !== 8 * 8 * 8 * 3 || fn.rebuild.countN12 !== 12 * 12 * 12 * 3 || fn.rebuild.cells700 !== 700 || fn.rebuild.capacity < 700
      || !fn.rebuild.fibersHidden || !fn.rebuild.gVisible || !fn.rebuild.mVisible || !fn.rebuild.gHiddenAgain)
    problem('rebuild / capacity growth / layer toggles failed: ' + JSON.stringify(fn.rebuild));
  fn.dispose = await page.evaluate(() => { try { const r = window.__smoke.renderer; r.dispose(); r.render(); r.update(window.__smoke.state); return 'ok'; } catch (e) { return 'threw: ' + e.message; } });
  if (fn.dispose !== 'ok') problem('dispose(): ' + fn.dispose);
  summary.functional = fn;
  console.log('functional:', JSON.stringify(fn));

  // --- 3. perf: N=12, K=3, n=160 ----------------------------------------------------------
  await open('t=30&N=12&n=160&K=3&play=0');
  await page.evaluate(() => window.__smoke.resetStats());
  await page.waitForTimeout(perfSeconds * 1000);
  const perf = await page.evaluate(() => window.__smoke.stats());
  // update() alone, many iterations, independent of the frame rate
  const updOnly = await page.evaluate(() => {
    const r = window.__smoke.renderer, s = window.__smoke.state;
    const L = { fibers: true, cells: true, g: false, m: false };
    for (let i = 0; i < 20; i++) r.update(s, L);
    const t0 = performance.now(); const n = 200;
    for (let i = 0; i < n; i++) r.update(s, L);
    return +((performance.now() - t0) / n).toFixed(3);
  });
  summary.perf = { ...perf, updateMsIsolated: updOnly, seconds: perfSeconds, viewport: `${width}x${height}` };
  console.log('perf:', JSON.stringify(summary.perf));

  summary.consoleErrors = consoleErrors;
  if (consoleErrors.some((l) => l.startsWith('[pageerror]') || /Failed to load|TypeError|ReferenceError/.test(l))) problem('page reported errors: ' + consoleErrors.slice(0, 3).join(' | '));
  summary.ok = summary.problems.filter((p) => !p.startsWith('jsdelivr not reachable')).length === 0;

  await browser.close();
  if (server) server.srv.close();
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nSUMMARY', JSON.stringify({ ok: summary.ok, cdn: summary.cdn, perf: summary.perf, problems: summary.problems }, null, 1));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
