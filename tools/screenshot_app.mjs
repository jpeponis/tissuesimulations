// Loads the app over a local HTTP server in headless Chromium, runs a scripted
// interaction sequence (load via deep link, play 1 s, move a dial with the
// keyboard, reset → ghost traces, injure when the tissue supports it, table
// toggle, keyboard shortcuts), probes basic accessibility (accessible names,
// heading order, status region, canvas description), measures the stats/plot
// cadence, saves screenshots and reports console errors.
//
// It also probes every acceptance criterion of docs/REVIEW.md package C, because each of them is
// a claim about the RENDERED page that no unit test can make:
//   C1  Space after a MOUSE click on a chip toggles play (the chip does not re-fire), and
//       Tab-then-Space still activates the chip a keyboard user is on
//   C2  the import map points at three.module.min.js and both modules are preloaded with crossorigin
//   C3  #status is the only live region, #equilibrium has no live role, and while playing the
//       status region speaks at most once per ~15 s (plus trend changes, pause, step, load)
//   C4  the flux gauge has its number in the DOM; a focused chart takes ←/→/Home/End/Esc and
//       mirrors the crosshair into #status; the five-day history table fills in
//   C7  every interactive border uses --control-border, and a pressed chip carries a ✓
//   C8  #btn-play sits at y < 200 and stays visible when the console is scrolled (sticky Run);
//       the flux readout is the first one; the metaphor/Watch text is collapsed per dial
//   C10 the speed default is 5 d/s with 1 / 5 / 20 presets, "+7 days" pauses on arrival without
//       a synchronous stall, and the clock shows the week
//   C12 ?present=1, the chip and the P key all set body.present; #fps is hidden but still written
//   C13 the first-run hint carries the tissue's own opening line and a button that opens About
//   C14 the open legend never reaches the HUD
//   A3  a frame never spends more than ~8 ms stepping
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
//              the engine, the dial UI and the status region, and saves a screenshot.
// --no-page-checks  skip the package-C page probes (for a page that is not index.html).
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
const pageChecks = !flags['no-page-checks'];
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

const report = { url, loaded, interaction: {}, a11y: {}, perf: {}, page: {} };

// ---- the page as it arrives: head, first-run hint, layout above the fold -------------------
if (pageChecks) {
  const pg = report.page;
  // C2: the minified library, preloaded, with the font host warmed up
  pg.head = await page.evaluate(() => {
    const map = document.querySelector('script[type="importmap"]');
    const links = Array.from(document.querySelectorAll('link')).map((l) => ({ rel: l.rel, href: l.href, crossOrigin: l.crossOrigin }));
    return {
      importmap: map ? JSON.parse(map.textContent).imports : null,
      modulepreload: links.filter((l) => l.rel === 'modulepreload'),
      preconnect: links.filter((l) => l.rel === 'preconnect'),
    };
  });
  const three = pg.head.importmap && pg.head.importmap.three;
  check(!!three && /three\.module\.min\.js$/.test(three), `import map should point at the minified build, got ${three}`);
  check(pg.head.modulepreload.length >= 2 && pg.head.modulepreload.every((l) => l.crossOrigin === 'anonymous'),
    `expected two crossorigin modulepreload links, got ${JSON.stringify(pg.head.modulepreload)}`);
  check(pg.head.preconnect.some((l) => /fonts\.gstatic\.com/.test(l.href) && l.crossOrigin === 'anonymous'),
    'fonts.gstatic.com is not preconnected with crossorigin');

  // C13: the first-run hint carries this tissue's own opening line and a way into About
  pg.hint = await page.evaluate(() => {
    const h = document.getElementById('hint');
    const intro = ((window.tissueApp.tissue.copy || {}).intro || {}).paragraphs || [];
    return { hidden: h.hidden, text: h.textContent.replace(/\s+/g, ' ').trim(), firstIntroWords: (intro[0] || '').split(/\s+/).slice(0, 6).join(' '), hasWhat: !!document.getElementById('btn-what') };
  });
  check(!pg.hint.hidden, 'the first-run hint is not shown on a fresh load');
  check(pg.hint.hasWhat, 'the hint has no "What am I looking at?" button');
  check(pg.hint.text.includes(pg.hint.firstIntroWords), `the hint does not open with the tissue's own words: "${pg.hint.text.slice(0, 90)}…"`);
  check(/Play/.test(pg.hint.text) && /dial/.test(pg.hint.text), 'the hint has no controls line');
  await page.click('#btn-what');
  pg.aboutOpened = await page.evaluate(() => document.getElementById('about').open);
  check(pg.aboutOpened, '"What am I looking at?" did not open About');
  // opening About scrolls it into view; put the page back before measuring anything (in the
  // stacked layout below 900 px it is the WINDOW that scrolled, not the console)
  await page.evaluate(() => { document.getElementById('about').open = false; document.getElementById('panel').scrollTop = 0; window.scrollTo(0, 0); });

  // C8: Run above the fold, and still there once the console is scrolled (sticky)
  pg.layout = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const first = document.querySelector('#readouts .readout');
    const panel = document.getElementById('panel');
    const pr = panel.getBoundingClientRect();
    const pb = document.getElementById('btn-play').getBoundingClientRect();
    return {
      play: box('#btn-play'), week: box('#btn-week'), run: box('.run'),
      // how far down the CONSOLE the play button sits — the same number in the two-column
      // layout (where the panel starts at y = 0) and in the stacked one below 900 px
      playInPanel: Math.round(pb.top - pr.top),
      panelScrollable: panel.scrollHeight > panel.clientHeight + 4,
      firstReadout: first ? { gauge: first.classList.contains('gauge'), label: (first.querySelector('h3') || {}).textContent } : null,
      hasFlux: (window.tissueApp.tissue.readouts || []).some((r) => r.type === 'flux'),
      panelTag: panel.tagName.toLowerCase(), panelLabel: panel.getAttribute('aria-label'),
      skip: (document.querySelector('.skip-link') || {}).getAttribute ? document.querySelector('.skip-link').getAttribute('href') : null,
      dialMore: document.querySelectorAll('#dials .dial-more').length,
      dialMoreOpen: Array.from(document.querySelectorAll('#dials .dial-more')).filter((d) => d.open).length,
      dialHintsVisible: Array.from(document.querySelectorAll('#dials .hint')).filter((h) => h.offsetParent !== null).length,
      dials: (window.tissueApp.tissue.dials || []).length,
    };
  });
  check(pg.layout.playInPanel < 200, `#btn-play is ${pg.layout.playInPanel}px down the console, wanted < 200`);
  check(!!pg.layout.week, 'no "+7 days" button');
  check(pg.layout.panelTag === 'section' && !!pg.layout.panelLabel, `the console is not a named landmark: <${pg.layout.panelTag} aria-label="${pg.layout.panelLabel}">`);
  check(pg.layout.skip === '#panel', `skip link target ${pg.layout.skip}`);
  if (pg.layout.hasFlux) check(pg.layout.firstReadout && pg.layout.firstReadout.gauge, `the first readout is "${pg.layout.firstReadout && pg.layout.firstReadout.label}", expected the flux gauge`);
  check(pg.layout.dialMore > 0 && pg.layout.dialMoreOpen === 0, `dial metaphor/Watch text is not collapsed (${pg.layout.dialMore} details, ${pg.layout.dialMoreOpen} open)`);
  check(pg.layout.dialHintsVisible === pg.layout.dials, `${pg.layout.dialHintsVisible}/${pg.layout.dials} dial biology hints visible — aria-describedby must stay visible`);
  // sticky only means anything where the console is its own scroll container (the two-column
  // layout); stacked under 900 px the whole page scrolls and Run travels with it
  if (pg.layout.panelScrollable) {
    pg.sticky = await page.evaluate(async () => {
      const panel = document.getElementById('panel');
      panel.scrollTop = panel.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.getElementById('btn-play').getBoundingClientRect();
      const out = { top: Math.round(r.top), scrolled: Math.round(panel.scrollTop) };
      panel.scrollTop = 0;
      return out;
    });
    check(pg.sticky.scrolled > 0 && pg.sticky.top >= 0 && pg.sticky.top < 200,
      `Run is not sticky: #btn-play at y=${pg.sticky.top} after scrolling ${pg.sticky.scrolled}px`);
  } else {
    pg.sticky = { skipped: 'the console is not its own scroll container at this width' };
  }

  // C10: the speed the copy quotes, with named presets
  pg.speed = await page.evaluate(() => ({
    speed: window.tissueApp.speed,
    slider: document.getElementById('speed').value,
    out: document.getElementById('speed-out').textContent,
    presets: Array.from(document.querySelectorAll('#speed-presets .chip')).map((b) => ({ label: b.textContent, title: b.getAttribute('title'), pressed: b.getAttribute('aria-pressed') })),
    week: (document.getElementById('week') || {}).textContent,
  }));
  check(pg.speed.speed === 5 && pg.speed.out.startsWith('5'), `default speed ${pg.speed.speed} (${pg.speed.out}), expected 5 d/s`);
  check(pg.speed.presets.map((p) => p.label).join('/') === 'Watch/Weeks/Months', `speed presets ${JSON.stringify(pg.speed.presets.map((p) => p.label))}`);
  check(/\b1 d\/s/.test(pg.speed.presets[0].title) && /\b5 d\/s/.test(pg.speed.presets[1].title) && /\b20 d\/s/.test(pg.speed.presets[2].title),
    `speed presets are not 1 / 5 / 20: ${JSON.stringify(pg.speed.presets.map((p) => p.title))}`);
  check(pg.speed.presets[1].pressed === 'true', 'the 5 d/s preset is not marked as the current one');
  check(/week \d/.test(pg.speed.week || ''), `the clock shows no week: "${pg.speed.week}"`);

  // C7: interactive borders and the reserved-space tick on a pressed chip
  pg.contrast = await page.evaluate(() => {
    const cs = (sel, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo || null) : null; };
    const border = (sel) => { const c = cs(sel); return c ? c.borderTopColor : null; };
    const chip = document.querySelector('#layers .chip[aria-pressed]');
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue('--control-border').trim(),
      // an unpressed control: a pressed chip / selected scenario / the primary button raise the
      // contrast further with --text or --amber, which is the point of the pressed state
      borders: { chip: border('#layers .chip[aria-pressed="false"]'), scenario: border('.scenario-btn[aria-pressed="false"]'), transport: border('.transport button:not(.primary)'), share: border('.share button'), segmented: border('.segmented') },
      tick: chip ? getComputedStyle(chip, '::before').content : null,
      tickHidden: chip ? getComputedStyle(chip, '::before').visibility : null,
      pressed: chip ? chip.getAttribute('aria-pressed') : null,
    };
  });
  check(pg.contrast.token === '#60758f', `--control-border is "${pg.contrast.token}"`);
  const want = 'rgb(96, 117, 143)';
  for (const [k, v] of Object.entries(pg.contrast.borders)) check(v === want, `${k} border is ${v}, expected ${want} (--control-border)`);
  check(/✓/.test(pg.contrast.tick || ''), `a pressed chip has no check glyph (::before content ${pg.contrast.tick})`);

  // A2: idle frames warm the scenario pre-runs, so the first Unloading click is not a freeze ----
  const fromScenario = await page.evaluate(() => (window.tissueApp.tissue.scenarios.find((s) => s.init && s.init.from) || {}).key || null);
  if (fromScenario) {
    // (1) idle frames must actually call it, and (2) driving it must end with a warm cache — the
    // wall-clock of (2) is left to the machine: software GL here runs at a fraction of the frame
    // rate a classroom laptop does, so the harness drives the same code path directly.
    pg.warm = await page.evaluate(async (key) => {
      const app = window.tissueApp;
      if (typeof app.engine.warmScenarios !== 'function') return { skipped: 'engine has no warmScenarios' };
      let calls = 0;
      const w0 = app.warmIdle.bind(app);
      app.warmIdle = (n) => { calls++; return w0(n); };
      await new Promise((r) => setTimeout(r, 2500));       // idle: the frame loop should be warming
      app.warmIdle = w0;
      let guard = 0;
      while (!app.warmDone && guard++ < 20000) app.warmIdle();
      const t0 = performance.now(); app.engine.reset(key); const warmMs = performance.now() - t0;
      const cold = new app.engine.constructor(app.tissue, { seed: 12345 });   // nothing cached
      const t1 = performance.now(); cold.reset(key); const coldMs = performance.now() - t1;
      return { key, calls, warmDone: app.warmDone, slices: guard, chunk: app.warmChunk, warmMs: +warmMs.toFixed(1), coldMs: +coldMs.toFixed(1) };
    }, fromScenario);
    if (!pg.warm.skipped) {
      check(pg.warm.calls >= 1, `no idle frame called warmIdle in 2.5 s (software GL renders a heavy tissue at about one frame a second here)`);
      check(pg.warm.warmDone, 'warmScenarios never reported done');
      check(pg.warm.warmMs < Math.max(50, pg.warm.coldMs / 5),
        `the "${pg.warm.key}" pre-run was not cached: reset took ${pg.warm.warmMs} ms (cold ${pg.warm.coldMs} ms)`);
    }
    await page.evaluate((s) => window.tissueApp.loadScenario(s, { ghost: false }), loaded.scenario);
    await waitReady();
  }

  // REVIEW §5: the export starts at t = 0, and its meta carries the seed and the box
  pg.export = await page.evaluate(() => {
    const app = window.tissueApp;
    const meta = app.engine.exportMeta();
    return { frames: app.exportFrames.length, firstT: app.exportFrames.length ? app.exportFrames[0].t : null, seed: meta.seed, L: meta.L, N: meta.N };
  });
  check(pg.export.frames > 0 && pg.export.firstT === 0, `the export has no t=0 frame: ${JSON.stringify(pg.export)}`);
  check(Number.isFinite(pg.export.seed) && Number.isFinite(pg.export.L), `export meta lacks seed / L: ${JSON.stringify(pg.export)}`);

  // C14: the open legend never reaches the HUD
  pg.legend = await page.evaluate(() => {
    const box = document.getElementById('legend-box');
    box.open = true;
    const l = document.getElementById('legend').getBoundingClientRect();
    const hud = document.querySelector('.hud-top').getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('legend'));
    return { top: Math.round(l.top), hudBottom: Math.round(hud.bottom), maxHeight: cs.maxHeight, overflowY: cs.overflowY };
  });
  check(pg.legend.maxHeight !== 'none' && pg.legend.overflowY === 'auto', `#legend has no height cap (${pg.legend.maxHeight} / ${pg.legend.overflowY})`);
  check(pg.legend.top > pg.legend.hudBottom, `the open legend (top ${pg.legend.top}) reaches the HUD (bottom ${pg.legend.hudBottom})`);
}

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
      charts: Array.from(document.querySelectorAll('#readouts .readout:not(.gauge) canvas')).map((c) => ({ role: c.getAttribute('role'), tabindex: c.getAttribute('tabindex'), label: (c.getAttribute('aria-label') || '').slice(0, 40) })),
      liveRegions: document.querySelectorAll('[aria-live]').length,
      status: (() => { const st = document.getElementById('status'); return st ? { role: st.getAttribute('role'), live: st.getAttribute('aria-live'), atomic: st.getAttribute('aria-atomic'), offscreen: st.getBoundingClientRect().width <= 2 } : null; })(),
      equilibriumLive: eq.getAttribute('aria-live') || eq.getAttribute('role') || null,
      reducedMotionRule: Array.from(document.styleSheets).some((ss) => { try { return Array.from(ss.cssRules).some((r) => r.media && /prefers-reduced-motion/.test(r.media.mediaText)); } catch (e) { return false; } }),
    };
  });
  check(report.a11y.unnamed.length === 0, `controls without an accessible name: ${report.a11y.unnamed.join(', ')}`);
  check(report.a11y.headingSkips === 0, 'heading levels skip');
  check(report.a11y.slidersWithoutValuetext.length === 0, `sliders without aria-valuetext: ${report.a11y.slidersWithoutValuetext.join(', ')}`);
  check(report.a11y.canvas.role === 'img' && report.a11y.canvas.tabindex !== null && /day/.test(report.a11y.canvas.label || ''), `canvas description: ${JSON.stringify(report.a11y.canvas)}`);
  check(report.a11y.smallTargets.length === 0, `targets under 24 px: ${JSON.stringify(report.a11y.smallTargets)}`);
  // C3: exactly one live region, and it is the sr-only status one — not the sentence that is
  // rewritten every 0.7 s
  check(!!report.a11y.status && report.a11y.status.role === 'status' && report.a11y.status.live === 'polite' && report.a11y.status.offscreen,
    `#status is not an off-screen polite status region: ${JSON.stringify(report.a11y.status)}`);
  check(report.a11y.equilibriumLive === null, `#equilibrium still carries a live role (${report.a11y.equilibriumLive})`);
  check(report.a11y.liveRegions === 1, `${report.a11y.liveRegions} live regions; exactly one (#status) is expected`);
  // C4: every chart is reachable and describes itself
  check(report.a11y.charts.every((c) => c.tabindex === '0' && c.role === 'img' && c.label), `charts are not focusable: ${JSON.stringify(report.a11y.charts)}`);

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

// ---- package C behaviour that only the rendered page can answer ----------------
if (interact && pageChecks) {
  const pg = report.page;

  // C1: Space after a MOUSE click belongs to play/pause, not to the clicked button ------------
  await page.evaluate(() => window.tissueApp.setPlaying(false));
  await page.click('.scenario-btn');                       // a real mouse click (detail 1)
  await waitReady();
  pg.spaceAfterClick = await page.evaluate(() => ({ active: (document.activeElement || {}).tagName, scenario: window.tissueApp.scenarioKey, playing: window.tissueApp.playing }));
  await page.keyboard.press('Space');
  pg.spaceAfterClick.playsAfterSpace = await page.evaluate(() => window.tissueApp.playing);
  await page.keyboard.press('Space');
  pg.spaceAfterClick.pausesAfterSpace = !(await page.evaluate(() => window.tissueApp.playing));
  pg.spaceAfterClick.scenarioAfter = await page.evaluate(() => window.tissueApp.scenarioKey);
  check(pg.spaceAfterClick.active !== 'BUTTON', `a mouse-clicked button kept focus (${pg.spaceAfterClick.active}), so Space would re-fire it`);
  check(pg.spaceAfterClick.playsAfterSpace && pg.spaceAfterClick.pausesAfterSpace,
    'Space after a mouse click on a scenario chip did not toggle play/pause');
  check(pg.spaceAfterClick.scenarioAfter === pg.spaceAfterClick.scenario, 'Space after a mouse click reloaded the scenario');
  // and a KEYBOARD-focused button still activates on Space (nothing was taken away)
  await page.evaluate(() => window.tissueApp.advance(2));
  await page.evaluate(() => document.getElementById('btn-reset').focus());
  await page.keyboard.press('Space');
  await waitReady();
  pg.spaceOnFocusedButton = await page.evaluate(() => ({ day: window.tissueApp.engine.state.time, playing: window.tissueApp.playing, active: (document.activeElement || {}).id }));
  check(pg.spaceOnFocusedButton.day < 0.1 && !pg.spaceOnFocusedButton.playing,
    `Space on a keyboard-focused Reset did not reset (day ${pg.spaceOnFocusedButton.day}, playing ${pg.spaceOnFocusedButton.playing})`);

  // C3: how often the status region speaks while the clock runs ------------------------------
  pg.status = await page.evaluate(async () => {
    const el = document.getElementById('status');
    const seen = [];
    const obs = new MutationObserver(() => seen.push({ t: Math.round(performance.now()), text: el.textContent.slice(0, 60) }));
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    window.tissueApp.setPlaying(true);
    await new Promise((r) => setTimeout(r, 5000));
    window.tissueApp.setPlaying(false);
    await new Promise((r) => setTimeout(r, 200));
    obs.disconnect();
    return { changes: seen.length, texts: seen.map((s) => s.text), last: el.textContent.slice(0, 80) };
  });
  check(pg.status.changes <= 4, `#status changed ${pg.status.changes} times in 5 s of playing: ${JSON.stringify(pg.status.texts)}`);
  check(/Paused/.test(pg.status.last), `pausing did not announce: "${pg.status.last}"`);
  await page.click('#btn-step');
  pg.statusAfterStep = await page.evaluate(() => document.getElementById('status').textContent);
  check(/Day \d/.test(pg.statusAfterStep), `a step did not announce the day: "${pg.statusAfterStep}"`);

  // C4: the gauge number in the DOM, and the keyboard crosshair -------------------------------
  pg.gaugeValue = await page.evaluate(() => {
    const g = document.querySelector('#readouts .readout.gauge .val');
    return g ? g.textContent : null;
  });
  if (pg.layout && pg.layout.hasFlux) check(/\/d/.test(pg.gaugeValue || ''), `the flux gauge has no number in the DOM: "${pg.gaugeValue}"`);
  await page.evaluate(() => document.querySelector('#readouts .readout:not(.gauge) canvas').focus());
  await page.keyboard.press('ArrowLeft');
  pg.crosshair = await page.evaluate(() => ({ i: window.tissueApp.plots[0].plot.hoverI, status: document.getElementById('status').textContent.slice(0, 90) }));
  await page.keyboard.press('ArrowLeft');
  pg.crosshair.after2 = await page.evaluate(() => window.tissueApp.plots[0].plot.hoverI);
  await page.keyboard.press('Home');
  pg.crosshair.home = await page.evaluate(() => window.tissueApp.plots[0].plot.hoverI);
  await page.keyboard.press('Escape');
  pg.crosshair.afterEsc = await page.evaluate(() => window.tissueApp.plots[0].plot.hoverI);
  check(pg.crosshair.i !== null && pg.crosshair.after2 === pg.crosshair.i - 1 && pg.crosshair.home === 0 && pg.crosshair.afterEsc === null,
    `keyboard crosshair: ${JSON.stringify(pg.crosshair)}`);
  check(/day/i.test(pg.crosshair.status), `the crosshair is not mirrored into #status: "${pg.crosshair.status}"`);
  pg.history = await page.evaluate(() => {
    const d = document.querySelector('#readouts .history') || document.querySelector('.history');
    if (!d) return null;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    return { rows: d.querySelectorAll('tbody tr').length, cols: d.querySelectorAll('thead th').length };
  });
  check(pg.history && pg.history.rows > 0, `the five-day history table is empty: ${JSON.stringify(pg.history)}`);

  // C11: a dial change and an injury leave a mark on the time axis ----------------------------
  await page.evaluate(() => {
    const d = window.tissueApp.tissue.dials[0];
    window.tissueApp.setDial(d.key, d.default === d.max ? d.min : d.max, 'test');
    window.tissueApp.setDial(d.key, d.default === d.max ? d.min : d.max, 'test');   // same day: still one mark
  });
  pg.marks = await page.evaluate(() => window.tissueApp.plots[0].plot.marks.map((m) => ({ letter: m.letter, key: m.key, label: m.label, t: m.t })));
  check(pg.marks.length === 1, `expected one debounced dial mark, got ${JSON.stringify(pg.marks)}`);
  check(/→/.test(pg.marks[0].label), `the mark does not name the change: ${JSON.stringify(pg.marks[0])}`);

  // C10: "+7 days" runs to a target without a synchronous stall --------------------------------
  const beforeWeek = await page.evaluate(() => window.tissueApp.engine.state.time);
  const tClick = Date.now();
  await page.click('#btn-week');
  pg.weekJump = { clickMs: Date.now() - tClick, target: await page.evaluate(() => window.tissueApp.stopAt), playing: await page.evaluate(() => window.tissueApp.playing) };
  check(pg.weekJump.clickMs < 400, `"+7 days" blocked the UI for ${pg.weekJump.clickMs} ms — it must run, not step`);
  check(pg.weekJump.playing && Math.abs(pg.weekJump.target - (beforeWeek + 7)) < 1e-6, `"+7 days" did not set a stopAt: ${JSON.stringify(pg.weekJump)}`);
  await page.waitForFunction(() => !window.tissueApp.playing, null, { timeout: 30000 }).catch(() => {});
  pg.weekJump.day = await page.evaluate(() => window.tissueApp.engine.state.time);
  pg.weekJump.stopAtAfter = await page.evaluate(() => window.tissueApp.stopAt);
  check(Math.abs(pg.weekJump.day - (beforeWeek + 7)) < 0.5 && pg.weekJump.stopAtAfter === null,
    `"+7 days" ended at day ${pg.weekJump.day}, wanted ${beforeWeek + 7}`);

  // A3: a frame never spends more than the stepping budget ------------------------------------
  pg.stepBudget = await page.evaluate(async () => {
    const app = window.tissueApp;
    const f0 = app.frame.bind(app), r0 = app.runSteps.bind(app);
    let cur = 0, max = 0, frames = 0;
    app.runSteps = (n) => { const t0 = performance.now(); const out = r0(n); cur += performance.now() - t0; return out; };
    app.frame = (now) => { if (cur > max) max = cur; cur = 0; frames++; return f0(now); };
    const speed = app.speed;
    app.setSpeed(20, false);
    app.setPlaying(true);
    await new Promise((r) => setTimeout(r, 2500));
    app.setPlaying(false);
    app.setSpeed(speed, false);
    app.frame = f0; app.runSteps = r0;
    return { maxStepMsPerFrame: +max.toFixed(1), frames };
  });
  check(pg.stepBudget.maxStepMsPerFrame < 25, `a frame spent ${pg.stepBudget.maxStepMsPerFrame} ms stepping (budget 8 ms + one chunk)`);
  // and an impossible speed drops the backlog instead of falling behind for ever
  pg.slowed = await page.evaluate(async () => {
    const app = window.tissueApp;
    const speed = app.speed;
    app.speed = 4000;
    app.setPlaying(true);
    await new Promise((r) => setTimeout(r, 1600));
    const fps = document.getElementById('fps').textContent;
    app.setPlaying(false);
    app.setSpeed(speed, false);
    return { fps, accum: app.accum };
  });
  check(/sim slowed/.test(pg.slowed.fps), `#fps did not report the dropped backlog: "${pg.slowed.fps}"`);

  // C12: presentation mode from the key, the chip and the URL ---------------------------------
  await page.evaluate(() => document.getElementById('panel').focus());
  await page.keyboard.press('p');
  pg.presentByKey = await page.evaluate(() => document.body.classList.contains('present'));
  await page.keyboard.press('p');
  pg.presentOff = await page.evaluate(() => !document.body.classList.contains('present'));
  await page.click('#btn-present');
  pg.present = await page.evaluate(() => ({
    on: document.body.classList.contains('present'),
    pressed: document.getElementById('btn-present').getAttribute('aria-pressed'),
    sentencePx: Math.round(parseFloat(getComputedStyle(document.querySelector('.equilibrium')).fontSize)),
    clockPx: Math.round(parseFloat(getComputedStyle(document.querySelector('.clock')).fontSize)),
    panelPx: Math.round(document.getElementById('panel').getBoundingClientRect().width),
    hintsShown: Array.from(document.querySelectorAll('#dials .hint')).filter((h) => h.offsetParent !== null).length,
    fpsShown: getComputedStyle(document.getElementById('fps')).display !== 'none',
    fpsText: document.getElementById('fps').textContent,
    url: window.tissueApp.buildUrl(),
  }));
  check(pg.presentByKey && pg.presentOff, 'the P key does not toggle presentation mode');
  check(pg.present.on && pg.present.pressed === 'true', 'the Presentation chip did not turn presentation mode on');
  check(pg.present.sentencePx >= 22 && pg.present.clockPx >= 17, `presentation type is too small: ${pg.present.sentencePx}px sentence, ${pg.present.clockPx}px clock`);
  check(pg.present.hintsShown === 0, 'the dial hints are still shown in presentation mode');
  check(!pg.present.fpsShown && /fps/.test(pg.present.fpsText), `#fps must be hidden but still written: shown=${pg.present.fpsShown} text="${pg.present.fpsText}"`);
  check(/present=1/.test(pg.present.url), `the copied link drops presentation mode: ${pg.present.url}`);
  await page.screenshot({ path: join(outDir, `${tag}-present.png`) });
  report.presentShot = `${tag}-present.png`;
  await page.click('#btn-present');

  // B3: the auto-rotate chip, and ?rotate=0 -----------------------------------------------------
  pg.rotate = await page.evaluate(() => {
    const b = document.getElementById('btn-rotate');
    if (!b) return null;
    const before = b.getAttribute('aria-pressed');
    b.click();
    return { before, after: b.getAttribute('aria-pressed'), app: window.tissueApp.autoRotate, url: window.tissueApp.buildUrl() };
  });
  check(!!pg.rotate && pg.rotate.before !== pg.rotate.after, `the auto-rotate chip did not toggle: ${JSON.stringify(pg.rotate)}`);
  if (pg.rotate && pg.rotate.after === 'false') check(/rotate=0/.test(pg.rotate.url), `auto-rotate off is not in the link: ${pg.rotate.url}`);
  await page.evaluate(() => { const b = document.getElementById('btn-rotate'); if (b && b.getAttribute('aria-pressed') === 'false') b.click(); });

  // put the page back the way the long run expects it
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
