import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;

let findTools, extension;
before(async () => {
  findTools = await import(dist('tools.js'));
  extension = await import(dist('extension.js'));
});

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function fullStubSearch() {
  return {
    findPaths: async () => [],
    grepContents: async () => ({ matches: [] }),
    outlineFile: async () => ({ symbols: [] }),
    callersOf: async () => ({ refs: [] }),
    structuralGrep: async () => ({ matches: [] }),
    rankMap: async () => ({ files: [] }),
    capsuleOf: async () => ({}),
  };
}
const stubFrecency = { score: async () => 0, recordOpen: async () => {} };

function extensionPi() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    tools,
    handlers,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    toolCall(event) {
      const fns = handlers.get('tool_call') ?? [];
      assert.ok(fns.length > 0, 'tool_call handler wired');
      return fns[0](event);
    },
  };
  return pi;
}

describe('guard: fails open before registration', () => {
  it('early-return and throwing hosts leave the flag false and pass everything', () => {
    assert.equal(findTools.isFindToolsReady(), false);
    findTools.registerFindTools({ registerTool() {} }, {}, {});
    assert.equal(findTools.isFindToolsReady(), false);
    const handlers = new Map();
    const pi = {
      registerTool() { throw new Error('tool-down'); },
      registerCommand() {},
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
      },
    };
    assert.doesNotThrow(() => extension.default(pi));
    const fns = handlers.get('tool_call') ?? [];
    assert.ok(fns.length > 0, 'guard subscribes even when tools are down');
    // Pure detection still fires, but the wired handler must fail open on the flag.
    assert.ok(findTools.decideBashSearchBlock("grep -rn 'x' a.py") !== undefined);
    assert.equal(fns[0]({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: "grep -rn 'x' a.py" } }), undefined);
  });
});

describe('guard: loadMode tiers', () => {
  it('fffind/ffgrep/ffjfind (+ jfind/find/grep) are essential; the rest stay as-is', () => {
    const pi = { tools: new Map(), registerTool(tool) { this.tools.set(tool.name, tool); } };
    findTools.registerFindTools(pi, { search: fullStubSearch(), frecency: stubFrecency }, { mode: 'override' });
    for (const name of ['fffind', 'ffgrep', 'ffjfind', 'jfind', 'find', 'grep']) {
      assert.equal(pi.tools.get(name)?.loadMode, 'essential', `${name} essential`);
    }
    for (const name of ['ffoutline', 'ffcallers', 'ffstructural', 'ffmap', 'ffcapsule']) {
      assert.equal(pi.tools.get(name)?.loadMode, undefined, `${name} untouched`);
    }
    assert.equal(findTools.isFindToolsReady(), true);
  });
});

describe('guard: blocks code-search shell-outs', () => {
  it("blocks grep -rn with an ffgrep+pattern message", () => {
    const pi = extensionPi();
    extension.default(pi);
    const res = pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: "grep -rn 'x' a.py b.py | head -15" } });
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? '', /ffgrep/);
    assert.match(res?.reason ?? '', /pattern/);
  });

  it('blocks rg, sudo grep, and pipe-to-grep chains', () => {
    assert.match(findTools.decideBashSearchBlock('rg foo')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('rg -i foo src')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('sudo grep -r foo .')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('sudo sudo rg foo')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('cat file.txt | grep foo')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('cat *.ts | grep foo')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('cat file | sudo grep foo')?.message ?? '', /ffgrep/);
    assert.match(findTools.decideBashSearchBlock('grep foo')?.message ?? '', /ffgrep/);
    const pi = extensionPi();
    extension.default(pi);
    assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'rg foo' } })?.block, true);
  });

  it('blocks egrep/fgrep, xargs grep, and wrapper/env-prefixed searches', () => {
    for (const cmd of [
      'egrep foo',
      'fgrep foo bar',
      'xargs grep foo',
      'xargs -I{} egrep foo',
      'FOO=1 grep x',
      'FOO=1 BAR=2 rg x',
      'time grep x',
      'sudo -E grep x',
      'env FOO=1 grep x',
      'nice -n5 rg foo',
      'command grep x',
    ]) {
      assert.match(findTools.decideBashSearchBlock(cmd)?.message ?? '', /ffgrep/, `block: ${cmd}`);
    }
  });

  it('blocks grep pipes only behind file-content/file-listing producers', () => {
    for (const cmd of [
      'cat f | grep x',
      'ls | grep x',
      'find . | grep x',
      'sort f | grep x',
      'jq . f | grep x',
      'head -5 f | grep x',
      'awk "{print}" f | grep x',
      'cat list | xargs grep foo',
    ]) {
      assert.match(findTools.decideBashSearchBlock(cmd)?.message ?? '', /ffgrep/, `block: ${cmd}`);
    }
  });

  it('blocks find -name variants and ls -R with an fffind message', () => {
    assert.match(findTools.decideBashSearchBlock('find . -name "*.ts"')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('find src -iname "*.TS"')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('find . -path "*node*"')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock("find . -ipath '*src*'")?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock("find . -regex '.*\\.ts'")?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock("find . -wholename '*src*'")?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('ls -R')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('ls -lR src')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('ls --recursive')?.message ?? '', /fffind/);
    assert.match(findTools.decideBashSearchBlock('sudo find . -name x')?.message ?? '', /fffind/);
    const pi = extensionPi();
    extension.default(pi);
    assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'find . -name "*.ts"' } })?.block, true);
  });
});

describe('guard: passes builds and plain shells', () => {
  it('passes git/docker/npm/pip/cargo/go/make verbs and bare ls/find', () => {
    const pass = [
      'git grep foo',
      'git log --grep=foo',
      'ls',
      'ls -la',
      'npm test | grep foo',
      'docker ps | grep foo',
      'pip install foo | grep bar',
      'pip3 list | grep foo',
      'cargo test | grep foo',
      'go test ./... | grep foo',
      'make test | grep foo',
      'find . -type f',
      'echo hi',
      'npm test',
      'echo hi || grep foo',
      'echo hi; grep foo bar',
      'cat file.txt',
    ];
    for (const cmd of pass) {
      assert.equal(findTools.decideBashSearchBlock(cmd), undefined, `pass: ${cmd}`);
    }
    const pi = extensionPi();
    extension.default(pi);
    assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'git grep foo' } }), undefined);
    assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'ls' } }), undefined);
    assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'npm test | grep foo' } }), undefined);
  });

  it('passes grep pipes behind non-producer first stages', () => {
    const pass = [
      'ps aux | grep firefox',
      'kubectl get pods | grep api',
      'history | grep ssh',
      'yarn test | grep foo',
      'docker-compose logs | grep err',
      'curl https://example.com | grep title',
      'git log | grep foo',
      'env | grep PATH',
      'sudo -u root grep x',
    ];
    for (const cmd of pass) {
      assert.equal(findTools.decideBashSearchBlock(cmd), undefined, `pass: ${cmd}`);
    }
  });

  it('passes tail-follow pipes, quoted pipes, and find action flags', () => {
    const pass = [
      'tail -f app.log | grep err',
      'tail -F app.log | grep err',
      'tail --follow app.log | grep err',
      'echo "a | grep b"',
      "printf 'x|y' | wc -c",
      'find . -name "*.o" -delete',
      'find . -name x -exec rm {} +',
      'find . -name x -execdir rm {} +',
      'find . -name x -ok rm {} \\;',
    ];
    for (const cmd of pass) {
      assert.equal(findTools.decideBashSearchBlock(cmd), undefined, `pass: ${cmd}`);
    }
  });

  it('OMP_FIND_GUARD=off|0|false|no passes everything', () => {
    const pi = extensionPi();
    extension.default(pi);
    withEnv({ OMP_FIND_GUARD: 'off' }, () => {
      assert.equal(findTools.isFindGuardEnabled(), false);
      assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: "grep -rn 'x' a.py" } }), undefined);
      assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'rg foo' } }), undefined);
      assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'find . -name x' } }), undefined);
    });
    assert.equal(findTools.isFindGuardEnabled(), true);
    for (const off of ['OFF', ' off ', '0', 'false', 'FALSE', 'no', 'No']) {
      withEnv({ OMP_FIND_GUARD: off }, () => assert.equal(findTools.isFindGuardEnabled(), false, `off: ${off}`));
    }
    withEnv({ OMP_FIND_GUARD: '0' }, () => {
      assert.equal(pi.toolCall({ type: 'tool_call', toolName: 'bash', toolCallId: '1', input: { command: 'grep foo' } }), undefined);
    });
    withEnv({ OMP_FIND_GUARD: 'on' }, () => assert.equal(findTools.isFindGuardEnabled(), true));
    withEnv({ OMP_FIND_GUARD: '1' }, () => assert.equal(findTools.isFindGuardEnabled(), true));
    withEnv({ OMP_FIND_GUARD: undefined }, () => assert.equal(findTools.isFindGuardEnabled(), true));
  });

  it('malformed events fail open without throwing', () => {
    const pi = extensionPi();
    extension.default(pi);
    const cases = [
      undefined,
      null,
      {},
      { toolName: 'bash' },
      { toolName: 'bash', input: null },
      { toolName: 'bash', input: {} },
      { toolName: 'bash', input: { command: undefined } },
      { toolName: 'bash', input: { command: 123 } },
      { toolName: 'bash', input: { command: '' } },
      { toolName: 'bash', input: { command: '   ' } },
      { toolName: 'bash', input: { command: 'sudo ' } },
      { toolName: 'read', input: { path: 'x' } },
      { toolName: 'read', input: { command: 'grep foo' } },
    ];
    for (const event of cases) {
      assert.doesNotThrow(() => {
        assert.equal(pi.toolCall(event), undefined);
      });
    }
    assert.equal(findTools.decideBashSearchBlock(undefined), undefined);
    assert.equal(findTools.decideBashSearchBlock(123), undefined);
    assert.equal(findTools.decideBashSearchBlock(''), undefined);
    assert.equal(findTools.decideBashSearchBlock('   '), undefined);
    assert.equal(findTools.decideBashSearchBlock('sudo '), undefined);
  });
});
