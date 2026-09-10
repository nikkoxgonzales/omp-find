# omp-find

**A lighter, omp-focused [fff](https://github.com/dmtrKovalenko/fff.nvim): ranked path search plus content grep, host-native, zero dependencies.** No watcher, no index to go stale — every search scans the live tree (`rg` when present, a builtin Node walker otherwise), then frecency re-ranks what you actually open.

## Why strip fff down?

fff is a full fuzzy-finding platform: a background file watcher, an LMDB cache, a picker UI, an MCP server, and multi-editor bindings. Inside an omp/pi agent session none of that pays off — the agent needs two fast primitives through host tools, and caches that can lie are worse than a fresh scan. So omp-find cuts the watcher, the LMDB cache, the picker UI, the MCP server, and the multi-editor bindings, and keeps ranked path search plus content grep.

## Features

- **`fffind`** — fuzzy file-path search over the live tree; exact and stem basename matches rank first.
- **`ffgrep`** — content search, literal by default, regex when `literal=false`; `contextBefore`/`contextAfter` (max 5) disambiguate without follow-up reads.
- **`ffoutline`** (`outline` alias) — approximate per-file symbol overview. Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline → grep → read. Regex-based, explicitly approximate, every hit carries a line number.
- **`ffcallers`** — approximate "who calls X". Use instead of shell grep chains: definition-vs-import-vs-call-site queries collapse into one frecency-ranked call. Text heuristics, explicitly approximate — confirm with read.
- **`maxChars` budgets** — on `fffind`/`ffgrep`/`ffoutline`/`ffcallers`. Over-budget output degrades to counts instead of shell-pipe dumps: per-dir (find), per-file (grep/callers), kind counts (outline).
- **Query subset** — `dir/` prefix, `*.ext`-style globs, `!` exclusions, `git:modified`; leftover words fuzzy-match the path.
- **Per-project JSON frecency** — every opened file bumps count + recency (7-day half-life decay); frequent/recent paths sort first. Stored under `%LOCALAPPDATA%/omp-find` (Windows) or `~/.omp/var/omp-find`, keyed by project-root hash.
- **Cursor pagination** — default 30 results per page, max 50; fuller pages return an opaque `cursor` for the next page.
- **Override vs additive** — `fffind` / `ffgrep` are always registered; override (default) additionally claims `find` / `grep`, additive leaves the host's names alone.
- **No persistent index** — `/find-rescan` just drops the frecency store; the next search rebuilds from disk. Runaway-tree guard refuses filesystem-root and home-directory scans.

## What an agent actually sees

Unlike omp-peers, there is no injected per-prompt note — the agent sees tool cards and commands, nothing else.

```text
fffind ("Find files"; `find` in override mode)
  "Use instead of shell grep/rg/find/ls because results are fuzzy-ranked, frecency-ordered, paged, and counted. [...]"
  approval: read
  promptGuidelines:
    "fffind: Never use shell find/ls/dir to locate files — use fffind with 1-2 short terms."
    "fffind: Keep fffind queries SHORT: 1-2 terms (e.g. 'user_service'); add terms only to narrow, never as OR."
    "fffind: Prefer bare identifiers over sentences; when the top hit is an exact filename match, read it directly."
  pattern: "Fuzzy query: 1-2 short terms (e.g. 'srv usr'); supports dir/ prefix, *.ext globs, !exclusions, git:modified"
  path: "Within-tree filter prepended to the query (e.g. 'src/')"
  cwd: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd"
  limit: "Max results per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns per-dir counts instead of rows"
ffgrep ("Grep content"; `grep` in override mode)
  "Use instead of shell grep/rg/find/ls because results are literal-safe, frecency-ranked, paged, and counted. [...]"
  approval: read
  promptGuidelines:
    "ffgrep: Never use shell grep/rg/select-string for code search — use ffgrep with literal:true and a path filter."
    "ffgrep: Prefer bare identifiers (e.g. 'frecency') over sentences; stay literal unless regex is needed."
    "ffgrep: Scope with the path filter (dir/ prefix, *.ext glob, or bare filename like 'server.py') before broadening the search."
  pattern (required): "Search text or regex (required). Literal by default: quotes/parens need no escaping"
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
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
ffoutline ("Outline file"; `outline` alias, always registered)
  "Approximate per-file symbol overview (omp-find). Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline->grep->read. Regex-based, not LSP-accurate; every hit carries a line number — verify with read/ffgrep. Does not record frecency."
  approval: read
  promptGuidelines:
    "ffoutline: Outline a new file before reading it — never read whole files or run ctags shells to learn shape."
    "ffoutline: Compose outline->grep->read: outline for shape, ffgrep on one symbol, read the range."
  path (required): "Single file to outline, e.g. 'src/search.ts'"
  depth: "0 = top-level symbols (default), 1 = also one nesting level"
  limit: "Max symbols per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns kind counts instead of rows"
ffcallers ("Find callers")
  "Approximate 'who calls X' (omp-find). Use instead of shell grep chains for who-calls-X: definition vs import vs call-site queries collapse into one ranked call. Text heuristics over call parens, imports, and member access — not LSP-accurate; confirm with read."
  approval: read
  promptGuidelines:
    "ffcallers: Never chain shell greps for who-calls-X — one ffcallers call ranks them all."
    "ffcallers: Confirm shortlisted sites with read; output is approximate, not LSP references."
  symbol (required): "Symbol name, e.g. 'parseFindQuery'"
  path: "File constraint, e.g. 'src/', '*.ts'"
  ignoreCase: "Case-insensitive match"
  limit: "Max matches per page (default 30, max 50)"
  cursor: "Opaque pagination cursor from a previous call"
  maxChars: "Max output chars; when exceeded returns per-file counts instead of rows"
Errors return as text: "fffind failed: ..." / "ffgrep failed: ..." / "ffoutline failed: ..." / "ffcallers failed: ..." (no pattern/path/symbol, unknown/expired cursor, non-absolute cwd).
```

```text
> fffind { "pattern": "srv usr" }   # paths illustrative
src/user.ts
src/user_service.ts

... (2 more; pass cursor "c1" for the next page)

> ffgrep { "pattern": "Chat ID (CHT-XXXX from list_chats or search_chats)", "path": "server.py" }
server.py:42:5: // Chat ID (CHT-XXXX from list_chats or search_chats) ...
(1 match total)

> ffgrep { "pattern": "frecency", "path": "src/" }   # paths illustrative
src/frecency.ts:12:3: const HALF_LIFE_MS = ...
src/tools.ts:136:9: const ranked = ...
(2 matches total)

> ffoutline { "path": "src/search.ts" }   # approximate shape, not a full read
src/search.ts:17:1: function parseFindQuery
src/search.ts:31:1: function globToRegExp
src/search.ts:174:1: function findPaths

> ffcallers { "symbol": "parseFindQuery" }   # one ranked call, not a shell grep chain
src/tools.ts:210:9: query = [dirParam, pattern]...
(1 match total)

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

> /find-rescan
caches dropped (nothing cached)
```

## Query syntax

| Token | Meaning | Example |
|---|---|---|
| `dir/` | Only paths under this directory (first such token) | `src/ main` |
| `*.ext` / globs | Keep paths matching `*`, `**`, `?`, `{a,b}`, `[...]` | `*.ts !*.test.ts` |
| `!pat` | Exclude paths containing this text | `main !dist` |
| `git:modified` | Only files `git status --porcelain` reports (errors outside a repo) | `git:modified api` |
| remaining words | Fuzzy subsequence match against the path | `srv usr` → `src/user.ts` |

`ffgrep` takes the same idea through parameters instead: `pattern` (required), optional `path` filter (`src/`, `*.ts`, or a bare filename like `server.py`), `literal` (default `true`), `ignoreCase`, plus `wholeWord` (no more hand-rolled `\b` regexes) and `smartCase` (no more case juggling — lowercase matches all cases, uppercase restores sensitivity).

`path` is always a within-tree filter; `cwd` sets the root. To search another project, pass its absolute directory as `cwd` — never `cd`. The runaway-tree guard still refuses filesystem-root and home-directory scans, and a non-absolute `cwd` is rejected.

## Tools / Commands

| Tool / command | What it does |
|---|---|
| `fffind` (`pattern`, `path`, `cwd`, `limit`, `cursor`, `maxChars`) | Ranked file paths, workspace-relative; frecency-sorted within fuzzy order. 3+-word zero-result queries retry once with the first 2 terms; empty results report files scanned + backend. Over budget → per-dir counts. |
| `ffgrep` (`pattern`, `path`, `literal`, `ignoreCase`, `wholeWord`, `smartCase`, `cwd`, `limit`, `cursor`, `contextBefore`, `contextAfter`, `maxChars`) | `path:line:col: text` matches plus a `(N matches total)` line; path filter applies over the full result set. Empty results report the pattern + backend. Context lines (indented, max 5/side) disambiguate without follow-up reads; over budget → per-file counts. |
| `ffoutline` (`path`, `cwd`, `depth`, `limit`, `cursor`, `maxChars`) | Approximate `path:line:col: kind name` overview — use instead of full reads/ctags shells; composes outline → grep → read. Over budget → kind counts. |
| `ffcallers` (`symbol`, `path`, `cwd`, `ignoreCase`, `limit`, `cursor`, `maxChars`) | Approximate `path:line:col: text` reference sites — use instead of shell grep chains; frecency-ranked. Over budget → per-file counts. |
| `/find-health` | Scan backend status (rg version or walker fallback) plus frecency status, with ok/warn/error levels. |
| `/find-rescan` | Drops the frecency store (nothing else is cached). |

`fffind` / `ffgrep` / `ffoutline` / `ffcallers` are always present (`outline` aliases `ffoutline`); override mode additionally claims `find` / `grep` (same handlers, where the host allows).

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
