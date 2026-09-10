import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, parse as parsePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search, frecency, findTools, commands, extension;
before(async () => {
  search = await import(dist('search.js'));
  frecency = await import(dist('frecency.js'));
  findTools = await import(dist('tools.js'));
  commands = await import(dist('commands.js'));
  extension = await import(dist('extension.js'));
});

function fakePiTwoArg() {
  const cmdMap = new Map();
  const toolMap = new Map();
  const handlers = new Map();
  return {
    commands: cmdMap,
    tools: toolMap,
    registerCommand(name, def) { cmdMap.set(name, def); },
    registerTool(nameOrDef, maybeDef) {
      if (typeof nameOrDef === 'object' && nameOrDef !== null) toolMap.set(nameOrDef.name, nameOrDef);
      else toolMap.set(nameOrDef, maybeDef);
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, ...args) { return (handlers.get(event) ?? []).map((fn) => fn(...args)); },
  };
}

/** Single-arg host: registerTool(tool) — the real host arity. */
function fakePiOneArg() {
  const toolMap = new Map();
  return {
    tools: toolMap,
    registerTool(tool) { toolMap.set(tool.name, tool); },
  };
}

function notified(ctx) {
  const notes = [];
  ctx.ui = { notify: (text, kind) => { notes.push({ text, kind }); } };
  return notes;
}

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

/** Build a fixture tree: { 'rel/path': 'content' }. Returns the root. */
async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-cov-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const names = (hits) => (Array.isArray(hits) ? hits : []).map((h) => String(h.path ?? h));
const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const cursorOf = (out) => /cursor "([^"]+)"/.exec(textOf(out))?.[1];

describe('parseFindQuery edges', () => {
  it('empty and whitespace-only queries parse to empty fuzzy', () => {
    assert.deepEqual(search.parseFindQuery(''), { fuzzy: '', extGlobs: [], excludes: [], gitModifiedOnly: false });
    assert.deepEqual(search.parseFindQuery('   '), { fuzzy: '', extGlobs: [], excludes: [], gitModifiedOnly: false });
  });

  it('git:modified matches case-insensitively', () => {
    assert.equal(search.parseFindQuery('GIT:MODIFIED').gitModifiedOnly, true);
    assert.equal(search.parseFindQuery('Git:Modified x').gitModifiedOnly, true);
    assert.equal(search.parseFindQuery('x').gitModifiedOnly, false);
  });

  it('a lone ! is fuzzy text, not an exclusion', () => {
    const q = search.parseFindQuery('!');
    assert.deepEqual(q.excludes, []);
    assert.equal(q.fuzzy, '!');
  });

  it('only the first dir/ token is the prefix; later ones stay fuzzy', () => {
    const q = search.parseFindQuery('src/ lib/ foo');
    assert.equal(q.dirPrefix, 'src');
    assert.equal(q.fuzzy, 'lib/ foo');
  });

  it('a ./ prefix on the dir is stripped', () => {
    assert.equal(search.parseFindQuery('./src/ foo').dirPrefix, 'src');
  });

  it('?, [, { tokens become globs; fuzzy tokens join with spaces', () => {
    const q = search.parseFindQuery('file? a[bc d{e main ts');
    assert.deepEqual(q.extGlobs, ['file?', 'a[bc', 'd{e']);
    assert.equal(q.fuzzy, 'main ts');
  });

  it('multiple exclusions accumulate', () => {
    const q = search.parseFindQuery('!a !*.js !dist/');
    assert.deepEqual(q.excludes, ['a', '*.js', 'dist/']);
  });
});

describe('globToRegExp edges', () => {
  it('** crosses separators with and without a trailing slash', () => {
    assert.ok(search.globToRegExp('**/a.ts').test('x/y/a.ts'));
    assert.ok(search.globToRegExp('**/a.ts').test('a.ts'));
    assert.ok(search.globToRegExp('src/**').test('src/a/b.ts'));
    assert.ok(!search.globToRegExp('src/**').test('other/a.ts'));
  });

  it('? matches exactly one non-separator char', () => {
    assert.ok(search.globToRegExp('?.ts').test('a.ts'));
    assert.ok(!search.globToRegExp('?.ts').test('ab.ts'));
    assert.ok(!search.globToRegExp('?.ts').test('a/b.ts'));
  });

  it('{a,b} alternation matches either side', () => {
    const re = search.globToRegExp('*.{ts,js}');
    assert.ok(re.test('a.ts'));
    assert.ok(re.test('b.js'));
    assert.ok(!re.test('c.md'));
  });

  it('unclosed { and [ stay literal', () => {
    assert.ok(search.globToRegExp('a{b').test('a{b'));
    assert.ok(!search.globToRegExp('a{b').test('axb'));
    assert.ok(search.globToRegExp('a[bc').test('a[bc'));
    assert.ok(!search.globToRegExp('a[bc').test('abc'));
  });

  it('closed [..] classes work', () => {
    const re = search.globToRegExp('file[12].txt');
    assert.ok(re.test('file1.txt'));
    assert.ok(!re.test('file3.txt'));
  });

  it('regex metachars in literals are escaped', () => {
    assert.ok(search.globToRegExp('a+b.ts').test('a+b.ts'));
    assert.ok(!search.globToRegExp('a+b.ts').test('aab.ts'));
    assert.ok(!search.globToRegExp('a.ts').test('axbts'));
  });
});

describe('findPaths guards and paging', () => {
  it('refuses the filesystem root and the home directory', async () => {
    const root = parsePath(process.cwd()).root;
    await assert.rejects(search.findPaths('', { cwd: root, scan: 'mock' }), /filesystem root/);
    await assert.rejects(search.findPaths('', { cwd: homedir(), scan: 'mock' }), /home directory/);
    await assert.rejects(search.grepContents('x', { cwd: root, scan: 'mock' }), /filesystem root/);
    await assert.rejects(search.grepContents('x', { cwd: homedir(), scan: 'mock' }), /home directory/);
  });

  it('empty query returns everything; impossible fuzzy returns nothing', async () => {
    const root = await fixture({ 'a.ts': 'x', 'sub/b.md': 'y' });
    try {
      const all = await search.findPaths('', { cwd: root, scan: 'mock' });
      assert.equal(all.length, 2);
      assert.deepEqual(await search.findPaths('zzz-no-such-file-9q', { cwd: root, scan: 'mock' }), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limit/offset page; bad limits fall back to the default; offset clamps at zero', async () => {
    const root = await fixture({ 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x', 'd.ts': 'x' });
    try {
      const full = names(await search.findPaths('', { cwd: root, scan: 'mock' }));
      assert.equal(full.length, 4);
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: 2 })).length, 2);
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: 2, offset: 1 })).length, 2);
      assert.deepEqual(names(await search.findPaths('', { cwd: root, scan: 'mock', offset: 99 })), []);
      // Zero/negative/NaN limits behave like the default page (everything here).
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: 0 })).length, 4);
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: -3 })).length, 4);
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: NaN })).length, 4);
      // Negative offsets clamp to zero.
      assert.equal(names(await search.findPaths('', { cwd: root, scan: 'mock', limit: 2, offset: -5 })).length, 2);
      // Huge limits clamp to PAGE_MAX (50).
      assert.equal(search.PAGE_MAX, 50);
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.ts`, 'x']));
      const big = await fixture(many);
      try {
        assert.equal(names(await search.findPaths('', { cwd: big, scan: 'mock', limit: 1000 })).length, 50);
      } finally {
        await rm(big, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exact/stem basename matches outrank the rest; matching is case-insensitive', async () => {
    // Tiers (upstream PR #728, open): exact basename -20, stem -10, fuzzy 0. A
    // dirname-prefix match (gap-free, score 0) now outranks a partial-basename
    // subsequence (gap penalty, no bonus); exact and stem basenames still win.
    const root = await fixture({ 'alpha/readme.md': 'x', 'myalpha.md': 'x', 'alpha.md': 'x' });
    try {
      const hits = names(await search.findPaths('alpha', { cwd: root, scan: 'mock' }));
      assert.deepEqual(hits.map((h) => h.replace(/\\/g, '/')), ['alpha.md', 'alpha/readme.md', 'myalpha.md']);
      const upper = names(await search.findPaths('ALPHA', { cwd: root, scan: 'mock' }));
      assert.equal(upper.length, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('glob constraints filter (?, {, [) end to end', async () => {
    const root = await fixture({ 'a.ts': 'x', 'ab.ts': 'x', 'a.md': 'x', 'b.js': 'x', 'file1.txt': 'x', 'file3.txt': 'x' });
    try {
      assert.deepEqual(names(await search.findPaths('?.ts', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')), ['a.ts']);
      const alt = names(await search.findPaths('*.{ts,js}', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.deepEqual(alt, ['a.ts', 'ab.ts', 'b.js']);
      const cls = names(await search.findPaths('file[12].txt', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.deepEqual(cls, ['file1.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('findPaths filters: excludes, skips, links', () => {
  it('supports dir/, exact, bare-name, and ./ exclusions', async () => {
    const root = await fixture({
      'src/a.ts': 'x',
      'src/skip.ts': 'x',
      'dist/bundle.js': 'x',
      'note.md': 'x',
    });
    try {
      const noDist = names(await search.findPaths('!dist/', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(!noDist.some((n) => n.startsWith('dist/')), `dist/ excluded: ${noDist}`);
      assert.ok(noDist.some((n) => n === 'src/a.ts'));
      const noDotDist = names(await search.findPaths('!./dist/', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(!noDotDist.some((n) => n.startsWith('dist/')));
      const noExact = names(await search.findPaths('!dist/bundle.js', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(!noExact.includes('dist/bundle.js'));
      assert.ok(noExact.includes('src/a.ts'));
      const noBare = names(await search.findPaths('!note.md', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(!noBare.includes('note.md'));
      const noGlob = names(await search.findPaths('src/ *.ts !skip.ts', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.deepEqual(noGlob, ['src/a.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips node_modules, .git, and dot dirs but keeps dotfiles', async () => {
    const root = await fixture({
      'node_modules/pkg/i.js': 'x',
      '.git/HEAD': 'ref',
      '.cache/x.js': 'x',
      '.env': 'x',
      'real.js': 'x',
    });
    try {
      const hits = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.deepEqual(hits, ['.env', 'real.js']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a file named exactly like the dir prefix still matches', async () => {
    const root = await fixture({ docs: 'x', 'other.txt': 'y' });
    try {
      const hits = names(await search.findPaths('docs/', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(hits.includes('docs'), `exact dir-name file kept: ${hits}`);
      assert.ok(!hits.includes('other.txt'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('a file path as cwd lists nothing instead of throwing', async () => {
    const root = await fixture({ 'a.ts': 'x' });
    try {
      assert.deepEqual(await search.findPaths('', { cwd: join(root, 'a.ts'), scan: 'mock' }), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('symlinks are skipped without follow and resolved with follow', async () => {
    const root = await fixture({ 'sub/inner.txt': 'x', 'top.txt': 'x' });
    try {
      try {
        await symlink(join(root, 'sub'), join(root, 'linkdir'), 'junction');
      } catch { return; } // junctions need no privileges; bail only if the FS refuses
      let dangling = true;
      try {
        await symlink(join(root, 'nope-missing-xyz'), join(root, 'dangling.txt'), 'file');
      } catch { dangling = false; }
      const plain = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.ok(!plain.some((n) => n.startsWith('linkdir/')), `junction skipped without follow: ${plain}`);
      const followed = names(await search.findPaths('', { cwd: root, scan: 'mock', followSymlinks: true })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.ok(followed.includes('linkdir/inner.txt'), `junction resolved with follow: ${followed}`);
      if (dangling) {
        assert.ok(!followed.includes('dangling.txt'), 'dangling link never lists, never throws');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deep trees stop at the max depth instead of recursing forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-deep-'));
    try {
      let dir = root;
      for (let i = 0; i < 30; i++) {
        dir = join(dir, `d${i}`);
        await mkdir(dir, { recursive: true });
      }
      await writeFile(join(dir, 'bottom.txt'), 'x');
      await writeFile(join(root, 'top.txt'), 'x');
      const hits = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
      assert.ok(hits.includes('top.txt'));
      assert.ok(!hits.some((h) => h.endsWith('bottom.txt')), 'beyond max depth is unreachable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('findPaths git:modified', () => {
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  it('outside a repo it throws a helpful error', async () => {
    const root = await fixture({ 'a.txt': 'x' });
    try {
      await assert.rejects(search.findPaths('git:modified', { cwd: root, scan: 'mock' }), /git:modified requires a git repository/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('inside a repo it returns only modified paths (rename arrows, quoted names)', async (t) => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch { return t.skip('git absent from PATH'); }
    const root = await mkdtemp(join(tmpdir(), 'omp-find-git-'));
    try {
      git(['init'], root);
      await writeFile(join(root, 'keep.txt'), 'v1\n');
      await writeFile(join(root, 'change.txt'), 'v1\n');
      await writeFile(join(root, 'gone.txt'), 'v1\n');
      git(['add', '.'], root);
      git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'base'], root);
      await writeFile(join(root, 'change.txt'), 'v2\n');
      await writeFile(join(root, 'new.txt'), 'fresh\n');
      await writeFile(join(root, 'a b.txt'), 'spaced\n');
      git(['mv', 'gone.txt', 'renamed.txt'], root);
      const hits = names(await search.findPaths('git:modified', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.ok(hits.includes('change.txt'), `edited file listed: ${hits}`);
      assert.ok(hits.includes('new.txt'), `untracked file listed: ${hits}`);
      assert.ok(hits.includes('a b.txt'), `quoted spaced name listed: ${hits}`);
      assert.ok(hits.includes('renamed.txt'), `rename target listed: ${hits}`);
      assert.ok(!hits.includes('keep.txt'), `unmodified file excluded: ${hits}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('findPaths via rg (no mock flag)', () => {
  it('rg listing agrees with the walker over plain files', async (t) => {
    try {
      execFileSync('rg', ['--version'], { stdio: 'ignore' });
    } catch { return t.skip('rg absent from PATH'); }
    const root = await fixture({ 'a.ts': 'x', 'sub/b.md': 'y', 'sub/deep/c.txt': 'z' });
    try {
      const viaRg = names(await search.findPaths('', { cwd: root })).map((h) => h.replace(/\\/g, '/')).sort();
      const viaWalk = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.deepEqual(viaRg, viaWalk);
      for (const p of viaRg) assert.ok(!p.startsWith('./'), `no ./ prefix: ${p}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the walker when rg is missing from PATH', async () => {
    const root = await fixture({ 'a.ts': 'x', 'sub/b.md': 'y' });
    const emptyBin = await mkdtemp(join(tmpdir(), 'omp-find-norg-'));
    try {
      const expected = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      const fallback = await withEnv({ PATH: emptyBin }, async () =>
        names(await search.findPaths('', { cwd: root })).map((h) => h.replace(/\\/g, '/')).sort());
      assert.deepEqual(fallback, expected);
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('grepContents validation and fallback', () => {
  it('rejects empty patterns and invalid regexes on both engines', async () => {
    const root = await fixture({ 'a.txt': 'x\n' });
    try {
      await assert.rejects(search.grepContents('', { cwd: root, scan: 'mock' }), /must not be empty/);
      await assert.rejects(search.grepContents('([', { cwd: root, scan: 'mock', literal: false }), /invalid regex/);
      await assert.rejects(search.grepContents('([', { cwd: root, literal: false }), /invalid regex/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fallback literal match reports line/col/text; non-matching lines are skipped', async () => {
    const root = await fixture({ 'a.txt': 'first\nthe Needle here\nlast\n' });
    try {
      const res = await search.grepContents('Needle', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 1);
      assert.equal(res.matches[0].line, 2);
      assert.equal(res.matches[0].col, 5);
      assert.match(res.matches[0].text, /Needle/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fallback ignoreCase and regex modes compute columns', async () => {
    const root = await fixture({ 'a.txt': 'AAA needle bbb\n' });
    try {
      const ci = await search.grepContents('NEEDLE', { cwd: root, scan: 'mock', ignoreCase: true });
      assert.equal(ci.total, 1);
      assert.equal(ci.matches[0].col, 5);
      const cs = await search.grepContents('NEEDLE', { cwd: root, scan: 'mock' });
      assert.equal(cs.total, 0);
      const re = await search.grepContents('n..dle', { cwd: root, scan: 'mock', literal: false });
      assert.equal(re.total, 1);
      assert.equal(re.matches[0].col, 5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fallback skips binary files and dangling links without throwing', async () => {
    const root = await fixture({ 'ok.txt': 'needle here\n' });
    try {
      await writeFile(join(root, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2]), Buffer.from('tail')]));
      let dangling = true;
      try {
        await symlink(join(root, 'missing-xyz'), join(root, 'dangle.txt'), 'file');
      } catch { dangling = false; }
      const res = await search.grepContents('needle', { cwd: root, scan: 'mock', followSymlinks: true });
      assert.equal(res.total, 1);
      assert.ok(res.matches[0].path.endsWith('ok.txt'));
      assert.ok(dangling || true, 'dangling-link setup is best-effort');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fallback trims match text to 500 chars', async () => {
    const root = await fixture({ 'long.txt': `needle ${'y'.repeat(2000)}\n` });
    try {
      const res = await search.grepContents('needle', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 1);
      assert.ok(res.matches[0].text.length <= 500, `trimmed: ${res.matches[0].text.length}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limit/offset page the fallback result set', async () => {
    const root = await fixture({ 'a.txt': 'hit\n'.repeat(10) });
    try {
      const all = await search.grepContents('hit', { cwd: root, scan: 'mock' });
      assert.equal(all.total, 10);
      const page = await search.grepContents('hit', { cwd: root, scan: 'mock', limit: 3, offset: 8 });
      assert.equal(page.matches.length, 2);
      assert.equal(page.total, 10);
      assert.equal(page.matches[0].line, 9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('grepContents via rg', () => {
  async function needRg(t) {
    try {
      execFileSync('rg', ['--version'], { stdio: 'ignore' });
    } catch { t.skip('rg absent from PATH'); }
  }

  it('literal, ignoreCase, and regex searches agree', async (t) => {
    needRg(t);
    const root = await fixture({ 'a.txt': 'Hello Needle world\nsecond line\n' });
    try {
      const lit = await search.grepContents('Needle', { cwd: root });
      assert.equal(lit.total, 1);
      const ci = await search.grepContents('needle', { cwd: root, ignoreCase: true });
      assert.equal(ci.total, 1);
      const cs = await search.grepContents('needle', { cwd: root });
      assert.equal(cs.total, 0);
      const re = await search.grepContents('N..dle', { cwd: root, literal: false });
      assert.equal(re.total, 1);
      assert.equal(re.matches[0].col, 7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no rg hits resolve empty (exit 1 is not an error)', async (t) => {
    needRg(t);
    const root = await fixture({ 'a.txt': 'nothing relevant\n' });
    try {
      const res = await search.grepContents('zzz-absent-9q', { cwd: root });
      assert.equal(res.total, 0);
      assert.deepEqual(res.matches, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rg results page by limit/offset and carry the full total', async (t) => {
    needRg(t);
    const root = await fixture({ 'a.txt': 'hit\n'.repeat(8) });
    try {
      const page = await search.grepContents('hit', { cwd: root, limit: 3, offset: 6 });
      assert.equal(page.matches.length, 2);
      assert.equal(page.total, 8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('search status / warm / clear', () => {
  it('status names rg when present and missing when PATH is stripped', async () => {
    assert.match(search.status(), /rg: /);
    const emptyBin = await mkdtemp(join(tmpdir(), 'omp-find-norg2-'));
    try {
      const missing = await withEnv({ PATH: emptyBin }, async () => search.status());
      assert.match(missing, /missing/);
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
    }
  });

  it('warmScan and clearCache resolve', async () => {
    await search.warmScan();
    await search.clearCache();
  });
});

describe('frecency store (isolated LOCALAPPDATA)', () => {
  async function isolated(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'omp-find-freq-'));
    try {
      return await withEnv({ LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir }, () => fn(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('recorded paths outscore unknown ones; counts accumulate', async () => {
    await isolated(async () => {
      await frecency.clear();
      assert.equal(await frecency.score('proj/new-a.ts'), 0);
      await frecency.recordOpen('proj/a.ts');
      await frecency.recordOpen('proj/a.ts');
      await frecency.recordOpen('proj/b.ts');
      const a = await frecency.score('proj/a.ts');
      const b = await frecency.score('proj/b.ts');
      assert.ok(a > b && b > 0, `counts accumulate with decay near 1 (${a} > ${b} > 0)`);
    });
  });

  it('backslash and slash keys are the same entry', async () => {
    await isolated(async () => {
      await frecency.clear();
      await frecency.recordOpen('proj\\win.ts');
      assert.ok((await frecency.score('proj/win.ts')) > 0, 'normalized key scores');
    });
  });

  it('scores decay with age (patched clock)', async () => {
    await isolated(async () => {
      await frecency.clear();
      const realNow = Date.now;
      try {
        Date.now = () => 1_000_000;
        await frecency.recordOpen('proj/old.ts');
        const fresh = await frecency.score('proj/old.ts');
        Date.now = () => 1_000_000 + 7 * 24 * 3600 * 1000; // one half-life later
        const aged = await frecency.score('proj/old.ts');
        assert.ok(Math.abs(fresh - 1) < 0.01, `fresh score ~1 (got ${fresh})`);
        assert.ok(Math.abs(aged - 0.5) < 0.01, `one half-life halves the score (got ${aged})`);
      } finally {
        Date.now = realNow;
      }
    });
  });
  it('corrupt and shapeless stores read as empty (fresh parse per env)', async () => {
    // Each case uses a brand-new LOCALAPPDATA dir with the content pre-written,
    // so the module cache misses and the bytes are really parsed.
    for (const content of ['not-json{{{', JSON.stringify({ entries: null }), JSON.stringify({})]) {
      const dir = await mkdtemp(join(tmpdir(), 'omp-find-freq-'));
      try {
        await withEnv({ LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir }, async () => {
          const file = frecency.storePath(process.cwd());
          assert.ok(file.startsWith(dir), `isolated to temp (${file})`);
          const { writeFileSync, mkdirSync } = await import('node:fs');
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
          assert.equal(await frecency.score('proj/a.ts'), 0, `empty for ${content}`);
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  it('status reports empty, tracked, and corrupt states', async () => {
    await isolated(async (dir) => {
      assert.match(frecency.status(), /empty/, 'no file yet reads empty');
      await frecency.recordOpen('proj/a.ts');
      assert.match(frecency.status(), /1 paths tracked/);
      assert.ok(frecency.status().includes(dir), `status names the store dir: ${frecency.status()}`);
      await frecency.clear();
      assert.match(frecency.status(), /0 paths tracked/, 'cleared store tracks nothing');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(frecency.storePath(process.cwd()), 'garbage{{{');
      assert.match(frecency.status(), /empty/, 'corrupt store reads empty');
    });
  });

  it('clear drops the score to zero', async () => {
    await isolated(async () => {
      await frecency.recordOpen('proj/a.ts');
      assert.ok((await frecency.score('proj/a.ts')) > 0);
      await frecency.clear();
      assert.equal(await frecency.score('proj/a.ts'), 0);
    });
  });

  it('recordOpen and clear never throw when the store is unwritable', async () => {
    const file = await mkdtemp(join(tmpdir(), 'omp-find-ro-'));
    try {
      const blockFile = join(file, 'block');
      await writeFile(blockFile, 'x');
      await withEnv({ LOCALAPPDATA: join(blockFile, 'sub'), HOME: file, USERPROFILE: file }, async () => {
        await frecency.recordOpen('proj/a.ts');
        await frecency.clear();
        assert.equal(await frecency.score('proj/a.ts'), 0);
      });
    } finally {
      await rm(file, { recursive: true, force: true });
    }
  });

  it('storePath honors explicit roots, win32 fallback, and posix layout', async (t) => {
    const p = frecency.storePath('some-root');
    assert.match(p.replace(/\\/g, '/'), /omp-find\/[0-9a-f]{16}\/frecency\.json$/);
    await withEnv({ LOCALAPPDATA: undefined }, async () => {
      assert.match(frecency.storePath('r'), /AppData/);
    });
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!desc || desc.configurable !== true) return t.skip('platform not redefinable here');
    try {
      Object.defineProperty(process, 'platform', { ...desc, value: 'linux' });
      assert.match(frecency.storePath('/tmp/x'), /\.omp\/var\/omp-find\/[0-9a-f]{16}\/frecency\.json$/);
    } catch {
      return t.skip('platform redefine refused');
    } finally {
      try { Object.defineProperty(process, 'platform', desc); } catch { /* best-effort restore */ }
    }
  });
});

describe('resolveFindMode from omp-find.json', () => {
  async function modeWithFile(content) {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-mode-'));
    try {
      if (content !== undefined) await writeFile(join(root, 'omp-find.json'), content);
      return await withEnv({ OMP_FIND_MODE: undefined }, async () => findTools.resolveFindMode(undefined, root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('reads additive/override from the config file', async () => {
    assert.equal(await modeWithFile('{"mode":"additive"}'), 'additive');
    assert.equal(await modeWithFile('{"mode":"override"}'), 'override');
  });

  it('bad configs fall back to override', async () => {
    assert.equal(await modeWithFile(undefined), 'override');
    assert.equal(await modeWithFile('not-json'), 'override');
    assert.equal(await modeWithFile('{}'), 'override');
    assert.equal(await modeWithFile('{"mode":42}'), 'override');
    assert.equal(await modeWithFile('{"mode":null}'), 'override');
    assert.equal(await modeWithFile('[1,2]'), 'override');
    assert.equal(await modeWithFile('"additive"'), 'override');
  });
});

describe('registerFindTools edges', () => {
  const stubHits = (n, prefix = 'f') =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);
  const stubMatches = (n) =>
    Array.from({ length: n }, (_, i) => ({ path: `src/t${i}.ts`, line: i + 1, col: 1, text: `hit ${i}` }));

  function stubSearch(hits, matches, calls) {
    return {
      findPaths: async (query, opts) => {
        calls?.find?.push({ query, opts });
        return [...hits];
      },
      grepContents: async (pattern, opts) => {
        calls?.grep?.push({ pattern, opts });
        const ms = matches ?? hits.map((p) => ({ path: p, line: 1, col: 1, text: 'x' }));
        if (opts && typeof opts.limit === 'number') {
          const off = opts.offset ?? 0;
          return { matches: ms.slice(off, off + opts.limit), total: ms.length };
        }
        return { matches: [...ms], total: ms.length };
      },
      globToRegExp: search.globToRegExp,
    };
  }

  it('registers nothing when search is missing or partial', () => {
    for (const deps of [{}, { search: undefined }, { search: { findPaths: async () => [] } }, { search: { grepContents: async () => ({ matches: [], total: 0 }) } }]) {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, deps, { mode: 'override' });
      assert.equal(pi.tools.size, 0, `no tools for ${JSON.stringify(Object.keys(deps.search ?? {}))}`);
    }
  });

  it('supports the single-arg host arity', async () => {
    const pi = fakePiOneArg();
    findTools.registerFindTools(pi, { search: stubSearch(['a.ts']) }, { mode: 'additive' });
    assert.deepEqual([...pi.tools.keys()].sort(), ['fffind', 'ffgrep']);
    const out = await pi.tools.get('fffind').execute('t', { pattern: 'a' });
    assert.ok(textOf(out).includes('a.ts'));
  });

  it('fffind requires a pattern or path; search errors render as text', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch(['a.ts']) }, { mode: 'additive' });
    const find = pi.tools.get('fffind');
    assert.match(textOf(await find.execute('t', {})), /provide a pattern or path/);
    assert.match(textOf(await find.execute('t', { pattern: '', path: '' })), /provide a pattern or path/);
    assert.match(textOf(await find.execute('t', { cursor: 'nope-1' })), /unknown or expired cursor/);
    const boom = fakePiTwoArg();
    findTools.registerFindTools(boom, {
      search: {
        findPaths: async () => { throw new Error('disk-boom'); },
        grepContents: async () => ({ matches: [], total: 0 }),
      },
    }, { mode: 'additive' });
    assert.match(textOf(await boom.tools.get('fffind').execute('t', { pattern: 'x' })), /fffind failed: disk-boom/);
    const strBoom = fakePiTwoArg();
    findTools.registerFindTools(strBoom, {
      search: {
        findPaths: async () => { throw 'string-boom'; },
        grepContents: async () => ({ matches: [], total: 0 }),
      },
    }, { mode: 'additive' });
    assert.match(textOf(await strBoom.tools.get('fffind').execute('t', { pattern: 'x' })), /fffind failed: string-boom/);
  });

  it('fffind reports no files, clamps limits, and pages through a cursor', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch([]) }, { mode: 'additive' });
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'zzz' })), /0 matches/);

    const pi2 = fakePiTwoArg();
    const calls = { find: [] };
    findTools.registerFindTools(pi2, { search: stubSearch(stubHits(5), undefined, calls) }, { mode: 'additive' });
    const find = pi2.tools.get('fffind');
    const page1 = textOf(await find.execute('t1', { pattern: 'f', limit: 2 }));
    assert.ok(page1.includes('f0.ts') && page1.includes('f1.ts'), `first page:\n${page1}`);
    assert.ok(!page1.includes('f2.ts'));
    const c1 = cursorOf({ content: [{ type: 'text', text: page1 }] });
    assert.ok(c1, 'cursor advertised');
    const page2 = textOf(await find.execute('t2', { cursor: c1 }));
    assert.ok(page2.includes('f2.ts') && page2.includes('f3.ts'), `second page:\n${page2}`);
    const c2 = cursorOf({ content: [{ type: 'text', text: page2 }] });
    const page3 = textOf(await find.execute('t3', { cursor: c2 }));
    assert.ok(page3.includes('f4.ts') && !/more; pass cursor/.test(page3), `last page closes:\n${page3}`);
    // A find cursor is rejected by grep and vice versa.
    const grep = pi2.tools.get('ffgrep');
    assert.match(textOf(await grep.execute('t4', { cursor: c1 })), /unknown or expired cursor/);
    // The tool always fetches a full window from search; search saw PAGE_MAX.
    assert.deepEqual(calls.find[0].opts, { cwd: undefined, limit: 50, offset: 0 });
  });

  it('fffind limit validation: clamp, floor, and defaults', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch(stubHits(60)) }, { mode: 'additive' });
    const find = pi.tools.get('fffind');
    const clamped = textOf(await find.execute('t', { pattern: 'f', limit: 1000 }));
    assert.match(clamped, /\(10 more; pass cursor/);
    const floored = textOf(await find.execute('t', { pattern: 'f', limit: 2.7 }));
    assert.match(floored, /\(58 more; pass cursor/);
    for (const bad of [-5, 0, NaN, 'x', true]) {
      const out = textOf(await find.execute('t', { pattern: 'f', limit: bad }));
      assert.ok(!/more; pass cursor/.test(out) || out.includes('(30 more'), `default page for limit=${String(bad)}:\n${out}`);
    }
  });

  it('fffind orders by frecency and tolerates failing scores', async () => {
    const pi = fakePiTwoArg();
    const frec = { score: async (p) => (p === 'b.ts' ? 9 : 0) };
    findTools.registerFindTools(pi, { search: stubSearch(['a.ts', 'b.ts', 'c.ts']), frecency: frec }, { mode: 'additive' });
    const lines = textOf(await pi.tools.get('fffind').execute('t', { pattern: 'x' })).split('\n');
    assert.equal(lines[0], 'b.ts');
    const throwing = fakePiTwoArg();
    findTools.registerFindTools(throwing, {
      search: stubSearch(['a.ts']),
      frecency: { score: async () => { throw new Error('freq-down'); } },
    }, { mode: 'additive' });
    assert.ok(textOf(await throwing.tools.get('fffind').execute('t', { pattern: 'x' })).includes('a.ts'));
    const nofreq = fakePiTwoArg();
    findTools.registerFindTools(nofreq, { search: stubSearch(['a.ts']) }, { mode: 'additive' });
    assert.ok(textOf(await nofreq.tools.get('fffind').execute('t', { pattern: 'x' })).includes('a.ts'));
  });

  it('fffind passes path+pattern query and cwd through to search', async () => {
    const pi = fakePiTwoArg();
    const calls = { find: [] };
    findTools.registerFindTools(pi, { search: stubSearch(['src/a.ts'], undefined, calls) }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('fffind').execute('t', { pattern: 'a', path: 'src/', cwd: '/tmp/x' }));
    assert.ok(out.includes('src/a.ts'));
    assert.equal(calls.find[0].query, 'src/ a');
    assert.equal(calls.find[0].opts.cwd, '/tmp/x');
  });

  it('fffind renders native separators as display slashes', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch(['a\\b\\c.ts']) }, { mode: 'additive' });
    assert.ok(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'c' })).includes('a/b/c.ts'));
  });

  it('ffgrep requires a pattern; errors render as text', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch([]) }, { mode: 'additive' });
    const grep = pi.tools.get('ffgrep');
    assert.match(textOf(await grep.execute('t', {})), /provide a pattern/);
    assert.match(textOf(await grep.execute('t', { pattern: '' })), /provide a pattern/);
    assert.match(textOf(await grep.execute('t', { cursor: 'nope-9' })), /unknown or expired cursor/);
    const boom = fakePiTwoArg();
    findTools.registerFindTools(boom, {
      search: {
        findPaths: async () => [],
        grepContents: async () => { throw new Error('grep-boom'); },
      },
    }, { mode: 'additive' });
    assert.match(textOf(await boom.tools.get('ffgrep').execute('t', { pattern: 'x' })), /ffgrep failed: grep-boom/);
  });

  it('ffgrep parses literal/ignoreCase, forwards bounded pages without a filter', async () => {
    const pi = fakePiTwoArg();
    const calls = { grep: [] };
    findTools.registerFindTools(pi, { search: stubSearch([], stubMatches(5), calls) }, { mode: 'additive' });
    const grep = pi.tools.get('ffgrep');
    const out = textOf(await grep.execute('t', { pattern: 'hit', literal: false, ignoreCase: true, limit: 2, cwd: '/tmp/y' }));
    assert.ok(out.includes('src/t0.ts:1:1: hit 0'), `first page:\n${out}`);
    assert.deepEqual(calls.grep[0], { pattern: 'hit', opts: { cwd: '/tmp/y', literal: false, ignoreCase: true, wholeWord: false, smartCase: false, limit: 2, offset: 0 } });
    // Defaults: literal true, case-sensitive, page 30.
    await grep.execute('t', { pattern: 'hit' });
    assert.deepEqual(calls.grep[1].opts, { cwd: undefined, literal: true, ignoreCase: false, wholeWord: false, smartCase: false, limit: 30, offset: 0 });
    // Explicit literal:true and ignoreCase:false behave the same.
    await grep.execute('t', { pattern: 'hit', literal: true, ignoreCase: false });
    assert.deepEqual(calls.grep[2].opts.literal, true);
    // Non-boolean literal values fall back to literal matching.
    await grep.execute('t', { pattern: 'hit', literal: 'yes' });
    assert.equal(calls.grep[3].opts.literal, false);
  });

  it('ffgrep path filters: dir, ./, glob, bare name, and misses', async () => {
    const ms = [
      { path: 'src/a.ts', line: 1, col: 1, text: 'M' },
      { path: 'src/b.js', line: 2, col: 1, text: 'M' },
      { path: 'other/a.ts', line: 3, col: 1, text: 'M' },
    ];
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch([], ms) }, { mode: 'additive' });
    const grep = pi.tools.get('ffgrep');
    const dir = textOf(await grep.execute('t', { pattern: 'M', path: 'src/' }));
    assert.ok(dir.includes('src/a.ts') && !dir.includes('other/a.ts'), `dir filter:\n${dir}`);
    const dot = textOf(await grep.execute('t', { pattern: 'M', path: './src/' }));
    assert.ok(dot.includes('src/a.ts') && !dot.includes('other/a.ts'), `./ filter:\n${dot}`);
    const glob = textOf(await grep.execute('t', { pattern: 'M', path: '*.ts' }));
    assert.ok(glob.includes('src/a.ts') && glob.includes('other/a.ts') && !glob.includes('b.js'), `glob filter:\n${glob}`);
    const bare = textOf(await grep.execute('t', { pattern: 'M', path: 'a.ts' }));
    assert.ok(bare.includes('src/a.ts') && bare.includes('other/a.ts'), `bare-name filter:\n${bare}`);
    const exact = textOf(await grep.execute('t', { pattern: 'M', path: 'src/a.ts' }));
    assert.ok(exact.includes('src/a.ts') && !exact.includes('other/a.ts'), `exact filter:\n${exact}`);
    assert.match(textOf(await grep.execute('t', { pattern: 'M', path: 'nowhere/' })), /0 matches for "M"/);
    // A glob filter without a glob compiler falls back to bare-name matching.
    const pi2 = fakePiTwoArg();
    findTools.registerFindTools(pi2, {
      search: {
        findPaths: async () => [],
        grepContents: async () => ({ matches: ms, total: ms.length }),
      },
    }, { mode: 'additive' });
    assert.match(textOf(await pi2.tools.get('ffgrep').execute('t', { pattern: 'M', path: '*.ts' })), /0 matches for "M"/);
  });

  it('ffgrep pages filtered results through a cursor', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch([], stubMatches(5)) }, { mode: 'additive' });
    const grep = pi.tools.get('ffgrep');
    const page1 = textOf(await grep.execute('t1', { pattern: 'hit', path: 'src/', limit: 2 }));
    assert.ok(page1.includes('src/t0.ts') && page1.includes('src/t1.ts'), `first page:\n${page1}`);
    const page2 = textOf(await grep.execute('t2', { cursor: cursorOf({ content: [{ type: 'text', text: page1 }] }) }));
    assert.ok(page2.includes('src/t2.ts') && page2.includes('src/t3.ts'), `second page:\n${page2}`);
    const page3 = textOf(await grep.execute('t3', { cursor: cursorOf({ content: [{ type: 'text', text: page2 }] }) }));
    assert.ok(page3.includes('src/t4.ts') && !/more; pass cursor/.test(page3), `last page:\n${page3}`);
    // A grep cursor is rejected by find.
    const find = pi.tools.get('fffind');
    assert.match(textOf(await find.execute('t', { cursor: cursorOf({ content: [{ type: 'text', text: page1 }] }) })), /unknown or expired cursor/);
  });

  it('ffgrep without a filter honors search-side paging and an empty total', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch([], []) }, { mode: 'additive' });
    assert.match(textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'zzz' })), /0 matches for "zzz"/);
  });

  it('old cursors expire once the cursor table overflows', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stubSearch(stubHits(60)) }, { mode: 'additive' });
    const find = pi.tools.get('fffind');
    const first = cursorOf(await find.execute('t0', { pattern: 'f', limit: 30 }));
    assert.ok(first, 'first cursor issued');
    for (let i = 0; i < 205; i++) await find.execute(`t${i}`, { pattern: 'f', limit: 30 });
    assert.match(textOf(await find.execute('t-last', { cursor: first })), /unknown or expired cursor/);
  });
});

describe('find commands edges', () => {
  it('health renders string, object, throwing, and missing statuses', async () => {
    const pi = fakePiTwoArg();
    commands.registerFindCommands(pi, {
      search: { status: 'plain-string' },
      frecency: { status: { tracked: 4 } },
    });
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-health').handler('', ctx);
    assert.match(notes[0].text, /index: ok \(plain-string\)/);
    assert.match(notes[0].text, /frecency: ok \(\{"tracked":4\}\)/);

    const pi2 = fakePiTwoArg();
    commands.registerFindCommands(pi2, {
      search: { status: () => { throw new Error('idx-boom'); } },
      frecency: { status: () => { throw 'freq-boom'; } },
    });
    const ctx2 = {};
    const notes2 = notified(ctx2);
    await pi2.commands.get('find-health').handler('', ctx2);
    assert.match(notes2[0].text, /index: error \(idx-boom\)/);
    assert.match(notes2[0].text, /frecency: error \(freq-boom\)/);

    const pi3 = fakePiTwoArg();
    commands.registerFindCommands(pi3, {});
    const ctx3 = {};
    const notes3 = notified(ctx3);
    await pi3.commands.get('find-health').handler('', ctx3);
    assert.match(notes3[0].text, /no status reported/);
  });

  it('rescan covers rescan-fallback, single drops, and both failure modes', async () => {
    const pi = fakePiTwoArg();
    commands.registerFindCommands(pi, { search: { rescan: async () => {} } });
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-rescan').handler('', ctx);
    assert.match(notes[0].text, /caches dropped: index/);

    const pi2 = fakePiTwoArg();
    commands.registerFindCommands(pi2, { frecency: { clear: async () => {} } });
    const ctx2 = {};
    const notes2 = notified(ctx2);
    await pi2.commands.get('find-rescan').handler('', ctx2);
    assert.match(notes2[0].text, /caches dropped: frecency/);

    const pi3 = fakePiTwoArg();
    commands.registerFindCommands(pi3, { search: { clearCache: async () => { throw new Error('idx-down'); } } });
    const ctx3 = {};
    const notes3 = notified(ctx3);
    await pi3.commands.get('find-rescan').handler('', ctx3);
    assert.match(notes3[0].text, /\/find-rescan failed \(index\): idx-down/);

    const pi4 = fakePiTwoArg();
    commands.registerFindCommands(pi4, {
      search: { clearCache: async () => {} },
      frecency: { clear: async () => { throw new Error('freq-down'); } },
    });
    const ctx4 = {};
    const notes4 = notified(ctx4);
    await pi4.commands.get('find-rescan').handler('', ctx4);
    assert.match(notes4[0].text, /\/find-rescan failed \(frecency\): freq-down/);

    const pi5 = fakePiTwoArg();
    commands.registerFindCommands(pi5, { search: { rescan: async () => { throw new Error('rs-down'); } } });
    const ctx5 = {};
    const notes5 = notified(ctx5);
    await pi5.commands.get('find-rescan').handler('', ctx5);
    assert.match(notes5[0].text, /\/find-rescan failed \(index\): rs-down/);
  });

  it('handlers survive a throwing notifier', async () => {
    const pi = fakePiTwoArg();
    commands.registerFindCommands(pi, { search: { status: () => 's' } });
    const badCtx = { ui: { notify: () => { throw new Error('ui-down'); } } };
    await pi.commands.get('find-health').handler('', badCtx);
    await pi.commands.get('find-rescan').handler('', badCtx);
    const bareCtx = {};
    await pi.commands.get('find-health').handler('', bareCtx);
    await pi.commands.get('find-rescan').handler('', bareCtx);
  });
});

describe('extension host tolerance', () => {
  it('never throws when command registration or the event hook fails', async () => {
    assert.doesNotThrow(() => extension.default({ registerCommand() { throw new Error('cmd-down'); }, registerTool() {} }));
    assert.doesNotThrow(() => extension.default({
      registerCommand() {},
      registerTool() {},
      on() { throw new Error('events-down'); },
    }));
  });

  it('survives throwing tool registration and warms on session_start', async () => {
    const pi = fakePiTwoArg();
    pi.registerTool = () => { throw new Error('tool-down'); };
    assert.doesNotThrow(() => extension.default(pi));
    await new Promise((r) => setTimeout(r, 150));
    // A synchronous session_start before wiring completes must not throw either.
    const pi2 = fakePiTwoArg();
    extension.default(pi2);
    pi2.emit('session_start', {}, {});
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(pi2.commands.has('find-health'), 'commands wired');
    assert.deepEqual([...pi2.tools.keys()].sort(), ['ffcallers', 'fffind', 'ffgrep', 'ffoutline', 'ffstructural', 'find', 'grep', 'outline', 'structural']);
    pi2.emit('session_start', {}, {});
  });
});

describe('fff-ported cases (adapted)', () => {
  it('self-search finds this very test file under the repo root', async () => {
    const hits = names(await search.findPaths('coverage.mjs', { cwd: process.cwd(), scan: 'mock' })).map((h) => h.replace(/\\/g, '/'));
    assert.ok(hits.some((h) => h === 'test/coverage.mjs'), `self-search hit: ${hits}`);
  });

  it('results resolve against the searched dir, not process.cwd (fff issue #389 class)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'omp-find-389-'));
    const target = join(sandbox, 'target-dir');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'issue389_target.txt'), 'regression fixture\n');
    try {
      assert.notEqual(process.cwd(), target);
      const hits = names(await search.findPaths('issue389', { cwd: target, scan: 'mock' }));
      assert.ok(hits.length > 0, 'target fixture found via explicit cwd');
      for (const h of hits) {
        const { stat } = await import('node:fs/promises');
        await stat(join(target, h)); // resolves against the searched dir
        assert.ok(!h.includes('..'), `no escaping relpath: ${h}`);
      }
      const leaked = names(await search.findPaths('issue389_target', { cwd: process.cwd(), scan: 'mock' }));
      assert.ok(!leaked.some((h) => h.replace(/\\/g, '/').endsWith('issue389_target.txt')), 'sandbox file absent from the primary root');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('explicit cwd wins over a changed process.cwd (cd-during-scan class)', async () => {
    const root = await fixture({ 'cdproof.txt': 'x\n' });
    const saved = process.cwd();
    try {
      process.chdir(tmpdir());
      assert.equal(process.cwd() === saved, false);
      const hits = names(await search.findPaths('cdproof', { cwd: root, scan: 'mock' }));
      assert.ok(hits.some((h) => h.endsWith('cdproof.txt')), `explicit cwd honored after chdir: ${hits}`);
      const res = await search.grepContents('x', { cwd: root, scan: 'mock' });
      assert.ok(res.total > 0, 'grep honors explicit cwd after chdir');
    } finally {
      process.chdir(saved);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('every grep match line contains the marker; marker spans files', async () => {
    const marker = 'isolated_grep_marker_xyzzy_7f3';
    const root = await fixture({
      'one.txt': `prefix ${marker} suffix\nnoise\n`,
      'sub/two.txt': `other ${marker} here\n`,
      'clean.txt': 'nothing relevant\n',
    });
    try {
      const res = await search.grepContents(marker, { cwd: root, scan: 'mock' });
      assert.ok(res.total >= 2, `marker found repeatedly: ${res.total}`);
      const files = new Set(res.matches.map((m) => m.path));
      assert.ok(files.size >= 2, `marker spans files: ${[...files]}`);
      for (const m of res.matches) {
        assert.ok(typeof m.line === 'number' && m.line >= 1, '1-based line');
        assert.ok(typeof m.col === 'number' && m.col >= 1, '1-based col');
        assert.ok(m.text.includes(marker), `matched line carries the marker: ${m.text}`);
      }
      const rgRes = await search.grepContents(marker, { cwd: root });
      assert.equal(rgRes.total, res.total, 'rg and walker agree on the marker');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a missing cwd searches nothing instead of throwing', async () => {
    const missing = join(tmpdir(), `omp-find-missing-${process.pid}-xyz`);
    await rm(missing, { recursive: true, force: true });
    assert.deepEqual(await search.findPaths('anything', { cwd: missing, scan: 'mock' }), []);
    assert.deepEqual(await search.findPaths('anything', { cwd: missing }), []);
    const res = await search.grepContents('anything', { cwd: missing, scan: 'mock' });
    assert.equal(res.total, 0);
    assert.deepEqual(res.matches, []);
  });

  it('clearing caches keeps listing working (stateless rescan)', async () => {
    const root = await fixture({ 'a.ts': 'x\n', 'sub/b.ts': 'y\n' });
    try {
      await search.clearCache();
      await frecency.clear();
      const hits = names(await search.findPaths('', { cwd: root, scan: 'mock' })).map((h) => h.replace(/\\/g, '/')).sort();
      assert.deepEqual(hits, ['a.ts', 'sub/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an invalid explicit mode falls back to the default instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-badmode-'));
    try {
      const mode = await withEnv({ OMP_FIND_MODE: undefined }, async () => findTools.resolveFindMode('bogus', root));
      assert.equal(mode, 'override');
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search: { findPaths: async () => [], grepContents: async () => ({ matches: [], total: 0 }) } }, { mode: 'bogus', cwd: root });
      assert.deepEqual([...pi.tools.keys()].sort(), ['fffind', 'ffgrep', 'find', 'grep']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('tool cards displace shell (wording, approval, arity)', () => {

  it('descriptions lead with instead-of-shell and carry worked examples', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, {
      search: { findPaths: async () => [], grepContents: async () => ({ matches: [], total: 0 }) },
    }, { mode: 'additive' });
    const find = pi.tools.get('fffind'), grep = pi.tools.get('ffgrep');
    for (const [def, name] of [[find, 'fffind'], [grep, 'ffgrep']]) {
      assert.match(def.description, /^Use instead of shell grep\/rg\/find\/ls because /);
      assert.equal(def.approval, 'read', `${name}: read-only tier`);
      assert.ok(Array.isArray(def.promptGuidelines) && def.promptGuidelines.length <= 3, `${name}: at most 3 guidelines`);
      assert.ok(def.promptGuidelines.every((g) => g.startsWith(`${name}: `)), `${name}: every guideline carries the tool-name prefix`);
      assert.ok(def.promptGuidelines.some((g) => /Never use shell/.test(g)), `${name}: never-shell rule`);
      assert.ok(def.parameters.properties.cwd, `${name}: cwd scan root exposed`);
      assert.equal(def.parameters.additionalProperties, false, `${name}: schema stays closed`);
    }
    assert.match(grep.description, /Chat ID \(CHT-XXXX from list_chats or search_chats\)/);
    assert.match(grep.description, /server\.py/);
    assert.match(find.description, /srv usr/);
  });

  it('registers through the single-object host arity', async () => {
    const seen = [];
    findTools.registerFindTools({ registerTool(...args) { seen.push(args); } }, {
      search: { findPaths: async () => [], grepContents: async () => ({ matches: [], total: 0 }) },
    }, { mode: 'additive' });
    assert.deepEqual(seen.map((a) => a[0].name).sort(), ['fffind', 'ffgrep']);
    for (const args of seen) assert.equal(args.length, 1, 'one object, not (name, def)');
  });
});

describe('fffind auto-retry + zero-state counts', () => {
  function metaStub(onQuery) {
    const calls = [];
    return {
      calls,
      search: {
        findScanned: async (q) => { calls.push(q); return onQuery(q); },
        findPaths: async (q) => { calls.push(`paths:${q}`); return onQuery(q).paths; },
        grepContents: async () => ({ matches: [], total: 0 }),
        globToRegExp: search.globToRegExp,
      },
    };
  }

  it('3+-word zero results retry once with the first 2 terms', async () => {
    const { calls, search: stub } = metaStub((q) => q === 'alpha beta'
      ? { paths: ['src/ab.ts'], scanned: 42, backend: 'rg' }
      : { paths: [], scanned: 42, backend: 'rg' });
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stub }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('fffind').execute('t', { pattern: 'alpha beta gamma' }));
    assert.deepEqual(calls, ['alpha beta gamma', 'alpha beta']);
    assert.ok(out.includes('src/ab.ts'), `relaxed hits:\n${out}`);
    assert.match(out, /no matches for "alpha beta gamma"; showing results for "alpha beta"/);
  });

  it('relaxed-but-empty reports counts plus the relaxation; short queries stay plain', async () => {
    const { search: stub } = metaStub(() => ({ paths: [], scanned: 7, backend: 'walker' }));
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stub }, { mode: 'additive' });
    assert.match(
      textOf(await pi.tools.get('fffind').execute('t', { pattern: 'a b c' })),
      /0 matches for "a b c" \(7 files scanned, walker; relaxed to "a b"\)/,
    );
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'zz' })), /0 matches \(7 files scanned, walker\)/);
  });

  it('legacy cores without findScanned retry through findPaths', async () => {
    const calls = [];
    const stub = {
      findPaths: async (q) => { calls.push(q); return q === 'x y' ? ['hit.ts'] : []; },
      grepContents: async () => ({ matches: [], total: 0 }),
      globToRegExp: search.globToRegExp,
    };
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search: stub }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('fffind').execute('t', { pattern: 'x y z' }));
    assert.deepEqual(calls, ['x y z', 'x y']);
    assert.ok(out.includes('hit.ts') && /showing results for "x y"/.test(out), `legacy retry hits:\n${out}`);
    assert.equal(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'nope' })), '0 matches');
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'q w e' })), /0 matches for "q w e" \(relaxed to "q w"\)/);
  });

  it('odd findScanned shapes fall back to findPaths', async () => {
    for (const scanned of [async () => null, async () => ({ paths: [42], scanned: 'many', backend: 'rg' }), 42]) {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, {
        search: {
          findScanned: scanned,
          findPaths: async () => ['ok.ts'],
          grepContents: async () => ({ matches: [], total: 0 }),
          globToRegExp: search.globToRegExp,
        },
      }, { mode: 'additive' });
      assert.ok(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'q' })).includes('ok.ts'));
    }
  });

  it('real scans report files scanned plus the serving backend', async () => {
    const root = await fixture({ 'a.txt': 'x\n', 'sub/b.txt': 'y\n' });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      assert.match(
        textOf(await pi.tools.get('fffind').execute('t', { pattern: 'zzz-no-hit', cwd: root })),
        /0 matches \(\d+ files scanned, (rg|walker)\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffgrep verbatim phrases + totals (no shell -c needed)', () => {
  const phrase = 'Chat ID (CHT-XXXX from list_chats or search_chats)';
  it('literal phrase plus bare filename resolves in one call', async () => {
    const root = await fixture({
      'server.py': `# list chats\nlabel = "${phrase}"\n`,
      'other.py': 'nothing relevant here\n',
    });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: phrase, path: 'server.py', cwd: root }));
      assert.ok(out.includes('server.py:'), `row:\n${out}`);
      assert.ok(!out.includes('other.py'), `bare filename scopes:\n${out}`);
      assert.match(out, /\(1 match total\)/);
      // The walker agrees with rg on literal specials (no escaping ever).
      const w = await search.grepContents(phrase, { cwd: root, scan: 'mock' });
      assert.equal(w.total, 1);
      assert.equal(w.backend, 'walker');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('zero states name the pattern plus the backend when known', async () => {
    const root = await fixture({ 'a.txt': 'hello\n' });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      assert.match(
        textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'zzz-absent', cwd: root })),
        /0 matches for "zzz-absent" \((rg|walker)\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const pi2 = fakePiTwoArg();
    findTools.registerFindTools(pi2, {
      search: { findPaths: async () => [], grepContents: async () => ({ matches: [], total: 0 }) },
    }, { mode: 'additive' });
    assert.equal(textOf(await pi2.tools.get('ffgrep').execute('t', { pattern: 'zzz-absent' })), '0 matches for "zzz-absent"');
  });
});

describe('cwd scan root', () => {
  it('absolute cwd scans another tree; relative cwd is rejected', async () => {
    const root = await fixture({ 'marker.txt': 'marker-body\n' });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      const find = pi.tools.get('fffind'), grep = pi.tools.get('ffgrep');
      assert.ok(textOf(await find.execute('t', { pattern: 'marker', cwd: root })).includes('marker.txt'));
      assert.ok(textOf(await grep.execute('t', { pattern: 'marker-body', cwd: root })).includes('marker.txt'));
      assert.match(textOf(await find.execute('t', { pattern: 'marker', cwd: 'rel/dir' })), /cwd must be an absolute directory path/);
      assert.match(textOf(await grep.execute('t', { pattern: 'marker-body', cwd: 'rel/dir' })), /cwd must be an absolute directory path/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filesystem-root and home scans are refused through the tools', async () => {
    const pi = fakePiTwoArg();
    findTools.registerFindTools(pi, { search }, { mode: 'additive' });
    const fsRoot = parsePath(process.cwd()).root;
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'x', cwd: fsRoot })), /refusing to scan the filesystem root/);
    assert.match(textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'x', cwd: fsRoot })), /refusing to scan the filesystem root/);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
    assert.match(textOf(await pi.tools.get('fffind').execute('t', { pattern: 'x', cwd: home })), /refusing to scan the home directory/);
  });

  it('outline/callers honor an absolute cwd', async () => {
    const root = await fixture({ 'mod.ts': 'export function hello() { return 1; }\n' });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      if (typeof search.outlineFile === 'function') {
        assert.ok(textOf(await pi.tools.get('ffoutline').execute('t', { path: 'mod.ts', cwd: root })).includes('hello'));
        assert.match(textOf(await pi.tools.get('ffoutline').execute('t', { path: 'mod.ts', cwd: 'rel' })), /absolute directory path/);
      }
      if (typeof search.callersOf === 'function') {
        assert.equal(typeof textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'hello', cwd: root })), 'string');
        assert.match(textOf(await pi.tools.get('ffcallers').execute('t', { symbol: 'hello', cwd: 'rel' })), /absolute directory path/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('scan metadata cores', () => {
  it('findScanned reports counts plus backend; grepContents reports backend', async () => {
    const root = await fixture({ 'a.txt': 'x\n', 'sub/b.txt': 'y\n' });
    try {
      const scan = await search.findScanned('', { cwd: root, scan: 'mock' });
      assert.equal(scan.backend, 'walker');
      assert.equal(scan.scanned, 2);
      assert.deepEqual(scan.paths.map((p) => p.replace(/\\/g, '/')).sort(), ['a.txt', 'sub/b.txt']);
      assert.equal((await search.grepContents('x', { cwd: root, scan: 'mock' })).backend, 'walker');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('find-health levels', () => {
  it('real statuses carry ok with an info kind; stripped PATH warns', async () => {
    const pi = fakePiTwoArg();
    commands.registerFindCommands(pi, { search, frecency });
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-health').handler('', ctx);
    assert.match(notes[0].text, /^find status\nindex: (ok|warn) \(rg: /);
    assert.equal(notes[0].kind, /rg: missing/.test(search.status()) ? 'warn' : 'info');
    const emptyBin = await mkdtemp(join(tmpdir(), 'omp-find-norg3-'));
    try {
      const piW = fakePiTwoArg();
      commands.registerFindCommands(piW, { search, frecency });
      const ctxW = {};
      const notesW = notified(ctxW);
      await withEnv({ PATH: emptyBin }, async () => piW.commands.get('find-health').handler('', ctxW));
      assert.match(notesW[0].text, /index: warn \(rg: missing/);
      assert.equal(notesW[0].kind, 'warn');
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
    }
  });

  it('throwing statuses surface an error kind', async () => {
    const pi = fakePiTwoArg();
    commands.registerFindCommands(pi, { search: { status: () => { throw new Error('x'); } } });
    const ctx = {};
    const notes = notified(ctx);
    await pi.commands.get('find-health').handler('', ctx);
    assert.match(notes[0].text, /index: error \(x\)/);
    assert.equal(notes[0].kind, 'error');
  });
});

describe('fuzzyScore tiers (exact -20, stem -10, fuzzy 0; upstream PR #728)', () => {
  it('table: exact, stem, fuzzy, and no-match scores', () => {
    const cases = [
      // [pattern, target, expected]
      ['main.ts', 'main.ts', -20], // exact, gap-free
      ['main', 'main.ts', -10], // stem, gap-free
      ['mai', 'main.ts', 0], // fuzzy prefix, no bonus
      ['maint', 'main.ts', 2], // near-stem prefix with a gap, separator is not a dot: no bonus
      ['mt', 'main.ts', 8], // fuzzy with gaps, no bonus
      ['zzz', 'main.ts', Number.POSITIVE_INFINITY], // no match
      ['main.ts', 'src/main.ts', -12], // exact with a dir gap (8 - 20)
      ['main', 'src/main.ts', -2], // stem with a dir gap (8 - 10)
      ['mn', 'src/main.ts', 12], // fuzzy subsequence, not a stem
      ['user.test', 'user.test.ts', 0], // second dot: not a single-extension stem
      ['a', 'a.b', -10], // single-char stem and extension
      ['main', 'main.', 0], // empty extension is not a stem
    ];
    for (const [pattern, target, expected] of cases) {
      assert.equal(search.fuzzyScore(pattern, target), expected, `${pattern} vs ${target}`);
    }
  });

  it('tiers order exact < stem < fuzzy on one target', () => {
    const exact = search.fuzzyScore('main.ts', 'src/main.ts');
    const stem = search.fuzzyScore('main', 'src/main.ts');
    const fuzzy = search.fuzzyScore('mn', 'src/main.ts');
    assert.ok(exact < stem && stem < fuzzy, `exact ${exact} < stem ${stem} < fuzzy ${fuzzy}`);
  });
});

describe('walker scan honors the cooperative deadline', () => {
  it('a wide tree under a tiny budget rejects promptly with timeout text', async () => {
    const struct = {};
    for (let d = 0; d < 120; d++) {
      for (let f = 0; f < 10; f++) struct[`d${d}/f${f}.txt`] = `filler ${d}/${f}\n`.repeat(200);
    }
    const root = await fixture(struct);
    try {
      const start = Date.now();
      await assert.rejects(
        search.grepContents('zzz-absent-9q', { cwd: root, scan: 'mock', timeoutMs: 10 }),
        /grep timed out after 0\.01s/,
        'walker aborts instead of finishing the tree',
      );
      assert.ok(Date.now() - start < 15000, 'rejection arrives promptly');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffgrep wholeWord flag', () => {
  it("'port' skips 'export'/'portNumber' with the flag on, matches all with it off", async () => {
    const root = await fixture({ 'a.txt': 'port\nexport\nportNumber\n(port)\n' });
    try {
      for (const scan of [undefined, 'mock']) {
        const opts = scan === undefined ? { cwd: root } : { cwd: root, scan };
        const on = await search.grepContents('port', { ...opts, wholeWord: true });
        assert.equal(on.total, 2, `whole-word hits (${scan ?? 'rg'}): ${on.total}`);
        assert.ok(on.matches.every((m) => /(^|\W)port(\W|$)/.test(m.text)), 'boundary-held rows only');
        const off = await search.grepContents('port', opts);
        assert.equal(off.total, 4, `flag off preserves substring behavior (${scan ?? 'rg'})`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wholeWord composes with regex and travels through cursors', async () => {
    const root = await fixture({ 'a.txt': 'foo bar\nfoobar\nfoo\n' });
    try {
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      const grep = pi.tools.get('ffgrep');
      const page1 = textOf(await grep.execute('t1', { pattern: 'foo', wholeWord: true, literal: false, limit: 1, cwd: root }));
      assert.ok(page1.includes('foo bar'), `first whole-word hit:\n${page1}`);
      assert.ok(!page1.includes('foobar'), 'partial word excluded');
      const c1 = /cursor "([^"]+)"/.exec(page1)?.[1];
      assert.ok(c1, 'cursor advertised');
      const page2 = textOf(await grep.execute('t2', { cursor: c1 }));
      assert.ok(page2.includes('a.txt:3'), `second page keeps the flag:\n${page2}`);
      assert.ok(!page2.includes('foobar'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffgrep smartCase flag', () => {
  it('lowercase goes insensitive, uppercase stays sensitive, defaults untouched', async () => {
    const root = await fixture({ 'a.txt': 'needle\nNeedle\nNEEDLE\n' });
    try {
      for (const scan of [undefined, 'mock']) {
        const opts = scan === undefined ? { cwd: root } : { cwd: root, scan };
        assert.equal((await search.grepContents('needle', { ...opts, smartCase: true })).total, 3, `lowercase insensitive (${scan ?? 'rg'})`);
        assert.equal((await search.grepContents('Needle', { ...opts, smartCase: true })).total, 1, `uppercase sensitive (${scan ?? 'rg'})`);
        assert.equal((await search.grepContents('needle', opts)).total, 1, `flag off stays sensitive (${scan ?? 'rg'})`);
        assert.equal((await search.grepContents('needle', { ...opts, ignoreCase: true })).total, 3, 'ignoreCase path unchanged');
      }
      const pi = fakePiTwoArg();
      findTools.registerFindTools(pi, { search }, { mode: 'additive' });
      const out = textOf(await pi.tools.get('ffgrep').execute('t', { pattern: 'needle', smartCase: true, cwd: root }));
      assert.match(out, /\(3 matches total\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
