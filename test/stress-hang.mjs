import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-hang-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

/** Watchdog: the pre-fix bug hung forever, so a bare await could stall the
 * suite. Rejects past `ms` so the test fails instead of hanging. */
function withWatchdog(promise, ms = 15000) {
  const { promise: wd, reject } = Promise.withResolvers();
  const t = setTimeout(() => reject(new Error(`watchdog: exceeded ${ms}ms`)), ms);
  return Promise.race([promise, wd]).finally(() => clearTimeout(t));
}

const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
};

/** grepContents sorts rows by path/line/col; the raw inline scan does not. */
const byRow = (a, b) => {
  const ap = a.path.replace(/\\/g, '/'), bp = b.path.replace(/\\/g, '/');
  return ap < bp ? -1 : ap > bp ? 1 : a.line - b.line || a.col - b.col;
};

describe('stress-hang: catastrophic regex cannot stall the event loop', () => {
  it('(a|a)*b on a 30KB run rejects with "grep timed out" instead of hanging', async () => {
    // Pre-fix the walker ran the regex inline: re.exec starved the loop and the
    // timeout race could never fire. Post-fix the scan runs in a worker that
    // the deadline terminates. Watchdog (15s) guards the pre-fix hang; the
    // timeout itself must land well under 10s.
    const root = await fixture({ 'big.txt': 'a'.repeat(30 * 1024) });
    try {
      const t0 = Date.now();
      await assert.rejects(
        withWatchdog(search.grepContents('(a|a)*b', { cwd: root, scan: 'mock', literal: false, timeoutMs: 3000 })),
        /grep timed out/,
      );
      assert.ok(Date.now() - t0 < 10000, `timeout fired promptly (${Date.now() - t0}ms)`);
    } finally {
      await cleanup(root);
    }
  });

  it('tool layer: rg runtime failure falls back to the worker scan end-to-end', async (t) => {
    // A junction/symlink to a missing target makes the installed rg exit 2
    // (numeric exit = recoverable → walker fallback → worker regex path).
    // Where rg is absent the same fallback fires via ENOENT, so the tool call
    // is deterministic either way; link creation itself may be refused.
    const root = await fixture({ 'good.txt': 'alpha TOOLMARK one\nbeta TOOLMARK two\n' });
    try {
      try {
        if (process.platform === 'win32') await symlink(join(root, 'missing-dir'), join(root, 'badloop'), 'junction');
        else await symlink(join(root, 'missing-target'), join(root, 'bad-link.txt'));
      } catch (err) {
        return t.skip(`link creation unavailable: ${err.message}`);
      }
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = textOf(await withWatchdog(
        pi.tools.get('ffgrep').execute('t', { pattern: 'TOOLMARK\\s+\\w+', literal: false, cwd: root }),
      ));
      assert.match(out, /TOOLMARK one/, `regex hit via walker fallback:\n${out}`);
      assert.match(out, /\(2 matches total\)/, `both rows counted:\n${out}`);
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-hang: BOM-aware decoding on the walker backend', () => {
  it('UTF-16LE+BOM file matches instead of NUL-skipping (literal + regex)', async () => {
    const root = await fixture({
      'wide.txt': utf16le('first line\nsecond UTF16MARK line\n'),
      'plain.txt': 'UTF16MARK in plain utf8\n',
    });
    try {
      const lit = await search.grepContents('UTF16MARK', { cwd: root, scan: 'mock' });
      assert.equal(lit.total, 2, `literal sees both files:\n${JSON.stringify(lit.matches)}`);
      const wide = lit.matches.find((m) => m.path.endsWith('wide.txt'));
      assert.ok(wide, 'wide.txt hit present');
      assert.equal(wide.line, 2);
      assert.equal(wide.col, 8);
      const rx = await search.grepContents('UTF16MARK', { cwd: root, scan: 'mock', literal: false });
      assert.equal(rx.total, 2, 'regex worker sees both files');
    } finally {
      await cleanup(root);
    }
  });

  it('UTF-16BE+BOM file matches on the walker backend', async () => {
    const root = await fixture({ 'wide-be.txt': utf16be('BE marker UTF16BE here\n') });
    try {
      const res = await search.grepContents('UTF16BE', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 1, `BE file decodes:\n${JSON.stringify(res.matches)}`);
      assert.equal(res.matches[0].line, 1);
    } finally {
      await cleanup(root);
    }
  });

  it('UTF-8 BOM: line-1 match reports col 1 like rg', async () => {
    const root = await fixture({ 'bom.txt': 'BOMMARK rest of line\n' });
    try {
      const res = await search.grepContents('BOMMARK', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 1);
      assert.equal(res.matches[0].line, 1);
      assert.equal(res.matches[0].col, 1, 'BOM stripped before scanning');
      assert.equal(res.matches[0].text, 'BOMMARK rest of line');
    } finally {
      await cleanup(root);
    }
  });
});

describe('stress-hang: literal path stays inline; worker parity', () => {
  it('literal walker scan completes fast with no worker', async () => {
    const root = await fixture({ 'big.txt': 'a'.repeat(30 * 1024) });
    try {
      const t0 = Date.now();
      const res = await search.grepContents('aaa', { cwd: root, scan: 'mock' });
      assert.equal(res.total, 10240, 'indexOf steps by needle length: 30720/3 non-overlapping hits');
      assert.ok(Date.now() - t0 < 5000, `literal scan stayed inline and fast (${Date.now() - t0}ms)`);
    } finally {
      await cleanup(root);
    }
  });

  it('worker regex path returns rows identical to the inline scan', async () => {
    const root = await fixture({
      'a/one.ts': 'const alpha = beta(1);\nconst gamma = beta(2);\n',
      'b/two.ts': 'beta(3) at top\n',
    });
    try {
      const viaWorker = await search.grepContents('beta\\(\\d\\)', { cwd: root, scan: 'mock', literal: false });
      const inline = await search.walkerRegexGrep(root, 'beta\\(\\d\\)', false, false, false, 0, 0, false, undefined);
      assert.deepEqual(inline.sort(byRow), viaWorker.matches, 'worker rows identical to inline rows');
      assert.equal(viaWorker.total, 3);
    } finally {
      await cleanup(root);
    }
  });
});
