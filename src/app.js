// app.js — wires a tissue definition (src/tissues/*) through the generic engine
// (engine.js) to the 3D scene (render.js), the readouts (plots.js) and the
// shared copy helpers (copy.js). Everything in the panel — tissue picker, dials,
// scenario chips and card, readouts, legend, layer chips, About — is generated
// from the definition (docs/EXTENDING.md §1, §6). Nothing here knows a specific
// tissue.
//
// Build constraints: ES module, named exports only, unique top-level identifiers
// (prefixed app/APP_/TissueApp), one-line local imports. render.js is loaded with
// a dynamic import so a CDN failure of Three.js can be caught and explained; in
// the single-file build render.js is inlined ahead of this file, so the already
// defined class is used and the import is never attempted.
import { TissueEngine } from './engine.js';
import { TISSUES, TISSUE_DEFAULT } from './tissues/index.js';
import { TimeSeriesPlot, FluxGauge } from './plots.js';
import { copyEquilibriumSentence, copyFormatRate, copyFormatDial, copyTrend } from './copy.js';

const APP_THEME = {
  text: '#e6edf3', muted: '#8b9bb0', grid: '#243040', surface: '#161e28',
  warm: '#c4822a', cool: '#3f97dc',
};
const APP_SEED = 12345;
const APP_STATS_MS = 100;   // engine.stats() at most 10×/s
const APP_PLOT_MS = 125;    // plots redraw at most 8×/s
const APP_SENTENCE_MS = 700;
const APP_LABEL_MS = 5000;  // canvas aria-label refresh
const APP_TABLE_MS = 500;
const APP_URL_MS = 500;     // history.replaceState debounce
const APP_FLASH_MS = 3200;
const APP_STATUS_MS = 15000;    // screen-reader status: at most one routine announcement per 15 s
const APP_TREND_MS = 5000;      // …and at most one "the balance turned" announcement per 5 s
const APP_TREND_HOLD_MS = 1000; // a new trend must hold this long before it is worth saying
const APP_STATUS_FLOOR_MS = 10000;  // …and nothing the CLOCK causes ever lands within 10 s of the last
const APP_HOVER_SAY_MS = 220;   // the keyboard crosshair speaks once the arrow key comes to rest
const APP_STEP_BUDGET_MS = 8;   // wall-clock stepping budget per frame (A3); always ≥ 1 step
const APP_SLOW_MS = 1500;       // how long "sim slowed" stays in #fps after a dropped backlog
const APP_WARM_MS = 5;          // idle-frame budget for engine.warmScenarios (A2)
const APP_WARM_CHUNK_MS = 2;    // …spent in slices this long, so the budget is not overshot
const APP_GHOST_MIN_DAYS = 0.5; // a run shorter than this is not worth keeping as a ghost
const APP_SPEED_DEFAULT = 5;    // days per second — the number the teaching copy quotes
const APP_SPEEDS = [['Watch', 1], ['Weeks', 5], ['Months', 20]];  // labelled presets next to the speed slider
const APP_WEEK_JUMP = 7;        // the "+7 days" button, run (not stepped) to a stopAt
// endpoint glyphs: identity never by colour alone (B5). Five of them, so a readout with four or
// five series never repeats one — the cartilage phenotype/memory pair are luminance twins, and a
// repeated circle left them differing by hue alone.
const APP_MARKERS = ['circle', 'square', 'diamond', 'triangle', 'cross'];
const APP_PRESENT_FONT = 14;    // readout font in presentation mode (11 px normally)
const APP_EVENTS_KEY = 'tw.autoEvents';
const APP_HINT_KEY = 'tw.hintDismissed';    // the first-run card, dismissed for this session
const APP_SHORTCUT_KEY = 'tw.shortcuts';    // single-key shortcuts on/off, remembered between visits
const APP_LEGEND_MIN_H = 132;   // px of stage left under the HUD before the legend moves into the console
const APP_KEYS = [
  ['Space', 'play / pause'], ['R', 'reset the scenario (previous run stays dashed)'], ['I', 'injure (when the tissue supports it)'],
  ['1 – 9', 'pick a scenario'], ['P', 'presentation mode (bigger sentence and clock)'],
  ['← →', 'nudge the focused dial (Home / End for the extremes); on a focused chart, move the crosshair (Esc drops it)'],
  ['Tab', 'move between controls; the 3D view and every chart are focusable and describe themselves'],
];
/**
 * The camera chips under the layer chips: [id, glyph, accessible name, renderer method, args].
 * Each is checked against the renderer before it is built, so a renderer without the camera API
 * (or none at all, when WebGL failed) simply has no camera row.
 */
const APP_CAMERA = [
  ['cam-left', '◀', 'Orbit the view left', 'orbit', (s) => [-s.rot, 0]],
  ['cam-right', '▶', 'Orbit the view right', 'orbit', (s) => [s.rot, 0]],
  ['cam-up', '▲', 'Orbit the view up', 'orbit', (s) => [0, -s.rot]],
  ['cam-down', '▼', 'Orbit the view down', 'orbit', (s) => [0, s.rot]],
  ['cam-in', '+', 'Zoom in', 'dolly', (s) => [1 / s.dolly]],
  ['cam-out', '−', 'Zoom out', 'dolly', (s) => [s.dolly]],
  ['cam-home', '⌂', 'Recentre the camera on the default framing', 'resetView', () => []],
];
const APP_CAMERA_STEP = { rot: 0.26, dolly: 1.15 };   // one chip press ≈ one arrow-key press (render.js)
/** The one line of orientation under the intro paragraph in the first-run hint (C13). */
const APP_HINT_CONTROLS = 'Press Play to start the clock, drag a dial to change the weather, and drag the 3D view to look around. Everything works from the keyboard too — Space plays, 1–9 pick a scenario.';
const APP_OFFLINE_HTML = 'To use this page offline: reload once with an internet connection so the browser caches the library, or download <code>three@0.160.0</code> (<code>build/three.module.min.js</code> and <code>examples/jsm/controls/OrbitControls.js</code>) next to this page and point the import map in the HTML at those files.';

function appEl(id) { return document.getElementById(id); }
function appH(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c !== '' && c != null) el.append(c);
  return el;
}
function appClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function appNum(v) { return String(Math.round(v * 1000) / 1000); }
function appRound(x) { return x >= 10 ? x.toFixed(0) : String(Math.round(x * 10) / 10); }
function appFirstSentence(t) { return (String(t).match(/^[^.]*\./) || [t])[0]; }
function appShortLabel(t) { return String(t).replace(/\s*\(.*\)\s*$/, ''); }
/** A label mid-sentence: lower-case the first letter, unless the first word is an acronym
 *  ('Dynamic compression' → 'dynamic compression', 'TGF-β3 bath' and 'Collagen I' kept). */
function appLowerFirst(t) {
  const s = String(t);
  const first = s.split(' ')[0];
  return /[A-Z]/.test(first.slice(1)) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}
/**
 * 10^v as a readable number, never in exponent notation (REVIEW §5): 320, 32, 5.6, 0.89, 0.0089.
 * `toPrecision` would print 1.5e+2 / 8.9e-8 for the tails of a log axis that leaves its domain.
 */
function appPow10(v) {
  const x = Math.pow(10, v);
  if (!Number.isFinite(x)) return '–';
  if (x >= 10) return x.toFixed(0);
  if (x >= 1) return x.toFixed(1);
  if (x >= 0.01) return x.toFixed(2);
  const digits = Math.min(20, Math.max(2, 2 - Math.floor(Math.log10(x))));   // two significant digits
  return x.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}
/** The day as weeks, for the clock: "week 3.4". */
function appWeek(t) { return `week ${(t / 7).toFixed(1)}`; }
function appFormatDial(dial, v) { return typeof dial.format === 'function' ? dial.format(v) : copyFormatDial(dial.format, v); }
function appSpeedText(speed) {
  const week = 7 / speed;
  const hint = week >= 2 ? `1 week ≈ ${appRound(week)} s` : `1 month ≈ ${appRound(30 / speed)} s`;
  return { value: `${speed} d/s`, hint, valuetext: `${speed} simulated days per second; ${hint.replace('≈', 'takes about')}` };
}
/** Resolve a stat path from a stats() object (§1 paths against the §3 shape, both nestings accepted). */
function appStat(stats, path) {
  if (!stats || !path) return NaN;
  const parts = String(path).split('.');
  if (parts[0] === 'species' && parts.length === 3 && parts[2] === 'fraction') {
    const f = stats.fraction && stats.fraction[parts[1]];
    if (typeof f === 'number') return f;
    const s = stats.species && stats.species[parts[1]];
    return s && typeof s.fraction === 'number' ? s.fraction : NaN;
  }
  if (path === 'fiber.total') { const v = stats.species ? stats.species.fiberTotal : stats.fiberTotal; return typeof v === 'number' ? v : NaN; }
  let v = stats;
  for (const p of parts) { if (v == null) return NaN; v = v[p]; }
  return typeof v === 'number' ? v : NaN;
}
/**
 * The cell type's state descriptors, in the order the definition gives them:
 * `cellTypes[0].states` ([{ key, label, range }], the richer form) if present, else the
 * `stateLabels` map, else a single 'activation'. Nothing here assumes what a state means.
 */
function appCellStates(tissue) {
  const ct = (tissue && tissue.cellTypes && tissue.cellTypes[0]) || null;
  if (ct && Array.isArray(ct.states) && ct.states.length) {
    return ct.states.filter((s) => s && s.key).map((s) => ({ key: String(s.key), label: s.label || String(s.key), range: Array.isArray(s.range) ? s.range : null }));
  }
  const out = [];
  const sl = ct && ct.stateLabels;
  if (sl) for (const k of ['a', 'b', 'c']) if (typeof sl[k] === 'string' && sl[k].trim()) out.push({ key: k, label: sl[k], range: null });
  return out.length ? out : [{ key: 'a', label: 'activation', range: null }];
}
/** The primary state as a noun plus its parenthetical, e.g. 'phenotype (1 = chondrogenic)'. */
function appStateNoun(states) {
  const st = states.find((s) => s.key === 'a') || states[0];
  const label = (st && st.label) || 'activation';
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  return m && m[1] ? { noun: m[1], qualifier: m[2] } : { noun: label, qualifier: '' };
}
/** sessionStorage, with the read/write wrapped: sandboxed hosts throw on access. */
function appSession(key, value) {
  try {
    if (value === undefined) return window.sessionStorage.getItem(key);
    window.sessionStorage.setItem(key, value);
    return value;
  } catch (e) { return null; }
}
/** localStorage, same treatment: for the one preference worth keeping between visits. */
function appLocal(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
    return value;
  } catch (e) { return null; }
}
/** Give a scroll container a tab stop only while it actually overflows (axe scrollable-region-focusable). */
function appScrollable(el, axis) {
  if (!el) return false;
  const over = axis === 'y' ? el.scrollHeight > el.clientHeight + 2 : el.scrollWidth > el.clientWidth + 2;
  el.tabIndex = over ? 0 : -1;
  return over;
}
function appHasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}
/** The renderer class: already inlined (single-file build) or loaded on demand (module build). */
async function appLoadRenderer() {
  if (typeof TissueRenderer === 'function') return TissueRenderer; // eslint-disable-line no-undef
  const mod = await import('./render.js');
  if (!mod || typeof mod.TissueRenderer !== 'function') throw new Error('render.js has no TissueRenderer export');
  return mod.TissueRenderer;
}

export class TissueApp {
  constructor() {
    this.tissues = TISSUES;
    this.tissueKey = null; this.tissue = null; this.engine = null; this.renderer = null;
    this.rendererState = 'loading';
    this.layers = { fibers: true, cells: true, scaffold: true, gel: true, fields: {} };
    this.playing = false; this.hasPlayed = false; this.ready = false;
    this.speed = APP_SPEED_DEFAULT; this.accum = 0; this.lastFrame = 0; this.dt = 0.02;
    this.scenarioKey = null;
    this.exportFrames = []; this.exportEvery = 2; this.nextExportT = 0;
    this.stats = null; this.values = {}; this.dialValues = {};
    this.lastStatsAt = -1e9; this.lastPlotAt = -1e9; this.lastSentenceAt = -1e9; this.lastLabelAt = -1e9; this.lastTableAt = -1e9;
    this.flashUntil = 0; this.urlTimer = null; this.frameTimes = []; this.lastFpsAt = 0;
    this.plots = []; this.gauge = null; this.gaugeVal = null; this.tableOn = false; this.tableCells = [];
    this.historyBox = null; this.historyOut = null;
    this.dialInputs = {}; this.dialOutputs = {}; this.scenarioButtons = {}; this.layerButtons = {}; this.speedButtons = [];
    this.cellStates = []; this.stateNoun = { noun: 'activation', qualifier: '' }; this.voc = {};
    // screen-reader status region (C3): routine announcements at most every APP_STATUS_MS,
    // plus one whenever the trend changes, the clock stops or a scenario loads
    this.statusText = ''; this.lastStatusAt = -1e9; this.lastTrend = null; this.statusFlip = false;
    this.lastSaidSentence = '';            // the last equilibrium sentence announced (not re-said)
    this.lastRevision = undefined;         // engine.revision at the last stats sample (B1/A3)
    this.pendingTrend = null; this.pendingTrendAt = 0; this.lastTrendSaidAt = -1e9;
    this.stopAt = null;                    // "+7 days": pause when the clock reaches this day
    this.slowUntil = 0;                    // "sim slowed" in #fps while a backlog is being dropped
    this.warmDone = false; this.warmChunk = 16;   // idle-frame scenario warm-up (A2)
    this.present = false; this.autoRotate = true;
    this.hoverTimer = null;                // the keyboard crosshair speaks once, after the key rests
    this.legendDocked = false;             // the legend has moved into the console (short stage)
    this.hintDismissed = appSession(APP_HINT_KEY) === '1';
    // Single-character shortcuts need a way OFF (WCAG 2.1.4 Character Key Shortcuts): a speech-input
    // user dictating anything with an "r" in it would otherwise destroy the run. Default on — they
    // are what the classroom uses — remembered between visits, and Space is never gated.
    this.shortcuts = appLocal(APP_SHORTCUT_KEY) !== '0';
    // scripted scenario events: off by default (the student does the protocol by hand),
    // remembered for the session so an instructor can leave hands-free mode on
    this.autoEvents = appSession(APP_EVENTS_KEY) === '1';
    this.pendingEvents = []; this.eventIdx = 0;
    const mq = (q) => (window.matchMedia ? window.matchMedia(q) : null);
    this.motionQuery = mq('(prefers-reduced-motion: reduce)');
    this.narrowQuery = mq('(max-width: 900px)');
    this.reducedMotion = !!(this.motionQuery && this.motionQuery.matches);
    this.query = new URLSearchParams(window.location.search);

    this.present = this.query.get('present') === '1';
    this.autoRotate = this.query.get('rotate') !== '0' && !this.reducedMotion;
    if (this.query.get('debug') === '1') document.body.classList.add('debug');

    this.bindStatic();
    this.buildTissuePicker();
    this.setPresent(this.present, false);
    const qSpeed = parseFloat(this.query.get('speed'));
    this.setSpeed(Number.isFinite(qSpeed) ? qSpeed : APP_SPEED_DEFAULT, false);
    const qt = this.query.get('tissue');
    const defKey = typeof TISSUE_DEFAULT === 'string' ? TISSUE_DEFAULT : (TISSUE_DEFAULT && TISSUE_DEFAULT.key);
    const first = (qt && TISSUES[qt]) ? qt : (defKey && TISSUES[defKey] ? defKey : Object.keys(TISSUES)[0]);
    const qDials = {};
    for (const [k, v] of this.query) { const x = parseFloat(v); if (Number.isFinite(x)) qDials[k] = x; }
    this.setTissue(first, { scenario: this.query.get('scenario'), dials: qDials });
    this.initRenderer();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- static controls (exist in index.html) ----------
  bindStatic() {
    appEl('btn-play').addEventListener('click', () => this.togglePlay());
    appEl('btn-step').addEventListener('click', () => this.advance(1));
    appEl('btn-week').addEventListener('click', () => this.runFor(APP_WEEK_JUMP));
    appEl('btn-reset').addEventListener('click', () => this.reset());
    appEl('btn-injure').addEventListener('click', () => this.injure());
    appEl('btn-copy-link').addEventListener('click', () => this.copyLink());
    appEl('btn-table').addEventListener('click', () => this.toggleTable());
    appEl('btn-clear-ref').addEventListener('click', () => this.clearReference(true));
    // dismissing the card means dismissed: buildHint re-derives visibility on every tissue switch,
    // so without the flag the second tissue brought the card back
    appEl('hint-dismiss').addEventListener('click', () => {
      this.hintDismissed = true; appSession(APP_HINT_KEY, '1');
      appEl('hint').hidden = true; appEl('btn-play').focus();
    });
    appEl('btn-present').addEventListener('click', () => this.setPresent(!this.present, true));
    const speed = appEl('speed');
    speed.addEventListener('input', () => this.setSpeed(parseFloat(speed.value), true));
    // three named speeds beside the slider: the slider still takes any value in between
    const presets = appEl('speed-presets');
    presets.replaceChildren();
    this.speedButtons = APP_SPEEDS.map(([label, v]) => {
      const t = appSpeedText(v);
      const b = appH('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', text: label, title: `${t.value} — ${t.hint}` });
      b.addEventListener('click', () => this.setSpeed(v, false));
      presets.append(b);
      return { b, v };
    });
    /**
     * Space belongs to play/pause (C1). A button keeps focus after a MOUSE click, so the next
     * Space re-fires that button — a scenario chip reloads, Injure wounds again. Drop focus from
     * a mouse-clicked button (`detail > 0`; a keyboard-activated click reports 0), except the
     * play button itself, where keeping focus is exactly what a repeat press should hit. Keyboard
     * users never lose focus, so Tab-then-Space still activates the button they are on.
     */
    document.addEventListener('click', (e) => {
      if (!e.detail) return;
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (b && b.id !== 'btn-play' && document.activeElement === b) b.blur();
    });
    // legend: open on wide screens, collapsed (but reachable) on narrow ones
    const legendBox = appEl('legend-box');
    const applyLegend = () => { legendBox.open = !(this.narrowQuery && this.narrowQuery.matches); this.layoutLegend(); };
    applyLegend();
    if (this.narrowQuery && this.narrowQuery.addEventListener) this.narrowQuery.addEventListener('change', applyLegend);
    legendBox.addEventListener('toggle', () => this.syncLegendScroll());
    // Two measurements the layout cannot make on its own, both of which move with the tissue, the
    // window and presentation mode: the sticky Run header's height (it becomes #panel's
    // scroll-padding, so Shift+Tab never parks focus behind it) and the room the stage leaves
    // under the HUD (the legend's cap).
    const measure = () => { this.measureRun(); this.layoutLegend(); };
    if (typeof ResizeObserver === 'function') {
      this.sizeObserver = new ResizeObserver(measure);
      for (const sel of ['.run', '#stage', '.hud-top']) { const el = document.querySelector(sel); if (el) this.sizeObserver.observe(el); }
    }
    window.addEventListener('resize', measure);
    measure();
    if (this.motionQuery && this.motionQuery.addEventListener) {
      this.motionQuery.addEventListener('change', (e) => {
        this.reducedMotion = e.matches;
        if (this.renderer && typeof this.renderer.setAutoRotate === 'function') this.renderer.setAutoRotate(!e.matches);
      });
    }
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /**
   * The sticky Run header's height, as the console's scroll-padding. Chrome scrolls a focused
   * element into view only when it is OUTSIDE the scrollport; one that is inside it but under the
   * opaque sticky header is left where it is, so Shift+Tab up the console used to leave four or
   * five controls focused and invisible (WCAG 2.4.11). The header is 241 px with four dials and
   * 197 px with seven, so it is measured rather than guessed.
   */
  measureRun() {
    const run = document.querySelector('.run'), panel = appEl('panel');
    if (!run || !panel) return;
    const h = Math.round(run.getBoundingClientRect().height);
    if (h > 0) panel.style.setProperty('--run-h', `${h + 8}px`);
  }

  /**
   * Where the legend may live (WCAG 1.4.4 Resize Text / 1.4.10 Reflow). The box is absolutely
   * positioned in the stage and opens UPWARD, while its old cap was computed from the VIEWPORT —
   * so at 200 % zoom, where the stage is 58vh of a 450 px-tall viewport, an open legend printed
   * itself over the title, the clock and the live sentence. Cap it against what the stage
   * actually leaves under the HUD; when that is less than can be read, move the whole disclosure
   * into the console, where it is an ordinary block and covers nothing.
   */
  layoutLegend() {
    const stage = appEl('stage'), hud = document.querySelector('.hud-top'), box = appEl('legend-box'), dock = appEl('legend-dock'), layers = appEl('layers');
    if (!stage || !hud || !box || !dock) return;
    const sr = stage.getBoundingClientRect(), hr = hud.getBoundingClientRect();
    const room = Math.round(sr.bottom - hr.bottom - 26);   // 16 px bottom offset + 10 px clear of the HUD
    const dockIt = !(room >= APP_LEGEND_MIN_H);
    if (dockIt !== this.legendDocked) {
      this.legendDocked = dockIt;
      document.body.classList.toggle('legend-docked', dockIt);
      dock.hidden = !dockIt;
      if (dockIt) dock.append(box);
      else if (layers) stage.insertBefore(box, layers); else stage.append(box);
    }
    if (dockIt) box.style.removeProperty('--legend-max');
    else box.style.setProperty('--legend-max', `${Math.max(0, room)}px`);
    this.syncLegendScroll();
  }
  /** A capped legend scrolls: give it a tab stop while it does, and none while it does not. */
  syncLegendScroll() { appScrollable(appEl('legend'), 'y'); }

  onKey(e) {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    const tag = el ? el.tagName : '';
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable) || (tag === 'INPUT' && !/^(range|radio|checkbox|button)$/.test(el.type));
    if (typing) return;
    const interactive = /^(BUTTON|A|SUMMARY|INPUT|SELECT|TEXTAREA)$/.test(tag);
    if (e.code === 'Space' || e.key === ' ') {
      if (interactive) return; // native activation (buttons, summary, checkbox) wins
      e.preventDefault(); this.togglePlay(); return;
    }
    // WCAG 2.1.4 Character Key Shortcuts: everything below is a single printable character, so it
    // is switchable (About → "Single-key shortcuts"). Space is not — it is the one key WCAG
    // exempts as a standard activation key, and it stays whatever the switch says.
    if (!this.shortcuts) return;
    const k = e.key.toLowerCase();
    if (k === 'p') { e.preventDefault(); this.setPresent(!this.present, true); return; }
    if (k === 'r') { e.preventDefault(); this.reset(); return; }
    if (k === 'i') { if (this.tissue && this.tissue.injury) { e.preventDefault(); this.injure(); } return; }
    if (/^[1-9]$/.test(e.key) && this.tissue) {
      const sc = this.tissue.scenarios[parseInt(e.key, 10) - 1];
      if (sc) { e.preventDefault(); this.loadScenario(sc.key); }
    }
  }

  /**
   * The single-key shortcuts on or off (WCAG 2.1.4), from the About toggle, remembered between
   * visits. Off, the page stops advertising them too: no aria-keyshortcuts, no kbd hints on the
   * scenario chips — a promise the page is no longer keeping is worse than no promise.
   */
  setShortcuts(on, fromUi) {
    this.shortcuts = !!on;
    if (fromUi) appLocal(APP_SHORTCUT_KEY, this.shortcuts ? '1' : '0');   // …else this is only a re-sync
    const b = appEl('opt-shortcuts');
    if (b) b.setAttribute('aria-pressed', String(this.shortcuts));
    for (const [id, key] of [['btn-reset', 'r'], ['btn-injure', 'i'], ['btn-present', 'p']]) {
      const el = appEl(id);
      if (el) { if (this.shortcuts) el.setAttribute('aria-keyshortcuts', key); else el.removeAttribute('aria-keyshortcuts'); }
    }
    if (this.tissue) this.tissue.scenarios.forEach((sc, i) => {
      const chip = this.scenarioButtons[sc.key];
      if (!chip || i >= 9) return;
      if (this.shortcuts) chip.setAttribute('aria-keyshortcuts', String(i + 1)); else chip.removeAttribute('aria-keyshortcuts');
      const kbd = chip.querySelector('kbd');
      if (kbd) kbd.hidden = !this.shortcuts;
    });
    if (fromUi) {
      this.announce(this.shortcuts
        ? 'Single-key shortcuts on: R resets, I injures, P is presentation mode, 1 to 9 pick a scenario.'
        : 'Single-key shortcuts off. Space still plays and pauses, and every control is still reachable with Tab.', true);
    }
  }

  // ---------- tissue ----------
  buildTissuePicker() {
    const box = appEl('tissue-picker'); box.replaceChildren();
    for (const key of Object.keys(TISSUES)) {
      const t = TISSUES[key];
      const input = appH('input', { type: 'radio', name: 'tissue', value: key, id: `tissue-${key}` });
      input.addEventListener('change', () => { if (input.checked && key !== this.tissueKey) this.setTissue(key); });
      box.append(appH('label', { class: 'seg', title: t.short || '' }, [input, appH('span', { text: t.name })]));
    }
  }

  setTissue(key, opts = {}) {
    const tissue = TISSUES[key];
    if (!tissue) return;
    const tok = this.focusToken();     // the dials, readouts and card below are all replaced
    this.setPlaying(false, true);
    this.tissueKey = key; this.tissue = tissue;
    const radio = appEl(`tissue-${key}`); if (radio) radio.checked = true;
    document.title = `Tissue Weather · ${tissue.name}`;
    appEl('tissue-name').textContent = tissue.name;
    appEl('tissue-short').textContent = tissue.short || '';
    this.layers = { fibers: true, cells: true, scaffold: true, gel: true, fields: {} };
    for (const f of tissue.fields || []) this.layers.fields[f.key] = false;
    this.dialValues = {};
    for (const d of tissue.dials) this.dialValues[d.key] = d.default;
    // the words this tissue's cells are described with (canvas description, table, sentence)
    this.cellStates = appCellStates(tissue);
    this.stateNoun = appStateNoun(this.cellStates);
    this.voc = Object.assign({ cellStateNoun: this.stateNoun.noun }, (tissue.copy && tissue.copy.vocabulary) || {});
    if (this.renderer && typeof this.renderer.setTissue === 'function') this.renderer.setTissue(tissue);
    this.buildDials(); this.buildScenarios(); this.buildReadouts(); this.buildLayers(); this.buildLegend(); this.buildAbout(); this.buildHint();
    this.restoreFocus(tok);
    this.measureRun();                 // a tissue with seven dials has a taller sticky header
    appEl('btn-injure').hidden = !tissue.injury;
    this.engine = null; this.stats = null; this.ready = false;
    this.warmDone = false; this.lastTrend = null; this.stopAt = null;
    this.busy(`preparing ${tissue.name}…`);
    const sc = tissue.scenarios.some((s) => s.key === opts.scenario) ? opts.scenario : tissue.scenarios[0].key;
    // let the overlay paint before the (possibly slow) engine construction
    setTimeout(() => {
      try { this.engine = new TissueEngine(tissue, { seed: APP_SEED }); }
      catch (e) { this.busy(null); this.showNotice('The simulation could not start', String(e && e.message || e)); return; }
      this.loadScenario(sc, { dials: opts.dials, ghost: false, autoplay: false });
    }, 30);
  }

  /**
   * Focus survival across a rebuild (WCAG 2.4.3). `replaceChildren` on the scenario card, and the
   * whole-console rebuild behind a tissue switch, dropped focus to the document body — from which
   * the next Tab restarts at the skip link, and a screen-reader user loses their place. Remember where
   * focus was, and afterwards put it on the same control, or on the container that replaced it.
   * Focus OUTSIDE the rebuilt regions (a scenario chip, the tissue radio) is left strictly alone,
   * so nothing here can move focus for a mouse user.
   */
  focusToken() {
    const el = document.activeElement;
    if (!el || !el.closest || el === document.body) return null;
    const box = el.closest('#scenario-card, #dials, #readouts, #layers');
    return box ? { id: el.id || '', box: box.id } : null;
  }
  restoreFocus(tok) {
    if (!tok) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;  // something else took it
    let el = tok.id ? appEl(tok.id) : null;                       // the same control, if the rebuild kept it
    const box = appEl(tok.box);
    if ((!el || !el.isConnected || el.offsetParent === null) && box) {
      el = box.hasAttribute('tabindex') ? box : box.querySelector('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
    }
    if (el && typeof el.focus === 'function') { try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); } }
  }

  scenario() { return this.tissue ? (this.tissue.scenarios.find((s) => s.key === this.scenarioKey) || this.tissue.scenarios[0]) : null; }
  scenarioTitle(key) { const s = this.tissue && this.tissue.scenarios.find((x) => x.key === key); return s ? s.title : key; }
  runDays() { return this.stats ? this.stats.t : 0; }

  // ---------- scenarios ----------
  buildScenarios() {
    const box = appEl('scenarios'); box.replaceChildren(); this.scenarioButtons = {};
    this.tissue.scenarios.forEach((sc, i) => {
      const b = appH('button', { class: 'scenario-btn', type: 'button', 'aria-pressed': 'false', title: sc.goal || '' }, [document.createTextNode(sc.title)]);
      if (i < 9) { b.setAttribute('aria-keyshortcuts', String(i + 1)); b.append(appH('kbd', { text: String(i + 1), 'aria-hidden': 'true' })); }
      b.addEventListener('click', () => this.loadScenario(sc.key));
      this.scenarioButtons[sc.key] = b; box.append(b);
    });
    this.setShortcuts(this.shortcuts, false);   // the new chips advertise the digits only if they work
  }

  renderScenarioCard(sc) {
    const card = appEl('scenario-card');
    const tok = this.focusToken();
    const from = sc.init && sc.init.from;
    const events = this.describeEvents(sc);
    const toggle = appH('button', {
      class: 'chip', type: 'button', id: 'btn-auto-events', 'aria-pressed': String(this.autoEvents),
      text: 'Auto-apply scripted events',
      title: 'Off: you move the dials yourself at the days listed above. On: the app applies them as the clock passes each day.',
      onclick: () => this.toggleAutoEvents(),
    });
    card.replaceChildren(
      appH('h3', { text: sc.title }),
      sc.goal ? appH('p', { class: 'goal', text: sc.goal }) : '',
      sc.steps && sc.steps.length ? appH('ol', {}, sc.steps.map((s) => appH('li', { text: s }))) : '',
      sc.question ? appH('p', { class: 'question', text: sc.question }) : '',
      sc.expect ? appH('details', {}, [appH('summary', { text: 'What should happen' }), appH('p', { text: sc.expect })]) : '',
      from ? appH('p', { class: 'note', text: `Starts from a matured tissue: “${this.scenarioTitle(from.scenario)}” pre-run for ${from.days} days.` }) : '',
      events ? appH('p', { class: 'note', id: 'events-note', text: this.eventsNote(events) }) : '',
      events ? appH('div', { class: 'tools-row' }, [toggle]) : '',
    );
    this.restoreFocus(tok);
  }

  eventsNote(events) {
    return this.autoEvents
      ? `Scripted protocol, applied for you as the clock passes each day: ${events}.`
      : `Reference run (headless checks): ${events}. Here you do it by hand.`;
  }

  /** Human-readable list of a scenario's scripted `events`. */
  describeEvents(sc) {
    if (!sc || !Array.isArray(sc.events) || !sc.events.length) return '';
    return sc.events.map((ev) => `day ${ev.at}: ${this.describeEvent(ev, 'set ') || 'event'}`).join('; ');
  }

  /** One scripted event as words: "set growth-factor bath to 0.20, injure". */
  describeEvent(ev, verb = '') {
    const parts = [];
    if (ev.dials) {
      for (const [k, v] of Object.entries(ev.dials)) {
        const d = this.tissue.dials.find((x) => x.key === k);
        parts.push(`${verb}${d ? appLowerFirst(d.label) : k} to ${d ? appFormatDial(d, v) : v}`);
      }
    }
    if (ev.injure) parts.push('injure');
    return parts.join(', ');
  }

  // ---------- scripted events (opt-in) ----------
  toggleAutoEvents(on) {
    this.autoEvents = on === undefined ? !this.autoEvents : !!on;
    appSession(APP_EVENTS_KEY, this.autoEvents ? '1' : '0');
    const b = appEl('btn-auto-events');
    if (b) b.setAttribute('aria-pressed', String(this.autoEvents));
    const events = this.describeEvents(this.scenario());
    const note = appEl('events-note');
    if (note && events) note.textContent = this.eventsNote(events);
    if (!this.autoEvents) { this.flash('Auto-apply off: move the dials yourself, as the steps ask.'); return; }
    const skipped = this.skipPastEvents();
    const left = this.pendingEvents.length - this.eventIdx;
    if (left > 0) {
      this.flash(`Auto-apply on: ${left} scripted event${left > 1 ? 's' : ''} left, the next on day ${this.pendingEvents[this.eventIdx].at}.${skipped ? ` ${skipped} already passed — Reset to run the protocol from day 0.` : ''}`);
    } else if (this.pendingEvents.length) {
      this.flash('Auto-apply on, but every scripted event of this run has already passed. Reset to run the protocol from day 0.');
    } else {
      this.flash('Auto-apply on. This scenario has no scripted events.');
    }
  }

  nextEvent() { return this.eventIdx < this.pendingEvents.length ? this.pendingEvents[this.eventIdx] : null; }

  /** Skip the events whose day is already behind the clock (turning the toggle on mid-run). */
  skipPastEvents() {
    const t = this.engine ? this.engine.time : 0;
    let skipped = 0;
    while (this.eventIdx < this.pendingEvents.length && this.pendingEvents[this.eventIdx].at < t - 1e-9) { this.eventIdx++; skipped++; }
    return skipped;
  }

  /** Apply one scripted event: dials through the engine (and the dial UI), injure through the engine. */
  applyEvent(ev) {
    this.eventIdx++;
    const parts = [];
    if (ev.dials) {
      const d = this.validDials(ev.dials);
      if (Object.keys(d).length) { this.engine.setDials(d); this.syncDialsFromEngine(); }
      parts.push(this.describeEvent({ dials: ev.dials }, 'set '));
    }
    if (ev.injure) {
      if (this.tissue.injury) { this.engine.injure((ev.injure && ev.injure.center) || null, ev.injure && ev.injure.radius); parts.push('wound inflicted'); }
      else parts.push('injury skipped (this tissue has none)');
    }
    // scripted events earn a mark on the time axis too — the protocol should be visible in the
    // chart, not only in the card (C11)
    this.markPlots(parts.filter(Boolean).join('; ') || 'scripted event', `event:${ev.at}`);
    this.flash(`Day ${ev.at}, scripted: ${parts.filter(Boolean).join('; ') || 'event applied'}.`);
    this.scheduleUrl();
  }

  loadScenario(key, o = {}) {
    const tissue = this.tissue;
    if (!tissue || !this.engine) return;
    const sc = tissue.scenarios.find((s) => s.key === key) || tissue.scenarios[0];
    this.scenarioKey = sc.key;
    for (const [k, b] of Object.entries(this.scenarioButtons)) b.setAttribute('aria-pressed', String(k === sc.key));
    this.renderScenarioCard(sc);
    appEl('scenario-name').textContent = sc.title;
    const wasPlaying = this.playing;
    this.setPlaying(false, true);
    // ghost traces: keep the run that just ended (if it went anywhere) as dashed reference lines
    if (o.ghost === false) this.clearReference(false);
    else if (this.runDays() >= APP_GHOST_MIN_DAYS) { for (const p of this.plots) p.plot.setReference(); this.syncReferenceUI(); }
    const from = sc.init && sc.init.from;
    const busyText = from ? `pre-running “${this.scenarioTitle(from.scenario)}” for ${from.days} days…` : 'preparing tissue…';
    this.busy(busyText);
    if (from) this.flash(busyText);
    this.ready = false;
    setTimeout(() => {
      this.engine.reset(sc.key);
      this.pendingEvents = (Array.isArray(sc.events) ? sc.events.slice() : []).sort((a, b) => (a.at || 0) - (b.at || 0));
      this.eventIdx = 0;
      if (o.dials) { const d = this.validDials(o.dials); if (Object.keys(d).length) this.engine.setDials(d); }
      this.syncDialsFromEngine();
      const st = this.engine.state;
      this.dt = (st && st.dt) || (tissue.engine && tissue.engine.dt) || 0.02;
      for (const p of this.plots) p.plot.clear();
      this.exportFrames = []; this.nextExportT = 0; this.accum = 0;
      this.captureExport();
      this.busy(null);
      this.ready = true;
      this.flashUntil = 0;
      this.lastTrend = null;
      this.stopAt = null;
      this.sample(true, performance.now());
      // A scenario swap is silent on screen apart from the card, so it says which one loaded (C3).
      // The resume BELOW used to be the last word: setPlaying's own "Playing at N days per second"
      // overwrote #status in the same task, so switching scenario or pressing Reset while the
      // clock ran never reached a screen reader. The resume is quiet now and the play state is
      // part of this one sentence instead.
      // No programmatic focus move — loadScenario also runs on page load and on a radio change.
      const resume = o.autoplay === undefined ? wasPlaying : o.autoplay;
      const said = o.flash || `Scenario “${sc.title}” loaded, day 0. ${sc.goal ? appFirstSentence(sc.goal) : ''}`.trim();
      const withState = resume ? `${said} Still running at ${this.speed} simulated days per second.` : said;
      if (o.flash) this.flash(withState); else this.announce(withState, true);
      this.setPlaying(resume, true);
      this.scheduleUrl();
    }, 30);
  }

  validDials(partial) {
    const out = {};
    for (const d of this.tissue.dials) {
      const v = partial[d.key];
      if (Number.isFinite(v)) out[d.key] = appClamp(v, d.min, d.max);
    }
    return out;
  }

  reset() {
    if (!this.engine || !this.ready) return;
    const sc = this.scenario();
    const ghost = this.runDays() >= APP_GHOST_MIN_DAYS;
    this.loadScenario(this.scenarioKey, { flash: ghost ? `Reset: “${sc.title}” restarted from day 0. The previous run stays as dashed lines for comparison.` : `Reset: “${sc.title}” restarted from day 0.` });
  }

  injure() {
    if (!this.engine || !this.ready || !this.tissue.injury) return;
    this.engine.injure();
    this.markPlots('injury', 'injure');
    this.sample(true, performance.now());
    this.flash((this.tissue.injury && this.tissue.injury.flash) || 'Wound inflicted. Watch the hole refill.');
  }

  // ---------- dials ----------
  buildDials() {
    const box = appEl('dials'); box.replaceChildren(); this.dialInputs = {}; this.dialOutputs = {};
    for (const d of this.tissue.dials) {
      const id = `dial-${d.key}`;
      const txt = appFormatDial(d, d.default);
      const input = appH('input', { type: 'range', id, min: d.min, max: d.max, step: d.step, value: d.default, 'aria-valuetext': txt, 'aria-describedby': `${id}-hint` });
      // <output> maps to role=status, i.e. an implicit polite live region: without aria-live="off"
      // one drag of this slider queues ~40 announcements on top of the value the slider itself
      // already speaks, and the page has six or nine live regions instead of the one it claims.
      const out = appH('output', { for: id, 'aria-live': 'off', text: txt });
      input.addEventListener('input', () => this.setDial(d.key, parseFloat(input.value), 'ui'));
      const m = String(d.metaphor || '');
      const ci = m.indexOf(':');
      const tag = (ci > 0 ? m.slice(0, ci) : m).toLowerCase();
      const rest = ci > 0 ? m.slice(ci + 1).trim() : '';
      // The biology line stays visible: it is what aria-describedby points at, and it is the
      // sentence a student needs while moving the slider. The metaphor and the "Watch:" line
      // fold into a details (C8) — seven cartilage dials with three lines each pushed Play and
      // the readouts more than a screen below the fold.
      const hint = appH('div', { class: 'hint', id: `${id}-hint` }, [d.biology ? appH('span', { text: d.biology }) : '']);
      // the summary text is the same three words on every dial: four (seven, for cartilage)
      // identically named disclosures in a row in a screen reader's elements list. The dial's own
      // label goes in front of it in the accessible name — the visible words are kept verbatim,
      // so the name still contains the label a voice user would say (WCAG 2.5.3).
      const summaryText = rest && d.watch ? 'Metaphor & what to watch' : (rest ? 'Metaphor' : 'What to watch');
      const more = (rest || d.watch) ? appH('details', { class: 'dial-more' }, [
        appH('summary', { text: summaryText, 'aria-label': `${appShortLabel(d.label)}: ${summaryText}` }),
        rest ? appH('p', { class: 'metaphor-note', text: `Like ${tag}: ${rest}` }) : '',
        d.watch ? appH('p', {}, [appH('b', { text: 'Watch: ' }), document.createTextNode(d.watch)]) : '',
      ]) : '';
      box.append(appH('div', { class: 'dial' }, [
        // the metaphor tag is decoration inside the label; without aria-hidden the slider is
        // announced as "Growth-factor bath humidity" (C5)
        appH('label', { for: id }, [document.createTextNode(d.label), tag ? appH('span', { class: 'metaphor', 'aria-hidden': 'true', text: tag }) : '']),
        out, input, hint, more,
      ]));
      this.dialInputs[d.key] = input; this.dialOutputs[d.key] = out;
    }
  }

  setDial(key, v, source) {
    const d = this.tissue && this.tissue.dials.find((x) => x.key === key);
    if (!d || !Number.isFinite(v)) return;
    v = appClamp(v, d.min, d.max);
    this.dialValues[key] = v;
    const txt = appFormatDial(d, v);
    const input = this.dialInputs[key];
    if (input) { if (source !== 'ui') input.value = v; input.setAttribute('aria-valuetext', txt); }
    if (this.dialOutputs[key]) this.dialOutputs[key].textContent = txt;
    if (this.engine) this.engine.setDials({ [key]: v });
    // a dashed rule with a letter on the time axis, so "what did I change, and when?" is
    // answerable from the chart (C11). Debounced in plots.js on SIMULATED time: a slider drag
    // is one mark, not thirty.
    if (this.ready && this.engine) this.markPlots(`${appShortLabel(d.label)} → ${txt}`, `dial:${key}`);
    this.scheduleUrl();
  }

  /** Put the same mark on every chart (the time axis is shared). */
  markPlots(label, key) {
    if (!this.engine) return;
    const t = this.engine.time;
    for (const p of this.plots) p.plot.mark(t, label, key);
  }

  syncDialsFromEngine() {
    const st = this.engine.state;
    const dials = (st && st.dials) || {};
    for (const d of this.tissue.dials) {
      const v = Number.isFinite(dials[d.key]) ? dials[d.key] : d.default;
      this.dialValues[d.key] = v;
      const txt = appFormatDial(d, v);
      this.dialInputs[d.key].value = v;
      this.dialInputs[d.key].setAttribute('aria-valuetext', txt);
      this.dialOutputs[d.key].textContent = txt;
    }
  }

  // ---------- readouts ----------
  buildReadouts() {
    const box = appEl('readouts'); box.replaceChildren();
    for (const p of this.plots) p.plot.dispose();
    if (this.gauge) this.gauge.dispose();
    this.plots = []; this.gauge = null; this.gaugeVal = null;
    const fontPx = this.present ? APP_PRESENT_FONT : 11;
    // the flux gauge answers "which way is it going?" and is the readout the scenarios point
    // at first, so it goes at the top of the section (C8); everything else keeps its order
    const ordered = (this.tissue.readouts || []).slice().sort((a, b) => (a.type === 'flux' ? 0 : 1) - (b.type === 'flux' ? 0 : 1));
    for (const r of ordered) {
      const val = appH('span', { class: 'val' });
      const head = appH('div', { class: 'head' }, [appH('h3', { text: r.label }), val]);
      const meaning = (r.unit || r.meaning) ? appH('p', { class: 'meaning' }, [r.unit ? appH('span', { class: 'unit', text: r.unit }) : '', r.unit && r.meaning ? document.createTextNode(' — ') : '', r.meaning ? document.createTextNode(r.meaning) : '']) : '';
      if (r.type === 'flux') {
        const canvas = appH('canvas', { role: 'img', 'aria-label': `${r.label} gauge; the same rates are written beside the title and in the values table` });
        box.append(appH('div', { class: 'readout gauge' }, [head, meaning, canvas]));
        // the tissue's own words for the gauge (docs/EXTENDING.md §1 `copy.gauge`), else the weather ones
        const gaugeCopy = (this.tissue.copy && this.tissue.copy.gauge) || {};
        this.gauge = new FluxGauge(canvas, APP_THEME, Object.assign({ scaffold: this.scaffoldNoun() }, gaugeCopy, { fontPx }));
        this.gaugeVal = val;
        continue;
      }
      const stack = r.type === 'stack';
      const isLog = r.type === 'log';
      // marker shapes and (for the top band of a stack) a hatch make a pair of luminance twins
      // readable without colour (B5); a definition may set `marker` / `pattern` itself,
      // `pattern: 'none'` opts a band out.
      const declaresPattern = (r.series || []).some((x) => x.pattern);
      const nStacked = stack ? (r.series || []).length : 0;
      const series = (r.series || []).map((s, i) => ({
        key: s.stat, label: s.label, color: s.color, stack,
        marker: s.marker || APP_MARKERS[i % APP_MARKERS.length],
        pattern: s.pattern === 'none' ? null : (s.pattern || (stack && !declaresPattern && nStacked > 1 && i === nStacked - 1 ? 'hatch' : null)),
      }));
      const yDomain = Array.isArray(r.domain) ? r.domain : (isLog ? [-1, 2.5] : [0, 1]);
      const yFormat = isLog ? (v) => appPow10(v) : (v) => v.toFixed(2);
      const canvas = appH('canvas', {
        role: 'img', tabindex: '0', 'aria-describedby': 'chart-keys-hint',
        'aria-label': `${r.label} chart over the last 90 days; focus it and use the arrow keys to read day by day`,
      });
      // `background-color`, not the `background` shorthand: the shorthand resets background-image
      // to none, and an inline declaration outranks any selector, so the hatch rule in index.html
      // never applied — the chart drew a hatched band the key beside it did not (B5).
      const keys = appH('div', { class: 'keys' }, series.length > 1 ? series.map((s) => appH('span', {}, [
        appH('i', { class: `key-mark ${s.marker}${s.pattern === 'hatch' ? ' hatch' : ''}`, style: `background-color:${s.color}` }), document.createTextNode(s.label),
      ])) : []);
      const ghostKey = appH('span', { class: 'ghost-key', hidden: true }, [appH('i', { class: 'dash' }), document.createTextNode('previous run (dashed)')]);
      keys.append(ghostKey);
      box.append(appH('div', { class: 'readout' }, [head, meaning, canvas, keys]));
      const plot = new TimeSeriesPlot(canvas, {
        series, yDomain, yFormat, windowDays: 90, theme: APP_THEME, fontPx,
        onHover: (lines, i, source) => this.onPlotHover(r, lines, source),
      });
      this.plots.push({ readout: r, plot, val, ghostKey, isLog, unitWord: (r.unit || '').split(/[\s(]/)[0] });
    }
    this.buildTable();
    this.syncReferenceUI();
  }

  /**
   * The keyboard crosshair speaks: mirror the tooltip into the status region (C4) — but only once
   * the key comes to rest. Auto-repeat delivers ~30 keydowns a second and each one moved the
   * crosshair one sample, so a held arrow rewrote the polite region 30 times a second with a
   * four-to-six-line reading: a reader that queues rather than coalesces would still be talking
   * long after the key was released.
   */
  onPlotHover(readout, lines, source) {
    if (source !== 'key' || !lines || !lines.length) return;
    const text = `${readout.label}, ${lines.join(', ')}`;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => this.announce(text, true), APP_HOVER_SAY_MS);
  }

  /** What the third flux bar and its table row are called: the tissue's word, else a neutral one. */
  scaffoldNoun() { return this.voc.scaffoldNoun || 'scaffold dissolving'; }

  readoutValueText(p) {
    const r = p.readout, ser = p.plot.spec.series, v = this.values;
    if (!ser.length) return '';
    if (r.type === 'stack') {
      const sum = ser.reduce((a, s) => a + (v[s.key] || 0), 0);
      const last = ser[ser.length - 1];
      const pct = sum > 1e-6 ? Math.round(100 * (v[last.key] || 0) / sum) : 0;
      return ser.length > 1 ? `${sum.toFixed(2)} total · ${pct} % ${last.label}` : sum.toFixed(2);
    }
    if (p.isLog) return ser.map((s) => `${appPow10(v[s.key] || 0)} ${p.unitWord}`.trim()).join(' · ');
    return ser.map((s) => `${s.label} ${(v[s.key] || 0).toFixed(2)}`).join(' · ');
  }

  // Values table: one row per series, the flux rates, the totals and the cell states the
  // charts do not already show. Built once per tissue, values updated in place; a row whose
  // getter returns null (a stat this engine does not provide) hides itself.
  buildTable() {
    const box = appEl('stats-table'); box.replaceChildren(); this.tableCells = [];
    const tbody = appH('tbody');
    const row = (group, label, unit, getter) => {
      const td = appH('td', { class: 'num', text: '–' });
      const tr = appH('tr', {}, [appH('td', { text: group }), appH('th', { scope: 'row', text: label }), td, appH('td', { text: unit })]);
      tbody.append(tr);
      this.tableCells.push({ tr, td, getter });
    };
    const num = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : null);
    const plotted = new Set();
    for (const p of this.plots) {
      for (const s of p.plot.spec.series) {
        plotted.add(s.key);
        const def = (p.readout.series || []).find((x) => x.stat === s.key) || {};
        row(p.readout.label, s.label, p.isLog ? p.unitWord : (def.unit || p.readout.unit || ''), () => {
          const v = this.values[s.key];
          if (!Number.isFinite(v)) return '–';
          return p.isLog ? appPow10(v) : v.toFixed(3);
        });
      }
    }
    const flux = (this.tissue.readouts || []).find((r) => r.type === 'flux');
    const fluxLabel = flux ? flux.label : 'Flux';
    row(fluxLabel, 'deposition', 'density per day', () => (this.stats ? copyFormatRate(this.stats.deposition) : '–'));
    row(fluxLabel, 'degradation', 'density per day', () => (this.stats ? copyFormatRate(this.stats.degradation) : '–'));
    row(fluxLabel, 'deposition / degradation', 'ratio', () => { const s = this.stats; if (!s) return '–'; const r = (s.deposition + 1e-9) / (s.degradation + 1e-9); return r > 99 ? '>99' : r.toFixed(2); });
    // engine extras: shown only once (and while) the engine reports them
    row(fluxLabel, this.scaffoldNoun(), 'density per day', () => { const v = this.stats && this.stats.scaffoldFlux; return Number.isFinite(v) && v > 0 ? copyFormatRate(v) : null; });
    row(fluxLabel, 'deposited since reset', 'density', () => num(this.stats && this.stats.cumDeposition));
    row(fluxLabel, 'degraded since reset', 'density', () => num(this.stats && this.stats.cumDegradation));
    // totals and the cells themselves, in this tissue's own words
    const sp = () => (this.stats && this.stats.species) || null;
    row('Tissue', 'all species', 'relative density', () => num(sp() ? sp().total : NaN));
    row('Tissue', 'matrix without the scaffold', 'relative density', () => num(sp() ? sp().tissueTotal : NaN));
    const cellGroup = 'Cells';
    row(cellGroup, 'number', 'cells', () => { const c = this.stats && this.stats.cells; return c && Number.isFinite(c.n) ? String(c.n) : null; });
    for (const st of this.cellStates) {
      const key = `cells.${st.key}`;
      if (plotted.has(key)) continue;                       // already a charted series
      const range = st.range ? `${st.range[0]}–${st.range[1]}` : '0–1';
      row(cellGroup, st.label, `${range} (mean over cells)`, () => num(this.stats && this.stats.cells ? this.stats.cells[st.key] : NaN));
    }
    this.tableCaption = appH('caption', { text: 'Latest values' });
    box.append(appH('table', {}, [
      this.tableCaption,
      appH('thead', {}, [appH('tr', {}, [appH('th', { scope: 'col', text: 'Readout' }), appH('th', { scope: 'col', text: 'Series' }), appH('th', { scope: 'col', text: 'Value' }), appH('th', { scope: 'col', text: 'Unit' })])]),
      tbody,
    ]));
    // the last five days as numbers (C4): a chart is a picture, and "is it still rising?" needs
    // more than the latest value. Filled only while the details is open.
    // The box scrolls sideways (434 px of columns in a 355 px console), so it is a NAMED region
    // and — while it actually overflows — a tab stop: without one, the last day is unreachable
    // for a keyboard user in Firefox and Safari (WCAG 2.1.1, axe scrollable-region-focusable).
    this.historyOut = appH('div', { class: 'history-out', role: 'region', tabindex: '-1', 'aria-label': 'Last five days, scroll sideways for the later days' });
    this.historyBox = appH('details', { class: 'history' }, [appH('summary', { text: 'Last five days as a table' }), this.historyOut]);
    this.historyBox.addEventListener('toggle', () => this.renderHistory());
    box.append(this.historyBox);
  }

  /**
   * One row per plotted series, one column per whole day over the last five (nearest sample).
   * Reads the plots' own buffers, so it needs no extra history and always agrees with the charts.
   */
  renderHistory() {
    const box = this.historyBox, out = this.historyOut;
    if (!box || !out || !box.open || !this.plots.length) return;
    const t = this.plots[0].plot.t;
    if (!t.length) { out.replaceChildren(appH('p', { class: 'note', text: 'Nothing recorded yet — press Play.' })); return; }
    const end = Math.floor(t[t.length - 1]);
    const days = [];
    for (let d = Math.max(Math.ceil(t[0]), end - 4); d <= end; d++) days.push(d);
    if (!days.length) days.push(end);
    // one pass over each plot's time buffer picks the sample nearest each day; every series of
    // that plot then reads the same indices
    const rows = [];
    for (const p of this.plots) {
      const T = p.plot.t;
      const idx = days.map((d) => {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < T.length; i++) { const dd = Math.abs(T[i] - d); if (dd < bestD) { bestD = dd; best = i; } }
        return bestD <= 0.75 ? best : -1;
      });
      for (const ser of p.plot.spec.series) {
        const cells = idx.map((i) => {
          const v = i < 0 ? NaN : p.plot.data[ser.key][i];
          return appH('td', { class: 'num', text: Number.isFinite(v) ? (p.isLog ? appPow10(v) : v.toFixed(3)) : '–' });
        });
        rows.push(appH('tr', {}, [appH('th', { scope: 'row', text: `${p.readout.label} · ${ser.label}` }), ...cells]));
      }
    }
    out.replaceChildren(appH('table', {}, [
      appH('caption', { text: `Days ${days[0]} to ${days[days.length - 1]}` }),
      appH('thead', {}, [appH('tr', {}, [appH('th', { scope: 'col', text: 'Series' }), ...days.map((d) => appH('th', { scope: 'col', text: `d ${d}` }))])]),
      appH('tbody', {}, rows),
    ]));
    appScrollable(out, 'x');
  }
  renderTable(now) {
    this.lastTableAt = now;
    appScrollable(appEl('stats-table'), 'x');
    if (this.stats) this.tableCaption.textContent = `Latest values, day ${this.stats.t.toFixed(1)}`;
    for (const c of this.tableCells) {
      const v = c.getter();
      c.tr.hidden = v == null;                 // a stat this engine does not report
      c.td.textContent = v == null ? '–' : v;
    }
  }
  toggleTable() {
    this.tableOn = !this.tableOn;
    appEl('btn-table').setAttribute('aria-pressed', String(this.tableOn));
    appEl('stats-table').hidden = !this.tableOn;
    if (this.tableOn) { this.renderTable(performance.now()); this.renderHistory(); }
    this.announce(this.tableOn ? 'Values table shown under the readouts.' : 'Values table hidden.', true);
  }

  // ghost traces
  clearReference(announce) {
    for (const p of this.plots) p.plot.clearReference();
    this.syncReferenceUI();
    for (const p of this.plots) p.plot.draw();
    if (announce) this.flash('Comparison cleared. The next Reset will keep the current run as dashed lines.');
  }
  syncReferenceUI() {
    let any = false;
    for (const p of this.plots) { const has = p.plot.hasReference(); p.ghostKey.hidden = !has; any = any || has; }
    appEl('btn-clear-ref').hidden = !any;
  }

  // ---------- layers, legend, about ----------
  buildLayers() {
    const box = appEl('layers'); box.replaceChildren(); this.layerButtons = {};
    const t = this.tissue;
    // a visible word in front of the chip row: "show fibers cells …" reads as a control, a bare
    // row of pills reads as decoration (C13). The group already carries an aria-label.
    box.append(appH('span', { class: 'chips-label', 'aria-hidden': 'true', text: 'show' }));
    const items = [['fibers', 'fibers'], ['cells', 'cells']];
    const gel = (t.species || []).filter((s) => s.kind === 'gel');
    const scaffold = (t.species || []).filter((s) => s.kind === 'scaffold');
    if (gel.length) items.push(['gel', gel.length === 1 ? appShortLabel(gel[0].label) : 'gel']);
    if (scaffold.length) items.push(['scaffold', scaffold.length === 1 ? appShortLabel(scaffold[0].label) : 'scaffold']);
    for (const f of t.fields || []) items.push([`field:${f.key}`, appShortLabel(f.label)]);
    for (const [id, label] of items) {
      const isField = id.startsWith('field:');
      const fkey = id.slice(6);
      const get = () => (isField ? !!this.layers.fields[fkey] : this.layers[id] !== false);
      const b = appH('button', { class: 'chip', type: 'button', 'aria-pressed': String(get()), text: label, title: `Show or hide ${label}` });
      b.addEventListener('click', () => {
        if (isField) this.layers.fields[fkey] = !this.layers.fields[fkey]; else this.layers[id] = !get();
        b.setAttribute('aria-pressed', String(get()));
      });
      this.layerButtons[id] = b; box.append(b);
    }
    // auto-rotate is motion the viewer did not ask for: give it a stop control (B3, WCAG 2.2.2)
    const rot = appH('button', {
      class: 'chip', type: 'button', id: 'btn-rotate', 'aria-pressed': String(this.autoRotate), text: 'auto-rotate',
      title: 'Turn the slow automatic rotation of the 3D view on or off (?rotate=0 starts with it off)',
    });
    rot.addEventListener('click', () => this.setAutoRotate(!this.autoRotate, true));
    this.layerButtons['auto-rotate'] = rot; box.append(rot);
    this.buildCamera();
  }

  /**
   * Orbit, zoom and recentre without dragging: the single-pointer alternative to the drag gesture
   * the 3D view otherwise needs (WCAG 2.5.7 Dragging Movements), and the same moves the arrow
   * keys make on the focused canvas. Rebuilt whenever the layer row is, and again once the
   * renderer has loaded (initRenderer), because until then there is nothing to drive.
   */
  buildCamera() {
    const box = appEl('layers');
    if (!box) return;
    const old = box.querySelector('.cam-group');
    if (old) old.remove();
    const r = this.renderer;
    const items = APP_CAMERA.filter(([, , , method]) => r && typeof r[method] === 'function');
    if (!items.length) return;
    const row = appH('div', { class: 'cam-group', role: 'group', 'aria-label': '3D camera' });
    for (const [id, glyph, name, method, args] of items) {
      const b = appH('button', {
        class: 'chip', type: 'button', id: `btn-${id}`, 'aria-label': name,
        title: `${name}. With the 3D view focused the arrow keys, + and − and Home do the same.`,
      }, [appH('span', { 'aria-hidden': 'true', text: glyph })]);
      b.addEventListener('click', () => {
        // a move the viewer asked for beats the rotation they did not: stop auto-rotate first,
        // exactly as a drag or an arrow key on the canvas does
        if (this.autoRotate) this.setAutoRotate(false, true);
        try { this.renderer[method](...args(APP_CAMERA_STEP)); } catch (e) { /* renderer torn down */ }
      });
      row.append(b);
    }
    box.append(row);
  }

  /** Auto-rotate, from the chip or from the renderer (a drag or a key press stops it). */
  setAutoRotate(on, fromUi) {
    const was = this.autoRotate;
    this.autoRotate = !!on;
    const b = this.layerButtons['auto-rotate'];
    if (b) b.setAttribute('aria-pressed', String(this.autoRotate));
    if (fromUi && this.renderer && typeof this.renderer.setAutoRotate === 'function') this.renderer.setAutoRotate(this.autoRotate);
    if (fromUi) this.scheduleUrl();
    // a state change nobody asked for out loud: dragging or an arrow key on the canvas stops the
    // rotation, and the chip's aria-pressed flips silently. Say it once.
    else if (was && !this.autoRotate) this.announce('Automatic rotation stopped. The auto-rotate chip under the view turns it back on.', true);
  }

  defaultSwatches() {
    const t = this.tissue, out = [];
    for (const s of t.species || []) out.push({ label: s.label, css: s.color });
    for (const c of t.cellTypes || []) out.push({ label: c.label, css: c.colors && c.colors.length > 1 ? `linear-gradient(90deg, ${c.colors[0]}, ${c.colors[1]})` : (c.colors && c.colors[0]) || '#888' });
    for (const f of t.fields || []) out.push({ label: f.label, css: f.color });
    return out;
  }

  buildLegend() {
    const box = appEl('legend'); box.replaceChildren();
    const t = this.tissue; if (!t) return;
    let sw = null;
    if (this.renderer && typeof this.renderer.legendSwatches === 'function') { try { sw = this.renderer.legendSwatches(); } catch (e) { sw = null; } }
    if (!Array.isArray(sw) || !sw.length) sw = this.defaultSwatches();
    const rows = sw.map((s) => appH('li', { class: 'legend-row' }, [appH('span', { class: 'swatch', style: `background:${s.css}` }), appH('span', { text: s.label })]));
    // optional scale cue (C13): a definition that knows how big its cube is says so
    const um = Number(t.domainMicrons);
    if (Number.isFinite(um) && um > 0) rows.push(appH('li', { class: 'legend-row legend-scale' }, [appH('span', { class: 'swatch scale-swatch', 'aria-hidden': 'true' }), appH('span', { text: `Cube edge ≈ ${um >= 1000 ? `${(um / 1000).toFixed(um % 1000 ? 1 : 0)} mm` : `${Math.round(um)} µm`}` })]));
    // the legend is capped against the stage and scrolls inside that cap (layoutLegend), so it
    // needs a name and — while it actually scrolls — a tab stop of its own
    box.setAttribute('aria-label', 'Colour key and how to read the view');
    box.append(appH('ul', { class: 'legend-swatches', 'aria-label': 'Colour key' }, rows));
    // "How to read the view": every string the definition put in copy.legend, in its own
    // order — fibers, cells, scaffold, gel, load and each key under `fields` — not a fixed
    // set (the cartilage scaffold and gel lines were dropped by the old fixed list).
    const lg = (t.copy && t.copy.legend) || {};
    const hasLoad = (t.dials || []).some((d) => d.role === 'load');
    const guide = [];
    const addGuide = (v) => { if (typeof v === 'string' && v.trim()) guide.push(v); };
    for (const [key, value] of Object.entries(lg)) {
      if (key === 'load' && !hasLoad) continue;             // no load dial: no arrows to explain
      if (typeof value === 'string') addGuide(value);
      else if (value && typeof value === 'object') for (const inner of Object.values(value)) addGuide(inner);
    }
    if (guide.length) {
      box.append(appH('details', { class: 'legend-guide' }, [appH('summary', { text: 'How to read the view' }), appH('ul', {}, guide.map((g) => appH('li', { text: g })))]));
    }
    this.layoutLegend();
  }

  /**
   * The first-run hint (C13). Everything a newcomer needs to know before pressing Play, in the
   * panel rather than behind a closed About at its bottom: the tissue's own opening sentences,
   * one line about the controls, and a button that opens About where the rest of it lives.
   * Hidden for good once the clock has run (setPlaying) or when the student dismisses it.
   */
  buildHint() {
    const box = appEl('hint');
    if (!box) return;
    const dismiss = appEl('hint-dismiss');
    const intro = (this.tissue.copy && this.tissue.copy.intro) || {};
    const first = (Array.isArray(intro.paragraphs) && intro.paragraphs[0]) || this.tissue.short || '';
    // the opening sentences of the tissue's own intro: enough to say what the cube is
    // (no lookbehind: it is a parse-time error in older Safari, which would take the module with it)
    const sentences = String(first).match(/[^.!?]+[.!?]+\s*/g) || [String(first)];
    const opener = sentences.slice(0, 2).join('').trim();
    const body = appH('div', { class: 'hint-body' }, [
      appH('p', {}, [appH('b', { text: 'First time here? ' }), document.createTextNode(opener)]),
      appH('p', { class: 'hint-controls', text: APP_HINT_CONTROLS }),
      appH('p', { class: 'hint-tools' }, [appH('button', {
        type: 'button', id: 'btn-what', class: 'linkish', text: 'What am I looking at?',
        title: 'Open the About section: what the model is, where the metaphor breaks, the keyboard map',
        onclick: () => this.openAbout(),
      })]),
    ]);
    box.replaceChildren(body, dismiss || '');
    // "Got it" means got it: this is re-derived on every tissue switch, so without the flag the
    // card came back the moment the student tried the second tissue
    box.hidden = this.hasPlayed || this.hintDismissed;
  }

  /** Open the About details and put it in view (the hint's "What am I looking at?" button). */
  openAbout() {
    const ab = appEl('about');
    if (!ab) return;
    ab.open = true;
    const sum = ab.querySelector('summary');
    if (sum && typeof sum.scrollIntoView === 'function') sum.scrollIntoView({ block: 'nearest' });
    if (sum && typeof sum.focus === 'function') sum.focus();
  }

  buildAbout() {
    const ab = appEl('about-body'); ab.replaceChildren();
    const t = this.tissue, c = t.copy || {}, intro = c.intro || {};
    ab.append(appH('p', { class: 'tagline', text: intro.tagline || t.short || '' }));
    for (const p of intro.paragraphs || []) ab.append(appH('p', { text: p }));
    if (Array.isArray(c.metaphorBreaks) && c.metaphorBreaks.length) {
      ab.append(appH('h3', { text: 'Where the cloud metaphor breaks' }));
      const dl = appH('dl');
      for (const mb of c.metaphorBreaks) { dl.append(appH('dt', { text: mb.claim })); dl.append(appH('dd', { text: mb.reality })); }
      ab.append(dl);
    }
    ab.append(appH('h3', { text: 'Keyboard' }));
    ab.append(appH('ul', { class: 'keys-list' }, APP_KEYS.map(([k, what]) => appH('li', {}, [appH('kbd', { text: k }), document.createTextNode(` ${what}`)]))));
    // WCAG 2.1.4 asks for a way to turn single-character shortcuts off (dictation puts every
    // spoken letter through as a keystroke: with focus on the page, an "r" restarts the run).
    // Space is a standard activation key and is never gated.
    const shortcutChip = appH('button', {
      type: 'button', class: 'chip', id: 'opt-shortcuts', 'aria-pressed': String(this.shortcuts),
      text: 'Single-key shortcuts',
      title: 'R, I, P and 1–9. Turn them off if you use dictation or a switch that sends letters. Space always plays and pauses.',
      onclick: () => this.setShortcuts(!this.shortcuts, true),
    });
    ab.append(appH('p', { class: 'note' }, [shortcutChip]));
    ab.append(appH('p', { class: 'note', text: 'The single letters and digits above work while nothing is being typed into. Turn them off with the button and only Space, Tab and the arrow keys on a focused control stay.' }));
    ab.append(appH('p', { class: 'note', text: 'Drag the 3D view to orbit, scroll to zoom. With the view focused, the arrow keys orbit, + and − zoom and Home reframes it. Hover a chart for exact values, or focus it and walk the crosshair with the arrow keys; the Table button under the readouts lists the same numbers as text.' }));
    ab.append(appH('div', { class: 'tools' }, [
      appH('button', { type: 'button', text: 'Export trajectory (JSON for Blender)', onclick: () => this.exportJSON() }),
      appH('a', { href: 'https://github.com/jpeponis/tissuesimulations', target: '_blank', rel: 'noopener', text: 'Model notes & source' }),
    ]));
    ab.append(appH('p', { class: 'note', text: `The export holds one frame every ${this.exportEvery} simulated days since the last reset. In the hosted viewer you will be asked to confirm the save.` }));
    ab.append(appH('p', { class: 'note', text: `${t.name}${t.version ? ` · definition v${t.version}` : ''}` }));
  }

  // ---------- renderer ----------
  /**
   * WebGL never arrived, so the canvas is a picture and nothing else: it must stop promising the
   * camera keys it can no longer honour (4.1.2). The live description stays — it is the tissue's
   * state in words, which is exactly what is left when the picture is gone.
   */
  viewIsInert() {
    const c = appEl('view');
    if (c) { c.removeAttribute('aria-describedby'); c.removeAttribute('aria-keyshortcuts'); }
    const hint = appEl('view-keys-hint');
    if (hint) hint.hidden = true;
  }

  async initRenderer() {
    const canvas = appEl('view');
    if (!appHasWebGL()) {
      this.rendererState = 'failed';
      this.viewIsInert();
      this.showNotice('3D view unavailable', 'This browser could not create a WebGL context, so the tissue cannot be drawn. The simulation, dials, readouts and values table still work. Try another browser, or enable hardware acceleration in the browser settings.');
      canvas.setAttribute('aria-label', '3D view unavailable: WebGL is not available in this browser. The readouts and values table still describe the tissue.');
      return;
    }
    let Ctor;
    try { Ctor = await appLoadRenderer(); }
    catch (e) {
      this.rendererState = 'failed';
      this.viewIsInert();
      this.showNotice('Could not load the 3D library', `Three.js did not load from cdn.jsdelivr.net (${(e && e.message) || 'network error'}). The simulation, dials and readouts still run.`, appH('p', { html: APP_OFFLINE_HTML }));
      canvas.setAttribute('aria-label', '3D view unavailable: the Three.js library did not load. The readouts and values table still describe the tissue.');
      this.flash('The 3D view could not load; the readouts still run.');
      return;
    }
    try {
      this.renderer = new Ctor(canvas, {
        autoRotate: this.autoRotate,
        // the renderer stops rotating by itself on a drag or a key press (WCAG 2.2.2): keep the chip honest
        onAutoRotate: (on) => this.setAutoRotate(on, false),
      });
    }
    catch (e) {
      this.rendererState = 'failed';
      this.viewIsInert();
      this.showNotice('3D view unavailable', `The WebGL renderer could not start (${(e && e.message) || 'unknown error'}). The simulation, dials and readouts still run.`);
      return;
    }
    if (this.tissue && typeof this.renderer.setTissue === 'function') this.renderer.setTissue(this.tissue);
    this.rendererState = 'ready';
    this.buildLegend();
    this.buildCamera();          // the camera chips exist only once there is a camera to drive
    // the camera is keyboard-operable (B2); give the pointer the same way back to the default view
    if (typeof this.renderer.resetView === 'function') {
      const b = appEl('btn-view');
      if (b) { b.hidden = false; b.addEventListener('click', () => { this.renderer.resetView(); this.announce('3D view reframed.', true); }); }
    }
  }

  showNotice(title, body, extra) {
    const n = appEl('notice');
    n.replaceChildren(appH('h2', { text: title }), appH('p', { text: body }), extra || '');
    n.hidden = false;
  }

  busy(text) {
    const b = appEl('busy');
    if (text) {
      b.textContent = text; b.hidden = false; appEl('app').setAttribute('aria-busy', 'true');
      this.announce(text, true);          // the overlay is visual only; the status region says it once
    } else { b.hidden = true; appEl('app').removeAttribute('aria-busy'); }
  }

  // ---------- run loop ----------
  /** `quiet` suppresses the announcement — a scenario or tissue switch says its own thing. */
  setPlaying(on, quiet) {
    if (on && !(this.engine && this.ready)) on = false;
    const was = this.playing;
    this.playing = on;
    const b = appEl('btn-play');
    b.textContent = on ? 'Pause' : 'Play';
    b.setAttribute('title', on ? 'Pause the simulation (Space)' : 'Run the simulation (Space)');
    if (on && !this.hasPlayed) { this.hasPlayed = true; appEl('hint').hidden = true; }
    if (!on) { this.stopAt = null; this.accum = 0; }
    // a screen reader hears the clock stop, and what the tissue was doing when it did (C3)
    if (quiet || !this.stats) return;
    if (was && !on) this.announce(`Paused, day ${this.stats.t.toFixed(1)}. ${this.sentence(this.stats)}`, true);
    else if (!was && on) this.announce(`Playing at ${this.speed} simulated days per second, from day ${this.stats.t.toFixed(1)}.`, true);
  }
  togglePlay() { this.setPlaying(!this.playing); }

  setSpeed(v, fromUi) {
    v = appClamp(Number.isFinite(v) ? v : APP_SPEED_DEFAULT, 0.25, 20);
    this.speed = v;
    const input = appEl('speed');
    if (!fromUi) input.value = v;
    const t = appSpeedText(v);
    appEl('speed-out').textContent = t.value;
    input.setAttribute('aria-valuetext', t.valuetext);
    for (const s of this.speedButtons) s.b.setAttribute('aria-pressed', String(Math.abs(s.v - v) < 1e-9));
    this.scheduleUrl();
  }

  /** One simulated day, stepped synchronously (50 steps ≈ 10 ms): the "+1 day" button. */
  advance(days) {
    if (!this.engine || !this.ready) return;
    this.runSteps(Math.max(1, Math.round(days / this.dt)));
    this.sample(true, performance.now());
    if (this.stats) this.announce(`Day ${this.stats.t.toFixed(1)}, ${appWeek(this.stats.t)}. ${this.sentence(this.stats)}`, true);
  }

  /**
   * "+7 days": run to a target day instead of stepping there (C10). 350 steps synchronously is a
   * third of a second of frozen UI on a Chromebook; playing to a `stopAt` keeps the 3D view and
   * the charts alive and pauses on arrival. Pressing it again extends the target.
   */
  runFor(days) {
    if (!this.engine || !this.ready) return;
    const base = this.stopAt != null ? this.stopAt : this.engine.time;
    this.stopAt = base + days;
    this.accum = 0;
    this.setPlaying(true);
    this.flash(`Running to day ${this.stopAt.toFixed(0)} (${appWeek(this.stopAt)}), then pausing.`);
  }

  /**
   * Step the engine n steps. With auto-apply on, the block is split at the day of each
   * scripted event so a jump of forty days still fires them in the right order and on
   * the right day; with it off this is one engine.step(n), as before.
   */
  runSteps(n) {
    const eng = this.engine;
    let guard = 0;
    while (n > 0 && guard++ < 256) {
      let take = n;
      const ev = this.autoEvents ? this.nextEvent() : null;
      if (ev) {
        const need = Math.ceil((ev.at - eng.time) / this.dt - 1e-9);
        if (need <= 0) { this.applyEvent(ev); continue; }
        if (need < take) take = need;
      }
      eng.step(take);
      n -= take;
    }
    if (n > 0) eng.step(n);
    this.captureExport();
  }

  /**
   * One animation frame: step the engine within a WALL-CLOCK budget (A3), update the 3D view,
   * sample the stats, and — while paused — spend a few idle milliseconds warming the scenario
   * pre-runs (A2) so the first Unloading click is instant.
   *
   * The old bound was a step COUNT (60), which is 12 ms of fibrous but 21 ms of cartilage and
   * whatever the next tissue costs. Here the loop stops as soon as APP_STEP_BUDGET_MS is spent —
   * always after at least one step, so the clock never freezes — and the backlog it could not
   * work through is DROPPED (the sim runs slower than the speed dial asks rather than falling
   * further behind every frame), which #fps says out loud as "sim slowed".
   */
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const eng = this.engine;
    let slowed = false;
    if (eng && this.ready) {
      if (this.playing && dtReal > 0) {
        this.accum += dtReal * this.speed;                    // simulated days owed
        let n = Math.floor(this.accum / this.dt);
        if (this.stopAt != null) n = Math.min(n, Math.max(0, Math.ceil((this.stopAt - eng.time) / this.dt - 1e-9)));
        if (n > 0) {
          const t0 = performance.now();
          let done = 0;
          while (done < n) {
            const take = Math.min(n - done, 8);               // one budget check per ~8 steps
            this.runSteps(take);
            done += take;
            if (performance.now() - t0 >= APP_STEP_BUDGET_MS) break;
          }
          this.accum -= done * this.dt;
          if (done < n) { this.accum = 0; slowed = true; this.slowUntil = now + APP_SLOW_MS; }   // drop the backlog
        }
        if (this.stopAt != null && eng.time >= this.stopAt - 1e-9) {
          const target = this.stopAt;
          this.stopAt = null;
          this.setPlaying(false, true);      // the flash below is the announcement
          this.sample(true, now);
          this.flash(`Paused at day ${eng.time.toFixed(1)} (${appWeek(eng.time)}), the target was day ${target.toFixed(0)}.`);
        }
      }
      if (this.renderer) this.renderer.update(eng.state, this.layers);
      if (now - this.lastStatsAt >= APP_STATS_MS) this.sample(false, now);
      if (!this.playing && !slowed) this.warmIdle(now);
    }
    if (this.renderer) this.renderer.render();
    this.frameTimes.push(now); if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length === 30 && now - this.lastFpsAt > 1000) {
      const fps = 29000 / (this.frameTimes[29] - this.frameTimes[0]);
      // #fps is hidden by CSS (body.debug shows it) but keeps being written: tools/screenshot_app.mjs
      // reads it, and "sim slowed" is the one message worth surfacing from here.
      appEl('fps').textContent = now < this.slowUntil ? `${fps.toFixed(0)} fps · sim slowed` : `${fps.toFixed(0)} fps`;
      this.lastFpsAt = now;
    }
  }

  /**
   * Idle frames pay for the scenario pre-runs (A2). `engine.warmScenarios(n)` advances one
   * `init.from` pre-run by n steps and caches it when it finishes, so the 3000-step Unloading
   * pre-run is spread over a few seconds of doing nothing instead of freezing the UI on the
   * first click. The chunk size follows the measured cost, and an engine without the method
   * (an older build) simply never warms — loadScenario still runs it synchronously.
   */
  warmIdle() {
    const eng = this.engine;
    if (this.warmDone || !eng || typeof eng.warmScenarios !== 'function') return;
    const t0 = performance.now();
    let spent = 0;
    do {
      let r = null;
      const s0 = performance.now();
      try { r = eng.warmScenarios(this.warmChunk); } catch (e) { this.warmDone = true; return; }
      const ms = performance.now() - s0;
      if (!r || r.done) { this.warmDone = true; return; }   // every pre-run is cached
      // size the next slice from the measured per-step cost of this one
      this.warmChunk = appClamp(Math.round(APP_WARM_CHUNK_MS * this.warmChunk / Math.max(0.05, ms)), 4, 400);
      spent = performance.now() - t0;
    } while (spent < APP_WARM_MS);
  }

  statValue(s, path) {
    let v = NaN;
    if (typeof TissueEngine.statFrom === 'function') { try { v = TissueEngine.statFrom(s, path); } catch (e) { v = NaN; } }
    if (!Number.isFinite(v)) v = appStat(s, path);
    if (!Number.isFinite(v) && this.engine && typeof this.engine.stat === 'function') {
      try { v = this.engine.stat(path); } catch (e) { v = NaN; }
    }
    return Number.isFinite(v) ? v : NaN;
  }

  /** The live sentence for these stats, in this tissue's vocabulary. */
  sentence(s) { return copyEquilibriumSentence(s, this.voc); }
  /** The trend these stats are in ('still' | 'condensing' | 'evaporating' | 'steady'). */
  trend(s) { return copyTrend(s, this.voc); }

  /**
   * Sample engine.stats() (≤ 10×/s), feed plots, and refresh text at their own cadences.
   *
   * While the state is unchanged — paused, and nothing pressed — the engine's `revision`
   * (docs/EXTENDING.md §3) says so and the stats pass is skipped entirely: no stats(), no plot
   * push, no redraw (REVIEW §5, folded into A3/B1). The text below still runs, because the live
   * sentence has to come back after a flash expires even when nothing is moving. An engine
   * without `revision` samples exactly as before.
   */
  sample(force, now) {
    if (!this.engine) return;
    this.lastStatsAt = now;
    const rev = this.engine.revision;
    const fresh = force || rev === undefined || rev !== this.lastRevision || !this.stats;
    this.lastRevision = rev;
    const s = fresh ? this.engine.stats() : this.stats;
    this.stats = s;
    appEl('day').textContent = s.t.toFixed(1);
    const wk = appEl('week');
    if (wk) wk.textContent = `(${appWeek(s.t)})`;
    const vals = this.values;
    if (fresh) {
      for (const p of this.plots) {
        for (const ser of p.plot.spec.series) vals[ser.key] = this.statValue(s, ser.key);
        p.plot.push(s.t, vals);
      }
    }
    if (fresh && (force || now - this.lastPlotAt >= APP_PLOT_MS)) {
      for (const p of this.plots) { p.plot.draw(); p.val.textContent = this.readoutValueText(p); }
      if (this.gauge) {
        this.gauge.update(s.deposition, s.degradation, s.scaffoldFlux);
        // the gauge is a picture; the number goes in the DOM beside the title (C4)
        if (this.gaugeVal) this.gaugeVal.textContent = this.gaugeValueText();
      }
      this.lastPlotAt = now;
    }
    const trend = this.trend(s);
    if (now >= this.flashUntil && (force || now - this.lastSentenceAt > APP_SENTENCE_MS)) {
      const eq = appEl('equilibrium');
      eq.textContent = this.sentence(s);
      eq.dataset.state = trend;
      this.lastSentenceAt = now;
    }
    // Screen readers (C3): the visual sentence is rewritten every 0.7 s with changing rates, which
    // in a live region is a flood. Announce it when the BALANCE turns — but only once the new
    // trend has held for a second and not more often than every APP_TREND_MS, because the first
    // days of a run cross the thresholds several times — and otherwise at most once every
    // APP_STATUS_MS while the clock runs. Pauses, steps and scenario loads announce on their own.
    // …and never within APP_STATUS_FLOOR_MS of ANY previous announcement while the clock runs: the
    // trend path was gated only by its own 5 s timer, so a flip could land 1.1 s after "Playing at
    // 20 days per second" or 2.5 s after a routine reading, repeating a sentence whose first
    // seventy characters were identical. A sentence identical to the last one said is skipped
    // outright — a threshold crossed and re-crossed is not news.
    if (trend !== this.pendingTrend) { this.pendingTrend = trend; this.pendingTrendAt = now; }
    const floor = this.playing ? APP_STATUS_FLOOR_MS : 0;
    const turned = trend !== this.lastTrend && this.lastTrend !== null
      && now - this.pendingTrendAt >= APP_TREND_HOLD_MS && now - this.lastTrendSaidAt >= APP_TREND_MS
      && now - this.lastStatusAt >= floor;
    const line = this.sentence(s);
    if (turned) {
      this.lastTrendSaidAt = now;
      if (line !== this.lastSaidSentence) { this.lastSaidSentence = line; this.announce(`Day ${s.t.toFixed(1)}. ${line}`, true); }
    } else if (this.playing && now - this.lastStatusAt >= APP_STATUS_MS) {
      this.lastSaidSentence = line;
      this.announce(`Day ${s.t.toFixed(1)}. ${line}`);
    }
    if (turned || this.lastTrend === null || now - this.pendingTrendAt >= APP_TREND_HOLD_MS) this.lastTrend = trend;
    if (force || now - this.lastLabelAt > APP_LABEL_MS) {
      appEl('view').setAttribute('aria-label', this.describe(s));
      this.lastLabelAt = now;
    }
    if (this.tableOn && (force || now - this.lastTableAt > APP_TABLE_MS)) { this.renderTable(now); this.renderHistory(); }
  }

  /**
   * The flux gauge as text for the value beside its title: "0.05/d vs 0.02/d · 2.50 ×". The gauge
   * itself owns the wording, so the tissue's own word for a dissolving scaffold
   * (`copy.gauge.scaffold`) reaches the DOM value and not only the canvas — this text is what a
   * screen reader gets instead of the picture.
   */
  gaugeValueText() { return this.gauge && typeof this.gauge.describe === 'function' ? this.gauge.describe() : ''; }

  // ---------- screen-reader status region (C3) ----------
  /**
   * Say something once, in the polite `#status` region. `force` bypasses the 15 s cadence (a
   * pause, a step, a scenario load, a flash, a busy overlay, a keyboard crosshair reading).
   * Identical text is nudged with a trailing space so a repeat is still announced, and nothing
   * here moves focus.
   */
  announce(text, force) {
    const el = appEl('status');
    if (!el || !text) return;
    const now = performance.now();
    if (!force && now - this.lastStatusAt < APP_STATUS_MS) return;
    let msg = String(text);
    if (msg === this.statusText) { this.statusFlip = !this.statusFlip; msg += this.statusFlip ? ' ' : ''; }
    this.statusText = msg;
    this.lastStatusAt = now;
    el.textContent = msg;
  }

  /** One sentence for the 3D canvas's aria-label, built from generic stats and the tissue's words. */
  describe(s) {
    const t = this.tissue, sc = this.scenario();
    const voc = this.voc;
    const parts = [];
    // matrix without the scaffold when the engine separates them, otherwise every species
    const sp = s.species || null;
    const total = sp ? (Number.isFinite(sp.tissueTotal) ? sp.tissueTotal : sp.total) : NaN;
    if (Number.isFinite(total)) {
      let str = `${voc.matrix || 'matrix'} density ${total.toFixed(2)}`;
      const fibers = (t.species || []).filter((x) => x.kind === 'fiber');
      const last = fibers[fibers.length - 1];
      const fr = last ? appStat(s, `species.${last.key}.fraction`) : NaN;
      if (fibers.length > 1 && Number.isFinite(fr)) str += ` with ${Math.round(fr * 100)} % ${appLowerFirst(last.label)}`;
      parts.push(str);
    }
    // F8: "alignment" is whole-tissue coherence (globalFA) everywhere else in the UI; the
    // per-voxel mean (fa) is "local anisotropy". Keep the spoken description on the same measure.
    if (Number.isFinite(s.globalFA)) parts.push(`alignment ${s.globalFA.toFixed(2)}`);
    else if (Number.isFinite(s.fa)) parts.push(`alignment ${s.fa.toFixed(2)}`);
    // the cells in their own vocabulary: "activation 0.85", "phenotype 0.99 (1 = chondrogenic)"
    if (s.cells && Number.isFinite(s.cells.a)) {
      const n = this.stateNoun;
      parts.push(`cell ${n.noun} ${s.cells.a.toFixed(2)}${n.qualifier ? ` (${n.qualifier})` : ''}`);
    }
    if (Number.isFinite(s.logE)) parts.push(`stiffness ${appPow10(s.logE)} kPa`);
    const ratio = (s.deposition + 1e-9) / (s.degradation + 1e-9);
    parts.push(ratio > 1.15 ? 'deposition outpaces degradation' : ratio < 0.87 ? 'degradation outpaces deposition' : 'deposition and degradation balance');
    if (this.engine && this.engine.state && this.engine.state.wound) parts.push('a wound is healing');
    const head = this.rendererState === 'failed' ? `3D view not available; ${t.name.toLowerCase()}` : `3D view of ${t.name.toLowerCase()}`;
    return `${head}, ${sc ? sc.title : ''}, day ${s.t.toFixed(0)}: ${parts.join('; ')}.`;
  }

  flash(msg) {
    const eq = appEl('equilibrium');
    eq.textContent = msg;
    eq.dataset.state = 'flash';
    this.flashUntil = performance.now() + APP_FLASH_MS;
    this.announce(msg, true);            // said once, not re-read every 0.7 s (C3)
  }

  // ---------- presentation mode (C12) ----------
  /**
   * `body.present` (CSS in index.html) blows the live sentence up to 24 px on a backdrop, the
   * clock to 18 px, widens the panel and hides the per-dial hints — the lecture-room view from
   * the back row. Toggled by the chip, by `?present=1` and by the P key; the copied link keeps it.
   * The charts follow with a bigger font, so the readouts scale with the rest.
   */
  setPresent(on, fromUi) {
    this.present = !!on;
    document.body.classList.toggle('present', this.present);
    const b = appEl('btn-present');
    if (b) b.setAttribute('aria-pressed', String(this.present));
    const fontPx = this.present ? APP_PRESENT_FONT : 11;
    for (const p of this.plots) { p.plot.spec.fontPx = fontPx; p.plot.draw(); }
    if (this.gauge && typeof this.gauge.setFontPx === 'function') this.gauge.setFontPx(fontPx);
    if (this.renderer && typeof this.renderer.resize === 'function') this.renderer.resize();
    // the sentence and the clock grow, so the HUD is taller and the legend has less room; the
    // console's type grows too, so the sticky header is taller
    this.measureRun(); this.layoutLegend();
    if (fromUi) {
      this.scheduleUrl();
      this.announce(this.present ? 'Presentation mode on: bigger sentence and clock, hints hidden.' : 'Presentation mode off.', true);
    }
  }

  // ---------- deep links ----------
  buildUrl() {
    const p = new URLSearchParams();
    p.set('tissue', this.tissueKey);
    if (this.scenarioKey) p.set('scenario', this.scenarioKey);
    for (const d of this.tissue.dials) if (Number.isFinite(this.dialValues[d.key])) p.set(d.key, appNum(this.dialValues[d.key]));
    p.set('speed', appNum(this.speed));
    if (this.present) p.set('present', '1');
    if (!this.autoRotate) p.set('rotate', '0');
    if (document.body.classList.contains('debug')) p.set('debug', '1');
    return `${window.location.pathname}?${p.toString()}${window.location.hash}`;
  }
  scheduleUrl() { clearTimeout(this.urlTimer); this.urlTimer = setTimeout(() => this.writeUrl(), APP_URL_MS); }
  writeUrl() {
    if (!this.tissue || !this.ready) return;
    try { window.history.replaceState(null, '', this.buildUrl()); } catch (e) { /* sandboxed hosts may refuse */ }
  }

  async copyLink() {
    this.writeUrl();
    const url = window.location.href;
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(url); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      const ta = appH('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;left:-9999px;top:0' });
      ta.value = url; document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    const out = appEl('link-out');
    out.value = url;
    out.hidden = ok;
    if (!ok) { out.focus(); out.select(); }
    this.flash(ok ? 'Link copied. It restores this tissue, scenario, dial values and speed.' : 'Could not copy automatically; the link is shown under the Run controls. Select and copy it.');
  }

  // ---------- export ----------
  captureExport() {
    const st = this.engine.state;
    const t = st.time;
    if (t + 1e-9 >= this.nextExportT) {
      this.exportFrames.push(this.engine.snapshot());
      this.nextExportT = t + this.exportEvery;
      if (this.exportFrames.length > 120) this.exportFrames.shift();
    }
  }
  async exportJSON() {
    if (!this.engine || !this.ready) return;
    const st = this.engine.state;
    const meta = Object.assign({ format: 2, tissue: this.tissueKey }, typeof this.engine.exportMeta === 'function' ? this.engine.exportMeta() : {}, { scenario: this.scenarioKey, exportEveryDays: this.exportEvery });
    // E2: carry the fiber recipe actually in use so blender/import_tissue.py reproduces this
    // exact layout (recipe_from_meta) instead of falling back to its own copy of the defaults.
    if (this.renderer && typeof this.renderer.layoutParams === 'function') {
      try { meta.render = this.renderer.layoutParams(); } catch (e) { /* renderer without the hook: importer falls back */ }
    }
    const payload = { meta, frames: this.exportFrames };
    const filename = `tissue-weather-${this.tissueKey}-${this.scenarioKey}-day${st.time.toFixed(0)}.json`;
    const json = JSON.stringify(payload);
    // Hosted artifact viewer: saves go through the downloads capability (viewer confirms).
    const dl = (window.claude && typeof window.claude.use === 'function') ? await window.claude.use('downloads') : null;
    if (dl) {
      try {
        await dl.save({ filename, data: json });
        this.flash(`Saved ${filename} (${this.exportFrames.length} frames).`);
      } catch (e) {
        if (e && e.code === 'declined') this.flash('Export cancelled.');
        else this.flash('Export is not available in this viewer. Run the page from the repository to download.');
      }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    this.flash(`Exported ${filename} (${this.exportFrames.length} frames).`);
  }
}

function appBoot() { window.tissueApp = new TissueApp(); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', appBoot); else appBoot();
