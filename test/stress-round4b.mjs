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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-stress4b-'));
  for (const [rel, content] of Object.entries(struct)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

const STORE_KEYS = ['LOCALAPPDATA', 'HOME', 'USERPROFILE'];
async function withStoreEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress4b-freq-'));
  const old = Object.fromEntries(STORE_KEYS.map((k) => [k, process.env[k]]));
  for (const k of STORE_KEYS) process.env[k] = dir;
  try {
    return await fn(dir);
  } finally {
    for (const k of STORE_KEYS) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('stress-round4b: cross-process frecency merge-on-save', () => {
  it('two interleaved writers on one store keep both batches', async () => {
    await withStoreEnv(async () => {
      // A second module instance simulates a second omp process: own cache +
      // write queue, same store file (env + cwd are process-global).
      const frecencyB = await import(`${dist('frecency.js')}?proc=B`);
      const file = frecency.storePath();

      // Seed the store and prime both instances' caches — each "process" has
      // loaded once, so B's cache goes stale the moment A saves.
      await frecency.recordOpen('seed.ts');
      await frecencyB.score('seed.ts');

      // Interleave: A bumps + saves, then B bumps + saves from its stale cache.
      // Pre-fix B's save clobbered A's batch (last-writer-wins); merge-on-save
      // must fold A's keys back in.
      await frecency.recordOpen('a.ts');
      await frecencyB.recordOpen('b.ts');

      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.ok('a.ts' in saved.entries, `A batch survives B save: ${JSON.stringify(saved)}`);
      assert.ok('b.ts' in saved.entries, 'B batch persisted');
      assert.ok('seed.ts' in saved.entries, 'seed survives');

      // Reverse interleave: B bumps first, then A saves from its stale cache —
      // A's merge must fold B's new key in too.
      await frecencyB.recordOpen('b2.ts');
      await frecency.recordOpen('a2.ts');
      const saved2 = JSON.parse(await readFile(file, 'utf8'));
      assert.ok('b2.ts' in saved2.entries && 'a2.ts' in saved2.entries, 'reverse interleave keeps both batches');

      // Same-key bumps merge as max, not sum — the documented under-count.
      await frecency.recordOpen('shared.ts');
      await frecencyB.recordOpen('shared.ts');
      const saved3 = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(saved3.entries['shared.ts'].count, 1, 'same-key merge keeps max, not sum');
    });
  });
});

describe('stress-round4b: GREP_CAP capped flag', () => {
  it('core sets capped when the match set hits GREP_CAP', async () => {
    const root = await fixture({ 'big.txt': 'x\n'.repeat(20050) });
    try {
      const res = await search.grepContents('x', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 20000, 'match set stops at the cap');
      assert.equal(res.capped, true, 'capped flag set at the cap');

      const under = await search.grepContents('x', { cwd: root, scan: 'mock', scope: 'big.txt', literal: true });
      assert.ok(under.capped, 'scoped re-fetch still capped');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('core leaves capped unset under the cap', async () => {
    const root = await fixture({ 'a.txt': 'x\nx\n', 'b.txt': 'x\n' });
    try {
      const res = await search.grepContents('x', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 3);
      assert.ok(!res.capped, 'no capped flag under the cap');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep renders capped totals as N+ with a capped note', async () => {
    const cappedSearch = {
      ...search,
      grepContents: async () => ({
        matches: [{ path: 'big.txt', line: 1, col: 1, text: 'x' }],
        total: 20000,
        backend: 'walker',
        capped: true,
      }),
    };
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: cappedSearch, frecency: stubFrecency }, { mode: 'additive' });
    const ffgrep = pi.tools.get('ffgrep');
    const first = await ffgrep.execute('t', { pattern: 'x' });
    const out = textOf(first);
    assert.match(out, /\(20000\+ matches total, capped\)/, `totals line:\n${out}`);
    assert.match(out, /\(19999\+ more; pass cursor "[^"]+" for the next page\)/, `cursor footer:\n${out}`);
    assert.equal(first.details.capped, true, 'details carry the capped flag');

    const tight = textOf(await ffgrep.execute('t', { pattern: 'x', maxChars: 1 }));
    assert.match(tight, /Matched 20000\+ hits in 1 file \(output exceeds 1 chars, capped\)/, `over-budget line:\n${tight}`);
  });

  it('uncapped results render without the marker', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: { ...search, grepContents: async () => ({ matches: [{ path: 'a.txt', line: 1, col: 1, text: 'x' }], total: 1, backend: 'walker' }) }, frecency: stubFrecency }, { mode: 'additive' });
    const ffgrep = pi.tools.get('ffgrep');
    const out = textOf(await ffgrep.execute('t', { pattern: 'x' }));
    assert.match(out, /\(1 match total\)/, `plain totals line:\n${out}`);
    assert.doesNotMatch(out, /capped|\+ matches/, 'no capped marker');
  });
});

describe('stress-round4b: hostile frecency store', () => {
  it('score/recordOpen/status never throw on garbage or wrong-shaped files', async () => {
    await withStoreEnv(async (dir) => {
      const shapes = [
        'not json {{{',
        '{"entries":[1,2,3]}',
        '{"entries":{"a.ts":{"count":null}}}',
        '',
      ];
      for (let i = 0; i < shapes.length; i++) {
        // Fresh base per shape so load() misses the module cache and re-reads disk.
        const alt = join(dir, `alt${i}`);
        for (const k of STORE_KEYS) process.env[k] = alt;
        const file = frecency.storePath();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, shapes[i]);
        assert.equal(await frecency.score('x.ts'), 0, `shape ${i} scores 0`);
        await frecency.recordOpen('x.ts'); // must not throw
        assert.equal(typeof frecency.status(), 'string', `shape ${i} status is a string`);
      }
    });
  });
});
