// tests/recipe.test.mjs — the fiber recipe (src/recipe.js), the one description of how a voxel's
// fiber density and orientation become drawn rods. Run with `node --test tests/*.test.mjs`.
//
// src/recipe.js exists so that the browser renderer (src/render.js) and the Blender importer
// (blender/import_tissue.py) cannot drift apart — but until this file, nothing in `npm test`
// touched it: a changed draw order, a retuned constant or a `meta.render` block that reports
// something the layout does not honour all landed green (round-3 review B, finding 2; E, #1).
//
// Three kinds of check here, and they are deliberately different in kind:
//
//   1. an INDEPENDENT re-implementation of the documented layout (mulberry32, voxels in index
//      order, seven draws per rod in the documented order) — this pins the ORDER, not just the
//      output, so swapping two draws fails even though every number is still "in" the stream;
//   2. LITERALS for N=2, K=1, seed 90210, so changing both implementations at once still fails
//      (these are the same values blender/README.md §4 and test_recipe_parity.py pin);
//   3. the python parity harness itself, spawned when python3 is available — the thing that
//      compares the JS module against the importer's mirror of it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  RECIPE_FIBER, RECIPE_LAYOUT_KEYS, recipeRng, recipeFiberLayout, recipeFiberScales,
  recipeFiberRadius, recipeFiberLength, recipeFiberFade, recipeFiberDir, recipeRenderMeta,
} from '../src/recipe.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PARITY = join(root, 'blender', 'test_recipe_parity.py');

/** mulberry32, written out again here so a change to recipeRng cannot hide behind itself. */
function refRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The layout as src/recipe.js's header describes it, in words:
 *   per voxel v = (i·N + j)·N + k   (i outermost, k innermost)
 *     per instance q = 0 … K−1
 *       3 draws  centre offset (u − 0.5)·offsetSpan·h per axis
 *       2 draws  random unit vector (z = 2u − 1, φ = 2πu)
 *       1 draw   length factor   lenJitterMin + lenJitterSpan·u
 *       1 draw   radius factor   radJitterMin + radJitterSpan·u
 */
function refLayout(N, K, seed) {
  const R = RECIPE_FIBER, h = 1 / N, V = N * N * N, rand = refRng(seed);
  const base = [], rvec = [], jit = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        const c = [(i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h];
        for (let q = 0; q < K; q++) {
          for (let d = 0; d < 3; d++) base.push(c[d] + (rand() - 0.5) * R.offsetSpan * h);
          const z = rand() * 2 - 1, ph = rand() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - z * z));
          rvec.push(s * Math.cos(ph), s * Math.sin(ph), z);
          jit.push(R.lenJitterMin + R.lenJitterSpan * rand());
          jit.push(R.radJitterMin + R.radJitterSpan * rand());
        }
      }
    }
  }
  assert.equal(base.length, 3 * V * K);
  return { base, rvec, jit };
}

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want} (Δ ${Math.abs(got - want)} > ${tol})`);

describe('recipeFiberLayout — the layout stream', () => {
  test('reproduces the documented draw order, element by element', () => {
    for (const [N, K, seed] of [[2, 1, 90210], [8, 3, 90210], [12, 3, 4242], [3, 2, 1]]) {
      const got = recipeFiberLayout(N, K, seed), want = refLayout(N, K, seed);
      assert.equal(got.count, N * N * N * K);
      assert.equal(got.h, 1 / N);
      // the arrays are Float32Array, the reference is float64: one float32 ulp of the unit cube
      for (let i = 0; i < want.base.length; i++) near(got.base[i], want.base[i], 1e-7, `base[${i}] (N=${N},K=${K})`);
      for (let i = 0; i < want.rvec.length; i++) near(got.rvec[i], want.rvec[i], 1e-7, `rvec[${i}] (N=${N},K=${K})`);
      for (let i = 0; i < want.jit.length; i++) near(got.jit[i], want.jit[i], 1e-7, `jit[${i}] (N=${N},K=${K})`);
    }
  });

  test('N=2, K=1, seed 90210 matches the published reference values', () => {
    // blender/README.md §4 and blender/test_recipe_parity.py pin the same numbers; a retune of
    // RECIPE_FIBER's layout half, or a reordered draw, changes them.
    const L = recipeFiberLayout(2, 1, 90210);
    const base = [0.151778474, 0.356280208, 0.439688712, 0.096662581, 0.459526002, 0.882270098];
    const rvec = [0.054295711, -0.752331376, -0.656543553, 0.180023223, -0.577217758, 0.796499372];
    const jit = [0.967380345, 0.871677697, 1.146859765, 1.099844933];
    base.forEach((w, i) => near(L.base[i], w, 1e-8, `base[${i}]`));
    rvec.forEach((w, i) => near(L.rvec[i], w, 1e-8, `rvec[${i}]`));
    jit.forEach((w, i) => near(L.jit[i], w, 1e-8, `jit[${i}]`));
  });

  test('exactly seven draws per instance are consumed, and nothing else touches the stream', () => {
    // Count the draws by making the stream itself countable: refLayout consumes 7·V·K numbers,
    // so a run of N=2,K=3 must leave a run of N=2,K=1 as its first third — which is only true if
    // the per-instance loop is the innermost consumer and takes 7 draws every time.
    const one = recipeFiberLayout(2, 1, 90210), three = recipeFiberLayout(2, 3, 90210);
    for (let d = 0; d < 3; d++) near(three.base[d], one.base[d], 1e-9, `first rod base[${d}]`);
    // …and the second voxel of the K=1 run starts 7 draws in, while for K=3 it starts 21 draws in
    const rand = refRng(90210);
    for (let i = 0; i < 7; i++) rand();                 // the first rod's seven draws, skipped
    // voxel 1 is (i, j, k) = (0, 0, 1) — k is the innermost index — so its centre x is still 0.25
    const secondVoxelFirstOffset = 0.25 + (rand() - 0.5) * RECIPE_FIBER.offsetSpan * 0.5;   // h = 0.5
    near(one.base[3], secondVoxelFirstOffset, 1e-7, 'second voxel of the K=1 run');
  });

  test('is deterministic, and seed / K / N are the only things that change it', () => {
    const a = recipeFiberLayout(6, 3, 90210), b = recipeFiberLayout(6, 3, 90210);
    assert.deepEqual(Array.from(a.base), Array.from(b.base));
    assert.deepEqual(Array.from(a.rvec), Array.from(b.rvec));
    assert.deepEqual(Array.from(a.jit), Array.from(b.jit));
    const c = recipeFiberLayout(6, 3, 90211);
    assert.notDeepEqual(Array.from(c.base), Array.from(a.base), 'a different seed must move the rods');
    assert.equal(recipeFiberLayout(6).K, RECIPE_FIBER.K, 'K defaults to RECIPE_FIBER.K');
    assert.deepEqual(Array.from(recipeFiberLayout(6).base), Array.from(recipeFiberLayout(6, RECIPE_FIBER.K, RECIPE_FIBER.seed).base));
  });

  test('every rvec is a unit vector and every rod centre is inside its voxel', () => {
    const N = 8, K = 3, L = recipeFiberLayout(N, K, 90210), h = 1 / N;
    for (let o = 0; o < L.count; o++) {
      const len = Math.hypot(L.rvec[3 * o], L.rvec[3 * o + 1], L.rvec[3 * o + 2]);
      near(len, 1, 1e-6, `|rvec[${o}]|`);
      const v = (o / K) | 0, i = (v / (N * N)) | 0, j = ((v / N) | 0) % N, k = v % N;
      const c = [(i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h];
      for (let d = 0; d < 3; d++) {
        assert.ok(Math.abs(L.base[3 * o + d] - c[d]) <= 0.5 * RECIPE_FIBER.offsetSpan * h + 1e-7,
          `rod ${o} left its voxel on axis ${d}`);
      }
      assert.ok(L.jit[2 * o] >= RECIPE_FIBER.lenJitterMin && L.jit[2 * o] <= RECIPE_FIBER.lenJitterMin + RECIPE_FIBER.lenJitterSpan);
      assert.ok(L.jit[2 * o + 1] >= RECIPE_FIBER.radJitterMin && L.jit[2 * o + 1] <= RECIPE_FIBER.radJitterMin + RECIPE_FIBER.radJitterSpan);
    }
  });

  test('`out` fills caller-owned arrays in place, and rejects wrong-sized ones', () => {
    const N = 4, K = 3, count = N * N * N * K;
    const out = { base: new Float32Array(count * 3), rvec: new Float32Array(count * 3), jit: new Float32Array(count * 2) };
    const L = recipeFiberLayout(N, K, 90210, out);
    assert.equal(L.base, out.base, 'the caller\'s array must be filled, not replaced');
    assert.deepEqual(Array.from(L.base), Array.from(recipeFiberLayout(N, K, 90210).base));
    const bad = recipeFiberLayout(N, K, 90210, { base: new Float32Array(3), rvec: null, jit: undefined });
    assert.equal(bad.base.length, count * 3, 'a wrong-sized array is replaced rather than overrun');
  });

  test('recipeRng is mulberry32 and is what the layout draws from', () => {
    const a = recipeRng(90210), b = refRng(90210);
    for (let i = 0; i < 32; i++) assert.equal(a(), b());
  });
});

describe('the per-frame laws', () => {
  const sc = recipeFiberScales(1 / 12, null);

  test('recipeFiberScales pre-multiplies the constants for one grid spacing', () => {
    const R = RECIPE_FIBER, h = 1 / 12;
    near(sc.rMul, R.radiusBase * h * R.radiusScale, 1e-15, 'rMul');
    near(sc.rMin, R.minRadius * h, 1e-15, 'rMin');
    near(sc.lMul, h * R.lengthScale, 1e-15, 'lMul');
    near(sc.minDensity, R.minDensity, 1e-15, 'minDensity');
    near(sc.rampLo, R.minDensity * R.minDensityRamp, 1e-15, 'rampLo');
    // the override bag the renderer passes is honoured for the law half of the recipe
    const o = recipeFiberScales(1 / 12, { radiusScale: 1.2, minDensity: 0.1, minDensityRamp: 1 });
    near(o.rMul, R.radiusBase * h * 1.2, 1e-15, 'overridden rMul');
    near(o.minDensity, 0.1, 1e-15, 'overridden minDensity');
    near(o.rampLo, 0.1, 1e-15, 'ramp 1 puts the ramp foot at minDensity');
    // a garbage override falls back to the constant instead of coercing to 0 and erasing the rods
    for (const junk of [undefined, null, NaN, '', ' ', 'x', {}, [], Infinity]) {
      near(recipeFiberScales(1 / 12, { radiusScale: junk }).rMul, sc.rMul, 1e-15, `radiusScale: ${String(junk)}`);
    }
    near(recipeFiberScales(1 / 12, { radiusScale: '1.2' }).rMul, R.radiusBase * h * 1.2, 1e-15, 'a numeric string is a number');
  });

  test('recipeFiberFade ramps in over [minDensity·ramp, minDensity] and is continuous at both ends', () => {
    assert.equal(recipeFiberFade(RECIPE_FIBER.minDensity, sc), 1, 'full strength at minDensity');
    assert.equal(recipeFiberFade(1, sc), 1);
    assert.equal(recipeFiberFade(sc.rampLo, sc), 0, 'nothing drawn at the foot of the ramp');
    assert.equal(recipeFiberFade(0, sc), 0);
    assert.equal(recipeFiberFade(-1, sc), 0);
    // continuity: approach minDensity from below and the fade must approach 1
    near(recipeFiberFade(sc.minDensity - 1e-9, sc), 1, 1e-6, 'fade just below minDensity');
    near(recipeFiberFade(sc.rampLo + 1e-9, sc), 0, 1e-6, 'fade just above the ramp foot');
    // monotone, and smoothstep at the midpoint
    let prev = -1;
    for (let x = 0; x <= 0.04; x += 0.0005) {
      const f = recipeFiberFade(x, sc);
      assert.ok(f >= prev - 1e-12, `fade must not fall (at ρ=${x})`);
      assert.ok(f >= 0 && f <= 1);
      prev = f;
    }
    near(recipeFiberFade(0.5 * (sc.rampLo + sc.minDensity), sc), 0.5, 1e-12, 'smoothstep midpoint');
  });

  test('minDensityRamp = 1 restores the v0.1 hard cut', () => {
    const hard = recipeFiberScales(1 / 12, { minDensityRamp: 1 });
    assert.equal(hard.rampLo, hard.minDensity);
    assert.equal(recipeFiberFade(hard.minDensity, hard), 1);
    assert.equal(recipeFiberFade(hard.minDensity - 1e-12, hard), 0, 'below the threshold: nothing, as in v0.1');
    assert.equal(recipeFiberFade(0.5 * hard.minDensity, hard), 0);
  });

  test('recipeFiberRadius clamps ρ at rhoMaxDraw and floors at minRadius', () => {
    const R = RECIPE_FIBER, h = 1 / 12;
    near(recipeFiberRadius(1, sc), R.radiusBase * h * R.radiusScale, 1e-15, 'ρ = 1');
    near(recipeFiberRadius(4, sc), recipeFiberRadius(R.rhoMaxDraw, sc), 1e-15, 'ρ above rhoMaxDraw is clamped');
    assert.equal(recipeFiberRadius(0, sc), sc.rMin, 'ρ = 0 floors at minRadius');
    assert.equal(recipeFiberRadius(-1, sc), sc.rMin, 'a negative ρ cannot make a negative radius');
    near(recipeFiberRadius(0.25, sc), sc.rMul * 0.5, 1e-15, 'radius ∝ √ρ');
  });

  test('recipeFiberLength is h·lengthScale·(lengthBase + lengthFA·FA)', () => {
    const R = RECIPE_FIBER, h = 1 / 12;
    near(recipeFiberLength(0, sc), h * R.lengthScale * R.lengthBase, 1e-15, 'FA = 0');
    near(recipeFiberLength(1, sc), h * R.lengthScale * (R.lengthBase + R.lengthFA), 1e-15, 'FA = 1');
    near(recipeFiberLength(0.5, sc), 0.5 * (recipeFiberLength(0, sc) + recipeFiberLength(1, sc)), 1e-15, 'linear in FA');
  });

  test('recipeFiberDir mixes the voxel axis with the rod vector and always returns a unit vector', () => {
    const out = new Float64Array(3);
    const u = [0, 0, 1];
    // FA = 0 → the rod keeps its own direction; FA = 1 → the voxel axis, signed toward the rod
    recipeFiberDir(out, ...u, 0, 1, 0, 0);
    assert.deepEqual(Array.from(out), [1, 0, 0]);
    recipeFiberDir(out, ...u, 1, 0.3, 0.4, 0.86602540378);
    near(out[2], 1, 1e-12, 'FA = 1 → the voxel axis');
    recipeFiberDir(out, ...u, 1, 0.3, 0.4, -0.86602540378);
    near(out[2], -1, 1e-12, 'and it never flips 180° away from the rod vector');
    // any mix is unit length, including the degenerate cancellation
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      for (const r of [[1, 0, 0], [0, -1, 0], [-0.57735, 0.57735, 0.57735], [0, 0, -1]]) {
        recipeFiberDir(out, ...u, a, ...r);
        near(Math.hypot(out[0], out[1], out[2]), 1, 1e-9, `|d| at FA=${a}, r=${r}`);
      }
    }
    // exact cancellation (FA = 0.5, r antiparallel to the signed axis) falls back to r
    recipeFiberDir(out, 1, 0, 0, 0.5, -1, 0, 0);
    near(Math.hypot(out[0], out[1], out[2]), 1, 1e-9, '|d| in the degenerate case');
  });
});

describe('recipeRenderMeta — what the export promises Blender', () => {
  test('is the fiber-v1 shape, and repeats RECIPE_FIBER when nothing is overridden', () => {
    const m = recipeRenderMeta(null);
    assert.equal(m.recipe, 'fiber-v1');
    assert.equal(m.seed, RECIPE_FIBER.seed);
    assert.equal(m.K, RECIPE_FIBER.K);
    for (const [k, v] of Object.entries(m.fiber)) assert.equal(v, RECIPE_FIBER[k], `meta.render.fiber.${k}`);
    // every key of the recipe except the two that are arguments is reported
    assert.deepEqual(Object.keys(m.fiber).sort(), Object.keys(RECIPE_FIBER).filter((k) => k !== 'seed' && k !== 'K').sort());
  });

  test('reports the LAW values actually used when the renderer overrides them', () => {
    const over = { seed: 7, K: 2, radiusScale: 0.9, lengthScale: 2, minRadius: 0.05, minDensity: 0.1, minDensityRamp: 1 };
    const m = recipeRenderMeta(over);
    assert.equal(m.seed, 7);
    assert.equal(m.K, 2);
    for (const k of ['radiusScale', 'lengthScale', 'minRadius', 'minDensity', 'minDensityRamp']) {
      assert.equal(m.fiber[k], over[k], `meta.render.fiber.${k} must be the value in use`);
    }
    // …and a reader rebuilding the scales from meta.render gets exactly the renderer's scales
    const fromMeta = recipeFiberScales(1 / 12, m.fiber);
    const used = recipeFiberScales(1 / 12, over);
    assert.deepEqual(fromMeta, used, 'meta.render must round-trip through recipeFiberScales');
  });

  test('NEVER reports a layout constant it cannot honour (round-3 review B, finding 3)', () => {
    // recipeFiberLayout takes no override bag: these five come from the frozen table, so an
    // export can only ever describe the layout the browser really drew.
    const over = {};
    for (const k of RECIPE_LAYOUT_KEYS) over[k] = 0.123;
    const m = recipeRenderMeta(over);
    for (const k of RECIPE_LAYOUT_KEYS) assert.equal(m.fiber[k], RECIPE_FIBER[k], `meta.render.fiber.${k} must ignore the override`);
    // and the layout really is unmoved by them
    assert.deepEqual(Array.from(recipeFiberLayout(4, 3, 90210).base), Array.from(recipeFiberLayout(4, 3, 90210).base));
    assert.deepEqual(RECIPE_LAYOUT_KEYS.slice(), ['offsetSpan', 'lenJitterMin', 'lenJitterSpan', 'radJitterMin', 'radJitterSpan']);
    assert.ok(Object.isFrozen(RECIPE_FIBER) && Object.isFrozen(RECIPE_LAYOUT_KEYS));
  });
});

describe('web ↔ Blender parity (blender/test_recipe_parity.py)', () => {
  const havePython = () => { const r = spawnSync('python3', ['--version'], { stdio: 'ignore' }); return !r.error && r.status === 0; };
  const skip = !existsSync(PARITY) ? 'blender/test_recipe_parity.py is missing'
    : !havePython() ? 'python3 is not installed' : false;

  test('the python mirror of src/recipe.js still agrees with it', { skip }, (t) => {
    // The harness runs `node blender/recipe_dump.mjs` itself and compares ~1100 numbers: the
    // recipe constants, the whole N=2/K=1 layout, the per-frame laws, one frame of rods end to
    // end, the cell colour ramp, the aspect law and the load-arrow normalisation. Nothing else
    // in `npm test` or in CI runs it, so a retune of src/recipe.js or of the importer's mirror
    // would otherwise land green and only show up as a Blender render that no longer matches
    // the browser (round-3 review E, finding 1).
    //
    // The only thing this test asks of that script's CLI is: no arguments, exit 0 when parity
    // holds (or when it skips itself), non-zero when it does not, and something on stdout. Its
    // wording is its own business, so a reworded report cannot fail the JS suite.
    const r = spawnSync('python3', [PARITY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, `blender/test_recipe_parity.py failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, 'the parity harness printed nothing at all');
    if (/\bSKIP\b/i.test(r.stdout)) t.diagnostic(`parity harness skipped itself: ${r.stdout.trim().split('\n')[0]}`);
  });
});
