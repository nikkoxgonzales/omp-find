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

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

const STORE_KEYS = ['LOCALAPPDATA', 'HOME', 'USERPROFILE'];
async function withStoreEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress6b-freq-'));
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

describe('stress-round6b: frecency clearedAt tombstone', () => {
  it('clear() then a stale instance recordOpen does not resurrect cleared keys', async () => {
    await withStoreEnv(async () => {
      const file = frecency.storePath();
      await mkdir(dirname(file), { recursive: true });
      // Seed the store with an entry old enough to predate the tombstone.
      await writeFile(file, JSON.stringify({ entries: { 'seed.ts': { count: 3, last: Date.now() - 60000 } } }));
      // Instance A loads the seeded store into its cache.
      assert.ok((await frecency.score('seed.ts')) > 0, 'A sees the seeded entry');
      // Instance B = a second process: own cache + write queue.
      const frecencyB = await import(`${dist('frecency.js')}?proc=tombstone`);
      await frecencyB.clear();
      // A's cache is now stale; its next save merges against the tombstoned file.
      await frecency.recordOpen('x.ts');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(saved.entries['seed.ts'], undefined, `cleared key stays cleared: ${JSON.stringify(saved)}`);
      assert.ok(saved.entries['x.ts'], 'the new recordOpen still lands');
      assert.equal(typeof saved.clearedAt, 'number', 'clearedAt survives the merge round-trip');
      assert.equal(await frecencyB.score('seed.ts'), 0, 'B scores the cleared key as 0');
      assert.ok((await frecencyB.score('x.ts')) > 0, 'B scores the post-clear key');
    });
  });

  it('a pre-tombstone store without clearedAt loads and merges fine', async () => {
    await withStoreEnv(async () => {
      const file = frecency.storePath();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ entries: { 'old.ts': { count: 2, last: Date.now() } } }));
      const frecencyC = await import(`${dist('frecency.js')}?proc=oldstore`);
      assert.ok((await frecencyC.score('old.ts')) > 0, 'old-format store scores');
      await frecencyC.recordOpen('new.ts');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(saved.entries['old.ts'] && saved.entries['new.ts'], `both entries survive: ${JSON.stringify(saved)}`);
    });
  });
});

describe('stress-round6b: cursor resume param drift notice', () => {
  const pagedFind = (seen) => ({
    ...search,
    findScanned: async (q) => {
      seen.push(q);
      return { paths: Array.from({ length: 40 }, (_, i) => `f${i}.ts`), scanned: 40, backend: 'walker' };
    },
  });

  it('resume with a different pattern notes it and keeps page-1 params', async () => {
    const seen = [];
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: pagedFind(seen), frecency: stubFrecency }, { mode: 'additive' });
    const fffind = pi.tools.get('fffind');
    const page1 = textOf(await fffind.execute('t', { pattern: 'alpha' }));
    const m = page1.match(/pass cursor "([^"]+)"/);
    assert.ok(m, `page 1 mints a cursor:\n${page1}`);
    const page2 = textOf(await fffind.execute('t', { cursor: m[1], pattern: 'beta' }));
    assert.match(page2, /note: cursor params in effect \(pattern[^\n]*from page 1\)/, `drift notice:\n${page2}`);
    assert.equal(seen[1], 'alpha', 'stored page-1 query still drives the re-fetch');
    assert.match(page2, /f30\.ts/, `page 2 rows resume at the stored offset:\n${page2}`);
  });

  it('resume with the same params stays silent', async () => {
    const seen = [];
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: pagedFind(seen), frecency: stubFrecency }, { mode: 'additive' });
    const fffind = pi.tools.get('fffind');
    const page1 = textOf(await fffind.execute('t', { pattern: 'alpha', limit: 30 }));
    const m = page1.match(/pass cursor "([^"]+)"/);
    assert.ok(m, `page 1 mints a cursor:\n${page1}`);
    const page2 = textOf(await fffind.execute('t', { cursor: m[1], pattern: 'alpha', limit: 30 }));
    assert.doesNotMatch(page2, /cursor params in effect/, `no notice when params match:\n${page2}`);
    assert.match(page2, /f30\.ts/, 'page 2 still resumes');
  });

  it('ffgrep resume with a different pattern notes it too', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ path: 'a.txt', line: i + 1, col: 1, text: 'x' }));
    const paged = { ...search, grepContents: async (_p, o = {}) => ({ matches: rows(40).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 30)), total: 40, backend: 'walker' }) };
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: paged, frecency: stubFrecency }, { mode: 'additive' });
    const ffgrep = pi.tools.get('ffgrep');
    const page1 = textOf(await ffgrep.execute('t', { pattern: 'x' }));
    const m = page1.match(/pass cursor "([^"]+)"/);
    assert.ok(m, `page 1 mints a cursor:\n${page1}`);
    const drift = textOf(await ffgrep.execute('t', { cursor: m[1], pattern: 'y' }));
    assert.match(drift, /note: cursor params in effect \(pattern[^\n]*from page 1\)/, `grep drift notice:\n${drift}`);
    const same = textOf(await ffgrep.execute('t', { cursor: m[1], pattern: 'x' }));
    assert.doesNotMatch(same, /cursor params in effect/, `no notice when params match:\n${same}`);
  });
});
