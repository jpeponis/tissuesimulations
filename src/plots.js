// plots.js — 2D canvas readouts for Tissue Weather: rolling time-series strips
// and the deposition/degradation "flux gauge". No dependencies, no DOM lookups
// beyond the canvas handed in. Colours are passed in by the app so the same
// tokens drive the 3D scene, the legend and the charts.
//
// Sizing is cached: a ResizeObserver (or, without one, the window resize event)
// records the canvas's CSS box once per resize, so draw() never calls
// getBoundingClientRect. Hover uses offsetX for the same reason and is throttled
// to one redraw per animation frame.
//
// Not by colour alone (docs/REVIEW.md B5): a series may carry `marker`
// ('circle' | 'square' | 'diamond', drawn at the endpoint and mirrored in the app's key row)
// and a stacked band may carry `pattern: 'hatch'`, so two series that are luminance twins are
// still told apart in greyscale. Live series are never dashed — dashes mean "previous run".
//
// Keyboard (docs/REVIEW.md C4): a focused canvas takes ←/→ (step the crosshair), Home / End
// (first / last sample) and Esc (drop it); `onHover(lines, i)` reports the tooltip text so the
// app can mirror it into its screen-reader status region.
//
// Marks (docs/REVIEW.md C11): mark(t, label, key) puts a dashed 1 px rule with a letter on the
// time axis — a dial change, an injury — and the tooltip lists the marks near the hovered day.
//
// Ghost traces: setReference() snapshots the current series as dashed reference
// lines that stay drawn until clearReference(). The app calls it on Reset so
// the previous run stays visible for comparison.
import { copyFormatRate } from './copy.js';

const PLOT_FONT_FAMILY = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const PLOT_FONT_PX = 11;
const PLOT_MARK_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // I and O left out: they read as 1 and 0
function plotFont(px) { return `${px}px ${PLOT_FONT_FAMILY}`; }

/** Watch a canvas's CSS size; calls onSize(w, h) now and whenever it changes. */
function plotWatchSize(canvas, onSize) {
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      onSize(r.width, r.height);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }
  const read = () => onSize(canvas.clientWidth, canvas.clientHeight);
  read();
  window.addEventListener('resize', read);
  return () => window.removeEventListener('resize', read);
}

/** Prepare the backing store for the cached CSS size; null while the canvas has no size. */
function plotSetupCanvas(canvas, size) {
  const w = Math.round(size.w), h = Math.round(size.h);
  if (!(w >= 10) || !(h >= 10)) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** One marker glyph, centred on (x, y): the shape a series is identified by without colour. */
function plotMarker(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (shape === 'diamond') { const d = r * 1.35; ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

/**
 * Rolling time-series strip.
 * spec = {
 *   series: [{ key, label, color, stack: bool,
 *              marker: 'circle'|'square'|'diamond',   // endpoint glyph (default circle)
 *              pattern: 'hatch' }],                   // stacked band overlaid with diagonals
 *   yDomain: [0, 1] | 'auto',
 *   yFormat: fn(v) -> string,
 *   windowDays: 90,
 *   fontPx: 11,                                       // presentation mode scales this up
 *   onHover: fn(lines, i, source) -> void,            // crosshair moved (lines null when dropped);
 *                                                     // source is 'pointer' | 'key' | null
 *   theme: { text, muted, grid, surface }
 * }
 * push(t, values) takes values keyed by series key. draw() is cheap enough to
 * call on every push, but the app throttles it (≤ 8 Hz).
 */
export class TimeSeriesPlot {
  constructor(canvas, spec) {
    this.canvas = canvas;
    this.spec = Object.assign({ yDomain: [0, 1], windowDays: 90, fontPx: PLOT_FONT_PX, onHover: null, yFormat: (v) => v.toFixed(2) }, spec);
    this.t = [];
    this.data = {};
    for (const s of this.spec.series) this.data[s.key] = [];
    this.ref = null;   // { t: [], data: {} } — ghost of a previous run
    this.marks = [];   // [{ t, label, key, letter }] — dial changes and injuries on the time axis
    this.hoverI = null;    // index into this.t, from the pointer or the keyboard
    this._hoverSrc = null; // 'pointer' | 'key'
    this._lastHoverKey = '';
    this._raf = 0;
    this.size = { w: canvas.clientWidth || 0, h: canvas.clientHeight || 0 };
    this._unwatch = plotWatchSize(canvas, (w, h) => {
      const changed = w !== this.size.w || h !== this.size.h;
      this.size = { w, h };
      if (changed) this.draw();
    });
    // pointer hover, coalesced to one redraw per frame (a pointermove per pixel is free then)
    this._onMove = (e) => { this._pendingX = e.offsetX; this._schedule(); };
    this._onLeave = () => { this._pendingX = null; this.setHover(null, 'pointer'); };
    this._onKey = (e) => this._handleKey(e);
    this._onBlur = () => { if (this._hoverSrc === 'key') this.setHover(null, 'key'); };
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);
    canvas.addEventListener('keydown', this._onKey);
    canvas.addEventListener('blur', this._onBlur);
  }

  dispose() {
    this._unwatch();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.canvas.removeEventListener('keydown', this._onKey);
    this.canvas.removeEventListener('blur', this._onBlur);
  }

  _schedule() {
    if (this._raf || typeof requestAnimationFrame !== 'function') { this._applyPointer(); return; }
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._applyPointer(); });
  }
  _applyPointer() {
    const x = this._pendingX;
    if (x == null) return;
    this.setHover(this._indexAtX(x), 'pointer');
  }

  clear() {
    this.t.length = 0;
    for (const k in this.data) this.data[k].length = 0;
    this.marks.length = 0;
    this.setHover(null, this._hoverSrc || 'pointer');
  }

  /** Snapshot the current run as the dashed reference. Returns false if there is nothing to keep. */
  setReference() {
    if (this.t.length < 2) return false;
    const data = {};
    for (const k in this.data) data[k] = this.data[k].slice();
    this.ref = { t: this.t.slice(), data };
    return true;
  }
  clearReference() { this.ref = null; }
  hasReference() { return !!this.ref; }

  /**
   * A mark on the time axis (C11): a dial change, an injury. Debounced on SIMULATED time —
   * a mark within one day of the previous mark with the SAME key updates that one instead of
   * adding another, so dragging a slider for a few seconds leaves one rule, not thirty.
   * Every mark gets a letter (A, B, C …) so the rule can be named in the tooltip.
   */
  mark(t, label, key) {
    if (!Number.isFinite(t)) return null;
    if (key != null) {
      for (let i = this.marks.length - 1; i >= 0; i--) {
        const m = this.marks[i];
        if (m.key !== String(key)) continue;
        if (Math.abs(m.t - t) < 1) { m.label = String(label || ''); return m; }   // same dial, same day: one mark
        break;
      }
    }
    const m = { t, label: String(label || ''), key: key == null ? null : String(key), letter: PLOT_MARK_LETTERS[this.marks.length % PLOT_MARK_LETTERS.length] };
    this.marks.push(m);
    if (this.marks.length > 64) this.marks.shift();
    return m;
  }
  clearMarks() { this.marks.length = 0; }

  /** Latest value of a series (NaN if none). */
  last(key) { const a = this.data[key]; return a && a.length ? a[a.length - 1] : NaN; }

  push(t, values) {
    const n = this.t.length;
    if (n && t - this.t[n - 1] < 0.1) return; // ~0.1 d resolution is plenty for a 90 d strip
    this.t.push(t);
    for (const s of this.spec.series) { const v = values[s.key]; this.data[s.key].push(Number.isFinite(v) ? v : 0); }
    const minT = t - this.spec.windowDays;
    let drop = 0;
    while (drop < this.t.length && this.t[drop] < minT) drop++;
    if (drop > 0) {
      this.t.splice(0, drop);
      for (const k in this.data) this.data[k].splice(0, drop);
      if (this.hoverI != null) this.hoverI = Math.max(0, this.hoverI - drop);
    }
    let dm = 0;
    while (dm < this.marks.length && this.marks[dm].t < minT) dm++;
    if (dm > 0) this.marks.splice(0, dm);
  }

  // ---------------------------------------------------------------- crosshair
  _plotBox(w, h) {
    const f = this.spec.fontPx || PLOT_FONT_PX;
    const padL = 6, padR = Math.round(44 * f / PLOT_FONT_PX), padT = Math.round(8 * f / PLOT_FONT_PX), padB = Math.round(16 * f / PLOT_FONT_PX);
    return { padL, padR, padT, padB, pw: w - padL - padR, ph: h - padT - padB, f };
  }
  _indexAtX(x) {
    const n = this.t.length;
    if (!n) return null;
    const { padL, pw } = this._plotBox(Math.round(this.size.w), Math.round(this.size.h));
    if (pw <= 0 || x < padL || x > padL + pw) return null;
    const t0 = Math.max(this.t[0], this.t[n - 1] - this.spec.windowDays);
    const t1 = Math.max(this.t[n - 1], t0 + 5);
    const th = (x - padL) / pw * (t1 - t0) + t0;
    let i = 0; while (i < n - 1 && this.t[i + 1] < th) i++;
    return i;
  }
  /** Move (or drop) the crosshair. Redraws and reports the tooltip lines through onHover. */
  setHover(i, source) {
    const n = this.t.length;
    const next = i == null || !n ? null : Math.max(0, Math.min(n - 1, i));
    const changed = next !== this.hoverI;
    this.hoverI = next;
    this._hoverSrc = next == null ? null : (source || 'pointer');
    this.draw();
    const cb = this.spec.onHover;
    if (typeof cb === 'function') {
      const lines = next == null ? null : this.hoverLines(next);
      const key = lines ? lines.join(' | ') : '';
      if (changed || key !== this._lastHoverKey) { this._lastHoverKey = key; cb(lines, next, this._hoverSrc); }
    }
    return changed;
  }
  hasHover() { return this.hoverI != null; }

  /** The tooltip, as text: day, every series, the marks near it, and the ghost when it lines up. */
  hoverLines(i) {
    const n = this.t.length;
    if (!n) return null;
    const idx = Math.max(0, Math.min(n - 1, i));
    const t = this.t[idx];
    const lines = [`day ${t.toFixed(1)}`];
    for (const s of this.spec.series) lines.push(`${s.label} ${this.spec.yFormat(this.data[s.key][idx])}`);
    const t0 = Math.max(this.t[0], this.t[n - 1] - this.spec.windowDays);
    const t1 = Math.max(this.t[n - 1], t0 + 5);
    const near = (t1 - t0) / 20;
    for (const m of this.marks) if (Math.abs(m.t - t) <= near) lines.push(`${m.letter}: ${m.label}`);
    const ref = this.ref, refN = ref ? ref.t.length : 0;
    if (refN >= 2) {
      let j = 0; while (j < refN - 1 && ref.t[j + 1] < t) j++;
      if (Math.abs(ref.t[j] - t) < near) for (const s of this.spec.series) lines.push(`prev. ${s.label} ${this.spec.yFormat(ref.data[s.key][j])}`);
    }
    return lines;
  }

  /** ←/→ step the crosshair, Home / End jump, Esc drops it. Everything else is left to the app. */
  _handleKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = this.t.length;
    const k = e.key;
    if (k === 'Escape') { if (this.hoverI == null) return; this.setHover(null, 'key'); e.preventDefault(); return; }
    if (!n) return;
    let i = this.hoverI;
    if (k === 'ArrowLeft') i = i == null ? n - 1 : i - 1;
    else if (k === 'ArrowRight') i = i == null ? n - 1 : i + 1;
    else if (k === 'Home') i = 0;
    else if (k === 'End') i = n - 1;
    else return;
    this.setHover(Math.max(0, Math.min(n - 1, i)), 'key');
    e.preventDefault();
  }

  draw() {
    const set = plotSetupCanvas(this.canvas, this.size);
    if (!set) return;
    const { ctx, w, h } = set;
    const th = this.spec.theme;
    const { padL, padT, pw, ph, f } = this._plotBox(w, h);
    if (pw <= 0 || ph <= 0) return;
    ctx.clearRect(0, 0, w, h);
    ctx.font = plotFont(f);
    ctx.textBaseline = 'middle';

    const n = this.t.length;
    const ref = this.ref;
    const refN = ref ? ref.t.length : 0;
    // time window: the live run, or the reference while the new run is still empty
    let t0 = 0, t1 = 5;
    if (n) { t0 = Math.max(this.t[0], this.t[n - 1] - this.spec.windowDays); t1 = Math.max(this.t[n - 1], t0 + 5); }
    else if (refN) { t0 = ref.t[0]; t1 = Math.max(ref.t[refN - 1], t0 + 5); }

    // y domain
    let y0 = 0, y1 = 1;
    if (this.spec.yDomain === 'auto') {
      y0 = Infinity; y1 = -Infinity;
      for (const s of this.spec.series) for (const v of this.data[s.key]) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
      if (!isFinite(y0)) { y0 = 0; y1 = 1; }
      if (y1 - y0 < 1e-6) { y0 -= 0.5; y1 += 0.5; }
      const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
    } else { [y0, y1] = this.spec.yDomain; }
    // Data may leave the declared domain — a stack that sums past its top (cartilage matrix
    // reaches ≈ 1.5), or a line above/below it (stiffness on a log axis). Widen instead of
    // clipping, in quarter steps, over both the live run and the ghost.
    if (this.spec.yDomain !== 'auto') {
      let hi = -Infinity, lo = Infinity;
      const scan = (T, D) => {
        for (let i = 0; i < T.length; i++) {
          let acc = 0;
          for (const s of this.spec.series) {
            const v = D[s.key][i];
            if (!Number.isFinite(v)) continue;
            if (s.stack) { acc += v; if (acc > hi) hi = acc; if (acc < lo) lo = acc; }
            else { if (v > hi) hi = v; if (v < lo) lo = v; }
          }
        }
      };
      scan(this.t, this.data);
      if (ref) scan(ref.t, ref.data);
      const slack = 0.02 * (y1 - y0);          // ignore a hair over the top (a pool that saturates at 1)
      if (hi > y1 + slack) y1 = Math.ceil(hi * 4) / 4;
      if (lo < y0 - slack) y0 = Math.floor(lo * 4) / 4;
    }

    const X = (t) => padL + ((t - t0) / (t1 - t0)) * pw;
    const Y = (v) => padT + ph - ((v - y0) / (y1 - y0)) * ph;

    // recessive grid: 3 horizontal lines, labels at right
    ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
    ctx.fillStyle = th.muted; ctx.textAlign = 'left';
    const ticks = [y0, (y0 + y1) / 2, y1];
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
      ctx.fillText(this.spec.yFormat(v), padL + pw + 6, Math.min(Math.max(y, padT + 5), padT + ph - 5));
    }
    // time axis: start and end day
    ctx.textAlign = 'left'; ctx.fillText(`d ${t0.toFixed(0)}`, padL, h - Math.round(f * 0.55));
    ctx.textAlign = 'right'; ctx.fillText(`d ${t1.toFixed(0)}`, padL + pw, h - Math.round(f * 0.55));

    // marks: what the student changed, and when (C11)
    if (this.marks.length) {
      ctx.save();
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = th.muted; ctx.globalAlpha = 0.8;
      ctx.textAlign = 'center'; ctx.font = plotFont(Math.max(9, f - 2));
      for (const m of this.marks) {
        if (m.t < t0 || m.t > t1) continue;
        const x = Math.round(X(m.t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
        ctx.fillStyle = th.muted;
        ctx.fillText(m.letter, Math.min(Math.max(x, padL + 4), padL + pw - 4), padT + 4);
      }
      ctx.restore();
      ctx.font = plotFont(f);
    }

    // ghost of the previous run: dashed, clipped to the plot area
    if (refN >= 2) {
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1.25; ctx.globalAlpha = 0.75;
      const base = new Float64Array(refN);
      for (const s of this.spec.series) {
        const vals = ref.data[s.key];
        ctx.beginPath();
        for (let i = 0; i < refN; i++) ctx.lineTo(X(ref.t[i]), Y(s.stack ? base[i] + vals[i] : vals[i]));
        ctx.strokeStyle = s.color; ctx.stroke();
        if (s.stack) for (let i = 0; i < refN; i++) base[i] += vals[i];
      }
      ctx.restore();
    }

    if (n < 2) { this._drawCrosshair(ctx, { X, Y, padL, padT, pw, ph, w, h, f, th }); return; }

    // stacked areas first (from baseline), with a 1px surface gap between bands
    const base = new Float64Array(n);
    for (const s of this.spec.series) {
      if (!s.stack) continue;
      const vals = this.data[s.key];
      const band = () => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(base[i] + vals[i]));
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(this.t[i]), Y(base[i]) + (base[i] > 0 ? -1 : 0));
        ctx.closePath();
      };
      band();
      ctx.fillStyle = s.color; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      // a hatched band reads as itself in greyscale (B5): diagonals inside the same outline
      if (s.pattern === 'hatch') {
        ctx.save();
        band(); ctx.clip();
        ctx.strokeStyle = th.surface; ctx.globalAlpha = 0.75; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = padL - ph; x < padL + pw; x += 6) { ctx.moveTo(x, padT + ph); ctx.lineTo(x + ph, padT); }
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(base[i] + vals[i]));
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.stroke();
      for (let i = 0; i < n; i++) base[i] += vals[i];
    }
    // lines — never dashed: a dashed live line would read as the previous run
    for (const s of this.spec.series) {
      if (s.stack) continue;
      const vals = this.data[s.key];
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(vals[i]));
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; ctx.stroke();
    }
    // emphasised endpoints, by SHAPE as well as colour (the keys row mirrors the shape)
    let acc = 0;
    for (const s of this.spec.series) {
      const v = this.data[s.key][n - 1];
      const yv = s.stack ? (acc + v) : v;
      if (s.stack) acc += v;
      const x = X(this.t[n - 1]), y = Y(yv);
      ctx.fillStyle = s.color;
      plotMarker(ctx, s.marker || 'circle', x, y, 3);
      ctx.fill();
      ctx.strokeStyle = th.surface; ctx.lineWidth = 1.5; ctx.stroke();
    }
    this._drawCrosshair(ctx, { X, Y, padL, padT, pw, ph, w, h, f, th });
  }

  /** Crosshair + tooltip at hoverI (pointer or keyboard). */
  _drawCrosshair(ctx, g) {
    const i = this.hoverI;
    const n = this.t.length;
    if (i == null || !n) return;
    const idx = Math.max(0, Math.min(n - 1, i));
    const { X, padL, padT, pw, ph, th, f } = g;
    const x = X(this.t[idx]);
    if (x < padL - 1 || x > padL + pw + 1) return;
    ctx.save();
    ctx.strokeStyle = this._hoverSrc === 'key' ? th.text : th.muted;
    ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, padT); ctx.lineTo(Math.round(x) + 0.5, padT + ph); ctx.stroke();
    ctx.setLineDash([]);
    const lines = this.hoverLines(idx) || [];
    ctx.font = plotFont(f);
    const lh = Math.round(f * 1.28);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const tx = x + 8 + tw > padL + pw ? x - 8 - tw : x + 8;
    const ty = padT + 2;
    ctx.fillStyle = th.surface; ctx.globalAlpha = 0.92;
    ctx.fillRect(tx, ty, tw, lh * lines.length + 6); ctx.globalAlpha = 1;
    ctx.strokeStyle = th.grid; ctx.strokeRect(tx + 0.5, ty + 0.5, tw, lh * lines.length + 6);
    ctx.textAlign = 'left';
    lines.forEach((l, k) => {
      ctx.fillStyle = k === 0 ? th.muted : th.text;
      ctx.fillText(l, tx + 6, ty + Math.round(lh * 0.72) + lh * k);
    });
    ctx.restore();
  }
}

/**
 * Two-sided flux gauge: degradation (evaporating, cool) to the left of centre,
 * deposition (condensing, warm) to the right. The bar shows log2(dep/deg),
 * clamped to ±3, so "balanced" is the centre mark.
 *
 * A tissue whose scaffold dissolves on its own clock (a hydrogel) has a third rate
 * that is neither deposition nor degradation of tissue. update(dep, deg, scaffold)
 * with a positive third value adds a thin one-sided bar under the gauge, scaled
 * against the largest of the three rates, labelled `labels.scaffold`. Without it
 * (or with 0) the gauge is exactly the two-bar gauge it was.
 *
 * `labels` are the tissue's own words (docs/EXTENDING.md §1 `copy.gauge`): { left, right,
 * ratio (or caption), scaffold }, defaulting to the weather ones. `labels.fontPx` scales the
 * text for presentation mode. describe() is the same reading as text, for the DOM value beside
 * the title and for a screen-reader announcement (C4).
 */
export class FluxGauge {
  constructor(canvas, theme, labels = {}) {
    this.canvas = canvas; this.theme = theme; this.dep = 0; this.deg = 0; this.scaf = 0;
    const L = Object.assign({ left: 'evaporating', right: 'condensing', ratio: 'deposition / degradation', scaffold: 'scaffold dissolving' }, labels || {});
    if (L.caption && !(labels && labels.ratio)) L.ratio = L.caption;   // `caption` is the EXTENDING §1 name for it
    this.labels = L;
    this.fontPx = Number.isFinite(L.fontPx) ? L.fontPx : PLOT_FONT_PX;
    this.size = { w: canvas.clientWidth || 0, h: canvas.clientHeight || 0 };
    this._tall = false;
    this._unwatch = plotWatchSize(canvas, (w, h) => {
      const changed = w !== this.size.w || h !== this.size.h;
      this.size = { w, h };
      if (changed) this.draw();
    });
  }
  dispose() { this._unwatch(); }
  /** Text scale (presentation mode). */
  setFontPx(px) { if (Number.isFinite(px) && px !== this.fontPx) { this.fontPx = px; this.draw(); } }
  /** The gauge as one line of text: "deposition 0.05/d vs degradation 0.02/d — ratio 2.50". */
  describe() {
    const ratio = (this.dep + 1e-9) / (this.deg + 1e-9);
    const r = ratio > 99 ? '>99' : ratio.toFixed(2);
    let s = `deposition ${copyFormatRate(Math.max(0, this.dep))} vs degradation ${copyFormatRate(Math.max(0, this.deg))} — ${this.labels.ratio} = ${r}`;
    if (this.scaf > 0) s += `; ${this.labels.scaffold} ${copyFormatRate(this.scaf)}`;
    return s;
  }
  update(dep, deg, scaffold) {
    this.dep = dep; this.deg = deg;
    this.scaf = Number.isFinite(scaffold) && scaffold > 0 ? scaffold : 0;
    // the third bar needs a row of its own: grow the element once (the size watcher confirms it)
    if (this.scaf > 0 && !this._tall) { this._tall = true; this.canvas.style.height = '88px'; this.size = { w: this.size.w, h: 88 }; }
    this.draw();
  }
  draw() {
    const set = plotSetupCanvas(this.canvas, this.size);
    if (!set) return;
    const { ctx, w, h } = set;
    const th = this.theme;
    const scaf = this.scaf > 0 && h >= 80 ? this.scaf : 0;   // only once the taller box has arrived
    ctx.clearRect(0, 0, w, h);
    ctx.font = plotFont(this.fontPx); ctx.textBaseline = 'middle';
    const cx = w / 2, barY = scaf ? 14 : 18, barH = 10, half = w / 2 - 12;
    // track
    ctx.fillStyle = th.grid; ctx.fillRect(cx - half, barY, half * 2, barH);
    // value
    const ratio = (this.dep + 1e-9) / (this.deg + 1e-9);
    const lg = Math.max(-3, Math.min(3, Math.log2(ratio)));
    const len = Math.abs(lg) / 3 * half;
    ctx.fillStyle = lg >= 0 ? th.warm : th.cool;
    if (lg >= 0) ctx.fillRect(cx, barY, len, barH); else ctx.fillRect(cx - len, barY, len, barH);
    // centre tick
    ctx.fillStyle = th.text; ctx.fillRect(cx - 1, barY - 4, 2, barH + 8);
    // captions
    ctx.fillStyle = th.muted; ctx.textAlign = 'left'; ctx.fillText(this.labels.left, cx - half, barY + barH + 12);
    ctx.textAlign = 'right'; ctx.fillText(this.labels.right, cx + half, barY + barH + 12);
    if (scaf) {
      // one-sided magnitude bar: full width when the scaffold is the fastest of the three rates
      const maxRate = Math.max(scaf, Math.max(0, this.dep) || 0, Math.max(0, this.deg) || 0) || 1;
      const y = h - 36;
      ctx.fillStyle = th.grid; ctx.fillRect(cx - half, y, half * 2, 5);
      ctx.fillStyle = th.muted; ctx.fillRect(cx - half, y, 2 * half * Math.min(1, scaf / maxRate), 5);
      ctx.fillStyle = th.muted; ctx.textAlign = 'left'; ctx.fillText(this.labels.scaffold, cx - half, h - 22);
      ctx.textAlign = 'right'; ctx.fillStyle = th.text; ctx.fillText(copyFormatRate(scaf), cx + half, h - 22);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = th.text;
    const r = ratio > 99 ? '>99' : ratio.toFixed(2);
    ctx.fillText(`${this.labels.ratio} = ${r}`, cx, h - 8);
  }
}
