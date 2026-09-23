import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let jfind, judge, tools, commands, context, search;
before(async () => {
  jfind = await import(dist('jfind.js'));
  judge = await import(dist('judge.js'));
  tools = await import(dist('tools.js'));
  commands = await import(dist('commands.js'));
  context = await import(dist('context.js'));
  search = await import(dist('search.js'));
});

// ── env helpers ──────────────────────────────────────────────────────────────
const ENV_KEYS = ['OMP_FIND_JUDGE_URL', 'JEGREP_ENDPOINT_URL', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'OMP_FIND_JUDGE_MODEL'];
const savedEnv = {};
before(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function fakePi() {
  const tools = new Map();
  return { tools, registerTool(tool) { tools.set(tool.name, tool); } };
}
const textOf = (out) => out?.content?.[0]?.text ?? String(out);

async function fixture(struct) {
  const root = await mkdtemp(join(tmpdir(), 'omp-find-jfind-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

/** Local SystemOne wire mock. handler(req, res, body) for full control. */
async function startServer(handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* malformed body → handler sees {} */ }
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Judge stub answering noul from request shape: name → by name, verify → by content + file, sketch → by sketch. */
function stubJudge(gradeName = () => 0.9, gradeSketch = () => 0.9, gradeVerify = () => 0.9) {
  const calls = [];
  return {
    label: 'stub',
    calls,
    async judge(req) {
      calls.push(req);
      const answers = {};
      for (const key of Object.keys(req.questions)) {
        let noul = 0.5;
        if (req.state.tree !== undefined) {
          noul = gradeName(req, key);
        } else if (req.state.file !== undefined) {
          noul = gradeVerify(req, key);
        } else if (req.state.passages !== undefined) {
          noul = gradeSketch(req, key);
        }
        answers[key] = { type: 'noul', noul };
      }
      return { answers, usage: { input: 10, output: 1, cost: { total: 10 * judge.USD_PER_INPUT_TOKEN } } };
    },
  };
}

/** Deterministic target line for fixtures: ~90 bytes, always keyword-bearing. */
const targetLine = (i) => `${String(i).padStart(3, '0')} retry budget counting ${'x'.repeat(60)}\n`;
const targetFile = (lines) => Array.from({ length: lines }, (_, i) => targetLine(i)).join('');

describe('jfind: query keywords', () => {
  it('keeps quoted phrases whole, stems tokens, drops stopwords and digits', () => {
    const kws = jfind.keywords('how the Retry Budget gets compacted, "exact phrase"', ['Retry']);
    assert.ok(kws.includes('exact phrase'), 'quoted phrase stays whole');
    assert.ok(kws.includes('retry'), 'base token');
    assert.ok(kws.includes('budget'), 'base token');
    assert.ok(kws.includes('compact'), 'stemmed token');
    assert.ok(!kws.includes('compacted'), 'no inflected form');
    assert.ok(!kws.includes('gets') && !kws.includes('how') && !kws.includes('the'), 'stopwords dropped');
    assert.ok(!kws.includes('42'), 'digits dropped');
    assert.equal(kws.filter((k) => k === 'retry').length, 1, 'deduplicated');
  });

  it('unclosed quotes flow back as tokens', () => {
    const kws = jfind.keywords('retry "budget', []);
    assert.ok(kws.includes('budget'), 'unclosed phrase still yields its token');
    assert.ok(kws.includes('retry'));
  });
});

describe('jfind: lexical prior', () => {
  it('idf clamps to [0.5, 6] on rare and ubiquitous terms', () => {
    // 100 files: 'rare' in exactly one (df=1), 'everywhere' in all 100 (df=100), 'mid' in 50.
    const perFileKw = new Map();
    for (let i = 0; i < 100; i++) {
      perFileKw.set(`f${i}.ts`, [
        i === 0 ? 1 : 0,
        3,
        i % 2 === 0 ? 1 : 0,
      ]);
    }
    const weights = jfind.idf({ keywords: ['rare', 'everywhere', 'mid'], perFileKw, filesScanned: 100 });
    assert.equal(weights[1], 0.5, 'ubiquitous term clamps to the 0.5 floor');
    assert.equal(weights[0], Math.min(6, Math.max(0.5, Math.log(101 / 2))), 'rare term inside the clamp');
    assert.ok(weights[2] > 0.5, 'mid-frequency term above the floor');
  });

  it('fileScore: rare terms weigh more, path mentions add two log-units', () => {
    const weights = [2, 1];
    const zero = jfind.fileScore([0, 0], weights, 'plain.ts', ['retry', 'budget']);
    assert.equal(zero, 0);
    const inPath = jfind.fileScore([0, 0], weights, 'retry.ts', ['retry', 'budget']);
    assert.equal(inPath, 4, 'path keyword = 2 extra log-units × weight');
    const withHits = jfind.fileScore([9, 0], weights, 'plain.ts', ['retry', 'budget']);
    assert.equal(withHits, 2 * Math.log1p(9));
  });
});

describe('jfind: byte-bounded text primitives', () => {
  it('lines: Rust str::lines semantics', () => {
    assert.deepEqual(jfind.lines('a\r\nb\nc'), ['a', 'b', 'c']);
    assert.deepEqual(jfind.lines('a\n'), ['a']);
    assert.deepEqual(jfind.lines(''), []);
  });

  it('clipBytes never splits a code point', () => {
    const s = 'aé中word';
    assert.equal(jfind.clipBytes(s, 1), 'a');
    assert.equal(jfind.clipBytes(s, 2), 'a', '2 bytes hold only "a" (é is 2 bytes)');
    assert.equal(jfind.clipBytes(s, 3), 'aé');
    assert.equal(jfind.clipBytes(s, 6), 'aé中');
    assert.equal(jfind.clipBytes(s, 100), s);
  });

  it('takeChars counts code points, not bytes', () => {
    assert.equal(jfind.takeChars('aé中', 2), 'aé');
    assert.equal(jfind.takeChars('abc', 99), 'abc');
  });

  it('readText: binary, empty, io, truncation at last newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-text-'));
    try {
      await writeFile(join(root, 'bin.zzz'), Buffer.from([0x68, 0x69, 0x00, 0x62]));
      await writeFile(join(root, 'empty.zzz'), '');
      await writeFile(join(root, 'noeol.zzz'), 'abc');
      await writeFile(join(root, 'ok.zzz'), 'l1\nl2\nl3');
      const big = 'x'.repeat(40) + '\n' + 'y'.repeat(40) + '\n' + 'z'.repeat(40) + '\n';
      await writeFile(join(root, 'big.zzz'), big);
      await assert.rejects(jfind.readText(join(root, 'bin.zzz'), 1 << 20), (e) => e instanceof jfind.ReadTextError && e.kind === 'binary');
      await assert.rejects(jfind.readText(join(root, 'empty.zzz'), 1 << 20), (e) => e instanceof jfind.ReadTextError && e.kind === 'empty');
      await assert.rejects(jfind.readText(join(root, 'missing.zzz'), 1 << 20), (e) => e instanceof jfind.ReadTextError && e.kind === 'io');
      const truncated = await jfind.readText(join(root, 'big.zzz'), 50);
      assert.equal(truncated.truncated, true);
      assert.equal(truncated.text, `${'x'.repeat(40)}\n`);
      const full = await jfind.readText(join(root, 'ok.zzz'), 1 << 20);
      assert.equal(full.truncated, false);
      assert.equal(full.text, 'l1\nl2\nl3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('jfind: passages', () => {
  const kws = ['retry'];
  const weights = [2];

  it('windows cut whole lines with real line ids and clip oversized lines', () => {
    const ps = jfind.windows('aa\nbbbbbbbbbb\ncc\n', 10, kws, weights);
    assert.deepEqual(ps.map((p) => [p.start, p.end]), [[1, 1], [2, 2], [3, 3]]);
    assert.equal(ps[1].text, 'L2| bbbbb\n', 'the opening line of a window is clipped to the remaining budget');
    const huge = 'w'.repeat(100);
    const one = jfind.windows(`${huge}\nzz\n`, 12, kws, weights);
    assert.equal(one[0].end, 1);
    assert.ok(one[0].text.startsWith('L1| '), 'single oversized line keeps its real line id');
    assert.ok(Buffer.byteLength(one[0].text) <= 12 + 8, 'clipped window stays near budget');
  });

  it('windows score by keyword weight × log1p count', () => {
    const ps = jfind.windows('nothing here\nretry retry retry\n', 30, kws, weights);
    assert.deepEqual(ps.map((p) => p.start), [1, 2]);
    assert.equal(ps[0].score, 0);
    assert.equal(ps[1].score, 2 * Math.log1p(3));
  });

  it('selectWindows keeps strongest; all-zero distributes evenly', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ start: i + 1, end: i + 1, text: '', score: i }));
    const kept = jfind.selectWindows(many, 3);
    assert.deepEqual(kept.map((p) => p.start), [8, 9, 10], 'strongest kept, file order');
    const zeros = Array.from({ length: 10 }, (_, i) => ({ start: i + 1, end: i + 1, text: '', score: 0 }));
    const spread = jfind.selectWindows(zeros, 3);
    assert.deepEqual(spread.map((p) => p.start), [1, 5, 10], 'even coverage over the file');
    assert.deepEqual(jfind.selectWindows(many, 10).map((p) => p.start), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('plainContent strips the L<n>| tags', () => {
    const p = { start: 7, end: 8, text: 'L7| alpha\nL8| beta\n', score: 0 };
    assert.equal(jfind.plainContent(p), 'alpha\nbeta\n');
  });

  it('sketch emits verbatim `<line>: text` rows in file order within budget', () => {
    const passage = {
      start: 10,
      end: 13,
      text: 'L10| retry budget = 3\nL11|   \nL12| other code\nL13| retry deep()\n',
      score: 1,
    };
    const sk = jfind.sketch(passage, kws, weights, 60);
    const rows = sk.split('\n');
    assert.deepEqual(rows, ['10: retry budget = 3', '13: retry deep()'], 'keyword lines ranked, file order, blanks skipped, budget respected');
    const tiny = jfind.sketch(passage, kws, weights, 8);
    assert.equal(tiny, '', 'budget below one line yields nothing');
  });

  it('mergeHeat unions adjacent spans, keeps max p, strongest first', () => {
    const heat = [
      { start: 5, end: 8, p: 0.6, snippet: 'a' },
      { start: 9, end: 12, p: 0.9, snippet: 'b' },
      { start: 20, end: 22, p: 0.7, snippet: 'c' },
      { start: 30, end: 29, p: 0.99, snippet: 'd' },
      { start: 40, end: 41, p: 0.05, snippet: 'e' },
    ];
    const merged = jfind.mergeHeat(heat, 0.2);
    assert.deepEqual(merged, [
      { start: 5, end: 12, p: 0.9, snippet: 'a' },
      { start: 20, end: 22, p: 0.7, snippet: 'c' },
    ], 'adjacent merge takes max p; invalid and sub-threshold dropped');
  });

  it('rankedHeat: strongest first, then earliest, capped', () => {
    const heat = [
      { start: 1, end: 2, p: 0.5, snippet: 'a' },
      { start: 9, end: 9, p: 0.9, snippet: 'b' },
      { start: 5, end: 5, p: 0.9, snippet: 'c' },
      { start: 3, end: 3, p: 0, snippet: 'd' },
    ];
    assert.deepEqual(jfind.rankedHeat(heat, 2), [
      { start: 5, end: 5, p: 0.9, snippet: 'c' },
      { start: 9, end: 9, p: 0.9, snippet: 'b' },
    ]);
  });
});

describe('jfind: eligibility + tree', () => {
  it('eligibleFile denies build dirs, lockfiles, binaries, and secrets — even hidden ones', () => {
    assert.equal(jfind.eligibleFile('src/a.ts', 10, false), true);
    assert.equal(jfind.eligibleFile('node_modules/x.js', 10, false), false);
    assert.equal(jfind.eligibleFile('target/debug/a', 10, false), false);
    assert.equal(jfind.eligibleFile('Cargo.lock', 10, false), false);
    assert.equal(jfind.eligibleFile('logo.png', 10, false), false);
    assert.equal(jfind.eligibleFile('.env', 10, true), false, 'credential files never listed');
    assert.equal(jfind.eligibleFile('id_rsa', 10, true), false);
    assert.equal(jfind.eligibleFile('server.pem', 10, true), false);
    assert.equal(jfind.eligibleFile('.env.local', 10, true), false, '.env.* variants are secrets');
    assert.equal(jfind.eligibleFile('.env.example', 10, true), true, 'committed template allowed');
    assert.equal(jfind.eligibleFile('.env.example', 10, false), false, 'hidden stays hidden unless included');
    assert.equal(jfind.eligibleFile('empty.ts', 0, false), false, 'zero-size files never listed');
  });

  it('humanSize renders B/KB tiers', () => {
    assert.equal(jfind.humanSize(3), '3 B');
    assert.equal(jfind.humanSize(1024), '1.0 KB');
    assert.equal(jfind.humanSize(2048), '2.0 KB');
  });

  it('renderTree folds single-child chains, tags files, blanks around headers', () => {
    const entries = [
      { path: 'a.md', rel: 'a.md', size: 3 },
      { path: 'b.md', rel: 'b.md', size: 5 },
      { path: 'src/x.ts', rel: 'src/x.ts', size: 1024 },
      { path: 'src/sub/y.ts', rel: 'src/sub/y.ts', size: 2048 },
    ];
    const out = jfind.renderTree(entries, (i) => `e${String(i).padStart(3, '0')}`);
    assert.equal(out, [
      '# e000 a.md (3 B)',
      '',
      '# e001 b.md (5 B)',
      '',
      '# src/',
      '## e002 x.ts (1.0 KB)',
      '',
      '## sub/',
      '### e003 y.ts (2.0 KB)',
      '',
    ].join('\n'));
  });

  it('renderTree folds a pure single-child dir chain into one header', () => {
    const entries = [{ path: 'p/q/r/s.ts', rel: 'p/q/r/s.ts', size: 1 }];
    const out = jfind.renderTree(entries, (i) => `e${i}`);
    assert.equal(out, '# p/q/r/\n## e0 s.ts (1 B)\n');
  });
});

describe('jfind: judgment requests', () => {
  const entries = [
    { path: 'a.ts', rel: 'a.ts', size: 10 },
    { path: 'd/b.ts', rel: 'd/b.ts', size: 20 },
  ];

  it('entryKey/passageKey zero-pad', () => {
    assert.equal(jfind.entryKey(0), 'e000');
    assert.equal(jfind.entryKey(17), 'e017');
    assert.equal(jfind.passageKey(0), 'p00');
    assert.equal(jfind.passageKey(41), 'p41');
  });

  it('nameBatch renders the tree and one noul per entry with {{var}} filled', () => {
    const req = jfind.nameBatch('proj', 'find the retry budget', entries);
    assert.equal(req.state.project, 'proj');
    assert.equal(req.state.search, 'find the retry budget');
    assert.ok(req.state.tree.includes('# e000 a.ts (10 B)'));
    assert.deepEqual(Object.keys(req.state.criteria), ['file'], 'folders are never tagged: file criteria only');
    assert.ok(req.state.criteria.file.yes.length > 0);
    assert.deepEqual(Object.keys(req.questions), ['e000', 'e001']);
    assert.equal(req.questions.e000.type, 'noul');
    assert.ok(req.questions.e000.instructions.includes('e000'), 'key substituted');
    assert.ok(req.questions.e000.instructions.includes('find the retry budget'), 'query substituted');
    assert.ok(req.questions.e000.instructions.includes('"a.ts"'), 'name substituted');
  });

  it('sketchBatch packs mixed-file cards with sorted file map', () => {
    const req = jfind.sketchBatch('find the retry budget', [
      { fileKey: 'f1', rel: 'b.ts', sketch: 's1' },
      { fileKey: 'f0', rel: 'a.ts', sketch: 's0' },
    ]);
    assert.deepEqual(Object.keys(req.state.files), ['f0', 'f1'], 'files sorted lexicographically');
    assert.deepEqual(req.state.passages.p00, ['f1', 's1'], 'first card takes p00');
    assert.deepEqual(req.state.passages.p01, ['f0', 's0']);
    assert.ok(req.questions.p00.instructions.includes('p00'), 'key substituted');
    assert.ok(req.questions.p00.instructions.includes('"find the retry budget"'), 'query substituted');
  });

  it('passageBatch sends verbatim content under the file key', () => {
    const passages = [{ start: 2, end: 3, text: 'L2| aa\nL3| bb\n', score: 0 }];
    const req = jfind.passageBatch('query here', 'src/x.ts', passages);
    assert.equal(req.state.file, 'src/x.ts');
    assert.equal(req.state.passages.p00, 'aa\nbb\n');
    assert.ok(req.questions.p00.instructions.includes('query here'));
  });
});

describe('jfind: SystemOneClient over a local wire mock', () => {
  it('200: parses answers/usage, sends bearer auth, bills hosted input tokens', async () => {
    let sawAuth, sawBody;
    const srv = await startServer((req, res, body) => {
      sawAuth = req.headers.authorization;
      sawBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'm',
        answers: { e000: { type: 'noul', noul: 0.9, legend: 'extra-ignored' }, e001: { type: 'other' } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }));
    });
    try {
      const client = new judge.SystemOneClient({ providers: [{ url: srv.url, auth: 'Bearer tok' }], model: 'm' });
      const out = await client.judge({ state: { a: 1 }, questions: { e000: { type: 'noul', instructions: 'q' } } });
      assert.equal(sawAuth, 'Bearer tok');
      assert.equal(sawBody.model, 'm');
      assert.deepEqual(sawBody.questions, { e000: { type: 'noul', instructions: 'q' } });
      assert.equal(out.answers.e000.noul, 0.9);
      assert.equal(out.answers.e001.noul, undefined, 'non-noul shapes read as unknown');
      assert.equal(out.usage.input, 100);
      assert.equal(out.usage.cost.total, 100 * judge.USD_PER_INPUT_TOKEN);
    } finally { await srv.close(); }
  });

  it('429 retries with backoff within the active provider, then succeeds', async () => {
    const hits = { a: 0, b: 0 };
    const a = await startServer((req, res) => {
      hits.a++;
      if (hits.a === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { p00: { noul: 0.7 } }, usage: { input_tokens: 3, output_tokens: 0 } }));
    });
    const b = await startServer((req, res) => {
      hits.b++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { p00: { noul: 0.1 } }, usage: { input_tokens: 0, output_tokens: 0 } }));
    });
    try {
      const client = new judge.SystemOneClient({ providers: [{ url: a.url, auth: 'Bearer t' }, { url: b.url, auth: 'Bearer t' }] });
      const out = await client.judge({ state: {}, questions: { p00: { type: 'noul', instructions: '' } } });
      assert.equal(out.answers.p00.noul, 0.7);
      assert.equal(hits.a, 2, 'exactly one in-place retry on the active provider');
      assert.equal(hits.b, 0, 'transient failures retry before any failover');
    } finally { await a.close(); await b.close(); }
  });

  it('single-provider clients do not retry: 429 fails fast', async () => {
    let hits = 0;
    const srv = await startServer((req, res) => { hits++; res.writeHead(429); res.end('slow down'); });
    try {
      const client = judge.SystemOneClient.local(srv.url);
      await assert.rejects(client.judge({ state: {}, questions: { e000: { type: 'noul', instructions: '' } } }), /HTTP 429/);
      assert.equal(hits, 1, 'no retry on a lone provider');
    } finally { await srv.close(); }
  });

  it('failover: 401 on the active provider switches to the fallback', async () => {
    const hits = { bad: 0, good: 0 };
    const bad = await startServer((req, res) => { hits.bad++; res.writeHead(401); res.end('no key'); });
    const good = await startServer((req, res) => {
      hits.good++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { p00: { noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 0 } }));
    });
    try {
      const client = new judge.SystemOneClient({ providers: [{ url: bad.url, auth: 'Bearer a' }, { url: good.url, auth: 'Bearer b' }], label: 'pair' });
      const out = await client.judge({ state: {}, questions: { p00: { type: 'noul', instructions: '' } } });
      assert.equal(out.answers.p00.noul, 0.8);
      assert.equal(hits.bad, 1);
      await client.judge({ state: {}, questions: { p00: { type: 'noul', instructions: '' } } });
      assert.equal(hits.bad, 1, 'active provider remembered after failover');
      assert.equal(hits.good, 2);
    } finally { await bad.close(); await good.close(); }
  });

  it('local endpoint sends no Authorization header and costs nothing', async () => {
    let sawAuth;
    const srv = await startServer((req, res, body) => {
      sawAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { e000: { noul: 1 } }, usage: { input_tokens: 5000, output_tokens: 0 } }));
    });
    try {
      const client = judge.SystemOneClient.local(srv.url);
      const out = await client.judge({ state: {}, questions: { e000: { type: 'noul', instructions: '' } } });
      assert.equal(sawAuth, undefined, 'local is unauthenticated');
      assert.equal(out.usage.cost.total, 0);
      assert.equal(out.usage.input, 5000);
    } finally { await srv.close(); }
  });

  it('400 is not retried on a single-provider client', async () => {
    let hits = 0;
    const srv = await startServer((req, res) => { hits++; res.writeHead(400); res.end('bad request'); });
    try {
      const client = new judge.SystemOneClient({ providers: [{ url: srv.url, auth: 'Bearer t' }] });
      await assert.rejects(client.judge({ state: {}, questions: { e000: { type: 'noul', instructions: '' } } }), /HTTP 400/);
      assert.equal(hits, 1, 'non-transient status: no retry, no failover');
    } finally { await srv.close(); }
  });
});

// ── fixture shared by the cascade e2e tests ─────────────────────────────────
const LINES_PER_TARGET_FILE = 240;
async function cascadeFixture() {
  const a = Array.from({ length: 240 }, (_, i) => targetLine(i)).join('');
  const b = Array.from({ length: 40 }, (_, i) => targetLine(i)).join('');
  const root = await mkdtemp(join(tmpdir(), 'omp-find-cascade-'));
  await writeFile(join(root, 'a.ts'), a);
  await writeFile(join(root, 'b.ts'), b);
  return { root, totalLinesA: 240 };
}

describe('jfind: cascade e2e with a stub judge', () => {
  it('three waves rank, merge ranges, and land stats in order', async () => {
    const { root } = await cascadeFixture();
    try {
      const stub = stubJudge(
        () => 0.8,
        () => 0.9,
        (req) => (req.state.file === 'b.ts' ? 0.5 : 0.9),
      );
      const result = await jfind.runCascade({
        root,
        query: 'retry budget counting',
        extraKeywords: ['VERBATIM_TAG'],
        judge: stub,
      });
      assert.deepEqual(result.keywords, ['retry', 'budget', 'count', 'verbatim_tag']);
      assert.equal(result.hits.length, 2, 'both files verify above threshold');
      assert.equal(result.hits[0].rel, 'a.ts');
      assert.equal(result.hits[0].contentScore, 0.9);
      assert.equal(result.hits[0].ranges.length, 1, 'contiguous windows merge');
      assert.equal(result.hits[0].ranges[0].start, 1);
      assert.equal(result.hits[0].ranges[0].end, 240);
      assert.equal(result.hits[0].ranges[0].p, 0.9);
      assert.equal(result.hits[0].truncated, false);
      assert.equal(result.hits[1].rel, 'b.ts');
      assert.equal(result.hits[1].contentScore, 0.5);
      assert.equal(result.hits[0].nameScore, 0.8);
      assert.equal(result.threshold, 0.2);
      const stats = result.stats;
      assert.equal(stats.listed, 2);
      assert.equal(stats.requests, 4, '1 name + 1 sketch + 2 verify');
      assert.equal(stats.judged, 2, 'filename judgments only; verification tallies in windowsJudged');
      assert.equal(stats.windowsJudged, 4);
      assert.equal(stats.windowsPruned, 0);
      assert.equal(stats.errors, 0);
      assert.deepEqual(stats.failures, []);
      assert.ok(stats.inputTokens === 40 && stats.outputTokens === 4, 'usage summed');
      assert.ok(stats.filesRead >= 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('sub-threshold sketches prune verification; zero-verified files stay out', async () => {
    const { root } = await cascadeFixture();
    try {
      const stub = stubJudge(
        () => 0.9,
        (req, key) => (req.state.passages[key][0] === 'f0' ? 0.9 : 0.1),
        () => 0.9,
      );
      const result = await jfind.runCascade({ root, query: 'retry budget', extraKeywords: [], judge: stub });
      assert.deepEqual(result.hits.map((h) => h.rel), ['a.ts'], 'only the sketched-positive file verifies');
      assert.equal(result.stats.windowsPruned, 1, 'b.ts card pruned below cutoff');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('judge failures land in stats.failures and never throw', async () => {
    const { root } = await cascadeFixture();
    try {
      const failing = {
        label: 'always-fails',
        async judge() { throw new Error('boom'); },
      };
      const result = await jfind.runCascade({ root, query: 'retry budget', extraKeywords: [], judge: failing });
      assert.equal(result.hits.length, 0, 'no verified passages');
      assert.ok(result.stats.requests > 0);
      assert.equal(result.stats.errors, result.stats.requests);
      assert.ok(result.stats.failures.length > 0, 'failure text retained');
      assert.ok(result.stats.failures.every((f) => f.startsWith('filenames:') || f.startsWith('sketches:') || f.startsWith('verification:')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('binary and blank files are expected misses, not failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-misses-'));
    try {
      await writeFile(join(root, 'blob.zzz'), Buffer.from([0x00, 0x01, 0x02]));
      await writeFile(join(root, 'blank.zzz'), '   \n\t\n');
      const stub = stubJudge();
      const result = await jfind.runCascade({ root, query: 'retry budget', extraKeywords: [], judge: stub });
      assert.deepEqual(result.stats.failures, []);
      assert.deepEqual(result.hits, []);
      assert.equal(result.stats.listed, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('frecencyScore breaks contentScore ties', async () => {
    const { root } = await cascadeFixture();
    try {
      const tie = stubJudge(() => 0.9, () => 0.9, () => 0.5);
      const result = await jfind.runCascade({
        root, query: 'retry budget', extraKeywords: [], judge: tie,
        frecencyScore: (rel) => (rel === 'b.ts' ? 1 : 0),
      });
      assert.deepEqual(result.hits.map((h) => h.rel), ['b.ts', 'a.ts'], 'equal contentScore → frecency wins');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('jfind: numeric env overrides', () => {
  it('OMP_FIND_CASCADE_* clamp imported knobs', async () => {
    process.env.OMP_FIND_CASCADE_FILES = '9999';
    process.env.OMP_FIND_CASCADE_THRESHOLD = '5';
    process.env.OMP_FIND_CASCADE_PARALLEL = 'nope';
    process.env.OMP_FIND_CASCADE_NAME_BATCH = '-3';
    try {
      const mod = await import(`${dist('jfind.js')}?override=1`);
      assert.equal(mod.FILES, 256, 'clamped to max');
      assert.equal(mod.THRESHOLD, 1, 'float clamped to [0,1] ceiling');
      assert.equal(mod.PARALLEL, 16, 'non-numeric falls back to default');
      assert.equal(mod.NAME_BATCH, 1, 'clamped to min');
    } finally {
      delete process.env.OMP_FIND_CASCADE_FILES;
      delete process.env.OMP_FIND_CASCADE_THRESHOLD;
      delete process.env.OMP_FIND_CASCADE_PARALLEL;
      delete process.env.OMP_FIND_CASCADE_NAME_BATCH;
    }
  });
});

// ── tool-surface tests ──────────────────────────────────────────────────────
describe('ffjfind tool surface', () => {
  it('registers ffjfind and the jfind alias, always', async () => {
    const pi = fakePi();
    tools.registerFindTools(pi, { search, frecency: undefined });
    assert.ok(pi.tools.has('ffjfind'), 'ffjfind always registered');
    assert.ok(pi.tools.has('jfind'), 'alias attempted');
  });

  it('reports the no-judge error when nothing resolves', async () => {
    const hosted = judge.lookupKey('OPENROUTER_API_KEY') !== undefined || judge.lookupKey('TYPESAFE_API_KEY') !== undefined;
    delete process.env.OMP_FIND_JUDGE_URL;
    delete process.env.JEGREP_ENDPOINT_URL;
    if (hosted) return; // this machine's ~/.env resolves hosted keys — the zero-state is env-dependent
    const pi = fakePi();
    tools.registerFindTools(pi, { search });
    const out = await pi.tools.get('ffjfind').execute('t', { query: 'retry budget' }, undefined, undefined, {});
    assert.match(textOf(out), /ffjfind failed: no judge available \(configure a @judge model role, or set TYPESAFE_API_KEY\/OPENROUTER_API_KEY, or OMP_FIND_JUDGE_URL\)/);
  });

  it('query is required and non-empty', async () => {
    const pi = fakePi();
    tools.registerFindTools(pi, { search });
    assert.match(textOf(await pi.tools.get('ffjfind').execute('t', {})), /query must be a non-empty description/);
    assert.match(textOf(await pi.tools.get('ffjfind').execute('t', { query: '   ' })), /query must be a non-empty description/);
  });

  it('path scope errors surface cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-scope-'));
    try {
      await writeFile(join(root, 'file.txt'), 'hi\n');
      const pi = fakePi();
      tools.registerFindTools(pi, { search });
      const exe = (params) => pi.tools.get('ffjfind').execute('t', { ...params, cwd: root }, undefined, undefined, {});
      assert.match(textOf(await exe({ query: 'q', path: '../x' })), /path must be a directory inside the scan root/);
      assert.match(textOf(await exe({ query: 'q', path: '*.ts' })), /path must be a directory inside the scan root/);
      assert.match(textOf(await exe({ query: 'q', path: 'nope/' })), /path not found: nope\//);
      assert.match(textOf(await exe({ query: 'q', path: 'file.txt' })), /path is not a directory: file\.txt/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('ffjfind full tool path over OMP_FIND_JUDGE_URL mock', () => {
  let srv;
  before(async () => {
    srv = await startServer((req, res, body) => {
      const q = String(body.state.search ?? '').toLowerCase();
      const relevant = q.includes('retry');
      const answers = {};
      for (const key of Object.keys(body.questions ?? {})) {
        let noul = 0.05;
        if (body.state.tree !== undefined) noul = 0.9;
        else if (body.state.passages !== undefined) {
          const content = Array.isArray(body.state.passages[key]) ? body.state.passages[key][1] : body.state.passages[key];
          noul = relevant && String(content).includes('retry') ? 0.9 : 0.1;
        }
        answers[key] = { type: 'noul', noul };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', answers, usage: { input_tokens: 12, output_tokens: 2 } }));
    });
    process.env.OMP_FIND_JUDGE_URL = srv.url;
  });
  after(async () => {
    delete process.env.OMP_FIND_JUDGE_URL;
    await srv.close();
  });

  async function toolFixture() {
    const a = Array.from({ length: 240 }, (_, i) => `${String(i).padStart(3, '0')} RETRY_MARK retry budget ${'x'.repeat(50)}\n`).join('');
    const b = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(3, '0')} unrelated filler line ${'y'.repeat(60)}\n`).join('');
    const root = await mkdtemp(join(tmpdir(), 'omp-find-toolpath-'));
    await writeFile(join(root, 'a.ts'), a);
    await writeFile(join(root, 'b.ts'), b);
    return root;
  }

  it('renders hits strongest first with ranges, footer, and details', async () => {
    const root = await toolFixture();
    try {
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const out = await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', grep_keywords: ['RETRY_MARK'], cwd: root }, undefined, undefined, {});
      const t = textOf(out);
      assert.match(t, /^1 hit\(s\) for "retry budget" \(τ 0\.20\), strongest first$/m);
      assert.match(t, /a\.ts  0\.90  240 lines judged/);
      assert.match(t, /  a\.ts:1-240  0\.90  /, 'merged range row with snippet');
      assert.match(t, /listed 2 · judged \d+ · read 2 files \([\d.]+ KB\) · \d+ requests · [\d,]+ tokens · \$[\d.]+ · \S+ wall \/ \S+ api/);
      assert.equal(out.details.totalMatched, 1);
      assert.equal(out.details.totalFiles, 2);
      assert.equal(out.details.truncated, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('scoped path prefixes hit displays with dir/ and zero-hit renders the tau line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-find-scoped-'));
    try {
      await mkdir(join(root, 'sub'), { recursive: true });
      const a = Array.from({ length: 100 }, (_, i) => `${i} RETRY_MARK retry budget ${'x'.repeat(50)}\n`).join('');
      await writeFile(join(root, 'sub', 'a.ts'), a);
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const hit = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', path: 'sub/', cwd: root }, undefined, undefined, {}));
      assert.match(hit, /in sub\/ \(τ 0\.20\)/);
      assert.match(hit, /sub\/a\.ts  0\.90/);
      const zero = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'nothing matches this ever', limit: 5, cwd: root }, undefined, undefined, {}));
      assert.match(zero, /^no hits for "nothing matches this ever" \(τ 0\.20\)$/m);
      assert.match(zero, /listed 1 · judged/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('concise drops range rows; maxChars degrades to per-file counts', async () => {
    const root = await toolFixture();
    try {
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const concise = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', concise: true, cwd: root }, undefined, undefined, {}));
      assert.match(concise, /^a\.ts  0\.90$/m);
      assert.ok(!concise.includes('lines judged'), 'no coverage column');
      const budget = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', maxChars: 10, cwd: root }, undefined, undefined, {}));
      assert.match(budget, /output exceeds 10 chars/);
      assert.match(budget, /Per-file judged lines: a\.ts: 240/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('/find-health judge line', () => {
  it('reports the resolved judge label from OMP_FIND_JUDGE_URL', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }));
    });
    const prev = process.env.OMP_FIND_JUDGE_URL;
    process.env.OMP_FIND_JUDGE_URL = srv.url;
    try {
      const notes = [];
      const pi = {
        commands: new Map(),
        registerCommand(name, def) { this.commands.set(name, def); },
      };
      commands.registerFindCommands(pi, { search: { status: () => 'ok (stub)' }, frecency: { status: () => 'ok' } });
      await pi.commands.get('find-health').handler('', { ui: { notify: (text, kind) => notes.push({ text, kind }) } });
      assert.match(notes[0].text, /judge: ok \(systemone-local \(http:\/\/127\.0\.0\.1:\d+\/\)\)/);
      assert.equal(notes[0].kind, 'info');
    } finally {
      if (prev === undefined) delete process.env.OMP_FIND_JUDGE_URL; else process.env.OMP_FIND_JUDGE_URL = prev;
      await srv.close();
    }
  });
});

describe('context note mentions ffjfind', () => {
  it('lists ffjfind among the tools', async () => {
    assert.ok(context.buildFindToolsNote().includes('ffjfind'));
  });

  it('leads with an ffjfind-first directive inside the find-tools tags', async () => {
    const note = context.buildFindToolsNote();
    assert.match(note, /<find-tools>[\s\S]*<\/find-tools>/, 'kept inside the find-tools tags');
    assert.match(note, /Start EVERY code search with ffjfind/, 'find-first directive leads');
    assert.ok(note.indexOf('Start EVERY code search with ffjfind') < note.indexOf('ffgrep is for exact strings'), 'directive precedes the per-tool roles');
  });
});

describe('find-first prompt guidelines', () => {
  function guidelines(name) {
    const pi = fakePi();
    tools.registerFindTools(pi, { search });
    const def = pi.tools.get(name);
    assert.ok(def, `${name} registered`);
    return def.promptGuidelines;
  }

  it('ffjfind guidelines carry a first-call rule', async () => {
    const guides = guidelines('ffjfind');
    assert.ok(guides.some((g) => /MUST be the first call/.test(g)), 'first-call rule present');
    assert.ok(guides.some((g) => /NEVER grep\/glob blindly/.test(g)), 'blind pattern-guessing banned');
    assert.ok(guides.every((g) => g.startsWith('ffjfind: ')), 'house-style prefix kept');
  });

  it('ffgrep guidelines point at ffjfind for concepts', async () => {
    const guides = guidelines('ffgrep');
    assert.ok(guides.some((g) => /use ffjfind first for concepts\/behaviors/.test(g)), 'ffjfind cross-pointer present');
    assert.ok(guides.some((g) => /Never use shell/.test(g)), 'never-shell rule kept');
  });

  it('fffind guidelines point at ffjfind for concepts', async () => {
    const guides = guidelines('fffind');
    assert.ok(guides.some((g) => /use ffjfind first for concepts\/behaviors/.test(g)), 'ffjfind cross-pointer present');
    assert.ok(guides.some((g) => /Never use shell/.test(g)), 'never-shell rule kept');
  });
});

// ── review batch: partial-failure gate, index hygiene, awaits, aborts, parsing ──
describe('ffjfind partial-failure gate (gaps on OK responses)', () => {
  /** Stub judge omitting the first key of every batch — errors accrue per gap, never per transport. */
  function gappyJudge() {
    const base = stubJudge(() => 0.9, () => 0.9, () => 0.9);
    return {
      label: 'gappy',
      calls: base.calls,
      async judge(req) {
        const out = await base.judge(req);
        const keys = Object.keys(out.answers);
        if (keys.length > 0) delete out.answers[keys[0]];
        return out;
      },
    };
  }

  it('runCascade: errors==requests with judgments still verifies hits', async () => {
    const { root } = await cascadeFixture();
    try {
      const result = await jfind.runCascade({
        root,
        query: 'retry budget counting',
        extraKeywords: ['VERBATIM_TAG'],
        judge: gappyJudge(),
      });
      assert.equal(result.stats.errors, result.stats.requests, 'one gap per batch, all requests OK');
      assert.ok(result.stats.judged + result.stats.windowsJudged > 0, 'usable judgments exist');
      assert.ok(result.hits.length > 0, 'hits verify despite every batch dropping a key');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('tool surface renders hits, not all-failed, under the same gaps', async () => {
    const a = Array.from({ length: 240 }, (_, i) => `${String(i).padStart(3, '0')} RETRY_MARK retry budget ${'x'.repeat(50)}\n`).join('');
    const b = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(3, '0')} unrelated filler line ${'y'.repeat(60)}\n`).join('');
    const root = await fixture({ 'a.ts': a, 'b.ts': b });
    const srv = await startServer((req, res, body) => {
      const keys = Object.keys(body.questions ?? {});
      const answers = {};
      for (const key of keys.slice(1)) {
        let noul = 0.9;
        if (body.state.tree === undefined) {
          const content = Array.isArray(body.state.passages?.[key])
            ? body.state.passages[key][1]
            : body.state.passages?.[key] ?? '';
          noul = String(content).includes('retry') ? 0.9 : 0.1;
        }
        answers[key] = { type: 'noul', noul };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', answers, usage: { input_tokens: 12, output_tokens: 2 } }));
    });
    const prev = process.env.OMP_FIND_JUDGE_URL;
    process.env.OMP_FIND_JUDGE_URL = srv.url;
    try {
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const t = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', grep_keywords: ['RETRY_MARK'], cwd: root }, undefined, undefined, {}));
      assert.match(t, /1 hit\(s\) for "retry budget"/, 'hits render despite per-batch gaps');
      assert.ok(!t.includes('judge requests failed'), 'no all-failed error');
    } finally {
      if (prev === undefined) delete process.env.OMP_FIND_JUDGE_URL; else process.env.OMP_FIND_JUDGE_URL = prev;
      await srv.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tool surface still errors on genuine total failure', async () => {
    const root = await fixture({ 'a.ts': targetFile(40) });
    const srv = await startServer((req, res) => { res.writeHead(500); res.end('bad'); });
    const prev = process.env.OMP_FIND_JUDGE_URL;
    process.env.OMP_FIND_JUDGE_URL = srv.url;
    try {
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const t = textOf(await pi.tools.get('ffjfind').execute('t', { query: 'retry budget', cwd: root }, undefined, undefined, {}));
      assert.match(t, /ffjfind failed: all \d+ judge requests failed/, 'zero usable judgments still errors');
    } finally {
      if (prev === undefined) delete process.env.OMP_FIND_JUDGE_URL; else process.env.OMP_FIND_JUDGE_URL = prev;
      await srv.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('jfind: grepIndex skips ineligible files', () => {
  it('secret files never enter per-file counts or idf', async () => {
    const root = await fixture({
      '.env': 'SECRET_KEYWORD alpha beta\n',
      'app.ts': 'uses SECRET_KEYWORD here\n',
    });
    try {
      const index = await jfind.grepIndex(root, ['secret_keyword'], {});
      assert.ok(!index.perFileKw.has('.env'), 'no .env key even though the backend scanned it');
      assert.ok(index.perFileKw.has('app.ts'), 'eligible file counted');
      const weights = jfind.idf(index);
      assert.equal(weights.length, 1);
      assert.ok(weights[0] < 6, `df excludes the secret file (weight ${weights[0]})`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('jfind: scan abort checks', () => {
  it('listFiles and grepIndex reject on an aborted signal', async () => {
    const root = await fixture({ 'a.ts': 'retry budget\n' });
    try {
      const signal = AbortSignal.abort(new Error('stop'));
      await assert.rejects(jfind.listFiles(root, { signal }), /stop/);
      await assert.rejects(jfind.grepIndex(root, ['retry'], { signal }), /stop/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('judge: adaptHostModule awaits async hosts', () => {
  it('an async resolveJudge Promise adapts instead of falling through', async () => {
    const hostJudge = {
      label: 'async-host',
      async judge() {
        return {
          answers: { e000: { type: 'noul', noul: 0.9, legend: 'extra-ignored' } },
          usage: { input: 4, output: 1, cost: { total: 0 } },
        };
      },
    };
    const mod = { resolveJudge: async () => hostJudge };
    const adapted = await judge.adaptHostModule(mod, {});
    assert.ok(adapted, 'Promise result adapts');
    assert.equal(adapted.label, 'async-host');
    const out = await adapted.judge({ state: {}, questions: { e000: { type: 'noul', instructions: '' } } });
    assert.equal(out.answers.e000.noul, 0.9);
    assert.equal(await judge.adaptHostModule({ resolveJudge: () => undefined }, {}), undefined);
    assert.equal(await judge.adaptHostModule(undefined, {}), undefined);
  });
});

describe('ffjfind path "./" searches the scan root', () => {
  it('"./" and "." behave like the root; guards still reject escapes', async () => {
    const root = await fixture({ 'a.ts': targetFile(40) });
    const srv = await startServer((req, res, body) => {
      const answers = {};
      for (const key of Object.keys(body.questions ?? {})) answers[key] = { type: 'noul', noul: 0.9 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', answers, usage: { input_tokens: 5, output_tokens: 1 } }));
    });
    const prev = process.env.OMP_FIND_JUDGE_URL;
    process.env.OMP_FIND_JUDGE_URL = srv.url;
    try {
      const pi = fakePi();
      tools.registerFindTools(pi, { search, frecency: undefined });
      const exe = (params) => pi.tools.get('ffjfind').execute('t', { query: 'retry budget', cwd: root, ...params }, undefined, undefined, {});
      assert.ok(!textOf(await exe({ path: './' })).includes('path must be a directory inside the scan root'), '"./" searches the root');
      assert.ok(!textOf(await exe({ path: '.' })).includes('path must be a directory inside the scan root'), '"." searches the root');
      assert.match(textOf(await exe({ path: '../x' })), /path must be a directory inside the scan root/, 'escape still rejected');
      assert.match(textOf(await exe({ path: '*.ts' })), /path must be a directory inside the scan root/, 'glob still rejected');
    } finally {
      if (prev === undefined) delete process.env.OMP_FIND_JUDGE_URL; else process.env.OMP_FIND_JUDGE_URL = prev;
      await srv.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('judge: HTTP-date Retry-After', () => {
  it('waits past an HTTP-date before the in-place retry', async () => {
    let hits = 0;
    const date = new Date(Date.now() + 1900).toUTCString(); // ~1s out; whole-second truncation keeps >=900ms of it
    const a = await startServer((req, res) => {
      hits++;
      if (hits === 1) { res.writeHead(429, { 'retry-after': date }); res.end('slow down'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { p00: { noul: 0.7 } }, usage: { input_tokens: 3, output_tokens: 0 } }));
    });
    const b = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { p00: { noul: 0.1 } }, usage: { input_tokens: 0, output_tokens: 0 } }));
    });
    try {
      const client = new judge.SystemOneClient({ providers: [{ url: a.url, auth: 'Bearer t' }, { url: b.url, auth: 'Bearer t' }] });
      const t0 = Date.now();
      const out = await client.judge({ state: {}, questions: { p00: { type: 'noul', instructions: '' } } });
      const elapsed = Date.now() - t0;
      assert.equal(out.answers.p00.noul, 0.7);
      assert.ok(elapsed >= 800, `second attempt lands after the date (elapsed ${elapsed}ms)`);
    } finally { await a.close(); await b.close(); }
  });
});

describe('judge: ~/.env matched-pair quotes and export whitespace', () => {
  it('strips only matched pairs; accepts export with a tab', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omp-find-home-'));
    const envFile = join(home, '.env');
    await writeFile(envFile, [
      'export\tOMP_FIND_TEST_TAB=tabbed',
      "OMP_FIND_TEST_DQ=\"a'b\"",
      "OMP_FIND_TEST_SQ='a\"b'",
      'OMP_FIND_TEST_MISMATCH="abc\'',
      'OMP_FIND_TEST_TRAIL=abc"',
      'OMP_FIND_TEST_PLAIN=plain',
      '',
    ].join('\n'));
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      assert.equal(judge.lookupKey('OMP_FIND_TEST_TAB'), 'tabbed', 'export + tab prefix accepted');
      assert.equal(judge.lookupKey('OMP_FIND_TEST_DQ'), "a'b", 'double pair stripped, inner quote kept');
      assert.equal(judge.lookupKey('OMP_FIND_TEST_SQ'), 'a"b', 'single pair stripped, inner quote kept');
      assert.equal(judge.lookupKey('OMP_FIND_TEST_MISMATCH'), '"abc\'', 'mismatched quotes kept literally');
      assert.equal(judge.lookupKey('OMP_FIND_TEST_TRAIL'), 'abc"', 'trailing-only quote kept literally');
      assert.equal(judge.lookupKey('OMP_FIND_TEST_PLAIN'), 'plain');
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
