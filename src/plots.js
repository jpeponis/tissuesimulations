// plots.js — 2D canvas readouts for Tissue Weather: rolling time-series strips
// and the deposition/degradation "flux gauge". No dependencies, no DOM lookups
// beyond the canvas handed in. Colours are passed in by the app so the same
// tokens drive the 3D scene, the legend and the charts.

const PLOT_FONT = '11px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function plotSetupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(rect.width));
  const h = Math.max(10, Math.round(rect.height));
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
 */
export class TimeSeriesPlot {
  constructor(canvas, spec) {
    this.canvas = canvas;
    this.spec = Object.assign({ yDomain: [0, 1], windowDays: 90, yFormat: (v) => v.toFixed(2) }, spec);
    this.t = [];
    this.data = {};
    for (const s of this.spec.series) this.data[s.key] = [];
    this.hoverX = null;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.draw(); });
  }

  clear() {
    this.t.length = 0;
    for (const k in this.data) this.data[k].length = 0;
  }

  push(t, values) {
    const n = this.t.length;
    if (n && t - this.t[n - 1] < 0.1) return; // ~0.1 d resolution is plenty for a 90 d strip
    this.t.push(t);
    for (const s of this.spec.series) this.data[s.key].push(values[s.key]);
    const minT = t - this.spec.windowDays;
    let drop = 0;
    while (drop < this.t.length && this.t[drop] < minT) drop++;
    if (drop > 0) {
      this.t.splice(0, drop);
      for (const k in this.data) this.data[k].splice(0, drop);
    }
  }

  draw() {
    const { ctx, w, h } = plotSetupCanvas(this.canvas);
    const th = this.spec.theme;
    const padL = 6, padR = 44, padT = 8, padB = 16;
    const pw = w - padL - padR, ph = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    ctx.font = PLOT_FONT;
    ctx.textBaseline = 'middle';

    const n = this.t.length;
    const t0 = n ? Math.max(this.t[0], this.t[n - 1] - this.spec.windowDays) : 0;
    const t1 = n ? Math.max(this.t[n - 1], t0 + 5) : 5;

    // y domain
    let y0 = 0, y1 = 1;
    if (this.spec.yDomain === 'auto') {
      y0 = Infinity; y1 = -Infinity;
      for (const s of this.spec.series) for (const v of this.data[s.key]) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
      if (!isFinite(y0)) { y0 = 0; y1 = 1; }
      if (y1 - y0 < 1e-6) { y0 -= 0.5; y1 += 0.5; }
      const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
    } else { [y0, y1] = this.spec.yDomain; }
    // stacked series may exceed the domain top: widen if needed
    if (this.spec.yDomain !== 'auto') {
      let maxStack = 0;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (const s of this.spec.series) if (s.stack) acc += this.data[s.key][i];
        if (acc > maxStack) maxStack = acc;
      }
      if (maxStack > y1) y1 = Math.ceil(maxStack * 4) / 4;
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

    if (n < 2) return;

    // stacked areas first (from baseline), with a 1px surface gap between bands
    let base = new Float64Array(n);
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
    // emphasised endpoints + direct labels (identity never by colour alone)
    ctx.textAlign = 'left';
    let acc = 0;
    const labelYs = [];
    for (const s of this.spec.series) {
      const v = this.data[s.key][n - 1];
      const yv = s.stack ? (acc + v) : v;
      if (s.stack) acc += v;
      const x = X(this.t[n - 1]), y = Y(yv);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = th.surface; ctx.lineWidth = 1.5; ctx.stroke();
      labelYs.push({ y, label: s.label, v: this.spec.yFormat(v) });
    }
    // hover crosshair + tooltip
    if (this.hoverX != null && this.hoverX >= padL && this.hoverX <= padL + pw) {
      const th_ = (this.hoverX - padL) / pw * (t1 - t0) + t0;
      let i = 0; while (i < n - 1 && this.t[i + 1] < th_) i++;
      const x = X(this.t[i]);
      ctx.strokeStyle = th.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + ph); ctx.stroke(); ctx.setLineDash([]);
      const lines = [`day ${this.t[i].toFixed(1)}`].concat(this.spec.series.map((s) => `${s.label} ${this.spec.yFormat(this.data[s.key][i])}`));
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
 */
export class FluxGauge {
  constructor(canvas, theme) {
    this.canvas = canvas; this.theme = theme; this.dep = 0; this.deg = 0;
  }
  update(dep, deg) { this.dep = dep; this.deg = deg; this.draw(); }
  draw() {
    const { ctx, w, h } = plotSetupCanvas(this.canvas);
    const th = this.theme;
    ctx.clearRect(0, 0, w, h);
    ctx.font = PLOT_FONT; ctx.textBaseline = 'middle';
    const cx = w / 2, barY = 18, barH = 10, half = w / 2 - 12;
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
    ctx.fillStyle = th.muted; ctx.textAlign = 'left'; ctx.fillText('evaporating', cx - half, barY + barH + 12);
    ctx.textAlign = 'right'; ctx.fillText('condensing', cx + half, barY + barH + 12);
    ctx.textAlign = 'center'; ctx.fillStyle = th.text;
    const r = ratio > 99 ? '>99' : ratio.toFixed(2);
    ctx.fillText(`deposition / degradation = ${r}`, cx, h - 8);
  }
}
