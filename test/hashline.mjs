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

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-hashline-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };
const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

describe('hashline: xxh32 primitive (seed 0, Math.imul throughout, no merge round)', () => {
  it('matches the standard short-input vectors', () => {
    const enc = new TextEncoder();
    assert.equal(hex8(findTools.xxh32Bytes(enc.encode(''), 0)), '02CC5D05');
    assert.equal(hex8(findTools.xxh32Bytes(enc.encode('abc'), 0)), '32D153FF');
  });

  it('matches the oracle on lane and multi-stripe inputs', () => {
    const enc = new TextEncoder();
    // Python xxhash oracle (seed 0): tail-lane and 16+ byte stripe coverage.
    const vecs = [
      ['hello\n', '946B5BF9'],
      ['hell', 'D66D38F4'],
      ['a'.repeat(15), '6A786076'],
      ['a'.repeat(16), '5DACDD8C'],
      ['a'.repeat(17), 'DF090C34'],
      ['a'.repeat(20), '31B53804'],
      ['0123456789abcdef', 'C2C45B69'],
      ['The quick brown fox jumps over the lazy dog', 'E85EA4DE'],
      ['x'.repeat(32), '25CEF61D'],
    ];
    for (const [s, want] of vecs) {
      assert.equal(hex8(findTools.xxh32Bytes(enc.encode(s), 0)), want, `xxh32(${JSON.stringify(s.slice(0, 12))}…)`);
    }
  });
});

describe('hashline: file tag pipeline (BOM strip, LF normalize, per-line rstrip)', () => {
  it('reproduces the store::file_hash edge table', () => {
    assert.equal(findTools.hashlineFileHash('a \n b\t\r\nc'), '80BA');
    assert.equal(findTools.hashlineFileHash('hello\n'), '5BF9');
    assert.equal(findTools.hashlineFileHash(''), '5D05');
  });

  it('is invariant over line endings, BOM, and trailing whitespace', () => {
    assert.equal(findTools.hashlineFileHash('hello\r\n'), '5BF9');
    assert.equal(findTools.hashlineFileHash('hello\r'), '5BF9');
    assert.equal(findTools.hashlineFileHash('\uFEFFhello\n'), '5BF9');
    assert.equal(findTools.hashlineFileHash('hello   \n'), '5BF9');
  });

  it('formats [path#TAG] headers with forward slashes', () => {
    assert.equal(findTools.hashlineHeader('src/a.ts', 'hello\n'), '[src/a.ts#5BF9]');
  });
});

describe('hashline: ffgrep prefixes each file group with its header', () => {
  it('one header per file on the page, ahead of that file rows', async () => {
    const root = await fixture({
      'a.txt': 'needle one\ntail\n',
      'sub/b.txt': 'head\nneedle two\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root }));
      const lines = out.split('\n');
      const ha = `[a.txt#${findTools.hashlineFileHash('needle one\ntail\n')}]`;
      const hb = `[sub/b.txt#${findTools.hashlineFileHash('head\nneedle two\n')}]`;
      const ia = lines.indexOf(ha);
      const ib = lines.indexOf(hb);
      assert.ok(ia >= 0, `missing header ${ha}:\n${out}`);
      assert.ok(ib >= 0, `missing header ${hb}:\n${out}`);
      const ra = lines.findIndex((l) => l.startsWith('a.txt:1:'));
      const rb = lines.findIndex((l) => l.startsWith('sub/b.txt:2:'));
      assert.ok(ra > ia, `a.txt rows follow their header:\n${out}`);
      assert.ok(rb > ib, `sub/b.txt rows follow their header:\n${out}`);
      assert.ok(out.includes('(2 matches total)'), `totals footer intact:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('concise pages group path:line rows under headers too', async () => {
    const root = await fixture({ 'c.txt': 'needle here\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root, concise: true }));
      const head = `[c.txt#${findTools.hashlineFileHash('needle here\n')}]`;
      const lines = out.split('\n');
      assert.ok(lines.includes(head), `missing concise header:\n${out}`);
      assert.ok(lines.indexOf('c.txt:1') > lines.indexOf(head), `row follows header:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
