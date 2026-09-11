# Changelog

All notable changes to omp-find are documented here, Keep-a-Changelog style.
Version pins (`package.json`, `.omp-plugin/marketplace.json`, docs) move in lockstep.
## [0.8.9]

### Fixed

- Frecency keys are canonicalized — `read`/`edit`/`write` paths with `:line-range`/`?q=`/`#tag` selectors and non-file URIs (`xd://`, `agent://`, …) previously stored keys `score()` could never match, so ranking still couldn't move despite the 0.8.8 wiring. Paths now strip selectors, skip non-file URIs, and store cwd-relative inside the project — `read src/x.ts` and `read C:/repo/src/x.ts` hit the same key.

## [0.8.8]

### Fixed

- Frecency is now wired: `tool_result` events for read/edit/write record opens, and ffoutline/ffcapsule record their target files — `fffind` ranking now actually learns (previously recordOpen had zero call sites; all stores stayed empty).
- Cursor-only resume works: `{"cursor":"grep_c5"}` no longer fails schema validation — the primary param is optional when a cursor is present (the footer's own 'pass cursor' hint now works verbatim).
- `ffoutline` depth:1 lists methods with single-line `{}` bodies, trailing commas, and Java constructors (new `ctor` kind).
- `ffstructural kind:class` matches `public`/`private`/`final`/`sealed`/`export default` classes; `kind:call` no longer returns the definition line.
- `ffcapsule` def-hunt prefers source files over docs/dist — `capsule parseFindQuery` resolves src/search.ts, not a README example.
- `ffcallers` `ignoreCase` no longer leaks the definition line; keyword-less defs (object-literal methods, `constructor(`) are filtered from caller rows.
- `ffcallers` `depth` validates to 1|2|3 (was silently clamped); `limit` must be >= 1; non-string pattern/symbol/path params rejected with `expected string`.
- `scan root is not a directory` distinguishes file-as-cwd from a missing root.

## [0.8.7]

### Fixed

- `export async function` / `async function` now outlined (TS/JS, Rust `pub async fn`, generic rule) — previously invisible to ffoutline/ffmap and the capsule def-hunt.
- `ffcallers` depth>=2 runs frontier symbols through a bounded parallel pool (8) — walker depth-2 on a ~400-file tree dropped from ~65s to ~12s.
- `ffcapsule` def-detection outlines candidates at depth 1 — methods (e.g. `constructor`) now resolve as definitions.
- Chained structural combinators (`inside: inside:`, `has: … << has:`) now error cleanly instead of silently compiling to literal text.
- Call sites past column 500 are verified against the full source line (per-file cache) instead of the truncated row text — no longer dropped.
- Oversized regexes (64KB+) surface the normalized `invalid regex` error (V8 lazy-compile forced at preflight; pattern text truncated to 200 chars in messages).
- Core `scope` values escaping the scan root (`../x`, absolute) now throw instead of silently widening to a full-tree scan.
- rg `[Omitted long line]` rows keep their real column (byte-col conversion early-out).
- Walker zero-width match at EOF without trailing newline now matches rg exactly.
- `status()` distinguishes missing rg (ENOENT) from present-but-failed (exit N / spawn error).
- Frecency `clear()` stamps a `clearedAt` tombstone — a stale in-memory cache in another instance can no longer resurrect cleared entries via merge-on-save.
- Cursor resume with different params appends a `note: cursor params in effect` line (stored page-1 params still drive the fetch).

## [0.8.6]

### Fixed

- Outline no longer drops methods named `constructor`/`toString`/etc. — `NOT_A_METHOD` lookup was a plain-object prototype leak; now `Object.hasOwn`.
- `kind:` rejects Object.prototype member names (`kind:__proto__` produced a match-everything regex; `kind:constructor` crashed the worker clone) — now clean `unknown structural kind` errors.
- Capped rg result sets are now deterministic: rg collects full stdout, sorts, then applies GREP_CAP — cursor chains over capped sets no longer dupe/skip rows. Capped results no longer mint cursors (footer hints to narrow the query).
- rg stdout >64MB (maxBuffer) and oversized argv (ENAMETOOLONG/E2BIG) now fall back to the walker instead of throwing.
- `ffcallers` no longer reports `foo` call/import sites inside `$foo`/`foo$bar` (post-filter on identifier boundaries); `$foo` sites now tag `[exact]` correctly.
- rg byte columns convert to character columns — multibyte lines now agree with the walker.
- `\p{...}` patterns containing identity escapes retry without the `u` flag instead of erroring on the walker.
- Leading `(?i)` inline flag maps to `ignoreCase` (rg accepts it; JS preflight rejected it).
- `fffind` file pins (`path: 'sub/file.ts'`) no longer join the pin into the fuzzy query — file pin + empty pattern lists the file.
- `path`/`scope` values escaping the scan root (`../x`, absolute) now error instead of silently widening to a full-tree scan.
- Frecency `entries` uses null-prototype objects — a `__proto__` key now persists.

## [0.8.5]

### Fixed

- rg grep no longer drops matches on lines containing a lone `\r` (vimgrep row parse was `\r`-intolerant); row text strips `\r` on both backends.
- Walker regex reports zero-width matches (`^`, `^$`, `z*`) instead of silently skipping them.
- `wholeWord` uses identifier-boundary semantics (`\b` at word-char edges, `[\w$]` lookarounds at non-word edges) — `cat.`/`.cat` now match like `rg -w`.
- Literal `ignoreCase` no longer over-matches length-changing folds (e.g. Turkish İ) — routed through the regex path.
- `ffcallers`/`ffcapsule` resolve symbols starting with non-word chars (`$foo`) via edge-conditional boundaries.
- `ffcapsule` seeds definition candidates from a definition-shaped grep, so defs outside the top-30 mention files are found.
- Context rows no longer emit a phantom empty row past EOF.
- GREP_CAP (20000) now bounds rg too; `GrepResult.capped` surfaces as `N+`/`(capped)` in totals.
- `.git` pointer files (linked worktrees) skipped by the walker.
- `git:modified` in a bare repo reports `needs a worktree (bare repository)`.
- `\p{...}`/`\u{...}` patterns compile with the `u` flag on the walker/worker path.
- Frecency merges per-key on save (max count, max last) — two omp instances on one project no longer lose whole batches.

## [0.8.4]

### Fixed

- Walker regex scan runs in a worker thread: a catastrophic-backtracking pattern (e.g. `(a|a)*b` on long lines) blocked the event loop so `timeoutMs` could never fire — now terminated at the deadline with the same `grep timed out` error; reachable end-to-end via rg-error→walker fallback. Literal scans stay inline (indexOf cannot hang).
- UTF-16LE/BE+BOM and UTF-8 BOM files decode correctly in the walker (BOM sniff before binary NUL check); UTF-8 BOM no longer shifts line-1 columns by one.
- Frecency store entries with non-numeric/non-finite count/last are dropped on load; `score()` never returns NaN.
- Page-limit notice no longer suggests `limit=100` (clamped to 50); it names the cap and points at the cursor.
- Match row text strips `\r` (\r-only/CRLF files could overwrite terminal rows).

## [0.8.3]

### Fixed

- Grep matches sort deterministically by path/line/col before paging on both backends (rg stdout order varies run-to-run; cursor page 2+ re-fetch could duplicate/skip rows despite the total+backend snapshot guard).

## [0.8.2]

### Fixed

- rg per-file runtime failure (numeric exit, e.g. exit 2 from one unscannable file — trailing-dot name, EACCES, broken symlink, FIFO — with `--no-messages` hiding which file) now falls back to the walker instead of killing the whole grep/listing; timeout rejections still rethrow and exit 1 (no matches) never rejects.
- Walker grep emits one row per match (rg parity) instead of one row per line, for both regex and literal patterns.
- Walker tracks visited realpaths so a symlink cycle can no longer loop traversal; `MAX_DEPTH=25` still bounds depth.
- Missing (or file-path) scan root is a clean `scan root not found: <dir>` error instead of a silent zero-state.
- `structuralGrep` references mode forwards `scan` to the underlying grep, so `scan: "mock"` and walker-forcing reach references search.
- Backslash path filters normalize to forward slashes before matching, in both the tools-layer filter and the capsule scoping rule.
- Over-budget grep counts re-fetch the full match set for the per-file summary (unfiltered fetches are paged) and use `1 file` grammar for single-file hits.
- Frecency writes serialize through an in-process queue, so parallel `recordOpen` calls no longer lose bumps (cross-process stays last-writer-wins).
- Outline missing-file error collapses raw syscall text + absolute path to the relative display form.
- Windows EBUSY test-cleanup retry (test-only).

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
