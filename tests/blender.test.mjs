// tests/blender.test.mjs — the Blender importer's own behaviour, from the JS test runner.
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
// Three other files already touch `blender/`: `tests/export.test.mjs` proves the writer and the
// reader agree on the FORMAT, `tests/recipe.test.mjs` spawns `blender/test_recipe_parity.py`,
// which proves the two renderers agree on the ARITHMETIC, and CI dry-runs one fixture. What none
// of them pins is the importer's own contract with a person at a terminal — what its flags mean,
// what it refuses, and what the committed fixtures are supposed to say — and those are exactly
// what drifted in round 3 (review E: `--fiber-radius` changed meaning between versions with no
// warning; the cartilage fixture stopped matching the command documented to regenerate it; a
// rejected `meta.render` block was still announced as if it had been honoured).
//
// Everything here runs `import_tissue.py --dry-run`, which needs only the standard library (bpy
// is optional), and is skipped when python3 is not installed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const IMPORTER = join(root, 'blender', 'import_tissue.py');
const FIBROUS = join(root, 'blender', 'sample_trajectory.json');
const CARTILAGE = join(root, 'blender', 'sample_trajectory_cartilage.json');

const havePython = () => { const r = spawnSync('python3', ['--version'], { stdio: 'ignore' }); return !r.error && r.status === 0; };
const skip = !existsSync(IMPORTER) ? 'blender/import_tissue.py is missing'
  : !havePython() ? 'python3 is not installed' : false;

/** `import_tissue.py --dry-run` over a file; stdout on success, throws on a non-zero exit. */
function dryRun(file, extra = []) {
  return execFileSync('python3', [IMPORTER, '--input', file, '--dry-run', ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The same, expecting failure: returns { status, out } with stdout and stderr joined. */
function dryRunFails(file, extra = []) {
  const r = spawnSync('python3', [IMPORTER, '--input', file, '--dry-run', ...extra], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

let patchSeq = 0;

/**
 * A copy of a fixture with `patch(meta)` applied and only the first `frames` frames kept, in a
 * temp dir the caller removes. Trimming matters: the fibrous fixture is 2.2 MB of grids and the
 * reader measures every frame, so the flag checks below would spend seconds re-parsing data none
 * of them looks at. `meta` — which is what they do look at — is copied whole.
 */
function patched(dir, file, patch, frames = 2) {
  const traj = JSON.parse(readFileSync(file, 'utf8'));
  patch(traj.meta);
  traj.frames = traj.frames.slice(0, frames);
  const out = join(dir, `patched-${(patchSeq += 1)}.json`);
  writeFileSync(out, JSON.stringify(traj));
  return out;
}

describe('blender/import_tissue.py --dry-run', { skip }, () => {
  test('the committed fixtures say what blender/README.md says they say', () => {
    // The fibrous fixture is a real engine export and carries meta.loadRange; the cartilage one
    // is synthetic and, since round 3, carries it too — its arrows are normalised over 0–0.5,
    // which is the whole point of loadRange (a 0–0.5 compression dial and a 0–1 stretch dial
    // draw the same arrows for the same fraction of their range).
    const fib = dryRun(FIBROUS);
    assert.match(fib, /dry run: format 2, tissue 'fibrous'/);
    assert.match(fib, /2 load arrows \(strain 0\.6 -> 0\.60 of 0-1 \(meta\.loadRange\)\)/);
    const car = dryRun(CARTILAGE);
    assert.match(car, /dry run: format 2, tissue 'cartilage'/);
    assert.match(car, /2 load arrows \(compression 0\.3 -> 0\.60 of 0-0\.5 \(meta\.loadRange\)\)/,
      'the committed cartilage fixture must be one the documented regenerate command reproduces');
  });

  test('--fiber-radius MULTIPLIES the recipe scale (1 = draw what the file says)', () => {
    // v0.4 briefly made this flag the absolute radiusScale, so an old command line passing 1.0 —
    // which used to mean "leave it alone" — silently drew rods 1.67× thicker than the browser.
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-blender-'));
    try {
      const file = patched(dir, FIBROUS, () => {});
      assert.match(dryRun(file), /fiber recipe from [^:]+: seed \d+, K \d+, radiusScale 0\.6\b/);
      assert.match(dryRun(file, ['--fiber-radius', '1']), /radiusScale 0\.6\b/);
      assert.match(dryRun(file, ['--fiber-radius', '0.5']), /radiusScale 0\.3\b/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('meta.render is only credited when it was really used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-blender-'));
    try {
      const good = patched(dir, CARTILAGE, (m) => { m.render = { recipe: 'fiber-v1', seed: 12345, K: 3, fiber: { radiusScale: 0.9 } }; });
      const outGood = dryRun(good);
      assert.match(outGood, /fiber recipe from meta\.render: seed 12345, K 3, radiusScale 0\.9/);

      // a block this reader will not honour must not be announced as if it had been (E, #4)
      const bad = patched(dir, CARTILAGE, (m) => { m.render = { recipe: 'fiber-v2', seed: 12345 }; });
      const outBad = dryRun(bad);
      assert.match(outBad, /WARNING meta\.render\.recipe is 'fiber-v2'/);
      assert.match(outBad, /fiber recipe from built-in recipe: seed 90210/);
      assert.doesNotMatch(outBad, /recipe from meta\.render/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a meta.render.K that disagrees with meta.K lays out the K the browser drew', () => {
    // The layout stream spends seven draws per rod in voxel order, so laying out meta.K rods
    // when the renderer drew meta.render.K of them desyncs every voxel after the first (E, #9).
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-blender-'));
    try {
      const file = patched(dir, CARTILAGE, (m) => { m.render = { recipe: 'fiber-v1', seed: 90210, K: 1 }; });
      const out = dryRun(file);
      assert.match(out, /WARNING meta\.render\.K is 1 but meta\.K is 3/);
      assert.match(out, /laying out 1 rods per voxel/);
      assert.match(out, /K=1 /, 'the dry run reports the K it would draw');
      assert.match(out, /\(of 1728\)/, 'and counts rods at that K (12³ × 1), not 12³ × 3');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('fields are off by default, are not a layer, and an unknown key is an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-blender-'));
    try {
      const file = patched(dir, FIBROUS, () => {});
      const off = dryRun(file);
      assert.match(off, /fields: g \[#[0-9a-f]{6}\] \(off\), m \[#[0-9a-f]{6}\] \(off\)/);
      assert.doesNotMatch(off, /field pts=/);
      assert.match(dryRun(file, ['--fields', 'g']), /field pts=\s*\d+/);

      const asLayer = dryRunFails(file, ['--layers', 'fields']);
      assert.notEqual(asLayer.status, 0);
      assert.match(asLayer.out, /--layers: unknown \['fields'\]/);
      assert.match(asLayer.out, /drawn with --fields/);

      const unknown = dryRunFails(file, ['--fields', 'nope']);
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.out, /--fields: unknown \['nope'\]/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a file with no fields, no loadRange and no render block still reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-blender-'));
    try {
      const file = patched(dir, CARTILAGE, (m) => { delete m.loadRange; delete m.render; delete m.fields; });
      const out = dryRun(file);
      assert.match(out, /fiber recipe from built-in recipe/);
      assert.match(out, /fields: none in this trajectory/);
      assert.match(out, /2 load arrows \(compression 0\.3 -> 0\.30 of 0-1 \(assumed: no meta\.loadRange\)\)/);
      assert.match(dryRunFails(file, ['--fields', 'all']).out, /carries no field grids/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
