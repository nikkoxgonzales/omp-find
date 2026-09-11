import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
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
  const commands = new Map();
  const handlers = new Map();
  return {
    tools,
    commands,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, def) { commands.set(name, def); },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    async emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) await fn(...args);
    },
  };
}

const textOf = (out) => out?.content?.[0]?.text ?? String(out);
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

// 60 find hits so limit:1 and limit:50 both page (59/10 more respectively).
function stubSearch() {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ path: 'a.txt', line: i + 1, col: 1, text: 'x' }));
  const syms = (n) => Array.from({ length: n }, (_, i) => ({ line: i + 1, col: 1, kind: 'function', name: `sym${i}` }));
  return {
    ...search,
    findScanned: async () => ({ paths: Array.from({ length: 60 }, (_, i) => `f${i}.ts`), scanned: 60, backend: 'walker' }),
    grepContents: async (_p, o = {}) => ({ matches: rows(40).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 30)), total: 40, backend: 'walker' }),
    outlineFile: async () => ({ symbols: syms(40), total: 40 }),
    callersOf: async () => ({ matches: rows(40), total: 40, backend: 'walker' }),
    structuralGrep: async () => ({ matches: rows(40), total: 40, backend: 'walker' }),
  };
}

function pi() {
  const p = fakePi();
  findTools.registerFindTools(p, { search: stubSearch(), frecency: stubFrecency }, { mode: 'additive' });
  return p;
}

describe('stress-round9b: numeric params reject non-integers instead of flooring', () => {
  it('limit: 2.5 errors on every tool that takes it', async () => {
    const p = pi();
    for (const [name, params] of [
      ['fffind', { pattern: 'x' }],
      ['ffgrep', { pattern: 'x' }],
      ['ffoutline', { path: 'a.ts' }],
      ['ffcallers', { symbol: 'x' }],
      ['ffstructural', { pattern: 'x($A)' }],
      ['ffcapsule', { symbol: 'x' }],
    ]) {
      const out = textOf(await p.tools.get(name).execute('t', { ...params, limit: 2.5 }));
      assert.match(out, new RegExp(`${name} failed: limit must be an integer >= 1`), `${name} limit:2.5:\n${out}`);
    }
  });

  it('depth: 1.5 errors on ffoutline (0|1 knob) and ffcallers (closed set)', async () => {
    const p = pi();
    const outline = textOf(await p.tools.get('ffoutline').execute('t', { path: 'a.ts', depth: 1.5 }));
    assert.match(outline, /ffoutline failed: depth must be an integer/, `ffoutline depth:1.5:\n${outline}`);
    const callers = textOf(await p.tools.get('ffcallers').execute('t', { symbol: 'x', depth: 1.5 }));
    assert.match(callers, /ffcallers failed: depth must be an integer/, `ffcallers depth:1.5:\n${callers}`);
  });

  it('contextBefore/contextAfter: 2.5 error on ffgrep and ffstructural', async () => {
    const p = pi();
    for (const name of ['ffgrep', 'ffstructural']) {
      const params = name === 'ffgrep' ? { pattern: 'x' } : { pattern: 'x($A)' };
      for (const key of ['contextBefore', 'contextAfter']) {
        const out = textOf(await p.tools.get(name).execute('t', { ...params, [key]: 2.5 }));
        assert.match(out, new RegExp(`${name} failed: ${key} must be an integer`), `${name} ${key}:2.5:\n${out}`);
      }
    }
  });

  it('maxChars: 1.5 errors on every tool that takes it', async () => {
    const p = pi();
    for (const [name, params] of [
      ['fffind', { pattern: 'x' }],
      ['ffgrep', { pattern: 'x' }],
      ['ffoutline', { path: 'a.ts' }],
      ['ffcallers', { symbol: 'x' }],
      ['ffstructural', { pattern: 'x($A)' }],
      ['ffmap', {}],
      ['ffcapsule', { symbol: 'x' }],
    ]) {
      const out = textOf(await p.tools.get(name).execute('t', { ...params, maxChars: 1.5 }));
      assert.match(out, new RegExp(`${name} failed: maxChars must be an integer >= 1`), `${name} maxChars:1.5:\n${out}`);
    }
  });

  it('limit: 1 and limit: 50 still page normally', async () => {
    const p = pi();
    const find = p.tools.get('fffind');
    const one = textOf(await find.execute('t', { pattern: 'f', limit: 1 }));
    assert.match(one, /\(59 more; pass cursor/, `limit:1:\n${one}`);
    const fifty = textOf(await find.execute('t', { pattern: 'f', limit: 50 }));
    assert.match(fifty, /\(10 more; pass cursor/, `limit:50:\n${fifty}`);
  });
});

describe('stress-round9b: strictStrParam is direct-execute defense-in-depth', () => {
  // On the live path the host JSON-parses string args and coerces scalars to
  // the declared schema type before execute() runs, so a non-string primary
  // param can only arrive from a direct execute() caller — the check must
  // still fire there.
  it('non-string primary params still error on direct execute()', async () => {
    const p = pi();
    for (const [name, params, re] of [
      ['fffind', { pattern: 123 }, /fffind failed: pattern: expected string/],
      ['ffgrep', { pattern: 123 }, /ffgrep failed: pattern: expected string/],
      ['ffoutline', { path: 123 }, /ffoutline failed: path: expected string/],
      ['ffcallers', { symbol: 123 }, /ffcallers failed: symbol: expected string/],
      ['ffstructural', { pattern: 123 }, /ffstructural failed: pattern: expected string/],
      ['ffstructural', { symbol: 123 }, /ffstructural failed: symbol: expected string/],
      ['ffstructural', { references: 123 }, /ffstructural failed: references: expected string/],
      ['ffcapsule', { symbol: 123 }, /ffcapsule failed: symbol: expected string/],
      ['ffmap', { path: 123 }, /ffmap failed: path: expected string/],
    ]) {
      const out = textOf(await p.tools.get(name).execute('t', params));
      assert.match(out, re, `${name} ${JSON.stringify(params)}:\n${out}`);
    }
  });
});
