#!/usr/bin/env node
// blender/recipe_dump.mjs — the JS half of the Blender parity check (docs/REVIEW.md E2, E3, E5).
//
//   node blender/recipe_dump.mjs [--N 2] [--K 1] [--seed 90210] > dump.json
//
// Prints, as one JSON object, everything `blender/import_tissue.py` re-implements in python:
// the fiber recipe constants and one full per-instance layout (src/recipe.js), the per-frame
// fiber laws sampled on a grid, the cell colour ramp LUT and the cell aspect law, and the
// gel / scaffold / field-haze constants and the gel jitter stream (src/render.js).
// `blender/test_recipe_parity.py` runs this and compares its own arithmetic against it.
//
// src/recipe.js is a plain ES module and imports nothing, so it is used directly. src/render.js
// imports three, which node cannot resolve here (there is no node_modules), so the four PURE
// static colour helpers are lifted out of its source text and evaluated on their own — the test
// therefore still runs the renderer's real code, and renaming one of them fails loudly instead
// of silently comparing a copy against itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RECIPE_FIBER, recipeRng, recipeFiberLayout, recipeFiberScales, recipeFiberRadius, recipeFiberLength, recipeFiberFade, recipeFiberDir, recipeRenderMeta } from '../src/recipe.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return +argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? +eq.slice(name.length + 3) : dflt;
};

const N = arg('N', 2), K = arg('K', 1), SEED = arg('seed', RECIPE_FIBER.seed);

// --- src/render.js: lift the pure colour statics out of the source ----------------------------
const RENDER_SRC = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');

/** `n` source lines starting at the line that contains `anchor` (exact substring). */
function liftLines(anchor, n) {
  const at = RENDER_SRC.indexOf(anchor);
  if (at < 0) throw new Error(`src/render.js no longer contains ${JSON.stringify(anchor)} — update blender/recipe_dump.mjs`);
  const from = RENDER_SRC.lastIndexOf('\n', at) + 1;
  return RENDER_SRC.slice(from).split('\n').slice(0, n).join('\n');
}

/** One capture group out of src/render.js's source, or a loud failure. */
function liftNumber(re, what) {
  const m = RENDER_SRC.match(re);
  if (!m) throw new Error(`src/render.js: cannot find ${what} — update blender/recipe_dump.mjs`);
  return m.slice(1).map(Number);
}

/** The text of `static <name>(...) { … }` from a class body, braces balanced. */
function liftStatic(name) {
  const at = RENDER_SRC.indexOf(`static ${name}(`);
  if (at < 0) throw new Error(`src/render.js no longer defines static ${name}() — update blender/recipe_dump.mjs`);
  let i = RENDER_SRC.indexOf('{', at), depth = 0;
  for (let j = i; j < RENDER_SRC.length; j++) {
    const c = RENDER_SRC[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return RENDER_SRC.slice(at, j + 1);
  }
  throw new Error(`src/render.js: unbalanced braces in static ${name}()`);
}

// three's Color converts an sRGB hex into the linear working space with these constants
// (three/src/math/ColorManagement.js SRGBToLinear); the python side uses the same.
const srgbToLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const hexToLinear = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
};

const lutNMatch = RENDER_SRC.match(/const RENDER_LUT_N = (\d+)/);
if (!lutNMatch) throw new Error('src/render.js no longer defines RENDER_LUT_N');
const RENDER_LUT_N = +lutNMatch[1];

const shim = `const RENDER_LUT_N = ${RENDER_LUT_N};
export class TissueRenderer {
${['_saturate', '_toOklab', '_fromOklab', '_rampLUT'].map(liftStatic).join('\n')}
}`;
const { TissueRenderer } = await import(`data:text/javascript;base64,${Buffer.from(shim).toString('base64')}`);
// `_lin` itself cannot be lifted (it goes through THREE.Color); this is the same conversion,
// with three's own sRGB→linear constants, which the python side also mirrors.
TissueRenderer._lin = (css, sat = 1) => TissueRenderer._saturate(hexToLinear(css), sat);

// --- the fiber recipe (E2) --------------------------------------------------------------------
const lay = recipeFiberLayout(N, K, SEED);
const h = 1 / N;
const sc = recipeFiberScales(h, null);

const RHOS = [0, 0.005, 0.0105, 0.011, 0.02, 0.029999, 0.03, 0.1, 0.5, 1, 1.9, 2, 3];
const FAS = [0, 0.05, 0.25, 0.5, 0.75, 1];
const laws = [];
for (const rho of RHOS) {
  for (const fa of FAS) {
    laws.push({ rho, fa, fade: recipeFiberFade(rho, sc), radius: recipeFiberRadius(rho, sc), length: recipeFiberLength(fa, sc) });
  }
}

// direction law: a spread of principal axes, anisotropies and per-rod random vectors
const dirs = [];
const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const UAX = [[0, 0, 1], [1, 0, 0], [0.3, -0.5, 0.81], [-0.6, 0.2, -0.77]].map(norm);
const RAX = [[0, 0, 1], [0, 0, -1], [0.5, 0.5, 0.7071], [-0.9, 0.1, 0.42], [0.3, -0.5, 0.81]].map(norm);
const out3 = new Float64Array(3);
for (const u of UAX) for (const r of RAX) for (const a of [0, 0.25, 0.5, 0.9, 1]) {
  recipeFiberDir(out3, u[0], u[1], u[2], a, r[0], r[1], r[2]);
  dirs.push({ u, r, a, d: [out3[0], out3[1], out3[2]] });
}

// --- one finished frame of rods (the composition src/render.js `_updateFibers` performs) -------
// A synthetic N³ state: per voxel a density, an anisotropy and a principal axis. Everything the
// renderer does per instance — pick the direction, scale the length and radius by the per-rod
// jitters, place the rod at its layout base — happens here in the same order, so the python
// `fiber_segments()` can be compared endpoint by endpoint, not just law by law.
const V = N * N * N;
const rho = new Float64Array(V), faArr = new Float64Array(V), fvec = new Float64Array(3 * V);
for (let v = 0; v < V; v++) {
  rho[v] = [0, 0.004, 0.012, 0.02, 0.05, 0.3, 1.0, 2.4][v % 8];
  faArr[v] = [0, 0.2, 0.55, 0.95][v % 4];
  const ang = 0.7 * v;
  const ax = Math.cos(ang), ay = Math.sin(ang) * 0.6, az = Math.sin(ang * 1.7);
  const n = Math.hypot(ax, ay, az) || 1;
  fvec[3 * v] = ax / n; fvec[3 * v + 1] = ay / n; fvec[3 * v + 2] = az / n;
}
const rods = [];
for (let v = 0; v < V; v++) {
  const r = rho[v];
  const fade = recipeFiberFade(r, sc);
  if (!(fade > 0)) continue;
  const a = faArr[v];
  const ux = fvec[3 * v], uy = fvec[3 * v + 1], uz = fvec[3 * v + 2];
  const rad0 = recipeFiberRadius(r, sc) * fade, len0 = recipeFiberLength(a, sc);
  for (let q = 0; q < K; q++) {
    const o = v * K + q, o3 = 3 * o;
    recipeFiberDir(out3, ux, uy, uz, a, lay.rvec[o3], lay.rvec[o3 + 1], lay.rvec[o3 + 2]);
    const half = 0.5 * len0 * lay.jit[2 * o], rr = rad0 * lay.jit[2 * o + 1];
    const bx = lay.base[o3], by = lay.base[o3 + 1], bz = lay.base[o3 + 2];
    rods.push({
      v, q, radius: rr,
      p0: [bx - out3[0] * half, by - out3[1] * half, bz - out3[2] * half],
      p1: [bx + out3[0] * half, by + out3[1] * half, bz + out3[2] * half],
    });
  }
}

// --- the cell colour ramp (E3) and the aspect law (E5) ----------------------------------------
// The renderer's defaults, read out of its own constructor so a retune moves both sides at once.
const optOf = (key) => {
  const m = RENDER_SRC.match(new RegExp(`[\\n,]\\s*${key}:\\s*([^,\\n]+),`));
  if (!m) throw new Error(`src/render.js: no default for opts.${key}`);
  return m[1].trim();
};
const CELL_MID = optOf('cellColorMid').replace(/'/g, '').trim();
const CELL_LIFT = +optOf('cellMidLift');
const CELL_RAMP = optOf('cellRamp').replace(/'/g, '').trim();
const CELL_ASPECT_EXP = +optOf('cellAspectExp');
const CELL_SAT = +optOf('cellSaturation');

// WHICH colours a `colors` array turns into: the renderer's own three lines out of setTissue,
// run here rather than restated, because a two-entry array and a three-entry one do different
// things (the third entry is the ramp's MID, and the end colour still comes from colors[1]) and
// the importer has to follow whatever those lines say. Restating them is how the two would drift.
const selectSrc = liftLines('const c0 = TissueRenderer._lin(cols[0]', 3);
const selectRamp = new Function('TissueRenderer', 'cols', 'explicitMid',
  `${selectSrc}\n  return { c0, c1, mid };`);
const EXPLICIT_MID = CELL_MID && CELL_MID !== 'null' ? TissueRenderer._lin(CELL_MID, 1) : null;

const rampOf = (colors) => {
  const { c0, c1, mid } = selectRamp.call({ opts: { cellSaturation: CELL_SAT } }, TissueRenderer, colors, EXPLICIT_MID);
  return { lut: Array.from(TissueRenderer._rampLUT(c0, c1, CELL_RAMP, CELL_LIFT, mid)), mid: mid ? Array.from(mid) : null };
};

const PAIRS = [
  { key: 'fibroblast', colors: ['#4ea3ff', '#ff7a3d'] },        // src/tissues/fibrous.js
  { key: 'chondrocyte', colors: ['#ff7a3d', '#3fb8b0'] },       // src/tissues/cartilage.js
  { key: 'synthetic', colors: ['#7fd1ff', '#ff9a6b'] },         // blender/make_sample_trajectory.py
  // no registered tissue ships three colours yet; the format allows it and both sides must agree
  { key: 'three-colour', colors: ['#4ea3ff', '#8ad6a0', '#ff7a3d'] },
];

// --- the gel / scaffold / field haze (E5) -----------------------------------------------------
// Not laws lifted out of the renderer — they live inside instance methods that need a WebGL
// context — but their CONSTANTS, read out of the renderer's own defaults, plus the gel jitter
// STREAM, which is `recipeRng` (the real module) driven by the renderer's own seed arithmetic.
// A retune of any of them, or a moved seed, fails the python mirror instead of drifting quietly.
const [GEL_JIT_SPAN] = liftNumber(/jit\[4 \* v\] = \(rand\(\) - 0\.5\) \* ([\d.]+);/, 'the gel jitter span');
const [GEL_SIZE_MIN, GEL_SIZE_SPAN] = liftNumber(/jit\[4 \* v \+ 3\] = ([\d.]+) \+ ([\d.]+) \* rand\(\);/, 'the gel size jitter');
const [GEL_XOR] = liftNumber(/const rand = recipeRng\(this\.opts\.seed \^ (0x[0-9a-f]+)\);/i, 'the gel jitter seed');
const [FIELD_XOR, FIELD_STRIDE] = liftNumber(/_jitterPoints\(N, centers, \(this\.opts\.seed \^ (0x[0-9a-f]+)\) \+ (\d+) \* i,/i, 'the field cloud seed');
const HAZE = {
  gelMin: +optOf('gelMin'), gelSize: +optOf('gelSize'), gelOpacity: +optOf('gelOpacity'),
  gelCellFade: +optOf('gelCellFade'),
  gelJitterSpan: GEL_JIT_SPAN, gelSizeJitter: [GEL_SIZE_MIN, GEL_SIZE_SPAN], gelSeedXor: GEL_XOR,
  scaffoldMin: +optOf('scaffoldMin'), scaffoldRadius: +optOf('scaffoldRadius'),
  scaffoldMinRadius: +optOf('scaffoldMinRadius'), scaffoldOpacity: +optOf('scaffoldOpacity'),
  scaffoldAlphaExp: +optOf('scaffoldAlphaExp'), scaffoldRadiusExp: +optOf('scaffoldRadiusExp'),
  scaffoldBreak: +optOf('scaffoldBreak'),
  pointSize: +optOf('pointSize'), pointOpacity: +optOf('pointOpacity'), pointMin: +optOf('pointMin'),
  fieldSeedXor: FIELD_XOR, fieldSeedStride: FIELD_STRIDE,
};

// the gel jitter stream for this N and seed: three offsets (× h) and a size factor per voxel,
// four draws each, exactly as _buildGel consumes them
const gelJit = [];
{
  const rand = recipeRng((SEED ^ GEL_XOR) >>> 0);
  for (let v = 0; v < N * N * N; v++) {
    gelJit.push((rand() - 0.5) * GEL_JIT_SPAN, (rand() - 0.5) * GEL_JIT_SPAN, (rand() - 0.5) * GEL_JIT_SPAN,
      GEL_SIZE_MIN + GEL_SIZE_SPAN * rand());
  }
}

const ASPECTS = [];
for (const asp of [1, 1.4, 1.8, 2.2, 2.5]) for (const r of [0.03, 0.035, 0.0416]) {
  ASPECTS.push({ aspect: asp, radius: r, long: r * Math.pow(asp, CELL_ASPECT_EXP), short: r * Math.pow(asp, CELL_ASPECT_EXP - 1) });
}

process.stdout.write(JSON.stringify({
  source: 'src/recipe.js + src/render.js',
  recipe: RECIPE_FIBER,
  renderMeta: recipeRenderMeta(null),
  layout: { N, K, seed: SEED, h, count: lay.count, base: Array.from(lay.base), rvec: Array.from(lay.rvec), jit: Array.from(lay.jit) },
  scales: sc,
  laws,
  dirs,
  frame: { rho: Array.from(rho), fa: Array.from(faArr), f: Array.from(fvec), rods },
  cell: { lutN: RENDER_LUT_N, mid: CELL_MID, lift: CELL_LIFT, mode: CELL_RAMP, saturation: CELL_SAT, aspectExp: CELL_ASPECT_EXP },
  ramps: PAIRS.map((p) => Object.assign({ key: p.key, colors: p.colors }, rampOf(p.colors))),
  aspects: ASPECTS,
  haze: HAZE,
  gelJit,
}) + '\n');
