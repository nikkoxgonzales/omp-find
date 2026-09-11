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

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r5-'));
  for (const [rel, content] of Object.entries(struct)) {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const slash = (p) => p.replace(/\\/g, '/');
const rows = (res) => res.matches.map((m) => `${slash(m.path)}:${m.line}:${m.col}`);
const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };
function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); } };
}

describe('stress-round5: outline keeps Object.prototype-named methods', () => {
  it('constructor/toString/hasOwnProperty appear at depth 1', async () => {
    const root = await fixture({
      'w.ts': [
        'class Widget {',
        '  constructor()',
        '  {',
        '  }',
        '  toString() {',
        '  }',
        '  hasOwnProperty() {',
        '  }',
        '  valueOf() {',
        '  }',
        '}',
      ].join('\n'),
    });
    try {
      const res = await search.outlineFile('w.ts', { cwd: root, depth: 1 });
      const names = res.symbols.map((s) => s.name);
      for (const n of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.ok(names.includes(n), `missing ${n} in ${JSON.stringify(names)}`);
      }
      assert.ok(names.includes('Widget'));
      // blocklist still works: control-flow keywords are not methods
      const root2 = await fixture({ 'k.ts': 'class A {\n  m() {\n    if (x) {\n    }\n  }\n}\n' });
      try {
        const res2 = await search.outlineFile('k.ts', { cwd: root2, depth: 1 });
        const names2 = res2.symbols.map((s) => s.name);
        assert.ok(!names2.includes('if'), `blocklist leak: ${JSON.stringify(names2)}`);
      } finally {
        await rm(root2, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: structural kind: prototype keys', () => {
  it('kind:__proto__ and kind:constructor raise the clean unknown-kind error', async () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      await assert.rejects(
        search.structuralGrep(`kind:${k}`, { cwd: process.cwd() }),
        new RegExp(`unknown structural kind "${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
        `kind:${k} must hit the unknown-kind error`,
      );
    }
    const ok = search.compileStructural('kind:call');
    assert.equal(ok.mode, 'kind');
  });
});

describe('stress-round5: capped rg result set is deterministic', () => {
  it('60x400-line fixture: capped page is the sorted head, stable across runs and offsets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-r5cap-'));
    try {
      const line = 'hit ' + 'A'.repeat(40);
      for (let i = 0; i < 60; i++) {
        const name = `f${String(i).padStart(2, '0')}.txt`;
        await writeFile(join(root, name), (line + '\n').repeat(400));
      }
      const a = await search.grepContents('hit', { cwd: root });
      assert.equal(a.backend, 'rg');
      assert.equal(a.total, 20000);
      assert.equal(a.capped, true);
      assert.equal(a.matches.length, 20000);
      // Sorted head: files f00..f49 fully included (50*400 = 20000 rows)
      const first = rows(a)[0];
      const last = rows(a)[rows(a).length - 1];
      assert.equal(first, 'f00.txt:1:1');
      assert.equal(last, 'f49.txt:400:1');
      // Unique rows: no dupes inside the capped set
      assert.equal(new Set(rows(a)).size, 20000);
      // Same query again: identical subset (pre-fix the parallel emit order
      // could hand a different 20000-row subset to the sort)
      const b = await search.grepContents('hit', { cwd: root });
      assert.deepEqual(rows(b), rows(a), 're-fetch returned a different capped subset');
      // Cursor-style resume: offset page is a strict continuation, no overlap
      const c = await search.grepContents('hit', { cwd: root, offset: 19990 });
      assert.deepEqual(rows(c), rows(a).slice(19990), 'offset page is not a continuation of the snapshot');
      const d = await search.grepContents('hit', { cwd: root, limit: 50, offset: 19950 });
      assert.deepEqual(rows(d), rows(a).slice(19950, 20000));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: rg stdout over maxBuffer falls back to walker', () => {
  it('>64MB of match rows serves capped walker rows instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-r5big-'));
    try {
      // 400 files x 350 rows x ~490B/row ≈ 68MB of rg stdout > 64MB maxBuffer.
      // Lines stay under --max-columns 500 so every row is emitted.
      const line = 'x' + 'A'.repeat(478);
      const body = (line + '\n').repeat(350);
      for (let i = 0; i < 400; i++) {
        await writeFile(join(root, `b${String(i).padStart(3, '0')}.txt`), body);
      }
      const res = await search.grepContents('x', { cwd: root });
      assert.equal(res.backend, 'walker', `expected walker fallback, got ${res.backend}`);
      assert.equal(res.total, 20000);
      assert.equal(res.capped, true);
      assert.equal(res.matches.length, 20000);
    } finally {
      // The maxBuffer-killed rg child can still hold the dir on win32 — retry.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe('stress-round5: callers $-identifier edges', () => {
  it('callersOf(foo) does not match $foo() or import { $foo }', async () => {
    const root = await fixture({
      'a.ts': [
        'function foo() {}',
        'function $foo() {}',
        'foo();',
        '$foo();',
        'obj.foo();',
        'const foo$bar = () => {};',
        'foo$bar();',
      ].join('\n'),
      'b.ts': 'import { $foo } from "./a";\nimport { foo } from "./a";\nimport { foo$bar } from "./a";\n',
    });
    try {
      const res = await search.callersOf('foo', { cwd: root });
      const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text}`);
      assert.ok(texts.some((t) => t.includes('a.ts:3') && t.includes('foo();')), `missing foo() call: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('a.ts:5') && t.includes('obj.foo()')), `missing member access: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('b.ts:2') && t.includes('import { foo }')), `missing import: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('$foo();')), `$foo() false positive: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('import { $foo }')), `import $foo false positive: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('foo$bar')), `foo$bar false positive: ${JSON.stringify(texts)}`);
      // definition lines are filtered
      assert.ok(!texts.some((t) => t.includes('function foo')), `def line leaked: ${JSON.stringify(texts)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('callersOf($foo) resolves $-prefixed call and import sites (walker)', async () => {
    const root = await fixture({
      'a.ts': 'function $foo() {}\n$foo();\nfoo();\n',
      'b.ts': 'import { $foo } from "./a";\n',
    });
    try {
      const res = await search.callersOf('$foo', { cwd: root });
      const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text}`);
      assert.ok(texts.some((t) => t.includes('a.ts:2') && t.includes('$foo();')), `missing $foo() call: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('b.ts:1') && t.includes('$foo')), `missing $foo import: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('a.ts:3')), `bare foo() leaked into $foo callers: ${JSON.stringify(texts)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('callersOf(foo$) resolves $-suffixed call sites (walker)', async () => {
    const root = await fixture({
      'a.ts': 'function foo$() {}\nfoo$();\nfoo$bar();\n',
    });
    try {
      const res = await search.callersOf('foo$', { cwd: root });
      const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text}`);
      assert.ok(texts.some((t) => t.includes('a.ts:2') && t.includes('foo$();')), `missing foo$() call: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('foo$bar')), `foo$bar leaked into foo$ callers: ${JSON.stringify(texts)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffcallers tags $foo call sites as exact, not [possible]', async () => {
    const root = await fixture({
      'a.ts': 'function $foo() {}\n$foo();\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const tool = pi.tools.get('ffcallers');
      const out = textOf(await tool.execute('t1', { symbol: '$foo', cwd: root }));
      assert.match(out, /\$foo\(\);/, `missing $foo() row:\n${out}`);
      const hitLine = out.split('\n').find((l) => l.includes('$foo();'));
      assert.ok(hitLine && !hitLine.startsWith('[possible]'), `$foo() site mistagged:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: rg byte columns vs walker char columns', () => {
  it('multibyte prefix: rg col matches walker col', async () => {
    const root = await fixture({
      'u.txt': 'Étude foo\nplain foo\n',
    });
    try {
      const rg = await search.grepContents('foo', { cwd: root });
      assert.equal(rg.backend, 'rg');
      const walker = await search.grepContents('foo', { cwd: root, scan: 'mock' });
      assert.deepEqual(rows(rg), rows(walker), `col parity: ${JSON.stringify(rows(rg))} vs ${JSON.stringify(rows(walker))}`);
      const hit = rg.matches.find((m) => m.line === 1);
      assert.equal(hit.col, 7, 'É is 2 UTF-8 bytes: rg byte col 8 must become char col 7');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: u-flag SyntaxError retry on walker', () => {
  it('\\p{Lu}\\ (identity escape) runs on the walker instead of erroring', async () => {
    const root = await fixture({
      'u.txt': 'Xp{Lu} Y\nABC def\n',
    });
    try {
      const res = await search.grepContents('\\p{Lu}\\ ', { cwd: root, scan: 'mock', literal: false });
      assert.equal(res.backend, 'walker');
      assert.ok(res.matches.length >= 1, 'walker returned no rows');
      // rg accepts the same source (its \p{Lu} semantics differ — no parity claim)
      const rg = await search.grepContents('\\p{Lu}\\ ', { cwd: root, literal: false });
      assert.ok(rg.backend === 'rg' || rg.backend === 'walker');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: oversized argv falls back to walker', () => {
  it('a >128KB pattern spawns rg failure then serves walker rows', async () => {
    const big = 'z'.repeat(200 * 1024);
    const root = await fixture({ 'big.txt': big + '\n' });
    try {
      const res = await search.grepContents(big, { cwd: root });
      assert.equal(res.backend, 'walker', `expected walker fallback, got ${res.backend}`);
      assert.equal(res.total, 1);
      assert.equal(res.matches[0].col, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round5: leading (?i) inline flag', () => {
  it('(?i)foo matches FOO on both backends', async () => {
    const root = await fixture({ 'c.txt': 'FOO\nbar\n' });
    try {
      const rg = await search.grepContents('(?i)foo', { cwd: root, literal: false });
      assert.equal(rg.backend, 'rg');
      assert.deepEqual(rows(rg), ['c.txt:1:1']);
      const walker = await search.grepContents('(?i)foo', { cwd: root, scan: 'mock', literal: false });
      assert.deepEqual(rows(walker), rows(rg), 'walker/rg parity for (?i)');
      // literal mode: (?i) is literal text, not a flag
      const lit = await search.grepContents('(?i)foo', { cwd: root, literal: true });
      assert.equal(lit.total, 0);
      // mid-pattern inline flags still error
      await assert.rejects(
        search.grepContents('x(?i)y', { cwd: root, literal: false }),
        /invalid regex/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
