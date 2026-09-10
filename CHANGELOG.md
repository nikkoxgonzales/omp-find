# Changelog

All notable changes to omp-find are documented here, Keep-a-Changelog style.
Version pins (`package.json`, `.omp-plugin/marketplace.json`, docs) move in lockstep.

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
