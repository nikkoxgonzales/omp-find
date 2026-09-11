/**
 * omp-find installed-surface simulator (no-install, zero deps, Node stdlib only).
 *
 * Fidelity point: this file NEVER imports src/*.ts. It loads the exact artifact an
 * OMP install loads — dist/extension.js (default factory) — and drives it with a
 * faithful host double that implements the real host contract:
 *   - registerTool({name, ...}) single-object arity (no (name, def) form exists)
 *   - registerCommand(name, {description, handler})
 *   - on('session_start', ...) / emit (fired like the host fires it)
 *   - tool execute dispatched as execute(toolCallId, params, signal, onUpdate, ctx)
 *   - tool results validated as {content: [{type: 'text', text}], details?}
 *
 * Reference: C:/Users/nikko/Desktop/cc/f10/.temp/references/oh-my-pi/packages/
 *   coding-agent/src/extensibility/extensions/types.ts (ExtensionAPI, ToolDefinition).
 *
 * Isolation: temp HOME (LOCALAPPDATA/HOME/USERPROFILE) + temp fixture tree per run,
 * so frecency never touches the real store and scans never touch the real tree.
 * Run: npm run simulate  (builds first, so dist is never stale).
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- isolation
const simRoot = await mkdtemp(join(tmpdir(), 'omp-find-sim-'));
const fakeHome = join(simRoot, 'home');
const tree = join(simRoot, 'tree');
await mkdir(fakeHome, { recursive: true });
await mkdir(tree, { recursive: true });
// Frecency root is %LOCALAPPDATA%/omp-find on win32, ~/.omp/var/omp-find
// (via os.homedir()) elsewhere — fence both before dist is even imported.
process.env.LOCALAPPDATA = fakeHome;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// ------------------------------------------------------------- fixture tree
const PHRASE = 'Chat ID (CHT-1234 from list_chats)';
const fixture = {
  'src/server.py': [
    'from search import parseFindQuery',
    '',
    `header = "${PHRASE}"`,
    '',
    'def serve():',
    '    result = parseFindQuery("srv")',
    '    return result',
    '',
  ].join('\n'),
  'src/other.py': [`note = "${PHRASE}"`, ''].join('\n'),
  'src/user_service.py': ['def handle_user():', '    return 1', ''].join('\n'),
  'src/alpha_one.py': 'ALPHA = 1\n',
  'src/alpha_two.py': 'ALPHA = 2\n',
  'src/alpha_three.py': 'ALPHA = 3\n',
};
// 35 decoys sort BEFORE src/ ('a_' < 'src') and all contain the marker: a
// bounded-fetch-first grep would page server.py out, so the bare-file filter
// scenario below proves the tools-side full-set filter (the grep -c case).
for (let i = 0; i < 35; i++) {
  fixture[`a_decoy_${String(i).padStart(2, '0')}.txt`] = `decoy CHT-1234 marker ${i}\n`;
}
for (const [rel, content] of Object.entries(fixture)) {
  const full = join(tree, rel);
  await mkdir(join(tree, rel.split('/').slice(0, -1).join('/')), { recursive: true }).catch(() => {});
  await writeFile(full, content);
}

// ------------------------------------------------------------ host double
const tools = new Map();
const commands = new Map();
const subscribed = new Map();
let callSeq = 0;
const calledTools = new Set();

function fail(kind, msg) {
  throw new Error(`contract drift [${kind}]: ${msg}`);
}

const host = {
  registerTool(...args) {
    if (args.length !== 1 || typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])) {
      fail('registerTool', `expected single-object arity registerTool({name, ...}); got ${args.length} arg(s) of type ${args.map((a) => (a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a)).join(', ')}`);
    }
    const t = args[0];
    for (const k of ['name', 'description', 'parameters', 'execute']) {
      if (t[k] === undefined) fail('registerTool', `tool missing required field "${k}" (keys: ${Object.keys(t).join(', ')})`);
    }
    if (typeof t.name !== 'string' || typeof t.execute !== 'function') {
      fail('registerTool', `tool "name" must be string and "execute" function (got ${typeof t.name}/${typeof t.execute})`);
    }
    if (tools.has(t.name)) fail('registerTool', `duplicate tool registration "${t.name}"`);
    tools.set(t.name, t);
  },
  registerCommand(...args) {
    if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'object' || args[1] === null) {
      fail('registerCommand', `expected registerCommand(name, {description, handler}); got ${args.length} arg(s)`);
    }
    if (typeof args[1].handler !== 'function') fail('registerCommand', `command "${args[0]}" options.handler is not a function`);
    commands.set(args[0], args[1]);
  },
  on(event, listener) {
    if (typeof event !== 'string' || typeof listener !== 'function') fail('on', `expected on(event, listener); got (${typeof event}, ${typeof listener})`);
    if (!subscribed.has(event)) subscribed.set(event, []);
    subscribed.get(event).push(listener);
  },
  async emit(event, ...a) {
    for (const fn of subscribed.get(event) ?? []) await fn(...a);
  },
};

/** Dispatch exactly like the host: execute(id, params, signal, onUpdate, ctx). */
async function callTool(name, params) {
  const t = tools.get(name);
  if (!t) fail('dispatch', `tool "${name}" not registered (registered: ${[...tools.keys()].join(', ') || 'none'})`);
  calledTools.add(name);
  const res = await t.execute(`sim-${++callSeq}`, params ?? {}, undefined, undefined, {});
  if (!res || typeof res !== 'object' || !Array.isArray(res.content) || res.content.length === 0) {
    fail('result-shape', `tool "${name}" returned ${JSON.stringify(res)?.slice(0, 120)} — expected {content: [{type: 'text', text}], details?}`);
  }
  for (const b of res.content) {
    if (b?.type !== 'text' || typeof b.text !== 'string') {
      fail('result-shape', `tool "${name}" content block is not {type: 'text', text: string} (got ${JSON.stringify(b)?.slice(0, 120)})`);
    }
  }
  return res.content.map((b) => b.text).join('');
}

/** Invoke a slash command, capturing ctx.ui.notify output like the TUI does. */
async function invokeCommand(name, args = '') {
  const c = commands.get(name);
  if (!c) fail('dispatch', `command "${name}" not registered (registered: ${[...commands.keys()].join(', ') || 'none'})`);
  const notes = [];
  await c.handler(args, { ui: { notify: (text, kind) => notes.push({ text, kind }) } });
  return notes;
}

const cursorOf = (text) => /cursor "([^"]+)"/.exec(text)?.[1];

// ------------------------------------------------------- load dist (fidelity)
const extUrl = pathToFileURL(resolve('dist/extension.js')).href;
const mod = await import(extUrl);
if (typeof mod.default !== 'function') fail('entry', 'dist/extension.js has no default factory export');
await mod.default(host);
if (!(subscribed.get('session_start') ?? []).length) fail('events', 'extension never subscribed session_start — warm scan would never fire');
await host.emit('session_start', {}, {}); // fire like the host does

console.log(`extension : ${extUrl}`);
console.log(`tools     : ${[...tools.keys()].join(', ')}`);
console.log(`commands  : ${[...commands.keys()].join(', ')}`);
console.log(`session_start listeners: ${(subscribed.get('session_start') ?? []).length}`);
console.log(`fixture   : ${tree} (${Object.keys(fixture).length} files, HOME=${fakeHome})`);
console.log('');

// ---------------------------------------------------------------- scenarios
const results = [];
async function scenario(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message ?? err) });
    console.log(`FAIL ${name}\n  ${String(err?.message ?? err).split('\n').join('\n  ')}`);
  }
}
const show = (label, text) => console.log(`  --- agent sees (${label}) ---\n  ${text.split('\n').join('\n  ')}\n  --- end ---`);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await scenario('fffind ranked query + pagination cursor round-trip', async () => {
  const page1 = await callTool('fffind', { pattern: 'alpha', cwd: tree, limit: 2 });
  show('fffind page 1', page1);
  assert(page1.includes('alpha_one.py') || page1.includes('alpha_two.py'), `page 1 missing alpha hits:\n${page1}`);
  const cursor = cursorOf(page1);
  assert(cursor, `page 1 has no cursor footer (3 hits, limit 2 must page):\n${page1}`);
  const page2 = await callTool('fffind', { cursor });
  show('fffind page 2', page2);
  const seen = new Set([...page1.split('\n'), ...page2.split('\n')].filter((l) => l.includes('alpha_')));
  for (const f of ['alpha_one.py', 'alpha_two.py', 'alpha_three.py']) {
    assert([...seen].some((l) => l.includes(f)), `paged results never surfaced ${f}`);
  }
  // Determinism: same query twice → identical text (frecency store is real but cold).
  // Cursor ids increment per page issued, so normalize the footer token first.
  const norm = (t) => t.replace(/pass cursor "[^"]+"/, 'pass cursor "<cursor>"');
  const repeat = await callTool('fffind', { pattern: 'alpha', cwd: tree, limit: 2 });
  assert(norm(repeat) === norm(page1), 'repeat query diverged — ranking is not deterministic');
  return `cursor "${cursor}" round-trip surfaced all 3 alpha files across 2 pages`;
});

await scenario('ffgrep literal phrase + bare-file filter (grep -c displacement)', async () => {
  // Parens need no escaping (literal default) AND the bare filename must filter
  // over the FULL 36-hit set: 35 root decoys sort before src/, so a bounded
  // fetch-first implementation would page server.py out entirely.
  const out = await callTool('ffgrep', { pattern: 'CHT-1234', path: 'server.py', cwd: tree, limit: 5 });
  show('ffgrep filtered', out);
  assert(out.includes('server.py'), `bare-file filter lost server.py:\n${out}`);
  assert(!out.includes('a_decoy_'), `path filter leaked decoy hits:\n${out}`);
  const literal = await callTool('ffgrep', { pattern: PHRASE, path: 'server.py', cwd: tree });
  show('ffgrep literal parens', literal);
  assert(literal.includes('server.py'), `literal parens phrase did not match:\n${literal}`);
  return 'bare-file filter scoped 36 hits to server.py; parens matched literally';
});

await scenario('unknown-cursor errors (find + grep)', async () => {
  const badFind = await callTool('fffind', { cursor: 'find_c99999' });
  show('fffind bad cursor', badFind);
  assert(/unknown or expired cursor "find_c99999"/.test(badFind), `expected unknown-cursor error, got:\n${badFind}`);
  const badGrep = await callTool('ffgrep', { cursor: 'grep_c99999' });
  show('ffgrep bad cursor', badGrep);
  assert(/unknown or expired cursor "grep_c99999"/.test(badGrep), `expected unknown-cursor error, got:\n${badGrep}`);
  return 'both tools return error text (never throw) for bogus cursors';
});

await scenario('/find-health facts output', async () => {
  const notes = await invokeCommand('find-health');
  assert(notes.length > 0, '/find-health never called ctx.ui.notify');
  show('/find-health notify', notes[0].text);
  assert(/^find status/m.test(notes[0].text), `missing "find status" header:\n${notes[0].text}`);
  assert(/^index: /m.test(notes[0].text), `missing index: facts line:\n${notes[0].text}`);
  assert(/^frecency: /m.test(notes[0].text), `missing frecency: facts line:\n${notes[0].text}`);
  assert(/no status reported/.test(notes[0].text) === false, `tautology fallback leaked into health output:\n${notes[0].text}`);
  return `kind=${notes[0].kind}`;
});

await scenario('/find-rescan drop', async () => {
  const notes = await invokeCommand('find-rescan');
  assert(notes.length > 0, '/find-rescan never called ctx.ui.notify');
  show('/find-rescan notify', notes[0].text);
  assert(/caches dropped/.test(notes[0].text), `expected "caches dropped", got:\n${notes[0].text}`);
  return notes[0].text.split('\n')[0];
});

await scenario('ffoutline symbol overview', async () => {
  const out = await callTool('ffoutline', { path: 'src/server.py', cwd: tree });
  show('ffoutline', out);
  assert(out.includes('serve'), `outline missed "def serve":\n${out}`);
  assert(/src\/server\.py:\d+:\d+:/.test(out.replace(/\\/g, '/')), `outline rows lack file:line:col:\n${out}`);
  return 'outline rows carry line numbers for read/ffgrep follow-up';
});

await scenario('ffcallers who-calls-X', async () => {
  const out = await callTool('ffcallers', { symbol: 'parseFindQuery', cwd: tree });
  show('ffcallers', out);
  assert(out.includes('server.py'), `callers missed the server.py call site:\n${out}`);
  return 'import + call-paren sites ranked in one call';
});
await scenario('ffcallers certainty labels + exact_only', async () => {
  await writeFile(join(tree, 'src', 'zzq_certainty.py'), [
    'zzq_unique_sym()',
    'obj.zzq_unique_sym',
    'from m import zzq_unique_sym',
    '',
  ].join('\n'));
  const out = await callTool('ffcallers', { symbol: 'zzq_unique_sym', cwd: tree });
  show('ffcallers certainty', out);
  const fwd = out.replace(/\\/g, '/');
  assert(fwd.includes('src/zzq_certainty.py:1:'), `call-paren row missing:\n${out}`);
  assert(!fwd.includes('[possible] src/zzq_certainty.py:1:'), `exact row mistagged:\n${out}`);
  assert(!fwd.includes('[possible] src/zzq_certainty.py:3:'), `import row mistagged:\n${out}`);
  assert(fwd.includes('[possible] src/zzq_certainty.py:2:'), `member mention untagged:\n${out}`);
  const exact = await callTool('ffcallers', { symbol: 'zzq_unique_sym', cwd: tree, exact_only: true });
  assert(!exact.replace(/\\/g, '/').includes('zzq_certainty.py:2:'), `exact_only leaked a possible row:\n${exact}`);
  return 'exact rows bare, possible rows [possible]-tagged, exact_only drops them';
});

await scenario('stale cursor refuses a shifted page', async () => {
  const rel = join('src', 'zzq_stale.py');
  await writeFile(join(tree, rel), 'zzq_stale_sym()\nzzq_stale_sym()\n');
  const page1 = await callTool('ffcallers', { symbol: 'zzq_stale_sym', cwd: tree, limit: 1 });
  const cursor = cursorOf(page1);
  assert(cursor, `page 1 has no cursor footer:\n${page1}`);
  await writeFile(join(tree, rel), 'zzq_stale_sym()\nzzq_stale_sym()\nzzq_stale_sym()\n');
  const resumed = await callTool('ffcallers', { cursor });
  show('stale resume', resumed);
  assert(/results changed since page 1; re-run without cursor/.test(resumed), `stale cursor silently re-paged:\n${resumed}`);
  return 'total mismatch → restart guidance, never a shifted page';
});
await scenario('ffgrep expand:function attribution headers', async () => {
  const out = await callTool('ffgrep', { pattern: 'parseFindQuery', path: 'src/server.py', cwd: tree, expand: 'function' });
  assert(out.includes('in def serve'), `attribution header missing:\n${out}`);
  assert(out.includes('server.py'), `match rows missing:\n${out}`);
  const bare = await callTool('ffgrep', { pattern: 'parseFindQuery', path: 'src/server.py', cwd: tree });
  assert(!bare.includes('in def serve'), `default grew a header:\n${bare}`);
  return 'opt-in enclosing-symbol headers, default rows unchanged';
});

await scenario('ffcallers depth:2 transitive ring', async () => {
  await writeFile(join(tree, 'src', 'zzq_wrap.py'), [
    'from server import serve',
    '',
    'def zzq_wrap():',
    '    return serve()',
    '',
  ].join('\n'));
  const flat = await callTool('ffcallers', { symbol: 'parseFindQuery', cwd: tree });
  assert(!flat.includes('depth:'), `default grew ring labels:\n${flat}`);
  const deep = await callTool('ffcallers', { symbol: 'parseFindQuery', cwd: tree, depth: 2 });
  show('ffcallers depth 2', deep);
  const fwd = deep.replace(/\\/g, '/');
  assert(fwd.includes('zzq_wrap.py'), `transitive caller missing:\n${deep}`);
  assert(/depth:2 /.test(fwd), `ring-2 rows unlabeled:\n${deep}`);
  assert(/depth:1 /.test(fwd), `ring-1 rows unlabeled:\n${deep}`);
  return 'transitive callers labeled per ring, default depth 1 unchanged';
});

await scenario('ffstructural pattern + references + cursor + approx labels', async () => {
  const pat = await callTool('ffstructural', { pattern: 'parseFindQuery($$$)', path: 'src/', cwd: tree });
  show('ffstructural pattern', pat);
  assert(pat.includes('approx: '), `rows lack approx: labels:\n${pat}`);
  assert(pat.includes('server.py'), `pattern missed the server.py call site:\n${pat}`);
  const page1 = await callTool('ffstructural', { references: 'parseFindQuery', cwd: tree, limit: 1 });
  show('ffstructural references page 1', page1);
  const cursor = cursorOf(page1);
  assert(cursor && cursor.startsWith('structural_c'), `page 1 has no structural_c cursor footer:\n${page1}`);
  const page2 = await callTool('ffstructural', { cursor });
  show('ffstructural page 2', page2);
  assert(page2.includes('approx: '), `page 2 lost approx: labels:\n${page2}`);
  const sym = await callTool('ffstructural', { symbol: 'serve', cwd: tree });
  show('ffstructural symbol', sym);
  assert(sym.includes('serve'), `symbol: missed "def serve":\n${sym}`);
  const prev = await callTool('ffstructural', { pattern: 'parseFindQuery($$$)', rewrite: 'lookup($$$)', cwd: tree });
  show('ffstructural rewrite preview', prev);
  assert(prev.includes('- ') && prev.includes('+ '), `preview lacks -/+ rows:\n${prev}`);
  assert(prev.includes('preview only'), `preview lacks the no-write notice:\n${prev}`);
  return 'shape query + delegation + cursor + preview-only rewrite on the installed surface';
});
if (tools.has('structural')) {
  await scenario('structural alias mirrors ffstructural', async () => {
    const out = await callTool('structural', { pattern: 'parseFindQuery($$$)', path: 'src/', cwd: tree });
    show('structural alias', out);
    assert(out.includes('server.py'), `structural alias diverged:\n${out}`);
    return 'alias consistent';
  });
}
if (tools.has('find') || tools.has('grep')) {
  await scenario('override aliases find/grep mirror fffind/ffgrep', async () => {
    if (tools.has('find')) {
      const out = await callTool('find', { pattern: 'alpha', cwd: tree, limit: 2 });
      show('find alias', out);
      assert(out.includes('alpha_'), `find alias diverged from fffind:\n${out}`);
    }
    if (tools.has('grep')) {
      const out = await callTool('grep', { pattern: 'CHT-1234', path: 'server.py', cwd: tree, limit: 5 });
      show('grep alias', out);
      assert(out.includes('server.py'), `grep alias diverged from ffgrep:\n${out}`);
    }
    return `aliases present (${['find', 'grep'].filter((t) => tools.has(t)).join(', ')}) and consistent`;
  });
}
if (tools.has('outline')) {
  await scenario('outline alias mirrors ffoutline', async () => {
    const out = await callTool('outline', { path: 'src/server.py', cwd: tree });
    show('outline alias', out);
    assert(out.includes('serve'), `outline alias diverged:\n${out}`);
    return 'alias consistent';
  });
}

await scenario('ffmap fitted overview + map alias', async () => {
  const out = await callTool('ffmap', { cwd: tree, maxChars: 2000 });
  show('ffmap', out);
  assert(out.includes('server.py:'), `map lists fixture files:\n${out}`);
  assert(out.includes('serve'), `map shows symbols:\n${out}`);
  if (tools.has('map')) {
    const tight = await callTool('map', { cwd: tree, maxChars: 40 });
    show('map alias (tight budget)', tight);
    assert(tight.includes('files omitted'), `tight map omits:\n${tight}`);
  }
  return 'fitted overview + budget cutoff on the installed surface';
});
await scenario('ffcapsule dossier + capsule alias', async () => {
  const out = await callTool('ffcapsule', { symbol: 'parseFindQuery', cwd: tree });
  show('ffcapsule', out);
  assert(out.includes('server.py'), `dossier touches server.py:\n${out}`);
  assert(out.includes('Guidance:'), `dossier guides:\n${out}`);
  if (tools.has('capsule')) {
    const alias = await callTool('capsule', { symbol: 'parseFindQuery', cwd: tree });
    show('capsule alias', alias);
    assert(alias.includes('server.py'), `capsule alias diverged:\n${alias}`);
  }
  return 'fused dossier + guidance on the installed surface';
});

// ------------------------------------------------- full-surface coverage gate
const uncoveredTools = [...tools.keys()].filter((t) => !calledTools.has(t));
if (uncoveredTools.length > 0) {
  results.push({ name: 'surface coverage (all registered tools exercised)', ok: false, detail: `never dispatched: ${uncoveredTools.join(', ')}` });
  console.log(`FAIL surface coverage (all registered tools exercised)\n  never dispatched: ${uncoveredTools.join(', ')}`);
} else {
  results.push({ name: 'surface coverage (all registered tools exercised)', ok: true, detail: `${calledTools.size}/${tools.size} tools dispatched` });
  console.log('PASS surface coverage (all registered tools exercised)');
}
for (const c of commands.keys()) {
  // Both commands are invoked above; this guards future commands added without a scenario.
  if (c !== 'find-health' && c !== 'find-rescan') {
    results.push({ name: `command coverage (${c})`, ok: false, detail: 'registered but has no scenario' });
    console.log(`FAIL command coverage (${c})\n  registered but has no scenario`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
await rm(simRoot, { recursive: true, force: true }).catch(() => {});
if (failed.length > 0) process.exit(1);
