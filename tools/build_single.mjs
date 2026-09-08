#!/usr/bin/env node
// tools/build_single.mjs — inline src/*.js into one page.
//
//   node tools/build_single.mjs            dist/tissue-weather.html          full standalone page
//                                          dist/tissue-weather.artifact.html body fragment (title+style first)
//   node tools/build_single.mjs --vendor   dist/tissue-weather.offline.html  the same page with Three.js
//                                          inlined: no import map, no CDN, no network at all
//
// The build CONCATENATES the sources into one module (docs/EXTENDING.md §0): it strips `export `
// from declarations, drops local `import … from './…'` lines and hoists the external ones. That
// only works while the three §0 constraints hold, so this script refuses to write a broken page:
//
//   1. every local import specifier must resolve to a file the bundle actually carries
//      (a helper in src/_utils.js, or anything outside src/, is a dead reference in the bundle);
//   2. no `import` / `export` statement may survive the strip (multi-line imports, `export default`,
//      `export { … }`, `export *`);
//   3. the assembled module must parse — `node --check` catches syntax errors and the duplicate
//      top-level declarations that concatenating two files into one scope can produce.
//
// Each failure throws with the offending `src/file:line`. Nothing is written when a check fails.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.argv.includes('--vendor');

// ---------------------------------------------------------------- what goes into the bundle
// copy → engine → tissues/* (index.js last) → plots → recipe → render → app  (docs/EXTENDING.md §0)
// `recipe.js` is OPTIONAL: it is the shared fiber-layout recipe, present only once that landed.
// Order is fixed on purpose — the bundle is one module evaluated top to bottom, and reordering it
// is how a `const` ends up used before its declaration.
const OPTIONAL = new Set(['recipe.js']);
const tissueFiles = readdirSync(join(root, 'src', 'tissues')).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_')).sort().map((f) => `tissues/${f}`);
const order = ['copy.js', 'engine.js', ...tissueFiles, 'tissues/index.js', 'plots.js', 'recipe.js', 'render.js', 'app.js']
  .filter((f) => !OPTIONAL.has(f) || existsSync(join(root, 'src', f)));
const bundled = new Set(order);

const fail = (lines) => { throw new Error(['build_single: refusing to write a broken bundle.', ...lines].join('\n')); };

/** Resolve a local specifier seen in src/<from> to a path relative to src/, or null if it escapes src/. */
function resolveLocal(from, spec) {
  const parts = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
  const out = parts.slice();
  for (const p of spec.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (out.length === 0) return null; out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

const LOCAL_IMPORT = /^import\s[\s\S]*?from\s+['"](\.\.?\/[^'"]+)['"]/;
const EXTERNAL_IMPORT = /^import\s.*from\s+['"]([^'".][^'"]*)['"]/;
// A statement the strip did not remove. `import(` / `await import(` are expressions, not statements.
const LEFTOVER = /^\s*(?:import\s+[^(\s]|import\s*[{*'"`]|export\b)/;

// ---------------------------------------------------------------- assemble
const externalImports = new Set();
const unresolved = [], leftovers = [];
let body = '';
for (const f of order) {
  const src = readFileSync(join(root, 'src', f), 'utf8');
  const kept = [];
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    const local = LOCAL_IMPORT.exec(t);
    if (local) {                                                       // local import: dropped (concatenated)
      const target = resolveLocal(f, local[1]);
      if (target === null || !bundled.has(target)) {
        unresolved.push(`  src/${f}:${i + 1}: imports '${local[1]}'${target === null ? ' (outside src/)' : ` → src/${target}`}, which the bundle does not carry`);
      }
      return;
    }
    const ext = EXTERNAL_IMPORT.exec(t);
    if (ext) { externalImports.add(t); return; }                        // external: hoisted to the top
    const out = line.replace(/^export\s+(const|let|var|function|class|async function)\s/, '$1 ');
    if (LEFTOVER.test(out)) leftovers.push(`  src/${f}:${i + 1}: ${out.trim().slice(0, 110)}`);  // §0 violation
    kept.push(out);
  });
  body += `\n// ===== src/${f} =====\n${kept.join('\n')}\n`;
}

if (unresolved.length) fail([
  'A local import points at a file that is not in the bundle. The bundle is a concatenation, so',
  'that import is silently dropped and the page dies at the first use of the missing symbol.',
  ...unresolved,
  `Bundle order: ${order.join(', ')}`,
  'Fix: put the helper in one of those files, or add it to `order` in tools/build_single.mjs',
  'and to the build order in docs/EXTENDING.md §0.']);
if (leftovers.length) fail([
  'An `import` / `export` statement survived the strip. The build only removes single-line local',
  'imports and `export ` in front of const/let/var/function/class/async function (EXTENDING.md §0).',
  ...leftovers,
  'Fix: write the import on one line as `import { a, b } from \'./x.js\';`, and use named exports only.']);

const moduleText = `${[...externalImports].join('\n')}\n${body}`;
syntaxCheck(moduleText, 'the assembled bundle');

/** `node --check` the module text; rethrow with the source of the complaint. */
function syntaxCheck(text, what) {
  const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-check-'));
  const file = join(dir, 'bundle.mjs');
  try {
    writeFileSync(file, text);
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message).toString().replace(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<bundle>');
    fail([`${what} does not parse (node --check). Two usual causes: a syntax error in one source,`,
      'or two sources declaring the same top-level name (the bundle is ONE scope — see the',
      '"top-level identifiers are unique" test in tests/build.test.mjs).', '', msg.trim()]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- write the CDN outputs
const script = `<script type="module">\n${[...externalImports].join('\n')}\n${body}</script>`;
let html = readFileSync(join(root, 'index.html'), 'utf8');
const marker = '<script type="module" src="./src/app.js"></script>';
if (!html.includes(marker)) throw new Error('marker not found in index.html');
const full = html.replace(marker, () => script);   // function replacer: `$&` / `$'` in a source must stay literal
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'tissue-weather.html'), full);

// artifact fragment: strip the document skeleton, keep title/link/style/importmap/body content
const head = full.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta[^>]*>\s*/g, '');
const inner = full.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync(join(root, 'dist', 'tissue-weather.artifact.html'), `${head.trim()}\n${inner.trim()}\n`);
console.log('built dist/tissue-weather.html and dist/tissue-weather.artifact.html', (full.length / 1024).toFixed(0), 'KB');

// ---------------------------------------------------------------- --vendor: the offline page
// Three.js ships as an ES module, and an inline module cannot import another inline module without
// a URL (the artifact host's CSP blocks blob:/data: scripts, which is why the CDN variants stay).
// So each vendored module is emitted as its own <script type="module"> that publishes its exports
// on `window`, and the bundle reads them from there. Module scripts run in document order, so
// three is always defined before the addons, and the addons before the app.
if (VENDOR) buildOffline();

function buildOffline() {
  const map = readImportMap(html);
  const sources = new Map();                                   // specifier → { text, global }
  const globals = [];
  for (const stmt of externalImports) {
    const spec = /from\s+['"]([^'"]+)['"]/.exec(stmt)[1];
    if (!sources.has(spec)) {
      const url = specifierUrl(spec, map);
      const name = spec === 'three' ? '__TISSUE_THREE' : `__TISSUE_ADDON_${spec.split('/').pop().replace(/\.js$/, '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
      sources.set(spec, { text: esmToGlobal(fetchVendor(url), name, url), global: name });
    }
    globals.push(bindStatement(stmt, spec, sources.get(spec).global));
  }
  if (!sources.has('three')) fail(['--vendor: the bundle does not import three; nothing to vendor.']);
  // three first (the addons destructure from its global), then the addons, then the app
  const ordered = [['three', sources.get('three')], ...[...sources].filter(([k]) => k !== 'three')];
  const blocks = ordered.map(([spec, v]) => `<script type="module">\n/* vendored ${spec} */\n${v.text}\n</script>`);
  blocks.push(`<script type="module">\n${globals.join('\n')}\n${body}</script>`);
  const joined = blocks.join('\n');
  let out = html.replace(marker, () => joined);   // ditto — three.module.js contains a `$'`
  out = out.replace(/[ \t]*<script type="importmap">[\s\S]*?<\/script>\n?/, '')                     // no import map: nothing to resolve
    .replace(/[ \t]*<link rel="preconnect"[^>]*fonts\.[^>]*>\n?/g, '')                              // no webfont round-trip either:
    .replace(/[ \t]*<link rel="stylesheet"[^>]*fonts\.googleapis\.com[^>]*>\n?/g, '')               // the CSS names local fallbacks
    .replace(/[ \t]*<link rel="modulepreload"[^>]*>\n?/g, '');
  const left = out.match(/https:\/\/(?:cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)[^\s"'<)]*/g);
  const inMarkup = (left || []).filter((u) => out.includes(`"${u}"`) || out.includes(`'${u}'`));
  if (inMarkup.length) fail(['--vendor: the offline page still points at the network:', ...new Set(inMarkup.map((u) => `  ${u}`))]);
  writeFileSync(join(root, 'dist', 'tissue-weather.offline.html'), out);
  console.log('built dist/tissue-weather.offline.html', (out.length / 1024 / 1024).toFixed(2), 'MB',
    `(vendored: ${[...sources.keys()].join(', ')})`);
}

/** { "three": url, "three/addons/": prefix } from index.html's import map. */
function readImportMap(page) {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page);
  if (!m) fail(['--vendor: index.html has no <script type="importmap">, so there is no version to vendor.']);
  return JSON.parse(m[1]).imports || {};
}

function specifierUrl(spec, map) {
  if (map[spec]) return map[spec];
  for (const [k, v] of Object.entries(map)) if (k.endsWith('/') && spec.startsWith(k)) return v + spec.slice(k.length);
  return fail([`--vendor: the import map does not resolve '${spec}'.`]);
}

/** The vendored source of `url`: dist/cdn-cache, then node_modules, then curl (--fail, temp+rename). */
function fetchVendor(url) {
  const u = new URL(url);
  const cache = join(root, 'dist', 'cdn-cache', u.hostname, u.pathname.replace(/^\//, ''));
  if (!existsSync(cache)) {
    const local = nodeModulesPath(u.pathname);
    if (local && existsSync(local)) return readFileSync(local, 'utf8');
    mkdirSync(dirname(cache), { recursive: true });
    const tmp = `${cache}.part`;
    console.log('fetching', url);
    try {
      execFileSync('curl', ['-sSL', '--fail', '--max-time', '120', '-o', tmp, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      rmSync(tmp, { force: true });
      fail([`--vendor: could not download ${url}`, `  ${(e.stderr || e.message).toString().trim()}`,
        '  Put the file in dist/cdn-cache/<host>/<path> (or install three into node_modules) and retry.']);
    }
    renameSync(tmp, cache);                                     // never leave a half file in the cache
  }
  return readFileSync(cache, 'utf8');
}

/** /npm/three@0.160.0/build/three.module.js → node_modules/three/build/three.module.js */
function nodeModulesPath(pathname) {
  const m = /\/npm\/(@?[^@/]+(?:\/[^@/]+)?)@[^/]+\/(.*)$/.exec(pathname);
  return m ? join(root, 'node_modules', m[1], m[2]) : null;
}

/** Rewrite an ES module into one that publishes its exports on window.<name> and reads three from window. */
function esmToGlobal(text, name, url) {
  if (/<\/script/i.test(text) || /<!--/.test(text)) fail([`--vendor: ${url} contains markup that cannot be inlined in a <script>.`]);
  let out = text.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]three['"];?/m, (_, names) => `const {${names}} = window.__TISSUE_THREE;`);
  const stray = out.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*import\s/.test(l));
  if (stray.length) fail([`--vendor: ${url} imports something other than 'three' — vendoring it is not implemented:`,
    ...stray.map(([i, l]) => `  line ${i}: ${l.trim().slice(0, 100)}`)]);
  const exp = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(out.trimEnd());
  if (!exp) fail([`--vendor: ${url} does not end in an \`export { … };\` block; cannot turn it into a global.`]);
  const entries = exp[1].split(',').map((s) => s.trim()).filter(Boolean).map((e) => {
    const as = /^(\S+)\s+as\s+(\S+)$/.exec(e);
    return as ? `${as[2]}: ${as[1]}` : e;
  });
  out = out.trimEnd().slice(0, exp.index) + `window.${name} = { ${entries.join(', ')} };\n`;
  syntaxCheck(out, `the vendored ${url}`);
  return out;
}

/** `import * as THREE from 'three';` → `const THREE = window.__TISSUE_THREE;` (and the named form). */
function bindStatement(stmt, spec, name) {
  const ns = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/.exec(stmt);
  if (ns) return `const ${ns[1]} = window.${name};`;
  const named = /^import\s*\{([^}]*)\}\s*from/.exec(stmt);
  if (named) return `const {${named[1].replace(/\s+as\s+/g, ': ')}} = window.${name};`;
  return fail([`--vendor: cannot bind '${stmt}' to a global (only \`import * as X\` and \`import { a, b }\` are handled).`]);
}
