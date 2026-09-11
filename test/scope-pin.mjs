import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-pin-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };
const names = (rows) => rows.map((p) => String(p).replace(/\\/g, '/'));
const rgPresent = () => {
  try { return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};
const gitPresent = () => {
  try { return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};
async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}
/** Search double forcing the walker (scan:"mock") through the real core. */
const walkerOf = (core) => ({
  ...core,
  findScanned: (q, o = {}) => core.findScanned(q, { ...o, scan: 'mock' }),
  findPaths: (q, o = {}) => core.findPaths(q, { ...o, scan: 'mock' }),
  grepContents: (p, o = {}) => core.grepContents(p, { ...o, scan: 'mock' }),
});

const HID = { '.hid/deep/f.py': 'PIN_MARKER_1a2b def hid_func():\n    pass\n' };
const TREE = {
  ...HID,
  'vis.py': 'PIN_MARKER_1a2b visible here\n',
};

describe('scope pins: explicit hidden paths hit on both backends', () => {
  it('core rg: pinned dot-dir file hits, unpinned misses (defaults unchanged)', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture(TREE);
    try {
      const unpinned = await search.grepContents('PIN_MARKER_1a2b', { cwd: root });
      assert.equal(unpinned.backend, 'rg');
      assert.deepEqual(names(unpinned.matches.map((m) => m.path)), ['vis.py']);
      const pinned = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scope: '.hid/deep/f.py' });
      assert.equal(pinned.backend, 'rg');
      assert.equal(pinned.total, 1);
      assert.deepEqual(names(pinned.matches.map((m) => m.path)), ['.hid/deep/f.py']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('core walker (scan:mock): pinned dot-dir file hits, unpinned misses', async () => {
    const root = await fixture(TREE);
    try {
      const unpinned = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scan: 'mock' });
      assert.equal(unpinned.backend, 'walker');
      assert.deepEqual(names(unpinned.matches.map((m) => m.path)), ['vis.py']);
      const pinned = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scan: 'mock', scope: '.hid/deep/f.py' });
      assert.equal(pinned.backend, 'walker');
      assert.equal(pinned.total, 1);
      const dirPin = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scan: 'mock', scope: '.hid/' });
      assert.equal(dirPin.total, 1, 'dir pins seed traversal at the dot-dir');
      const missing = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scan: 'mock', scope: '.hid/nope.py' });
      assert.equal(missing.total, 0, 'missing pins stay honestly empty');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('core walker via PATH-shim ENOENT: pinned dot-dir file hits', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH (nothing to hide)');
    const root = await fixture(TREE);
    const emptyBin = await mkdtemp(join(tmpdir(), 'omp-find-pinbin-'));
    try {
      await withEnv({ PATH: emptyBin }, async () => {
        const pinned = await search.grepContents('PIN_MARKER_1a2b', { cwd: root, scope: '.hid/deep/f.py' });
        assert.equal(pinned.backend, 'walker', 'rg hidden from PATH falls back to the walker');
        assert.equal(pinned.total, 1);
      });
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('core rg: pinned gitignored file hits post-git-init, unpinned misses', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    if (!gitPresent()) return t.skip('git absent from PATH');
    const root = await fixture({ 'gen/out.txt': 'PIN_MARKER_9z8y generated\n', 'src/keep.py': 'PIN_MARKER_9z8y kept\n' });
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      await writeFile(join(root, '.gitignore'), 'gen/out.txt\n');
      const unpinned = await search.grepContents('PIN_MARKER_9z8y', { cwd: root });
      assert.deepEqual(names(unpinned.matches.map((m) => m.path)), ['src/keep.py']);
      const pinned = await search.grepContents('PIN_MARKER_9z8y', { cwd: root, scope: 'gen/out.txt' });
      assert.equal(pinned.total, 1);
      assert.deepEqual(names(pinned.matches.map((m) => m.path)), ['gen/out.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('core find: scoped listing reaches dot-dir files, unscoped does not', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture(TREE);
    try {
      assert.deepEqual(names(await search.findPaths('', { cwd: root, scan: 'mock' })), ['vis.py']);
      assert.deepEqual(names(await search.findPaths('', { cwd: root, scan: 'mock', scope: '.hid/' })), ['.hid/deep/f.py']);
      assert.deepEqual(names(await search.findPaths('', { cwd: root, scan: 'mock', scope: '.hid/deep/f.py' })), ['.hid/deep/f.py']);
      assert.deepEqual(names(await search.findPaths('', { cwd: root, scope: '.hid/' })), ['.hid/deep/f.py']);
      assert.deepEqual(names(await search.findPaths('', { cwd: root })), ['vis.py']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('scope pins: tool layer forwards pins, keeps other forms', () => {
  it('ffgrep transcript case: regex + pinned hidden path hits (rg and walker)', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture({ '.claude_temp/smoke_outlook_mcp.py': 'def smoke_one():\n    pass\n\ndef smoke_two():\n    pass\n' });
    try {
      for (const core of [search, walkerOf(search)]) {
        const pi = fakePi();
        findTools.registerFindTools(pi, { search: core, frecency: stubFrecency });
        const out = textOf(await pi.tools.get('ffgrep').execute('t1', {
          pattern: 'def smoke_one|def smoke_two', path: '.claude_temp/smoke_outlook_mcp.py', literal: false, cwd: root,
        }));
        assert.ok(out.includes('.claude_temp/smoke_outlook_mcp.py:1:'), `pinned regex misses on ${core === search ? 'rg' : 'walker'}:\n${out}`);
        assert.ok(out.includes('.claude_temp/smoke_outlook_mcp.py:4:'), `second def missed:\n${out}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep: bare-basename and glob forms keep post-filter behavior (no scope)', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency });
      const bare = textOf(await pi.tools.get('ffgrep').execute('t1', { pattern: 'PIN_MARKER_1a2b', path: 'vis.py', cwd: root }));
      assert.ok(bare.includes('vis.py'), `bare-basename filter loses its hit:\n${bare}`);
      assert.ok(!bare.includes('.hid/'), `bare-basename filter leaks:\n${bare}`);
      const glob = textOf(await pi.tools.get('ffgrep').execute('t1', { pattern: 'PIN_MARKER_1a2b', path: '*.py', cwd: root }));
      assert.ok(glob.includes('vis.py'), `glob filter loses its hit:\n${glob}`);
      assert.ok(!glob.includes('.hid/'), `glob reaches hidden files (scope leaked into multi-dir form):\n${glob}`);
      const bareHidden = textOf(await pi.tools.get('ffgrep').execute('t1', { pattern: 'PIN_MARKER_1a2b', path: 'f.py', cwd: root }));
      assert.ok(bareHidden.includes('0 matches'), `bare hidden basename should stay empty (no pin to forward):\n${bareHidden}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fffind: path form reaches dot-dir files, unpinned ranking unchanged', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency });
      const pinned = textOf(await pi.tools.get('fffind').execute('t1', { path: '.hid/', cwd: root }));
      assert.ok(pinned.includes('.hid/deep/f.py'), `scoped fffind misses the dot-dir file:\n${pinned}`);
      const plain = textOf(await pi.tools.get('fffind').execute('t1', { pattern: 'vis', cwd: root }));
      assert.ok(plain.includes('vis.py'), `unpinned fffind loses its hit:\n${plain}`);
      assert.ok(!plain.includes('.hid/'), `unpinned fffind leaks hidden files:\n${plain}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep cursor resume re-searches the pin (no stale on scoped totals)', async (t) => {
    if (!rgPresent()) return t.skip('rg absent from PATH');
    const root = await fixture({
      '.hid/deep/f.py': 'CURSOR_PIN_7q marker one\nCURSOR_PIN_7q marker two\n',
      'vis.py': 'CURSOR_PIN_7q a\nCURSOR_PIN_7q b\nCURSOR_PIN_7q c\nCURSOR_PIN_7q d\nCURSOR_PIN_7q e\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency });
      const tool = pi.tools.get('ffgrep');
      const page1 = textOf(await tool.execute('t1', { pattern: 'CURSOR_PIN_7q', path: '.hid/deep/f.py', cwd: root, limit: 1 }));
      const cursor = cursorOf({ content: [{ type: 'text', text: page1 }] });
      assert.ok(cursor, `scoped page 1 has no cursor footer:\n${page1}`);
      assert.ok(page1.includes('.hid/deep/f.py:1:'), `page 1 misses the pinned first hit:\n${page1}`);
      const page2 = textOf(await tool.execute('t2', { cursor }));
      assert.ok(page2.includes('.hid/deep/f.py:2:'), `resume lost the pin (stale or wrong page):\n${page2}`);
      assert.ok(!/results changed since page 1/.test(page2), `scoped resume went stale:\n${page2}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
