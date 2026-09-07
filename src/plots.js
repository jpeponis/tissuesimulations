// plots.js — 2D canvas readouts for Tissue Weather: rolling time-series strips
// and the deposition/degradation "flux gauge". No dependencies, no DOM lookups
// beyond the canvas handed in. Colours are passed in by the app so the same
// tokens drive the 3D scene, the legend and the charts.
//
// Sizing is cached: a ResizeObserver (or, without one, the window resize event)
// records the canvas's CSS box once per resize, so draw() never calls
// getBoundingClientRect. Hover uses offsetX for the same reason.
//
// Ghost traces: setReference() snapshots the current series as dashed reference
// lines that stay drawn until clearReference(). The app calls it on Reset so
// the previous run stays visible for comparison.
import { copyFormatRate } from './copy.js';

const PLOT_FONT = '11px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

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

/**
 * Rolling time-series strip.
 * spec = {
 *   series: [{ key, label, color, stack: bool }],   // stacked series drawn as areas from the baseline
 *   yDomain: [0, 1] | 'auto',
 *   yFormat: fn(v) -> string,
 *   windowDays: 90,
 *   theme: { text, muted, grid, surface }
 * }
 * push(t, values) takes values keyed by series key. draw() is cheap enough to
 * call on every push, but the app throttles it (≤ 8 Hz).
 */
export class TimeSeriesPlot {
  constructor(canvas, spec) {
    this.canvas = canvas;
    this.spec = Object.assign({ yDomain: [0, 1], windowDays: 90, yFormat: (v) => v.toFixed(2) }, spec);
    this.t = [];
    this.data = {};
    for (const s of this.spec.series) this.data[s.key] = [];
    this.ref = null; // { t: [], data: {} } — ghost of a previous run
    this.hoverX = null;
    this.size = { w: canvas.clientWidth || 0, h: canvas.clientHeight || 0 };
    this._unwatch = plotWatchSize(canvas, (w, h) => {
      const changed = w !== this.size.w || h !== this.size.h;
      this.size = { w, h };
      if (changed) this.draw();
    });
    this._onMove = (e) => { this.hoverX = e.offsetX; this.draw(); };
    this._onLeave = () => { this.hoverX = null; this.draw(); };
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);
  }

  dispose() {
    this._unwatch();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  clear() {
    this.t.length = 0;
    for (const k in this.data) this.data[k].length = 0;
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
    }
  }

  draw() {
    const set = plotSetupCanvas(this.canvas, this.size);
    if (!set) return;
    const { ctx, w, h } = set;
    const th = this.spec.theme;
    const padL = 6, padR = 44, padT = 8, padB = 16;
    const pw = w - padL - padR, ph = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    ctx.font = PLOT_FONT;
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
    ctx.textAlign = 'left'; ctx.fillText(`d ${t0.toFixed(0)}`, padL, h - 6);
    ctx.textAlign = 'right'; ctx.fillText(`d ${t1.toFixed(0)}`, padL + pw, h - 6);

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

    if (n < 2) return;

    // stacked areas first (from baseline), with a 1px surface gap between bands
    const base = new Float64Array(n);
    for (const s of this.spec.series) {
      if (!s.stack) continue;
      const vals = this.data[s.key];
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(base[i] + vals[i]));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(this.t[i]), Y(base[i]) + (base[i] > 0 ? -1 : 0));
      ctx.closePath();
      ctx.fillStyle = s.color; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(base[i] + vals[i]));
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.stroke();
      for (let i = 0; i < n; i++) base[i] += vals[i];
    }
    // lines
    for (const s of this.spec.series) {
      if (s.stack) continue;
      const vals = this.data[s.key];
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(X(this.t[i]), Y(vals[i]));
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    }
    // emphasised endpoints (identity never by colour alone: the keys row and the table carry the names)
    let acc = 0;
    for (const s of this.spec.series) {
      const v = this.data[s.key][n - 1];
      const yv = s.stack ? (acc + v) : v;
      if (s.stack) acc += v;
      const x = X(this.t[n - 1]), y = Y(yv);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = th.surface; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // hover crosshair + tooltip
    if (this.hoverX != null && this.hoverX >= padL && this.hoverX <= padL + pw) {
      const th_ = (this.hoverX - padL) / pw * (t1 - t0) + t0;
      let i = 0; while (i < n - 1 && this.t[i + 1] < th_) i++;
      const x = X(this.t[i]);
      ctx.strokeStyle = th.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + ph); ctx.stroke(); ctx.setLineDash([]);
      const lines = [`day ${this.t[i].toFixed(1)}`].concat(this.spec.series.map((s) => `${s.label} ${this.spec.yFormat(this.data[s.key][i])}`));
      if (refN >= 2) {
        let j = 0; while (j < refN - 1 && ref.t[j + 1] < th_) j++;
        if (Math.abs(ref.t[j] - th_) < (t1 - t0) / 20) for (const s of this.spec.series) lines.push(`prev. ${s.label} ${this.spec.yFormat(ref.data[s.key][j])}`);
      }
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
      const tx = x + 8 + tw > padL + pw ? x - 8 - tw : x + 8;
      const ty = padT + 2;
      ctx.fillStyle = th.surface; ctx.globalAlpha = 0.92;
      ctx.fillRect(tx, ty, tw, 14 * lines.length + 6); ctx.globalAlpha = 1;
      ctx.strokeStyle = th.grid; ctx.strokeRect(tx + 0.5, ty + 0.5, tw, 14 * lines.length + 6);
      ctx.textAlign = 'left';
      lines.forEach((l, k) => {
        ctx.fillStyle = k === 0 ? th.muted : th.text;
        ctx.fillText(l, tx + 6, ty + 10 + 14 * k);
      });
    }
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
 */
export class FluxGauge {
  constructor(canvas, theme, labels = {}) {
    this.canvas = canvas; this.theme = theme; this.dep = 0; this.deg = 0; this.scaf = 0;
    this.labels = Object.assign({ left: 'evaporating', right: 'condensing', ratio: 'deposition / degradation', scaffold: 'scaffold dissolving' }, labels);
    this.size = { w: canvas.clientWidth || 0, h: canvas.clientHeight || 0 };
    this._tall = false;
    this._unwatch = plotWatchSize(canvas, (w, h) => {
      const changed = w !== this.size.w || h !== this.size.h;
      this.size = { w, h };
      if (changed) this.draw();
    });
  }
  dispose() { this._unwatch(); }
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
    ctx.font = PLOT_FONT; ctx.textBaseline = 'middle';
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
