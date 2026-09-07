// tests/tools.test.mjs — the developer tools that other agents and contributors rely on.
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
//   tools/new_tissue.mjs   scaffolds src/tissues/<key>.js from the starter and registers it
//   tools/check_dist.mjs   fails when dist/*.html is not a fresh build of index.html + src/
//
// Everything runs in a throw-away copy of the repository under os.tmpdir(): these tests must never
// leave a generated tissue behind in src/tissues/ (the conformance suite in engine.test.mjs runs
// every registered tissue, so a stray scaffold would quietly become part of the test surface).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A temp copy of the repo carrying `parts` (relative paths); returns its absolute path. */
function scratchRepo(parts) {
  const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-tools-'));
  for (const p of parts) {
    const from = join(root, p), to = join(dir, p);
    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  return dir;
}

/** Run a tool inside a scratch repo; returns { status, stdout, stderr }. */
function run(dir, tool, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [join(dir, 'tools', tool), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

describe('tools/new_tissue.mjs', () => {
  test('scaffolds a registered, valid tissue that the engine accepts and can step', async () => {
    const dir = scratchRepo(['src', 'tools/new_tissue.mjs']);
    try {
      const r = run(dir, 'new_tissue.mjs', ['tendon', 'Tendon fascicle']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /wrote src\/tissues\/tendon\.js/);

      const gen = readFileSync(join(dir, 'src', 'tissues', 'tendon.js'), 'utf8');
      assert.match(gen, /export const TISSUE_TENDON = \{/);
      assert.match(gen, /key: 'tendon'/);
      assert.match(gen, /name: 'Tendon fascicle'/);
      assert.ok(!/\bTISSUE_TEMPLATE\b/.test(gen), 'the template identifier must be renamed');
      assert.ok(!/^export\s+(?!const|let|var|function|class|async function)/m.test(gen), 'named exports only');

      const index = readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8');
      assert.match(index, /^import \{ TISSUE_TENDON \} from '\.\/tendon\.js';$/m, 'one-line local import');
      assert.match(index, /^ {2}tendon: TISSUE_TENDON,$/m, 'registry entry');
      assert.match(index, /^ {2}fibrous: TISSUE_FIBROUS,$/m, 'the existing registration survives');

      const { TISSUES } = await import(pathToFileURL(join(dir, 'src', 'tissues', 'index.js')).href);
      const { TissueEngine } = await import(pathToFileURL(join(dir, 'src', 'engine.js')).href);
      assert.ok(TISSUES.tendon, 'registered under its key');
      assert.equal(TISSUES.tendon.key, 'tendon');
      assert.deepEqual(TissueEngine.validate(TISSUES.tendon), [], 'the scaffold must validate as it is');
      const M = new TissueEngine(TISSUES.tendon, { seed: 7 });
      M.reset(TISSUES.tendon.scenarios[0].key);
      M.step(50);
      const s = M.stats();
      assert.ok(Number.isFinite(s.species.total) && s.species.total >= 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a hyphenated key becomes TISSUE_A_B and a quoted registry entry', () => {
    const dir = scratchRepo(['src', 'tools/new_tissue.mjs']);
    try {
      assert.equal(run(dir, 'new_tissue.mjs', ['smooth-muscle', 'Smooth muscle']).status, 0);
      const gen = readFileSync(join(dir, 'src', 'tissues', 'smooth-muscle.js'), 'utf8');
      assert.match(gen, /export const TISSUE_SMOOTH_MUSCLE = \{/);
      assert.match(gen, /key: 'smooth-muscle'/);
      assert.match(readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8'), /^ {2}'smooth-muscle': TISSUE_SMOOTH_MUSCLE,$/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('refuses a duplicate key, a bad key and a reserved key, and leaves the registry alone', () => {
    const dir = scratchRepo(['src', 'tools/new_tissue.mjs']);
    try {
      const before = readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8');
      for (const [args, pattern] of [
        [['fibrous', 'Again'], /already registered|already exists/],
        [['Bad Key', 'x'], /bad key/],
        [['index', 'x'], /reserved/],
        [['tendon'], /./],                                    // no name: allowed, name defaults to the key
      ]) {
        const r = run(dir, 'new_tissue.mjs', args);
        if (args[0] === 'tendon') { assert.equal(r.status, 0); continue; }
        assert.equal(r.status, 1, `expected a refusal for ${JSON.stringify(args)}`);
        assert.match(r.stderr, pattern);
      }
      assert.ok(!existsSync(join(dir, 'src', 'tissues', 'Bad Key.js')));
      assert.ok(!existsSync(join(dir, 'src', 'tissues', 'index.js.bak')));
      const after = readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8');
      assert.ok(after.includes(before.split('\n').find((l) => l.includes('TISSUE_FIBROUS'))), 'the fibrous import must survive');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--dry-run writes nothing', () => {
    const dir = scratchRepo(['src', 'tools/new_tissue.mjs']);
    try {
      const before = readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8');
      const r = run(dir, 'new_tissue.mjs', ['tendon', 'Tendon fascicle', '--dry-run']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /--dry-run/);
      assert.ok(!existsSync(join(dir, 'src', 'tissues', 'tendon.js')));
      assert.equal(readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8'), before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('tools/check_dist.mjs', () => {
  test('passes on a fresh build and fails, readably, once a source changes', () => {
    const dir = scratchRepo(['src', 'index.html', 'tools/build_single.mjs', 'tools/check_dist.mjs']);
    try {
      execFileSync(process.execPath, [join(dir, 'tools', 'build_single.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
      const ok = run(dir, 'check_dist.mjs');
      assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
      assert.match(ok.stdout, /up to date/);

      const app = join(dir, 'src', 'app.js');
      writeFileSync(app, `${readFileSync(app, 'utf8')}\n// a change that never reached dist/\n`);
      const stale = run(dir, 'check_dist.mjs');
      assert.equal(stale.status, 1, 'a changed source must make check-dist fail');
      assert.match(stale.stderr, /STALE/);
      assert.match(stale.stderr, /npm run build/);
      assert.match(stale.stderr, /first difference at line \d+/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reports a missing dist/ instead of throwing', () => {
    const dir = scratchRepo(['src', 'index.html', 'tools/build_single.mjs', 'tools/check_dist.mjs']);
    try {
      const r = run(dir, 'check_dist.mjs');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /MISSING/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
