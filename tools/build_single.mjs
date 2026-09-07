// Inlines src/*.js into one page. Two outputs:
//   dist/tissue-weather.html          full standalone page (double-click, GitHub Pages)
//   dist/tissue-weather.artifact.html body fragment (title+style first) for hosts that wrap the page
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// copy → engine → tissues/* (index.js last) → plots → render → app  (docs/EXTENDING.md §0)
const tissueFiles = readdirSync(join(root, 'src', 'tissues')).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_')).sort().map((f) => `tissues/${f}`);
const order = ['copy.js', 'engine.js', ...tissueFiles, 'tissues/index.js', 'plots.js', 'render.js', 'app.js'];
const externalImports = new Set();
let body = '';
for (const f of order) {
  let src = readFileSync(join(root, 'src', f), 'utf8');
  src = src.split('\n').filter((line) => {
    const t = line.trim();
    if (/^import\s.*from\s+['"]\.\.?\//.test(t)) return false;          // local import: dropped (concatenated)
    if (/^import\s.*from\s+['"]/.test(t)) { externalImports.add(t); return false; } // external: hoisted
    return true;
  }).join('\n');
  src = src.replace(/^export\s+(const|let|var|function|class|async function)\s/gm, '$1 ');
  body += `\n// ===== src/${f} =====\n${src}\n`;
}
const script = `<script type="module">\n${[...externalImports].join('\n')}\n${body}</script>`;
let html = readFileSync(join(root, 'index.html'), 'utf8');
const marker = '<script type="module" src="./src/app.js"></script>';
if (!html.includes(marker)) throw new Error('marker not found in index.html');
const full = html.replace(marker, script);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'tissue-weather.html'), full);

// artifact fragment: strip the document skeleton, keep title/link/style/importmap/body content
const head = full.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta[^>]*>\s*/g, '');
const inner = full.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync(join(root, 'dist', 'tissue-weather.artifact.html'), `${head.trim()}\n${inner.trim()}\n`);
console.log('built dist/tissue-weather.html and dist/tissue-weather.artifact.html', (full.length / 1024).toFixed(0), 'KB');
