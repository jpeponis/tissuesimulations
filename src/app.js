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
import { copyEquilibriumSentence, copyFormatRate, copyFormatDial } from './copy.js';

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
const APP_GHOST_MIN_DAYS = 0.5; // a run shorter than this is not worth keeping as a ghost
const APP_KEYS = [
  ['Space', 'play / pause'], ['R', 'reset the scenario (previous run stays dashed)'], ['I', 'injure (when the tissue supports it)'],
  ['1 – 9', 'pick a scenario'], ['← →', 'nudge the focused dial (Home / End for the extremes)'], ['Tab', 'move between controls; the 3D view is focusable and describes itself'],
];
const APP_OFFLINE_HTML = 'To use this page offline: reload once with an internet connection so the browser caches the library, or download <code>three@0.160.0</code> (<code>build/three.module.js</code> and <code>examples/jsm/controls/OrbitControls.js</code>) next to this page and point the import map in the HTML at those files.';

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
/** 10^v as a readable number (no exponent notation): 0.89, 5.6, 32, 320. */
function appPow10(v) { const x = Math.pow(10, v); return x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toPrecision(2); }
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
    this.speed = 2; this.accum = 0; this.lastFrame = 0; this.dt = 0.02;
    this.scenarioKey = null;
    this.exportFrames = []; this.exportEvery = 2; this.nextExportT = 0;
    this.stats = null; this.values = {}; this.dialValues = {};
    this.lastStatsAt = -1e9; this.lastPlotAt = -1e9; this.lastSentenceAt = -1e9; this.lastLabelAt = -1e9; this.lastTableAt = -1e9;
    this.flashUntil = 0; this.urlTimer = null; this.frameTimes = []; this.lastFpsAt = 0;
    this.plots = []; this.gauge = null; this.tableOn = false; this.tableCells = [];
    this.dialInputs = {}; this.dialOutputs = {}; this.scenarioButtons = {}; this.layerButtons = {};
    const mq = (q) => (window.matchMedia ? window.matchMedia(q) : null);
    this.motionQuery = mq('(prefers-reduced-motion: reduce)');
    this.narrowQuery = mq('(max-width: 900px)');
    this.reducedMotion = !!(this.motionQuery && this.motionQuery.matches);
    this.query = new URLSearchParams(window.location.search);

    this.bindStatic();
    this.buildTissuePicker();
    const qSpeed = parseFloat(this.query.get('speed'));
    this.setSpeed(Number.isFinite(qSpeed) ? qSpeed : 2, false);
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
    appEl('btn-reset').addEventListener('click', () => this.reset());
    appEl('btn-injure').addEventListener('click', () => this.injure());
    appEl('btn-copy-link').addEventListener('click', () => this.copyLink());
    appEl('btn-table').addEventListener('click', () => this.toggleTable());
    appEl('btn-clear-ref').addEventListener('click', () => this.clearReference(true));
    appEl('hint-dismiss').addEventListener('click', () => { appEl('hint').hidden = true; });
    const speed = appEl('speed');
    speed.addEventListener('input', () => this.setSpeed(parseFloat(speed.value), true));
    // legend: open on wide screens, collapsed (but reachable) on narrow ones
    const legendBox = appEl('legend-box');
    const applyLegend = () => { legendBox.open = !(this.narrowQuery && this.narrowQuery.matches); };
    applyLegend();
    if (this.narrowQuery && this.narrowQuery.addEventListener) this.narrowQuery.addEventListener('change', applyLegend);
    if (this.motionQuery && this.motionQuery.addEventListener) {
      this.motionQuery.addEventListener('change', (e) => {
        this.reducedMotion = e.matches;
        if (this.renderer && typeof this.renderer.setAutoRotate === 'function') this.renderer.setAutoRotate(!e.matches);
      });
    }
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

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
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); this.reset(); return; }
    if (k === 'i') { if (this.tissue && this.tissue.injury) { e.preventDefault(); this.injure(); } return; }
    if (/^[1-9]$/.test(e.key) && this.tissue) {
      const sc = this.tissue.scenarios[parseInt(e.key, 10) - 1];
      if (sc) { e.preventDefault(); this.loadScenario(sc.key); }
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
    this.setPlaying(false);
    this.tissueKey = key; this.tissue = tissue;
    const radio = appEl(`tissue-${key}`); if (radio) radio.checked = true;
    document.title = `Tissue Weather · ${tissue.name}`;
    appEl('tissue-name').textContent = tissue.name;
    appEl('tissue-short').textContent = tissue.short || '';
    this.layers = { fibers: true, cells: true, scaffold: true, gel: true, fields: {} };
    for (const f of tissue.fields || []) this.layers.fields[f.key] = false;
    this.dialValues = {};
    for (const d of tissue.dials) this.dialValues[d.key] = d.default;
    if (this.renderer && typeof this.renderer.setTissue === 'function') this.renderer.setTissue(tissue);
    this.buildDials(); this.buildScenarios(); this.buildReadouts(); this.buildLayers(); this.buildLegend(); this.buildAbout();
    appEl('btn-injure').hidden = !tissue.injury;
    this.engine = null; this.stats = null; this.ready = false;
    this.busy(`preparing ${tissue.name}…`);
    const sc = tissue.scenarios.some((s) => s.key === opts.scenario) ? opts.scenario : tissue.scenarios[0].key;
    // let the overlay paint before the (possibly slow) engine construction
    setTimeout(() => {
      try { this.engine = new TissueEngine(tissue, { seed: APP_SEED }); }
      catch (e) { this.busy(null); this.showNotice('The simulation could not start', String(e && e.message || e)); return; }
      this.loadScenario(sc, { dials: opts.dials, ghost: false, autoplay: false });
    }, 30);
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
  }

  renderScenarioCard(sc) {
    const card = appEl('scenario-card');
    const from = sc.init && sc.init.from;
    const events = this.describeEvents(sc);
    card.replaceChildren(
      appH('h3', { text: sc.title }),
      sc.goal ? appH('p', { class: 'goal', text: sc.goal }) : '',
      sc.steps && sc.steps.length ? appH('ol', {}, sc.steps.map((s) => appH('li', { text: s }))) : '',
      sc.question ? appH('p', { class: 'question', text: sc.question }) : '',
      sc.expect ? appH('details', {}, [appH('summary', { text: 'What should happen' }), appH('p', { text: sc.expect })]) : '',
      from ? appH('p', { class: 'note', text: `Starts from a matured tissue: “${this.scenarioTitle(from.scenario)}” pre-run for ${from.days} days.` }) : '',
      events ? appH('p', { class: 'note', text: `Reference run (headless checks): ${events}. Here you do it by hand.` }) : '',
    );
  }

  /** Human-readable list of a scenario's scripted `events` (the app does not apply them; the student does). */
  describeEvents(sc) {
    if (!Array.isArray(sc.events) || !sc.events.length) return '';
    const dialLabel = (k) => { const d = this.tissue.dials.find((x) => x.key === k); return d ? d.label.toLowerCase() : k; };
    return sc.events.map((ev) => {
      const parts = [];
      if (ev.dials) for (const [k, v] of Object.entries(ev.dials)) { const d = this.tissue.dials.find((x) => x.key === k); parts.push(`set ${dialLabel(k)} to ${d ? appFormatDial(d, v) : v}`); }
      if (ev.injure) parts.push('injure');
      return `day ${ev.at}: ${parts.join(', ') || 'event'}`;
    }).join('; ');
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
    this.setPlaying(false);
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
      this.sample(true, performance.now());
      if (o.flash) this.flash(o.flash);
      this.setPlaying(o.autoplay === undefined ? wasPlaying : o.autoplay);
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
    this.sample(true, performance.now());
    this.flash('Wound inflicted. Watch the cells near it activate and refill it.');
  }

  // ---------- dials ----------
  buildDials() {
    const box = appEl('dials'); box.replaceChildren(); this.dialInputs = {}; this.dialOutputs = {};
    for (const d of this.tissue.dials) {
      const id = `dial-${d.key}`;
      const txt = appFormatDial(d, d.default);
      const input = appH('input', { type: 'range', id, min: d.min, max: d.max, step: d.step, value: d.default, 'aria-valuetext': txt, 'aria-describedby': `${id}-hint` });
      const out = appH('output', { for: id, text: txt });
      input.addEventListener('input', () => this.setDial(d.key, parseFloat(input.value), 'ui'));
      const m = String(d.metaphor || '');
      const ci = m.indexOf(':');
      const tag = (ci > 0 ? m.slice(0, ci) : m).toLowerCase();
      const rest = ci > 0 ? m.slice(ci + 1).trim() : '';
      const hint = appH('div', { class: 'hint', id: `${id}-hint` }, [
        d.biology ? appH('span', { text: `${d.biology} ` }) : '',
        rest ? appH('span', { class: 'metaphor-note', text: `Like ${tag}: ${rest} ` }) : '',
        d.watch ? appH('b', { text: 'Watch: ' }) : '', d.watch ? appH('span', { text: d.watch }) : '',
      ]);
      box.append(appH('div', { class: 'dial' }, [
        appH('label', { for: id }, [document.createTextNode(d.label), tag ? appH('span', { class: 'metaphor', text: tag }) : '']),
        out, input, hint,
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
    this.scheduleUrl();
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
    this.plots = []; this.gauge = null;
    for (const r of this.tissue.readouts || []) {
      const val = appH('span', { class: 'val' });
      const head = appH('div', { class: 'head' }, [appH('h3', { text: r.label }), val]);
      const meaning = (r.unit || r.meaning) ? appH('p', { class: 'meaning' }, [r.unit ? appH('span', { class: 'unit', text: r.unit }) : '', r.unit && r.meaning ? document.createTextNode(' — ') : '', r.meaning ? document.createTextNode(r.meaning) : '']) : '';
      if (r.type === 'flux') {
        const canvas = appH('canvas', { role: 'img', 'aria-label': `${r.label} gauge; the deposition and degradation rates are in the values table` });
        box.append(appH('div', { class: 'readout gauge' }, [head, meaning, canvas]));
        this.gauge = new FluxGauge(canvas, APP_THEME);
        continue;
      }
      const stack = r.type === 'stack';
      const isLog = r.type === 'log';
      const series = (r.series || []).map((s) => ({ key: s.stat, label: s.label, color: s.color, stack }));
      const yDomain = Array.isArray(r.domain) ? r.domain : (isLog ? [-1, 2.5] : [0, 1]);
      const yFormat = isLog ? (v) => appPow10(v) : (v) => v.toFixed(2);
      const canvas = appH('canvas', { role: 'img', 'aria-label': `${r.label} chart over the last 90 days; the current values are in the values table` });
      const keys = appH('div', { class: 'keys' }, series.length > 1 ? series.map((s) => appH('span', {}, [appH('i', { style: `background:${s.color}` }), document.createTextNode(s.label)])) : []);
      const ghostKey = appH('span', { class: 'ghost-key', hidden: true }, [appH('i', { class: 'dash' }), document.createTextNode('previous run (dashed)')]);
      keys.append(ghostKey);
      box.append(appH('div', { class: 'readout' }, [head, meaning, canvas, keys]));
      const plot = new TimeSeriesPlot(canvas, { series, yDomain, yFormat, windowDays: 90, theme: APP_THEME });
      this.plots.push({ readout: r, plot, val, ghostKey, isLog, unitWord: (r.unit || '').split(/[\s(]/)[0] });
    }
    this.buildTable();
    this.syncReferenceUI();
  }

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

  // Values table: one row per series plus the flux rates. Built once per tissue, values updated in place.
  buildTable() {
    const box = appEl('stats-table'); box.replaceChildren(); this.tableCells = [];
    const tbody = appH('tbody');
    const row = (group, label, unit, getter) => {
      const td = appH('td', { class: 'num', text: '–' });
      tbody.append(appH('tr', {}, [appH('td', { text: group }), appH('th', { scope: 'row', text: label }), td, appH('td', { text: unit })]));
      this.tableCells.push({ td, getter });
    };
    for (const p of this.plots) {
      for (const s of p.plot.spec.series) {
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
    this.tableCaption = appH('caption', { text: 'Latest values' });
    box.append(appH('table', {}, [
      this.tableCaption,
      appH('thead', {}, [appH('tr', {}, [appH('th', { scope: 'col', text: 'Readout' }), appH('th', { scope: 'col', text: 'Series' }), appH('th', { scope: 'col', text: 'Value' }), appH('th', { scope: 'col', text: 'Unit' })])]),
      tbody,
    ]));
  }
  renderTable(now) {
    this.lastTableAt = now;
    if (this.stats) this.tableCaption.textContent = `Latest values, day ${this.stats.t.toFixed(1)}`;
    for (const c of this.tableCells) c.td.textContent = c.getter();
  }
  toggleTable() {
    this.tableOn = !this.tableOn;
    appEl('btn-table').setAttribute('aria-pressed', String(this.tableOn));
    appEl('stats-table').hidden = !this.tableOn;
    if (this.tableOn) this.renderTable(performance.now());
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
    box.append(appH('ul', { class: 'legend-swatches', 'aria-label': 'Colour key' }, sw.map((s) => appH('li', { class: 'legend-row' }, [appH('span', { class: 'swatch', style: `background:${s.css}` }), appH('span', { text: s.label })]))));
    const lg = (t.copy && t.copy.legend) || {};
    const guide = [];
    if (lg.fibers) guide.push(lg.fibers);
    if (lg.cells) guide.push(lg.cells);
    for (const f of t.fields || []) if (lg.fields && lg.fields[f.key]) guide.push(lg.fields[f.key]);
    if (lg.load && (t.dials || []).some((d) => d.role === 'load')) guide.push(lg.load);
    if (guide.length) {
      box.append(appH('details', { class: 'legend-guide' }, [appH('summary', { text: 'How to read the view' }), appH('ul', {}, guide.map((g) => appH('li', { text: g })))]));
    }
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
    ab.append(appH('p', { class: 'note', text: 'Drag the 3D view to orbit, scroll to zoom. Hover a chart for exact values; the Table button under the readouts lists them as text.' }));
    ab.append(appH('div', { class: 'tools' }, [
      appH('button', { type: 'button', text: 'Export trajectory (JSON for Blender)', onclick: () => this.exportJSON() }),
      appH('a', { href: 'https://github.com/jpeponis/tissuesimulations', target: '_blank', rel: 'noopener', text: 'Model notes & source' }),
    ]));
    ab.append(appH('p', { class: 'note', text: `The export holds one frame every ${this.exportEvery} simulated days since the last reset. In the hosted viewer you will be asked to confirm the save.` }));
    ab.append(appH('p', { class: 'note', text: `${t.name}${t.version ? ` · definition v${t.version}` : ''}` }));
  }

  // ---------- renderer ----------
  async initRenderer() {
    const canvas = appEl('view');
    if (!appHasWebGL()) {
      this.rendererState = 'failed';
      this.showNotice('3D view unavailable', 'This browser could not create a WebGL context, so the tissue cannot be drawn. The simulation, dials, readouts and values table still work. Try another browser, or enable hardware acceleration in the browser settings.');
      canvas.setAttribute('aria-label', '3D view unavailable: WebGL is not available in this browser. The readouts and values table still describe the tissue.');
      return;
    }
    let Ctor;
    try { Ctor = await appLoadRenderer(); }
    catch (e) {
      this.rendererState = 'failed';
      this.showNotice('Could not load the 3D library', `Three.js did not load from cdn.jsdelivr.net (${(e && e.message) || 'network error'}). The simulation, dials and readouts still run.`, appH('p', { html: APP_OFFLINE_HTML }));
      canvas.setAttribute('aria-label', '3D view unavailable: the Three.js library did not load. The readouts and values table still describe the tissue.');
      this.flash('The 3D view could not load; the readouts still run.');
      return;
    }
    try { this.renderer = new Ctor(canvas, { autoRotate: !this.reducedMotion }); }
    catch (e) {
      this.rendererState = 'failed';
      this.showNotice('3D view unavailable', `The WebGL renderer could not start (${(e && e.message) || 'unknown error'}). The simulation, dials and readouts still run.`);
      return;
    }
    if (this.tissue && typeof this.renderer.setTissue === 'function') this.renderer.setTissue(this.tissue);
    this.rendererState = 'ready';
    this.buildLegend();
  }

  showNotice(title, body, extra) {
    const n = appEl('notice');
    n.replaceChildren(appH('h2', { text: title }), appH('p', { text: body }), extra || '');
    n.hidden = false;
  }

  busy(text) {
    const b = appEl('busy');
    if (text) { b.textContent = text; b.hidden = false; appEl('app').setAttribute('aria-busy', 'true'); }
    else { b.hidden = true; appEl('app').removeAttribute('aria-busy'); }
  }

  // ---------- run loop ----------
  setPlaying(on) {
    if (on && !(this.engine && this.ready)) on = false;
    this.playing = on;
    const b = appEl('btn-play');
    b.textContent = on ? 'Pause' : 'Play';
    b.setAttribute('title', on ? 'Pause the simulation (Space)' : 'Run the simulation (Space)');
    if (on && !this.hasPlayed) { this.hasPlayed = true; appEl('hint').hidden = true; }
  }
  togglePlay() { this.setPlaying(!this.playing); }

  setSpeed(v, fromUi) {
    v = appClamp(Number.isFinite(v) ? v : 2, 0.25, 20);
    this.speed = v;
    const input = appEl('speed');
    if (!fromUi) input.value = v;
    const t = appSpeedText(v);
    appEl('speed-out').textContent = t.value;
    appEl('speed-hint').textContent = t.hint;
    input.setAttribute('aria-valuetext', t.valuetext);
    this.scheduleUrl();
  }

  advance(days) {
    if (!this.engine || !this.ready) return;
    const n = Math.max(1, Math.round(days / this.dt));
    this.engine.step(n);
    this.captureExport();
    this.sample(true, performance.now());
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const eng = this.engine;
    if (eng && this.ready) {
      if (this.playing && dtReal > 0) {
        this.accum += dtReal * this.speed; // simulated days owed
        const maxSteps = 60; // keep the frame responsive; the sim slows rather than stutters
        let n = Math.floor(this.accum / this.dt);
        if (n > maxSteps) { n = maxSteps; this.accum = n * this.dt; }
        if (n > 0) { eng.step(n); this.accum -= n * this.dt; this.captureExport(); }
      }
      if (this.renderer) this.renderer.update(eng.state, this.layers);
      if (now - this.lastStatsAt >= APP_STATS_MS) this.sample(false, now);
    }
    if (this.renderer) this.renderer.render();
    this.frameTimes.push(now); if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length === 30 && now - this.lastFpsAt > 1000) {
      const fps = 29000 / (this.frameTimes[29] - this.frameTimes[0]);
      appEl('fps').textContent = `${fps.toFixed(0)} fps`;
      this.lastFpsAt = now;
    }
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

  /** Sample engine.stats() (≤ 10×/s), feed plots, and refresh text at their own cadences. */
  sample(force, now) {
    if (!this.engine) return;
    this.lastStatsAt = now;
    const s = this.engine.stats();
    this.stats = s;
    appEl('day').textContent = s.t.toFixed(1);
    const vals = this.values;
    for (const p of this.plots) {
      for (const ser of p.plot.spec.series) vals[ser.key] = this.statValue(s, ser.key);
      p.plot.push(s.t, vals);
    }
    if (force || now - this.lastPlotAt >= APP_PLOT_MS) {
      for (const p of this.plots) { p.plot.draw(); p.val.textContent = this.readoutValueText(p); }
      if (this.gauge) this.gauge.update(s.deposition, s.degradation);
      this.lastPlotAt = now;
    }
    if (now >= this.flashUntil && (force || now - this.lastSentenceAt > APP_SENTENCE_MS)) {
      const eq = appEl('equilibrium');
      const voc = (this.tissue.copy && this.tissue.copy.vocabulary) || {};
      eq.textContent = copyEquilibriumSentence(s, voc);
      const ratio = (s.deposition + 1e-9) / (s.degradation + 1e-9);
      eq.dataset.state = ratio > 1.15 ? 'condensing' : ratio < 0.87 ? 'evaporating' : 'steady';
      this.lastSentenceAt = now;
    }
    if (force || now - this.lastLabelAt > APP_LABEL_MS) {
      appEl('view').setAttribute('aria-label', this.describe(s));
      this.lastLabelAt = now;
    }
    if (this.tableOn && (force || now - this.lastTableAt > APP_TABLE_MS)) this.renderTable(now);
  }

  /** One sentence for the 3D canvas's aria-label, built from generic stats and the tissue's words. */
  describe(s) {
    const t = this.tissue, sc = this.scenario();
    const voc = (t.copy && t.copy.vocabulary) || {};
    const parts = [];
    const total = s.species ? s.species.total : NaN;
    if (Number.isFinite(total)) {
      let str = `${voc.matrix || 'matrix'} density ${total.toFixed(2)}`;
      const fibers = (t.species || []).filter((x) => x.kind === 'fiber');
      const last = fibers[fibers.length - 1];
      const fr = last ? appStat(s, `species.${last.key}.fraction`) : NaN;
      if (fibers.length > 1 && Number.isFinite(fr)) str += ` with ${Math.round(fr * 100)} % ${last.label.toLowerCase()}`;
      parts.push(str);
    }
    if (Number.isFinite(s.fa)) parts.push(`alignment ${s.fa.toFixed(2)}`);
    if (s.cells && Number.isFinite(s.cells.a)) parts.push(`cells ${Math.round(s.cells.a * 100)} % activated`);
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
  }

  // ---------- deep links ----------
  buildUrl() {
    const p = new URLSearchParams();
    p.set('tissue', this.tissueKey);
    if (this.scenarioKey) p.set('scenario', this.scenarioKey);
    for (const d of this.tissue.dials) if (Number.isFinite(this.dialValues[d.key])) p.set(d.key, appNum(this.dialValues[d.key]));
    p.set('speed', appNum(this.speed));
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
