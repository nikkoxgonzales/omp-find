import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search, findTools, frecency, extension;
before(async () => {
  search = await import(dist('search.js'));
  findTools = await import(dist('tools.js'));
  frecency = await import(dist('frecency.js'));
  extension = await import(dist('extension.js'));
});

function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  return {
    tools,
    commands,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, def) { commands.set(name, def); },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    async emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) await fn(...args);
    },
  };
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

const STORE_KEYS = ['LOCALAPPDATA', 'HOME', 'USERPROFILE'];
async function withStoreEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress7b-freq-'));
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

async function readStore() {
  try {
    return JSON.parse(await readFile(frecency.storePath(), 'utf8'));
  } catch {
    return { entries: {} };
  }
}

// recordOpen is fire-and-forget from the tools layer; poll the store until the
// queued write lands (or time out).
async function waitForEntry(key, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const saved = await readStore();
    if (saved.entries?.[key]) return saved.entries[key];
    if (Date.now() - t0 > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('stress-round7b: tool_result feeds frecency', () => {
  it('read/edit/write tool_result events record opens; errors and non-file tools do not', async () => {
    await withStoreEnv(async (dir) => {
      // recordOpen stats the resolved path: run from a scratch cwd holding the
      // recorded files (including the filtered ones, so filtering — not a
      // missing file — is what keeps them out of the store).
      const work = join(dir, 'work');
      await mkdir(join(work, 'src'), { recursive: true });
      for (const f of ['readme.ts', 'edited.ts', 'wrote.ts', 'failed.ts', 'bash.ts']) {
        await writeFile(join(work, 'src', f), 'x');
      }
      const prevCwd = process.cwd();
      process.chdir(work);
      try {
      const pi = fakePi();
      extension.default(pi);
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c1', toolName: 'read', input: { path: 'src/readme.ts' }, content: [], isError: false });
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c2', toolName: 'edit', input: { path: 'src/edited.ts' }, content: [], isError: false });
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c3', toolName: 'write', input: { path: 'src/wrote.ts' }, content: [], isError: false });
      // Ignored shapes: errored result, non-file tool, missing/non-string path.
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c4', toolName: 'read', input: { path: 'src/failed.ts' }, content: [], isError: true });
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c5', toolName: 'bash', input: { path: 'src/bash.ts' }, content: [], isError: false });
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c6', toolName: 'read', input: { path: 42 }, content: [], isError: false });
      await pi.emit('tool_result', { type: 'tool_result', toolCallId: 'c7', toolName: 'read', input: {}, content: [], isError: false });
      const saved = await readStore();
      for (const p of ['src/readme.ts', 'src/edited.ts', 'src/wrote.ts']) {
        assert.ok(saved.entries?.[p], `store gained ${p}: ${JSON.stringify(saved)}`);
      }
      for (const p of ['src/failed.ts', 'src/bash.ts']) {
        assert.equal(saved.entries?.[p], undefined, `store must not gain ${p}`);
      }
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});

describe('stress-round7b: cursor-only resume (primary param optional with cursor)', () => {
  // One stub search: every paged tool gets 40 rows so page 1 mints a cursor.
  function stubSearch() {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ path: 'a.txt', line: i + 1, col: 1, text: 'x' }));
    const syms = (n) => Array.from({ length: n }, (_, i) => ({ line: i + 1, col: 1, kind: 'function', name: `sym${i}` }));
    return {
      ...search,
      findScanned: async () => ({ paths: Array.from({ length: 40 }, (_, i) => `f${i}.ts`), scanned: 40, backend: 'walker' }),
      grepContents: async (_p, o = {}) => ({ matches: rows(40).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 30)), total: 40, backend: 'walker' }),
      outlineFile: async () => ({ symbols: syms(40), total: 40 }),
      callersOf: async () => ({ matches: rows(40), total: 40, backend: 'walker' }),
      structuralGrep: async () => ({ matches: rows(40), total: 40, backend: 'walker' }),
    };
  }

  it('all five cursor tools resume with {cursor} alone — schema optional, stored params drive', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: stubSearch(), frecency: stubFrecency }, { mode: 'additive' });
    const cases = [
      ['fffind', { pattern: 'f' }, /f30\.ts/],
      ['ffgrep', { pattern: 'x' }, /a\.txt:31:/],
      ['ffoutline', { path: 'a.ts' }, /sym30/],
      ['ffcallers', { symbol: 'x' }, /a\.txt:31:/],
      ['ffstructural', { pattern: 'x($A)' }, /a\.txt:31:/],
    ];
    for (const [name, params, page2row] of cases) {
      const tool = pi.tools.get(name);
      assert.ok(tool, `${name} registered`);
      assert.ok(!tool.parameters.required?.length, `${name} schema must not require its primary param (cursor-only resume)`);
      const page1 = textOf(await tool.execute('t', params));
      const c = cursorOf(page1);
      assert.ok(c, `${name} page 1 mints a cursor:\n${page1}`);
      const page2 = textOf(await tool.execute('t', { cursor: c }));
      assert.ok(!page2.includes('failed:'), `${name} cursor-only resume must not error:\n${page2}`);
      assert.match(page2, page2row, `${name} page 2 resumes at the stored offset:\n${page2}`);
    }
  });

  it('missing primary param without a cursor still errors', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: stubSearch(), frecency: stubFrecency }, { mode: 'additive' });
    assert.match(textOf(await pi.tools.get('ffgrep').execute('t', {})), /provide a pattern/);
    assert.match(textOf(await pi.tools.get('ffoutline').execute('t', {})), /provide a path/);
    assert.match(textOf(await pi.tools.get('ffcallers').execute('t', {})), /provide a symbol/);
    assert.match(textOf(await pi.tools.get('ffstructural').execute('t', {})), /provide exactly one of pattern, symbol, references/);
    assert.match(textOf(await pi.tools.get('ffcapsule').execute('t', {})), /provide a symbol/);
    assert.match(textOf(await pi.tools.get('fffind').execute('t', {})), /provide a pattern or path/);
  });
});

describe('stress-round7b: param validation', () => {
  function pi() {
    const p = fakePi();
    findTools.registerFindTools(p, { search, frecency: stubFrecency }, { mode: 'additive' });
    return p;
  }

  it('ffcallers depth outside {1,2,3} is a clean error, not a silent clamp', async () => {
    const p = pi();
    for (const depth of [0, 4, 5, 2.5, '2']) {
      const out = textOf(await p.tools.get('ffcallers').execute('t', { symbol: 'x', depth }));
      assert.match(out, /ffcallers failed: depth must be 1, 2, or 3/, `depth ${JSON.stringify(depth)}:\n${out}`);
    }
  });

  it('limit: 0 is rejected instead of falling through to the default page', async () => {
    const p = pi();
    for (const [name, params] of [
      ['fffind', { pattern: 'x' }],
      ['ffgrep', { pattern: 'x' }],
      ['ffoutline', { path: 'a.ts' }],
      ['ffcallers', { symbol: 'x' }],
      ['ffstructural', { pattern: 'x($A)' }],
      ['ffcapsule', { symbol: 'x' }],
    ]) {
      const out = textOf(await p.tools.get(name).execute('t', { ...params, limit: 0 }));
      assert.match(out, new RegExp(`${name} failed: limit must be >= 1`), `${name} limit:0:\n${out}`);
    }
  });

  it('non-string primary params error instead of coercing or passing silently', async () => {
    const p = pi();
    const cases = [
      ['fffind', { pattern: 123 }, /pattern: expected string/],
      ['fffind', { path: 123 }, /path: expected string/],
      ['ffgrep', { pattern: 123 }, /pattern: expected string/],
      ['ffoutline', { path: 123 }, /path: expected string/],
      ['ffcallers', { symbol: 123 }, /symbol: expected string/],
      ['ffstructural', { pattern: 123 }, /pattern: expected string/],
      ['ffstructural', { symbol: 123 }, /symbol: expected string/],
      ['ffstructural', { references: 123 }, /references: expected string/],
      ['ffcapsule', { symbol: 123 }, /symbol: expected string/],
      ['ffmap', { path: 123 }, /path: expected string/],
    ];
    for (const [name, params, re] of cases) {
      const out = textOf(await p.tools.get(name).execute('t', params));
      assert.match(out, re, `${name} ${JSON.stringify(params)}:\n${out}`);
    }
  });
});

describe('stress-round7b: our own tools record frecency', () => {
  it('ffoutline on a file records it as opened', async () => {
    await withStoreEnv(async () => {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'src/search.ts' }));
      assert.ok(!out.includes('failed:'), `ffoutline ran:\n${out}`);
      const entry = await waitForEntry('src/search.ts');
      assert.ok(entry, 'frecency store gained src/search.ts after ffoutline');
      // Drain the write queue before the temp store dir is removed.
      await frecency.recordOpen('__flush__.ts');
    });
  });

  it('ffcapsule records the resolved def file', async () => {
    await withStoreEnv(async (dir) => {
      // recordOpen stats the resolved path: the stub's defFile must exist.
      const work = join(dir, 'work');
      await mkdir(join(work, 'src'), { recursive: true });
      await writeFile(join(work, 'src', 'defs.ts'), 'x');
      const prevCwd = process.cwd();
      process.chdir(work);
      try {
      const stub = {
        ...search,
        capsuleOf: async () => ({
          symbol: 'x', found: true, defFile: 'src/defs.ts', defLine: 3, defKind: 'function',
          doc: [], callers: [], imports: [], filesInvolved: 1, backend: 'walker',
        }),
      };
      const pi = fakePi();
      findTools.registerFindTools(pi, { search: stub, frecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffcapsule').execute('t', { symbol: 'x' }));
      assert.ok(!out.includes('failed:'), `ffcapsule ran:\n${out}`);
      const entry = await waitForEntry('src/defs.ts');
      assert.ok(entry, 'frecency store gained src/defs.ts after ffcapsule');
      await frecency.recordOpen('__flush__.ts');
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});
