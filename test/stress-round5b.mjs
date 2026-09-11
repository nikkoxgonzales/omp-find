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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-stress5b-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress5b-freq-'));
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

const rows = (n, file = 'a.txt') =>
  Array.from({ length: n }, (_, i) => ({ path: file, line: i + 1, col: 1, text: 'x' }));

describe('stress-round5b: capped result sets mint no cursor', () => {
  it('ffgrep shows the narrow-the-query hint instead of a cursor', async () => {
    const cappedSearch = {
      ...search,
      grepContents: async () => ({ matches: rows(1, 'big.txt'), total: 20000, backend: 'walker', capped: true }),
    };
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: cappedSearch, frecency: stubFrecency }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'x' }));
    assert.match(out, /\(20000\+ matches total, capped\)/, `totals line:\n${out}`);
    assert.match(out, /capped result set — narrow the query for full results/, `hint:\n${out}`);
    assert.doesNotMatch(out, /pass cursor/, 'no cursor minted on a capped set');
  });

  it('ffcallers and ffstructural suppress the cursor too', async () => {
    const cappedSearch = {
      ...search,
      callersOf: async () => ({ matches: rows(40), total: 40, backend: 'walker', capped: true }),
      structuralGrep: async () => ({ matches: rows(40), total: 40, backend: 'walker', capped: true }),
      compileStructural: () => ({ mode: 'pattern' }),
      previewRewrite: () => [],
    };
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: cappedSearch, frecency: stubFrecency }, { mode: 'additive' });
    const callers = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'x' }));
    assert.match(callers, /capped result set — narrow the query for full results/, `ffcallers hint:\n${callers}`);
    assert.doesNotMatch(callers, /pass cursor/, 'ffcallers mints no cursor');
    const structural = textOf(await pi.tools.get('ffstructural').execute('t', { pattern: '$A' }));
    assert.match(structural, /capped result set — narrow the query for full results/, `ffstructural hint:\n${structural}`);
    assert.doesNotMatch(structural, /pass cursor/, 'ffstructural mints no cursor');
  });

  it('uncapped results keep the cursor flow byte-identical', async () => {
    const pi = fakePi();
    const paged = { ...search, grepContents: async (_p, o = {}) => ({ matches: rows(40).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 30)), total: 40, backend: 'walker' }) };
    findTools.registerFindTools(pi, { search: paged, frecency: stubFrecency }, { mode: 'additive' });
    const ffgrep = pi.tools.get('ffgrep');
    const out = textOf(await ffgrep.execute('t', { pattern: 'x' }));
    const m = out.match(/pass cursor "([^"]+)" for the next page/);
    assert.ok(m, `uncapped page mints a cursor:\n${out}`);
    assert.match(out, /30 matches limit reached \(max 50\) — more via cursor/, 'limit notice intact');
    const page2 = textOf(await ffgrep.execute('t', { cursor: m[1] }));
    assert.match(page2, /a\.txt:31:1: x/, `page 2 resumes at offset 30:\n${page2}`);
    assert.doesNotMatch(page2, /pass cursor/, 'last page mints no further cursor');
  });
});

describe('stress-round5b: fffind file pin', () => {
  it('path pinned to a file lists the file instead of double-matching it away', async () => {
    const root = await fixture({ 'sub/pin.ts': 'export const pin = 1;\n', 'sub/other.ts': 'export const other = 1;\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const fffind = pi.tools.get('fffind');

      const listed = textOf(await fffind.execute('t', { path: 'sub/pin.ts', cwd: root }));
      assert.match(listed, /sub\/pin\.ts/, `file pin + empty pattern lists the file:\n${listed}`);
      assert.doesNotMatch(listed, /other\.ts/, 'pin scopes to the one file');

      const fuzzy = textOf(await fffind.execute('t', { path: 'sub/pin.ts', pattern: 'pin', cwd: root }));
      assert.match(fuzzy, /sub\/pin\.ts/, `file pin + pattern fuzzy-matches the filename:\n${fuzzy}`);

      const miss = textOf(await fffind.execute('t', { path: 'sub/pin.ts', pattern: 'zzz', cwd: root }));
      assert.match(miss, /0 matches/, `non-matching pattern inside a file pin:\n${miss}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5b: scope escape errors', () => {
  it('path escaping the scan root errors instead of silently widening', async () => {
    const root = await fixture({ 'a.txt': 'x\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const ffgrep = pi.tools.get('ffgrep');
      const fffind = pi.tools.get('fffind');

      const grepOut = textOf(await ffgrep.execute('t', { pattern: 'x', path: '../x', cwd: root }));
      assert.match(grepOut, /ffgrep failed: path escapes the scan root: \.\.\/x/, `ffgrep escape:\n${grepOut}`);

      const findOut = textOf(await fffind.execute('t', { path: '../x', cwd: root }));
      assert.match(findOut, /fffind failed: path escapes the scan root: \.\.\/x/, `fffind escape:\n${findOut}`);

      const absOut = textOf(await ffgrep.execute('t', { pattern: 'x', path: '/etc', cwd: root }));
      assert.match(absOut, /ffgrep failed: path escapes the scan root: \/etc/, `absolute path escape:\n${absOut}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5b: frecency __proto__ key', () => {
  it('a path literally named __proto__ persists across save + reload', async () => {
    await withStoreEnv(async () => {
      // Fresh module instance = a second process: own cache + write queue.
      const frecencyB = await import(`${dist('frecency.js')}?proc=proto`);
      await frecency.recordOpen('__proto__');
      const file = frecency.storePath();
      const saved = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(Object.hasOwn(saved.entries, '__proto__'), `__proto__ persisted: ${JSON.stringify(saved)}`);
      assert.equal(saved.entries['__proto__'].count, 1);
      // B's cache is cold, so score() re-reads disk — the proto key must survive
      // the sanitize pass too (plain-object entries would drop it on write).
      assert.ok((await frecencyB.score('__proto__')) > 0, 'reloaded __proto__ scores > 0');
      assert.equal(await frecencyB.score('constructor'), 0, 'other magic names stay clean');
    });
  });
});

describe('stress-round5b: cursor eviction after the capped policy', () => {
  it('FIFO-200 still evicts cleanly; capped results never consume slots', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: { ...search, grepContents: async (_p, o = {}) => ({ matches: rows(40).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 30)), total: 40, backend: 'walker' }) }, frecency: stubFrecency }, { mode: 'additive' });
    const ffgrep = pi.tools.get('ffgrep');
    const ids = [];
    for (let i = 0; i < 205; i++) {
      const m = textOf(await ffgrep.execute('t', { pattern: 'x' })).match(/pass cursor "([^"]+)"/);
      assert.ok(m, `call ${i} mints a cursor`);
      ids.push(m[1]);
    }
    const evicted = textOf(await ffgrep.execute('t', { cursor: ids[0] }));
    assert.match(evicted, /unknown or expired cursor/, `oldest cursor evicted:\n${evicted}`);
    const live = textOf(await ffgrep.execute('t', { cursor: ids[ids.length - 1] }));
    assert.match(live, /a\.txt:31:1: x/, `newest cursor still resumes:\n${live}`);
  });
});
