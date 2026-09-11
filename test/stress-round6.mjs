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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r6-'));
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

describe('stress-round6: callersOf depth-2 ring scans run in a bounded pool', () => {
  it('400-file tree: walker d2 < 15s with correct depth-1/depth-2 rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-r6perf-'));
    try {
      const writes = [writeFile(join(root, 'main.ts'), 'export function target() {}\n')];
      for (let i = 0; i < 40; i++) {
        writes.push(writeFile(join(root, `mid${i}.ts`), `export function mid${i}() {\n  return target();\n}\n`));
        writes.push(writeFile(join(root, `caller${i}.ts`), `import { mid${i} } from "./mid${i}";\nexport function caller${i}() {\n  return mid${i}();\n}\n`));
      }
      for (let i = 0; i < 320; i++) writes.push(writeFile(join(root, `filler${i}.ts`), `export const filler${i} = ${i};\n`));
      await Promise.all(writes);
      const t0 = Date.now();
      const res = await search.callersOf('target', { cwd: root, depth: 2, scan: 'mock' });
      const elapsed = Date.now() - t0;
      assert.equal(res.backend, 'walker');
      assert.ok(elapsed < 15000, `walker d2 took ${elapsed}ms (sequential rings were ~65s)`);
      const d1 = res.matches.filter((m) => m.depth === 1);
      const d2 = res.matches.filter((m) => m.depth === 2);
      assert.equal(d1.length, 40, `40 mid* call sites at depth 1: ${d1.length}`);
      // Each caller file contributes the import line + the call line.
      assert.equal(d2.length, 80, `80 caller* sites at depth 2: ${d2.length}`);
      assert.ok(d1.every((m) => m.via === 'target'), 'depth-1 rows attributed via target');
      assert.ok(d2.every((m) => /^mid\d+$/.test(m.via)), `depth-2 rows attributed via mid*: ${d2.map((m) => m.via).slice(0, 5)}`);
      // rg backend agrees on the row set (order already sorted by path:line).
      const rg = await search.callersOf('target', { cwd: root, depth: 2 });
      assert.equal(rg.total, res.total, `rg total ${rg.total} != walker ${res.total}`);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe('stress-round6: outline sees async functions', () => {
  it('export async function / async function / async fn all list', async () => {
    const root = await fixture({
      'a.ts': [
        'export async function fetchData() {}',
        'async function helper() {}',
        'export default async function main() {}',
        'export function plain() {}',
      ].join('\n'),
      'b.rs': 'pub async fn serve() {}\nfn plain() {}\n',
      'c.xyz': 'async function mystery() {}\n',
    });
    try {
      const names = (await search.outlineFile('a.ts', { cwd: root })).symbols.map((s) => s.name);
      for (const n of ['fetchData', 'helper', 'main', 'plain']) {
        assert.ok(names.includes(n), `missing ${n} in ${JSON.stringify(names)}`);
      }
      const rs = (await search.outlineFile('b.rs', { cwd: root })).symbols.map((s) => s.name);
      assert.ok(rs.includes('serve') && rs.includes('plain'), `rust async fn missed: ${JSON.stringify(rs)}`);
      const gen = (await search.outlineFile('c.xyz', { cwd: root })).symbols.map((s) => s.name);
      assert.ok(gen.includes('mystery'), `generic async function missed: ${JSON.stringify(gen)}`);
      // enclosing attribution sees async functions too
      const g = await search.grepContents('return', { cwd: root, scan: 'mock' });
      assert.ok(g, 'grep still works');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: capsule finds method definitions', () => {
  it('capsuleOf(constructor) resolves the nested method def', async () => {
    const root = await fixture({
      'w.ts': [
        'class Widget {',
        '  constructor() {',
        '  }',
        '  render() {',
        '  }',
        '}',
      ].join('\n'),
      'u.ts': 'const w = new Widget();\nw.render();\n',
    });
    try {
      const cap = await search.capsuleOf('constructor', { cwd: root });
      assert.ok(cap.found, 'capsule reports not found');
      assert.equal(slash(cap.defFile ?? ''), 'w.ts', `def file: ${cap.defFile}`);
      assert.equal(cap.defLine, 2, `def line: ${cap.defLine}`);
      assert.equal(cap.defKind, 'method', `def kind: ${cap.defKind}`);
      // top-level defs still resolve at depth 1
      const cap2 = await search.capsuleOf('Widget', { cwd: root });
      assert.equal(cap2.defKind, 'class', `class def regressed: ${cap2.defKind}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: chained combinators error instead of silently matching nothing', () => {
  it('inside:/has: operands starting with a combinator prefix throw a clean error', async () => {
    // Recursive inside:/has: chaining is rejected; kind:/symbol:/references: are valid structural operands.
    for (const p of ['inside: inside: x >> y', 'has: $X << has: y', 'inside: has: a >> b']) {
      assert.throws(() => search.compileStructural(p), /combinators cannot be chained/, `no error for ${p}`);
    }
    // tool layer surfaces it via the <tool> failed: contract
    const root = await fixture({ 'a.ts': 'const x = 1;\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const tool = pi.tools.get('ffstructural');
      const out = textOf(await tool.execute('t1', { pattern: 'inside: inside: x >> y', cwd: root }));
      assert.match(out, /ffstructural failed:.*combinators cannot be chained/, `tool output:\n${out}`);
      // unchained combinators with kind:/symbol:/references: inner operands now compile
      const ok = search.compileStructural('inside: import >> kind:call');
      assert.equal(ok.mode, 'inside');
      const ok2 = search.compileStructural('has: $X << symbol: y');
      assert.equal(ok2.mode, 'has');
      const ok3 = search.compileStructural('inside: class Widget >> $M(');
      assert.equal(ok3.mode, 'inside');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: callers verify call sites past column 500', () => {
  it('a call at col ~600 survives verification on both backends', async () => {
    const root = await fixture({
      'long.ts': 'x'.repeat(598) + ' target()' + 'y'.repeat(100) + '\n',
      'def.ts': 'export function target() {}\n',
    });
    try {
      for (const scan of [undefined, 'mock']) {
        const res = await search.callersOf('target', { cwd: root, scan });
        const hit = res.matches.find((m) => slash(m.path).endsWith('long.ts'));
        assert.ok(hit, `call site past col 500 dropped (scan=${scan}): ${JSON.stringify(rows(res))}`);
        assert.equal(hit.col, 600, `col: ${hit.col}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: 64KB+ regex reports invalid regex, not raw V8 text', () => {
  it('huge pattern errors at preflight with the normalized message', async () => {
    const root = await fixture({ 'a.txt': 'hello\n' });
    const big = 'a'.repeat(70 * 1024);
    try {
      // regex path: preflight force-compile catches the lazy SyntaxError
      await assert.rejects(
        search.grepContents(big, { cwd: root, literal: false }),
        (e) => e.message.startsWith('invalid regex:') && e.message.length < 1000,
      );
      // literal+ignoreCase also routes through the regex worker
      await assert.rejects(
        search.grepContents(big, { cwd: root, scan: 'mock', literal: true, ignoreCase: true }),
        (e) => e.message.startsWith('invalid regex:') && e.message.length < 1000,
      );
      // sane patterns still work
      const ok = await search.grepContents('hello', { cwd: root });
      assert.equal(ok.total, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: core scope escape throws instead of widening', () => {
  it('.. and absolute scopes error on grep and find', async () => {
    const root = await fixture({ 'a.txt': 'hello\n' });
    try {
      for (const scope of ['../outside', 'a/../../x', 'C:/Windows', '/etc']) {
        await assert.rejects(
          search.grepContents('hello', { cwd: root, scope }),
          (e) => e.message === `path escapes the scan root: ${scope}`,
          `scope ${scope} did not throw`,
        );
        await assert.rejects(
          search.findPaths('', { cwd: root, scope }),
          /path escapes the scan root/,
          `findPaths scope ${scope} did not throw`,
        );
      }
      // in-tree scopes still work on both backends
      const ok = await search.grepContents('hello', { cwd: root, scope: './' });
      assert.equal(ok.total, 1);
      const ok2 = await search.grepContents('hello', { cwd: root, scan: 'mock', scope: 'a.txt' });
      assert.equal(ok2.total, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: omitted long line keeps its real column', () => {
  it('rg placeholder row reports the match col, not text.length+1', async () => {
    const root = await fixture({
      'long.txt': 'x'.repeat(599) + 'NEEDLE' + 'y'.repeat(100) + '\n',
    });
    try {
      const res = await search.grepContents('NEEDLE', { cwd: root });
      assert.equal(res.backend, 'rg');
      const hit = res.matches.find((m) => slash(m.path).endsWith('long.txt'));
      assert.ok(hit, 'omitted-line row missing');
      assert.equal(hit.col, 600, `col mangled to ${hit.col}`);
      assert.match(hit.text, /Omitted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: zero-width match at EOF without trailing newline', () => {
  it('walker omits the terminal zero-width position like rg', async () => {
    const root = await fixture({
      'noeol.txt': 'abc',      // no trailing newline
      'eol.txt': 'abc\n',      // trailing newline
    });
    try {
      const walker = await search.grepContents('z*', { cwd: root, scan: 'mock', literal: false });
      const noeol = walker.matches.filter((m) => slash(m.path).endsWith('noeol.txt'));
      const eol = walker.matches.filter((m) => slash(m.path) === 'eol.txt');
      assert.deepEqual(noeol.map((m) => m.col), [1, 2, 3], `no-EOL terminal zero-width leaked: ${JSON.stringify(noeol.map((m) => m.col))}`);
      assert.deepEqual(eol.map((m) => m.col), [1, 2, 3, 4], `EOL rows: ${JSON.stringify(eol.map((m) => m.col))}`);
      const rg = await search.grepContents('z*', { cwd: root, literal: false });
      assert.equal(rg.backend, 'rg');
      assert.deepEqual(
        rg.matches.filter((m) => slash(m.path).endsWith('noeol.txt')).map((m) => m.col),
        [1, 2, 3],
        'rg parity on the no-EOL file',
      );
      assert.deepEqual(
        rg.matches.filter((m) => slash(m.path) === 'eol.txt').map((m) => m.col),
        [1, 2, 3, 4],
        'rg parity on the EOL file',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round6: status() labels a present-but-broken rg', () => {
  it('nonzero-exit rg reports "present but failed", ENOENT stays "missing"', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'omp-find-r6rg-'));
    const prevPath = process.env.PATH ?? '';
    try {
      if (process.platform === 'win32') {
        // node.exe can't fake a failure (`node --version` exits 0); where.exe
        // exits 1 on `--version` — a real "present but failed" binary.
        const { copyFileSync } = await import('node:fs');
        copyFileSync('C:/Windows/System32/where.exe', join(bin, 'rg.exe'));
      } else {
        const { chmodSync } = await import('node:fs');
        const p = join(bin, 'rg');
        await writeFile(p, '#!/bin/sh\nexit 2\n');
        chmodSync(p, 0o755);
      }
      process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${prevPath}`;
      const s = search.status();
      assert.match(s, /present but failed/, `broken rg mislabeled: ${s}`);
      assert.ok(!s.includes('rg: missing'), `broken rg reported missing: ${s}`);
      // ENOENT still reports missing — PATH points at an empty dir only
      const empty = await mkdtemp(join(tmpdir(), 'omp-find-r6empty-'));
      try {
        process.env.PATH = empty;
        const s2 = search.status();
        assert.match(s2, /rg: missing/, `ENOENT mislabeled: ${s2}`);
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    } finally {
      process.env.PATH = prevPath;
      await rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
