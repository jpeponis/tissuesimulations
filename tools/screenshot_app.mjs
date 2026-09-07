// Loads the app over a local HTTP server in headless Chromium, runs a scripted
// interaction sequence (load via deep link, play 1 s, move a dial with the
// keyboard, reset → ghost traces, injure when the tissue supports it, table
// toggle, keyboard shortcuts), probes basic accessibility (accessible names,
// heading order, live region, canvas description), measures the stats/plot
// cadence, saves screenshots and reports console errors.
//
// Usage:
//   node tools/screenshot_app.mjs [--tissue fibrous] [--scenario maturation] [--days 40]
//        [--out dist/shots] [--page index.html] [--root <dir>] [--no-interact] [--width 1440] [--height 900]
//        [--panel-top] [--events]
//   legacy positional form: node tools/screenshot_app.mjs [outDir] [scenario] [days]
// --panel-top  also saves the same frame with the console scrolled to the top (tissue picker,
//              scenario card and the scripted-events toggle visible).
// --events     exercises the "Auto-apply scripted events" toggle: checks it is off by default and
//              changes nothing, then turns it on, replays past the first scripted day and checks
//              the engine, the dial UI and the live region, and saves a screenshot.
// Environment: PAGE=dist/tissue-weather.html (same as --page), INJURE=1 (force injure before the long run).
// Headless Chromium in some sandboxes cannot complete TLS to the CDNs even when
// curl can, so CDN and font requests are served from a curl-fetched cache.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ---- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {}; const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[k] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else positional.push(a);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serveRoot = flags.root ? resolve(flags.root) : root;
const outDir = resolve(flags.out || positional[0] || join(root, 'dist', 'shots'));
const tissue = flags.tissue || null;
const scenario = flags.scenario || positional[1] || null;
const days = parseFloat(flags.days || positional[2] || '40');
const interact = !flags['no-interact'];
const panelTop = !!flags['panel-top'];
const testEvents = !!flags.events;
const width = parseInt(flags.width || '1440', 10), height = parseInt(flags.height || '900', 10);
const pagePath = flags.page || process.env.PAGE || 'index.html';
const cacheDir = join(root, 'dist', 'cdn-cache');
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

// playwright: bare import, else the global install (npm root -g)
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const { stdout } = await execFileP('npm', ['root', '-g']);
  const g = stdout.trim();
  for (const c of [join(g, 'playwright', 'index.mjs'), join(g, 'playwright-core', 'index.mjs')]) if (existsSync(c)) return import(pathToFileURL(c).href);
  throw new Error('playwright not found: npm i -g playwright (and npx playwright install chromium)');
}

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

const { chromium } = await loadPlaywright();
const port = 8765 + Math.floor(Math.random() * 100);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: serveRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
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
const issues = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') issues.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };
const waitReady = () => page.waitForFunction(() => window.tissueApp && window.tissueApp.ready && document.getElementById('busy').hidden, null, { timeout: 60000 });

const q = new URLSearchParams();
if (tissue) q.set('tissue', tissue);
if (scenario) q.set('scenario', scenario);
const url = `http://127.0.0.1:${port}/${pagePath}${q.toString() ? `?${q}` : ''}`;
await page.goto(url, { waitUntil: 'networkidle' });
await waitReady();
const loaded = await page.evaluate(() => ({ tissue: window.tissueApp.tissueKey, scenario: window.tissueApp.scenarioKey, renderer: window.tissueApp.rendererState, tissues: Object.keys(window.tissueApp.tissues), scenarios: window.tissueApp.tissue.scenarios.map((s) => s.key), injury: !!window.tissueApp.tissue.injury }));
if (tissue) check(loaded.tissue === tissue, `deep link tissue: wanted ${tissue}, got ${loaded.tissue}`);
if (scenario) check(loaded.scenario === scenario, `deep link scenario: wanted ${scenario}, got ${loaded.scenario}`);
// the renderer loads asynchronously; give it a moment
await page.waitForFunction(() => window.tissueApp.rendererState !== 'loading', null, { timeout: 30000 }).catch(() => {});
loaded.renderer = await page.evaluate(() => window.tissueApp.rendererState);
const tag = `${loaded.tissue}-${loaded.scenario}`;
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, `${tag}-day0.png`) });

const report = { url, loaded, interaction: {}, a11y: {}, perf: {} };

if (interact) {
  const it = report.interaction;
  // 1. play for one real second via the button, then pause
  await page.click('#btn-play');
  await page.waitForTimeout(1000);
  await page.click('#btn-play');
  it.dayAfterPlay1s = await page.evaluate(() => window.tissueApp.engine.state.time);
  it.fpsWhilePlaying = await page.evaluate(() => document.getElementById('fps').textContent);
  check(it.dayAfterPlay1s > 0, `play 1 s did not advance the clock (day ${it.dayAfterPlay1s})`);
  // software GL can run at a few fps; make sure the run is long enough to leave a ghost trace
  if (it.dayAfterPlay1s < 1) await page.evaluate(() => window.tissueApp.advance(1));
  it.hintHiddenAfterPlay = await page.evaluate(() => document.getElementById('hint').hidden);
  check(it.hintHiddenAfterPlay, 'first-run hint still visible after Play');
  // 2. move the first dial with the keyboard (real input events)
  const dialKey = await page.evaluate(() => window.tissueApp.tissue.dials[0].key);
  const dial = page.locator(`#dial-${dialKey}`);
  const before = await dial.evaluate((el) => el.value);
  await dial.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700); // URL debounce
  it.dial = { key: dialKey, before, after: await dial.evaluate((el) => el.value), valuetext: await dial.getAttribute('aria-valuetext'), engine: await page.evaluate((k) => window.tissueApp.engine.state.dials[k], dialKey), url: await page.evaluate(() => location.search) };
  check(it.dial.after !== before, 'arrow keys did not move the dial');
  check(Math.abs(parseFloat(it.dial.after) - it.dial.engine) < 1e-6, `dial ${dialKey}: UI ${it.dial.after} vs engine ${it.dial.engine}`);
  check(it.dial.url.includes(`${dialKey}=`) && it.dial.url.includes('tissue=') && it.dial.url.includes('scenario='), `URL not updated: ${it.dial.url}`);
  // 3. reset → previous run kept as dashed reference
  await page.click('#btn-reset');
  await page.waitForFunction(() => !window.tissueApp.ready, null, { timeout: 5000 }).catch(() => {});
  await waitReady();
  it.reset = await page.evaluate(() => ({ day: window.tissueApp.engine.state.time, ghosts: window.tissueApp.plots.filter((p) => p.plot.hasReference()).length, clearVisible: !document.getElementById('btn-clear-ref').hidden, flash: document.getElementById('equilibrium').textContent }));
  check(it.reset.day < 0.1, `reset did not return to day 0 (${it.reset.day})`);
  check(it.reset.ghosts > 0 && it.reset.clearVisible, 'no ghost traces after reset');
  check(/Reset/.test(it.reset.flash), `no reset confirmation in the live region: "${it.reset.flash}"`);
  // 4. injure when available
  it.injureVisible = await page.evaluate(() => !document.getElementById('btn-injure').hidden);
  check(it.injureVisible === loaded.injury, `Injure button visibility ${it.injureVisible} but tissue.injury is ${loaded.injury}`);
  if (it.injureVisible) {
    await page.click('#btn-injure');
    await page.waitForTimeout(100);
    it.injureFlash = await page.evaluate(() => document.getElementById('equilibrium').textContent);
    it.wound = await page.evaluate(() => !!window.tissueApp.engine.state.wound);
    check(it.wound, 'injure did not create a wound');
  }
  // 5. table toggle
  await page.click('#btn-table');
  it.tableRows = await page.evaluate(() => document.querySelectorAll('#stats-table tbody tr').length);
  check(it.tableRows > 0, 'values table has no rows');
  it.tableSample = await page.evaluate(() => Array.from(document.querySelectorAll('#stats-table tbody tr')).slice(0, 3).map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
  await page.click('#btn-table');
  // 6. keyboard shortcuts: Space toggles play; digit picks a scenario; R resets
  await page.evaluate(() => document.getElementById('view').focus());
  await page.keyboard.press('Space');
  it.spacePlays = await page.evaluate(() => window.tissueApp.playing);
  await page.keyboard.press('Space');
  it.spacePauses = !(await page.evaluate(() => window.tissueApp.playing));
  check(it.spacePlays && it.spacePauses, 'Space did not toggle play/pause');
  if (loaded.scenarios.length > 1) {
    await page.keyboard.press('2');
    await waitReady();
    it.digitScenario = await page.evaluate(() => window.tissueApp.scenarioKey);
    check(it.digitScenario === loaded.scenarios[1], `key "2" selected ${it.digitScenario}, expected ${loaded.scenarios[1]}`);
    await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
    await waitReady();
  }
  // 7. copy link (clipboard is unavailable headless; the fallback must still surface the URL)
  await page.click('#btn-copy-link');
  await page.waitForTimeout(200);
  it.copyLink = await page.evaluate(() => ({ flash: document.getElementById('equilibrium').textContent, linkShown: !document.getElementById('link-out').hidden, value: document.getElementById('link-out').value }));
  check(/[Ll]ink/.test(it.copyLink.flash), `copy link did not confirm: "${it.copyLink.flash}"`);

  // ---- accessibility probe ------------------------------------------------------
  report.a11y = await page.evaluate(() => {
    const name = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent.trim()).join(' ');
      if (el.tagName === 'INPUT' && el.type === 'radio') return el.value;
      return (el.textContent || '').trim() || el.getAttribute('title') || '';
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return !el.hidden && !el.closest('[hidden]') && r.width > 0 && r.height > 0; };
    const controls = Array.from(document.querySelectorAll('button, input, select, textarea, a[href], canvas, summary')).filter(visible);
    const unnamed = controls.filter((el) => !name(el)).map((el) => `${el.tagName.toLowerCase()}#${el.id || ''}.${el.className || ''}`);
    const small = controls.filter((el) => !['canvas', 'a'].includes(el.tagName.toLowerCase())).map((el) => { const r = el.getBoundingClientRect(); return { el: `${el.tagName.toLowerCase()}#${el.id}`, w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 24 || x.h < 24);
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible).map((h) => ({ level: +h.tagName[1], text: h.textContent.trim().slice(0, 40) }));
    let skips = 0; for (let i = 1; i < heads.length; i++) if (heads[i].level > heads[i - 1].level + 1) skips++;
    const sliders = Array.from(document.querySelectorAll('input[type=range]')).filter(visible).map((s) => ({ id: s.id, valuetext: s.getAttribute('aria-valuetext') }));
    const view = document.getElementById('view');
    const eq = document.getElementById('equilibrium');
    return {
      controls: controls.length, unnamed, smallTargets: small, headings: heads, headingSkips: skips,
      slidersWithoutValuetext: sliders.filter((s) => !s.valuetext).map((s) => s.id),
      canvas: { role: view.getAttribute('role'), tabindex: view.getAttribute('tabindex'), label: view.getAttribute('aria-label') },
      liveRegions: document.querySelectorAll('[aria-live]').length, liveRegionPolite: eq.getAttribute('aria-live') === 'polite',
      reducedMotionRule: Array.from(document.styleSheets).some((ss) => { try { return Array.from(ss.cssRules).some((r) => r.media && /prefers-reduced-motion/.test(r.media.mediaText)); } catch (e) { return false; } }),
    };
  });
  check(report.a11y.unnamed.length === 0, `controls without an accessible name: ${report.a11y.unnamed.join(', ')}`);
  check(report.a11y.headingSkips === 0, 'heading levels skip');
  check(report.a11y.slidersWithoutValuetext.length === 0, `sliders without aria-valuetext: ${report.a11y.slidersWithoutValuetext.join(', ')}`);
  check(report.a11y.canvas.role === 'img' && report.a11y.canvas.tabindex !== null && /day/.test(report.a11y.canvas.label || ''), `canvas description: ${JSON.stringify(report.a11y.canvas)}`);
  check(report.a11y.smallTargets.length === 0, `targets under 24 px: ${JSON.stringify(report.a11y.smallTargets)}`);

  // ---- cadence: stats() ≤ 10/s, plot draw ≤ 8/s while playing ---------------------
  report.perf = await page.evaluate(async () => {
    const app = window.tissueApp;
    let statsCalls = 0, drawCalls = 0;
    const s0 = app.engine.stats.bind(app.engine); app.engine.stats = () => { statsCalls++; return s0(); };
    const p0 = app.plots[0] ? app.plots[0].plot : null; const d0 = p0 ? p0.draw.bind(p0) : null; if (p0) p0.draw = () => { drawCalls++; return d0(); };
    app.setPlaying(true);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2000));
    const dt = (performance.now() - t0) / 1000;
    app.setPlaying(false);
    app.engine.stats = s0; if (p0) p0.draw = d0;
    return { statsPerSec: +(statsCalls / dt).toFixed(1), plotDrawsPerSec: +(drawCalls / dt).toFixed(1), fps: document.getElementById('fps').textContent };
  });
  check(report.perf.statsPerSec <= 10.5, `stats() called ${report.perf.statsPerSec}/s`);
  check(report.perf.plotDrawsPerSec <= 8.5, `plot drawn ${report.perf.plotDrawsPerSec}/s`);
  await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
  await waitReady();
}

// ---- scripted events: the opt-in "Auto-apply" toggle ---------------------------
if (testEvents) {
  const ev = report.events = {};
  ev.scenarioEvents = await page.evaluate(() => (window.tissueApp.scenario().events || []).map((e) => ({ at: e.at, dials: e.dials || null, injure: !!e.injure })));
  if (!ev.scenarioEvents.length) {
    ev.skipped = `scenario "${loaded.scenario}" has no scripted events`;
  } else {
    const first = ev.scenarioEvents[0];
    const dialKeys = Object.keys(first.dials || {});
    // 1. default OFF: a run past the scripted day must change nothing by itself
    await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
    await waitReady();
    ev.toggleVisible = await page.evaluate(() => !!document.getElementById('btn-auto-events'));
    check(ev.toggleVisible, 'no auto-apply toggle on a scenario that has scripted events');
    ev.pressedInitially = await page.evaluate(() => document.getElementById('btn-auto-events').getAttribute('aria-pressed'));
    await page.evaluate(() => window.tissueApp.toggleAutoEvents(false));
    await page.evaluate((d) => window.tissueApp.advance(d), first.at + 2);
    ev.dialsOff = await page.evaluate((keys) => { const st = window.tissueApp.engine.state; const o = {}; for (const k of keys) o[k] = st.dials[k]; return o; }, dialKeys);
    for (const k of dialKeys) check(Math.abs(ev.dialsOff[k] - first.dials[k]) > 1e-9, `auto-apply off, but dial ${k} was set to the scripted ${first.dials[k]} anyway`);
    if (first.injure) {
      ev.woundOff = await page.evaluate(() => !!window.tissueApp.engine.state.wound);
      check(!ev.woundOff, 'auto-apply off, but the scripted injury happened anyway');
    }
    // 2. toggle ON (button, so the click path is what is tested), remembered for the session
    await page.click('#btn-auto-events');
    ev.pressedOn = await page.evaluate(() => document.getElementById('btn-auto-events').getAttribute('aria-pressed'));
    ev.session = await page.evaluate(() => { try { return window.sessionStorage.getItem('tw.autoEvents'); } catch (e) { return null; } });
    ev.toggleFlash = await page.evaluate(() => document.getElementById('equilibrium').textContent);
    check(ev.pressedOn === 'true', 'the auto-apply toggle did not switch on');
    check(ev.session === '1', `auto-apply was not remembered in sessionStorage (got ${ev.session})`);
    // 3. replay from day 0: the event must fire on its day, in the engine and in the dial UI
    await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
    await waitReady();
    await page.evaluate((d) => window.tissueApp.advance(d), first.at + 2);
    ev.day = await page.evaluate(() => window.tissueApp.engine.state.time);
    ev.dialsOn = await page.evaluate((keys) => { const st = window.tissueApp.engine.state; const o = {}; for (const k of keys) o[k] = st.dials[k]; return o; }, dialKeys);
    ev.dialUi = await page.evaluate((keys) => { const o = {}; for (const k of keys) o[k] = parseFloat(document.getElementById(`dial-${k}`).value); return o; }, dialKeys);
    ev.flash = await page.evaluate(() => document.getElementById('equilibrium').textContent);
    for (const k of dialKeys) {
      check(Math.abs(ev.dialsOn[k] - first.dials[k]) < 1e-9, `scripted event: engine dial ${k} is ${ev.dialsOn[k]}, expected ${first.dials[k]}`);
      check(Math.abs(ev.dialUi[k] - first.dials[k]) < 1e-9, `scripted event: dial UI ${k} shows ${ev.dialUi[k]}, engine has ${ev.dialsOn[k]}`);
    }
    if (first.injure) {
      ev.wound = await page.evaluate(() => !!window.tissueApp.engine.state.wound);
      check(ev.wound, 'the scripted injury did not happen with auto-apply on');
    }
    check(/scripted/i.test(ev.flash), `no scripted-event message in the live region: "${ev.flash}"`);
    await page.screenshot({ path: join(outDir, `${tag}-events.png`) });
    ev.shot = `${tag}-events.png`;
    // leave the toggle on: the long run below then plays the reference protocol hands-free
    ev.autoAppliedInFinalRun = true;
    await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
    await waitReady();
  }
}

if (process.env.INJURE && loaded.injury) await page.evaluate(() => window.tissueApp.injure());
const t0 = Date.now();
await page.evaluate((d) => window.tissueApp.advance(d), days);
report.advanceMs = Date.now() - t0;
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, `${tag}-day${days}.png`) });
// the same frame with the console scrolled home: tissue picker, scenario card, dials
if (panelTop) {
  await page.evaluate(() => { const p = document.getElementById('panel'); if (p) p.scrollTop = 0; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, `${tag}-day${days}-panel-top.png`) });
  report.panelTopShot = `${tag}-day${days}-panel-top.png`;
  report.panelScrollTop = await page.evaluate(() => document.getElementById('panel').scrollTop);
  check(report.panelScrollTop === 0, `panel did not scroll to the top (${report.panelScrollTop})`);
}
report.stats = await page.evaluate(() => window.tissueApp.stats);
report.canvasLabel = await page.evaluate(() => document.getElementById('view').getAttribute('aria-label'));
report.equilibrium = await page.evaluate(() => document.getElementById('equilibrium').textContent);
console.log(JSON.stringify(report, null, 1));
console.log(issues.length ? `console issues:\n${issues.join('\n')}` : 'no console errors');
console.log(failures.length ? `interaction/a11y failures:\n - ${failures.join('\n - ')}` : 'all interaction and a11y checks passed');
await browser.close();
server.kill();
process.exit(failures.length || issues.some((i) => i.startsWith('pageerror')) ? 1 : 0);
