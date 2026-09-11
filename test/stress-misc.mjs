import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search, findTools, frecency;
before(async () => {
  search = await import(dist('search.js'));
  findTools = await import(dist('tools.js'));
  frecency = await import(dist('frecency.js'));
});

function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); } };
}

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-stress-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => textOf(out).match(/pass cursor "([^"]+)"/)?.[1];
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

/** Search double forcing the walker (scan:"mock") through the real core. */
const walkerOf = (core) => ({
  ...core,
  findScanned: (q, o = {}) => core.findScanned(q, { ...o, scan: 'mock' }),
  findPaths: (q, o = {}) => core.findPaths(q, { ...o, scan: 'mock' }),
  grepContents: (p, o = {}) => core.grepContents(p, { ...o, scan: 'mock' }),
});

async function withStoreEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress-freq-'));
  const keys = ['LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = dir;
  try {
    return await fn(dir);
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('stress-misc: malformed frecency store', () => {
  it('wrong-typed entries are dropped or coerced; score() never returns NaN', async () => {
    await withStoreEnv(async (dir) => {
      // Point the store at a fresh base so load() misses the module cache and
      // reads the malformed file from disk (covers win32 LOCALAPPDATA and
      // POSIX HOME/USERPROFILE resolutions alike).
      const alt = join(dir, 'alt');
      for (const k of ['LOCALAPPDATA', 'HOME', 'USERPROFILE']) process.env[k] = alt;
      const file = frecency.storePath();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({
        entries: {
          'bad.ts': { count: 'x', last: 'y' },
          'neg.ts': { count: -3, last: Date.now() },
          'nul.ts': null,
          'coerce.ts': { count: '4', last: String(Date.now()) },
        },
      }));

      assert.equal(await frecency.score('bad.ts'), 0, 'non-numeric count/last dropped');
      assert.equal(await frecency.score('neg.ts'), 0, 'negative count dropped');
      assert.equal(await frecency.score('nul.ts'), 0, 'non-object entry dropped');
      const coerced = await frecency.score('coerce.ts');
      assert.ok(Number.isFinite(coerced) && coerced > 0, `numeric strings coerce, got ${coerced}`);

      // recordOpen still works on a store that held malformed entries, and the
      // persisted file comes back fully sanitized. recordOpen stats the path,
      // so the recorded file must exist on disk.
      const fresh = join(dir, 'fresh.ts');
      await writeFile(fresh, 'x');
      await frecency.recordOpen(fresh);
      assert.ok((await frecency.score(fresh)) > 0, 'recordOpen still bumps');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(saved.entries['coerce.ts'].count, 4, 'coerced count persists as a number');
      assert.ok(!('bad.ts' in saved.entries) && !('neg.ts' in saved.entries) && !('nul.ts' in saved.entries),
        'dropped entries stay dropped after save');
    });
  });
});

describe('stress-misc: limit notice points at the cursor', () => {
  it('never suggests a limit above the 50 page cap', async () => {
    const struct = {};
    for (let i = 0; i < 55; i++) struct[`f${String(i).padStart(2, '0')}.ts`] = 'x\n';
    const root = await fixture(struct);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search: walkerOf(search), frecency: stubFrecency }, { mode: 'additive' });
      const fffind = pi.tools.get('fffind');

      const small = textOf(await fffind.execute('t', { pattern: 'ts', cwd: root, limit: 1 }));
      assert.match(small, /1 matches limit reached \(max 50\) — more via cursor/, `notice:\n${small}`);
      assert.doesNotMatch(small, /Use limit=/, 'no bigger-limit advice');

      // A requested limit above the cap is clamped to 50; the hint names the cap.
      const capped = textOf(await fffind.execute('t', { pattern: 'ts', cwd: root, limit: 100 }));
      assert.match(capped, /50 matches limit reached \(max 50\) — more via cursor/, `clamped notice:\n${capped}`);
      assert.doesNotMatch(capped, /limit=100|Use limit=/, 'no impossible advice');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-misc: cursor store eviction', () => {
  it('the 201st cursor evicts the oldest, which fails as unknown or expired', async () => {
    const root = await fixture({ 'a.ts': 'x\n', 'b.ts': 'y\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search: walkerOf(search), frecency: stubFrecency }, { mode: 'additive' });
      const fffind = pi.tools.get('fffind');

      let first, last;
      for (let i = 0; i < 201; i++) {
        const c = cursorOf(await fffind.execute('t', { pattern: 'ts', cwd: root, limit: 1 }));
        assert.ok(c, `call ${i} mints a cursor`);
        if (i === 0) first = c;
        last = c;
      }

      const evicted = textOf(await fffind.execute('t', { cursor: first }));
      assert.match(evicted, /fffind failed: unknown or expired cursor/, `evicted cursor:\n${evicted}`);

      // Newest cursor is still live and resumes onto page 2.
      const resumed = textOf(await fffind.execute('t', { cursor: last }));
      assert.match(resumed, /b\.ts/, `fresh cursor still resumes:\n${resumed}`);
      assert.doesNotMatch(resumed, /unknown or expired/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
