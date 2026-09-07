#!/usr/bin/env node
// tools/check_dist.mjs — is dist/ what tools/build_single.mjs would produce from src/ right now?
//
//   node tools/check_dist.mjs          (or: npm run check-dist)
//
// Copies index.html, src/ and tools/build_single.mjs into a temporary directory, runs the real
// build there (so this check can never drift from the build), and compares the results with the
// committed dist/*.html byte for byte. Exit 0 when they match, exit 1 with the first differing
// line when they do not. Used by CI and by the PR checklist in CONTRIBUTING.md: dist/ is a
// committed build artifact (it is what GitHub Pages and "open the file" serve), so a change to
// index.html or src/ that is not followed by `npm run build` ships a stale page.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = ['tissue-weather.html', 'tissue-weather.artifact.html'];

/** First line where the two strings differ, 1-based, plus a short excerpt of each. */
function firstDifference(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      const cut = (s) => (s === undefined ? '(end of file)' : s.length > 120 ? `${s.slice(0, 117)}…` : s);
      return { line: i + 1, committed: cut(la[i]), fresh: cut(lb[i]) };
    }
  }
  return null;
}

const tmp = mkdtempSync(join(tmpdir(), 'tissue-weather-dist-'));
let stale = [];
try {
  cpSync(join(root, 'src'), join(tmp, 'src'), { recursive: true });
  cpSync(join(root, 'index.html'), join(tmp, 'index.html'));
  mkdirSync(join(tmp, 'tools'), { recursive: true });
  cpSync(join(root, 'tools', 'build_single.mjs'), join(tmp, 'tools', 'build_single.mjs'));
  try {
    execFileSync(process.execPath, [join(tmp, 'tools', 'build_single.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`check-dist: the build itself failed — fix that first\n${(e.stderr || e.stdout || e.message).toString().trim()}`);
    process.exit(1);
  }
  for (const name of OUTPUTS) {
    const committedPath = join(root, 'dist', name);
    const fresh = readFileSync(join(tmp, 'dist', name), 'utf8');
    if (!existsSync(committedPath)) { stale.push({ name, missing: true, freshBytes: fresh.length }); continue; }
    const committed = readFileSync(committedPath, 'utf8');
    if (committed !== fresh) stale.push({ name, diff: firstDifference(committed, fresh), committedBytes: committed.length, freshBytes: fresh.length });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (stale.length === 0) {
  console.log(`check-dist: dist/ is up to date (${OUTPUTS.join(', ')})`);
  process.exit(0);
}
console.error('check-dist: dist/ is STALE — it does not match a fresh build of index.html + src/.\n');
for (const s of stale) {
  if (s.missing) { console.error(`  dist/${s.name}  MISSING (a fresh build writes ${s.freshBytes} bytes)`); continue; }
  console.error(`  dist/${s.name}  ${s.committedBytes} bytes committed vs ${s.freshBytes} bytes fresh`);
  if (s.diff) {
    console.error(`    first difference at line ${s.diff.line}:`);
    console.error(`      committed: ${s.diff.committed}`);
    console.error(`      fresh:     ${s.diff.fresh}`);
  }
}
console.error('\nFix: run `npm run build` (node tools/build_single.mjs) and commit dist/*.html.');
process.exit(1);
