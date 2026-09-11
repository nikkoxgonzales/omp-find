# OMP extension manual — how to build a nice one

Distilled from the OMP host contract
(`oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts`,
`src/extensibility/plugins/types.ts`), samples (`pi-mono` `tool-override.ts` +
`pi-example-plugin`, `pi-blackhole` `recall.ts` + `tests/`), and fff port patterns
(`crates/fff-core/src/score.rs`, `crates/fff-query-parser/src/parser.rs`).
omp-find (`docs/extension.md`) is the worked example; items marked [GAP] are things
it doesn't do yet (see `docs/fff-findings.md` steal list).

## 1. Scaffold layout

```
pkg/
  package.json            # omp/pi manifest + version (single source of truth)
  tsconfig.json
  src/
    core.ts               # pure logic: parsing, ranking, filtering (no host imports)
    tools.ts              # registerFindTools(pi, deps, opts): tool defs + execute
    commands.ts           # registerXCommands(pi, deps): slash commands
    frecency.ts / notes.ts# state modules (Node builtins only)
    extension.ts          # default-export factory: wire everything, nothing else
  test/
    find.mjs              # node:test suite (see §8)
    fixtures.mjs          # shared tmp-tree builders (see §8)
  dist/                   # committed build output (see §7)
  .omp-plugin/
    marketplace.json      # marketplace wrapper (see §6)
  docs/                   # findings + as-built + this manual
  README.md               # tool cards + verify (see §6)
```

Rules: core modules never import the host; `tools.ts`/`commands.ts` take `pi: any`
(or typed `ExtensionAPI`) + a deps bag; `extension.ts` only wires.

## 2. Entry: default-export factory, fail loudly

```ts
export default function myExtension(pi: ExtensionAPI): void {
  registerMyCommands(pi, deps);
  registerMyTools(pi, deps, opts);
  pi.on("session_start", () => void warmUp(deps)); // underscore form — verify!
}
```

- Default-export factory `(pi: ExtensionAPI) => void | Promise<void>` is the contract
  (`types.ts: ExtensionFactory`). Hello-world: `pi-mono …/examples/extensions/hello.ts`.
- [GAP] Prefer static imports over dynamic-import-with-silent-catch wiring: a failed
  import should fail load, not leave tools silently unregistered. Best-effort
  `try/catch → return` around registration hides total breakage.
- [GAP] Verify event names against `types.ts` (`session_start`, not `session-start`).
  A wrong name means the handler never fires and nothing tells you.

## 3. Tools: single-object registration + coaching cards

Canonical arity is **one object** (`types.ts:1299`):

```ts
pi.registerTool({
  name: "fffind",
  label: "Find files",
  description: "…imperative, teaches query style in one line…",
  parameters: { type: "object", properties: { …per-field descriptions… } },
  approval: "read",                    // [GAP] read-only tools must say so
  promptGuidelines: ["Keep queries SHORT — 1-2 terms; …"],  // [GAP]
  execute: async (toolCallId, params, signal, onUpdate, ctx) => ({ content, details }),
});
```

- Result shape: `{ content: [{ type: "text", text }], details }` (never throw
  user-facing errors — return guidance text; cf. `tool-override.ts` blocked-path
  response). omp-find's `"fffind failed: …"` / `"No matches found"` convention is
  correct; extend with zero-state counts (`0 matches (N files scanned, rg|walker)`,
  fff `0 results (N indexed)`).
- Model card: `pi-blackhole src/tools/recall.ts:308–…` — long imperative description +
  `promptGuidelines[]` + per-field TypeBox descriptions + `PAGE_SIZE` paging. Copy it.
- Overriding builtins: register the same name (`tool-override.ts` registers `read`);
  document override-vs-additive explicitly and make override the deliberate default
  with an env/file opt-out (omp-find: flag > `OMP_FIND_MODE` > `omp-find.json` >
  default).

## 4. Commands + config

- `pi.registerCommand(name, { description, handler })`; handler `(args, ctx)` uses
  `ctx.ui.notify(text, kind)` — never `console.log`. Health commands report **facts**
  (backend version/presence, entry counts, store paths) with ok/warn/error levels
  (fff `health.lua`); [GAP] never tautologies (`ok (no status reported)`).
- Plugin settings belong in `package.json` under `omp`/`pi` as a typed schema
  (`PluginSettingSchema`: string/number/boolean/enum, defaults, env fallback —
  `plugins/types.ts:57–…`). Project-local JSON files (`omp-find.json`) are a
  stopgap, not the pattern.

## 5. Manifest + marketplace + README + versions

- `package.json`: `main`/`exports` → `./dist/extension.js`; `files: ["dist"]`;
  `omp` **and** `pi` keys each list `./dist/extension.js`; `engines: node >= 22`.
- `.omp-plugin/marketplace.json`: wrapper (`name`/`owner`/`metadata`/`plugins[]`);
  **version mirrors `package.json` in lockstep** (both 0.8.7 today).
- README must contain: one-line why, agent-visible tool cards (names, params,
  error/zero-state wording), query-syntax table, config precedence list, install +
  `/find-health` verify step, dev (`npm test`) + dist-committed note.

## 6. Zero-deps, host-native, no-daemon

Node builtins only (`node:fs`, `node:path`, `node:child_process`, `node:crypto`,
`node:os`); external binaries (`rg`, `git`) via `execFile` with ENOENT fallback and
wall-clock timeouts — never assume presence. No watcher/LMDB/picker/MCP server:
fresh scan per call, JSON state beside the tree, OS page cache as the only cache.

## 7. dist-committed

Plugin installs load `dist/extension.js` with no build step, so `dist/` is committed.
`npm test` = `tsc -p tsconfig.json && node --test …` (build-then-test, never
test-against-stale-dist).

## 8. Tests: node:test + fixtures + fake-pi, never the host

Stay on **node:test** (zero deps; vitest buys nothing here). From `pi-blackhole`
steal the *habits* (shared fixture module, pure-core exports, 10 s timeouts), not the
runner:

- `test/fixtures.mjs`: `makeTree(structure)` tmp-dir builders shared by all suites;
  never the real repo tree.
- `test/*.mjs`: fake host (`{registerTool, registerCommand, on}` maps — never import
  the real omp/pi host); table-driven cases; injected clocks (decay/math), never
  sleep; PATH-shim test for binary-missing fallback.
- Port upstream cases 1:1 with source comments:
  `// fff score.rs: test_exact_filename_beats_fuzzy_filename`. Port pure logic
  (scoring, query parse, ranking) and edge suites (dotdirs, separators, depth,
  symlink, EACCES, 2 MB/binary/invalid-utf8 skips, timeout text) — never
  watcher/index/fuzz, lua specs, or binary e2e.
- Export pure cores testably (`fuzzyScore`, `parseFindQuery`, `globToRegExp`) —
  test-only exports, no API change.
- Coverage gate: **85%** (see `coverage worker` Sj–5 series in f10): per-file
  `c8`-measured thresholds enforced in CI; new code without tests fails the gate.

## 9. Checklist for a new extension

1. Scaffold per §1; factory per §2 (static imports, verified event names).
2. Tool cards per §3 (single object, `approval`, guidelines, per-param docs).
3. Commands notify, never log; health reports facts (§4).
4. Settings schema in `package.json`; marketplace wrapper; README cards + verify (§5).
5. Zero runtime deps; binaries optional with fallback + timeout (§6).
6. `dist/` committed; build-then-test (§7).
7. Fixtures + fake-pi + ported tables; 85% gate (§8).
