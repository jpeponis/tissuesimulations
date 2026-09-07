// app.js — wires the simulation (model.js) to the 3D scene (render.js), the
// readouts (plots.js) and the student-facing copy (copy.js).
import { TissueModel, SCENARIOS, DEFAULT_PARAMS } from './model.js';
import { TissueRenderer } from './render.js';
import { TimeSeriesPlot, FluxGauge } from './plots.js';
import { COPY_DIALS, COPY_SCENARIOS, COPY_READOUTS, COPY_INTRO, COPY_METAPHOR_BREAKS, COPY_LEGEND, copyEquilibriumSentence } from './copy.js';

const APP_THEME = {
  text: '#e6edf3', muted: '#8b9bb0', grid: '#243040', surface: '#161e28',
  warm: '#c4822a', cool: '#3f97dc',
  sNew: '#3f97dc', sMat: '#c4822a', sAlpha: '#e0602a', sFA: '#8f7ae0', sE: '#8fb8d8',
};

const APP_DIAL_ORDER = ['Gext', 'strain', 'protease', 'nCells'];
const APP_DIAL_RANGES = {
  Gext: { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  strain: { min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
  protease: { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  nCells: { min: 40, max: 400, step: 10, fmt: (v) => `${Math.round(v)} cells` },
};

function appEl(id) { return document.getElementById(id); }
function appH(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

class TissueApp {
  constructor() {
    this.params = Object.assign({}, DEFAULT_PARAMS);
    this.model = new TissueModel(this.params, 12345);
    this.renderer = new TissueRenderer(appEl('view'));
    this.layers = { fibers: true, cells: true, g: false, m: false };
    this.playing = false;
    this.speed = 2; // simulated days per real second
    this.accum = 0;
    this.lastFrame = 0;
    this.scenarioKey = 'maturation';
    this.exportFrames = [];
    this.exportEvery = 2; // days
    this.nextExportT = 0;
    this.lastSentenceAt = 0;
    this.frameTimes = [];
    this.buildUI();
    this.loadScenario('maturation');
    requestAnimationFrame((t) => this.frame(t));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|BUTTON|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
        e.preventDefault(); this.togglePlay();
      }
    });
  }

  // ---------- UI construction ----------
  buildUI() {
    // scenarios
    const sc = appEl('scenarios');
    this.scenarioButtons = {};
    for (const key of Object.keys(SCENARIOS)) {
      const c = COPY_SCENARIOS[key] || { title: SCENARIOS[key].label || key };
      const b = appH('button', { class: 'scenario-btn', type: 'button', 'aria-pressed': 'false', text: c.title, onclick: () => this.loadScenario(key) });
      this.scenarioButtons[key] = b; sc.append(b);
    }
    // dials
    const dials = appEl('dials');
    this.dialInputs = {}; this.dialOutputs = {};
    for (const key of APP_DIAL_ORDER) {
      const c = COPY_DIALS[key]; const r = APP_DIAL_RANGES[key];
      const input = appH('input', { type: 'range', id: `dial-${key}`, min: r.min, max: r.max, step: r.step, value: r.min });
      const out = appH('output', { for: `dial-${key}` });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.textContent = r.fmt(v);
        this.model.setDials({ [key]: v });
      });
      // "Humidity: how much vapor..." -> tag "humidity", rest of the sentence in the hint
      const mIdx = c.metaphor.indexOf(':');
      const mTag = (mIdx > 0 ? c.metaphor.slice(0, mIdx) : c.metaphor).toLowerCase();
      const mRest = mIdx > 0 ? c.metaphor.slice(mIdx + 1).trim() : '';
      const wrap = appH('div', { class: 'dial' }, [
        appH('label', { for: `dial-${key}` }, [document.createTextNode(c.label), appH('span', { class: 'metaphor', text: mTag })]),
        out, input,
        appH('div', { class: 'hint' }, [
          appH('span', { text: `${c.biology} ` }),
          mRest ? appH('span', { class: 'metaphor-note', text: `Like ${mTag}: ${mRest} ` }) : '',
          appH('b', { text: 'Watch: ' }), appH('span', { text: c.watch }),
        ]),
      ]);
      dials.append(wrap);
      this.dialInputs[key] = input; this.dialOutputs[key] = out;
    }
    // transport
    appEl('btn-play').addEventListener('click', () => this.togglePlay());
    appEl('btn-step').addEventListener('click', () => { this.advance(1.0); this.syncReadouts(true); });
    appEl('btn-reset').addEventListener('click', () => this.loadScenario(this.scenarioKey));
    appEl('btn-injure').addEventListener('click', () => { this.model.injure(); this.flash('Wound inflicted. Watch the cells near it activate and refill it.'); });
    const speed = appEl('speed'), speedOut = appEl('speed-out');
    speed.addEventListener('input', () => { this.speed = parseFloat(speed.value); speedOut.textContent = `${this.speed} d/s`; });
    // layer toggles
    const layers = appEl('layers');
    const layerLabels = { fibers: 'fibers', cells: 'cells', g: 'growth factor', m: 'protease' };
    for (const key of Object.keys(layerLabels)) {
      const b = appH('button', { class: 'chip', type: 'button', 'aria-pressed': String(this.layers[key]), text: layerLabels[key] });
      b.addEventListener('click', () => { this.layers[key] = !this.layers[key]; b.setAttribute('aria-pressed', String(this.layers[key])); });
      layers.append(b);
    }
    // legend
    const legend = appEl('legend');
    const firstSentence = (t) => (t.match(/^[^.]*\./) || [t])[0];
    const legendRows = [['fiber', COPY_LEGEND.fibers], ['cell', COPY_LEGEND.cells], ['gf', COPY_LEGEND.growthFactor], ['mmp', COPY_LEGEND.protease], ['load', COPY_LEGEND.load]];
    for (const [cls, text] of legendRows) legend.append(appH('div', { class: 'legend-row' }, [appH('span', { class: `swatch ${cls}` }), appH('span', { text: firstSentence(text), title: text })]));
    // readouts
    const ro = appEl('readouts');
    const mk = (key, series, yDomain, yFormat) => {
      const c = COPY_READOUTS[key];
      const canvas = appH('canvas', { 'aria-label': c.label });
      const val = appH('span', { class: 'val', text: '' });
      const keys = appH('div', { class: 'keys' }, series.length > 1 ? series.map((s) => appH('span', { html: `<i style="background:${s.color}"></i>${s.label}` })) : []);
      ro.append(appH('div', { class: 'readout' }, [
        appH('div', { class: 'head' }, [appH('span', { html: `<b>${c.label}</b> ${c.unit ? `(${c.unit})` : ''} — ${c.meaning}` }), val]),
        canvas, keys,
      ]));
      const plot = new TimeSeriesPlot(canvas, { series, yDomain, yFormat, windowDays: 90, theme: APP_THEME });
      return { plot, val };
    };
    this.plots = {
      rho: mk('rho', [{ key: 'meanRhoNew', label: 'new matrix', color: APP_THEME.sNew, stack: true }, { key: 'meanRhoMat', label: 'mature collagen', color: APP_THEME.sMat, stack: true }], [0, 1], (v) => v.toFixed(2)),
      fa: mk('fa', [{ key: 'meanFA', label: 'alignment', color: APP_THEME.sFA }, { key: 'meanAlpha', label: 'cell activation', color: APP_THEME.sAlpha }], [0, 1], (v) => v.toFixed(2)),
      E: mk('E', [{ key: 'meanLogE', label: 'stiffness', color: APP_THEME.sE }], [-1, 2.5], (v) => `${Math.pow(10, v).toPrecision(2)}`),
    };
    const gc = COPY_READOUTS.flux;
    const gcanvas = appH('canvas', { 'aria-label': gc.label });
    ro.append(appH('div', { class: 'readout gauge' }, [appH('div', { class: 'head' }, [appH('span', { html: `<b>${gc.label}</b> — ${gc.meaning}` })]), gcanvas]));
    this.gauge = new FluxGauge(gcanvas, APP_THEME);
    // about
    const ab = appEl('about-body');
    ab.append(appH('p', { class: 'note', text: COPY_INTRO.tagline }));
    for (const p of COPY_INTRO.paragraphs) ab.append(appH('p', { text: p }));
    ab.append(appH('h2', { text: 'Where the cloud metaphor breaks' }));
    const dl = appH('dl');
    for (const mb of COPY_METAPHOR_BREAKS) { dl.append(appH('dt', { text: mb.claim })); dl.append(appH('dd', { text: mb.reality })); }
    ab.append(dl);
    ab.append(appH('div', { class: 'tools' }, [
      appH('button', { type: 'button', text: 'Export trajectory (JSON for Blender)', onclick: () => this.exportJSON() }),
      appH('a', { href: 'https://github.com/jpeponis/tissuesimulations', target: '_blank', rel: 'noopener', text: 'Model notes & source' }),
    ]));
    ab.append(appH('p', { class: 'note', text: 'The export holds one frame every 2 simulated days since the last reset. In some hosted viewers the browser blocks downloads; run the page from the repository if the button does nothing.' }));
    window.addEventListener('resize', () => this.redrawPlots());
  }

  // ---------- scenario / dial sync ----------
  loadScenario(key) {
    this.scenarioKey = key;
    for (const [k, b] of Object.entries(this.scenarioButtons)) b.setAttribute('aria-pressed', String(k === key));
    const c = COPY_SCENARIOS[key];
    const card = appEl('scenario-card');
    card.replaceChildren(
      appH('h3', { text: c.title }),
      appH('p', { class: 'goal', text: c.goal }),
      appH('ol', {}, c.steps.map((s) => appH('li', { text: s }))),
      appH('p', { class: 'question', text: c.question }),
      appH('details', {}, [appH('summary', { text: 'What should happen' }), appH('p', { text: c.expect })]),
    );
    appEl('scenario-name').textContent = c.title;
    const wasPlaying = this.playing;
    this.setPlaying(false);
    const busy = appEl('busy'); busy.hidden = false;
    // let the overlay paint before a possibly slow reset (matured-state scenarios pre-run 60 days)
    setTimeout(() => {
      this.model.reset(key);
      this.syncDialsFromModel();
      for (const p of Object.values(this.plots)) p.plot.clear();
      this.exportFrames = []; this.nextExportT = 0;
      this.accum = 0;
      this.syncReadouts(true);
      busy.hidden = true;
      this.setPlaying(wasPlaying || true);
    }, 30);
  }

  syncDialsFromModel() {
    const d = this.model.state.dials;
    for (const key of APP_DIAL_ORDER) {
      const r = APP_DIAL_RANGES[key];
      this.dialInputs[key].value = d[key];
      this.dialOutputs[key].textContent = r.fmt(d[key]);
    }
  }

  // ---------- run loop ----------
  setPlaying(on) {
    this.playing = on;
    const b = appEl('btn-play');
    b.textContent = on ? 'Pause' : 'Play';
    b.setAttribute('aria-pressed', String(on));
  }
  togglePlay() { this.setPlaying(!this.playing); }

  advance(days) {
    const dt = this.model.params.dt;
    const n = Math.max(1, Math.round(days / dt));
    this.model.step(n);
    this.captureExport();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.playing && dtReal > 0) {
      this.accum += dtReal * this.speed; // simulated days owed
      const dt = this.model.params.dt;
      const maxSteps = 60; // keep the frame responsive; the sim slows rather than stutters
      let n = Math.floor(this.accum / dt);
      if (n > maxSteps) { n = maxSteps; this.accum = n * dt; }
      if (n > 0) { this.model.step(n); this.accum -= n * dt; this.captureExport(); }
    }
    this.renderer.update(this.model.state, this.layers);
    this.renderer.render();
    this.syncReadouts(false, now);
    this.frameTimes.push(now); if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length === 30 && (now | 0) % 20 === 0) {
      const fps = 29000 / (this.frameTimes[29] - this.frameTimes[0]);
      appEl('fps').textContent = `${fps.toFixed(0)} fps`;
    }
  }

  syncReadouts(force, now = 0) {
    const s = this.model.stats();
    // deposition/degradation come back summed over voxels; show them as mean density change per day
    const nVox = this.model.state.N ** 3;
    s.deposition /= nVox; s.degradation /= nVox;
    appEl('day').textContent = s.t.toFixed(1);
    for (const p of Object.values(this.plots)) p.plot.push(s.t, s);
    this.plots.rho.val.textContent = `${s.meanRho.toFixed(2)} (${Math.round(100 * (s.meanRhoMat / Math.max(s.meanRho, 1e-6)))} % mature)`;
    this.plots.fa.val.textContent = `FA ${s.meanFA.toFixed(2)} · α ${s.meanAlpha.toFixed(2)}`;
    this.plots.E.val.textContent = `${Math.pow(10, s.meanLogE).toPrecision(2)} kPa`;
    if (force || (now - this.lastPlotAt > 120)) { this.redrawPlots(); this.gauge.update(s.deposition, s.degradation); this.lastPlotAt = now; }
    if (force || now - this.lastSentenceAt > 700) {
      const eq = appEl('equilibrium');
      eq.textContent = copyEquilibriumSentence(s);
      const ratio = (s.deposition + 1e-9) / (s.degradation + 1e-9);
      eq.dataset.state = ratio > 1.15 ? 'condensing' : ratio < 0.87 ? 'evaporating' : 'steady';
      this.lastSentenceAt = now;
    }
  }
  redrawPlots() { for (const p of Object.values(this.plots)) p.plot.draw(); }

  flash(msg) {
    const eq = appEl('equilibrium'); eq.textContent = msg; this.lastSentenceAt = performance.now() + 2500;
  }

  // ---------- export ----------
  captureExport() {
    const t = this.model.state.time;
    if (t + 1e-9 >= this.nextExportT) {
      this.exportFrames.push(this.model.snapshot());
      this.nextExportT = t + this.exportEvery;
      if (this.exportFrames.length > 120) this.exportFrames.shift();
    }
  }
  exportJSON() {
    const st = this.model.state;
    const payload = {
      meta: { N: st.N, L: 1, K: this.params.K || 3, dtDays: this.model.params.dt, scenario: this.scenarioKey, dials: Object.assign({}, st.dials), exportEveryDays: this.exportEvery },
      frames: this.exportFrames,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tissue-weather-${this.scenarioKey}-day${st.time.toFixed(0)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.tissueApp = new TissueApp(); });
