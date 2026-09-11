import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-stress-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

/** Search double forcing the walker (scan:"mock") through the real core. */
const walkerOf = (core) => ({
  ...core,
  findScanned: (q, o = {}) => core.findScanned(q, { ...o, scan: 'mock' }),
  findPaths: (q, o = {}) => core.findPaths(q, { ...o, scan: 'mock' }),
  grepContents: (p, o = {}) => core.grepContents(p, { ...o, scan: 'mock' }),
});

async function withStoreEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-stress-freq-'));
  const keys = ['LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = dir;
  try {
    return await fn(dir);
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('stress-tools: backslash path filters', () => {
  it('backslash dir filter matches like the slash form', async () => {
    const root = await fixture({
      'sub/inner/a.ts': 'BACKSLASH_MARKER_XYZ def a():\n    pass\n',
      'sub/other.ts': 'unrelated content here\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const tool = pi.tools.get('ffgrep');
      const slash = textOf(await tool.execute('t1', { pattern: 'BACKSLASH_MARKER_XYZ', path: 'sub/inner/', cwd: root }));
      const back = textOf(await tool.execute('t2', { pattern: 'BACKSLASH_MARKER_XYZ', path: 'sub\\inner\\', cwd: root }));
      assert.match(slash, /a\.ts/, `slash form hits:\n${slash}`);
      assert.match(back, /a\.ts/, `backslash form hits:\n${back}`);
      assert.ok(!back.includes('other.ts'), `backslash form stays scoped:\n${back}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-tools: over-budget counts are full-set', () => {
  it('multi-page hits report the full file count, not the page count', async () => {
    const struct = {};
    for (let i = 0; i < 35; i++) struct[`f${String(i).padStart(2, '0')}.ts`] = `// OVERBUDGET_MARKER_QQ file ${i}\n`;
    const root = await fixture(struct);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search: walkerOf(search), frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'OVERBUDGET_MARKER_QQ', cwd: root, maxChars: 40 }));
      assert.match(out, /Matched 35 hits in 35 files/, `full-set file count:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('single-file over-budget uses singular "file"', async () => {
    const root = await fixture({
      'one.ts': 'SINGULAR_MARKER one\nSINGULAR_MARKER two\nSINGULAR_MARKER three\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search: walkerOf(search), frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'SINGULAR_MARKER', cwd: root, maxChars: 10 }));
      assert.match(out, /Matched 3 hits in 1 file \(/, `singular grammar:\n${out}`);
      assert.doesNotMatch(out, /1 files/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-tools: frecency parallel writes', () => {
  it('10 parallel recordOpen calls keep all 10 bumps', async () => {
    await withStoreEnv(async (dir) => {
      // recordOpen stats the resolved path: run from a scratch cwd holding the
      // recorded files so the relative keys land in the store.
      const work = join(dir, 'work');
      const keys = Array.from({ length: 10 }, (_, i) => `stress/key-${i}.ts`);
      for (const k of keys) {
        await mkdir(join(work, dirname(k)), { recursive: true });
        await writeFile(join(work, k), 'x');
      }
      const prevCwd = process.cwd();
      process.chdir(work);
      try {
      await frecency.clear();
      await Promise.all(keys.map((k) => frecency.recordOpen(k)));
      for (const k of keys) {
        assert.ok((await frecency.score(k)) > 0, `${k} kept its bump`);
      }
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});

describe('stress-tools: outline miss sanitized', () => {
  it('missing file reports display form without syscall text', async () => {
    const root = await fixture({ 'a.ts': 'export const x = 1;\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffoutline').execute('t', { path: 'nope-missing.ts', cwd: root }));
      assert.match(out, /outline: cannot read nope-missing\.ts/, `display form:\n${out}`);
      assert.doesNotMatch(out, /ENOENT|no such file/i, `no syscall text:\n${out}`);
      assert.ok(!out.includes(root) && !out.includes(root.replace(/\\/g, '/')), `no absolute path:\n${out}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
