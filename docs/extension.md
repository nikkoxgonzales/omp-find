# omp-find extension — as-built reference

Grounds every claim in `src/*.ts`, `package.json`, `.omp-plugin/marketplace.json`,
`README.md` (v0.8.9). No proposals here — see `serena-findings.md` / `fff-findings.md`.

## Layout

| File | Owns |
|---|---|
| `src/search.ts` (337 lines) | `parseFindQuery`, `globToRegExp`, `findPaths`, `grepContents`, `warmScan`, `status`, `clearCache`; consts `PAGE_DEFAULT=30`, `PAGE_MAX=50` (line 5), `RG_BUFFER=64MB`, `GREP_CAP=20000`, `MAX_DEPTH=25` (line 6), `MAX_GREP_BYTES=2MB` / `MAX_GREP_SIZE="2M"` (8), `GREP_TIMEOUT_DEFAULT=30000` (10) |
| `src/tools.ts` (~1300 lines) | `resolveFindMode`, `registerFindTools`, cursor store (`cursors`, `storeCursor`, 200-entry cap), `applyPathFilter`, `strictStrParam`/`numParam` param validation, `safeRecordOpen` |
| `src/frecency.ts` (~210 lines) | `storePath`, `keyOf`, `recordOpen`, `score`, `status`, `clear`; `HALF_LIFE_MS` 7 days (line 8) |
| `src/extension.ts` (~62 lines) | Default-export factory; static imports (fail loudly at load); `session_start` warm scan; `tool_result` frecency feed (read/edit/write opens) |
| `src/commands.ts` (~92 lines) | `/find-health`, `/find-rescan` via deps bag |
| `test/find.mjs` | node:test suite (`npm test` = `tsc` build + `node --test`) |
| `dist/` (committed) | Built output; plugin entry `dist/extension.js` |

## Tools

- **`fffind`** — fuzzy file-path search. `registerFindTools` (`tools.ts:90–148`):
  joins `path` + `pattern` params into one query string (127); empty query → error
  text, not throw (128); `findPaths(query, {cwd, limit: PAGE_MAX, offset: 0})` fetches
  up to 50, frecency re-ranks (`safeScore` per path, stable sort `b.s - a.s`, 134–135),
  then slices the requested page. A concrete `path`-param pin (`dir/` or `dir/file`)
  additionally scopes the listing (`scope` through `listFiles`), so pinned dot-dir
  files list on both backends. Unknown/expired cursor → error text naming the
  cursor (123); all throws caught → `"fffind failed: …"` (145).
- **`ffgrep`** — content search (`tools.ts:150–207`). `pattern` required unless resuming with `cursor` (177);
  `literal` defaults true (179), `ignoreCase` opt-in (180). Path filter applies
  **tools-side over the full result set**: unfiltered queries pass limit/offset to
  `grepContents`; filtered ones fetch all then filter + slice (188–194) — a bounded
  fetch first would drop hits outside the page (comment 186–187). A concrete
  `dir/` or `dir/file` pin additionally scopes the backend itself (`scope` through
  `rgGrep`/`fallbackGrep`/`listFiles`: rg gets the pin as its positional path, the
  walker seeds traversal at the pin), so explicitly-pinned hidden/ignored files hit
  on both backends; glob and bare-basename forms keep the post-filter only. Row format
  `path:line:col: text` (195); grep pages are path/line/col ordered on both backends, totals are stable.
  Same cursor/error conventions as fffind. Page rows
  group by file under `[path#TAG]` hashline headers (`hashlineFileHash` /
  `hashlineHeader` next to `toDisplay`; whole-file tag read once per file per
  call via `hashlineTagsFor`, backend-agnostic; unreadable files render bare).
- **Output envelope** — every execute returns `{content, details:
  {totalMatched, totalFiles, truncated}}` (pi-fff packaging; totals over the full
  result set, `truncated` when a next page or count-fallback applies). Each def
  carries a one-line `promptSnippet` (guidelines unchanged); paged results add a
  `"<limit> matches limit reached (max 50) — more via cursor"` notice next to the cursor footer.
- **Override vs additive** (`tools.ts:94–95, 208–213`): `fffind`/`ffgrep` always
  registered; `override` (default) additionally claims `find`/`grep` with the same
  handlers. Dual-arity `register` shim (99–103): single-object if host takes 1 arg,
  `(name, tool)` if it takes 2.

## Commands

- **`/find-health`** (`commands.ts:79–85`): notifies `find status` + `index:` line from
  `search.status()` and `frecency:` line from `frecency.status()`, each with
  `ok (no status reported)` / `error (…)` fallbacks (24–52). `search.status()` today
  reports `rg --version` presence + `index: none (direct scan, no watcher)`
  (`search.ts:251–256`), plus a `session:` stats block from the tools module
  (`sessionStatsText`: calls per tool, rg-vs-walker mix, timeouts, avg ms —
  in-memory counters, `session: 0 calls` when cold).
- **`/find-rescan`** (`commands.ts:86–91`): calls `search.clearCache()` (currently a
  no-op resolve, `search.ts:258`) + `frecency.clear()` (drops persisted store + memory
  cache), then `resetSessionStats()` (in-memory counters go to zero); reports
  `caches dropped: …` or `caches dropped (nothing cached)` (55–77).

## Config precedence

`resolveFindMode` (`tools.ts:32–44`): explicit flag > `OMP_FIND_MODE` env
(`additive`|`override`, case-insensitive) > `"mode"` in `omp-find.json` at project
root (missing/unparseable → ignore) > built-in default **`override`**.
(`README.md:84–95`.)

Tool tier: `resolveFindToolsTier` — explicit `tools` option > `OMP_FIND_TOOLS`
env (`core`|`full`, case-insensitive, unknown → `core`) > built-in default
**`core`**. Core is the full surface as it stands; `full` adds nothing today
and is reserved for future tools so the default stays lean.

## Frecency

Per-project JSON (`frecency.ts:20–28`): `%LOCALAPPDATA%/omp-find` on win32, else
`~/.omp/var/omp-find`, keyed by 16-hex-char sha1 of resolved cwd (`projectHash`, 16–18).
Keys canonicalized in `keyOf` (45–69): selectors stripped (`:N`, `:N-M`, `:raw`,
`?q=`, `#tag`), non-file URIs (`xd://`, `artifact://`, `https://`, …) skipped,
`file://` unwrapped, separators `/`, cwd-relative when inside the project.
`recordOpen` bumps count + recency — fed by the extension's `tool_result` hook
(successful `read`/`edit`/`write`
results with a string `input.path`) and by the tools layer itself (`ffoutline`
records its file, `ffcapsule` records the resolved def file — both
fire-and-forget via `safeRecordOpen`).
Persist is atomic (sidecar write + fsync, then copyFile over live — never
rename-over-live on Windows, 45–58). `clear()` drops store + memory cache. Never
throws (`recordOpen`/`score`/`clear` all swallow). Writes serialize through an
in-process queue (parallel `recordOpen` calls no longer lose bumps); across
processes each save re-reads the file and merges per key (max count, max last)
instead of last-writer-wins — no lock, so simultaneous same-key bumps can
still under-count. `clear()` also stamps a `clearedAt` tombstone in the store
file; merge-on-save drops entries last-touched before the newest tombstone on
both sides, so a stale in-memory cache can't resurrect cleared keys. Stores
written before the tombstone existed (no `clearedAt`) load unchanged.

## Pagination

Default 30, max 50, enforced in two places: `numParam` clamps tool params
(`tools.ts:59–62`) and `pageOf` clamps core limit/offset (`search.ts:60–65`).
`fffind`/`ffgrep` return opaque cursors (`find_cN`/`grep_cN`, `storeCursor` 22–30,
200-entry cap with oldest eviction) capturing full query state (query/limit/offset/cwd;
pattern/literal/ignoreCase/pathFilter/…). Footer when more remain:
`... (N more; pass cursor "…" for the next page)` (`tools.ts:139–142, 196–201`).
Cursors bind to the fetched snapshot (`total` + `backend`, gograph query contracts): resume re-fetches and compares, so a tree change between pages returns `"…: results changed since page 1; re-run without cursor"` instead of a silently shifted page. Cursor id format is unchanged. The snapshot is total + backend only, so a compensating add+delete swap or a rename/content-preserving mutation between pages is invisible to resume. Resume is a stateless re-fetch — resuming the same cursor twice returns the same rows and mints a fresh cursor id each time. Grep pages are path/line/col ordered on both backends. The primary param (`pattern`/`path`/`symbol`, or ffstructural's one-of) is optional in the schema when `cursor` is present, so `{cursor}` alone passes host validation and resumes on stored params; without a cursor the missing-param error still fires. `limit` must be ≥ 1 (`limit: 0` errors `limit must be >= 1`), `ffcallers` `depth` must be 1|2|3 (anything else errors `depth must be 1, 2, or 3` — no silent clamp), and primary params must be strings when given (`<param>: expected string`).
Resume runs on page-1 params: extra params passed alongside `cursor` are
ignored and flagged with a `note: cursor params in effect (…)` line rather
than silently applied or rejected. Loading the extension twice shares one
module graph — the cursor store, session stats, and frecency cache are
process-global, so a `/find-rescan` in one load clears both.
Capped grep-family results (`capped: true`, `N+` totals) mint no cursor — pages
beyond `GREP_CAP` don't exist; the footer instead says `capped result set —
narrow the query for full results`. The store is FIFO-200 with no TTL:
"expired" means evicted, not aged out.

## Scan backends

- **Listing** (`listFiles`, `search.ts:92–100`): `rg --files --no-messages
  [--follow|--no-follow]`; on `ENOENT` (rg missing) falls back to `walkFiles`, any
  other error rethrows. `scan:"mock"` forces the walker (test hook). Unpinned
  hidden-file listing differs by backend (rg follows ignore rules, the walker
  skips dot-dirs outright), and `node_modules` pruning is walker-only — pin an
  explicit `path` for identical results.
- **Walker** (`walkFiles`, 72–91): iterative-depth, `MAX_DEPTH=25`, readdir errors
  swallowed per-dir, symlinks skipped unless `followSymlinks` (followed targets
  dedup by realpath, so junction/symlink aliases collapse where `rg --follow`
  lists each path separately), skips `node_modules`,
  `.git`, dot-dirs (`.git` pointer files — worktree/submodule `.git` files —
  skipped too); returns forward-slash relative paths. rg `./` prefixes stripped
  (96, 149).
  `MAX_DEPTH=25` bounds unpinned walks only — a pinned `path` roots traversal
  at depth 0, so pinned deep dirs stay reachable on the walker where rg is
  unbounded. A pin that escapes the scan root (`../x`, absolute paths) errors
  (`path escapes the scan root: …`) instead of silently scanning the full
  tree. An `fffind` `path` resolving to a file is consumed by the pin — the
  pin text isn't also fuzzy-matched (pin + empty pattern lists the file; pin
  + pattern matches within the filename). `ffoutline` `path` resolves under
  `cwd` but isn't confined to it — `../x` and absolute paths read outside the
  scan root.
- **Grep** (`rgGrep` 169–181): `rg --vimgrep --no-heading --no-messages --max-columns
  500 --max-filesize 2M`, `--fixed-strings` when literal, `--ignore-case` optional;
  rows parsed `path:line:col:text`, text trimmed to 500 chars. `--max-columns 500`
  means rg can emit `[Omitted long line with N matches]` as row text on
  >500-column lines. Fallback (`fallbackGrep`
  182–215): per-file stat skip > 2 MB, NUL-byte binary skip, unreadable files skipped,
  literal `indexOf` or `RegExp` per line, first match col per line, `GREP_CAP=20000`
  hard stop on both backends — surfaced as `capped: true` on `GrepResult`, which
  tools render as `N+` totals plus a `capped` note. `grepContents` (216–245): validates non-empty pattern + regex
  compilability up front, rg→fallback on ENOENT, plus a `Promise.race` wall-clock
  timeout (default 30 s, `timeoutMs` overridable — a core `GrepOptions` knob, not
  a tool param) that rejects `grep timed out after Ns`
  no-matches, kill as timeout). `wholeWord` wraps patterns in JS-identifier
  `[\w$]` boundaries on both backends (`$`/`_` count as word chars — differs
  from `rg -w` at `$` and unicode edges, so patterns starting/ending with a
  non-word char may not match); `\p{...}` unicode property escapes work on the
  walker too, not just rg. rg match columns are character-based (byte offsets
  converted post-0.8.6); walker cols are already char-based. A leading `(?i)`
  in a `literal:false` pattern maps to `ignoreCase`.
- **Runaway guard** (`guardCwd`, 66–71): refuses filesystem root and home directory
  (via `HOME`/`USERPROFILE`) for both find and grep.
- **git:modified** (`gitModifiedSet`, 101–115): fresh `git status --porcelain` per call;
  parses rename arrows + quoted paths; null when git fails → `findPaths` throws
  `git:modified requires a git repository (git status failed)`, or
  `git:modified needs a worktree (bare repository)` when `rev-parse --is-bare-repository` says bare.
- **Ranking** (`findPaths` 151–168): `applyFindFilters` (120–131: dirPrefix, globs
  matched against full path *or* basename via `matchesAny`, excludes as dir-/glob-/
  exact-/segment-match, modified-set intersection) → `fuzzyScore` (133–146:
  case-insensitive subsequence, gap-weighted, basename full-pattern match gets −20)
  → sort by score, then path length, then lexicographic. Empty fuzzy matches all
  (score 0).

## Query syntax (as implemented, `parseFindQuery` 17–29)

Whitespace-split tokens: `git:modified` (case-insensitive) sets flag; `!x` excludes
(first char `!`, length > 1); first trailing-`/` token (length > 1) is the dir prefix
(`./` stripped); tokens containing `*?[{` are globs; remainder joined as fuzzy text.
Glob engine (`globToRegExp` 31–44): `*`→`[^/]*`, `**`→`.*`, `?`→`[^/]`, `{a,b}`→`(?:a|b)`,
`[...]` passthrough, unclosed class/brace escaped literal.

## dist-committed rationale

`package.json: files: ["dist"]`, `main`/`exports` → `./dist/extension.js`,
`omp`+`pi` `extensions` → `./dist/extension.js`. Plugin installs must load without a
build step, so `dist/` is committed on purpose (`README.md:118–125`). Engines:
Node ≥ 22. Zero runtime deps; devDeps only (`@types/node`, `c8`, `typescript`).
Host-native zero-deps is existential, not aesthetic: Bun-compiled fff-bun vs fff-node misdetection under omp (#778) is exactly the runtime-guessing failure a dependency-free scanner sidesteps.

## Install + verify

Marketplace (recommended): `omp plugin marketplace add nikkoxgonzales/omp-find`
then `omp plugin install omp-find@omp-find` (wrapper
`.omp-plugin/marketplace.json`: name/owner/metadata + `plugins[]` entry, version
mirrors `package.json` 0.6.0). Or direct: `omp plugin install
github:nikkoxgonzales/omp-find`. Restart omp; verify `/find-health` shows index +
frecency status. Dev: `npm install && npm test`.

## Symbol-direction tools (additive; zero deps, fresh-scan intact)

Vs-shell positioning is the moat: each card tells the agent what shell habit it
replaces. All five tools take `maxChars` with tiered fallbacks (find→per-dir
counts, grep/callers/structural→per-file counts, outline→kind counts) complementing cursors.

- **`ffoutline`** (`outline` alias) — `src/outline.ts`: `outlineFile(file, {cwd,
  depth, limit, offset})` → `{symbols: {line, col, kind, name}[], total}`.
  Pure-TS regex table per language (TS/JS class|function — `export async
  function` included — |interface|enum|type|
  const-arrow + depth-1 methods; Python def/class; Go func/type; Rust
  fn/struct/enum/trait/mod/impl; Java/C# class|interface|enum|record|struct +
  depth-1 methods; C/C++ coarse; generic fallback). Depth 0 = unindented only;
  depth 1 = indent ≤ 4 cols via `nested` rules; comment openers (`//`, `#`,
  `/*`, `*`, `<!--`, `--`) skipped; >2 MB/binary → empty. Re-exported through
  `search.ts` so the tool-layer `search` dep carries it without host rewiring.
  Card: "Use instead of reading whole files or ctags shells to learn file
  shape … outline->grep->read." Records the outlined file via `recordOpen`
  (fire-and-forget) — outlining counts as opening.
- **`ffcallers`** — `search.callersOf(symbol, opts)` → `GrepResult`: 3 rg/walker
  patterns (`\bSYM\s*\(`, import/from/require/use/include lines, `\.SYM\b`),
  definition lines filtered, merged/deduped by `path:line`, sorted path→line,
  paged; tools-side frecency-rank + path filter + cursor (`callers_cN`).
  Card: "Use instead of shell grep chains for who-calls-X … not LSP-accurate."
  Rows carry gograph certainty: import/call-paren sites exact, member mentions
  `[possible]`-tagged (`tagCallerRows`); `exact_only` keeps exact rows; zero-exact
  sets prepend narrowing guidance instead of a merged guess. `depth?: 1|2|3`
  (default 1) BFS-follows each ring's enclosing symbols (depth-1 outline names)
  over the same 3-pattern matcher — cycle-guarded via the visited `path:line`
  set, merged rings hard-capped by `GREP_CAP`, every row labeled `depth:N`
  (`tagCallerRows` `showDepth`, on only for depth 2|3 so depth-1 output is
  byte-identical); rings are fetched in parallel (one round-trip per depth
  level, not per symbol); each row records its ring symbol (`GrepMatch.via`) so
  certainty/`exact_only` judge transitive rows against their own ring, not the
  root query; downstream callees explicitly out of scope.
- **`ffstructural`** (`structural` alias) — `src/structural.ts`:
  `compileStructural(pattern, {language})` lowers the ast-grep subset
  (`$VAR` identifier/string atom, `$$$` zero-or-more, `$A…$A` backreference,
  `kind:` line shapes, `symbol:` def lines, `references:` delegation,
  `inside: A >> B` / `has: A << B` file-scoped two-phase — one pair only;
  chained combinators like `inside: a >> b >> c` are rejected) to single-line
  regexes; `structuralGrep` runs them via `grepContents` (`literal: false`)
  or `callersOf`, forcing the walker (`scan: "mock"`) when a backreference
  is present because rg's engine rejects `\N`. `previewRewrite` fills
  `$NAME` slots from first-occurrence groups (longest-first) into `-`/`+`
  blocks — preview only, no write path exists. Tool takes exactly one of
  pattern/symbol/references (+ language/path/ignoreCase/rewrite/context/
  maxChars), rows labeled `approx:`, cursor (`structural_cN`).
  Card: "Use instead of hand-rolled AST-ish shell grep chains … rewrite
  returns a preview diff only and never writes." Re-exported through
  `search.ts` like `outlineFile`.
- **`ffmap`** (`map` alias) — `search.rankMap(opts)` → `{files: {path, symbols, modified, inDegree}[], total, scanned, backend}`: one listing, one git status, one text read per file (import-centrality over approximate specifier extractors — centrality only, never shown) plus one `outlineFile` depth-0 pass. Tools-side score `frecency + git + log1p(inDegree)`; file cutoff binary-searched to fit `maxChars` (default 8000) with an omitted-files footer; no cursor — re-call refines. Card: "Use instead of reading directory trees or shell ls -R … never stale."
- **`ffcapsule`** (`capsule` alias) — `search.capsuleOf(symbol, opts)` composes existing cores only: word-mention candidates (30 most-mentioned files cap) → first name-matching non-import depth-0 outline row as def → up to 5 contiguous comment lines above it as doc → bounded `callersOf` + import-line grep → `Guidance:` footer (top caller → ffoutline it; def-only → read it; nothing → ffgrep). Caller/import rows shrink to fit `maxChars`, noted when they do. Single dossier, no cursor. Card: "Use instead of N round-trips … data-driven next step."
- **`ffgrep context` + `expand`** — `GrepOptions.contextBefore/contextAfter` (cap 5 via
  `clampContext`, default 0); `GrepMatch.before/after`; `attachContext` slices
  file lines (each file read once) for BOTH backends — `rg --vimgrep` silently
  drops `-B`/`-C`, so no `-B`/`-C` is passed. Context rows render indented
  without a column (`  path:line: text`), per match — overlapping windows
  repeat per match instead of merging like `rg -C`; cursor state carries the windows.
  `GrepOptions.expand?: "none"|"function"` (default `none`) runs the
  `attachEnclosing` post-pass — one depth-0 `outlineFile` per file-with-hits on
  the page only — attributing each match to the nearest symbol at/above its
  line (`GrepMatch.enclosing`); tools-side `renderExpandedGrepRows` interleaves
  `in <kind> <name>` headers (consecutive same-symbol collapse, outline-miss
  rows stay bare, `concise` suppresses headers); `expand` travels in cursor
  state like context.
- **`concise` density** — opt-in param on `fffind`/`ffgrep`/`ffoutline` only (other tools ignore it): paths-only rows, `path:line` probes (context and expand suppressed), name-only outlines. Same ranking and paging, carried in cursor state.
- **Budgeted nudges** — `tools.ts` `nudge()`: one rotating cross-tool tip appended to non-trivial results (hits > 5), 3 per tool per process; trivial calls stay clean. Footer-only, never blocks or redirects.
- **Cursor ids** — `storeCursor` prefixes per kind (`find_c`/`grep_c`/`outline_c`/
  `callers_c`/`structural_c`), 200-entry cap, unchanged eviction.
