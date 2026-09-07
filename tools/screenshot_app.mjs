// Loads the app over a local HTTP server in headless Chromium, runs a scenario
// for a while, and saves screenshots. Usage:
//   node tools/screenshot_app.mjs [outDir] [scenario] [days]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(root, 'dist', 'shots');
const scenario = process.argv[3] || 'maturation';
const days = parseFloat(process.argv[4] || '40');
mkdirSync(outDir, { recursive: true });
const port = 8765 + Math.floor(Math.random() * 100);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.tissueApp && window.tissueApp.model, null, { timeout: 30000 });
await page.evaluate((s) => window.tissueApp.loadScenario(s), scenario);
await page.waitForTimeout(800);
await page.evaluate(() => window.tissueApp.setPlaying(false));
await page.screenshot({ path: join(outDir, `${scenario}-day0.png`) });
const t0 = Date.now();
await page.evaluate((d) => { window.tissueApp.advance(d); window.tissueApp.syncReadouts(true); }, days);
const ms = Date.now() - t0;
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, `${scenario}-day${days}.png`) });
const stats = await page.evaluate(() => window.tissueApp.model.stats());
console.log(JSON.stringify({ scenario, days, advanceMs: ms, stats }, null, 1));
console.log(errors.length ? `console issues:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
server.kill();
