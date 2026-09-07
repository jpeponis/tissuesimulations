#!/usr/bin/env node
// tools/new_tissue.mjs — scaffold a new tissue definition (docs/EXTENDING.md §8 step 1).
//
//   node tools/new_tissue.mjs <key> "<Name>"        (or: npm run new-tissue -- <key> "<Name>")
//   node tools/new_tissue.mjs <key> "<Name>" --dry-run     print what would change, write nothing
//
// It copies src/tissues/_template.js to src/tissues/<key>.js with
//   • the exported constant renamed TISSUE_TEMPLATE → TISSUE_<KEY>,
//   • any `tpl…` helper renamed to `<camelKey>…` (top-level identifiers must be unique
//     across src/ — the single-file build concatenates every source into one module),
//   • `key:` and `name:` set, and a fresh header comment,
// and registers it in src/tissues/index.js: one one-line local import plus one entry in the
// TISSUES object. Both edits are idempotent-by-refusal: if the key, the file or the identifier
// is already there, nothing is written and the tool exits 1 with a message.
//
// The generated file obeys the build constraints of docs/EXTENDING.md §0 (ES module, named
// exports only, unique top-level identifiers, local imports on one line), so
// `node tools/build_single.mjs` and `node --test tests/*.test.mjs` keep working; the starter
// passes the conformance suite unchanged, which is the point of scaffolding from it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TISSUE_DIR = join(root, 'src', 'tissues');
const INDEX = join(TISSUE_DIR, 'index.js');
const TEMPLATE = join(TISSUE_DIR, '_template.js');
const RESERVED = new Set(['index', 'template', '_template', 'total', 'fiber']);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const DRY = flags.has('--dry-run');

function die(msg) { console.error(`new_tissue: ${msg}`); process.exit(1); }

if (flags.has('--help') || flags.has('-h') || positional.length === 0) {
  console.log('usage: node tools/new_tissue.mjs <key> "<Name>" [--dry-run]\n' +
    '  <key>   registry/URL key, [a-z][a-z0-9-]*  (e.g. tendon, cartilage, smooth-muscle)\n' +
    '  <Name>  human-readable name shown in the tissue picker');
  process.exit(positional.length === 0 ? 1 : 0);
}

const key = positional[0];
const name = positional.length > 1 ? positional.slice(1).join(' ') : key;
for (const f of flags) if (!['--dry-run', '--help', '-h'].includes(f)) die(`unknown flag ${f}`);
if (!/^[a-z][a-z0-9-]*$/.test(key)) die(`bad key '${key}': use lower-case letters, digits and hyphens, starting with a letter`);
if (RESERVED.has(key)) die(`'${key}' is reserved`);
if (!name.trim()) die('the name must not be empty');

// TISSUE_MY_TISSUE for the exported constant, myTissue for helper identifiers.
const CONST = `TISSUE_${key.toUpperCase().replace(/-/g, '_')}`;
const idPrefix = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const target = join(TISSUE_DIR, `${key}.js`);
const rel = `src/tissues/${key}.js`;

// ---------------------------------------------------------------- refuse if it already exists
if (!existsSync(TEMPLATE)) die(`missing ${TEMPLATE} — the starter template is the source of the copy`);
if (existsSync(target)) die(`${rel} already exists — pick another key or delete that file first`);
let index = readFileSync(INDEX, 'utf8');
const codeLines = index.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const code = codeLines.join('\n');
if (new RegExp(`\\b${CONST}\\b`).test(code)) die(`${CONST} is already imported in src/tissues/index.js`);
if (new RegExp(`^\\s*'?${key}'?\\s*:`, 'm').test(code)) die(`key '${key}' is already registered in src/tissues/index.js`);
if (new RegExp(`from\\s+'\\./${key}\\.js'`).test(code)) die(`src/tissues/index.js already imports './${key}.js'`);

// ---------------------------------------------------------------- the tissue file
const template = readFileSync(TEMPLATE, 'utf8');
const header = `/*
 * src/tissues/${key}.js — ${CONST}: ${name}.
 *
 * Scaffolded from src/tissues/_template.js by tools/new_tissue.mjs. Everything below is the
 * starter tissue (cells replacing a dissolving hydrogel); it already passes the conformance
 * suite, so change it in small steps and re-run \`node --test tests/*.test.mjs\` as you go:
 *
 *   1. species / fields / cellTypes / dials — what the matrix is made of and what the dials are
 *   2. scenarios — at least two, each with machine-checkable \`checks\`
 *   3. makeRules() — what the cells secrete and what the matrix does
 *   4. copy — the intro, legend and vocabulary the app and the equilibrium sentence use
 *
 * Contract: docs/EXTENDING.md (§1 shape, §2 hooks, §7 what the tests demand).
 * Build constraint: every top-level identifier in this file must be unique across src/
 * (the single-file build concatenates all sources) — prefix helpers with \`${idPrefix}\`.
 */`;
let body = template
  .replace(/^\/\*[\s\S]*?\*\/\n/, `${header}\n`)               // replace the template's header block
  .replace(/\bTISSUE_TEMPLATE\b/g, CONST)
  .replace(/\btpl([A-Z][A-Za-z0-9_$]*)/g, `${idPrefix}$1`)
  .replace(/^(\s*key:\s*)'template'/m, `$1'${key}'`)
  .replace(/^(\s*name:\s*)'[^']*'/m, `$1'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
if (!body.includes(`export const ${CONST} = {`)) die('the template no longer exports TISSUE_TEMPLATE — update tools/new_tissue.mjs');
if (!new RegExp(`key:\\s*'${key}'`).test(body)) die("could not set the tissue's `key` field — update tools/new_tissue.mjs");

// ---------------------------------------------------------------- the registry
const lines = index.split('\n');
const isImport = (l) => /^import\s+\{[^}]*\}\s+from\s+'\.\/[^']+\.js';\s*$/.test(l);
let importAt = -1;
for (let i = 0; i < lines.length; i++) if (isImport(lines[i])) importAt = i;
if (importAt < 0) {
  importAt = lines.findIndex((l) => /^export\s+const\s+TISSUES\b/.test(l));
  if (importAt < 0) die('src/tissues/index.js has neither a local import nor `export const TISSUES` — register the tissue by hand');
  importAt -= 1;                                               // insert just above the registry
}
lines.splice(importAt + 1, 0, `import { ${CONST} } from './${key}.js';`);

const openAt = lines.findIndex((l) => /^export\s+const\s+TISSUES\s*=/.test(l));
if (openAt < 0) die('src/tissues/index.js does not declare `export const TISSUES` — register the tissue by hand');
let closeAt = -1;
for (let i = openAt; i < lines.length; i++) if (/^\}\)?;\s*$/.test(lines[i])) { closeAt = i; break; }
if (closeAt < 0) die('could not find the end of the TISSUES object in src/tissues/index.js — register the tissue by hand');
let entryAt = openAt;                                          // after the last real entry, else after the opening line
for (let i = openAt; i < closeAt; i++) if (/^\s*'?[A-Za-z0-9_$-]+'?\s*:\s*[A-Za-z_$][\w$]*\s*,?\s*(\/\/.*)?$/.test(lines[i]) && !/^\s*\/\//.test(lines[i])) entryAt = i;
lines.splice(entryAt + 1, 0, `  ${/^[a-z][a-z0-9]*$/.test(key) ? key : `'${key}'`}: ${CONST},`);
const nextIndex = lines.join('\n');

// ---------------------------------------------------------------- write
if (DRY) {
  console.log(`--dry-run: would write ${rel} (${(body.length / 1024).toFixed(1)} KB) and register it in src/tissues/index.js:\n`);
  console.log(nextIndex.split('\n').map((l) => `  ${l}`).join('\n'));
  process.exit(0);
}
writeFileSync(target, body);
writeFileSync(INDEX, nextIndex);
console.log(`wrote ${rel} (${CONST}) and registered '${key}' in src/tissues/index.js

next (docs/EXTENDING.md §8):
  2. fill in species, fields, cellTypes, dials and at least two scenarios with \`checks\`
  3. write makeRules(): what the cells secrete, what the matrix does
  4. node tools/run_headless.mjs --tissue ${key}   &&  node --test tests/*.test.mjs
  5. node tools/build_single.mjs   &&  open index.html?tissue=${key}`);
