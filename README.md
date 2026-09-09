# omp-find

**A lighter, omp-focused [fff](https://github.com/dmtrKovalenko/fff.nvim): ranked path search plus content grep, host-native, zero dependencies.** No watcher, no index to go stale — every search scans the live tree (`rg` when present, a builtin Node walker otherwise), then frecency re-ranks what you actually open.

## Why strip fff down?

fff is a full fuzzy-finding platform: a background file watcher, an LMDB cache, a picker UI, an MCP server, and multi-editor bindings. Inside an omp/pi agent session none of that pays off — the agent needs two fast primitives through host tools, and caches that can lie are worse than a fresh scan. So omp-find cuts the watcher, the LMDB cache, the picker UI, the MCP server, and the multi-editor bindings, and keeps ranked path search plus content grep.

## Features

- **`fffind`** — fuzzy file-path search over the live tree; basename matches rank first.
- **`ffgrep`** — content search, literal by default, regex when `literal=false`.
- **Query subset** — `dir/` prefix, `*.ext`-style globs, `!` exclusions, `git:modified`; leftover words fuzzy-match the path.
- **Per-project JSON frecency** — every opened file bumps count + recency (7-day half-life decay); frequent/recent paths sort first. Stored under `%LOCALAPPDATA%/omp-find` (Windows) or `~/.omp/var/omp-find`, keyed by project-root hash.
- **Cursor pagination** — default 30 results per page, max 50; fuller pages return an opaque `cursor` for the next page.
- **Additive vs override** — additive (default) registers `fffind`/`ffgrep` alongside the host's tools; override replaces them as `find`/`grep`.
- **No persistent index** — `/find-rescan` just drops the frecency store; the next search rebuilds from disk. Runaway-tree guard refuses filesystem-root and home-directory scans.

## Query syntax

| Token | Meaning | Example |
|---|---|---|
| `dir/` | Only paths under this directory (first such token) | `src/ main` |
| `*.ext` / globs | Keep paths matching `*`, `**`, `?`, `{a,b}`, `[...]` | `*.ts !*.test.ts` |
| `!pat` | Exclude paths containing this text | `main !dist` |
| `git:modified` | Only files `git status --porcelain` reports (errors outside a repo) | `git:modified api` |
| remaining words | Fuzzy subsequence match against the path | `srv usr` → `src/user.ts` |

`ffgrep` takes the same idea through parameters instead: `pattern` (required), optional `path` filter (`src/`, `*.ts`), `literal` (default `true`), `ignoreCase`.

## Tools / Commands

| Tool / command | What it does |
|---|---|
| `fffind` (`pattern`, `path`, `limit`, `cursor`) | Ranked file paths, workspace-relative; frecency-sorted within fuzzy order. |
| `ffgrep` (`pattern`, `path`, `literal`, `ignoreCase`, `limit`, `cursor`) | `path:line:col: text` matches; path filter applies over a bounded fetch. |
| `/find-health` | Shows scan backend status plus frecency status. |
| `/find-rescan` | Drops the frecency store (nothing else is cached). |

In override mode the tools are named `find` / `grep` with the same parameters.

## Config

Mode precedence, highest first:

1. Explicit flag passed to tool registration
2. `OMP_FIND_MODE` env var (`additive` or `override`)
3. `"mode"` in `omp-find.json` at the project root
4. Built-in default: `additive` (all sources on)

```json
{ "mode": "override" }
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
