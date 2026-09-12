import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
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

describe('grepContents bounds (needs core)', () => {
  it('skips oversized files in the fallback scan but still matches small ones', async (t) => {
    if (!search?.grepContents) return t.skip('core search.ts not landed yet');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-grep-'));
    try {
      await writeFile(join(root, 'small.txt'), 'the needle is here\n');
      const big = Buffer.alloc(2 * 1024 * 1024 + 64, 'x');
      big.write('needle-BIGMARKER-UNIQUE-7f3a', 0);
      await writeFile(join(root, 'big.txt'), big);
      const skipped = await search.grepContents('needle-BIGMARKER-UNIQUE-7f3a', { cwd: root, scan: 'mock' });
      assert.equal(skipped.total, 0, 'oversized file is never matched');
      assert.deepEqual(skipped.matches, []);
      const hit = await search.grepContents('needle', { cwd: root, scan: 'mock' });
      assert.ok(hit.total > 0, 'small file still matched');
      assert.ok(hit.matches.every((m) => !String(m.path).endsWith('big.txt')), 'no hits leak from big.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces a slow scan as a timed-out rejection via timeoutMs', async (t) => {
    if (!search?.grepContents) return t.skip('core search.ts not landed yet');
    // Slow-scan stub: must block past a 50ms budget and die when killed, so the
    // orphaned loser of the timeout race never holds the test process open.
    if (process.platform === 'win32') {
      // cmd.exe ignores rg-style args and sits interactive on piped stdin (blocks).
      const root = await mkdtemp(join(tmpdir(), 'omp-find-timeout-'));
      const bin = join(root, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(root, 'a.txt'), 'nothing to see here\n');
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      await copyFile(join(systemRoot, 'System32', 'cmd.exe'), join(bin, 'rg.exe'));
      const oldPath = process.env.PATH;
      process.env.PATH = bin + delimiter + oldPath;
      try {
        await assert.rejects(
          search.grepContents('nothing', { cwd: root, timeoutMs: 50 }),
          /timed out/,
          'slow scan rejects with a timed-out error (tool layer renders it as text)',
        );
      } finally {
        process.env.PATH = oldPath;
        // The killed stub rg.exe can still hold its own image file for a beat on
        // Windows; force:true does not cover EBUSY, so let fs.rm retry the lock out.
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    } else {
      // POSIX: a fifo with no writer blocks the fallback reader; we open the
      // writer only after the race rejects, so the orphaned scan drains cleanly.
      const { execFileSync } = await import('node:child_process');
      const root = await mkdtemp(join(tmpdir(), 'omp-find-timeout-'));
      try {
        await writeFile(join(root, 'a.txt'), 'nothing to see here\n');
        const fifo = join(root, 'stall');
        try { execFileSync('mkfifo', [fifo]); } catch { return t.skip('mkfifo unavailable'); }
        const pending = search.grepContents('nothing', { cwd: root, timeoutMs: 1500 });
        await assert.rejects(() => pending, /timed out/, 'slow scan rejects as timed out');
        await writeFile(fifo, 'drain the orphaned reader\n');
        await pending.catch(() => {});
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  it('real rg resolves well under timeout (never blocks on stdin)', async (t) => {
    if (!search?.grepContents) return t.skip('core search.ts not landed yet');
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('rg', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('rg absent from PATH');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-rgstdin-'));
    try {
      await writeFile(join(root, 'a.txt'), 'hello function world\r\nsecond line\r\nfunction two here\r\nand function three\r\n');
      const timeoutMs = 8000;
      const start = Date.now();
      const res = await search.grepContents('function', { cwd: root, timeoutMs });
      const elapsed = Date.now() - start;
      assert.equal(res.total, 3, 'every line match returns (CRLF split drops all but the last pre-fix on Windows)');
      assert.ok(elapsed < timeoutMs, `resolved in ${elapsed}ms, well under ${timeoutMs}ms (pre-fix it ate the whole timeout)`);
      for (const m of res.matches) {
        assert.ok(!m.path.startsWith('./') && !m.path.startsWith('.\\'), `no ./ prefix leaks (got ${m.path})`);
      }
      for (const p of await search.findPaths('', { cwd: root })) {
        assert.ok(!p.startsWith('./') && !p.startsWith('.\\'), `no ./ prefix in find results (got ${p})`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep with a dir filter finds hits (no ./ prefix breaks the tools filter)', async (t) => {
    if (!search?.grepContents || !findTools?.registerFindTools) return t.skip('core not landed yet');
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('rg', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('rg absent from PATH');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-dotslash-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'other'), { recursive: true });
      await writeFile(join(root, 'src', 'tools.ts'), 'export const DOTSLASH_MARKER_9q2 = 1;\n');
      await writeFile(join(root, 'other', 'misc.txt'), 'DOTSLASH_MARKER_9q2 lives here too\n');
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency });
      const tool = pi.tools.get('grep');
      assert.ok(tool, 'grep registered under the override default');
      const out = await tool.execute('t1', { pattern: 'DOTSLASH_MARKER_9q2', path: 'src/', cwd: root });
      const textOut = out?.content?.[0]?.text ?? String(out);
      assert.ok(textOut.includes('src/tools.ts'), `dir filter returns the src hit:\n${textOut}`);
      assert.ok(!textOut.includes('No matches found'), 'filter does not wipe the hits');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ffgrep with a dir filter finds hits beyond the first page (no bounded-fetch truncation)', async (t) => {
    if (!findTools?.registerFindTools) return t.skip('tools not landed yet');
    const other = Array.from({ length: 55 }, (_, i) => ({ path: `other/f${i}.txt`, line: 1, col: 1, text: 'TRUNC_MARKER_4x8 lives here' }));
    const srcHits = Array.from({ length: 5 }, (_, i) => ({ path: `src/t${i}.ts`, line: 1, col: 1, text: 'TRUNC_MARKER_4x8 lives here too' }));
    const stubSearch = {
      findPaths: async () => [],
      grepContents: async () => ({ matches: [...other, ...srcHits], total: 60 }),
      globToRegExp: search?.globToRegExp,
    };
    const pi = fakePi();
    findTools.registerFindTools(pi, { search: stubSearch, frecency });
    const tool = pi.tools.get('grep');
    assert.ok(tool, 'grep registered under the override default');
    const out = await tool.execute('t1', { pattern: 'TRUNC_MARKER_4x8', path: 'src/' });
    const textOut = out?.content?.[0]?.text ?? String(out);
    assert.ok(textOut.includes('src/t0.ts'), `dir filter finds hits past the first page:\n${textOut}`);
    assert.ok(!textOut.includes('No matches found'), 'filter does not wipe late hits');
  });
});

describe('frecency record/score round-trip (needs core)', () => {
  it('a recorded open scores above an unopened path', async (t) => {
    if (!frecency?.recordOpen || !frecency?.score) return t.skip('core frecency.ts not landed yet');
    // recordOpen stats the path, so the recorded file must exist on disk.
    const root = await mkdtemp(join(tmpdir(), 'omp-find-freq-'));
    try {
      const a = join(root, 'a.ts');
      const b = join(root, 'b.ts');
      await writeFile(a, 'x');
      const beforeScore = await frecency.score(b);
      await frecency.recordOpen(a);
      const afterA = await frecency.score(a);
      assert.ok(afterA > beforeScore, `opened path outranks unopened (${afterA} > ${beforeScore})`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('extension + tools wiring (needs core)', () => {
  it('default extension registers commands and tools on a fake pi', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    if (!findTools?.registerFindTools) return t.skip('core tools.ts not landed yet');
    const oldEnv = process.env.OMP_FIND_MODE;
    delete process.env.OMP_FIND_MODE;
    const pi = fakePi();
    extension.default(pi);
    await new Promise((r) => setTimeout(r, 50));
    if (oldEnv === undefined) delete process.env.OMP_FIND_MODE;
    else process.env.OMP_FIND_MODE = oldEnv;
    assert.ok(pi.commands.has('find-health'), 'commands wired via extension');
    assert.deepEqual([...pi.tools.keys()].sort(), ['capsule', 'ffcallers', 'ffcapsule', 'fffind', 'ffgrep', 'ffmap', 'ffoutline', 'ffstructural', 'find', 'grep', 'map', 'outline', 'structural'], `override default wires all thirteen: ${[...pi.tools.keys()]}`);
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
    pi.emit('session_start', {}, {});
  });
  it('injects a find-tools note into the last user message on the context event', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    const pi = fakePi();
    extension.default(pi);
    const messages = [{ role: 'user', content: 'hello' }];
    const [result] = pi.emit('context', { messages }, {});
    assert.ok(result, 'context handler returned a result');
    assert.ok(Array.isArray(result.messages), 'result has a messages array');
    assert.equal(result.messages.length, 1, 'note appended to existing user message');
    assert.match(result.messages[0].content, /<find-tools>/, 'find-tools note injected');
  });
  it('injects a find-tools note as a new user message when none exists', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    const pi = fakePi();
    extension.default(pi);
    const [result] = pi.emit('context', { messages: [] }, {});
    assert.ok(result, 'context handler returned a result');
    assert.equal(result.messages.length, 1, 'new user message appended');
    assert.equal(result.messages[0].role, 'user');
    assert.match(result.messages[0].content, /<find-tools>/, 'find-tools note injected');
  });
  it('no-arg resolve is override; explicit flag and env take precedence', async (t) => {
    if (!findTools?.resolveFindMode) return t.skip('core tools.ts not landed yet');
    const oldEnv = process.env.OMP_FIND_MODE;
    const root = await mkdtemp(join(tmpdir(), 'omp-find-mode-'));
    try {
      delete process.env.OMP_FIND_MODE;
      assert.equal(findTools.resolveFindMode(undefined, root), 'override', 'built-in default is override');
      assert.equal(findTools.resolveFindMode('additive', root), 'additive', 'explicit flag wins');
      process.env.OMP_FIND_MODE = 'additive';
      assert.equal(findTools.resolveFindMode(undefined, root), 'additive', 'env beats the default');
      process.env.OMP_FIND_MODE = 'override';
      assert.equal(findTools.resolveFindMode('additive', root), 'additive', 'explicit flag beats env');
    } finally {
      if (oldEnv === undefined) delete process.env.OMP_FIND_MODE;
      else process.env.OMP_FIND_MODE = oldEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('additive registers ff tools without host names', async (t) => {
    if (!findTools?.registerFindTools || !search?.findPaths) return t.skip('core not landed yet');
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency }, { mode: 'additive' });
    assert.deepEqual([...pi.tools.keys()].sort(), ['capsule', 'ffcallers', 'ffcapsule', 'fffind', 'ffgrep', 'ffmap', 'ffoutline', 'ffstructural', 'map', 'outline', 'structural'], 'additive leaves host names alone');
  });

  it('override aliases execute identically to canonical names', async (t) => {
    if (!findTools?.registerFindTools || !search?.findPaths || !search?.grepContents) return t.skip('core not landed yet');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-alias-'));
    try {
      await writeFile(join(root, 'alpha.txt'), 'shared marker one\n');
      await writeFile(join(root, 'beta.txt'), 'shared marker two\n');
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency }, { mode: 'override', cwd: root });
      const byName = (n) => pi.tools.get(n);
      assert.ok(byName('find') && byName('fffind') && byName('grep') && byName('ffgrep'), 'all four registered in override');
      const norm = (s) => s.split('\n').sort().join('\n');
      const findA = norm((await byName('find').execute('q1', { pattern: 'alpha', cwd: root })).content[0].text);
      const findB = norm((await byName('fffind').execute('q2', { pattern: 'alpha', cwd: root })).content[0].text);
      assert.equal(findA, findB, 'same find query returns the same page under both names');
      const grepA = norm((await byName('grep').execute('q3', { pattern: 'shared marker', cwd: root })).content[0].text);
      const grepB = norm((await byName('ffgrep').execute('q4', { pattern: 'shared marker', cwd: root })).content[0].text);
      assert.equal(grepA, grepB, 'same grep query returns the same page under both names');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extension never throws on a minimal host without .on', async (t) => {
    if (!extension?.default) return t.skip('dist/extension.js missing');
    const bare = { registerCommand() {}, registerTool() {} };
    assert.doesNotThrow(() => extension.default(bare));
  });
});

describe('compileStructural pattern subset (needs core)', () => {
  it('lowers $VAR to an identifier-or-string atom', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const c = search.compileStructural('console.log($MSG)', { language: 'ts' });
    assert.ok(c.regex.includes('console\\.log\\('), `literal code escaped: ${c.regex}`);
    assert.deepEqual(c.groups, ['MSG']);
    const re = new RegExp(c.regex);
    assert.ok(re.test('console.log("hi")'), 'string literal fills $VAR');
    assert.ok(re.test('console.log(foo)'), 'identifier fills $VAR');
    assert.ok(!re.test('console.log()'), 'empty parens do not fill $VAR');
    assert.equal(c.language, 'ts');
  });

  it('lowers $$VAR like $VAR (ast-grep unnamed capture, approximatively)', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const c = search.compileStructural('test($$X)');
    assert.deepEqual(c.groups, ['X']);
    assert.ok(new RegExp(c.regex).test('test(a)'), 'double-dollar fills one atom');
  });

  it('fills bare $$$ slots last (named $$$ARGS first)', async (t) => {
    if (!search?.compileStructural || !search?.previewRewrite) return t.skip('structural core not landed yet');
    const c = search.compileStructural('f($$$)');
    const blocks = search.previewRewrite(c, 'g($$$)', [{ path: 'a.ts', line: 1, col: 1, text: 'f(a, b)' }]);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].includes('+ g(a, b)'), `bare slot filled:\n${blocks[0]}`);
  });

  it('lowers $$$ to zero-or-more (named or bare)', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const re = new RegExp(search.compileStructural('console.log($$$)').regex);
    assert.ok(re.test('console.log()'), 'bare $$$ matches empty');
    assert.ok(re.test("console.log('debug: ', key, value)"), 'bare $$$ matches several args');
    const named = search.compileStructural('function $F($$$ARGS) { $$$ }');
    assert.deepEqual(named.groups, ['F', 'ARGS', '$$$'], 'bare $$$ keeps its capture slot');
    assert.ok(new RegExp(named.regex).test('function add(a, b) { return a + b }'), 'named multi matches args');
  });

  it('reuses a metavar name as a same-shape backreference', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const c = search.compileStructural('$A == $A');
    assert.ok(c.hasBackref, 'repeat flagged');
    assert.ok(c.regex.includes('\\1'), `repeat lowered to backref: ${c.regex}`);
    const re = new RegExp(c.regex);
    assert.ok(re.test('a == a'), 'same shape matches');
    assert.ok(!re.test('a == b'), 'different shapes do not match');
  });

  it('keeps non-metavar $ uses literal, escapes regex metachars', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const c = search.compileStructural('f(x) price $5');
    assert.ok(c.regex.includes('f\\(x\\)'), `parens escaped: ${c.regex}`);
    assert.ok(c.regex.includes('\\$5'), `dollar-digit stays literal: ${c.regex}`);
    assert.ok(new RegExp(c.regex).test('f(x) price $5'), 'literal round-trips');
    const home = search.compileStructural('echo $HOME');
    assert.deepEqual(home.groups, ['HOME'], '$HOME is a metavar (ast-grep-faithful), not text');
  });

  it('lowers kind: to line shapes, rejects unknown kinds and trailing filters', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const call = new RegExp(search.compileStructural('kind:call').regex);
    assert.ok(call.test('foo(1)'), 'bare call matches');
    assert.ok(call.test('a.b(x)'), 'member call matches');
    assert.throws(() => search.compileStructural('kind:nope'), /unknown structural kind/, 'unknown kind throws');
    assert.throws(() => search.compileStructural('kind:call logger'), /bare kind/, 'trailing filter rejected');
  });

  it('lowers symbol: to def lines and records references: for delegation', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const sym = search.compileStructural('symbol:thing');
    assert.equal(sym.mode, 'symbol');
    const re = new RegExp(sym.regex);
    assert.ok(re.test('function thing('), 'function def matches');
    assert.ok(re.test('export class thing'), 'class def matches');
    const ref = search.compileStructural('references:thing');
    assert.equal(ref.mode, 'references');
    assert.equal(ref.symbolName, 'thing');
    assert.equal(ref.regex, '');
    assert.throws(() => search.compileStructural('symbol:'), /needs a name/, 'empty symbol: throws');
    assert.throws(() => search.compileStructural('   '), /must not be empty/, 'empty pattern throws');
  });

  it('parses inside:/has: two-phase separators, rejects malformed ones', async (t) => {
    if (!search?.compileStructural) return t.skip('structural core not landed yet');
    const inside = search.compileStructural('inside: import >> $X');
    assert.equal(inside.mode, 'inside');
    assert.ok(inside.outer?.regex, 'outer compiled');
    assert.ok(inside.description.includes('file-scoped'), 'approximation disclosed in description');
    const has = search.compileStructural('has: $F << return');
    assert.equal(has.mode, 'has');
    assert.throws(() => search.compileStructural('inside: import $X'), /needs "OUTER >> INNER"/, 'missing separator throws');
    assert.throws(() => search.compileStructural('has:  << return'), /non-empty/, 'empty side throws');
  });

  it('normalizes language families, never throws on unknown input', async (t) => {
    if (!search?.normalizeLanguage) return t.skip('structural core not landed yet');
    assert.equal(search.normalizeLanguage('TypeScript'), 'ts');
    assert.equal(search.normalizeLanguage('py'), 'py');
    assert.equal(search.normalizeLanguage('brainfuck'), 'generic');
    assert.equal(search.normalizeLanguage(undefined), 'generic');
  });
});

describe('previewRewrite (needs core)', () => {
  it('fills $NAME slots and renders -/+ blocks, skipping non-matches', async (t) => {
    if (!search?.compileStructural || !search?.previewRewrite) return t.skip('structural core not landed yet');
    const c = search.compileStructural('console.log($MSG)');
    const blocks = search.previewRewrite(c, 'logger.info($MSG)', [
      { path: 'a.ts', line: 3, col: 1, text: 'console.log("hi")' },
      { path: 'a.ts', line: 9, col: 1, text: 'console.log()' },
    ]);
    assert.equal(blocks.length, 1, 'non-matching line skipped');
    assert.ok(blocks[0].startsWith('approx: a.ts:3:1:'), `approx header:\n${blocks[0]}`);
    assert.ok(blocks[0].includes('- console.log("hi")'), 'minus row');
    assert.ok(blocks[0].includes('+ logger.info("hi")'), 'slot filled');
  });

  it('substitutes longest names first and leaves unknown slots literal', async (t) => {
    if (!search?.compileStructural || !search?.previewRewrite) return t.skip('structural core not landed yet');
    const c = search.compileStructural('$AB + $A');
    const blocks = search.previewRewrite(c, '[$AB][$A][$MISSING]', [{ path: 'a.ts', line: 1, col: 1, text: 'foo + f' }]);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].includes('+ [foo][f][$MISSING]'), `no cross-name corruption, unknown slot literal:\n${blocks[0]}`);
  });

  it('returns no blocks for references: (nothing to lower)', async (t) => {
    if (!search?.compileStructural || !search?.previewRewrite) return t.skip('structural core not landed yet');
    const c = search.compileStructural('references:thing');
    assert.deepEqual(search.previewRewrite(c, 'x($thing)', [{ path: 'a.ts', line: 1, col: 1, text: 'thing()' }]), []);
  });
});

describe('structuralGrep end-to-end (mock scan, needs core)', () => {
  async function tree() {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-structural-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'other'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'import { thing } from "./b";\nconsole.log(thing);\nconst x = 1;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export function thing() {\n  return 1;\n}\nthing();\n');
    await writeFile(join(root, 'other', 'c.py'), 'def thing():\n    return 2\n');
    await writeFile(join(root, 'eq.txt'), 'x == x\nx == y\n');
    return root;
  }
  it('pattern mode finds call shapes over the live tree', async (t) => {
    if (!search?.structuralGrep) return t.skip('structural core not landed yet');
    const root = await tree();
    try {
      const res = await search.structuralGrep('console.log($MSG)', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 1, 'one call site');
      assert.ok(res.matches[0].path.endsWith('a.ts'), `hit is a.ts: ${res.matches[0].path}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('backreference patterns run (walker-forced) and filter shapes', async (t) => {
    if (!search?.structuralGrep) return t.skip('structural core not landed yet');
    const root = await tree();
    try {
      const res = await search.structuralGrep('$A == $A', { cwd: root, scan: 'mock' });
      const texts = res.matches.map((m) => m.text);
      assert.ok(texts.includes('x == x'), 'same shape kept');
      assert.ok(!texts.includes('x == y'), 'different shape dropped');
      // No scan option at all: must still resolve (rg would reject \1).
      const any = await search.structuralGrep('$A == $A', { cwd: root });
      assert.ok(any.matches.some((m) => m.text === 'x == x'), 'backref resolves on the default backend too');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('symbol: finds defs not calls; references: delegates to callersOf', async (t) => {
    if (!search?.structuralGrep) return t.skip('structural core not landed yet');
    const root = await tree();
    try {
      const defs = await search.structuralGrep('symbol:thing', { cwd: root, scan: 'mock' });
      assert.ok(defs.total >= 2, `b.ts + c.py defs: ${defs.total}`);
      assert.ok(defs.matches.every((m) => !m.text.trim().startsWith('thing();')), 'call site excluded');
      const refs = await search.structuralGrep('references:thing', { cwd: root, scan: 'mock' });
      assert.ok(refs.matches.some((m) => m.path.endsWith('a.ts')), 'import/member sites found');
      assert.ok(refs.matches.some((m) => m.text.includes('thing();')), 'call-paren site found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('inside:/has: scope matches file-by-file', async (t) => {
    if (!search?.structuralGrep) return t.skip('structural core not landed yet');
    const root = await tree();
    try {
      const inner = await search.structuralGrep('inside: import >> thing', { cwd: root, scan: 'mock' });
      assert.ok(inner.total > 0, 'inner matches exist');
      assert.ok(inner.matches.every((m) => m.path.endsWith('a.ts')), `scoped to the importing file: ${inner.matches.map((m) => m.path)}`);
      const outer = await search.structuralGrep('has: console.log($M) << thing', { cwd: root, scan: 'mock' });
      assert.ok(outer.matches.some((m) => m.path.endsWith('a.ts')), 'outer kept where the filter co-occurs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('honors limit/offset paging', async (t) => {
    if (!search?.structuralGrep) return t.skip('structural core not landed yet');
    const root = await tree();
    try {
      const full = await search.structuralGrep('thing', { cwd: root, scan: 'mock' });
      assert.ok(full.total >= 3, `several plain hits: ${full.total}`);
      const page = await search.structuralGrep('thing', { cwd: root, scan: 'mock', limit: 1, offset: 1 });
      assert.equal(page.matches.length, 1, 'one row per page');
      assert.equal(page.total, full.total, 'total holds over the full set');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffstructural tool (needs core)', () => {
  async function tree() {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-ffstructural-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'import { thing } from "./b";\nconsole.log(thing);\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export function thing() {\n  return 1;\n}\nthing();\n');
    return root;
  }
  const textOf = (out) => out?.content?.[0]?.text ?? String(out);
  it('rejects zero or several of pattern/symbol/references', async (t) => {
    if (!findTools?.registerFindTools) return t.skip('tools not landed yet');
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency });
    const tool = pi.tools.get('ffstructural');
    assert.ok(tool, 'ffstructural registered');
    for (const params of [{}, { pattern: 'a($X)', symbol: 'a' }, { pattern: 'a($X)', references: 'a' }]) {
      const out = textOf(await tool.execute('t1', params));
      assert.match(out, /exactly one of pattern, symbol, references/, `exactly-one enforced for ${JSON.stringify(params)}:\n${out}`);
    }
  });
  it('labels rows approx:, pages via structural_c cursors, honors path + context', async (t) => {
    if (!findTools?.registerFindTools || !search?.structuralGrep) return t.skip('core not landed yet');
    const root = await tree();
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency });
      const tool = pi.tools.get('ffstructural');
      const page1 = textOf(await tool.execute('t1', { references: 'thing', cwd: root, limit: 1 }));
      assert.ok(page1.includes('approx: '), `rows labeled approx::\n${page1}`);
      const cursor = /cursor "(structural_c[^"]+)"/.exec(page1)?.[1];
      assert.ok(cursor, `structural_c cursor footer:\n${page1}`);
      const page2 = textOf(await tool.execute('t2', { cursor }));
      assert.ok(page2.includes('approx: '), `page 2 keeps labels:\n${page2}`);
      const scoped = textOf(await tool.execute('t3', { pattern: 'console.log($MSG)', path: 'src/a.ts', contextBefore: 1, cwd: root }));
      assert.ok(scoped.includes('src/a.ts') || scoped.includes('a.ts'), `path filter kept a.ts:\n${scoped}`);
      assert.ok(/approx: +src\/a\.ts:1:/.test(scoped.replace(/\\/g, '/')), `context row attached:\n${scoped}`);
      const bad = textOf(await tool.execute('t4', { cursor: 'structural_c99999' }));
      assert.match(bad, /unknown or expired cursor "structural_c99999"/, 'bogus cursor is error text');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rewrite returns a -/+ preview and never writes', async (t) => {
    if (!findTools?.registerFindTools || !search?.structuralGrep) return t.skip('core not landed yet');
    const root = await tree();
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency });
      const tool = pi.tools.get('ffstructural');
      const out = textOf(await tool.execute('t1', { pattern: 'console.log($MSG)', rewrite: 'logger.info($MSG)', cwd: root }));
      assert.ok(out.includes('- console.log(thing)'), `minus row:\n${out}`);
      assert.ok(out.includes('+ logger.info(thing)'), `slot filled:\n${out}`);
      assert.ok(out.includes('preview only'), `preview notice:\n${out}`);
      const { readFile } = await import('node:fs/promises');
      const disk = await readFile(join(root, 'src', 'a.ts'), 'utf8');
      assert.ok(disk.includes('console.log(thing)'), 'file on disk untouched');
      const refRewrite = textOf(await tool.execute('t2', { references: 'thing', rewrite: 'x', cwd: root }));
      assert.match(refRewrite, /needs pattern: or symbol:, not references:/, 'references: + rewrite rejected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('degrades to per-file counts over maxChars and reports honest zero-states', async (t) => {
    if (!findTools?.registerFindTools || !search?.structuralGrep) return t.skip('core not landed yet');
    const root = await tree();
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency });
      const tool = pi.tools.get('ffstructural');
      const over = textOf(await tool.execute('t1', { pattern: 'thing', maxChars: 10, cwd: root }));
      assert.match(over, /Per-file counts:/, `counts not rows:\n${over}`);
      const none = textOf(await tool.execute('t2', { pattern: 'zzz-no-such-shape-qq', cwd: root }));
      assert.match(none, /0 structural matches/, `honest zero-state:\n${none}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('structural alias mirrors ffstructural', async (t) => {
    if (!findTools?.registerFindTools || !search?.structuralGrep) return t.skip('core not landed yet');
    const root = await tree();
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency });
      const a = textOf(await pi.tools.get('ffstructural').execute('q1', { pattern: 'console.log($MSG)', cwd: root }));
      const b = textOf(await pi.tools.get('structural').execute('q2', { pattern: 'console.log($MSG)', cwd: root }));
      assert.equal(a, b, 'alias returns the same page');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
