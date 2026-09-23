# omp-find

**A lighter, omp-focused [fff](https://github.com/dmtrKovalenko/fff.nvim): ranked path search plus content grep, host-native, zero dependencies.** No watcher, no index to go stale — every search scans the live tree (`rg` when present, a builtin Node walker otherwise), then frecency re-ranks what you actually open.

## Why strip fff down?

fff is a full fuzzy-finding platform: a background file watcher, an LMDB cache, a picker UI, an MCP server, and multi-editor bindings. Inside an omp/pi agent session none of that pays off — the agent needs two fast primitives through host tools, and caches that can lie are worse than a fresh scan. So omp-find cuts the watcher, the LMDB cache, the picker UI, the MCP server, and the multi-editor bindings, and keeps ranked path search plus content grep.

## Features

- **`fffind`** — fuzzy file-path search over the live tree; exact and stem basename matches rank first.
- **`ffjfind`** (`jfind` alias) — semantic grep: describe the behavior in plain language, get files plus judged line ranges with calibrated 0–1 relevance scores, strongest first. Three judged waves — filename ranking over a lexical pre-rank (IDF-weighted grep counts), sketch routing of byte-bounded windows, then verbatim passage verification — ≤16 judge requests in flight per wave, plus `grep_keywords` to steer the lexical pre-rank. Needs a judge: the host `@judge` role, hosted `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY` keys, or a local `OMP_FIND_JUDGE_URL` endpoint. Credential files (`.env*`, keys, keystores, vaults) are never listed or read.
- **`ffgrep`** — content search, literal by default, regex when `literal=false`; `contextBefore`/`contextAfter` (max 5) disambiguate without follow-up reads; `expand:function` attributes each hit to its enclosing symbol with an `in <kind> <name>` header (approximate, line-anchored). Result rows group by file under a `[path#TAG]` hashline header (whole-file content tag, same tag `read` shows — copy it into patch calls). An explicit `path` pin (`dir/` or `dir/file`) is searched directly on both backends, so pinned hidden/ignored files hit; glob and bare-basename filters still search the visible tree.
- **`ffoutline`** (`outline` alias) — approximate per-file symbol overview. Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline → grep → read. Regex-based, explicitly approximate, every hit carries a line number.
- **`ffcallers`** — approximate "who calls X". Use instead of shell grep chains: definition-vs-import-vs-call-site queries collapse into one frecency-ranked call. Text heuristics, explicitly approximate — confirm with read. Rows carry certainty labels: import/call-paren sites are exact, member mentions are `[possible]`-tagged; `exact_only` drops the possible rows. `depth: 1|2|3` (default 1) BFS-follows each ring's enclosing symbols for transitive callers, rows labeled `depth:N`, cycle-guarded and capped.
- **`ffstructural`** (`structural` alias) — approximate structural search. Use instead of hand-rolled AST-ish shell grep chains: `$VAR`/`$$$` patterns, `kind:`/`symbol:`/`references:`/`inside:`/`has:` lower to one ranked regex call with exactly one of pattern/symbol/references; `rewrite` returns a `-`/`+` preview and never writes. Regex lowering, explicitly approximate — every row is `approx:` labeled.
- **`ffmap`** (`map` alias) — fitted repo overview. Use instead of reading directory trees or shell `ls -R` to learn a repo: per-file symbol outlines ranked by frecency, git recency and import-centrality, cut to fit `maxChars` (default 8000). Fresh scan every call — never stale.
- **`ffcapsule`** (`capsule` alias) — fused symbol dossier. Use instead of N round-trips (outline file, grep symbol, grep imports, list callers): signature + doc comment + top callers + import sites + a data-driven `Guidance:` next step in one call. All rows approximate — confirm with read.
- **`concise`** — density knob on `fffind`/`ffgrep`/`ffjfind`/`ffoutline`. Minified end of the rendering range: paths-only rows, `path:line` probes, name-only outlines. Composes with (not replaces) cursors + `maxChars`.
- **`maxChars` budgets** — on every tool. Over-budget output degrades to counts/summaries instead of shell-pipe dumps: per-dir (find), per-file (grep/callers/structural), kind counts (outline), omitted-files footer (map), row shrinking (capsule).
- **Query subset** — `dir/` prefix, `*.ext`-style globs, `!` exclusions, `git:modified`; leftover words fuzzy-match the path.
- **Per-project JSON frecency** — every opened file bumps count + recency (7-day half-life decay); frequent/recent paths sort first. Fed by host `tool_result` events for `read`/`edit`/`write` plus our own `ffoutline`/`ffcapsule` file targets. Stored under `%LOCALAPPDATA%/omp-find` (Windows) or `~/.omp/var/omp-find`, keyed by project-root hash.
- **Cursor pagination** — default 30 results per page, max 50; fuller pages return an opaque `cursor` for the next page. Cursors bind to the fetched snapshot (result total + backend): resuming after the tree changes returns restart guidance (`results changed since page 1; re-run without cursor`), never a silently shifted page. Grep pages are path/line/col ordered on both backends.
- **Override vs additive** — `fffind` / `ffgrep` are always registered; override (default) additionally claims `find` / `grep`, additive leaves the host's names alone.
- **No persistent index** — `/find-rescan` just drops the frecency store; the next search rebuilds from disk. Runaway-tree guard refuses filesystem-root and home-directory scans.

## What an agent actually sees

A concise `<find-tools>` note is injected into every prompt (like omp-peers does for `<peers>`) — it reminds the model to use the ff tools instead of shell find/ls/grep/rg/ctags. The agent also sees the tool cards and commands below.

```text
<find-tools>
Start EVERY code search with ffjfind (describe the behavior in plain language) before any ffgrep/glob/shell search — one call replaces pattern-guessing chains. ffgrep is for exact strings, regexes, and known symbols only; fffind for file names.
Use the ff tools instead of shell find/ls/grep/rg/ctags: fffind for files, ffgrep for content, ffjfind for semantic search by description, ffoutline for file shape, ffcallers for callers, ffstructural for AST-ish patterns, ffmap for repo overview, ffcapsule for one symbol. Results are approximate — verify with read.
</find-tools>

fffind ("Find files"; `find` in override mode)
  "Use instead of shell grep/rg/find/ls because results are fuzzy-ranked, frecency-ordered, paged, and counted. [...]"
  approval: read
  promptSnippet: "Find files by fuzzy name (frecency-ranked, paged, counted)"
  promptGuidelines:
    "fffind: Never use shell find/ls/dir to locate files — use fffind with 1-2 short terms."
    "fffind: Keep fffind queries SHORT: 1-2 terms (e.g. 'user_service'); add terms only to narrow, never as OR."
    "fffind: Prefer bare identifiers over sentences; when the top hit is an exact filename match, read it directly; use ffjfind first for concepts/behaviors you can describe."
  pattern: "Fuzzy query: 1-2 short terms (e.g. 'srv usr'); supports dir/ prefix, *.ext globs, !exclusions, git:modified"
  path: "Within-tree filter prepended to the query (e.g. 'src/')"
  cwd: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd"
  limit: "Max results per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns per-dir counts instead of rows"
  concise: "Concise paths-only rows (default false) — drops notes and tips, same ranking"
ffgrep ("Grep content"; `grep` in override mode)
  "Use instead of shell grep/rg/find/ls because results are literal-safe, frecency-ranked, paged, and counted. Patterns are LITERAL by default — pass literal:false for regex (e.g. 'a|b', 'foo\\.bar'). Literal needs no escaping ever: pattern 'Chat ID (CHT-XXXX from list_chats or search_chats)' with path 'server.py' searches that one file literally."
  approval: read
  promptSnippet: "Search file contents literally or by regex (ranked, paged, counted)"
  promptGuidelines:
    "ffgrep: Never use shell grep/rg/select-string for code search — use ffgrep with a path filter."
    "ffgrep: Patterns are literal by default; patterns containing |, \\., .*, or other regex syntax need literal:false."
    "ffgrep: Prefer bare identifiers (e.g. 'frecency') over sentences; scope with the path filter (dir/ prefix, *.ext glob, or bare filename like 'server.py') before broadening; use ffjfind first for concepts/behaviors you can describe."
  pattern: "Search text or regex. Literal by default: quotes/parens need no escaping. Required unless resuming with cursor"
  path: "File filter: dir/ prefix ('src/'), glob ('*.ts'), or bare filename ('server.py'); applies over the full result set"
  literal: "Literal match (default true); set false to use regex"
  ignoreCase: "Case-insensitive match (default false)"
  wholeWord: "Whole-word match (default false) — no more hand-rolled \\b regexes; ASCII \\b limits apply"
  smartCase: "Smart case (default false) — no more case juggling in shell pipes: lowercase matches all cases, uppercase restores sensitivity"
  cwd: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd"
  limit: "Max matches per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  contextBefore: "Context lines before each match (default 0, max 5)"
  contextAfter: "Context lines after each match (default 0, max 5)"
  expand: "Enclosing-symbol attribution: 'function' adds an 'in <kind> <name>' header per match via an outline pass (default 'none') — approximate, line-anchored"
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
  concise: "Concise path:line rows (default false) — existence probe without text; ignores context params"
ffjfind ("Semantic find"; `jfind` alias, always registered)
  "Use FIRST for any behavior/concept search. Semantic grep: describe what you are looking for in plain language; returns the files and line ranges that implement it, each with a calibrated 0–1 relevance score. No index; searches the live workspace tree on every call."
  approval: read
  promptSnippet: "Semantic grep: find files and line ranges by describing what they do"
  promptGuidelines:
    "ffjfind: MUST be the first call when you do not already know where a behavior lives — one ffjfind replaces a chain of guessed ffgrep patterns and glob sweeps; NEVER grep/glob blindly for a concept you can describe."
    "ffjfind: Use when you can describe the behavior but not the file name — one call replaces ffgrep pattern-guessing chains."
    "ffjfind: query is plain language (a concept or behavior), never a regex; put verbatim identifiers in grep_keywords."
    "ffjfind: Scope with path (one directory) when you know the subsystem — fewer files to rank means cheaper, sharper results."
  query: "what to find, in plain language (concept or behavior, not a regex)"
  grep_keywords: "identifiers or terms likely to appear verbatim in matching source; steer lexical pre-ranking. [] when unsure"
  path: "one directory to search (e.g. 'src/'); omit for the workspace root"
  cwd: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd; refused for filesystem-root and home"
  limit: "Max hits rendered (default 30, max 50)"
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
  concise: "Concise path+score rows (default false) — drops range rows and snippets"
ffoutline ("Outline file"; `outline` alias, always registered)
  "Approximate per-file symbol overview (omp-find). Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline->grep->read. Regex-based, not LSP-accurate; every hit carries a line number — verify with read/ffgrep. Outlining a file records it as opened for frecency."
  approval: read
  promptSnippet: "Outline one file's symbols (approximate shape; verify with read)"
  promptGuidelines:
    "ffoutline: Outline a new file before reading it — never read whole files or run ctags shells to learn shape."
    "ffoutline: Compose outline->grep->read: outline for shape, ffgrep on one symbol, read the range."
  path: "Single file to outline, e.g. 'src/search.ts' (resolved under cwd) — required unless resuming with cursor"
  depth: "0 = top-level symbols (default), 1 = also one nesting level"
  limit: "Max symbols per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns kind counts instead of rows"
  concise: "Concise name-only rows (default false) — minified shape probe; drops locations"
ffcallers ("Find callers")
  "Approximate 'who calls X' (omp-find). Use instead of shell grep chains for who-calls-X: definition vs import vs call-site queries collapse into one ranked call. Text heuristics over call parens, imports, and member access — not LSP-accurate; confirm with read."
  approval: read
  promptSnippet: "Find who calls a symbol (approximate; confirm with read)"
  promptGuidelines:
    "ffcallers: Never chain shell greps for who-calls-X — one ffcallers call ranks them all."
    "ffcallers: Confirm shortlisted sites with read; output is approximate, not LSP references."
  symbol: "Symbol name, e.g. 'parseFindQuery' — required unless resuming with cursor"
  path: "File constraint, e.g. 'src/', '*.ts'"
  ignoreCase: "Case-insensitive match"
  limit: "Max matches per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
  exact_only: "Exact-only: drop possible mentions (member access `.SYM`, comments), keep import/call-paren sites"
  depth: "Caller depth 1|2|3 (default 1) — BFS over enclosing symbols for transitive callers; rows labeled depth:N; downstream callees out of scope"
ffstructural ("Structural search"; `structural` alias, always registered)
  "Approximate structural code search (omp-find). Use instead of hand-rolled AST-ish shell grep chains (piped rg/sed for call shapes, def sites, usages): one call takes exactly one of pattern/symbol/references — pattern is ast-grep-style $VAR/$$$ shape ('console.log($MSG)', 'kind:call'). Regex lowering over live text — not AST-accurate; every row is approx: labeled with a line number — verify with read. rewrite returns a preview diff only and never writes."
  approval: read
  promptSnippet: "Search code by AST shape with $VAR/$$$ patterns (approximate; preview-only rewrite)"
  promptGuidelines:
    "ffstructural: Never hand-roll AST-ish shell grep chains (rg pipes/sed for call shapes, def sites, who-calls-X) — one ffstructural call lowers a $VAR/$$$ pattern to a ranked regex search."
    "ffstructural: Give exactly one of pattern, symbol, references; rows are approx: labeled — confirm with read. rewrite is preview-only and never writes."
  pattern: "Structural pattern: $VAR one atom (identifier/string), $$$ zero-or-more, $A…$A same-shape backreference; kind:/inside:/has: prefixes"
  symbol: "Definition lookup by name (regex-lowered, not LSP)"
  references: "Usage lookup by name via callersOf heuristics"
  language: "Language family hint (ts, py, go, rust, java, cpp; default generic)"
  path: "File constraint, e.g. 'src/', '*.ts'"
  ignoreCase: "Case-insensitive match"
  limit: "Max matches per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  contextBefore: "Context lines before each match (default 0, max 5)"
  contextAfter: "Context lines after each match (default 0, max 5)"
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
  rewrite: "Rewrite template with $NAME slots; returns a unified -/+ preview only — nothing is ever written"
ffmap ("Repo map"; `map` alias, always registered)
  "Fitted repo overview (omp-find). Use instead of reading directory trees or shell ls -R to learn a repo: per-file symbol outlines ranked by frecency, git recency and import-centrality, cut to fit maxChars. Fresh scan every call — never stale."
  approval: read
  promptSnippet: "Map the repo: ranked file overview fitted to a budget"
  promptGuidelines:
    "ffmap: Map an unfamiliar repo before exploring — one fitted overview beats a shell ls -R plus N file reads."
    "ffmap: Follow the map with ffoutline <file> for shape, ffgrep for content, read for the range."
  path: "Dir-scope filter, e.g. 'src/' — map only this subtree"
  cwd: "Scan root: absolute directory to map (default: session cwd)"
  maxChars: "Overview budget in chars (default 8000) — the file cutoff is fitted to it"
ffcapsule ("Symbol dossier"; `capsule` alias, always registered)
  "Fused symbol dossier (omp-find). Use instead of N round-trips (outline file, grep symbol, grep imports, list callers) to learn one symbol: signature + doc comment + top callers + import sites + a data-driven next step in one call."
  approval: read
  promptSnippet: "Dossier on one symbol: def, doc, callers, imports, next step"
  promptGuidelines:
    "ffcapsule: Learn one symbol with a single ffcapsule call instead of chaining ffoutline, ffgrep and ffcallers by hand."
    "ffcapsule: Follow the Guidance: footer — it names the cheapest next call from the data."
  symbol: "Symbol name, e.g. 'parseFindQuery' (required)"
  path: "File constraint, e.g. 'src/', '*.ts'"
  cwd: "Scan root: absolute directory to search (default: session cwd)"
  ignoreCase: "Case-insensitive match"
  limit: "Max callers/imports shown each (default 10, max 50)"
  maxChars: "Max output chars; caller/import rows shrink to fit, noted when they do"
Errors return as text: "fffind failed: ..." / "ffgrep failed: ..." / "ffjfind failed: ..." / "ffoutline failed: ..." / "ffcallers failed: ..." / "ffstructural failed: ..." / "ffmap failed: ..." / "ffcapsule failed: ..." (no/excess pattern/symbol/references, empty query, judge unavailable, all judge requests failed, scope `path` not an existing directory under the scan root, unknown/expired cursor, non-absolute cwd, `depth` outside 1|2|3, non-integer `limit`/`depth`/`contextBefore`/`contextAfter`/`maxChars`, `limit` < 1, non-string primary params on direct `execute()`).
Stale cursors (tree changed since page 1) return restart guidance as text: "...: results changed since page 1; re-run without cursor".
Each execute also returns `details: { totalMatched, totalFiles, truncated }` (pi-fff packaging: totals over the full result set, `truncated` when a next page or count-fallback applies); hosts that ignore it see identical text. Paged results add a `"<limit> matches limit reached (max 50) — more via cursor"` notice next to the cursor footer.
```

```text
> fffind { "pattern": "srv usr" }   # paths illustrative
src/user.ts
src/user_service.ts

> ffcallers { "symbol": "parseFindQuery" }   # one ranked call, not a shell grep chain
src/tools.ts:210:9: query = [dirParam, pattern]...
(1 match total)

> ffstructural { "pattern": "console.log($MSG)", "rewrite": "logger.info($MSG)" }   # shape query + preview-only rewrite
approx: src/a.ts:3:5:
- console.log(thing)
+ logger.info(thing)

[preview only — nothing was written]
30 matches limit reached (max 50) — more via cursor

> ffgrep { "pattern": "Chat ID (CHT-XXXX from list_chats or search_chats)", "path": "server.py" }
server.py:42:5: // Chat ID (CHT-XXXX from list_chats or search_chats) ...
(1 match total)

> ffgrep { "pattern": "frecency", "path": "src/" }   # paths illustrative
src/frecency.ts:12:3: const HALF_LIFE_MS = ...
src/tools.ts:136:9: const ranked = ...
(2 matches total)

> ffjfind { "query": "where is the download rate limit enforced?" }   # describe it, get files+line ranges
1 hit(s) for "where is the download rate limit enforced?" (τ 0.20), strongest first

src/rate_limit.ts  0.87  41 lines judged
  src/rate_limit.ts:118-146  0.87  const MAX_ATTEMPTS = ...

listed 3 · judged 6 · read 1 files (12.4 KB) · 3 requests · 1,918 tokens · $0.0001 · 1.6s wall / 1.4s api

> ffoutline { "path": "src/search.ts" }   # approximate shape, not a full read
src/search.ts:17:1: function parseFindQuery
src/search.ts:31:1: function globToRegExp
src/search.ts:174:1: function findPaths

> ffcallers { "symbol": "parseFindQuery" }   # one ranked call, not a shell grep chain
src/tools.ts:210:9: query = [dirParam, pattern]...
(1 match total)

> ffmap { "maxChars": 800 }   # one fitted overview, not ls -R plus reads
src/search.ts:
  function parseFindQuery
  function findPaths
... (3 files omitted; raise maxChars or ffoutline <file>)

> ffcapsule { "symbol": "parseFindQuery" }   # one dossier, not N round-trips
symbol parseFindQuery — function in src/search.ts:17
doc:
  (no doc comment)
callers (2):
src/tools.ts:210:9: query = [dirParam, pattern]...
imports (1):
src/tools.ts:4:1: import type * as SearchNS from "./search.js";
Guidance: ffoutline src/tools.ts for the top caller's shape

> ffgrep { "pattern": "frecency", "path": "src/", "contextAfter": 1 }
src/frecency.ts:12:3: const HALF_LIFE_MS = ...
  src/frecency.ts:13: const DAY = ...

> ffgrep { "pattern": "e", "path": "src/", "maxChars": 40 }   # over budget: counts, not a dump
Matched 58 hits in 4 files (output exceeds 40 chars). Per-file counts: search.ts: 30, tools.ts: 20, .... Refine path/pattern or raise maxChars.

> fffind { "pattern": "srv usr xyzzy" }   # 3+ words, zero hits: one retry with the first 2 terms
0 matches (412 files scanned, rg)

> /find-health
find status
index: ok (rg: ripgrep 14.1.0 (rev ...); backend: rg; index: none (fresh scan, no watcher))
frecency: ok (3 paths tracked (<store-path>/frecency.json))
session: 2 calls (find: 1, grep: 1); backend rg: 1 walker: 1; timeouts: 0; avg 3ms

> /find-rescan
caches dropped (nothing cached)
```

## Query syntax

| Token | Meaning | Example |
|---|---|---|
| `dir/` | Only paths under this directory (first such token) | `src/ main` |
| `*.ext` / globs | Keep paths matching `*`, `**`, `?`, `{a,b}`, `[...]` | `*.ts !*.test.ts` |
| `!pat` | Exclude by exact path, `dir/` prefix, path segment, or glob (`!*.test.ts`) — not a substring match | `main !dist` |
| `git:modified` | Only files `git status --porcelain` reports (errors outside a repo) | `git:modified api` |
| remaining words | Fuzzy subsequence match against the path | `srv usr` → `src/user.ts` |

`ffgrep` takes the same idea through parameters instead: `pattern` (required unless resuming with `cursor`), optional `path` filter (`src/`, `*.ts`, or a bare filename like `server.py`), `literal` (default `true`), `ignoreCase`, plus `wholeWord` (no more hand-rolled `\b` regexes) and `smartCase` (no more case juggling — lowercase matches all cases, uppercase restores sensitivity).

Hot-files recipe (≈ `codedb_hot`): `fffind` with a `git:modified` query and no other terms lists recently modified files — frecency re-ranks the set, so the files you actually touch keep floating up. Explain recipe (≈ `codedb_explain`): `ffcapsule <symbol>` fuses signature, doc comment, callers, imports, and a data-driven `Guidance:` next step in one call instead of chaining outline/grep/callers by hand.

`path` is always a within-tree filter; `cwd` sets the root. To search another project, pass its absolute directory as `cwd` — never `cd`. The runaway-tree guard still refuses filesystem-root and home-directory scans, and a non-absolute `cwd` is rejected.

## Tools / Commands

| Tool / command | What it does |
| `ffjfind` (`jfind` alias) (`query`, `grep_keywords`, `path`, `cwd`, `limit`, `maxChars`, `concise`) | Semantic grep: `path  score  N lines judged` rows strongest first, each with ≤3 `  path:start-end  score  snippet` range rows from judged complete passages (merged adjacent spans, max score). Footer `listed N · judged N (filename + window judgments) · read N files (X KB) · N requests · N tokens · $X · wall / api`; judge failures listed, never thrown; zero hits render `no hits for "…" (τ 0.20)` + the same footer. Scores are absolute yes/no probabilities comparable across calls; below ~0.4 is weak evidence. No cursor — re-call with a refined query. |
| `ffgrep` (`pattern`, `path`, `literal`, `ignoreCase`, `wholeWord`, `smartCase`, `cwd`, `limit`, `cursor`, `contextBefore`, `contextAfter`, `expand`, `maxChars`, `concise`) | `path:line:col: text` matches plus a `(N matches total)` line; path filter applies over the full result set. Empty results report the pattern + backend. Context lines (indented, max 5/side) disambiguate without follow-up reads; `expand:function` interleaves approximate `in <kind> <name>` attribution headers (outline-miss rows stay bare); over budget → per-file counts. `concise` renders `path:line` probes, ignoring context/expand. |
| `ffoutline` (`path`, `cwd`, `depth`, `limit`, `cursor`, `maxChars`, `concise`) | Approximate `path:line:col: kind name` overview — use instead of full reads/ctags shells; composes outline → grep → read. Over budget → kind counts. `concise` renders name-only rows. |
| `ffcallers` (`symbol`, `path`, `cwd`, `ignoreCase`, `limit`, `cursor`, `maxChars`, `exact_only`, `depth`) | Approximate `path:line:col: text` reference sites — use instead of shell grep chains; frecency-ranked. Import/call-paren rows are exact, member mentions carry `[possible]`; `exact_only` keeps exact rows. `depth` 2\|3 BFS-follows enclosing symbols for transitive callers (cycle-guarded, capped); rows labeled `depth:N`. Over budget → per-file counts. |
| `ffstructural` (`pattern`, `symbol`, `references`, `language`, `path`, `ignoreCase`, `limit`, `cursor`, `contextBefore`, `contextAfter`, `maxChars`, `rewrite`) | Approximate structural search — ast-grep-style `$VAR`/`$$$` patterns lower to one ranked call; exactly one of pattern/symbol/references; `rewrite` previews only. Rows `approx:` labeled. |
| `ffmap` (`path`, `cwd`, `maxChars`) | Fitted `path:` + symbol overview ranked by frecency/recency/centrality; omitted-files footer. No cursor — re-call with a bigger budget refines. |
| `ffcapsule` (`symbol`, `path`, `cwd`, `ignoreCase`, `limit`, `maxChars`) | Fused dossier: def + doc + callers + imports + `Guidance:` next step. Single page, no cursor. |
| `/find-health` | Scan backend status (rg version or walker fallback) plus frecency status, with ok/warn/error levels — plus a `judge:` line (resolved judge label or `none configured`) and a `session:` stats block (calls per tool, rg-vs-walker mix, timeouts, avg ms; in-memory only). |
| `/find-rescan` | Drops the frecency store (nothing else is cached) and resets the session counters. |

`fffind` / `ffgrep` / `ffjfind` / `ffoutline` / `ffcallers` / `ffstructural` / `ffmap` / `ffcapsule` are always present (`jfind`, `outline`, `structural`, `map`, `capsule` aliases); override mode additionally claims `find` / `grep` (same handlers, where the host allows).

## Honest limits

- `ffjfind` needs a judge — with none configured it errors with fix-up text (`no judge available (configure a @judge model role, or set TYPESAFE_API_KEY/OPENROUTER_API_KEY, or OMP_FIND_JUDGE_URL)`) instead of degrading to a plain grep. Every call costs real judge tokens over the whole (scoped) tree; narrow with `path`/`grep_keywords` before broadening. Scores are model judgments, not ground truth.
- `ffjfind` sketch judgments are routing signals only: a reported range always comes from a complete verified passage, so a high sketch score that fails verification produces no hit and no range.
- `ffjfind` judge requests cap at 6 retries per provider with backoff honoring `retry-after`; a single-provider (local) client never retries in place and never fails over — one bad request is one lost batch. Judge failures degrade coverage (fewer candidates read, fewer passages verified) and are listed in the report, never thrown; only total failure (judge requests failed with zero usable judgments) renders as a tool error.
- `ffjfind` files are listed once via the full-tree scan (gitignore-honoring, hidden files excluded) and filtered against deny-lists (build dirs, lockfiles, binaries, credentials); a credential file outside these lists (e.g. a renamed key file) would be read like any other file. Binary/blank files are silent expected misses, not failures. File sizes are statted only for the ≤128 tree-rendered candidates.
- `ffjfind` hits beyond `limit` (default 30, max 50) are computed but not rendered (`(… M more hits not shown)`); over-budget output degrades to per-file judged-line counts. No cursor — re-call to refine.
- `ffjfind` `path` accepts one existing directory under the scan root (glob/escape forms error); `cwd` refuses filesystem-root and home like the other tools.
- Unpinned hidden-file listing differs by backend (rg follows ignore rules AND skips dotfiles — no `--hidden` is passed; the walker skips dot-dirs outright but lists dotfiles in visible dirs) — pin an explicit `path` for identical results.
- `node_modules` pruning is walker-only; rg follows your ignore files instead.
- Cursors bind to result total + backend, so a compensating add+delete swap or rename/content-preserving mutation between pages reads as unchanged and resumes silently.
- Cursor resume is a stateless re-fetch: resuming the same cursor twice returns the same rows and mints a fresh cursor id each time.
- The cursor store evicts the oldest entry beyond 200; evicted cursors fail with `unknown or expired cursor`.
- With `followSymlinks` the walker dedups junction/symlink targets by realpath; `rg --follow` lists each path separately.
- `rg --max-columns 500` can emit `[Omitted long line with N matches]` as row text on >500-column lines.
- `timeoutMs` is a core `GrepOptions`/`CallersOptions` knob, not a tool param.
- `ffcapsule` considers the 30 most-mentioned files when hunting a definition.
- Grep pages are path/line/col ordered on both backends; totals and counts are stable.
- At most one rotating tip per call, max 3 per tool per process, on non-trivial results only.
- Frecency writes serialize in-process; across processes each save takes a mkdir lockfile around read/merge/write and skips the write if the lock cannot be acquired, so simultaneous same-key bumps can still under-count.
- Grep match sets hard-cap at 20000 (`GREP_CAP`) on both backends; a capped result renders totals as `N+` with a `capped` note.
- `wholeWord` uses identifier-boundary semantics on both backends — `$` and `_` count as word chars, so patterns starting/ending with a non-word char may not match.
- Regex (`literal:false`) `\p{...}` unicode property escapes work on both backends.
- `contextBefore`/`contextAfter` windows render per match — overlapping context repeats per match instead of merging like `rg -C`.
- The walker skips `.git` pointer files (worktree/submodule `.git` files) as well as `.git` directories.
- `git:modified` needs a work tree: bare repositories fail `git status` like non-repos, and the error names the requirement.
- Capped grep-family result sets (`N+`, `capped`) mint no next-page cursor — pages beyond the cap don't exist; narrow the query for full results.
- The cursor store is one process-global FIFO-200 map shared across all tools (a find cursor can evict a grep cursor) with no TTL — "expired" means evicted, not aged out.
- The walker stops at `MAX_DEPTH=25` while rg is unbounded; a pinned `path` still reaches deeper dirs on the walker (the pin roots traversal at depth 0).
- An `fffind` `path` that resolves to a file is consumed by the pin — the pin text isn't also fuzzy-matched (pin + empty pattern lists the file; pin + pattern matches within the filename).
- A `path` that escapes the scan root (`../x`, absolute paths) errors instead of silently scanning the full tree.
- `ffoutline` `path` resolves under `cwd` but isn't confined to it — `../x` and absolute paths read outside the scan root.
- `wholeWord` boundaries are JS-identifier `[\w$]` on both backends (intended) — differs from `rg -w` at `$` and unicode edges.
- rg match columns are character-based (byte offsets converted post-0.8.6); walker cols are already char-based.
- A leading `(?i)` in a `literal:false` pattern maps to `ignoreCase`.
- Cursor resume runs on page-1 params: extra params passed alongside `cursor` are ignored and flagged with a `note: cursor params in effect (…)` line.
- Loading the extension twice shares one module graph — cursor store, session stats, and the frecency cache are process-global, so a `/find-rescan` in one load clears both.
- Frecency `clear()` stamps a `clearedAt` tombstone; merge-on-save drops entries older than it, so a stale process can't resurrect cleared keys.
- Frecency keys are canonicalized before storing/lookup: `read`-style selectors (`:10-20`, `:raw`, `?q=`, `#tag`) are stripped, non-file URIs (`xd://`, `artifact://`, `https://`, …) are skipped, and paths inside the project store cwd-relative — so `read src/x.ts` and `read C:/repo/src/x.ts` hit one key.
- `ffcallers` `depth` 2|3 fetches each BFS ring in parallel — transitive depth costs one round-trip per ring, not per symbol.
- `ffoutline` covers `export async function` declarations alongside plain `function`.
- `ffstructural` `inside:`/`has:` take one `OUTER >> INNER` / `OUTER << INNER` pair — chained combinators (`inside: a >> b >> c`) are rejected, not nested.
- `concise` exists only on `fffind`/`ffgrep`/`ffjfind`/`ffoutline`; other tools ignore it.
- `limit` must be an integer ≥ 1 — `limit: 0` errors (`limit must be >= 1`), `limit: 2.5` errors (`limit must be an integer >= 1`); same integer rule on `depth` (`depth must be an integer` on ffoutline; ffcallers' closed-set message), `contextBefore`/`contextAfter` (`must be an integer`), and `maxChars` (`must be an integer >= 1`) — no silent flooring.
- `ffcallers` `depth` accepts only 1|2|3 — other values error (`depth must be 1, 2, or 3`) instead of clamping to 1.
- Primary params (`pattern`/`symbol`/`path`/`references`) must be strings when given — a non-string errors (`<param>: expected string`) instead of coercing or passing silently. Defense-in-depth only: on the live path the host JSON-parses string args and coerces scalars/objects to the declared schema type before `execute()` runs (`pattern: 123` arrives as `'123'`, `pattern: {a:1}` as `'{"a":1}'`), so this check can only fire for direct `execute()` callers (tests, embedders bypassing the host). Note `pattern: "null"` JSON-parses to `null` at the host layer, which surfaces as `provide a pattern`.
- Primary params are optional in the schema when `cursor` is present — `{cursor}` alone resumes on the stored page-1 params.
- `ffstructural` `language` is a lowering hint only — it does not restrict which file types are searched.
- On Windows the tree walk skips DOS device names (`nul`, `con`, `aux`, `prn`, `com1`–`com9`, `lpt1`–`lpt9`) — they can't be opened as files.
- A `.git` pointer FILE (linked worktree/submodule) doesn't activate gitignore honoring — rg treats the tree as a plain directory; the walker skips the pointer file itself.
- Binary files are skipped silently by grep (NUL-byte check) — no "skipped binary" note.
- The `MAX_DEPTH=25` cutoff is silent and walker-only — deeper files simply don't appear; rg is unbounded.
- `ffstructural kind:class` means "type declaration" — it matches `interface`/`struct`/`enum`/`trait` lines too, not just `class`.
- `contextBefore`/`contextAfter` clamp to 0–5, `expand` treats anything but `function` as `none`, `ffoutline` `depth` treats any integer but 1 as 0, `maxChars` clamps at 1M — all silently (non-integer numbers error instead, per above).
- A `read` on a directory used to record a frecency entry for a path that can never match a file — fixed in 0.8.10 (directory reads no longer feed frecency).

## Config

Mode precedence, highest first:

1. Explicit flag passed to tool registration
2. `OMP_FIND_MODE` env var (`additive` or `override`)
3. `"mode"` in `omp-find.json` at the project root
4. Built-in default: `override` (host tools replaced)

```json
{ "mode": "additive" }
```

Scanning needs no config: `rg --files` / `rg --vimgrep` when `rg` is on `PATH`, otherwise the builtin walker (symlinks not followed by default). Frecency location follows the store path above; deleting it is safe.
Tool surface: `OMP_FIND_TOOLS=core|full` (default `core` = the full surface above as it stands; `full` adds nothing today and is reserved for future tools so they don't bloat the default). Unknown values fall back to `core`.

`ffjfind` judge resolution, highest first:

1. `OMP_FIND_JUDGE_URL` (or legacy `JEGREP_ENDPOINT_URL`) — unauthenticated local System One endpoint; explicit user intent wins.
2. The host `@judge` model role (omp/pi ≥ 18.2.8) via the judgment module — `OMP_FIND_JUDGE_MODEL` overrides the session model when set (default `jev-latest`).
3. `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` from the process env, then `~/.env` — both load independently and fail over (OpenRouter first). Hosted endpoints bill input tokens at $42/1B; the local endpoint is free.

Numeric cascade knobs accept env overrides `OMP_FIND_CASCADE_<NAME>` (parsed, clamped): `PARALLEL` (16), `NAME_BATCH` (64), `CANDIDATES` (128), `FILES` (20), `WINDOWS` (24), `WINDOW_BYTES` (8192), `SKETCH_BYTES` (384), `FULL_LIMIT` (40), `CUTOFF` (0.45), `THRESHOLD` (0.2), `READ_LIMIT` (4 MB), `SKETCH_STATE_BYTES` (18000), `SKETCH_CARDS_MAX` (48), `VERIFY_STATE_BYTES` (24 KB), `SCAN_TIMEOUT_MS` (30000), `FAILURES_KEPT` (5).

## Install

Requirements: Node.js 22+, and omp (`@oh-my-pi/pi-coding-agent`) or pi.

**Marketplace (recommended — enables updates via `omp plugin upgrade omp-find@omp-find`):**

```sh
omp plugin marketplace add nikkoxgonzales/omp-find
omp plugin install omp-find@omp-find
```

**Direct from GitHub:**

```sh
omp plugin install github:nikkoxgonzales/omp-find
```

Then restart omp. Verify with `/find-health` — it should show index/frecency status.

## Development

```sh
npm install
npm test   # build + tests
```

`dist/` is committed on purpose: plugin installs must load without a build step.
