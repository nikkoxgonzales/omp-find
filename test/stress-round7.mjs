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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r7-'));
  for (const [rel, content] of Object.entries(struct)) {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const slash = (p) => p.replace(/\\/g, '/');
const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };
function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); } };
}

describe('stress-round7: outline lists single-line and trailing-comma methods', () => {
  it('m() {}, m() {},, constructor(public id){}, async run(): Promise<void> {} all list at depth:1', async () => {
    const root = await fixture({
      'a.ts': [
        'class A {',
        '  m() {}',
        '  n() {},',
        '  constructor(public id){}',
        '  async run(): Promise<void> {}',
        '  sig(): void;',
        '}',
        'const o = {',
        '  ping(): number { return 1 },',
        '};',
      ].join('\n'),
    });
    try {
      const syms = (await search.outlineFile('a.ts', { cwd: root, depth: 1 })).symbols;
      const names = syms.map((s) => s.name);
      for (const n of ['A', 'm', 'n', 'constructor', 'run', 'ping']) {
        assert.ok(names.includes(n), `missing ${n} in ${JSON.stringify(syms)}`);
      }
      assert.ok(syms.find((s) => s.name === 'm')?.kind === 'method', 'm is a method');
      // signature-only declarations (no body) still must not list
      assert.ok(!names.includes('sig'), `signature leaked: ${JSON.stringify(names)}`);
      // statements still must not list
      const root2 = await fixture({ 'b.ts': 'class B {\n  run() {\n    foo(x);\n    if (y) {\n    }\n  }\n}\n' });
      try {
        const names2 = (await search.outlineFile('b.ts', { cwd: root2, depth: 1 })).symbols.map((s) => s.name);
        assert.ok(!names2.includes('foo'), `call statement leaked: ${JSON.stringify(names2)}`);
        assert.ok(!names2.includes('if'), `control flow leaked: ${JSON.stringify(names2)}`);
      } finally {
        await rm(root2, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Java constructors list at depth:1 (modifier-less and access-modified)', async () => {
    const root = await fixture({
      'W.java': [
        'public class Widget {',
        '  private int id;',
        '  public Widget() {}',
        '  Widget(int id) {}',
        '  public void render() {}',
        '}',
      ].join('\n'),
    });
    try {
      const syms = (await search.outlineFile('W.java', { cwd: root, depth: 1 })).symbols;
      const names = syms.map((s) => s.name);
      assert.ok(names.includes('Widget'), `ctor missed: ${JSON.stringify(syms)}`);
      assert.equal(names.filter((n) => n === 'Widget').length, 3, `class + 2 ctors: ${JSON.stringify(syms)}`);
      assert.ok(names.includes('render'), `method missed: ${JSON.stringify(syms)}`);
      assert.ok(!names.includes('id'), `field leaked: ${JSON.stringify(names)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: kind:class matches modified declarations', () => {
  it('public class / final class / export default class all match', async () => {
    const root = await fixture({
      'a.ts': [
        'export default class Alpha {}',
        'final class Beta {}',
        'public class Gamma {}',
        'sealed class Delta {}',
        'class Plain {}',
        'const notAClass = 1;',
      ].join('\n'),
    });
    try {
      const res = await search.structuralGrep('kind:class', { cwd: root, scan: 'mock' });
      const lines = res.matches.map((m) => m.text.trim());
      for (const want of ['export default class Alpha {}', 'final class Beta {}', 'public class Gamma {}', 'sealed class Delta {}', 'class Plain {}']) {
        assert.ok(lines.includes(want), `missing "${want}" in ${JSON.stringify(lines)}`);
      }
      assert.ok(!lines.some((l) => l.includes('notAClass')), `non-class leaked: ${JSON.stringify(lines)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: capsule def prefers source files over docs', () => {
  it('capsuleOf(parseFindQuery) picks src/parse.ts, not the README example', async () => {
    const root = await fixture({
      'src/parse.ts': 'export function parseFindQuery(q) { return q; }\n',
      'README.md': [
        '# parseFindQuery',
        '',
        'parseFindQuery parses queries. parseFindQuery is fast.',
        '',
        '```ts',
        'function parseFindQuery(q) {}',
        '```',
        '',
        'See parseFindQuery for details.',
      ].join('\n'),
    });
    try {
      const cap = await search.capsuleOf('parseFindQuery', { cwd: root });
      assert.ok(cap.found, 'capsule reports not found');
      assert.equal(slash(cap.defFile ?? ''), 'src/parse.ts', `def file: ${cap.defFile}`);
      assert.equal(cap.defLine, 1, `def line: ${cap.defLine}`);
      assert.equal(cap.defKind, 'function', `def kind: ${cap.defKind}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('docs still win when no source def exists', async () => {
    const root = await fixture({
      'README.md': '# thing\n\n```\nfunction onlyInDocs() {}\n```\n',
      'src/user.ts': 'onlyInDocs();\n',
    });
    try {
      const cap = await search.capsuleOf('onlyInDocs', { cwd: root });
      assert.equal(slash(cap.defFile ?? ''), 'README.md', `doc fallback def: ${cap.defFile}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: callersOf def filter honors ignoreCase', () => {
  it("callersOf('PING', ignoreCase) drops 'function ping' but keeps 'ping();'", async () => {
    const root = await fixture({
      'a.ts': 'function ping() {}\nping();\n',
    });
    try {
      for (const scan of ['mock', undefined]) {
        const res = await search.callersOf('PING', { cwd: root, ignoreCase: true, scan });
        const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text.trim()}`);
        assert.ok(texts.some((t) => t.includes('a.ts:2') && t.includes('ping();')), `call site missing (${scan}): ${JSON.stringify(texts)}`);
        assert.ok(!texts.some((t) => t.includes('function ping')), `def line leaked (${scan}): ${JSON.stringify(texts)}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: keyword-less defs are not callers', () => {
  it('object-literal method and constructor lines are filtered', async () => {
    const root = await fixture({
      'lib.ts': 'const o = {\n  ping(): number { return 1 },\n};\nclass W {\n  constructor() {}\n}\n',
      'app.ts': 'ping();\n',
      'app.py': 'ping()\n',
    });
    try {
      const res = await search.callersOf('ping', { cwd: root, scan: 'mock' });
      const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text.trim()}`);
      assert.ok(texts.some((t) => t.includes('app.ts:1')), `call site missing: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('app.py:1')), `semicolon-less call missing: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('ping(): number')), `object-literal def leaked: ${JSON.stringify(texts)}`);
      const res2 = await search.callersOf('constructor', { cwd: root, scan: 'mock' });
      assert.ok(!res2.matches.some((m) => m.text.includes('constructor()')), `ctor def leaked: ${JSON.stringify(res2.matches.map((m) => m.text))}`);
      // bare call statements still count as callers (defRe2 tail needs `)` then `:`/`{`)
      const res3 = await search.callersOf('ping', { cwd: root });
      assert.ok(res3.matches.some((m) => slash(m.path) === 'app.ts'), 'rg backend keeps the call site');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: cwd file path reports not-a-directory', () => {
  it('cwd=<file> → "scan root is not a directory"; missing → "not found"', async () => {
    const root = await fixture({ 'a.ts': 'x\n' });
    try {
      const fileCwd = join(root, 'a.ts');
      await assert.rejects(search.findPaths('', { cwd: fileCwd, scan: 'mock' }), /scan root is not a directory/, 'walker file-cwd');
      await assert.rejects(search.findPaths('', { cwd: fileCwd }), /scan root is not a directory/, 'rg file-cwd');
      await assert.rejects(search.grepContents('x', { cwd: fileCwd, scan: 'mock' }), /scan root is not a directory/, 'grep file-cwd');
      const missing = join(root, 'nope');
      await assert.rejects(search.findPaths('', { cwd: missing, scan: 'mock' }), /scan root not found/, 'missing still not-found');
      // tool layer surfaces the distinction under the <tool> failed: contract
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('fffind').execute('t1', { pattern: 'a', cwd: fileCwd }));
      assert.match(out, /fffind failed: scan root is not a directory/, `tool output:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round7: kind:call excludes definition lines', () => {
  it('function/method/ctor def lines drop; call sites stay', async () => {
    const root = await fixture({
      'defs.ts': 'function alpha() {}\nclass B {\n  beta() {}\n  constructor() {}\n}\nconst gamma = () => {};\n',
      'uses.ts': 'alpha();\nobj.beta();\ngamma();\n',
    });
    try {
      const res = await search.structuralGrep('kind:call', { cwd: root, scan: 'mock' });
      const texts = res.matches.map((m) => `${slash(m.path)}:${m.line} ${m.text.trim()}`);
      assert.ok(texts.some((t) => t.includes('uses.ts:1')), `alpha() call missing: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('uses.ts:2')), `obj.beta() call missing: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('function alpha')), `function def leaked: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('beta() {}')), `method def leaked: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('constructor()')), `ctor def leaked: ${JSON.stringify(texts)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
