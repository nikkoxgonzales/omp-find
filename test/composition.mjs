import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const root = await mkdtemp(join(tmpdir(), 'omp-find-comp-'));
  for (const [rel, content] of Object.entries(struct)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const detailsOf = (out) => out?.details;
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

function exe(pi, name) {
  const t = pi.tools.get(name);
  assert.ok(t, `tool ${name} registered`);
  return (params) => t.execute('t', params);
}

const TREE = {
  'src/alpha.py': 'import beta\n\n# Alpha handler.\ndef alpha():\n    return beta.run()\n',
  'src/beta.py': 'def run():\n    return 1\n',
  'src/main.py': 'from alpha import alpha\n\nresult = alpha()\n',
  'docs/note.txt': 'hello world\n',
};

describe('rankMap core (goldmine pick 4)', () => {
  it('returns sorted files with symbols, centrality and scan facts', async () => {
    const root = await fixture(TREE);
    try {
      const res = await search.rankMap({ cwd: root });
      assert.equal(res.backend === 'rg' || res.backend === 'walker', true);
      assert.equal(res.scanned, 4);
      const paths = res.files.map((f) => f.path.replace(/\\/g, '/'));
      assert.deepEqual(paths, [...paths].sort());
      const byPath = new Map(res.files.map((f) => [f.path.replace(/\\/g, '/'), f]));
      assert.ok((byPath.get('src/alpha.py').symbols.length ?? 0) > 0);
      assert.equal(typeof byPath.get('src/alpha.py').modified, 'boolean');
      assert.ok(byPath.get('src/beta.py').inDegree >= 1, 'beta imported by alpha');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffmap tool (goldmine pick 4)', () => {
  it('maps top files, fits budget with omitted footer, carries details', async () => {
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const full = await exe(pi, 'ffmap')({ cwd: root });
      const t = textOf(full);
      assert.ok(t.includes('src/alpha.py:'), `map lists files:\n${t}`);
      assert.ok(t.includes('alpha'), 'map shows symbols');
      assert.deepEqual(detailsOf(full).truncated, false);
      const tight = await exe(pi, 'ffmap')({ cwd: root, maxChars: 40 });
      const tt = textOf(tight);
      assert.ok(tt.includes('files omitted'), `tight budget omits:\n${tt}`);
      assert.equal(detailsOf(tight).truncated, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('path scope restricts the map subtree', async () => {
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = await exe(pi, 'ffmap')({ cwd: root, path: 'src/' });
      const t = textOf(out);
      assert.ok(!t.includes('note.txt'), `scope drops docs/:\n${t}`);
      assert.ok(t.includes('src/alpha.py:'), 'scope keeps src/');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ffcapsule tool (goldmine pick 5)', () => {
  it('fuses def, doc, callers, imports and guidance', async () => {
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = await exe(pi, 'ffcapsule')({ symbol: 'alpha', cwd: root });
      const t = textOf(out);
      assert.ok(t.includes('symbol alpha — def in src/alpha.py:4'), `header:\n${t}`);
      assert.ok(t.includes('Alpha handler.'), `doc:\n${t}`);
      assert.ok(t.includes('src/main.py:3'), `caller:\n${t}`);
      assert.ok(t.includes('imports (1):'), `imports:\n${t}`);
      assert.ok(t.includes('Guidance: ffoutline src/main.py'), `guidance:\n${t}`);
      assert.deepEqual(detailsOf(out), { totalMatched: 1, totalFiles: 2, truncated: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honest empty dossier guides to ffgrep', async () => {
    const root = await fixture(TREE);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const out = await exe(pi, 'ffcapsule')({ symbol: 'zz_nope', cwd: root });
      const t = textOf(out);
      assert.ok(t.includes('no definition found'), `empty header:\n${t}`);
      assert.ok(t.includes('Guidance: ffgrep zz_nope'), `guidance:\n${t}`);
      assert.equal(detailsOf(out).totalMatched, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('budgeted nudges (goldmine pick 6)', () => {
  it('tips non-trivial results, max 3 per tool, trivial calls clean', async () => {
    const struct = {};
    for (let i = 0; i < 7; i++) struct[`f${i}.txt`] = `needle ${i}\n`;
    const root = await fixture(struct);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const find = exe(pi, 'fffind');
      const seen = [];
      for (let i = 0; i < 4; i++) seen.push(textOf(await find({ pattern: 'txt', cwd: root })));
      assert.ok(seen[0].includes('tip: ffoutline'), 'first tip');
      assert.ok(seen[1].includes('tip: ffcallers'), 'rotates');
      assert.ok(seen[2].includes('tip: ffmap'), 'third tip');
      assert.ok(!seen[3].includes('tip:'), 'budget exhausted');
      const small = textOf(await find({ pattern: 'f0.txt', cwd: root }));
      assert.ok(!small.includes('tip:'), 'trivial call stays clean');
      const grep = exe(pi, 'ffgrep');
      const g = textOf(await grep({ pattern: 'needle', cwd: root }));
      assert.ok(g.includes('tip: ffcallers'), 'grep tips too');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('concise density (goldmine pick 7)', () => {
  it('find drops notes and tips, grep drops to path:line, outline to names', async () => {
    const struct = {};
    for (let i = 0; i < 7; i++) struct[`g${i}.txt`] = `mark ${i}\n`;
    struct['src/mod.py'] = 'def thing():\n    return 1\n';
    const root = await fixture(struct);
    try {
      const pi = fakePi();
      findTools.registerFindTools(pi, { search, frecency: stubFrecency }, { mode: 'additive' });
      const f = textOf(await exe(pi, 'fffind')({ pattern: 'txt', cwd: root, concise: true }));
      assert.ok(!f.includes('tip:'), `concise find has no tips:\n${f}`);
      assert.ok(f.includes('g0.txt'), 'rows stay');
      const g = textOf(await exe(pi, 'ffgrep')({ pattern: 'mark', cwd: root, concise: true }));
      assert.ok(g.split('\n').some((l) => /^g\d\.txt:\d+$/.test(l)), `path:line rows:\n${g}`);
      assert.ok(!g.includes('mark 0'), 'no text in concise grep');
      const o = textOf(await exe(pi, 'ffoutline')({ path: 'src/mod.py', cwd: root, concise: true }));
      assert.ok(o.split('\n').includes('thing'), `name-only rows:\n${o}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
