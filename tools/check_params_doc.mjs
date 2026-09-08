#!/usr/bin/env node
// tools/check_params_doc.mjs — keep the "as built" parameter blocks in the docs equal to the code.
//
//   node tools/check_params_doc.mjs            check every documented tissue (exit 1 on a mismatch)
//   node tools/check_params_doc.mjs --write    rewrite the blocks from the tissue definitions
//   node tools/check_params_doc.mjs --tissue cartilage [--write]
//
// docs/REVIEW.md D5: the numbers used to live in three or four places — the tissue definition, the
// spec table, the model write-up and the tissue's own document — and the copies drifted (the
// cartilage document was ~14 values behind its implementation). Now each document carries ONE
// generated block between HTML markers
//
//     <!-- params:fibrous -->  …generated…  <!-- /params:fibrous -->
//
// filled from `TISSUES[key].engine` and `TISSUES[key].params`. Everything around the block stays
// hand-written (that is where the sources, the plausible ranges and the reasoning live): the block
// is only the record of what the code actually runs. `npm test` runs this checker
// (tests/tools.test.mjs), so changing a parameter without re-running `--write` fails the suite.
//
// Numbers are printed to six significant figures and compared numerically (1e-6 relative), so a
// value like 1/14 reads as 0.0714286 in the document and still matches the code exactly.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TISSUES } from '../src/tissues/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** tissue key → the document that carries its as-built block. */
export const PARAMS_DOCS = {
  fibrous: 'docs/MODEL.md',
  cartilage: 'docs/tissues/cartilage-hydrogel.md',
};

const COLS = 4, PAD = 2;

/** 6 significant figures, without exponent noise: 0.07142857142857142 → 0.0714286, 20 → 20. */
export function paramsFormatValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(6));
  if (typeof v === 'string') return `'${v}'`;
  return JSON.stringify(v);
}

/** { key: value } of one block, flattened (`a.b`) so a nested params object still round-trips. */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

/** The generated body for a tissue: two labelled groups of `key = value`, four to a line. */
export function paramsBlockBody(tissue) {
  const groups = [['engine', flatten(tissue.engine)], ['params', flatten(tissue.params)]];
  const width = Math.max(...groups.flatMap(([, o]) => Object.entries(o).map(([k, v]) => `${k} = ${paramsFormatValue(v)}`.length))) + PAD;
  const lines = [];
  for (const [label, obj] of groups) {
    const entries = Object.entries(obj).map(([k, v]) => `${k} = ${paramsFormatValue(v)}`);
    if (!entries.length) continue;
    for (let i = 0; i < entries.length; i += COLS) {
      const chunk = entries.slice(i, i + COLS).map((e, j) => (i + j === Math.min(i + COLS, entries.length) - 1 ? e : e.padEnd(width)));
      lines.push(`${(i === 0 ? label : '').padEnd(8)}${chunk.join('')}`.trimEnd());
    }
  }
  const counts = groups.map(([label, o]) => `${Object.keys(o).length} ${label}`).join(' + ');
  return [
    `<!-- Generated from src/tissues/${tissue.key}.js by \`node tools/check_params_doc.mjs --write\`.`,
    '     Do not edit inside the markers: `npm test` compares every number with the code. -->',
    `**As built** — what \`src/tissues/${tissue.key}.js\` runs today (${counts}). The sourced table in this`,
    'section says what the numbers have to answer to; this block says what they are.',
    '',
    '```text',
    ...lines,
    '```',
  ].join('\n');
}

/** Parse a generated body back into { key: value } per group. */
export function paramsParseBlock(body) {
  const fence = /```text\n([\s\S]*?)\n```/.exec(body);
  if (!fence) return null;
  const out = { engine: {}, params: {} };
  let group = null;
  for (const line of fence[1].split('\n')) {
    if (!line.trim()) continue;
    const label = line.slice(0, 8).trim();
    if (label) group = label;
    if (!group || !(group in out)) return null;
    for (const entry of line.slice(8).split(/ {2,}/)) {
      const m = /^([\w.]+)\s*=\s*(.+?)\s*$/.exec(entry.trim());
      if (!m) { if (entry.trim()) return null; continue; }
      out[group][m[1]] = m[2];
    }
  }
  return out;
}

const MARK = (key) => ({ open: `<!-- params:${key} -->`, close: `<!-- /params:${key} -->` });

/** Compare one document with its tissue; returns { file, problems[], updated }. */
export function paramsCheckTissue(key, { write = false } = {}) {
  const tissue = TISSUES[key];
  const rel = PARAMS_DOCS[key];
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  const { open, close } = MARK(key);
  const i = text.indexOf(open), j = text.indexOf(close);
  const body = paramsBlockBody(tissue);
  if (i < 0 || j < i) {
    return { file: rel, updated: false, problems: [
      `${rel}: no \`${open}\` … \`${close}\` block. Add the markers where the as-built values belong, then run:`,
      '  node tools/check_params_doc.mjs --write'] };
  }
  const current = text.slice(i + open.length, j).trim();
  const fresh = `${open}\n${body}\n${close}`;
  if (write) {
    const next = text.slice(0, i) + fresh + text.slice(j + close.length);
    if (next !== text) { writeFileSync(file, next); return { file: rel, updated: true, problems: [] }; }
    return { file: rel, updated: false, problems: [] };
  }
  if (current === body) return { file: rel, updated: false, problems: [] };

  // Not byte-identical: say WHICH values disagree (formatting-only drift is reported as such).
  const doc = paramsParseBlock(current);
  if (!doc) return { file: rel, updated: false, problems: [`${rel}: the params:${key} block is not in the generated shape — run \`node tools/check_params_doc.mjs --write\``] };
  const code = { engine: flatten(tissue.engine), params: flatten(tissue.params) };
  const problems = [];
  for (const group of ['engine', 'params']) {
    for (const [k, v] of Object.entries(code[group])) {
      const shown = doc[group][k];
      if (shown === undefined) { problems.push(`${rel}: ${group}.${k} is missing from the document (code: ${paramsFormatValue(v)})`); continue; }
      if (typeof v === 'number') {
        const x = Number(shown);
        if (!Number.isFinite(x) || Math.abs(x - v) > 1e-6 * Math.max(1, Math.abs(v))) {
          problems.push(`${rel}: ${group}.${k} — document says ${shown}, src/tissues/${key}.js has ${paramsFormatValue(v)}`);
        }
      } else if (shown !== paramsFormatValue(v)) {
        problems.push(`${rel}: ${group}.${k} — document says ${shown}, src/tissues/${key}.js has ${paramsFormatValue(v)}`);
      }
    }
    for (const k of Object.keys(doc[group])) {
      if (!(k in code[group])) problems.push(`${rel}: ${group}.${k} is in the document but no longer in src/tissues/${key}.js`);
    }
  }
  if (!problems.length) problems.push(`${rel}: the params:${key} block says the same numbers but is formatted differently — run \`node tools/check_params_doc.mjs --write\``);
  return { file: rel, updated: false, problems };
}

/** Check (or rewrite) every tissue that has a document. Returns a flat list of problems. */
export function paramsCheckAll({ write = false, only = null } = {}) {
  const problems = [], written = [];
  for (const key of Object.keys(PARAMS_DOCS)) {
    if (only && key !== only) continue;
    if (!TISSUES[key]) { problems.push(`tools/check_params_doc.mjs: PARAMS_DOCS names tissue '${key}', which is not registered`); continue; }
    const r = paramsCheckTissue(key, { write });
    problems.push(...r.problems);
    if (r.updated) written.push(r.file);
  }
  for (const key of Object.keys(TISSUES)) {
    if (!PARAMS_DOCS[key] && !only) problems.push(`no as-built block for tissue '${key}': add one and list it in PARAMS_DOCS (tools/check_params_doc.mjs)`);
  }
  return { problems, written };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && process.argv[1].endsWith('check_params_doc.mjs')) {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const ti = argv.indexOf('--tissue');
  const only = ti >= 0 ? argv[ti + 1] : null;
  if (argv.includes('--help')) {
    console.log('usage: node tools/check_params_doc.mjs [--write] [--tissue KEY]\n' +
      `  documents: ${Object.entries(PARAMS_DOCS).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
    process.exit(0);
  }
  const { problems, written } = paramsCheckAll({ write, only });
  if (write) {
    console.log(written.length ? `rewrote the as-built block in: ${written.join(', ')}` : 'as-built blocks already up to date');
  }
  if (problems.length) {
    console.error(`check_params_doc: ${problems.length} problem${problems.length > 1 ? 's' : ''}\n  ${problems.join('\n  ')}` +
      (write ? '' : '\n\nFix: change the parameter in the tissue definition (it is the source of truth), then run\n  node tools/check_params_doc.mjs --write'));
    process.exit(1);
  }
  if (!write) console.log(`check_params_doc: the as-built blocks match the code (${Object.keys(PARAMS_DOCS).join(', ')})`);
}
