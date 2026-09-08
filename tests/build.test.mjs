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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
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

// ---------------------------------------------------------------- fail-loud checks (REVIEW D1)
// The build concatenates: an import it cannot resolve, a statement the strip missed or a name
// declared twice all produce a green build and a dead page. Each must throw instead.
describe('the build refuses to write a broken bundle (docs/REVIEW.md D1)', () => {
  /** A throw-away repo (src/ + index.html + the build) that `mutate` may edit before the build runs. */
  function buildIn(mutate) {
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-fail-'));
    try {
      cpSync(SRC, join(dir, 'src'), { recursive: true });
      cpSync(join(root, 'index.html'), join(dir, 'index.html'));
      mkdirSync(join(dir, 'tools'), { recursive: true });
      cpSync(join(root, 'tools', 'build_single.mjs'), join(dir, 'tools', 'build_single.mjs'));
      if (mutate) mutate(dir);
      try {
        const stdout = execFileSync(process.execPath, [join(dir, 'tools', 'build_single.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '', dir, wrote: existsSync(join(dir, 'dist', 'tissue-weather.html')) };
      } catch (e) {
        return { status: e.status ?? 1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString(), dir, wrote: existsSync(join(dir, 'dist', 'tissue-weather.html')) };
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test('a local import whose target is not bundled throws with file:line', () => {
    const r = buildIn((dir) => {
      writeFileSync(join(dir, 'src', 'tissues', '_helper.js'), 'export const helperK = 3;\n');
      writeFileSync(join(dir, 'src', 'tissues', 'scratchy.js'),
        "import { helperK } from './_helper.js';\nexport const TISSUE_SCRATCHY = { key: 'scratchy', k: helperK };\n");
    });
    assert.equal(r.status, 1, `the build must fail\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /src\/tissues\/scratchy\.js:1/, 'names the importing file and line');
    assert.match(r.stderr, /_helper\.js/, 'names the specifier it could not resolve');
    assert.ok(!r.wrote, 'nothing may be written when a check fails');
  });

  test('an import that reaches outside src/ throws too', () => {
    const r = buildIn((dir) => {
      const p = join(dir, 'src', 'plots.js');
      writeFileSync(p, `import { readFileSync } from '../tools/build_single.mjs';\n${readFileSync(p, 'utf8')}`);
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src\/plots\.js:1/);
  });

  test('a multi-line import survives the strip and throws', () => {
    const r = buildIn((dir) => {
      const p = join(dir, 'src', 'plots.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace("import { copyFormatRate } from './copy.js';", "import {\n  copyFormatRate\n} from './copy.js';"));
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src\/plots\.js:\d+/);
    assert.match(r.stderr, /import|export/);
  });

  test('`export default` / `export { … }` throw', () => {
    for (const line of ['export default 1;', 'export { copyFormatRate as fmt };', "export * from './copy.js';"]) {
      const r = buildIn((dir) => {
        const p = join(dir, 'src', 'plots.js');
        writeFileSync(p, `${readFileSync(p, 'utf8')}\n${line}\n`);
      });
      assert.equal(r.status, 1, `\`${line}\` must fail the build`);
      assert.match(r.stderr, /src\/plots\.js:\d+/);
    }
  });

  test('a duplicate top-level declaration is caught by node --check', () => {
    const r = buildIn((dir) => {
      const p = join(dir, 'src', 'app.js');
      writeFileSync(p, `${readFileSync(p, 'utf8')}\nconst TISSUES = 1;\n`);
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already been declared|node --check|does not parse/);
    assert.ok(!r.wrote);
  });

  test('a syntax error in one source is caught before anything is written', () => {
    const r = buildIn((dir) => {
      const p = join(dir, 'src', 'copy.js');
      writeFileSync(p, `${readFileSync(p, 'utf8')}\nconst broken = (;\n`);
    });
    assert.equal(r.status, 1);
    assert.ok(!r.wrote);
  });

  test('the untouched tree still builds', () => {
    const r = buildIn(null);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(r.wrote);
  });
});

// ---------------------------------------------------------------- vendored offline page (C9)
// `--vendor` inlines Three.js so the page needs no network at all. It is opt-in and needs the
// library on disk (dist/cdn-cache or node_modules), so the test skips when it is not there.
describe('the vendored offline build (docs/REVIEW.md C9)', () => {
  const cdnThree = join(root, 'dist', 'cdn-cache', 'cdn.jsdelivr.net');
  const nmThree = join(root, 'node_modules', 'three', 'build', 'three.module.js');
  const haveLib = existsSync(cdnThree) || existsSync(nmThree);

  test('writes dist/tissue-weather.offline.html with no import map and no CDN URL', { skip: haveLib ? false : 'three.module.js is not cached locally (dist/cdn-cache or node_modules)' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-vendor-'));
    try {
      cpSync(SRC, join(dir, 'src'), { recursive: true });
      cpSync(join(root, 'index.html'), join(dir, 'index.html'));
      mkdirSync(join(dir, 'tools'), { recursive: true });
      cpSync(join(root, 'tools', 'build_single.mjs'), join(dir, 'tools', 'build_single.mjs'));
      if (existsSync(cdnThree)) { mkdirSync(join(dir, 'dist', 'cdn-cache'), { recursive: true }); cpSync(cdnThree, join(dir, 'dist', 'cdn-cache', 'cdn.jsdelivr.net'), { recursive: true }); }
      else { mkdirSync(join(dir, 'node_modules'), { recursive: true }); cpSync(join(root, 'node_modules', 'three'), join(dir, 'node_modules', 'three'), { recursive: true }); }
      execFileSync(process.execPath, [join(dir, 'tools', 'build_single.mjs'), '--vendor'], { stdio: ['ignore', 'pipe', 'pipe'] });

      const off = readFileSync(join(dir, 'dist', 'tissue-weather.offline.html'), 'utf8');
      assert.ok(!/<script type="importmap">/.test(off), 'the import map must be gone: nothing is resolved by specifier any more');
      const urls = (off.match(/(?:src|href)="(https?:[^"]+)"/g) || []);
      assert.deepEqual(urls, [], `the offline page must not fetch anything: ${urls.join(', ')}`);
      assert.match(off, /window\.__TISSUE_THREE = \{/, 'three publishes its exports on a global');
      assert.match(off, /const THREE = window\.__TISSUE_THREE;/, 'the bundle binds that global instead of importing');
      assert.match(off, /const \{ ?OrbitControls ?\} = window\.__TISSUE_ADDON_ORBITCONTROLS;/);
      assert.ok(!/^\s*import\s/m.test(off.slice(off.indexOf('<script type="module">'))), 'no import statement may survive in any inlined module');
      assert.match(off, /SPDX-License-Identifier: MIT/, "three's licence header travels with the code");
      assert.equal((off.match(/<script type="module">/g) || []).length, 3, 'three, the addon and the app, in that order');

      // the CDN variants are still produced and still use the import map
      const cdn = readFileSync(join(dir, 'dist', 'tissue-weather.html'), 'utf8');
      assert.match(cdn, /<script type="importmap">/);
      assert.ok(off.length > cdn.length + 5e5, `the library really is inlined (offline ${off.length} vs CDN ${cdn.length} bytes)`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------- one three@ version (D9)
// The Three.js version is pinned in the page, in the renderer harness and in the docs. When they
// drift, the harness measures a different library from the one the app ships.
describe('the pinned three@ version agrees everywhere (docs/REVIEW.md D9)', () => {
  const FILES = ['index.html', 'tools/render_smoke.html', 'tools/render_smoke.mjs', 'docs/SPEC.md',
    'docs/ARCHITECTURE.md', 'README.md', 'src/app.js', 'blender/README.md'];
  test('every three@<version> mention matches index.html', () => {
    const pins = new Map();
    for (const rel of FILES) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(/three@(\d+\.\d+\.\d+)/g)) {
        if (!pins.has(rel)) pins.set(rel, new Set());
        pins.get(rel).add(m[1]);
      }
    }
    const app = [...(pins.get('index.html') || [])];
    assert.equal(app.length, 1, `index.html must pin exactly one three@ version, found: ${app.join(', ')}`);
    const disagree = [...pins].filter(([, vs]) => [...vs].some((v) => v !== app[0]))
      .map(([rel, vs]) => `${rel}: ${[...vs].join(', ')}`);
    assert.deepEqual(disagree, [], `these still name another three@ version than index.html's ${app[0]}:\n  ${disagree.join('\n  ')}`);
  });
});
