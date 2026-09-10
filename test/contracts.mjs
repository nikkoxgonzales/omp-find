import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-contracts-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}
const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };
const STALE = /results changed since page 1; re-run without cursor/;

function stubSearch(state) {
  const files = () => state.files.map((p) => ({ path: p, line: 1, col: 1, text: 'hit' }));
  // grepContents pages core-side (like the real core); find/callers/structural
  // return full sets because the tools layer slices those itself.
  const pageOf = (all, o = {}) => all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length));
  return {
    findPaths: async () => [...state.files],
    findScanned: async () => ({ paths: [...state.files], scanned: state.files.length, backend: 'walker' }),
    grepContents: async (_p, o = {}) => ({ matches: pageOf(files(), o), total: state.files.length, backend: state.backend ?? 'rg' }),
    globToRegExp: search?.globToRegExp,
    outlineFile: async () => ({ symbols: state.symbols, total: state.symbols.length }),
    callersOf: async () => ({ matches: files(), total: state.files.length, backend: 'rg' }),
    structuralGrep: async () => ({ matches: files(), total: state.files.length, backend: 'rg' }),
    compileStructural: () => { throw new Error('unused without rewrite'); },
    previewRewrite: () => [],
  };
}

function register(state) {
  const pi = fakePi();
  findTools.registerFindTools(pi, { search: stubSearch(state), frecency: stubFrecency }, { mode: 'additive' });
  return pi;
}

describe('contracts: stale cursors refuse silent re-offsets', () => {
  it('fffind resume after a new file lands returns restart guidance', async () => {
    const state = { files: ['a.ts', 'b.ts'] };
    const pi = register(state);
    const p1 = await pi.tools.get('fffind').execute('t', { pattern: 'ts', limit: 1 });
    const c = cursorOf(p1);
    assert.ok(c, 'page 1 advertises a cursor');
    state.files.push('c.ts');
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { cursor: c })), STALE);
  });

  it('ffgrep resume after a backend flip returns restart guidance; stable resume pages', async () => {
    const state = { files: ['a.txt', 'b.txt'], backend: 'rg' };
    const pi = register(state);
    const p1 = await pi.tools.get('ffgrep').execute('t', { pattern: 'hit', limit: 1 });
    const c = cursorOf(p1);
    assert.ok(c, 'page 1 advertises a cursor');
    const p2 = await pi.tools.get('ffgrep').execute('t', { cursor: c });
    assert.ok(!STALE.test(textOf(p2)), `stable tree pages cleanly:\n${textOf(p2)}`);
    state.backend = 'walker';
    assert.match(textOf(await pi.tools.get('ffgrep').execute('t', { cursor: c })), STALE);
  });

  it('ffoutline resume after a symbol is added returns restart guidance', async () => {
    const sym = (name, line) => ({ line, col: 1, kind: 'function', name });
    const state = { symbols: [sym('one', 1), sym('two', 5)] };
    const pi = register(state);
    const p1 = await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', limit: 1 });
    const c = cursorOf(p1);
    assert.ok(c, 'page 1 advertises a cursor');
    state.symbols.push(sym('three', 9));
    assert.match(textOf(await pi.tools.get('ffoutline').execute('t', { cursor: c })), STALE);
  });

  it('ffcallers and ffstructural resumes after result growth return restart guidance', async () => {
    const state = { files: ['a.ts', 'b.ts'] };
    const pi = register(state);
    const cc = cursorOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'hit', limit: 1 }));
    const sc = cursorOf(await pi.tools.get('ffstructural').execute('t', { pattern: 'hit($A)', limit: 1 }));
    assert.ok(cc && sc, 'both advertise cursors');
    state.files.push('c.ts');
    assert.match(textOf(await pi.tools.get('ffcallers').execute('t', { cursor: cc })), STALE);
    assert.match(textOf(await pi.tools.get('ffstructural').execute('t', { cursor: sc })), STALE);
  });
});

describe('contracts: every paged tool states returned-vs-total the same way', () => {
  it('all five footers carry the identical N-more + cursor shape', async () => {
    const state = { files: ['a.ts', 'b.ts'], symbols: [{ line: 1, col: 1, kind: 'function', name: 'one' }, { line: 5, col: 1, kind: 'function', name: 'two' }] };
    const pi = register(state);
    const calls = [
      ['fffind', { pattern: 'ts', limit: 1 }],
      ['ffgrep', { pattern: 'hit', limit: 1 }],
      ['ffoutline', { path: 'a.ts', limit: 1 }],
      ['ffcallers', { symbol: 'hit', limit: 1 }],
      ['ffstructural', { pattern: 'hit($A)', limit: 1 }],
    ];
    for (const [name, params] of calls) {
      const out = textOf(await pi.tools.get(name).execute('t', params));
      assert.match(out, /\(1 more; pass cursor "[a-z]+_c\d+" for the next page\)/, `${name}: returned-vs-total footer`);
    }
  });
});

describe('contracts: ffcallers certainty labels (gograph exact|possible)', () => {
  it('call-paren and import rows are exact; member mentions carry [possible]', async () => {
    const root = await fixture({
      'a.ts': 'target();\n',
      'b.ts': 'obj.target;\n',
      'c.ts': 'import { target } from "./a";\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', cwd: root }));
      const rows = out.split('\n').filter((l) => l.includes('.ts:'));
      assert.ok(rows.some((r) => r.startsWith('a.ts:1:1:')), `call-paren row untagged:\n${out}`);
      assert.ok(rows.some((r) => r.startsWith('c.ts:1:1:')), `import row untagged:\n${out}`);
      assert.ok(rows.some((r) => r.startsWith('[possible] b.ts:1:')), `member mention tagged:\n${out}`);
      assert.ok(!rows.some((r) => r.startsWith('[possible] a.ts')), 'exact rows never tagged');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exact_only drops possible mentions; all-possible sets get narrowing guidance', async () => {
    const root = await fixture({
      'a.ts': 'target();\n',
      'b.ts': 'obj.target;\n',
    });
    const lone = await fixture({ 'm.ts': 'obj.target;\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const exact = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', cwd: root, exact_only: true }));
      assert.ok(exact.includes('a.ts') && !exact.includes('b.ts'), `exact_only keeps call sites:\n${exact}`);
      const vague = textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'target', cwd: lone }));
      assert.match(vague, /note: no exact call\/import sites for "target"; 1 possible mention — confirm with read/, 'narrowing guidance, not a merged guess');
      assert.ok(vague.includes('[possible] m.ts:1:'), 'possible row still shown, labeled');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(lone, { recursive: true, force: true });
    }
  });
});
