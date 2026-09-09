import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

/** Fake host: the tests must never import the real omp/pi host. */
function fakePi() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  return {
    commands,
    tools,
    registerCommand(name, def) { commands.set(name, def); },
    // Real host takes registerTool(tool) single-arg; accept the legacy
    // (name, def) two-arg form too so old callers fail loudly, not silently.
    registerTool(nameOrDef, maybeDef) {
      if (typeof nameOrDef === 'object' && nameOrDef !== null && typeof nameOrDef.name === 'string') {
        tools.set(nameOrDef.name, nameOrDef);
      } else {
        tools.set(nameOrDef, maybeDef);
      }
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, ...args) { return (handlers.get(event) ?? []).map((fn) => fn(...args)); },
  };
}

function notified(ctx) {
  const notes = [];
  ctx.ui = { notify: (text, kind) => { notes.push({ text, kind }); } };
  return notes;
}

/** Optional core modules: absent until the core worker lands. */
let search, frecency, findTools, extension;
before(async () => {
  try { search = await import(dist('search.js')); } catch { search = undefined; }
  try { frecency = await import(dist('frecency.js')); } catch { frecency = undefined; }
  try { findTools = await import(dist('tools.js')); } catch { findTools = undefined; }
  try { extension = await import(dist('extension.js')); } catch { extension = undefined; }
});

describe('find commands (scaffold-owned)', () => {
  it('registers /find-health and /find-rescan on a fake pi', async () => {
    const { registerFindCommands } = await import(dist('commands.js'));
    const pi = fakePi();
    registerFindCommands(pi, {});
    assert.ok(pi.commands.has('find-health'), 'find-health registered');
    assert.ok(pi.commands.has('find-rescan'), 'find-rescan registered');
  });

  it('/find-health notifies index/frecency status, /find-rescan drops caches', async () => {
    const { registerFindCommands } = await import(dist('commands.js'));
    const pi = fakePi();
    const deps = {
      search: { status: () => '3 dirs indexed', clearCache: async () => {} },
      frecency: { status: () => '12 opens', clear: async () => {} },
    };
    registerFindCommands(pi, deps);
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-health').handler('', ctx);
    assert.match(notes[0].text, /index:.*3 dirs indexed/);
    assert.match(notes[0].text, /frecency:.*12 opens/);
    await pi.commands.get('find-rescan').handler('', ctx);
    assert.match(notes[1].text, /caches dropped: index, frecency/);
  });

  it('/find-rescan survives hosts with no caches to drop', async () => {
    const { registerFindCommands } = await import(dist('commands.js'));
    const pi = fakePi();
    registerFindCommands(pi, {});
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-rescan').handler('', ctx);
    assert.match(notes[0].text, /nothing cached/);
  });
});

describe('parseFindQuery constraint subset (needs core)', () => {
  it('parses dir/, *.ext and !excl constraints', { skip: false }, async (t) => {
    if (!search?.parseFindQuery) return t.skip('core search.ts not landed yet');
    // dir/ prefix, extension filter, and negated exclusion.
    const q = search.parseFindQuery('src/ *.ts !*.test.ts foo');
    assert.ok(JSON.stringify(q).includes('src'), `dir constraint kept: ${JSON.stringify(q)}`);
    assert.ok(JSON.stringify(q).includes('ts'), `ext constraint kept: ${JSON.stringify(q)}`);
    assert.ok(JSON.stringify(q).toLowerCase().includes('test'), `exclusion kept: ${JSON.stringify(q)}`);
    assert.ok(JSON.stringify(q).includes('foo'), `free text kept: ${JSON.stringify(q)}`);
  });

  it('findPaths honors the subset over a temp fixture tree (mocked scan, no rg)', async (t) => {
    if (!search?.findPaths) return t.skip('core search.ts not landed yet');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(root, 'src', 'a.test.ts'), 'test\n');
      await writeFile(join(root, 'note.md'), '# hi\n');
      const hits = await search.findPaths('src/ *.ts !*.test.ts', { cwd: root, scan: 'mock' });
      const names = (Array.isArray(hits) ? hits : []).map((h) => String(h.path ?? h));
      assert.ok(names.some((n) => n.endsWith(join('src', 'a.ts'))), `a.ts found: ${names}`);
      assert.ok(!names.some((n) => n.endsWith('a.test.ts')), `exclusion honored: ${names}`);
      assert.ok(!names.some((n) => n.endsWith('note.md')), `ext filter honored: ${names}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('frecency record/score round-trip (needs core)', () => {
  it('a recorded open scores above an unopened path', async (t) => {
    if (!frecency?.recordOpen || !frecency?.score) return t.skip('core frecency.ts not landed yet');
    const beforeScore = await frecency.score('/proj/src/b.ts');
    await frecency.recordOpen('/proj/src/a.ts');
    const afterA = await frecency.score('/proj/src/a.ts');
    assert.ok(afterA > beforeScore, `opened path outranks unopened (${afterA} > ${beforeScore})`);
  });
});

describe('extension + tools wiring (needs core)', () => {
  it('default extension registers commands and tools on a fake pi', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    if (!findTools?.registerFindTools) return t.skip('core tools.ts not landed yet');
    const pi = fakePi();
    extension.default(pi);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(pi.commands.has('find-health'), 'commands wired via extension');
    assert.ok(pi.tools.has('fffind') || pi.tools.size > 0, `tools wired: ${[...pi.tools.keys()]}`);
    // Mirror of the real host's required tool fields (host.ts:63-73).
    for (const [key, def] of pi.tools) {
      assert.equal(typeof def.name, 'string', `${key}: name is a string`);
      assert.ok(def.name.length > 0, `${key}: non-empty name`);
      assert.equal(typeof def.label, 'string', `${key}: label is a string`);
      assert.ok(def.label.length > 0, `${key}: non-empty label`);
      assert.equal(typeof def.description, 'string', `${key}: description is a string`);
      assert.ok(def.description.length > 0, `${key}: non-empty description`);
      assert.ok(def.parameters !== undefined, `${key}: parameters present`);
      assert.equal(typeof def.execute, 'function', `${key}: execute is a function`);
    }
    pi.emit('session-start', {}, {});
  });

  it('extension never throws on a minimal host without .on', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    const bare = { registerCommand() {}, registerTool() {} };
    assert.doesNotThrow(() => extension.default(bare));
  });
});
