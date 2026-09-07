// Loads the app over a local HTTP server in headless Chromium, runs a scenario
// for a while, and saves screenshots. Usage:
//   node tools/screenshot_app.mjs [outDir] [scenario] [days]
// Headless Chromium in some sandboxes cannot complete TLS to the CDNs even when
// curl can, so CDN and font requests are served from a curl-fetched cache.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// playwright: bare import, else the global install (npm root -g)
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const { stdout } = await execFileP('npm', ['root', '-g']);
  return import(join(stdout.trim(), 'playwright', 'index.mjs'));
}
const { chromium } = await loadPlaywright();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(root, 'dist', 'shots');
const scenario = process.argv[3] || 'maturation';
const days = parseFloat(process.argv[4] || '40');
const cacheDir = join(root, 'dist', 'cdn-cache');
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

async function cached(url) {
  const u = new URL(url);
  const file = join(cacheDir, u.hostname, u.pathname.replace(/[^A-Za-z0-9._@/-]/g, '_') + (u.search ? '_' + Buffer.from(u.search).toString('hex').slice(0, 40) : ''));
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    // Chrome UA so Google Fonts returns woff2 CSS
    await execFileP('curl', ['-sS', '-L', '--max-time', '60', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', '-o', file, url]);
  }
  return readFileSync(file);
}

const port = 8765 + Math.floor(Math.random() * 100);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const origin of ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
  await context.route(origin + '/**', async (route) => {
    const url = route.request().url();
    try {
      const body = await cached(url);
      const ext = extname(new URL(url).pathname);
      const type = url.startsWith('https://fonts.googleapis.com') ? 'text/css' : (MIME[ext] || 'text/javascript');
      await route.fulfill({ status: 200, body, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    } catch (e) { console.error('cache miss', url, e.message); await route.abort(); }
  });
}
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const pagePath = process.env.PAGE || 'index.html'; // e.g. PAGE=dist/tissue-weather.html
await page.goto(`http://127.0.0.1:${port}/${pagePath}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.tissueApp && window.tissueApp.model, null, { timeout: 30000 });
await page.evaluate((s) => window.tissueApp.loadScenario(s), scenario);
await page.waitForTimeout(1500);
await page.evaluate(() => window.tissueApp.setPlaying(false));
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, `${scenario}-day0.png`) });
if (process.env.INJURE) await page.evaluate(() => window.tissueApp.model.injure());
const t0 = Date.now();
await page.evaluate((d) => { window.tissueApp.advance(d); window.tissueApp.syncReadouts(true); }, days);
const ms = Date.now() - t0;
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, `${scenario}-day${days}.png`) });
const stats = await page.evaluate(() => window.tissueApp.model.stats());
console.log(JSON.stringify({ scenario, days, advanceMs: ms, stats }, null, 1));
console.log(errors.length ? `console issues:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
server.kill();
