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
  return {
    tools,
    registerTool(nameOrDef, maybeDef) {
      if (typeof nameOrDef === 'object' && nameOrDef !== null) tools.set(nameOrDef.name, nameOrDef);
      else tools.set(nameOrDef, maybeDef);
    },
  };
}

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-sym-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];
const slash = (s) => String(s).replace(/\\/g, '/');
const kinds = (res) => res.symbols.map((s) => `${s.kind} ${s.name}`);

const TS = `export class Foo {
  bar() {
    return 1;
  }
}
export function topFn() {}
export interface Iface {}
export enum Colors {}
export type Alias = string;
export const arrow = (x) => x;
// class Ghost {}
`;
const PY = `class Thing:
    def method(self):
        pass
def top():
    pass
# def notreal():
`;
const GO = `package main
type Server struct{}
func (s Server) Start() {}
func main() {}
`;
const RS = `pub struct Point {}
pub enum Dir {}
impl Point {
    pub fn x() {}
}
pub fn helper() {}
`;
const JAVA = `public class App {
  public static void main(String[] args)
  {
  }
  private int helper(int x)
  {
    return x;
  }
}
public interface Api {}
`;
const CPP = `class Widget {};
struct Point {};
int add(int a, int b)
{
  return a + b;
}
`;

describe('outlineFile per-language fixtures', () => {
  it('outlines TypeScript at depth 0, members at depth 1, skips comments', async () => {
    const root = await fixture({ 'a.ts': TS });
    try {
      const d0 = await search.outlineFile('a.ts', { cwd: root });
      assert.deepEqual(kinds(d0), ['class Foo', 'function topFn', 'interface Iface', 'enum Colors', 'type Alias', 'const arrow']);
      assert.equal(d0.total, 6);
      for (const s of d0.symbols) assert.ok(s.line >= 1 && s.col >= 1, 'every hit carries line:col');
      const d1 = await search.outlineFile('a.ts', { cwd: root, depth: 1 });
      assert.ok(kinds(d1).includes('method bar'), `depth1:\n${kinds(d1).join('\n')}`);
      assert.equal(d1.total, 7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('outlines Python/Go/Rust/Java/C++ coarsely', async () => {
    const root = await fixture({ 'a.py': PY, 'b.go': GO, 'c.rs': RS, 'D.java': JAVA, 'e.cpp': CPP });
    try {
      assert.deepEqual(kinds(await search.outlineFile('a.py', { cwd: root })), ['class Thing', 'def top']);
      assert.ok(kinds(await search.outlineFile('a.py', { cwd: root, depth: 1 })).includes('def method'));
      assert.deepEqual(kinds(await search.outlineFile('b.go', { cwd: root })), ['type Server', 'func Start', 'func main']);
      assert.deepEqual(kinds(await search.outlineFile('c.rs', { cwd: root })), ['struct Point', 'enum Dir', 'impl Point', 'fn helper']);
      assert.deepEqual(kinds(await search.outlineFile('D.java', { cwd: root })), ['class App', 'interface Api']);
      const jd1 = kinds(await search.outlineFile('D.java', { cwd: root, depth: 1 }));
      assert.ok(jd1.includes('method main') && jd1.includes('method helper'), jd1.join(','));
      assert.deepEqual(kinds(await search.outlineFile('e.cpp', { cwd: root })), ['class Widget', 'struct Point', 'function add']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to generic keywords, pages, and errors on missing files', async () => {
    const root = await fixture({ 'a.xyz': 'func alpha {}\nclass Beta {}\n', 'many.ts': 'export class A {}\nexport class B {}\nexport class C {}\n' });
    try {
      assert.deepEqual(kinds(await search.outlineFile('a.xyz', { cwd: root })), ['func alpha', 'class Beta']);
      const p1 = await search.outlineFile('many.ts', { cwd: root, limit: 2 });
      assert.equal(p1.symbols.length, 2);
      assert.equal(p1.total, 3);
      const p2 = await search.outlineFile('many.ts', { cwd: root, limit: 2, offset: 2 });
      assert.deepEqual(kinds(p2), ['class C']);
      await assert.rejects(search.outlineFile('nope.ts', { cwd: root }), /cannot read/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('yields nothing for binary or oversized files', async () => {
    const root = await fixture({ 'bin.ts': 'export class A {}\0binary\n' });
    try {
      assert.deepEqual((await search.outlineFile('bin.ts', { cwd: root })).symbols, []);
      await writeFile(join(root, 'big.ts'), 'x'.repeat(2 * 1024 * 1024 + 1));
      assert.deepEqual((await search.outlineFile('big.ts', { cwd: root })).symbols, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('callersOf approximate references', () => {
  const TREE = {
    'defs.ts': 'export function greet(name) { return name; }\n',
    'a.ts': 'import { x } from "./y";\ngreet("hi");\n',
    'b.ts': 'import { greet } from "./defs";\nconst y = 1;\n',
    'c.ts': 'obj.greet("yo");\nobj.greet("again");\n',
    'd.ts': 'function greet() {}\ngreet();\n',
  };
  it('merges call/import/member hits, dedupes by path:line, drops the definition', async () => {
    const root = await fixture(TREE);
    try {
      const res = await search.callersOf('greet', { cwd: root, scan: 'mock' });
      const rows = res.matches.map((m) => `${slash(m.path)}:${m.line}`);
      assert.ok(rows.includes('a.ts:2'), rows.join(','));
      assert.ok(rows.includes('b.ts:1'), rows.join(','));
      assert.ok(rows.includes('c.ts:1') && rows.includes('c.ts:2'), rows.join(','));
      assert.ok(rows.includes('d.ts:2'), rows.join(','));
      assert.ok(!rows.includes('defs.ts:1') && !rows.includes('d.ts:1'), `defs excluded:\n${rows.join('\n')}`);
      assert.equal(new Set(rows).size, rows.length, 'deduped by path:line');
      assert.deepEqual(rows, [...rows].sort(), 'sorted by path then line');
      assert.equal(res.total, rows.length);
      const page = await search.callersOf('greet', { cwd: root, scan: 'mock', limit: 2, offset: 1 });
      assert.equal(page.matches.length, 2);
      assert.equal(page.total, res.total);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('works over rg too and rejects an empty symbol', async () => {
    const root = await fixture(TREE);
    try {
      const res = await search.callersOf('greet', { cwd: root });
      assert.ok(res.matches.length >= 4, JSON.stringify(res.matches));
      await assert.rejects(search.callersOf('', { cwd: root }), /must not be empty/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('grepContents context slicing', () => {
  const LINES = ['l1', 'l2', 'l3', 'HIT', 'l5', 'l6', 'l7'].join('\n') + '\n';
  for (const scan of [undefined, 'mock']) {
    it(`attaches before/after windows (scan=${scan ?? 'rg'})`, async () => {
      const root = await fixture({ 'f.txt': LINES, 'top.txt': 'HIT\nl2\nl3\n' });
      try {
        const res = await search.grepContents('HIT', { cwd: root, scan, contextBefore: 2, contextAfter: 2 });
        const mid = res.matches.find((m) => slash(m.path) === 'f.txt');
        assert.deepEqual(mid.before, ['l2', 'l3']);
        assert.deepEqual(mid.after, ['l5', 'l6']);
        const top = res.matches.find((m) => slash(m.path) === 'top.txt');
        assert.deepEqual(top.before, [], 'clamped at file start');
        assert.deepEqual(top.after, ['l2', 'l3']);
        const plain = await search.grepContents('HIT', { cwd: root, scan });
        assert.equal(plain.matches[0].before, undefined, 'default 0 attaches nothing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  it('clamps context windows to 5', async () => {
    const root = await fixture({ 'f.txt': LINES });
    try {
      const res = await search.grepContents('HIT', { cwd: root, scan: 'mock', contextBefore: 99, contextAfter: 99 });
      assert.ok(res.matches[0].before.length <= 5 && res.matches[0].after.length <= 5);
      assert.equal(search.clampContext(undefined), 0);
      assert.equal(search.clampContext(-3), 0);
      assert.equal(search.clampContext(99), 5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('tools: ffoutline and ffcallers', () => {
  const stubFrecency = (preferred) => ({
    score: async (p) => (slash(p).endsWith(preferred) ? 10 : 0),
    recordOpen: async () => {},
  });

  it('registers outline/callers additively and outlines with row format + paging', async () => {
    const root = await fixture({ 'a.ts': TS });
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency('a.ts') }, { mode: 'additive' });
    assert.ok(pi.tools.has('ffoutline') && pi.tools.has('outline') && pi.tools.has('ffcallers'), [...pi.tools.keys()].join(','));
    const out = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root }));
    assert.ok(out.includes('a.ts:1:14: class Foo'), out);
    assert.ok(out.includes('function topFn'), out);
    const paged = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root, limit: 2 }));
    assert.ok(paged.includes('class Foo') && paged.includes('topFn') && !paged.includes('Iface'), paged);
    const c = cursorOf({ content: [{ type: 'text', text: paged }] });
    assert.ok(c, 'outline advertises a cursor');
    const page2 = textOf(await pi.tools.get('ffoutline').execute('t', { cursor: c }));
    assert.ok(page2.includes('Iface'), page2);
    const alias = textOf(await pi.tools.get('outline').execute('t', { path: 'a.ts', cwd: root }));
    assert.equal(alias, out, 'outline alias matches ffoutline');
    assert.match(textOf(await pi.tools.get('ffoutline').execute('t', { cwd: root })), /provide a path/);
    assert.match(textOf(await pi.tools.get('ffoutline').execute('t', { cursor: 'outline_c999' })), /unknown or expired cursor/);
    assert.match(textOf(await pi.tools.get('ffcallers').execute('t', {})), /provide a symbol/);
    await rm(root, { recursive: true, force: true });
  });

  it('ffcallers ranks by frecency, filters paths, and pages', async () => {
    const root = await fixture({
      'defs.ts': 'export function target() {}\n',
      'a.ts': 'target();\n',
      'sub/b.ts': 'target();\n',
    });
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency('sub/b.ts') }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', cwd: root }));
    const rows = out.split('\n').filter(Boolean);
    assert.ok(rows[0].startsWith('sub/b.ts:'), `frecency first:\n${out}`);
    assert.ok(rows.some((r) => r.startsWith('a.ts:1:1:')), out);
    const filtered = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', path: 'sub/', cwd: root }));
    assert.ok(filtered.includes('sub/b.ts') && !filtered.includes('a.ts'), filtered);
    const p1 = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', cwd: root, limit: 1 }));
    const c = cursorOf({ content: [{ type: 'text', text: p1 }] });
    assert.ok(c, 'callers advertises a cursor');
    const p2 = textOf(await pi.tools.get('ffcallers').execute('t', { cursor: c }));
    assert.ok(p2.includes('a.ts'), p2);
    assert.match(textOf(await pi.tools.get('ffcallers').execute('t', { cursor: 'callers_c999' })), /unknown or expired cursor/);
    await rm(root, { recursive: true, force: true });
  });

  it('registers nothing new when the core lacks outline/callers', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, {
      search: { findPaths: async () => [], grepContents: async () => ({ matches: [], total: 0 }) },
    }, { mode: 'additive' });
    assert.deepEqual([...pi.tools.keys()].sort(), ['fffind', 'ffgrep']);
  });

  it('maxChars falls back to tiered summaries per tool', async () => {
    const root = await fixture({
      'a.ts': TS,
      'sub/b.ts': 'export class B {}\nexport class C {}\n',
      'use.ts': 'import { B } from "./sub/b";\nB();\n',
      'g.txt': 'needle here\n',
      'sub/h.txt': 'needle there\n',
    });
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency('!') }, { mode: 'additive' });
    const find = textOf(await pi.tools.get('fffind').execute('t', { pattern: 'ts', cwd: root, maxChars: 10 }));
    assert.match(find, /Matched \d+ files.*Per-dir counts: .*sub: 1.*Refine path\/pattern or raise maxChars/s);
    const grep = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root, maxChars: 10 }));
    assert.match(grep, /Matched 2 hits in 2 files.*Per-file counts: .*Refine path\/pattern or raise maxChars/s);
    const outline = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root, maxChars: 10 }));
    assert.match(outline, /Matched 6 symbols.*Kind counts: .*class: 1.*Refine path or raise maxChars/s);
    const callers = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'B', cwd: root, maxChars: 10 }));
    assert.match(callers, /Matched \d+ approximate references to B.*Per-file counts: .*Refine path or raise maxChars/s);
    const roomy = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root, maxChars: 100000 }));
    assert.ok(roomy.includes('class Foo'), roomy);
    await rm(root, { recursive: true, force: true });
  });

  it('ffgrep threads context lines distinctly and carries them across cursors', async () => {
    const root = await fixture({ 'f.txt': 'l1\nl2\nHIT\nl4\nl5\nHIT2\nl7\n' });
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency('!') }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'HIT', cwd: root, contextBefore: 1, contextAfter: 1 }));
    assert.ok(out.includes('f.txt:3:1: HIT'), out);
    assert.ok(out.includes('  f.txt:2: l2'), `before marked:\n${out}`);
    assert.ok(out.includes('  f.txt:4: l4'), `after marked:\n${out}`);
    const many = await fixture({ 'm.txt': Array.from({ length: 8 }, (_, i) => `pre${i}\nHIT${i}\npost${i}`).join('\n') + '\n' });
    const pi2 = fakePi();
    findTools.registerFindTools(pi2, { search, frecency: stubFrecency('!') }, { mode: 'additive' });
    const p1 = textOf(await pi2.tools.get('ffgrep').execute('t', { pattern: 'HIT', cwd: many, limit: 2, contextAfter: 1 }));
    const c = cursorOf({ content: [{ type: 'text', text: p1 }] });
    assert.ok(c, 'grep advertises a cursor');
    const p2 = textOf(await pi2.tools.get('ffgrep').execute('t', { cursor: c }));
    assert.match(p2, / {2}\S+: post\d/, `cursor keeps context:\n${p2}`);
    const filtered = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'HIT', path: 'f.txt', cwd: root, contextBefore: 9 }));
    const capped = filtered.split('\n');
    const at = capped.findIndex((l) => l.startsWith('f.txt:6:1:'));
    assert.equal(capped.slice(at + 1, at + 6).filter((l) => l.startsWith('  ')).length, 5, `capped:\n${filtered}`);
    await rm(root, { recursive: true, force: true });
    await rm(many, { recursive: true, force: true });
  });
});
