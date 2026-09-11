# omp-find extension — as-built reference

Grounds every claim in `src/*.ts`, `package.json`, `.omp-plugin/marketplace.json`,
`README.md` (v0.6.0). No proposals here — see `serena-findings.md` / `fff-findings.md`.

## Layout

| File | Owns |
|---|---|
| `src/search.ts` (337 lines) | `parseFindQuery`, `globToRegExp`, `findPaths`, `grepContents`, `warmScan`, `status`, `clearCache`; consts `PAGE_DEFAULT=30`, `PAGE_MAX=50` (line 5), `RG_BUFFER=64MB`, `GREP_CAP=20000`, `MAX_DEPTH=25` (line 6), `MAX_GREP_BYTES=2MB` / `MAX_GREP_SIZE="2M"` (8), `GREP_TIMEOUT_DEFAULT=30000` (10) |
| `src/tools.ts` (492 lines) | `resolveFindMode`, `registerFindTools`, cursor store (`cursors`, `storeCursor` lines 19–30, 200-entry cap), `applyPathFilter` (74–88) |
| `src/frecency.ts` (~100 lines) | `storePath`, `recordOpen`, `score`, `status`, `clear`; `HALF_LIFE_MS` 7 days (line 7) |
| `src/extension.ts` (42 lines) | Default-export factory; static imports (fail loudly at load); `session_start` warm scan |
| `src/commands.ts` (~92 lines) | `/find-health`, `/find-rescan` via deps bag |
| `test/find.mjs` | node:test suite (`npm test` = `tsc` build + `node --test`) |
| `dist/` (committed) | Built output; plugin entry `dist/extension.js` |

## Tools

- **`fffind`** — fuzzy file-path search. `registerFindTools` (`tools.ts:90–148`):
  joins `path` + `pattern` params into one query string (127); empty query → error
  text, not throw (128); `findPaths(query, {cwd, limit: PAGE_MAX, offset: 0})` fetches
  up to 50, frecency re-ranks (`safeScore` per path, stable sort `b.s - a.s`, 134–135),
  then slices the requested page. Unknown/expired cursor → error text naming the
  cursor (123); all throws caught → `"fffind failed: …"` (145).
- **`ffgrep`** — content search (`tools.ts:150–207`). `pattern` required (177);
  `literal` defaults true (179), `ignoreCase` opt-in (180). Path filter applies
  **tools-side over the full result set**: unfiltered queries pass limit/offset to
  `grepContents`; filtered ones fetch all then filter + slice (188–194) — a bounded
  fetch first would drop hits outside the page (comment 186–187). Row format
  `path:line:col: text` (195). Same cursor/error conventions as fffind.
- **Output envelope** — every execute returns `{content, details:
  {totalMatched, totalFiles, truncated}}` (pi-fff packaging; totals over the full
  result set, `truncated` when a next page or count-fallback applies). Each def
  carries a one-line `promptSnippet` (guidelines unchanged); paged results add a
  `"<limit> matches limit reached. Use limit=<2×limit>"` notice next to the cursor footer.
- **Override vs additive** (`tools.ts:94–95, 208–213`): `fffind`/`ffgrep` always
  registered; `override` (default) additionally claims `find`/`grep` with the same
  handlers. Dual-arity `register` shim (99–103): single-object if host takes 1 arg,
  `(name, tool)` if it takes 2.

## Commands

- **`/find-health`** (`commands.ts:79–85`): notifies `find status` + `index:` line from
  `search.status()` and `frecency:` line from `frecency.status()`, each with
  `ok (no status reported)` / `error (…)` fallbacks (24–52). `search.status()` today
  reports `rg --version` presence + `index: none (direct scan, no watcher)`
  (`search.ts:251–256`).
- **`/find-rescan`** (`commands.ts:86–91`): calls `search.clearCache()` (currently a
  no-op resolve, `search.ts:258`) + `frecency.clear()` (drops persisted store + memory
  cache), reports `caches dropped: …` or `caches dropped (nothing cached)` (55–77).

## Config precedence

`resolveFindMode` (`tools.ts:32–44`): explicit flag > `OMP_FIND_MODE` env
(`additive`|`override`, case-insensitive) > `"mode"` in `omp-find.json` at project
root (missing/unparseable → ignore) > built-in default **`override`**.
(`README.md:84–95`.)

## Frecency

Per-project JSON (`frecency.ts:20–28`): `%LOCALAPPDATA%/omp-find` on win32, else
`~/.omp/var/omp-find`, keyed by 16-hex-char sha1 of resolved cwd (`projectHash`, 16–18).
Keys normalized to forward slashes (30–32). `recordOpen` bumps count + recency;
`score` decays `count × 0.5^(age/half-life)` (7-day half-life, line 7), unknown paths 0.
Persist is atomic (sidecar write + fsync, then copyFile over live — never
rename-over-live on Windows, 45–58). `clear()` drops store + memory cache. Never
throws (`recordOpen`/`score`/`clear` all swallow).

## Pagination

Default 30, max 50, enforced in two places: `numParam` clamps tool params
(`tools.ts:59–62`) and `pageOf` clamps core limit/offset (`search.ts:60–65`).
`fffind`/`ffgrep` return opaque cursors (`find_cN`/`grep_cN`, `storeCursor` 22–30,
200-entry cap with oldest eviction) capturing full query state (query/limit/offset/cwd;
pattern/literal/ignoreCase/pathFilter/…). Footer when more remain:
`... (N more; pass cursor "…" for the next page)` (`tools.ts:139–142, 196–201`).
Cursors bind to the fetched snapshot (`total` + `backend`, gograph query contracts): resume re-fetches and compares, so a tree change between pages returns `"…: results changed since page 1; re-run without cursor"` instead of a silently shifted page. Cursor id format is unchanged.

## Scan backends

- **Listing** (`listFiles`, `search.ts:92–100`): `rg --files --no-messages
  [--follow|--no-follow]`; on `ENOENT` (rg missing) falls back to `walkFiles`, any
  other error rethrows. `scan:"mock"` forces the walker (test hook).
- **Walker** (`walkFiles`, 72–91): iterative-depth, `MAX_DEPTH=25`, readdir errors
  swallowed per-dir, symlinks skipped unless `followSymlinks`, skips `node_modules`,
  `.git`, dot-dirs; returns forward-slash relative paths. rg `./` prefixes stripped
  (96, 149).
- **Grep** (`rgGrep` 169–181): `rg --vimgrep --no-heading --no-messages --max-columns
  500 --max-filesize 2M`, `--fixed-strings` when literal, `--ignore-case` optional;
  rows parsed `path:line:col:text`, text trimmed to 500 chars. Fallback (`fallbackGrep`
  182–215): per-file stat skip > 2 MB, NUL-byte binary skip, unreadable files skipped,
  literal `indexOf` or `RegExp` per line, first match col per line, `GREP_CAP=20000`
  hard stop. `grepContents` (216–245): validates non-empty pattern + regex
  compilability up front, rg→fallback on ENOENT, plus a `Promise.race` wall-clock
  timeout (default 30 s, `timeoutMs` overridable) that rejects `grep timed out after Ns`
  even if rg hangs past its own `timeout` kill (`runCmd` 48–59 treats rg exit 1 as
  no-matches, kill as timeout).
- **Runaway guard** (`guardCwd`, 66–71): refuses filesystem root and home directory
  (via `HOME`/`USERPROFILE`) for both find and grep.
- **git:modified** (`gitModifiedSet`, 101–115): fresh `git status --porcelain` per call;
  parses rename arrows + quoted paths; null when git fails (not a repo) →
  `findPaths` throws `git:modified requires a git repository` (159).
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
  Pure-TS regex table per language (TS/JS class|function|interface|enum|type|
  const-arrow + depth-1 methods; Python def/class; Go func/type; Rust
  fn/struct/enum/trait/mod/impl; Java/C# class|interface|enum|record|struct +
  depth-1 methods; C/C++ coarse; generic fallback). Depth 0 = unindented only;
  depth 1 = indent ≤ 4 cols via `nested` rules; comment openers (`//`, `#`,
  `/*`, `*`, `<!--`, `--`) skipped; >2 MB/binary → empty. Re-exported through
  `search.ts` so the tool-layer `search` dep carries it without host rewiring.
  Card: "Use instead of reading whole files or ctags shells to learn file
  shape … outline->grep->read." Never calls `recordOpen` (frecency on open only).
- **`ffcallers`** — `search.callersOf(symbol, opts)` → `GrepResult`: 3 rg/walker
  patterns (`\bSYM\s*\(`, import/from/require/use/include lines, `\.SYM\b`),
  definition lines filtered, merged/deduped by `path:line`, sorted path→line,
  paged; tools-side frecency-rank + path filter + cursor (`callers_cN`).
  Card: "Use instead of shell grep chains for who-calls-X … not LSP-accurate."
  Rows carry gograph certainty: import/call-paren sites exact, member mentions
  `[possible]`-tagged (`tagCallerRows`); `exact_only` keeps exact rows; zero-exact
  sets prepend narrowing guidance instead of a merged guess.
- **`ffstructural`** (`structural` alias) — `src/structural.ts`:
  `compileStructural(pattern, {language})` lowers the ast-grep subset
  (`$VAR` identifier/string atom, `$$$` zero-or-more, `$A…$A` backreference,
  `kind:` line shapes, `symbol:` def lines, `references:` delegation,
  `inside: A >> B` / `has: A << B` file-scoped two-phase) to single-line
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
- **ffgrep context** — `GrepOptions.contextBefore/contextAfter` (cap 5 via
  `clampContext`, default 0); `GrepMatch.before/after`; `attachContext` slices
  file lines (each file read once) for BOTH backends — `rg --vimgrep` silently
  drops `-B`/`-C`, so no `-B`/`-C` is passed. Context rows render indented
  without a column (`  path:line: text`); cursor state carries the windows;
- **`concise` density** — opt-in param on find/grep/outline: paths-only rows, `path:line` probes (context suppressed), name-only outlines. Same ranking and paging, carried in cursor state.
- **Budgeted nudges** — `tools.ts` `nudge()`: one rotating cross-tool tip appended to non-trivial results (hits > 5), 3 per tool per process; trivial calls stay clean. Footer-only, never blocks or redirects.
- **Cursor ids** — `storeCursor` prefixes per kind (`find_c`/`grep_c`/`outline_c`/
  `callers_c`/`structural_c`), 200-entry cap, unchanged eviction.
