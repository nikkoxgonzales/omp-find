# fff upstream intel (2026-09-11)

Method: GitHub REST API, unauthenticated (~15 calls, inside 60/hr budget —
`pulls?state=open`, `pulls?state=closed&page=1`, `issues?state=all`,
per-file patches for #864/#863/#862/#728/#832/#829/#827/#741, issue bodies for
#849/#846/#843/#830/#795/#778, one search call for whole-word status).
Local ref `C:/Users/nikko/Desktop/cc/f10/.temp/references/fff` at `d84c0a10`
(2026-08-31) == upstream #845, so merged-after-2026-08-31 vs open/unmerged vs
issues are distinguished below. Ranked by agent-value per line of code.
No `src/` changes — research output only.

## STEAL (directly portable)

### 1. Exact filename-stem bonus — open PR #728 (unmerged since 2026-07-29)

Upstream (`crates/fff-core/src/score.rs`): 40% bonus exact filename, **30%
bonus exact stem** (`needle_len + 2 <= fname_len`, `bytes[needle_len] == '.'`,
no second dot), 16% fuzzy-in-filename. Absent from local ref (`grep stem
score.rs`: no hits).

Exact omp-find change: `src/search.ts` `fuzzyScore` — after the basename
full-pattern `-20` bonus, add stem check (pattern equals basename minus final
single extension) with bonus `-10`. Pure function, ~8 lines; table-test it per
`docs/fff-findings.md` §5 (`// fff score.rs: …` source comments). No behavior
change except tie-breaks among basename hits; directly serves the "exact
filename → read directly" coaching.

Ref: https://github.com/dmtrKovalenko/fff/pulls/728

### 2. Prefix promptGuidelines with tool name — merged PR #741

Upstream (`packages/pi-fff/src/index.ts`): every guideline prefixed with
`${toolNames.grep}:` etc.

Exact omp-find change: `src/tools.ts` — prefix every `promptGuidelines`
entry with its tool name (`ffgrep: …`, `ffoutline: …`, …); mirror in the
README agent-sees block. ~4 edited strings, zero risk. Matters more now we
register 7 names (4 tools + aliases) where cross-tool guideline bleed is
likely.

Ref: https://github.com/dmtrKovalenko/fff/pulls/741

## ADAPT (idea portable, implementation differs)

### 3. Whole-word content flag — issue #849 (closed, UNIMPLEMENTED)

Motivating case: searching `port` returns `export`/`portNumber`; requester
wants a flag, off by default, with boundaries checked **before** per-file/page
limits (rejected substring matches filling `maxMatchesPerFile` + cursor
advancing = unrecoverable). Search-API check confirms no whole-word code
exists upstream; local ref grep: no hits.

Live-scan translation: add `wholeWord` param to `ffgrep`. rg path passes rg
`-w`/`--word-regexp` (no regex construction). Walker path tests
`escapeRegExp(symbol)` wrapped in `\b(?:…)\b` per line; document ASCII-`\b`
limits. Upside vs upstream: their core pagination worry **cannot happen
here** — our cursors re-fetch and slice the full match set, so boundaries are
enforced before any limit by construction. ~10 lines + tests.

Ref: https://github.com/dmtrKovalenko/fff/issues/849

### 4. Hashline `[path#TAG]` headers for omp editability — open issue #795

Upstream proposal (verified empirically on omp 0.10.5-era: hand-minted `DD92`
applied without a prior read): prefix each file's match group with
`[<relpath>#<TAG>]`, rows as `N: text`, so omp `edit` anchors with no
follow-up `read`. Tag recipe `@oh-my-pi/hashline/src/format.ts:108-121`,
gate `patcher.ts:688,728`. Filed 2026-08-17, still open.

Live-scan translation: needs **pure-TS xxHash32** (~30 lines — Node has no
`Bun.hash`) verified against hashline vectors; gate behind flag or omp-detect.
Highest agent-value per call (removes a follow-up read per edit); moderate
cost, host-native, zero deps. Verify the recipe against the installed omp
before shipping.

Ref: https://github.com/dmtrKovalenko/fff/issues/795

### 5. Smart-case mode — merged PR #609 (upstream default `smart_case:true`)

Upstream: `case_mode` smart/sensitive/insensitive (`conf.lua`,
`GrepOptions`). Ours: `literal:true` + opt-in `ignoreCase`.

Live-scan translation: add opt-in third state (insensitive unless pattern has
uppercase). rg path: `--smart-case`; walker: conditional lowercase. Defaults
untouched. Tiny.

Ref: https://github.com/dmtrKovalenko/fff/pulls/609

## WARNINGS (do not re-introduce; validations noted)

### 6. Event-loop block on external-path grep — open issue #843 (OUR GAP)

A sync native call past the JS-side 10s budget wedged the whole Pi process
(`Promise.race`/timer can't fire inside FFI). Our `execFile` design can't
wedge the loop, **but** the runaway-background-scan half applies: on timeout
our `Promise.race` rejects while `fallbackGrep` keeps scanning (fd/CPU
pressure). The rg path is kill-guarded via execFile timeout; the walker path
is not. Fix (~5 lines, no API change): cooperative deadline check per
directory batch in `walkFiles`/`fallbackGrep`.

Ref: https://github.com/dmtrKovalenko/fff/issues/843

### 7. Silent path-constraint widening — open issue #830 (validation, no gap)

Upstream drops the `path` constraint on zero exact matches and presents
frecency-ranked repo-wide noise as related. **Never port this fallback.**
Our filter applies tools-side over the full set and returns honest empty.
Watch open #831 ("keep grep path constraint when the pinned file exists")
for the sanctioned fix shape.

Ref: https://github.com/dmtrKovalenko/fff/issues/830

### 8. Native crash class — immune by construction

Open #846 (`simd_path.rs:109` index-OOB panic in opencode), #835 / #786
(Android arm64 SIGSEGV), closed #772 (ClearCache+Scan SIGSEGV), closed #783
(`MDB_READERS_FULL`), merged #865 (bigram-chunk binary skip). All FFI/LMDB/
mmap/arena. Corollary: never port arena/SIMD comparison tricks — #862's
`[0u8; 512]` stack buffer silently miscomparing >512B paths is impossible
under JS string equality; our `fuzzyScore` needs no length cap.

Refs: https://github.com/dmtrKovalenko/fff/issues/846

### 9. Checked-and-clear — no action

- Open #864 (left-to-right colon scan past `C:\` in `location.rs`): only
  matters with `file:line` query parsing; `parseFindQuery` does none.
- Open #863 (`Status::CURRENT == 0` `contains`-everything mislabels
  conflicted files "clean" in `git.rs`): libgit2-specific; our
  porcelain-text set never labels anything clean (`??` untracked
  intentionally counts as modified).
- Open #862: see rank 8.

## REJECT (index/watcher/picker/distribution surface, no portable core)

### 10. Index/watcher/picker-only

#848 `--max-cached-files` cap semantics, #847 cache-limit miswiring review,
#850 shared-index worktree leakage, #834 persist-results-to-file (host owns
artifacts), #822 ui-only mode, #852 clickable rendering, #717 `--tools` flag
(host owns tool surface), #859 indexing RSS (our `RG_BUFFER`/walker streaming
already bounded), #561 rg-CLI, #473 submodule/sparse e2e, all picker/nvim/
LMDB items. Several (#847, #850) actively validate the no-index philosophy.

## Suggested-next order

Ranks 1+2 first (both <15 lines + table tests) → rank 3 → rank 4 after
verifying hashline vectors against the installed omp → rank 6 deadline check
alongside any walker touch.

## Existential validation (for `docs/extension.md` rationale)

Open issue #778: pi-fff is unusable under omp — the Bun-compiled omp runtime
exposes `globalThis.Bun`, so `detectRuntime()` picks `fff-bun`, which cannot
resolve inside the standalone binary (`Cannot find module '@ff-labs/fff-bun'`
despite a complete install). A host-native, zero-native-dep design isn't
taste — it's load-bearing. Ref: https://github.com/dmtrKovalenko/fff/issues/778

## Refs

- PRs: #728 #741 #609 #864 #863 #862 #832 #829 #827
  (`https://github.com/dmtrKovalenko/fff/pulls/<N>`)
- Issues: #849 #795 #843 #830 #846 #835 #786 #778
  (`https://github.com/dmtrKovalenko/fff/issues/<N>`)
- Local paths read: `crates/fff-core/src/{score,simd_path,types,git}.rs`,
  `crates/fff-query-parser/src/location.rs`,
  `crates/fff-core/src/{grep/{grep,fuzzy_grep,types},index/constraints}.rs`,
  `packages/pi-fff/src/index.ts` (via API patches)
