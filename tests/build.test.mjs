// tests/build.test.mjs — the single-file build and the source constraints it depends on.
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
// docs/EXTENDING.md §0 makes tools/build_single.mjs possible: every src file is an ES module with
// NAMED EXPORTS ONLY, UNIQUE TOP-LEVEL IDENTIFIERS and LOCAL IMPORTS ON ONE LINE, because the build
// strips `export `, drops local `import … from './…'` lines and concatenates the sources into one
// <script type="module">. Break any of the three and the bundle is silently wrong (a duplicate
// `const`, a dangling `export default`, half an import statement left in the file) while
// `index.html` from source still works — so these are the checks that fail early instead.
//
// The build is run into a temporary directory, so this file tests the BUILD, not the committed
// artifact; `node tools/check_dist.mjs` (npm run check-dist) is what tells you dist/ is stale.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TISSUES } from '../src/tissues/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(root, 'src');

/** Every .js under src/, as { rel, text }. `bundled` = the files build_single.mjs concatenates. */
function sourceFiles() {
  const top = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort().map((f) => f);
  const tis = readdirSync(join(SRC, 'tissues')).filter((f) => f.endsWith('.js')).sort().map((f) => `tissues/${f}`);
  return [...top, ...tis].map((rel) => ({
    rel,
    bundled: !rel.split('/').pop().startsWith('_'),          // build_single.mjs skips _template.js
    text: readFileSync(join(SRC, rel), 'utf8'),
  }));
}
const files = sourceFiles();

// ---------------------------------------------------------------- source constraints (§0)
describe('source constraints (docs/EXTENDING.md §0)', () => {
  test('every src file uses named exports only', () => {
    const bad = [];
    for (const f of files) {
      for (const [i, line] of f.text.split('\n').entries()) {
        if (!/^export\b/.test(line)) continue;
        if (!/^export\s+(const|let|var|function|class|async function)\s+[A-Za-z_$]/.test(line)) {
          bad.push(`${f.rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(bad, [], 'the build strips only `export const|let|var|function|class|async function`;\n' +
      'default exports, `export { … }` and `export *` survive into the bundle:\n  ' + bad.join('\n  '));
  });

  test('every local import is a single line of the form `import { … } from \'./x.js\';`', () => {
    const bad = [];
    for (const f of files) {
      for (const [i, line] of f.text.split('\n').entries()) {
        const t = line.trim();
        if (!/^import\b/.test(t)) continue;
        const isLocal = /from\s+['"]\.\.?\//.test(t);
        if (!/;$/.test(t) || (/\{/.test(t) && !/\}/.test(t))) { bad.push(`${f.rel}:${i + 1}: import statement spans lines: ${t}`); continue; }
        if (isLocal && !/^import\s+\{[^}]*\}\s+from\s+'\.\.?\/[^']+\.js';$/.test(t)) bad.push(`${f.rel}:${i + 1}: ${t}`);
      }
    }
    assert.deepEqual(bad, [], 'the build drops local imports line by line:\n  ' + bad.join('\n  '));
  });

  test('top-level identifiers are unique across the bundled sources', () => {
    const seen = new Map(), clashes = [];
    const decl = /^(?:export\s+)?(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/;
    for (const f of files) {
      if (!f.bundled) continue;
      for (const [i, line] of f.text.split('\n').entries()) {
        const m = decl.exec(line);
        if (!m) continue;
        const where = `${f.rel}:${i + 1}`;
        if (seen.has(m[1])) clashes.push(`${m[1]} (${seen.get(m[1])} and ${where})`);
        else seen.set(m[1], where);
      }
    }
    assert.deepEqual(clashes, [], 'the bundle is one module, so these would redeclare each other:\n  ' + clashes.join('\n  '));
    assert.ok(seen.size > 20, 'the identifier scan found suspiciously little');
  });

  test('the engine and the tissue definitions stay DOM-free and unseeded', () => {
    const forbidden = /\b(document|window|localStorage|Math\.random)\b/;
    for (const f of files) {
      if (f.rel !== 'engine.js' && !f.rel.startsWith('tissues/')) continue;
      const hits = f.text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => forbidden.test(l) && !/^\s*(\*|\/\/)/.test(l));
      assert.deepEqual(hits.map(([i, l]) => `${f.rel}:${i}: ${l.trim()}`), [],
        `${f.rel} must run in node as well as the browser and must be deterministic (seeded PRNG only)`);
    }
  });
});

// ---------------------------------------------------------------- the built page
describe('single-file build (tools/build_single.mjs)', () => {
  let tmp = null, full = '', fragment = '';

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tissue-weather-build-'));
    cpSync(SRC, join(tmp, 'src'), { recursive: true });
    cpSync(join(root, 'index.html'), join(tmp, 'index.html'));
    mkdirSync(join(tmp, 'tools'), { recursive: true });
    cpSync(join(root, 'tools', 'build_single.mjs'), join(tmp, 'tools', 'build_single.mjs'));
    execFileSync(process.execPath, [join(tmp, 'tools', 'build_single.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    full = readFileSync(join(tmp, 'dist', 'tissue-weather.html'), 'utf8');
    fragment = readFileSync(join(tmp, 'dist', 'tissue-weather.artifact.html'), 'utf8');
  });
  after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  test('the page parses as HTML: doctype, one html/head/body, every tag closed', () => {
    assert.match(full, /^<!doctype html>/i);
    for (const tag of ['html', 'head', 'body']) {
      assert.equal((full.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length, 1, `exactly one <${tag}>`);
      assert.equal((full.match(new RegExp(`</${tag}>`, 'gi')) || []).length, 1, `exactly one </${tag}>`);
    }
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const RAW = new Set(['script', 'style', 'textarea', 'title']);
    const stack = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
    let m;
    while ((m = tagRe.exec(full))) {
      const [, close, rawName, , selfClose] = m;
      const name = rawName.toLowerCase();
      if (close) {
        const open = stack.pop();
        assert.equal(open, name, `</${name}> at offset ${m.index} closes <${open}>`);
        continue;
      }
      if (VOID.has(name) || selfClose === '/') continue;
      if (RAW.has(name)) {                                     // skip raw text: no markup inside
        const end = full.toLowerCase().indexOf(`</${name}>`, tagRe.lastIndex);
        assert.ok(end > 0, `<${name}> is never closed`);
        tagRe.lastIndex = end + name.length + 3;
        continue;
      }
      stack.push(name);
    }
    assert.deepEqual(stack, [], `unclosed tags: ${stack.join(' > ')}`);
  });

  test('exactly one <script type="module">, and no module script left pointing at src/', () => {
    assert.equal((full.match(/<script\s+type="module"/g) || []).length, 1);
    assert.equal((full.match(/<script\s+type="module"\s+src=/g) || []).length, 0, 'the src/app.js marker must be replaced by the inline bundle');
    assert.equal((full.match(/<script/g) || []).length, (full.match(/<\/script>/g) || []).length, 'balanced script tags');
    assert.match(full, /<script type="importmap">/, 'the Three.js import map survives the build');
    assert.match(full, /\/\/ ===== src\/engine\.js =====/, 'the engine is inlined');
    assert.match(full, /\/\/ ===== src\/app\.js =====/, 'the app is inlined');
  });

  test('no local import survives, and every external import is hoisted to the top of the module', () => {
    const script = full.slice(full.indexOf('<script type="module">'), full.indexOf('</script>', full.indexOf('<script type="module">')));
    const localStatic = script.split('\n').filter((l) => /^\s*import\s[^\n]*from\s+['"]\.\.?\//.test(l));
    assert.deepEqual(localStatic, [], 'local imports must be dropped (the files are concatenated)');
    const body = script.replace(/^<script type="module">\n/, '');
    const imports = body.split('\n').map((l, i) => [i, l]).filter(([, l]) => /^import\s/.test(l));
    assert.ok(imports.length > 0, 'the Three.js imports should be hoisted, not dropped');
    for (const [i, l] of imports) assert.ok(i < 8, `external import not hoisted (line ${i + 1}): ${l}`);
    assert.ok(!/^export\s/m.test(body), 'no `export` keyword may survive into the bundle');
  });

  test('every registered tissue is in the bundle and reachable through the registry', () => {
    const keys = Object.keys(TISSUES);
    assert.ok(keys.length >= 1, 'at least one registered tissue');
    for (const key of keys) {
      assert.match(full, new RegExp(`key:\\s*'${key}'`), `tissue '${key}' definition missing from the bundle`);
      assert.match(full, new RegExp(`\\b${key}:\\s*TISSUE_[A-Z0-9_]+`), `tissue '${key}' missing from the TISSUES registry in the bundle`);
      assert.match(full, new RegExp(`// ===== src/tissues/${key}\\.js =====`), `src/tissues/${key}.js was not concatenated`);
    }
    assert.ok(!full.includes('// ===== src/tissues/_template.js ====='), 'the unregistered starter must stay out of the bundle');
  });

  test('the artifact fragment is the same page without the document skeleton', () => {
    for (const tag of ['<!doctype', '<html', '<head>', '<body>']) assert.ok(!fragment.toLowerCase().includes(tag), `fragment still contains ${tag}`);
    assert.match(fragment, /^<title>/);
    assert.equal((fragment.match(/<script\s+type="module"/g) || []).length, 1);
    assert.ok(fragment.length > 0.5 * full.length, 'the fragment should carry the whole app');
  });

  test('dist/ carries both build outputs (freshness is checked by npm run check-dist)', () => {
    for (const name of ['tissue-weather.html', 'tissue-weather.artifact.html']) {
      assert.ok(existsSync(join(root, 'dist', name)), `dist/${name} is missing — run npm run build`);
    }
  });
});
