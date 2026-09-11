import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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
  return {
    tools,
    registerTool(tool) { tools.set(tool.name, tool); },
  };
}

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-pkg-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const detailsOf = (out) => out?.details;
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

describe('packaging: details envelope per tool (pi-fff pick 2)', () => {
  it('fffind returns details with totals and no truncation on a full page', async () => {
    const root = await fixture({ 'a.ts': 'x\n', 'b.ts': 'y\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = await pi.tools.get('fffind').execute('t', { pattern: 'ts', cwd: root });
      assert.deepEqual(detailsOf(out), { totalMatched: 2, totalFiles: 2, truncated: false });
      assert.ok(!textOf(out).includes('matches limit reached'), 'no notice on a full page');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fffind pages carry truncated:true plus the limit notice next to the cursor', async () => {
    const root = await fixture({ 'a.ts': 'x\n', 'b.ts': 'y\n', 'c.ts': 'z\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const p1 = await pi.tools.get('fffind').execute('t', { pattern: 'ts', cwd: root, limit: 1 });
      assert.equal(detailsOf(p1).totalMatched, 3);
      assert.equal(detailsOf(p1).truncated, true);
      assert.match(textOf(p1), /1 matches limit reached \(max 50\) — more via cursor/, 'pi-fff notice beside the cursor footer');
      const c = cursorOf(p1);
      assert.ok(c, 'cursor still advertised');
      const p2 = await pi.tools.get('fffind').execute('t', { cursor: c });
      assert.equal(detailsOf(p2).totalMatched, 3, 'totals hold across the resume');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep returns per-file details and the notice on page 1', async () => {
    const root = await fixture({ 'a.txt': 'needle one\n', 'b.txt': 'needle two\nneedle three\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const full = await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root });
      assert.deepEqual(detailsOf(full), { totalMatched: 3, totalFiles: 2, truncated: false });
      const p1 = await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root, limit: 1 });
      assert.equal(detailsOf(p1).truncated, true);
      assert.match(textOf(p1), /1 matches limit reached \(max 50\) — more via cursor/);
      const empty = await pi.tools.get('ffgrep').execute('t', { pattern: 'zz-no-hit', cwd: root });
      assert.deepEqual(detailsOf(empty), { totalMatched: 0, totalFiles: 0, truncated: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffoutline details count symbols in one file; ffcallers counts references across files', async () => {
    const root = await fixture({
      'a.ts': 'export class Foo {}\nexport function topFn() {}\n',
      'use.ts': 'import { topFn } from "./a";\ntopFn();\n',
    });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const ol = await pi.tools.get('ffoutline').execute('t', { path: 'a.ts', cwd: root });
      assert.equal(detailsOf(ol).totalMatched, 2);
      assert.equal(detailsOf(ol).totalFiles, 1);
      assert.equal(detailsOf(ol).truncated, false);
      const co = await pi.tools.get('ffcallers').execute('t', { symbol: 'topFn', cwd: root });
      assert.ok(detailsOf(co).totalMatched >= 2, `callers counted: ${JSON.stringify(detailsOf(co))}`);
      assert.ok(detailsOf(co).totalFiles >= 1);
      const paged = await pi.tools.get('ffcallers').execute('t', { symbol: 'topFn', cwd: root, limit: 1 });
      if (cursorOf(paged)) assert.match(textOf(paged), /1 matches limit reached \(max 50\) — more via cursor/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('over-budget fallbacks keep text shape and report truncated:true', async () => {
    const root = await fixture({ 'a.ts': 'needle here\n', 'sub/b.ts': 'needle there\n' });
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const grep = await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', cwd: root, maxChars: 10 });
      assert.match(textOf(grep), /Matched 2 hits in 2 files/);
      assert.deepEqual(detailsOf(grep), { totalMatched: 2, totalFiles: 2, truncated: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('every registered def carries a one-line promptSnippet; guidelines untouched', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'override', cwd: tmpdir() });
    for (const [key, def] of pi.tools) {
      assert.equal(typeof def.promptSnippet, 'string', `${key}: promptSnippet is a string`);
      assert.ok(def.promptSnippet.length > 0 && !def.promptSnippet.includes('\n'), `${key}: one-line snippet`);
      assert.ok(Array.isArray(def.promptGuidelines) && def.promptGuidelines.length >= 2, `${key}: guidelines stay`);
    }
  });
});

describe('packaging: README agent-sees mirror', () => {
  it('README shows each promptSnippet, the details envelope, and the notice', async () => {
    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
    for (const name of ['fffind', 'ffgrep', 'ffoutline', 'ffcallers']) {
      const snippet = pi.tools.get(name).promptSnippet;
      assert.ok(readme.includes(snippet), `README mirrors ${name} promptSnippet`);
    }
    assert.ok(readme.includes('details'), 'README documents the details envelope');
    assert.ok(readme.includes('matches limit reached (max 50) — more via cursor'), 'README shows the limit notice');
  });
});
