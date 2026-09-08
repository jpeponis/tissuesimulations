// tests/tools.test.mjs — the developer tools that other agents and contributors rely on.
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
//   tools/new_tissue.mjs       scaffolds src/tissues/<key>.js from the starter and registers it
//   tools/check_dist.mjs       fails when dist/*.html is not a fresh build of index.html + src/
//   tools/check_params_doc.mjs fails when a documented "as built" parameter block has drifted from
//                              the tissue definition it describes (docs/REVIEW.md D5)
//   tools/lib/browser.mjs      the shared Playwright harness plumbing (D9)
//
// Everything runs in a throw-away copy of the repository under os.tmpdir(): these tests must never
// leave a generated tissue behind in src/tissues/ (the conformance suite in engine.test.mjs runs
// every registered tissue, so a stray scaffold would quietly become part of the test surface).
//
// The copy carries the REAL src/tissues/, so the scaffolder refuses a key that already exists
// there. The fixtures therefore use keys no tissue would ever want — `demotissue` and
// `demo-tissue`, RESERVED for this file: a fixture key that reads like a real tissue (this used to
// be `tendon`) breaks three tests for whoever adds that tissue, before they have written a line.
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
      const r = run(dir, 'new_tissue.mjs', ['demotissue', 'Demo tissue']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /wrote src\/tissues\/demotissue\.js/);

      const gen = readFileSync(join(dir, 'src', 'tissues', 'demotissue.js'), 'utf8');
      assert.match(gen, /export const TISSUE_DEMOTISSUE = \{/);
      assert.match(gen, /key: 'demotissue'/);
      assert.match(gen, /name: 'Demo tissue'/);
      assert.ok(!/\bTISSUE_TEMPLATE\b/.test(gen), 'the template identifier must be renamed');
      assert.ok(!/^export\s+(?!const|let|var|function|class|async function)/m.test(gen), 'named exports only');

      const index = readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8');
      assert.match(index, /^import \{ TISSUE_DEMOTISSUE \} from '\.\/demotissue\.js';$/m, 'one-line local import');
      assert.match(index, /^ {2}demotissue: TISSUE_DEMOTISSUE,$/m, 'registry entry');
      assert.match(index, /^ {2}fibrous: TISSUE_FIBROUS,$/m, 'the existing registration survives');

      const { TISSUES } = await import(pathToFileURL(join(dir, 'src', 'tissues', 'index.js')).href);
      const { TissueEngine } = await import(pathToFileURL(join(dir, 'src', 'engine.js')).href);
      assert.ok(TISSUES.demotissue, 'registered under its key');
      assert.equal(TISSUES.demotissue.key, 'demotissue');
      assert.deepEqual(TissueEngine.validate(TISSUES.demotissue), [], 'the scaffold must validate as it is');
      const M = new TissueEngine(TISSUES.demotissue, { seed: 7 });
      M.reset(TISSUES.demotissue.scenarios[0].key);
      M.step(50);
      const s = M.stats();
      assert.ok(Number.isFinite(s.species.total) && s.species.total >= 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a hyphenated key becomes TISSUE_A_B and a quoted registry entry', () => {
    const dir = scratchRepo(['src', 'tools/new_tissue.mjs']);
    try {
      assert.equal(run(dir, 'new_tissue.mjs', ['demo-tissue', 'Demo tissue two']).status, 0);
      const gen = readFileSync(join(dir, 'src', 'tissues', 'demo-tissue.js'), 'utf8');
      assert.match(gen, /export const TISSUE_DEMO_TISSUE = \{/);
      assert.match(gen, /key: 'demo-tissue'/);
      assert.match(readFileSync(join(dir, 'src', 'tissues', 'index.js'), 'utf8'), /^ {2}'demo-tissue': TISSUE_DEMO_TISSUE,$/m);
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
        [['demotissue'], /./],                                    // no name: allowed, name defaults to the key
      ]) {
        const r = run(dir, 'new_tissue.mjs', args);
        if (args[0] === 'demotissue') { assert.equal(r.status, 0); continue; }
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
      const r = run(dir, 'new_tissue.mjs', ['demotissue', 'Demo tissue', '--dry-run']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /--dry-run/);
      assert.ok(!existsSync(join(dir, 'src', 'tissues', 'demotissue.js')));
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

// ---------------------------------------------------------------- shared harness plumbing (D9)
// tools/lib/browser.mjs is what tools/screenshot_app.mjs and tools/render_smoke.mjs are meant to
// share (see tools/lib/README.md). Everything that needs no browser is covered here.
describe('tools/lib/browser.mjs', () => {
  test('serveDir serves files, refuses to escape its root, and closes twice without complaining', async () => {
    const { serveDir } = await import('../tools/lib/browser.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-serve-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hi</title>');
    writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
    const server = await serveDir(dir, { port: 0 });
    try {
      assert.ok(server.port > 0, 'port 0 must pick a free port');
      const js = await fetch(`${server.url}/a.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /text\/javascript/);
      assert.equal((await js.text()).trim(), 'export const a = 1;');
      assert.equal((await fetch(`${server.url}/`)).status, 200, 'a directory serves its index.html');
      assert.equal((await fetch(`${server.url}/nope.js`)).status, 404);
      const escaped = await fetch(`${server.url}/../../etc/passwd`);
      assert.ok(escaped.status === 403 || escaped.status === 404, `must not serve outside the root (got ${escaped.status})`);
    } finally {
      await server.close();
      await server.close();                                  // idempotent: the finally block may double-close
      rmSync(dir, { recursive: true, force: true });
    }
    await assert.rejects(fetch(`${server.url}/a.js`), 'the socket is really gone after close()');
  });

  // The claim four documents make (README, CONTRIBUTING, docs/SPEC.md, docs/ARCHITECTURE.md) is
  // that the two smoke tools SHARE this module. They each used to carry their own copy, with a
  // different bug in each; this is the check that keeps the sentence true.
  test('both smoke tools drive the browser through it, and neither keeps its own copy', () => {
    for (const rel of ['tools/screenshot_app.mjs', 'tools/render_smoke.mjs']) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.match(text, /^import \{[^}]*\} from '\.\/lib\/browser\.mjs';$/m, `${rel} must import the shared harness`);
      assert.ok(!/http\.server/.test(text), `${rel} must not spawn its own python http.server`);
      assert.ok(!/\bserver\.kill\(/.test(text), `${rel} must let withHarness() close the server, so a throw cannot leak it`);
    }
  });

  test('fetchCached caches a download and never keeps a failed one', async () => {
    const { fetchCached } = await import('../tools/lib/browser.mjs');
    const { serveDir } = await import('../tools/lib/browser.mjs');
    const src = mkdtempSync(join(tmpdir(), 'tissue-weather-cdn-src-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'tissue-weather-cdn-cache-'));
    writeFileSync(join(src, 'lib.js'), 'export const three = 3;\n');
    const server = await serveDir(src, { port: 0 });
    try {
      const body = await fetchCached(`${server.url}/lib.js`, { cacheDir, maxSeconds: 10 });
      assert.equal(body.toString().trim(), 'export const three = 3;');
      const cached = join(cacheDir, `127.0.0.1:${server.port}`, 'lib.js');
      assert.ok(existsSync(cached), `the download must land in the cache (${cached})`);

      writeFileSync(join(src, 'lib.js'), 'export const three = 999;\n');   // changed at the source…
      assert.equal((await fetchCached(`${server.url}/lib.js`, { cacheDir })).toString().trim(), 'export const three = 3;',
        '…but a cached file is not fetched again');

      await assert.rejects(fetchCached(`${server.url}/missing.js`, { cacheDir, maxSeconds: 10 }), /download failed/,
        'curl --fail: a 404 must throw instead of caching the error page');
      assert.ok(!existsSync(join(cacheDir, `127.0.0.1:${server.port}`, 'missing.js')), 'nothing is cached for a failed download');
      assert.ok(!existsSync(join(cacheDir, `127.0.0.1:${server.port}`, 'missing.js.part')), 'and no .part file is left behind');
    } finally {
      await server.close();
      rmSync(src, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- as-built parameter blocks (D5)
// The documents carry one GENERATED block per tissue between `<!-- params:<key> -->` markers.
// This is the test that makes the record binding: change a parameter, and the suite tells you the
// document has to be regenerated (`node tools/check_params_doc.mjs --write`).
describe('tools/check_params_doc.mjs', () => {
  test('every documented as-built block matches its tissue definition', async () => {
    const { paramsCheckAll } = await import('../tools/check_params_doc.mjs');
    const { problems } = paramsCheckAll();
    assert.deepEqual(problems, [], 'the docs no longer describe the code:\n  ' + problems.join('\n  ') +
      '\n\nRegenerate with: node tools/check_params_doc.mjs --write');
  });

  test('a changed parameter is reported with its key, both values and the fix', async () => {
    const { paramsBlockBody, paramsParseBlock, paramsFormatValue } = await import('../tools/check_params_doc.mjs');
    const { TISSUES } = await import('../src/tissues/index.js');
    const body = paramsBlockBody(TISSUES.fibrous);
    const parsed = paramsParseBlock(body);
    assert.ok(parsed, 'the generated block must parse back');
    for (const [k, v] of Object.entries(TISSUES.fibrous.params)) {
      assert.equal(parsed.params[k], paramsFormatValue(v), `params.${k} must round-trip`);
    }
    for (const [k, v] of Object.entries(TISSUES.fibrous.engine)) {
      assert.equal(parsed.engine[k], paramsFormatValue(v), `engine.${k} must round-trip`);
    }
    assert.equal(paramsFormatValue(1 / 14), '0.0714286', 'six significant figures, compared numerically');

    // the real failure path: a document that says something else
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-params-'));
    try {
      const doc = join(dir, 'MODEL.md');
      writeFileSync(doc, `# doc\n\n<!-- params:fibrous -->\n${body.replace('kAlign = 0.6', 'kAlign = 0.4')}\n<!-- /params:fibrous -->\n`);
      const shown = paramsParseBlock(readFileSync(doc, 'utf8').split('<!-- params:fibrous -->')[1]);
      assert.equal(shown.params.kAlign, '0.4', 'the fixture really carries the stale value');
      assert.notEqual(shown.params.kAlign, paramsFormatValue(TISSUES.fibrous.params.kAlign));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the CLI exits 1 and names the file when a block is stale', () => {
    const dir = scratchRepo(['src', 'docs', 'tools/check_params_doc.mjs']);
    try {
      const doc = join(dir, 'docs', 'MODEL.md');
      writeFileSync(doc, readFileSync(doc, 'utf8').replace(/kAlign = [\d.]+/, 'kAlign = 0.4'));
      const r = run(dir, 'check_params_doc.mjs');
      assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /docs\/MODEL\.md: params\.kAlign/);
      assert.match(r.stderr, /--write/);

      const w = run(dir, 'check_params_doc.mjs', ['--write']);
      assert.equal(w.status, 0, w.stderr);
      assert.match(w.stdout, /rewrote/);
      assert.equal(run(dir, 'check_params_doc.mjs').status, 0, 'and --write makes it green again');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // A newcomer who scaffolds a tissue meets this checker before they meet the biology, so it has to
  // name the file to write. It must NOT ask them to edit this tool: the document defaults to
  // docs/tissues/<key>.md and is found by its markers (docs/EXTENDING.md §8).
  test('a newly scaffolded tissue is told which document to write, and needs no edit to the tool', () => {
    const dir = scratchRepo(['src', 'docs', 'tools/new_tissue.mjs', 'tools/check_params_doc.mjs']);
    try {
      assert.equal(run(dir, 'new_tissue.mjs', ['demotissue', 'Demo tissue']).status, 0);

      const missing = run(dir, 'check_params_doc.mjs');
      assert.equal(missing.status, 1, 'a tissue with no as-built block fails the check');
      assert.match(missing.stderr, /no as-built block for tissue 'demotissue'/);
      assert.match(missing.stderr, /docs\/tissues\/demotissue\.md/, 'it names the document to write');
      assert.match(missing.stderr, /<!-- params:demotissue -->/, 'and the markers to put in it');

      writeFileSync(join(dir, 'docs', 'tissues', 'demotissue.md'),
        '# Demo tissue\n\n## Parameters\n\n<!-- params:demotissue -->\n<!-- /params:demotissue -->\n');
      const w = run(dir, 'check_params_doc.mjs', ['--write']);
      assert.equal(w.status, 0, `${w.stdout}${w.stderr}`);
      assert.match(w.stdout, /docs\/tissues\/demotissue\.md/);
      assert.match(readFileSync(join(dir, 'docs', 'tissues', 'demotissue.md'), 'utf8'), /```text[\s\S]*engine[\s\S]*params/);
      assert.equal(run(dir, 'check_params_doc.mjs').status, 0, 'and the check is green from then on');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
