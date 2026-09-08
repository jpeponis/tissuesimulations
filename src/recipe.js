// Tissue Weather — fiber layout recipe (docs/REVIEW.md E2). ES module, named exports only.
//
// ONE definition of how a voxel's fiber density and orientation become K drawn rods. The web
// renderer (src/render.js) imports it; the Blender importer (blender/import_tissue.py)
// re-implements the same numbers in python. Anything that decides where a rod sits, which way
// it points, how long and how thick it is, lives here — so "the Blender render matches the web
// view" is a property of one file instead of two hand-tuned copies.
//
// Everything is deterministic: the per-instance layout is drawn from a seeded mulberry32 stream
// in a FIXED ORDER, so seed + N + K fully determine it.
//
//   per voxel v = (i·N + j)·N + k, in that index order (i outermost, k innermost)
//     per instance q = 0 … K−1
//       3 draws  offset of the rod centre inside the voxel: c + (u − 0.5)·offsetSpan·h per axis
//       2 draws  a random unit vector r_q (z = 2u − 1, φ = 2πu)
//       1 draw   length factor   lenJitterMin + lenJitterSpan·u
//       1 draw   radius factor   radJitterMin + radJitterSpan·u
//   (7 draws per instance; nothing else may consume this stream)
//
// The per-frame laws (a rod's direction, length, radius and fade-in) are pure functions of the
// voxel's fiber density ρ, its fractional anisotropy FA and its principal axis f:
//
//   direction   d = normalize( sign(f·r_q)·FA·f + (1 − FA)·r_q )      recipeFiberDir
//   length      L = h·lengthScale·(lengthBase + lengthFA·FA)·lenFactor_q
//   radius      R = max(minRadius·h, radiusBase·h·radiusScale·√min(ρ, rhoMaxDraw))·fade·radFactor_q
//   fade        1 at or above minDensity, smoothstep down to 0 at minDensity·minDensityRamp,
//               and the rod is not drawn at all below that (v0.1 cut hard at minDensity and drew
//               a hairline right up to it; fading the radius instead is docs/REVIEW.md §5)
//
// `meta.render` (what the app puts in the export so a reader can rebuild the same layout) is
// exactly what recipeRenderMeta() returns:
//
//   { recipe: 'fiber-v1', seed, K,
//     fiber: { offsetSpan, lenJitterMin, lenJitterSpan, radJitterMin, radJitterSpan,
//              radiusBase, radiusScale, minRadius, lengthScale, lengthBase, lengthFA,
//              minDensity, minDensityRamp, rhoMaxDraw } }
//
// TWO KINDS OF CONSTANT live in RECIPE_FIBER, and only one of them is overridable:
//
//   layout stream   seed, K, offsetSpan, lenJitterMin/Span, radJitterMin/Span — consumed by
//                   recipeFiberLayout() at BUILD time. `seed` and `K` are arguments, the other
//                   five are read from the frozen RECIPE_FIBER and cannot be overridden at all,
//                   so recipeRenderMeta() reports them from RECIPE_FIBER too (never through its
//                   `over` bag): meta.render can only ever describe the layout that was drawn.
//   per-frame laws  radiusBase/Scale, minRadius, lengthScale/Base/FA, minDensity, minDensityRamp,
//                   rhoMaxDraw — resolved by recipeFiberScales(h, over), so the renderer's opts
//                   (and a tissue's `render` hints) can change them; meta.render reports the
//                   resolved values, because those are the ones the browser used.
//
// Units: h = 1/N is the voxel edge in the unit cube the renderer draws in (a state in world
// units is divided by state.L first), so every length above is a fraction of the cube edge.
//
// Precision: every value is computed in double precision and only stored in a Float32Array at
// the end, so a python reader that works in float64 gets the same numbers. (The v0.1 renderer
// rounded the voxel centre to float32 first; `base` therefore differs from it by at most one
// float32 ulp — 6·10⁻⁸ of the cube edge. `rvec` and `jit` are bit-identical to v0.1.)

/** The RECIPE_FIBER keys recipeFiberLayout() consumes and no caller can override (see header). */
export const RECIPE_LAYOUT_KEYS = Object.freeze(['offsetSpan', 'lenJitterMin', 'lenJitterSpan', 'radJitterMin', 'radJitterSpan']);

/** Fiber layout constants — the v0.1 recipe, and the defaults of the matching renderer opts. */
export const RECIPE_FIBER = Object.freeze({
  seed: 90210,            // mulberry32 seed for the layout stream (recipeFiberLayout argument)
  K: 3,                   // rods drawn per voxel (recipeFiberLayout argument)
  // --- layout stream, RECIPE_LAYOUT_KEYS: build time only, NOT overridable ---
  offsetSpan: 0.9,        // rod centre jitter inside the voxel, × h, uniform in ±offsetSpan/2
  lenJitterMin: 0.78,     // per-rod length factor  = lenJitterMin + lenJitterSpan·u
  lenJitterSpan: 0.5,
  radJitterMin: 0.85,     // per-rod radius factor  = radJitterMin + radJitterSpan·u
  radJitterSpan: 0.3,
  // --- per-frame laws: recipeFiberScales(h, over) resolves these against the caller's bag ---
  radiusBase: 0.12,       // SPEC radius 0.12·h·√ρ …
  radiusScale: 0.6,       // … × this
  minRadius: 0.025,       // × h: floor so sparse fibers stay visible hairlines
  lengthScale: 1.35,      // × h
  lengthBase: 0.5,        // length ∝ (lengthBase + lengthFA·FA)
  lengthFA: 0.9,
  minDensity: 0.03,       // full-strength fibers at or above this total fiber density
  minDensityRamp: 0.35,   // fade in from minDensity·this (1 = the v0.1 hard cut, 0 = fade from ρ 0)
  rhoMaxDraw: 2,          // ρ used for the radius is clamped here
});

/**
 * One RECIPE_FIBER value, overridden by `over[key]` when that is a finite number (or a string
 * holding one — a URL parameter). Anything else, `null` and `undefined` included, falls back to
 * the constant rather than coercing to 0. The single resolver behind recipeFiberScales() and
 * recipeRenderMeta(), so "what the renderer used" and "what the export reports" can never be
 * resolved two different ways.
 */
function recipeResolve(over, key) {
  const raw = over ? over[key] : undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') { const v = +raw; if (Number.isFinite(v)) return v; }
  return RECIPE_FIBER[key];
}

/** Seeded PRNG (mulberry32) — the same stream the renderer and the importer must reproduce. */
export function recipeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic per-instance layout for an N³ grid with K rods per voxel.
 * Returns { N, K, count, h, base (3·count), rvec (3·count), jit (2·count: length, radius) };
 * `out` may carry arrays of the right length to fill in place (build time only — never per frame).
 *
 * Takes NO override bag on purpose: the five RECIPE_LAYOUT_KEYS come from the frozen
 * RECIPE_FIBER, so seed + N + K alone determine the arrangement and recipeRenderMeta() can
 * report it without a caller being able to make the two disagree.
 */
export function recipeFiberLayout(N, K = RECIPE_FIBER.K, seed = RECIPE_FIBER.seed, out = null) {
  const R = RECIPE_FIBER;
  const V = N * N * N, count = V * K, h = 1 / N;
  const fit = (a, n) => (a && a.length === n ? a : new Float32Array(n));
  const base = fit(out && out.base, count * 3);
  const rvec = fit(out && out.rvec, count * 3);
  const jit = fit(out && out.jit, count * 2);
  const rand = recipeRng(seed);
  for (let v = 0; v < V; v++) {
    const i = (v / (N * N)) | 0, j = ((v / N) | 0) % N, k = v % N;
    const cx = (i + 0.5) * h, cy = (j + 0.5) * h, cz = (k + 0.5) * h;
    for (let q = 0; q < K; q++) {
      const o = v * K + q;
      base[3 * o] = cx + (rand() - 0.5) * R.offsetSpan * h;
      base[3 * o + 1] = cy + (rand() - 0.5) * R.offsetSpan * h;
      base[3 * o + 2] = cz + (rand() - 0.5) * R.offsetSpan * h;
      const z = rand() * 2 - 1, ph = rand() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - z * z));
      rvec[3 * o] = s * Math.cos(ph); rvec[3 * o + 1] = s * Math.sin(ph); rvec[3 * o + 2] = z;
      jit[2 * o] = R.lenJitterMin + R.lenJitterSpan * rand();
      jit[2 * o + 1] = R.radJitterMin + R.radJitterSpan * rand();
    }
  }
  return { N, K, count, h, base, rvec, jit };
}

/**
 * Pre-multiplied scales for one grid spacing, so the per-frame laws below are two multiplies.
 * `over` may override any RECIPE_FIBER key (the renderer passes its opts through). Call it when
 * the grid or the tissue changes — NOT every frame (it allocates the small object it returns).
 */
export function recipeFiberScales(h, over = null) {
  const g = (k) => recipeResolve(over, k);
  const minDensity = Math.max(0, g('minDensity'));
  const ramp = Math.min(1, Math.max(0, g('minDensityRamp')));
  return {
    h,
    rMul: g('radiusBase') * h * g('radiusScale'),
    rMin: g('minRadius') * h,
    lMul: h * g('lengthScale'),
    lengthBase: g('lengthBase'),
    lengthFA: g('lengthFA'),
    rhoMaxDraw: g('rhoMaxDraw'),
    minDensity,
    rampLo: minDensity * ramp,
  };
}

/** Rod radius for a voxel's total fiber density (before the per-rod radius factor). */
export function recipeFiberRadius(rho, sc) {
  const r = rho > sc.rhoMaxDraw ? sc.rhoMaxDraw : (rho > 0 ? rho : 0);
  const rad = sc.rMul * Math.sqrt(r);
  return rad > sc.rMin ? rad : sc.rMin;
}

/** Rod length for a voxel's FA (before the per-rod length factor). */
export function recipeFiberLength(fa, sc) {
  return sc.lMul * (sc.lengthBase + sc.lengthFA * fa);
}

/**
 * Fade-in factor 0 … 1 for a voxel's total fiber density: 0 below `rampLo`, smoothstep to 1 at
 * `minDensity`. Multiplies the radius, so fibers thin out instead of popping in and out.
 */
export function recipeFiberFade(rho, sc) {
  if (rho >= sc.minDensity) return 1;
  if (!(rho > sc.rampLo) || !(sc.minDensity > sc.rampLo)) return 0;
  const u = (rho - sc.rampLo) / (sc.minDensity - sc.rampLo);
  return u * u * (3 - 2 * u);
}

/**
 * Direction of one rod: the voxel's principal axis (u, already unit) mixed with the rod's own
 * random unit vector r by the voxel's FA (a), signed so the rod never flips 180° between frames.
 * Writes the unit result into out[0..2] (a Float32Array/array the caller owns) — no allocation.
 */
export function recipeFiberDir(out, ux, uy, uz, a, rx, ry, rz) {
  const s = (ux * rx + uy * ry + uz * rz) < 0 ? -a : a;
  const ia = 1 - a;
  let dx = s * ux + ia * rx, dy = s * uy + ia * ry, dz = s * uz + ia * rz;
  const dl = dx * dx + dy * dy + dz * dz;
  if (dl < 1e-10) { dx = rx; dy = ry; dz = rz; }
  else { const inv = 1 / Math.sqrt(dl); dx *= inv; dy *= inv; dz *= inv; }
  out[0] = dx; out[1] = dy; out[2] = dz;
  return out;
}

/**
 * The recipe as a plain object for `meta.render` (export → Blender). `over` is the same override
 * bag `recipeFiberScales` takes, plus `seed` and `K`; the result carries the values actually used.
 *
 * The five RECIPE_LAYOUT_KEYS are reported from the frozen RECIPE_FIBER, NOT through `over`:
 * recipeFiberLayout() takes no override bag, so an `over.offsetSpan` would change what Blender
 * lays out while the browser kept drawing the frozen value — meta.render must only ever promise
 * a layout the browser really drew (docs/REVIEW.md E2). Everything else is resolved, because
 * recipeFiberScales() resolves it the same way when the renderer draws the frame.
 */
export function recipeRenderMeta(over = null) {
  const R = RECIPE_FIBER;
  const g = (k) => recipeResolve(over, k);
  return {
    recipe: 'fiber-v1',
    seed: g('seed') >>> 0,
    K: g('K') | 0,
    fiber: {
      offsetSpan: R.offsetSpan,
      lenJitterMin: R.lenJitterMin, lenJitterSpan: R.lenJitterSpan,
      radJitterMin: R.radJitterMin, radJitterSpan: R.radJitterSpan,
      radiusBase: g('radiusBase'), radiusScale: g('radiusScale'), minRadius: g('minRadius'),
      lengthScale: g('lengthScale'), lengthBase: g('lengthBase'), lengthFA: g('lengthFA'),
      minDensity: g('minDensity'), minDensityRamp: g('minDensityRamp'), rhoMaxDraw: g('rhoMaxDraw'),
    },
  };
}
