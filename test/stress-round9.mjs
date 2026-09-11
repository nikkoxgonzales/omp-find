import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, stat } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let frecency, search, findTools;
before(async () => {
  frecency = await import(dist('frecency.js'));
  search = await import(dist('search.js'));
  findTools = await import(dist('tools.js'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const kinds = (res) => res.symbols.map((s) => `${s.kind} ${s.name}`);

function fakePi() {
  const tools = new Map();
  return {
    tools,
    registerTool(nameOrDef, maybeDef) {
      if (typeof nameOrDef === 'object' && nameOrDef !== null) tools.set(nameOrDef.name, nameOrDef);
      else tools.set(nameOrDef, maybeDef);
    },
  };
}

async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    process.env[k] = vars[k];
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

/** Frecency store isolated to a fresh temp LOCALAPPDATA; `dir` doubles as the
 * fixture root for real files recordOpen must stat. */
async function isolated(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-find-r9-'));
  try {
    return await withEnv({ LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir }, () => fn(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function storedEntries() {
  const raw = await readFile(frecency.storePath(process.cwd()), 'utf8');
  return (JSON.parse(raw)).entries ?? {};
}

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r9fx-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

describe('stress-round9: frecency cross-process lock', () => {
  it('a stale readDisk landing last cannot clobber a committed bump', async () => {
    await isolated(async (dir) => {
      // Second module instance = second process: own cache + write queue.
      const frecencyB = await import(`${dist('frecency.js')}?proc=r9B`);
      const target = join(dir, 'shared.ts');
      const bOnly = join(dir, 'b-only.ts');
      await writeFile(target, 'x');
      await writeFile(bOnly, 'x');
      await frecency.clear();

      // B's cache holds a marker key; its save is slowed via a one-shot
      // copyFile patch so its (stale) write lands AFTER A's commits.
      await frecencyB.recordOpen(bOnly);
      const origCopy = fs.promises.copyFile;
      let slowed = false;
      fs.promises.copyFile = async (src, dest, mode) => {
        let snap = null;
        try {
          if (!slowed && String(src).includes('.tmp.')) {
            const body = await readFile(src, 'utf8');
            if (body.includes('b-only.ts')) { slowed = true; snap = body; }
          }
        } catch { /* tmp vanished — just copy */ }
        if (snap !== null) {
          // A real second process has its own tmp.<pid>; in-process both
          // instances share one name and A's saves would clobber it. Snapshot
          // B's bytes now and land them late — exactly what a delayed
          // cross-process copyFile does.
          await sleep(80);
          await fs.promises.writeFile(dest, snap);
          return;
        }
        return origCopy.call(fs.promises, src, dest, mode);
      };
      try {
        const bSave = frecencyB.recordOpen(target); // B reads disk pre-A, writes last
        await sleep(30); // let B reach its (slowed) copyFile
        await frecency.recordOpen(target); // A commits count 1 while B sleeps
        await frecency.recordOpen(target); // A commits count 2
        await bSave;
      } finally {
        fs.promises.copyFile = origCopy;
      }
      const entries = await storedEntries();
      const key = Object.keys(entries).find((k) => k.endsWith('shared.ts'));
      assert.ok(key, `shared.ts recorded: ${JSON.stringify(entries)}`);
      assert.ok(entries[key].count >= 2,
        `A's committed bumps survive B's stale write (got ${entries[key].count})`);
      assert.ok(Object.keys(entries).some((k) => k.endsWith('b-only.ts')), 'B batch persisted');
    });
  });

  it('a stale lock dir (mtime > 5s) is stolen and the save lands', async () => {
    await isolated(async (dir) => {
      const target = join(dir, 'stale.ts');
      await writeFile(target, 'x');
      await frecency.clear();
      const file = frecency.storePath(process.cwd());
      await mkdir(`${file}.lock`, { recursive: true });
      const old = new Date(Date.now() - 10_000);
      await utimes(`${file}.lock`, old, old);
      await frecency.recordOpen(target);
      const entries = await storedEntries();
      assert.ok(Object.keys(entries).some((k) => k.endsWith('stale.ts')),
        `save stole the stale lock: ${JSON.stringify(entries)}`);
      await stat(`${file}.lock`).then(
        () => assert.fail('lock dir left behind'),
        () => undefined,
      );
    });
  });

  it('a live lock times out into a skipped save — never throws', async () => {
    await isolated(async (dir) => {
      const target = join(dir, 'blocked.ts');
      await writeFile(target, 'x');
      await frecency.clear();
      const file = frecency.storePath(process.cwd());
      await mkdir(`${file}.lock`, { recursive: true }); // fresh mtime: live holder
      const t0 = Date.now();
      await frecency.recordOpen(target); // ~2s lock wait, then unlocked fallback
      const waited = Date.now() - t0;
      const entries = await storedEntries();
      assert.ok(!Object.keys(entries).some((k) => k.endsWith('blocked.ts')),
        `unlocked fallback still persisted: ${JSON.stringify(entries)}`);
      assert.ok(waited >= 1500, `lock wait happened (${waited}ms)`);
      await rm(`${file}.lock`, { recursive: true, force: true });
    });
  });

  it('a file at the lock path means no locking — save gives up without writing', async () => {
    await isolated(async (dir) => {
      const target = join(dir, 'nolock.ts');
      await writeFile(target, 'x');
      await frecency.clear();
      const file = frecency.storePath(process.cwd());
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.lock`, 'not a dir'); // mkdir can never succeed here
      const t0 = Date.now();
      await frecency.recordOpen(target);
      assert.ok(Date.now() - t0 < 1500, 'giveup is instant, no 2s wait');
      const entries = await storedEntries();
      assert.ok(!Object.keys(entries).some((k) => k.endsWith('nolock.ts')),
        `unlocked save persisted: ${JSON.stringify(entries)}`);
    });
  });
});

describe('stress-round9: recordOpen only counts real files', () => {
  it('directory reads and phantom paths record nothing; real files do', async () => {
    await isolated(async (dir) => {
      await frecency.clear();
      const real = join(dir, 'real.ts');
      await writeFile(real, 'x');
      await frecency.recordOpen(dir); // a directory listing is not a file open
      await frecency.recordOpen(join(dir, 'ghost.ts')); // stat fails — phantom
      await frecency.recordOpen(real);
      const entries = await storedEntries();
      const keys = Object.keys(entries);
      assert.equal(keys.length, 1, `only the real file recorded: ${JSON.stringify(entries)}`);
      assert.ok(keys[0].endsWith('real.ts'), keys[0]);
      assert.equal(await frecency.score(dir), 0, 'directory scores 0');
    });
  });
});

describe('stress-round9: outline fixes', () => {
  it('sync/async generator methods list at depth 1 (not eaten as JSDoc)', async () => {
    const root = await fixture({
      'g.ts': [
        'class C {',
        '  /**',
        '   * doc line',
        '   */',
        '  *gen() { yield 1; }',
        '  async *agen() { yield 2; }',
        '  * spaced() { yield 3; }',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const d1 = kinds(await search.outlineFile('g.ts', { cwd: root, depth: 1 }));
      for (const want of ['method gen', 'method agen', 'method spaced']) {
        assert.ok(d1.includes(want), `${want} missing:\n${d1.join('\n')}`);
      }
      assert.ok(!d1.some((k) => /doc line/.test(k)), `JSDoc still skipped:\n${d1.join('\n')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Rust `pub fn new` lists — blocklist only gates heuristic rules', async () => {
    const root = await fixture({
      'r.rs': 'impl Foo {\n    pub fn new() -> Foo { Foo }\n    pub fn build(&self) {}\n}\n',
    });
    try {
      const d1 = kinds(await search.outlineFile('r.rs', { cwd: root, depth: 1 }));
      assert.ok(d1.includes('fn new'), `pub fn new dropped:\n${d1.join('\n')}`);
      assert.ok(d1.includes('fn build'), d1.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Java `public Foo()` is a ctor, not a method', async () => {
    const root = await fixture({
      'J.java': 'public class Foo {\n    public Foo() {}\n    public void bar() {}\n}\n',
    });
    try {
      const d1 = kinds(await search.outlineFile('J.java', { cwd: root, depth: 1 }));
      assert.ok(d1.includes('ctor Foo'), `ctor mislabeled:\n${d1.join('\n')}`);
      assert.ok(!d1.includes('method Foo'), `ctor leaked as method:\n${d1.join('\n')}`);
      assert.ok(d1.includes('method bar'), d1.join('\n'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Kotlin `sealed class` lists via GENERIC modifier prefixes', async () => {
    const root = await fixture({
      'k.kt': 'sealed class Result\ndata class User(val id: Int)\ninternal class Repo\n',
    });
    try {
      const d0 = kinds(await search.outlineFile('k.kt', { cwd: root }));
      for (const want of ['class Result', 'class User', 'class Repo']) {
        assert.ok(d0.includes(want), `${want} missing:\n${d0.join('\n')}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round9: structural match-everything guard', () => {
  it('$$$ and friends throw a clean error instead of flooding', async () => {
    for (const pat of ['$$$', '$$$A', 'inside: x >> $$$', 'has: $$$ << y']) {
      assert.throws(() => search.compileStructural(pat), /matches everything/, pat);
      await assert.rejects(search.structuralGrep(pat, { scan: 'mock' }), /matches everything/, pat);
    }
    // a literal atom anywhere keeps the pattern legal
    assert.ok(search.compileStructural('f($$$)').regex.length > 0);
  });

  it('ffstructural surfaces it as "<tool> failed:"', async () => {
    const pi = fakePi();
    findTools.registerFindTools(pi, { search, frecency: { score: async () => 0, recordOpen: async () => {} } }, { mode: 'additive' });
    const out = textOf(await pi.tools.get('ffstructural').execute('t', { pattern: '$$$' }));
    assert.match(out, /^ffstructural failed: structural "\$\$\$" matches everything/, out);
  });
});
