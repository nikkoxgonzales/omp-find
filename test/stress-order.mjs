import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search, findTools;
before(async () => {
  search = await import(dist('search.js'));
  findTools = await import(dist('tools.js'));
});

function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); } };
}

async function fixture(n = 65) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-order-'));
  for (let i = 0; i < n; i++) {
    const rel = join(`d${i % 8}`, `f${String(i).padStart(2, '0')}.txt`);
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `line one\nORDER_MARKER ${i}\nline three\n`);
  }
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

const keyOf = (m) => `${m.path.replace(/\\/g, '/')}:${m.line}:${m.col}`;
const isSorted = (keys) => keys.every((k, i) => i === 0 || keys[i - 1] <= k);

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

function rowKeysOf(text) {
  const keys = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) continue;
    const m = /^(\S+):(\d+):(\d+):/.exec(line);
    if (m) keys.push(`${m[1]}:${m[2]}:${m[3]}`);
  }
  return keys;
}

const cursorOf = (text) => /pass cursor "([^"]+)"/.exec(text)?.[1];

describe('stress-order: rg grepContents order is deterministic', () => {
  it('two back-to-back identical calls give byte-identical row order', async () => {
    const root = await fixture();
    try {
      const a = await search.grepContents('ORDER_MARKER', { cwd: root });
      const b = await search.grepContents('ORDER_MARKER', { cwd: root });
      assert.equal(a.backend, 'rg');
      assert.equal(b.backend, 'rg');
      assert.equal(a.total, 65);
      const ka = a.matches.map(keyOf), kb = b.matches.map(keyOf);
      assert.deepEqual(ka, kb);
      assert.ok(isSorted(ka), 'rows are path/line/col ordered');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-order: tool cursor chain delivers every row exactly once', () => {
  it('multi-page ffgrep walk to exhaustion has no dupes or omissions', async () => {
    const root = await fixture();
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency });
      const grep = pi.tools.get('ffgrep');
      assert.ok(grep, 'ffgrep registered');
      const seen = [];
      let params = { pattern: 'ORDER_MARKER', cwd: root, limit: 10 };
      for (let page = 0; page < 20; page++) {
        const text = textOf(await grep.execute('id', params));
        assert.ok(!/results changed since page 1/.test(text), 'no stale cursor mid-chain');
        seen.push(...rowKeysOf(text));
        const next = cursorOf(text);
        if (!next) break;
        params = { pattern: 'ORDER_MARKER', cwd: root, limit: 10, cursor: next };
      }
      const core = await search.grepContents('ORDER_MARKER', { cwd: root });
      assert.equal(core.backend, 'rg');
      assert.equal(core.total, 65);
      assert.equal(seen.length, core.total);
      assert.equal(new Set(seen).size, seen.length, 'no duplicate rows');
      assert.deepEqual([...seen].sort(), core.matches.map(keyOf).sort());
      assert.ok(isSorted(seen), 'chained pages arrive in path/line/col order');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-order: walker grepContents order is deterministic', () => {
  it('two back-to-back walker calls give byte-identical row order', async () => {
    const root = await fixture();
    try {
      const a = await search.grepContents('ORDER_MARKER', { cwd: root, scan: 'mock' });
      const b = await search.grepContents('ORDER_MARKER', { cwd: root, scan: 'mock' });
      assert.equal(a.backend, 'walker');
      assert.equal(b.backend, 'walker');
      assert.equal(a.total, 65);
      const ka = a.matches.map(keyOf), kb = b.matches.map(keyOf);
      assert.deepEqual(ka, kb);
      assert.ok(isSorted(ka), 'walker rows are path/line/col ordered');
    } finally {
      await cleanup(root);
    }
  });
});
