import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search;
before(async () => {
  search = await import(dist('search.js'));
});

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-stress-'));
  for (const [rel, content] of Object.entries(struct)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

describe('stress-core: rg runtime errors fall back to walker (grep + listing)', () => {
  it('fake rg with a numeric exit still serves good matches via walker (simulates unscannable-file exit 2)', async () => {
    // Why process-level simulation: runCmd is module-private (not exported),
    // so the exit-2 path cannot be stubbed by import. A fake `rg` earlier on
    // PATH reproduces exactly what rg does when one unscannable file
    // (trailing-dot name, EACCES, broken symlink/junction, FIFO) trips
    // --no-messages: non-zero exit, no per-file detail. Pre-fix this threw and
    // discarded good matches; post-fix both grep and listing fall back.
    // Platform notes: on POSIX the fake is a shell script exiting 2. On
    // Windows execFile cannot run .cmd/.bat without a shell (verified: a
    // rg.cmd shim is silently skipped and the real rg answers instead), so
    // the fake is a copy of node.exe as rg.exe — rg-style argv is a node
    // "bad option" numeric exit, i.e. the same exit-2 class (any numeric rg
    // exit other than 1 = no-matches) that triggers the fallback.
    const root = await fixture({ 'good.txt': 'hello target world\nsecond line\n' });
    const bin = await mkdtemp(join(tmpdir(), 'omp-find-fakerg-'));
    const prevPath = process.env.PATH ?? '';
    const { execFile } = await import('node:child_process');
    const { copyFileSync, chmodSync } = await import('node:fs');
    const runBare = (args) => new Promise((resolve) => {
      execFile('rg', args, { cwd: root }, (err, stdout) => resolve({ err, stdout: String(stdout ?? '') }));
    });
    try {
      if (process.platform === 'win32') {
        copyFileSync(process.execPath, join(bin, 'rg.exe'));
      } else {
        const p = join(bin, 'rg');
        await writeFile(p, '#!/bin/sh\nexit 2\n');
        chmodSync(p, 0o755);
      }
      process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${prevPath}`;
      // Prove interception before asserting: the fake must answer bare `rg`,
      // not the real binary further down PATH. (A fresh 87MB exe copy can be
      // transiently un-runnable while AV scans it — ENOENT also falls back,
      // but the proof poll retries until the fake itself answers.)
      let intercepted = false;
      for (let i = 0; i < 150; i++) {
        const { err, stdout } = await runBare(['--version']);
        if (process.platform === 'win32') {
          if (!err && stdout.startsWith('v')) { intercepted = true; break; }
          if (!err && stdout.includes('ripgrep')) throw new Error('PATH fake bypassed: real rg answered bare `rg`');
        } else if (err && err.code === 2) { intercepted = true; break; }
        else if (!err) throw new Error(`PATH fake bypassed: bare rg succeeded: ${stdout.slice(0, 60)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(intercepted, 'fake rg intercepts bare `rg` before asserting fallback');
      const grep = await search.grepContents('target', { cwd: root });
      assert.ok(grep.total >= 1, `good matches survive rg failure: ${grep.total}`);
      assert.equal(grep.backend, 'walker', 'grep falls back to walker on numeric rg exit');
      assert.ok(grep.matches.some((m) => m.path.endsWith('good.txt')), 'good.txt hit present');
      const found = await search.findScanned('', { cwd: root });
      assert.equal(found.backend, 'walker', 'listing falls back to walker on numeric rg exit');
      assert.ok(found.paths.some((p) => p.endsWith('good.txt')), 'listing still sees good.txt');
    } finally {
      process.env.PATH = prevPath;
      await cleanup(root);
      await cleanup(bin);
    }
  });

  it('broken-junction fixture never fails the whole grep (real rg exit 2 end-to-end)', async (t) => {
    // A junction/symlink to a missing target makes the installed rg exit 2 on
    // grep argv (verified locally: good matches still on stdout, exit code 2)
    // while --no-messages hides which file tripped it. Junctions need no
    // privilege on Windows; POSIX uses a plain symlink. Skip with a note only
    // when the platform refuses link creation at all.
    const root = await fixture({ 'good.txt': 'hello target world\n' });
    try {
      try {
        if (process.platform === 'win32') await symlink(join(root, 'missing-dir'), join(root, 'badloop'), 'junction');
        else await symlink(join(root, 'missing-target'), join(root, 'bad-link.txt'));
      } catch (err) {
        return t.skip(`link creation unavailable, skipping real-rg unscannable-file probe: ${err.message}`);
      }
      const res = await search.grepContents('target', { cwd: root });
      assert.ok(res.total >= 1, 'good matches present alongside the broken link');
      assert.ok(res.matches.some((m) => m.path.endsWith('good.txt')), 'good.txt hit present');
      const followed = await search.grepContents('target', { cwd: root, followSymlinks: true, scan: 'mock' });
      assert.ok(followed.total >= 1, 'walker follow mode skips the dangling link');
    } finally {
      await cleanup(root);
    }
  });
});
describe('stress-core: walker emits one row per match (rg parity)', () => {
  it('two matches on one line give total=2 with distinct cols on both backends', async () => {
    const root = await fixture({ 'multi.txt': 'foo bar foo\nsecond line\n' });
    try {
      const walker = await search.grepContents('foo', { cwd: root, scan: 'mock' });
      assert.equal(walker.backend, 'walker', 'mock scan serves the walker');
      assert.equal(walker.total, 2, `walker total is per-match: ${walker.total}`);
      assert.equal(walker.matches.length, 2, 'walker page holds both matches');
      assert.notEqual(walker.matches[0].col, walker.matches[1].col, 'cols distinguish the two matches');
      assert.deepEqual(
        walker.matches.map((m) => m.col).sort((a, b) => a - b),
        [1, 9],
        `cols are 1-based offsets into the line: ${walker.matches.map((m) => m.col)}`,
      );
      const live = await search.grepContents('foo', { cwd: root });
      assert.equal(live.total, 2, `rg total agrees: ${live.total}`);
      assert.deepEqual(
        live.matches.map((m) => m.col).sort((a, b) => a - b),
        [1, 9],
        'rg cols agree with the walker',
      );
      const re = await search.grepContents('f.o', { cwd: root, scan: 'mock', literal: false });
      assert.equal(re.total, 2, `regex path is per-match too: ${re.total}`);
      assert.notEqual(re.matches[0].col, re.matches[1].col, 'regex cols distinct');
    } finally {
      await cleanup(root);
    }
  });

  it('callersOf still dedupes by path:line across the extra per-match rows', async () => {
    const root = await fixture({ 'a.js': 'function foo() {}\nfoo(); foo();\n' });
    try {
      const viaMock = await search.callersOf('foo', { cwd: root, scan: 'mock' });
      const viaLive = await search.callersOf('foo', { cwd: root });
      assert.equal(viaMock.total, viaLive.total, `backends agree on caller count: ${viaMock.total} vs ${viaLive.total}`);
      assert.ok(viaMock.total >= 1, 'the shared call line is still one caller row');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-core: symlink cycle guard', () => {
  it('self-loop dir with follow:true resolves instead of burning the budget', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-cycle-'));
    try {
      await mkdir(join(root, 'a'), { recursive: true });
      await writeFile(join(root, 'a', 'a.txt'), 'hello cycle\n');
      try {
        await symlink(root, join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        return t.skip(`symlink privilege unavailable, skipping cycle-guard probe: ${err.message}`);
      }
      const found = await search.findScanned('', { cwd: root, followSymlinks: true });
      assert.ok(found.paths.some((p) => p.endsWith('a.txt')), 'real files still listed through the loop');
      const grep = await search.grepContents('hello', { cwd: root, followSymlinks: true, scan: 'mock', timeoutMs: 10000 });
      assert.ok(grep.total >= 1, 'walker grep resolves through the loop');
      const nofollow = await search.findScanned('', { cwd: root, followSymlinks: false });
      assert.ok(nofollow.paths.some((p) => p.endsWith('a.txt')), 'follow=false still lists real files');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-core: nonexistent cwd is a clean error', () => {
  it('grep/find/callers/map/capsule throw scan root not found', async () => {
    const missing = join(tmpdir(), `omp-find-missing-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    await rm(missing, { recursive: true, force: true });
    await assert.rejects(search.grepContents('x', { cwd: missing }), /scan root not found/);
    await assert.rejects(search.findScanned('', { cwd: missing }), /scan root not found/);
    await assert.rejects(search.callersOf('x', { cwd: missing }), /scan root not found/);
    await assert.rejects(search.rankMap({ cwd: missing }), /scan root not found/);
    await assert.rejects(search.capsuleOf('x', { cwd: missing }), /scan root not found/);
    try {
      await search.grepContents('x', { cwd: missing });
    } catch (err) {
      assert.ok(err.message.includes(missing), `message names the dir: ${err.message}`);
    }
  });

  it('filesystem-root and home refusals still win as-is', async () => {
    const fsRoot = parse(process.cwd()).root;
    await assert.rejects(search.findScanned('', { cwd: fsRoot }), /refusing to scan the filesystem root/);
    await assert.rejects(search.grepContents('x', { cwd: fsRoot }), /refusing to scan the filesystem root/);
  });
});

describe('stress-core: structuralGrep references mode forwards scan', () => {
  it('references:thing with scan:mock serves the walker', async () => {
    const root = await fixture({
      'src/a.ts': 'import { thing } from "./b";\nconsole.log(thing);\n',
      'src/b.ts': 'export function thing() {\n  return 1;\n}\nthing();\n',
    });
    try {
      const refs = await search.structuralGrep('references:thing', { cwd: root, scan: 'mock' });
      assert.equal(refs.backend, 'walker', `mock scan reaches callersOf instead of serving rg: ${refs.backend}`);
      assert.ok(refs.matches.some((m) => m.path.endsWith('a.ts')), 'import/member sites found');
      assert.ok(refs.matches.some((m) => m.text.includes('thing();')), 'call-paren site found');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-core: backslash path filters scope like forward slashes', () => {
  it('capsule pathFilter src\\ behaves as src/ (filter normalized, not just the path)', async () => {
    const root = await fixture({
      'src/a.ts': 'export function thing() {\n  return 1;\n}\nthing();\n',
      'other/b.ts': 'thing();\n',
    });
    try {
      const fwd = await search.capsuleOf('thing', { cwd: root, scan: 'mock', pathFilter: 'src/' });
      const back = await search.capsuleOf('thing', { cwd: root, scan: 'mock', pathFilter: 'src\\' });
      assert.deepEqual(back.callers.map((m) => m.path).sort(), fwd.callers.map((m) => m.path).sort(), 'backslash dir filter scopes like forward slash');
      assert.equal(back.filesInvolved, fwd.filesInvolved, 'files involved agree across slash styles');
      const fwdFile = await search.capsuleOf('thing', { cwd: root, scan: 'mock', pathFilter: 'src/a.ts' });
      const backFile = await search.capsuleOf('thing', { cwd: root, scan: 'mock', pathFilter: 'src\\a.ts' });
      assert.equal(backFile.defFile, fwdFile.defFile, 'backslash file pin finds the same definition');
    } finally {
      await cleanup(root);
    }
  });
});
