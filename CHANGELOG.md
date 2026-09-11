# Changelog

All notable changes to omp-find are documented here, Keep-a-Changelog style.
Version pins (`package.json`, `.omp-plugin/marketplace.json`, docs) move in lockstep.

## [0.8.1]

### Fixed

- Explicit `path` pins (`dir/` or `dir/file`) now reach the scan backends, so pinned hidden/ignored paths are searched instead of silently missing: rg receives the pin positionally in place of `.`, and the walker starts at the pin (bypassing its dot-dir prune) or returns a pinned file directly. Glob (`*.py`) and bare-basename (`file.py`) filters keep today's post-filter path, and unpinned calls keep today's argv and traversal — defaults byte-identical. Measured nuance on rg: a **file** pin is searched regardless of `.gitignore` (an explicitly named file is never ignore-filtered), while a **dir** pin still honors `.gitignore` while traversing inside it.

## [0.8.0]

### Added

- `ffgrep` hashline file headers: each file group on the page is prefixed with `[path#TAG]` (whole-file content tag — BOM-strip, LF-normalize, per-line rstrip, xxh32 low 16 bits; byte-identical to the oh-my-pi `read` tag, so it copies straight into patch calls). Default-on output shaping only: no row removed or reordered, pagination/cursor/error formats untouched.

## [0.7.0]

### Added

- `expand: "function"` on `ffgrep`: per-match enclosing-symbol attribution (`enclosing: { kind, name, line }` via depth-0 outline, best-effort, never throws).
- `depth: 1 | 2 | 3` on `ffcallers`: BFS-transitive caller rings with `depth:N` on every row, hard-capped by `GREP_CAP`.
- Session-stats block on `/find-health` (in-memory per-tool call counters) with counter reset on `/find-rescan`.
- `OMP_FIND_TOOLS=core|full` tier gate (default `core`; `full` reserved for the wider surface).
- README hot-files/explain recipes.
- Installed-surface simulator grows to 18 scenarios (expand + depth-ring coverage).

### Changed

- README + `docs/extension.md` mirror the new params, session stats, and tier gate.

## [0.6.0]

### Added

- `ffmap` (+ `map` alias): fitted repo overview — per-file depth-0 outlines ranked by frecency, git recency and import-centrality, file cutoff binary-searched to fit `maxChars` (default 8000) with an omitted-files footer.
- `ffcapsule` (+ `capsule` alias): fused symbol dossier — def + doc comment + top callers + import sites + data-driven `Guidance:` next step in one call; caller/import rows shrink to fit `maxChars`.
- `concise` density knob on `fffind`/`ffgrep`/`ffoutline`: paths-only rows, `path:line` probes (context suppressed), name-only outlines; same ranking and paging.
- Budgeted footer nudges: one rotating cross-tool tip on non-trivial results (hits > 5), 3 per tool per process; trivial calls stay clean.
- Installed-surface simulator grows to 16 scenarios (map + capsule coverage).

### Changed

- README + `docs/extension.md` mirror the new tools, density knob, and nudges; tool table covers all seven tools.

## [0.5.0]

### Added

- `ffstructural` (+ `structural` alias): approximate structural search — ast-grep-style `$VAR`/`$$$` patterns, `kind:`/`symbol:`/`references:`/`inside:`/`has:` lower to one ranked regex call; `rewrite` returns a preview diff and never writes.
- `details` envelope on every execute: `{ totalMatched, totalFiles, truncated }` over the full result set (pi-fff packaging; hosts that ignore it see identical text).
- One-line `promptSnippet` per tool card (guidelines unchanged).
- Limit-reached notices (`"<limit> matches limit reached. Use limit=<2×limit>"`) next to cursor footers.
- Snapshot-bound cursors: each stored cursor binds result `total` + backend; resuming after the tree changes returns restart guidance (`results changed since page 1; re-run without cursor`), never a silently shifted page (gograph query contracts).
- Certainty labels on `ffcallers`: import/call-paren rows exact, member mentions `[possible]`-tagged, plus an `exact_only` param; zero-exact sets prepend narrowing guidance.
- `docs/goldmine.md`: ranked steal list behind the 0.5.0 set.

### Changed

- Cursor footers share one returned-vs-total shape across all five tools.
- README + `docs/extension.md` mirror the new envelope, notices, labels, and cursor binding.

## [0.4.0]

### Added

- `ffoutline` (+ `outline` alias): approximate per-file symbol overview — outline → grep → read composition without full-file reads.
- `ffcallers`: approximate "who calls X" over call parens, imports, and member access in one frecency-ranked call.
- `cwd` scan root on `fffind`/`ffgrep`/`ffoutline`/`ffcallers` (absolute dirs only; pass `cwd` instead of `cd`).
- `contextBefore`/`contextAfter` (max 5/side) on `ffgrep`, distinctly marked per row.
- `wholeWord` on `ffgrep` (rg `--word-regexp`; walker `\b`-wrapped escaped literal).
- `smartCase` on `ffgrep` (lowercase matches all cases, uppercase restores sensitivity).
- `maxChars` output budgets with per-dir/per-file/kind-count fallbacks.
- Stem scoring tiers in `fuzzyScore` (exact −20 / stem −10 / fuzzy 0; upstream PR #728).
- Installed-surface simulator (`npm run simulate`, 10 scenarios).
- `docs/fff-intel.md`: upstream intel survey behind the 0.4.0 set.

### Fixed

- Frecency `clear()` resets the in-memory singleton, not just the store file.
- Walker scans honor the cooperative deadline, so timeouts actually stop work.
- `/find-health` reports facts (rg version/backend, entry count, store path) with ok/warn/error levels.
- Extension entry hygiene: static imports that fail loudly, `session_start` host event form.

### Changed

- Tool cards coach instead of describing: `approval: 'read'`, tool-prefixed `promptGuidelines` with never-shell rules, and `Use instead of shell …` first lines displacing shell find/ls/grep/rg pipes.
- 3+-word zero-result find queries retry once with the first 2 terms; zero-states carry scan facts and grep rows carry totals.
