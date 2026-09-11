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

const textOf = (out) => out?.content?.[0]?.text ?? String(out);

function fakePi() {
  const tools = new Map();
  return {
    tools,
    registerTool(tool) { tools.set(tool.name, tool); },
  };
}

const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r10fx-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

describe('stress-round10: structural two-phase operands', () => {
  it('inside: import >> kind:call finds calls only in files with imports', async () => {
    const root = await fixture({
      'has.ts': 'import x from "./x";\nfoo();\n',
      'no.ts': 'foo();\n',
    });
    try {
      const res = await search.structuralGrep('inside: import >> kind:call', { cwd: root });
      const paths = res.matches.map((m) => m.path);
      assert.ok(paths.some((p) => p === 'has.ts'), `expected has.ts, got ${paths.join(', ')}`);
      assert.ok(!paths.includes('no.ts'), `no.ts should not match, got ${paths.join(', ')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('inside: inside: still errors as chained combinator', () => {
    assert.throws(() => search.compileStructural('inside: inside:'), /combinators cannot be chained/);
  });

  it('has: x << has:y still errors as chained combinator', () => {
    assert.throws(() => search.compileStructural('has: x << has:y'), /combinators cannot be chained/);
  });
});

describe('stress-round10: ffcallers constructor def filter', () => {
  it('does not list constructor() { foo(); } as a caller of constructor', async () => {
    const root = await fixture({
      'c.ts': 'class C {\n  constructor() { foo(); }\n}\n',
      'u.ts': 'x.constructor();\n',
    });
    try {
      const res = await search.callersOf('constructor', { cwd: root });
      assert.ok(!res.matches.some((m) => m.text.includes('constructor() {')), `ctor def leaked: ${JSON.stringify(res.matches.map((m) => m.text))}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round10: ffcapsule .md header fallback', () => {
  it('resolves mySymbol from a ## heading when no source def exists', async () => {
    const root = await fixture({
      'docs/thing.md': '# Overview\n\n## mySymbol\n\ncontent\n',
      'src/util.ts': '// mentions mySymbol\n',
    });
    try {
      const res = await search.capsuleOf('mySymbol', { cwd: root });
      assert.ok(res.found, `not found: ${JSON.stringify(res)}`);
      assert.ok(res.defFile && res.defFile.endsWith('.md'), `expected .md def, got ${res.defFile}`);
      assert.equal(res.defKind, 'heading');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round10: ffoutline depth clamp', () => {
  it('depth:4 errors with depth must be 0 or 1', async () => {
    const root = await fixture({ 'a.ts': 'function a() {}\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root, depth: 4 }));
      assert.match(out, /ffoutline failed: depth must be 0 or 1/, `got:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round10: ffmap limit', () => {
  it('limit:3 returns 3 files', async () => {
    const root = await fixture({
      'a.ts': 'function a() {}\n',
      'b.ts': 'function b() {}\n',
      'c.ts': 'function c() {}\n',
      'd.ts': 'function d() {}\n',
      'e.ts': 'function e() {}\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = await pi.tools.get('ffmap').execute('t', { cwd: root, limit: 3, maxChars: 10000 });
      assert.equal(out.details.totalMatched, 3, `details: ${JSON.stringify(out.details)}\n${textOf(out)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round10: ffgrep maxChars:0', () => {
  it('rejects maxChars:0 as maxChars must be >= 1', async () => {
    const root = await fixture({ 'a.ts': 'foo\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'foo', cwd: root, maxChars: 0 }));
      assert.match(out, /ffgrep failed: maxChars must be >= 1/, `got:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
