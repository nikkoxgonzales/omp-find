# fff + OMP findings for omp-find

fff ref: https://github.com/dmtrKovalenko/fff.nvim —
local ref at `C:/Users/nikko/Desktop/cc/f10/.temp/references/fff`,
commit `d84c0a10` (2026-08-31, "omit git:clean from find_files output (#845)").
OMP host + samples: local refs under `C:/Users/nikko/Desktop/cc/f10/.temp/references/`
(`oh-my-pi`, `pi-mono`, `pi-blackhole`). No `src/` changes.

## 1. fff test harness inventory

- **Harness:** Rust workspace (`cargo test`), 6 crates (`fff-core`, `fff-query-parser`,
  `fff-grep`, `fff-nvim`, `fff-mcp`, `fff-c`, `fff-python`). Unit tests inline
  (`#[test]` in `src/*.rs`: `score.rs`, `parser.rs`, `frecency.rs`, `grep_tests.rs`);
  integration tests in `crates/fff-core/tests/*.rs` (~25 files, real temp-dir fixtures,
  incl. proptest/fuzz regressions). Lua side: `tests/*_spec.lua` under a Neovim harness
  (plenary/busted style — **not portable**, needs live nvim + built `.so`). Node side:
  `packages/fff-node/test/{e2e,watch}.mjs` via plain node (portable in spirit).
  `Makefile` targets: `test-rust`, `test-lua`, `test-node`, `test-c-api`.
- **What's tested:** query parsing (extension/dir-segment/git-status/negation/escape/
  grep-text); scoring (filename-beats-path, exact-beats-fuzzy, no-false-exact,
  separator-disables-bonus, closer-wins, typo-tolerance, >512B no-panic);
  frecency calc + modification-score interpolation; grep classifier/prefilter/
  multi-pattern + overflow/invalid-utf8/binary regressions; walker edge cases
  (dotdir globs, separators, binary fixtures); plus **not portable**:
  watcher/LMDB/git-worker/fuzz suites (`rescan_*`, `fuzz_*`, `lmdb_*`, `watch_*`,
  bigram overlay) — index/watcher machinery we deliberately lack. (The bigram filter
  itself is fff's *indexed* prefilter; no equivalent in live-scan.)

### Adapt list (5 items, all → `test/find.mjs`, node:test)

1. **Query-parser table tests → `describe('parseFindQuery')`:** extension token, `dir/`
   prefix, trailing slash, `git:modified` + aliases, `!` negation (text/ext/path/git),
   backslash escape, multi-word fuzzy remainder. Pure function, zero fixture cost.
   (Source: `crates/fff-query-parser/src/parser.rs` tests, ~20 cases.)
2. **Score ranking tests → `describe('fuzzyScore/rank')`:** filename-beats-path,
   exact-beats-fuzzy, same-length no-false-exact, separator-disables-bonus,
   closer-file-wins, typo-tolerance, overlong-path no-throw. Requires exporting
   `fuzzyScore` (or a `rankPaths` helper) from `search.ts` — test-only export, no API
   change. (Source: `crates/fff-core/src/score.rs` tests, ~15 cases.)
3. **Frecency calc → `describe('frecency')`:** fixed count/last ⇒
   `count × 0.5^(age/half-life)`; unknown path scores 0; `recordOpen` bumps. Inject
   `now` — never sleep. (Source: `crates/fff-core/src/dbs/frecency.rs` tests.)
4. **Grep bounds → `describe('grepContents bounds')`:** 2 MB skip, 20k cap,
   invalid-utf8/binary no-crash, timeout rejection message, rg-missing falls back to
   walker (PATH shim). Temp-dir fixtures via `mkdtemp` (already the `find.mjs`
   pattern). (Source: `src/grep/*` tests + `tests/grep_integration.rs`.)
5. **Walker edges → `describe('walkFiles')`:** dotdir inclusion, win32 separator
   normalization, max-depth stop, symlink no-follow default, permission-denied dir
   doesn't abort. Small synthetic trees. (Source: `dotdir_glob_constraint`,
   `path_separator_constraint`, `invalid_utf8_paths`, `real_binary_fixtures`.)

## 2. fff extension niceties: KEEP / ADAPT / REJECT

**KEEP** (already mirror; don't regress): fresh-scan + frecency re-rank core;
rg-first/walker-fallback; `git:modified` via porcelain; runaway-tree guard (ours
refuses fs-root/home; fff has `enable_fs_root_scanning` flags — same idea, safer
default); cursor pagination + override/additive mode + config-precedence shape;
dist-committed + zero-deps + Node ≥ 22 (our equivalent of fff's prebuilt binaries).

**ADAPT:**

- **MCP tool-copy discipline.** fff `find_files` description teaches in one line
  ("Keep queries SHORT — 1-2 terms; waterfall NOT OR; exact match → read directly") +
  best-match directive (`→ Read X (best match)`) + zero-state counts (`0 results (N
  indexed)`). Our descriptions are reference-style; steal the imperative query-coaching
  sentence + zero-state counts. (`crates/fff-mcp/src/server.rs`)
- **Grep defaults.** fff grep auto-detects regex-vs-plaintext (`has_regex_metacharacters`)
  instead of a literal flag, plus context param + output modes. Our `literal` flag is
  fine, but auto-detect-with-override and `contextBefore/After` are adaptable at zero
  philosophy cost.
- **Health depth.** fff `health.lua` reports per-subsystem (initialized?, db path, disk
  size, healthy?) with ok/warn/error levels. Our `/find-health` prints two
  "ok (no status reported)" lines — adapt to real values: rg present? version, walker
  fallback active?, frecency entries count + store path.
- **Query auto-retry.** fff `find_files` retries 3+-word zero-result queries with the
  first 2 terms. Cheap pure logic, adaptable in `findPaths` or the tools layer (one
  output line noting the relaxation).

**REJECT** (philosophy fit): watcher/LMDB/bigram index + rescan throttle/stats
(short-lived agent sessions; lying caches cost more than fresh rg); picker UI
(`lua/fff/picker_ui/*`, layout/preview/keymaps — Nvim-only, OMP has no picker
surface); MCP server crate + `install-mcp.sh` (we register host tools directly);
multi-binding packages (`fff-node`/`fff-bun`/`fff-python`/`fff-c`, `sync-js-api` —
single host needs one entry).

## 3. OMP extension best practices

- **ExtensionAPI** (`oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts`):
  default-export factory `(pi: ExtensionAPI) => void | Promise<void>`;
  `pi.registerTool({name,label,description,parameters,execute})` — **single-object
  arity**, not `(name, def)`; `pi.registerCommand(name, {description, handler})` with
  `(args, ctx)` and `ctx.ui.notify(text, kind)`; events via `pi.on('session_start' |
  'session_shutdown' | …)` — **underscore form** (verify ours!); tool result shape
  `{content:[{type:'text',text}], details}`; `ToolDefinition` extras: `approval` tier
  (`'read'` for our tools), `loadMode`, `promptGuidelines`, `hidden`/`defaultInactive`.
- **Manifest:** `PluginManifest` lives in `package.json` under the `omp`/`pi` field
  (`extensions`, `tools`, `commands`, `settings` with typed string/number/boolean/enum
  schema incl. env fallback + defaults, `features`). Ours uses `package.json`
  `omp.extensions` correctly; `.omp-plugin/marketplace.json` is the marketplace
  wrapper (`name`/`owner`/`metadata`/`plugins[]`) — keep both; future knobs belong in
  `package.json` settings schema, not `omp-find.json`.
- **Samples:** `pi-mono …/examples/extensions/tool-override.ts` — canonical override
  pattern (same-name `registerTool('read')`, blocked-path guard returning guidance
  text not throws, file-mutation queue for logging, companion `/read-log` command).
  Direct template for our find/grep override. `pi-blackhole src/tools/recall.ts` —
  model tool card (long imperative description + `promptSnippet` + `promptGuidelines[]`,
  TypeBox params with per-field descriptions, `PAGE_SIZE = 5` paging with `page`
  param, pure testable cores `mergeExpandedIntoSearchResults`/`invalidExpandIndices`
  exported + thin register wrapper). Copy at file level. `pi-blackhole tests/` —
  vitest, `tests/**/*.test.ts`, 10 s timeout, shared `vcc-fixtures.ts`, upstream-port
  headers; steal fixture-module + pure-core habits, not the runner.
- **Nice-extension shape:** `dist/extension.js` default-export factory; `src/` split
  core/tools/commands(/settings); `package.json` omp+pi extensions + settings schema;
  README with tool cards + query syntax + config precedence + verify step; version bump
  `package.json` + `marketplace.json` in lockstep; tests hit pure cores, never the host
  (fake-pi already correct).

## 4. Ranked steal list (concrete file-level changes)

1. **Tool cards that coach** (`src/tools.ts`): extend find/grep defs with
   `approval:'read'`, `promptGuidelines` (1–2 imperative lines each, fff-MCP wording:
   short queries, waterfall-not-OR, bare identifiers), richer per-param descriptions;
   register via single-object arity (+ keep `(name,def)` shim only if host compat
   demands — re-check host signature; OMP canonical is one object). Update README
   "agent sees" block to match. *Why: cheapest token-efficiency win.*
2. **Port score.rs + parser.rs unit tests** (`src/search.ts` + `test/find.mjs`):
   export `fuzzyScore` (or `rankPaths`) with zero behavior change; new describes per
   adapt items 1–2, cases commented with fff source names. *Why: locks our two
   differentiators with upstream-proven cases; pure functions, no fixtures.*
3. **`/find-health` that reports facts** (`src/search.ts:status`,
   `src/frecency.ts:status`, `src/commands.ts:healthText`): real values — rg
   version/presence + walker mode; frecency entry count + store path. rg missing =
   warn, not error (fff `health.lua` levels). *Why: today it prints two tautologies.*
4. **Auto-retry + informative zero-states** (`src/search.ts:findPaths` or tools find
   execute; grep execute): 3+-word zero-result query retried once with first 2 terms
   (noted in output); zero-state `0 matches (N files scanned, rg|walker)` mirroring
   fff `0 results (N indexed)`. *Why: recovers the top agent failure in the same call.*
5. **ffgrep context lines** (`src/search.ts:GrepOptions` + `tools.ts` grepDef):
   `contextBefore/contextAfter` (cap 5); rg path passes `-B`/`-C`, walker slices;
   cursor state carries them; context lines marked distinctly. (Dual-justified by the
   Serena workstream.) *Why: disambiguates without a follow-up read; bounded cost.*
6. **Fixture-module + bounds/edge suites** (`test/find.mjs` → `test/fixtures.mjs`):
   extract `makeTree(structure)`; add walker-edge suite (dotdirs, separators, depth,
   symlink, EACCES) + grep-bound suite (2 MB skip, binary/invalid-utf8, timeout text,
   no-rg PATH-shim fallback) + frecency decay with injected clock. Stay on node:test.
   *Why: our suite covers happy paths; breakage lives in big/binary/denied/deep.*
7. **Extension-entry hygiene audit** (`src/extension.ts`): verify `pi.on` event name
   against host (`session_start` per types.ts vs our `session-start`); drop the
   string-typed dynamic-import dodge (core has landed — import statically, fail loudly
   at load); keep honest `rescanText` wording. *Why: scaffold-era silent
   catch-and-skip risks tools never registering.*

## 5. Test-pattern recommendations (for the coverage worker)

Stay on **node:test** (zero deps — vitest buys nothing here). Rules: pure cores
exported testably (`fuzzyScore`, `parseFindQuery`, `globToRegExp`, merge-style
helpers); table-driven cases ported 1:1 from `score.rs`/`parser.rs` with source
comments (`// fff score.rs: test_exact_filename_beats_fuzzy_filename`); temp-dir
fixtures via shared `fixtures.mjs`, never the real repo tree; time via injected now,
never sleep; PATH-shim test for no-rg fallback; host never imported (fake-pi only).
Do NOT port: watcher/lmdb/fuzz/proptest, lua specs, binary e2e.

## Refs

- fff: `crates/fff-core/{src/score.rs, src/dbs/frecency.rs, src/grep/*, tests/}`,
  `crates/fff-query-parser/src/{parser,constraints}.rs`,
  `crates/fff-mcp/src/server.rs` (find_files/grep/multi_grep),
  `lua/fff/{conf.lua,health.lua}`, `tests/fff_core_spec.lua`,
  `packages/fff-node/{package.json,test/}`, `Makefile` (test-* targets).
- OMP: `oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts`
  (ToolDefinition, ExtensionAPI, registerTool/registerCommand),
  `src/extensibility/plugins/types.ts` (PluginManifest, settings schema),
  `examples/extensions/{hello,tools,api-demo}.ts`.
- Samples: `pi-mono …/examples/extensions/tool-override.ts`,
  `…/examples/plugins/pi-example-plugin/{package.json,README.md}`;
  `pi-blackhole src/tools/recall.ts`, `package.json`, `vitest.config.ts`,
  `tests/clipboard.test.ts`.
