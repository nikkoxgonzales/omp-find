import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let search;
before(async () => {
  search = await import(dist('search.js'));
});

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-r4-'));
  for (const [rel, content] of Object.entries(struct)) {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const slash = (p) => p.replace(/\\/g, '/');
const rows = (res) => res.matches.map((m) => `${slash(m.path)}:${m.line}:${m.col}`);

describe('stress-round4: F1 lone-CR lines on rg', () => {
  it('rg parses a vimgrep row whose line text contains a lone \\r', async () => {
    const root = await fixture({ 'cr.txt': 'alpha\rbeta\nplain\n' });
    try {
      const rg = await search.grepContents('beta', { cwd: root });
      assert.equal(rg.backend, 'rg');
      const hit = rg.matches.find((m) => slash(m.path) === 'cr.txt');
      assert.ok(hit, 'rg dropped the lone-CR line');
      assert.equal(hit.line, 1);
      assert.equal(hit.col, 7);
      assert.equal(hit.text, 'alphabeta', 'row text strips \\r like the walker');
      const walker = await search.grepContents('beta', { cwd: root, scan: 'mock' });
      assert.deepEqual(rows(walker), rows(rg), 'walker/rg row parity on lone-CR line');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F2 zero-width matches on walker', () => {
  const FILE = 'abc\n\nxyz\n';
  it('^ emits one row per line', async () => {
    const root = await fixture({ 'e.txt': FILE });
    try {
      const res = await search.grepContents('^', { cwd: root, scan: 'mock', literal: false });
      assert.deepEqual(rows(res), ['e.txt:1:1', 'e.txt:2:1', 'e.txt:3:1']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('^$ emits a row on the empty line only', async () => {
    const root = await fixture({ 'e.txt': FILE });
    try {
      const res = await search.grepContents('^$', { cwd: root, scan: 'mock', literal: false });
      assert.deepEqual(rows(res), ['e.txt:2:1']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('z* emits a row at every position', async () => {
    const root = await fixture({ 'e.txt': FILE });
    try {
      const res = await search.grepContents('z*', { cwd: root, scan: 'mock', literal: false });
      assert.deepEqual(rows(res), [
        'e.txt:1:1', 'e.txt:1:2', 'e.txt:1:3', 'e.txt:1:4',
        'e.txt:2:1',
        'e.txt:3:1', 'e.txt:3:2', 'e.txt:3:3', 'e.txt:3:4',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F3 wholeWord on punctuation-edged patterns', () => {
  const FILE = 'cat. dog\na.cat here\nxcat. and .catx\ncat.x\n.cat\n';
  for (const scan of [undefined, 'mock']) {
    it(`wholeWord 'cat.' matches like rg -w (scan=${scan ?? 'rg'})`, async () => {
      const root = await fixture({ 'w.txt': FILE });
      try {
        const res = await search.grepContents('cat.', { cwd: root, scan, wholeWord: true });
        assert.deepEqual(rows(res), ['w.txt:1:1']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it(`wholeWord '.cat' matches like rg -w (scan=${scan ?? 'rg'})`, async () => {
      const root = await fixture({ 'w.txt': FILE });
      try {
        const res = await search.grepContents('.cat', { cwd: root, scan, wholeWord: true });
        assert.deepEqual(rows(res), ['w.txt:5:1']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe('stress-round4: F4 literal ignoreCase does not over-match', () => {
  const FILE = 'istanbul\nİstanbul\nI STANBUL\n';
  for (const scan of [undefined, 'mock']) {
    it(`ignoreCase 'I' skips Turkish İ (scan=${scan ?? 'rg'})`, async () => {
      const root = await fixture({ 't.txt': FILE });
      try {
        const res = await search.grepContents('I', { cwd: root, scan, ignoreCase: true });
        assert.deepEqual(rows(res), ['t.txt:1:1', 't.txt:3:1'], 'İ (U+0130) must not fold to i');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe('stress-round4: F5 capsule finds defs beyond top-30 mention files', () => {
  it('definition-shaped grep seeds candidate files', async () => {
    const struct = { 'lib.ts': 'export function thing() { return 1; }\n' };
    for (let i = 1; i <= 35; i++) struct[`many/f${i}.ts`] = 'import { thing } from "./lib";\nthing(); thing(); thing();\n';
    const root = await fixture(struct);
    try {
      const cap = await search.capsuleOf('thing', { cwd: root, scan: 'mock' });
      assert.equal(cap.found, true);
      assert.equal(slash(cap.defFile ?? ''), 'lib.ts', `def outside top-30 mentions: ${cap.defFile}`);
      assert.equal(cap.defLine, 1);
      assert.equal(cap.defKind, 'function');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F6 symbols starting with non-word chars', () => {
  const FILE = 'const $foo = () => 1;\nimport { $foo } from "./d";\n$foo();\nconst $fooBar = 2;\n';
  it("callersOf('$foo') finds import + call sites", async () => {
    const root = await fixture({ 'dollar.ts': FILE });
    try {
      const res = await search.callersOf('$foo', { cwd: root, scan: 'mock' });
      const texts = res.matches.map((m) => `${m.line}:${m.text}`);
      assert.ok(texts.some((t) => t.includes('import { $foo }')), `import row: ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.includes('$foo();')), `call row: ${JSON.stringify(texts)}`);
      assert.ok(!texts.some((t) => t.includes('$fooBar')), '$fooBar is a different identifier');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("capsuleOf('$foo') resolves the definition", async () => {
    const root = await fixture({ 'dollar.ts': FILE });
    try {
      const cap = await search.capsuleOf('$foo', { cwd: root, scan: 'mock' });
      assert.equal(cap.found, true);
      assert.equal(slash(cap.defFile ?? ''), 'dollar.ts');
      assert.equal(cap.defLine, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F9 no phantom context row past EOF', () => {
  it('context=5 on a 3-line file yields only real lines', async () => {
    const root = await fixture({ 'short.txt': 'l1\nl2\nl3\n' });
    try {
      const res = await search.grepContents('l2', { cwd: root, scan: 'mock', contextBefore: 5, contextAfter: 5 });
      const m = res.matches.find((x) => slash(x.path) === 'short.txt');
      assert.deepEqual(m.before, ['l1']);
      assert.deepEqual(m.after, ['l3'], 'trailing-newline phantom row must not appear');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: GREP_CAP parity across backends', () => {
  it('rg caps at 20000 and sets the capped flag', async () => {
    const root = await fixture({ 'big.txt': 'hit\n'.repeat(21000) });
    try {
      const res = await search.grepContents('hit', { cwd: root });
      assert.equal(res.backend, 'rg');
      assert.equal(res.total, 20000);
      assert.equal(res.capped, true);
      const walker = await search.grepContents('hit', { cwd: root, scan: 'mock' });
      assert.equal(walker.total, 20000);
      assert.equal(walker.capped, true);
      const small = await search.grepContents('hit', { cwd: root, scan: 'mock', limit: 5 });
      assert.equal(small.capped, true, 'cap flag is about the match set, not the page');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uncapped results carry no capped flag', async () => {
    const root = await fixture({ 'a.txt': 'hit\nhit\n' });
    try {
      const res = await search.grepContents('hit', { cwd: root });
      assert.equal(res.total, 2);
      assert.ok(!res.capped);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F11 .git pointer file skipped', () => {
  it('a .git FILE (linked worktree) is never listed', async () => {
    const root = await fixture({ '.git': 'gitdir: /nonexistent\n', 'real.txt': 'x\n' });
    try {
      const res = await search.findScanned('', { cwd: root, scan: 'mock' });
      assert.ok(!res.paths.some((p) => slash(p).endsWith('.git') || slash(p).includes('.git/')), `paths: ${res.paths}`);
      assert.ok(res.paths.some((p) => slash(p).endsWith('real.txt')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: F8 bare-repo git:modified message', () => {
  it('bare repo reports needs-a-worktree, plain dir reports requires-a-repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-r4-bare-'));
    try {
      const bare = join(root, 'bare.git');
      execFileSync('git', ['init', '--bare', bare]);
      await assert.rejects(
        search.findPaths('git:modified', { cwd: bare, scan: 'mock' }),
        /needs a worktree \(bare repository\)/,
      );
      const plain = join(root, 'plain');
      await mkdir(plain);
      await assert.rejects(
        search.findPaths('git:modified', { cwd: plain, scan: 'mock' }),
        /requires a git repository/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stress-round4: worker unicode property escapes', () => {
  it('\\p{Lu}+ matches uppercase runs on the walker', async () => {
    const root = await fixture({ 'u.txt': 'const ABC = 1;\nlower\n' });
    try {
      const res = await search.grepContents('\\p{Lu}+', { cwd: root, scan: 'mock', literal: false });
      assert.deepEqual(rows(res), ['u.txt:1:7'], `walker rows: ${JSON.stringify(rows(res))}`);
      const rg = await search.grepContents('\\p{Lu}+', { cwd: root, literal: false });
      assert.deepEqual(rows(res), rows(rg), 'walker/rg parity for \\p{Lu}+');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
