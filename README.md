omp-find — a lighter fff for omp/pi: fast file finding without the weight.
Cut from fff: file watcher, LMDB cache, picker UI, MCP server, multi-editor
bindings. What stays: ranked path search plus content grep, host-native.
Tools: `fffind` (find files by fuzzy query) and `ffgrep` (grep contents).
Commands: `/find-health` shows index/frecency status; `/find-rescan` drops
caches so the next search rebuilds from disk.
Query subset: `dir/` narrows to a directory, `*.ext` filters by extension,
`!pat` excludes matches; remaining words fuzzy-match the path.
Frecency: every opened file is recorded; recent/frequent paths rank higher.
Config precedence (highest first): CLI flag > `OMP_FIND_MODE` env var >
`omp-find.json` in project root > built-in additive default (all sources on).
Modes: `auto` (rg when present, builtin scan otherwise), `rg`, `builtin`.
Zero deps (node builtins only), ESM, `npm run build` then `npm test`.

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
