// tools/lib/browser.mjs — the browser-harness plumbing shared by tools/screenshot_app.mjs and
// tools/render_smoke.mjs (docs/REVIEW.md D9). No dependencies, no state at import time.
//
//   loadPlaywright()                      the playwright module: bare import, else the global install
//   serveDir(root, opts)  → server        a static file server over the repository (ES modules do not
//                                         load from file://); `server.close()` is idempotent
//   launchChromium(pw, opts) → { browser, context }   SwiftShader WebGL, one viewport
//   routeCdnCache(context, opts)          serve https://cdn.jsdelivr.net + Google Fonts from a curl
//                                         cache in os.tmpdir(), so a closed or slow network cannot
//                                         make a run flaky (and a failed download is never cached)
//   withHarness(opts, fn)                 serve + launch + route, and ALWAYS close both again
//   fetchCached(url, opts)                one cached download (curl --fail, temp file + rename)
//   cdnCacheDir()                         the default cache directory
//
// Why each piece exists (the bugs it removes):
//   * `python3 -m http.server` + `await sleep(700)` is a race and an extra dependency — serveDir
//     resolves only once the socket is listening, and picks a free port when asked for port 0;
//   * curl without `--fail` writes the CDN's 404 page into the cache and every later run "loads"
//     that HTML as JavaScript — fetchCached uses --fail AND downloads to `<file>.part`, renaming
//     only on success, so an interrupted run cannot poison the cache either;
//   * a harness that throws between `spawn()` and `kill()` leaks a server and a browser — every
//     entry point here is wrapped in try/finally, and withHarness() does it for the whole run.
import { createServer } from 'node:http';
import { readFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);

export const BROWSER_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.md': 'text/plain; charset=utf-8',
};

/** Chrome-like UA: Google Fonts serves woff2 CSS only to browsers it recognises. */
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** The origins both harnesses have to answer for when the network is closed. */
export const CDN_ORIGINS = ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

/** Where downloads are kept between runs. os.tmpdir(), so a harness never writes into the repo. */
export function cdnCacheDir(name = 'tissue-weather-cdn-cache') { return join(tmpdir(), name); }

/** The playwright module: the bare import first, then the global install (`npm root -g`). */
export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a local dependency; try the global one */ }
  let globalRoot = '';
  try { globalRoot = (await execFileP('npm', ['root', '-g'])).stdout.trim(); } catch { /* no npm on PATH */ }
  for (const c of ['playwright', 'playwright-core']) {
    const p = globalRoot && join(globalRoot, c, 'index.mjs');
    if (p && existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error('playwright not found: `npm i -g playwright && npx playwright install chromium`, or `npm i --no-save playwright`');
}

/**
 * Static file server for `root`. Returns { url, port, close() }; close() resolves when the socket
 * is gone and may be called twice (the finally block and the happy path both call it).
 */
export async function serveDir(root, { port = 0, host = '127.0.0.1', index = 'index.html' } = {}) {
  const base = resolve(root);
  const srv = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = join(base, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
      if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403); return res.end('forbidden'); }
      let st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = join(file, index); st = await stat(file).catch(() => null); }
      if (!st) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': BROWSER_MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(port, host, ok); });
  let closed = false;
  return {
    srv, root: base, port: srv.address().port, url: `http://${host}:${srv.address().port}`,
    close: () => closed ? Promise.resolve() : (closed = true, new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); })),
  };
}

/**
 * Headless Chromium with software WebGL (SwiftShader), plus one context at `width`×`height`.
 * `pw` is the module from loadPlaywright(); omit it and it is loaded here.
 */
export async function launchChromium(pw = null, { width = 1280, height = 800, deviceScaleFactor = 1, args = [], reducedMotion, ...contextOpts } = {}) {
  const { chromium } = pw || await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...args] });
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, ...(reducedMotion ? { reducedMotion } : {}), ...contextOpts });
    return { browser, context };
  } catch (e) { await browser.close(); throw e; }
}

/**
 * One cached download. Returns the Buffer; the cache file is written only on success, through a
 * `.part` temp file, so a killed run leaves no half file behind.
 */
export async function fetchCached(url, { cacheDir = cdnCacheDir(), ua = BROWSER_UA, maxSeconds = 60, force = false } = {}) {
  const u = new URL(url);
  const key = u.pathname.replace(/[^A-Za-z0-9._@/-]/g, '_') + (u.search ? `_${Buffer.from(u.search).toString('hex').slice(0, 40)}` : '');
  const file = join(cacheDir, u.host, key.replace(/^\//, ''));   // host, not hostname: keep a port apart
  if (force || !existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    const part = `${file}.part`;
    try {
      await execFileP('curl', ['-sS', '-L', '--fail', '--max-time', String(maxSeconds), '-A', ua, '-o', part, url]);
      await rename(part, file);                       // only a complete, non-error response is cached
    } catch (e) {
      await unlink(part).catch(() => {});
      throw new Error(`download failed: ${url}\n  ${(e.stderr || e.message || '').toString().trim()}`);
    }
  }
  return readFile(file);
}

/**
 * Answer the CDN origins from the cache instead of the network. Returns { hits, misses }, which a
 * caller can report: a miss means the asset was neither cached nor reachable, and the page will
 * have loaded without it.
 */
export async function routeCdnCache(context, { origins = CDN_ORIGINS, cacheDir = cdnCacheDir(), ua = BROWSER_UA, maxSeconds = 60, onMiss = null } = {}) {
  const stats = { hits: [], misses: [] };
  for (const origin of origins) {
    await context.route(`${origin}/**`, async (route) => {
      const url = route.request().url();
      try {
        const body = await fetchCached(url, { cacheDir, ua, maxSeconds });
        const ext = extname(new URL(url).pathname);
        const type = url.startsWith('https://fonts.googleapis.com') ? 'text/css' : (BROWSER_MIME[ext] || 'text/javascript');
        stats.hits.push(url);
        await route.fulfill({ status: 200, body, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
      } catch (e) {
        stats.misses.push({ url, error: e.message });
        if (onMiss) onMiss(url, e); else console.error(`cdn cache miss: ${url}\n  ${e.message}`);
        await route.abort();
      }
    });
  }
  return stats;
}

/**
 * serve + launch + route, run `fn({ server, browser, context, page })`, and close everything again
 * whether it threw or not. This is the one place that owns the try/finally, so no harness can leak
 * a server or a browser process on an early failure.
 */
export async function withHarness({ root, port = 0, cache = true, cacheDir = cdnCacheDir(), origins = CDN_ORIGINS, page: wantPage = true, ...launchOpts } = {}, fn) {
  let server = null, browser = null;
  try {
    if (root) server = await serveDir(root, { port });
    const launched = await launchChromium(null, launchOpts);
    browser = launched.browser;
    const context = launched.context;
    if (cache) await routeCdnCache(context, { cacheDir, origins });
    const page = wantPage ? await context.newPage() : null;
    return await fn({ server, browser, context, page, url: server ? server.url : null });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}
