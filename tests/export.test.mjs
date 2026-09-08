// tests/export.test.mjs — the trajectory format, from the writer to the reader (docs/REVIEW.md D7).
// Run with `node --test tests/*.test.mjs` (or `npm test`).
//
// `snapshot()` + `exportMeta()` (src/engine.js) write it, `blender/import_tissue.py` reads it, and
// docs/EXTENDING.md §5 is the contract between them. Nothing exercised the pair: the JS side had
// unit tests, the python side had the committed fixtures, and a new key on one side could not be
// noticed by the other. So for every registered tissue this builds a fresh export, checks its
// shape against §5, and then hands it to the real reader:
//
//     python3 blender/import_tissue.py --input <fresh export> --dry-run --all-frames
//
// `--dry-run` parses and measures the file without Blender (bpy is optional), so the reader's
// per-frame arithmetic — fiber layout, species colours, cell shapes, load arrows — runs over the
// writer's actual output. The committed fixtures go through the same reader, so a fixture that
// falls behind the format is caught too. Everything is skipped when python3 is not installed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TissueEngine } from '../src/engine.js';
import { TISSUES } from '../src/tissues/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const IMPORTER = join(root, 'blender', 'import_tissue.py');

/** python3 on PATH? (The Blender importer only needs the standard library for --dry-run.) */
function havePython() {
  const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}
const PY = havePython();
const skip = PY ? false : 'python3 is not installed';

/** Run the importer's dry run over a trajectory file; returns its stdout. */
function dryRun(file, extra = []) {
  return execFileSync('python3', [IMPORTER, '--input', file, '--dry-run', ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A short format-2 trajectory of `tissue`: t = 0 plus `frames-1` snapshots `days` apart. */
function exportTrajectory(tissue, { frames = 3, days = 4, seed = 7 } = {}) {
  const M = new TissueEngine(tissue, { seed });
  const sc = tissue.scenarios[0];
  M.reset(sc.key);
  const out = [M.snapshot()];
  const steps = Math.max(1, Math.round(days / M.dt));
  for (let i = 1; i < frames; i++) { M.step(steps); out.push(M.snapshot()); }
  return { engine: M, traj: { meta: M.exportMeta({ exportEveryDays: days }), frames: out } };
}

describe('format-2 export (docs/EXTENDING.md §5)', () => {
  for (const [key, tissue] of Object.entries(TISSUES)) {
    test(`${key}: a fresh export has the documented shape`, () => {
      const { engine, traj } = exportTrajectory(tissue);
      const m = traj.meta, N3 = m.N ** 3;
      assert.equal(m.format, 2);
      assert.equal(m.tissue, key);
      assert.equal(m.N, engine.state.N);
      assert.ok(m.K >= 1 && m.L > 0 && m.dtDays > 0);
      assert.equal(m.scenario, tissue.scenarios[0].key);
      assert.deepEqual(m.species.map((s) => s.key), tissue.species.map((s) => s.key), 'meta.species mirrors the definition, in order');
      for (const s of m.species) assert.ok(s.label && s.kind && /^#[0-9a-f]{6}$/i.test(s.color), `species ${s.key} needs label/kind/colour`);
      assert.deepEqual(m.cellTypes.map((c) => c.key), tissue.cellTypes.map((c) => c.key));
      for (const c of m.cellTypes) {
        assert.equal(c.colors.length, 2);
        assert.equal(typeof c.radius, 'number', 'a state-dependent radius still exports the state-0 number');
        assert.ok(c.shape && typeof c.shape.by === 'string');
      }
      const loadDial = (tissue.dials.find((d) => d.role === 'load') || {}).key ?? null;
      assert.equal(m.loadDial, loadDial, 'the reader draws load arrows for this dial');
      assert.equal(m.cellCountDial, (tissue.dials.find((d) => d.role === 'cellCount') || {}).key ?? null);
      if (m.loadRange !== undefined) {                       // v0.4 additions are optional, but must agree
        const d = tissue.dials.find((x) => x.key === loadDial);
        assert.deepEqual(m.loadRange, [d.min, d.max]);
      }
      if (m.fields !== undefined) assert.deepEqual(m.fields.map((f) => f.key), tissue.fields.map((f) => f.key));

      for (const fr of traj.frames) {
        assert.equal(typeof fr.t, 'number');
        for (const s of tissue.species) assert.equal(fr.species[s.key].length, N3, `species.${s.key} is one value per voxel`);
        assert.equal(fr.fa.length, N3);
        assert.equal(fr.f.length, 3 * N3);
        assert.equal(fr.rho.length, N3, 'rho (= fiber total) is kept for format-1 readers');
        assert.equal(fr.phiMat.length, N3);
        const n = fr.cells.a.length;
        assert.equal(fr.cells.x.length, 3 * n);
        assert.equal(fr.cells.p.length, 3 * n);
        assert.equal(fr.cells.type.length, n);
        assert.deepEqual(fr.cells.alpha, fr.cells.a, 'alpha duplicates a for format-1 readers');
        if (fr.fields !== undefined) for (const f of tissue.fields) assert.equal(fr.fields[f.key].length, N3);
      }
      assert.ok(JSON.stringify(traj).length > 1000);
    });

    test(`${key}: blender/import_tissue.py --dry-run reads a fresh export`, { skip }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'tissue-weather-export-'));
      try {
        const { traj } = exportTrajectory(tissue);
        const file = join(dir, `${key}.json`);
        writeFileSync(file, JSON.stringify(traj));
        const out = dryRun(file, ['--all-frames']);
        assert.match(out, /format 2/, 'the reader must recognise the format it was handed');
        assert.match(out, new RegExp(`N=${traj.meta.N}\\b`));
        assert.match(out, /frames=3/);
        assert.match(out, /frame\s+2\s+t=/, 'every frame is measured, not just the first');
        for (const s of tissue.species) assert.match(out, new RegExp(`${s.key} \\[(fiber|gel|scaffold) #`), `species ${s.key} reached the reader`);
        for (const c of tissue.cellTypes) assert.match(out, new RegExp(`${c.key} \\(colours #`));
        assert.match(out, /would build 3 frame\(s\)/);
        const loadDial = (tissue.dials.find((d) => d.role === 'load') || {}).key;
        if (loadDial) assert.match(out, new RegExp(`(2 load arrows \\(${loadDial}|no load arrows)`), 'the load dial is named or the arrows are off');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  // v0.4: a field's `pointScale` / `style` render hints travel with the export, so an offline
  // renderer draws the haze the browser drew (blender/import_tissue.py normalise_fields reads
  // them). They are emitted ONLY when the definition declares one, which is why the two shipped
  // tissues' exports did not change shape when the writer gained this.
  test('a field\'s render hints are exported only when the definition declares them', { skip }, () => {
    const base = TISSUES.fibrous;
    for (const f of new TissueEngine(base, { seed: 7 }).exportMeta().fields) {
      assert.deepEqual(Object.keys(f).sort(), ['color', 'key', 'label'], 'no hint declared, no hint emitted');
    }
    const hinted = Object.assign({}, base, {
      fields: base.fields.map((f, i) => (i === 0 ? Object.assign({}, f, { pointScale: 1.4, style: 'points' }) : f)),
    });
    const meta = new TissueEngine(hinted, { seed: 7 }).exportMeta();
    assert.equal(meta.fields[0].pointScale, 1.4);
    assert.equal(meta.fields[0].style, 'points');
    assert.ok(!('pointScale' in meta.fields[1]), 'a field that declares nothing stays as it was');

    // the reader takes the value rather than defaulting it, and the file still parses
    const dir = mkdtempSync(join(tmpdir(), 'tw-hint-'));
    try {
      const { traj } = exportTrajectory(hinted);
      const file = join(dir, 'hinted.json');
      writeFileSync(file, JSON.stringify(traj));
      assert.match(dryRun(file), /dry run: format 2/);
      const read = execFileSync('python3', ['-c', [
        'import importlib.util, json, sys',
        "spec = importlib.util.spec_from_file_location('it', sys.argv[1])",
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        "meta = json.load(open(sys.argv[2]))['meta']",
        'print(json.dumps([f["pointScale"] for f in m.normalise_fields(meta["fields"], [])]))',
      ].join('\n'), IMPORTER, file], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(read), [1.4, 1], 'the importer reads the declared scale and defaults the other');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the committed sample trajectories still read', { skip }, () => {
    const fixtures = ['sample_trajectory.json', 'sample_trajectory_cartilage.json']
      .map((f) => join(root, 'blender', f)).filter(existsSync);
    assert.ok(fixtures.length >= 1, 'at least one fixture must exist: it is the Blender README\'s example input');
    for (const f of fixtures) {
      const out = dryRun(f);
      assert.match(out, /dry run: format [12]/, `${f} is neither format 1 nor format 2`);
      assert.match(out, /would build 1 frame\(s\)/);
      assert.match(out, /fiber segments/);
    }
  });
});
