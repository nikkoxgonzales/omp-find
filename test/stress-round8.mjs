import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let frecency;
before(async () => {
  frecency = await import(dist('frecency.js'));
});

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

/** Run fn with the frecency store isolated to a fresh temp LOCALAPPDATA. */
async function isolated(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-r8-'));
  // recordOpen stats the resolved path: each test runs from a scratch cwd
  // (dir/work) holding a proj/ dir so recorded proj/* files can exist.
  const work = join(dir, 'work');
  await mkdir(join(work, 'proj'), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(work);
  try {
    return await withEnv({ LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir }, () => fn(dir));
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function storedEntries() {
  const raw = await readFile(frecency.storePath(process.cwd()), 'utf8');
  return (JSON.parse(raw)).entries ?? {};
}

describe('stress-round8: frecency key canonicalization', () => {
  it('read-style `abs:line-range` records the plain file; relative score hits it', async () => {
    await isolated(async () => {
      await frecency.clear();
      const abs = join(process.cwd(), 'proj', 'x.ts').replace(/\\/g, '/');
      await writeFile(abs, 'x');
      await frecency.recordOpen(`${abs}:10-20`);
      assert.ok((await frecency.score('proj/x.ts')) > 0, 'selector stripped + relativized');
      assert.ok((await frecency.score(abs)) > 0, 'absolute score hits the same key');
      const entries = await storedEntries();
      assert.deepEqual(Object.keys(entries), ['proj/x.ts'], `stored cwd-relative: ${JSON.stringify(entries)}`);
    });
  });

  it('non-file tool URIs record nothing and score 0', async () => {
    await isolated(async () => {
      await frecency.clear();
      for (const uri of ['xd://ffgrep', 'xd://fffind', 'artifact://abc', 'agent://a1',
        'local://plan.md', 'skill://frontend-design', 'history://h1', 'issue://3',
        'https://example.com/x.ts', 'ssh://host/path', 'omp://docs']) {
        await frecency.recordOpen(uri);
        assert.equal(await frecency.score(uri), 0, `${uri} scores 0`);
      }
      const entries = await storedEntries();
      assert.deepEqual(Object.keys(entries), [], `no noise stored: ${JSON.stringify(entries)}`);
    });
  });

  it('relative and absolute spellings of one file share a single key', async () => {
    await isolated(async () => {
      await frecency.clear();
      const abs = join(process.cwd(), 'proj', 'x.ts');
      await writeFile(abs, 'x');
      await frecency.recordOpen('proj/x.ts');
      await frecency.recordOpen(abs);
      await frecency.recordOpen(abs.replace(/\\/g, '/'));
      const entries = await storedEntries();
      assert.deepEqual(Object.keys(entries), ['proj/x.ts'], `one key: ${JSON.stringify(entries)}`);
      assert.equal(entries['proj/x.ts'].count, 3, 'all three spellings bumped one entry');
    });
  });

  it('`?q=`, `#tag`, `:raw`, `:img`, `:conflicts`, `:N+M` spellings all hit the plain key', async () => {
    await isolated(async () => {
      await frecency.clear();
      await writeFile('proj/y.ts', 'x');
      await writeFile('proj/z.ts', 'x');
      await frecency.recordOpen('proj/y.ts');
      for (const p of ['proj/y.ts?q=what', 'proj/y.ts#A1B2', 'proj/y.ts:raw',
        'proj/y.ts:img', 'proj/y.ts:conflicts', 'proj/y.ts:50+150',
        'proj/y.ts:raw:2-4', 'proj/y.ts:-60']) {
        assert.ok((await frecency.score(p)) > 0, `${p} scores the plain key`);
      }
      // selectors on the record side collapse too
      await frecency.recordOpen('proj/z.ts:5-16,960-973');
      assert.ok((await frecency.score('proj/z.ts')) > 0, 'record-side range stripped');
    });
  });

  it('file:// URIs unwrap to their filesystem path', async () => {
    await isolated(async () => {
      await frecency.clear();
      const abs = join(process.cwd(), 'proj', 'f.ts');
      await writeFile(abs, 'x');
      await frecency.recordOpen(pathToFileURL(abs).href);
      assert.ok((await frecency.score('proj/f.ts')) > 0, 'file:// unwrapped + relativized');
    });
  });

  it('a drive-letter colon is not a selector; outside-cwd paths stay absolute', async () => {
    await isolated(async (dir) => {
      await frecency.clear();
      // `X:/x.ts:10` — the drive prefix must survive stripping; the file lives
      // outside the scratch cwd so the key stays absolute.
      const outside = join(dir, 'outside-r8', 'x.ts');
      await mkdir(join(dir, 'outside-r8'), { recursive: true });
      await writeFile(outside, 'x');
      const outsideFwd = outside.replace(/\\/g, '/');
      await frecency.recordOpen(`${outsideFwd}:10`);
      assert.ok((await frecency.score(outsideFwd)) > 0, 'drive colon survived');
      const entries = await storedEntries();
      const keys = Object.keys(entries);
      assert.equal(keys.length, 1);
      assert.ok(keys[0].endsWith('/outside-r8/x.ts'), `absolute key kept: ${keys[0]}`);
      assert.ok(!keys[0].includes('..'), `not relativized outside cwd: ${keys[0]}`);
    });
  });
});
