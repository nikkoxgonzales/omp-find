# Goldmine — ranked steal list for omp-find 0.5.0+

Research-only; no `src/` changes. Method: remote-first (GitHub API READMEs,
raw sources, ast-grep docs site, aider docs, web search), then every claim
re-grounded against shallow clones in
`C:/Users/nikko/Desktop/cc/f10/.temp/references/` (revs pinned per pick;
all present 2026-09-11). Ours: `docs/extension.md` (v0.4.0),
`docs/serena-findings.md`, `docs/fff-findings.md`, `docs/fff-intel.md`,
`src/tools.ts`, `src/search.ts`, `package.json` (0.4.0).

Baseline that shapes every rank: **0.4.0 already shipped most of the old
steal lists** — `ffoutline`, `ffcallers`, grep context (cap 5), `maxChars`
tiered fallbacks, `wholeWord`, `smartCase`, `cwd`, per-kind cursors,
tool-name-prefixed `promptGuidelines`, `approval:"read"`, auto-retry,
zero-state scan facts (`src/tools.ts:184-499`, `src/search.ts`). Picks below
are net-new only; already-shipped items are not re-listed.

Philosophy (non-negotiable, from `docs/extension.md` + `serena-findings.md`
§3 + `fff-intel.md`): zero deps, host-native, no watcher/LMDB/picker/index,
fresh-scan + frecency, honest-empty (never widen-and-pretend, cf. fff #830),
additive-only while 0.x. Fit values: **KEEP** = ports as-is,
**ADAPT** = idea ports, implementation differs, **REJECT** = stays out.

---

## 1. `ffstructural` — ast-grep pattern subset compiled to the rg core

- **Source:** `ast-grep/ast-grep` @ `fc2b153` (local: `../f10/.temp/references/ast-grep/`)
  + https://ast-grep.github.io/guide/pattern-syntax + `/reference/rule`
  (both fetched remote 2026-09-11; rule keys verified: atomic
  `pattern|kind|regex|nthChild|range`, relational
  `inside|has|precedes|follows` + `stopBy|field`, composite `all|any|not`).
- **What:** Structural code search where the pattern looks like the code:
  `$VAR` matches one AST node, `$$$ARGS` zero-or-more, same-name reuse
  (`$A == $A`) enforces structural equality, `$$VAR` captures unnamed nodes.
  Muvon/octocode's `structural_search` (doc `MCP_INTEGRATION.md`, local
  `../f10/.temp/references/octocode/` @ `bd7a8a5`) proves the agent-facing
  envelope: **exactly one of `pattern | symbol | references`**, plus
  `language`, `paths`, `context` — and `rewrite` as **preview-only diff**
  unless an explicit apply flag is set (hermes `code_refactor` is likewise
  dry-run by default; see pick 6).
- **Exact change:** new `src/structural.ts` (~120 lines, pure TS, zero deps):
  `compileStructural(pattern, {language})` lowers the verified subset to
  rigged regexes over `grepContents`: `$VAR` → language-aware atom
  (identifier `[\w$]+` / string / balanced-paren-lite per language family
  already in `src/outline.ts`), `$$$` → `.*?`, same-name `$A…$A` →
  backreference, `kind: call_expression`-style `kind:` → call-paren shape,
  `inside:`/`has:` → two-phase (outer region via `outlineFile` rows, inner
  regex within). New additive tool `ffstructural` (alias `structural`) in
  `src/tools.ts` reusing `storeCursor` (`structural_cN`), frecency-rank,
  `path` filter, `maxChars`, context — output rows labeled `approx:`.
  `symbol:` maps to `outlineFile`-filtered rows, `references:` delegates to
  `callersOf`. `rewrite` param returns a unified-diff preview and **never
  writes** (retrieval-only scope).
- **Fit:** ADAPT. No tree-sitter dep (would break "Node stdlib only");
  regex lowering is explicitly approximate, every row carries a line number
  the agent verifies — same mitigation as `ffoutline`/`ffcallers` today.
- **Cost:** Medium. One new file + one tool card; `search.ts` untouched
  except import. Risk is false-positive patterns, contained by the
  `approx:` label and preview-only rewrite.
- **NOT this:** the tree-sitter grammar set, YAML rule engine, `sg scan`
  lint configs, rewrite-apply (`update_all`), ESQuery `kind:` selectors —
  all daemon/deps surface with no live-scan equivalent.

## 2. Pi-extension packaging: `details` envelope + limit notices

- **Source:** `SamuelLHuber/pi-fff` @ `9a2f378`
  (local `../f10/.temp/references/pi-fff/src/index.ts`) — verified lines:
  `details: {totalMatched, totalFiles, truncated}` on every execute
  (:421-428, :542-549), `"N matches limit reached. Use limit=2N"` notices
  (:403-415, :525-540), `promptSnippet` + `promptGuidelines` + `label`
  (:346-362, :483-497), `registerFlag` + `session_start`/`session_shutdown`
  lifecycle (:305-324). Cross-checked remote against
  `dmtrKovalenko/fff/packages/pi-fff` README + `src/index.ts`
  (modes `tools-and-ui|tools-only|override`, `/fff-health|/fff-rescan|/fff-mode`,
  `fffFileAnnotation` one-tag `[git in git]|[often touched]` rule,
  weak-match sample trim at 50% of `len*12`).
- **What:** The remaining packaging gap: our `execute` returns text only,
  but the omp host result shape already allows `details`
  (`docs/extension.md`: `{content, details?}`) — we just never send it.
- **Exact change:** `src/tools.ts` only — all four defs return
  `{content, details: {totalMatched, totalFiles, truncated}}`; add pi-fff's
  limit-reached notice line (`"${limit} matches limit reached. Use
  limit=${limit*2}"`) next to our cursor footer; add one-line
  `promptSnippet` per tool (host-indexed summary; guidelines stay).
- **Fit:** KEEP. Pure output-shaping, additive, no ranking/pagination change.
- **Cost:** Low (~20 lines). Zero behavior risk; hosts that ignore `details`
  see identical text.
- **NOT this:** `@`-mention autocomplete provider, `CustomEditor` TUI
  overrides, `renderCall`/`renderResult` (pi-TUI-only surface, omp has no
  such hook), LMDB frecency/history DBs, `waitForScan` indexed init,
  `override`-renaming our tools (our `resolveFindMode` already owns this),
  weak-match sample trim (silently dropping rows violates honest-empty).

## 3. Gograph query contracts: snapshot-bound cursors + exact/possible labels

- **Source:** `ozgurcd/gograph` @ `7019bc0`
  (local `../f10/.temp/references/gograph/docs/query-contracts.md:1-103`,
  README `:1-84`).
- **What:** The strictest pagination honesty seen anywhere: cursors bind to
  graph content + command + filtered identities (stale cursor → explicit
  restart guidance, never silent re-offset); every page carries
  `total|returned|truncated|next_cursor`; byte budget (16 KiB native) may
  return *fewer* rows than the limit; `impact` labels every path
  `exact|possible` (`--exact-only` to exclude); ambiguous names return
  `status=ambiguous` + sorted candidates instead of picking one; oversized
  single rows are *refused with narrowing guidance*, never silently cut.
- **Exact change:** `src/tools.ts` — bind cursor state with a scan
  fingerprint (`cwd + query + file count + mtime-max` captured at fetch;
  mismatch on resume → `"cursor expired: tree changed; re-run query"`
  instead of a shifted page); `src/search.ts` `callersOf` rows gain
  `certainty: "exact"|"possible"` (import/call-paren sites exact, member
  access `.SYM` possible) threaded into `ffcallers` output as
  `[possible]` tags + an `exact_only` param; ambiguous multi-file symbol
  hits return a candidate list, not a merged guess.
- **Fit:** ADAPT (their snapshot is a persisted graph; ours is a per-call
  fingerprint — same honesty, no index).
- **Cost:** Low-medium. No new tools; touches cursor + callers rows only.
- **NOT this:** the Go graph build, CHA/SSA enrichment, `gopls` toolchain
  calls, MCPB/registry distribution, mermaid output.

## 4. `ffmap` — aider repo-map shrunk to zero-deps

- **Source:** aider repo-map (grounded via aider.chat docs + PageRank
  explainers, search 2026-09-11): ctags/tree-sitter definitions+references
  → file graph → graph-rank → top definitions rendered scope-elided inside
  a token budget (binary-search fit), budget shrinking as chat fills.
- **What:** A repo overview that costs hundreds of tokens, not file reads:
  per-file depth-0 outlines, files ranked by importance, output fitted to
  `maxChars`.
- **Exact change:** new additive tool `ffmap` in `src/tools.ts` +
  `rankMap` in `src/search.ts`: walk once (`listFiles`), `outlineFile`
  depth-0 per file, rank files by `frecency × git-modified-boost ×
  import-centrality` (centrality = in-degree counted with the existing
  import-line patterns from `callersOf` — a poor-man's PageRank with zero
  new machinery), then binary-search the file cutoff to fit `maxChars`
  (same `_limitLength` family as our tiered fallbacks). Output:
  `path:` + depth-0 symbol lines for the top files + `... (N files
  omitted; raise maxChars or ffoutline <file>)`.
- **Fit:** ADAPT. No tree-sitter/ctags binary (regex outlines), no
  embeddings, fresh scan every call.
- **Cost:** Medium. One tool + one rank function; bounded by existing
  `PAGE_MAX`/walker machinery.
- **NOT this:** chat-coupled dynamic budget, elided-body rendering,
  tree-sitter extraction, anything persistent.

## 5. Fused symbol dossier — codanna `semantic_search_with_context` × hermes `code_capsule`

- **Sources:** `bartolli/codanna` @ `12e823c` (README headline command:
  one call → symbol identity + signature + docstring + callees with call
  sites + callers + blast radius + `symbol_id`s + chaining `Guidance:`);
  `rewasa/hermes-code-intel-plugin` @ `87b9c32`
  (local README `:21-51`: `code_capsule` = signature + doc + definition +
  top references + imports in one shot, replacing N calls).
- **What:** Both converge on the same lesson: agents pay per round-trip,
  so the highest-value shape is a **pre-correlated dossier**, not another
  index. Everything in it we can already compute live.
- **Exact change:** new additive tool `ffcapsule` (`src/tools.ts` +
  `capsuleOf` in `src/search.ts` composing existing cores only):
  `outlineFile` row (signature) + doc-comment lines above it +
  `callersOf` top-10 + import-line hits + `Guidance:` footer with the
  cheapest next call (data-driven, e.g. `ffoutline <top-caller-file>`).
  No new scan machinery — pure composition, paged via `capsule_cN`.
- **Fit:** ADAPT (their fusion is index-backed incl. semantic/embedding
  matches; ours is live-scan deterministic).
- **Cost:** Low-medium. Composition only; the `Guidance:` line generalizes
  our static card coaching into per-result next steps.
- **NOT this:** embeddings/vector search, `symbol_id` registries, doc-RAG
  collections, the disc/tree visualisation plugin.

## 6. Mechanical nudges with budgets — hermes `code_intel_nudges.py`

- **Source:** `rewasa/hermes-code-intel-plugin` @ `87b9c32`
  (local `code_intel_nudges.py:1-83` + README `:52-60` steering hints).
- **What:** Forensics-driven fix for agents ignoring the smart tools
  (2.5k intel calls vs ~104k raw calls): append a **one-line hint to tool
  results** via a hook that always fires, capped at 3 per trigger-type per
  session, source-files-only whitelist, min-lines gate (200), LRU-bounded
  state with `forget_session` cleanup. Plus static description splicing
  (`read_file` → "prefer code_symbols…").
- **Exact change:** `src/tools.ts` — a ~40-line `nudge()` helper:
  appends one rotating cross-tool tip to `fffind`/`ffgrep` footers
  (e.g. `tip: ffcallers <name> finds call sites without grep chains`),
  budget 3 per tool per process (Map + cap, same eviction as
  `storeCursor`), fires only when the result was non-trivial (hits > 5)
  so trivial calls stay clean. Static half: extend our four descriptions
  with one "prefer X over shell Y" clause each (pi-fff wording family).
- **Fit:** ADAPT. Our `promptGuidelines` are static card copy; nudges are
  the dynamic, budgeted complement. No system-prompt surgery (host owns it).
- **Cost:** Low. Footer-only; never blocks/redirects.
- **NOT this:** prompt splicing into subagent system prompts, per-session
  DB forensics, unbounded per-path state.

## 7. Token knobs `concise` + `minify` — bgauryy/octocode

- **Source:** `bgauryy/octocode` @ `c265e3f` (local
  `../f10/.temp/references/octocode-mcp/`; README tools table fetched
  remote 2026-09-11): `concise:true` → path/title-only lists;
  `minify: symbols|standard|none` controls read density;
  `localGetFileContent` region/match-slice reads; every result carries
  next-step hints to the cheapest follow-up.
- **What:** Two orthogonal density controls that compose with (not replace)
  cursors + `maxChars`.
- **Exact change:** `src/tools.ts` — `concise: true` on `fffind`
  (paths only, no frecency annotations/footers beyond cursor),
  `ffgrep` (path:line only, no text — a cheaper existence probe),
  `ffoutline` (name-only rows); `ffgrep`/`ffcallers` rows already support
  context — document `context:0 + concise` as the minified end. One
  shared `density` rendering branch per tool; cursor state carries the flag.
- **Fit:** KEEP. Pure rendering options, additive params, defaults untouched.
- **Cost:** Low (~30 lines). No core changes.
- **NOT this:** GitHub/PR/npm/remote-clone tools, secret redaction
  pipeline, Rust engine, `ghCloneRepo` (network + clone = host's job),
  `localFindDeadCode` reachability (index-backed; our dead-code stays
  manual via callers-zero-hits, unlabeled).

## 8. `expand: function` for grep rows — ox-codes scoped search

- **Source:** `anatolykoptev/ox-codes` @ `c9f5545`
  (local `../f10/.temp/references/ox-codes/`, README endpoints table +
  `docs/API.md` per README).
- **What:** `POST /search/scoped` (regex restricted to named AST regions)
  + `expand: none|function|block` returning the enclosing block instead of
  the line. The portable half is *enclosing-symbol attribution*, not the
  service.
- **Exact change:** `src/search.ts` — `GrepOptions.expand?: "none"|
  "function"`; when set, `attachContext`-style post-pass calls
  `outlineFile` once per file-with-hits and attributes each match to the
  nearest depth-0 symbol at/above its line (`▶ in <kind> <name>` header
  row). `src/tools.ts` threads the param + cursor state. Default `none`.
- **Fit:** ADAPT (their regions are tree-sitter-scoped; ours are
  outline-row-attributed, approximate, line-anchored).
- **Cost:** Medium-low. One extra outline pass per file on the page, only
  when asked.
- **NOT this:** the HTTP service, ripgrep/tree-sitter/ast-grep wrapper
  crates, mtime-keyed result cache (an index-that-lies in waiting —
  violates fresh-scan), dataflow/taint engine (compiler-grade analysis
  over an HTTP boundary; `ffcallers` depth-BFS covers the agent need).

## 9. Transitive callers + impact ordering — codeseek callgraph

- **Source:** `CodeBendKit/codeseek` @ `981bd23`
  (local `../f10/.temp/references/codeseek/README.md:1-126`):
  `callers|callees|callgraph <symbol>` with configurable bi-directional
  depth, MD5-incremental index, `status` stats, git-hook auto-refresh.
- **What:** `ffcallers` answers depth-1 upstream today. The missing
  agent question is "how far does this spread?" — codeseek's `callgraph`
  (callers + callees, depth-N) in one call.
- **Exact change:** `src/search.ts` — `callersOf` gains
  `depth?: 1|2|3` (BFS over its own 3-pattern matcher, cycle-guarded via
  visited `path:line` set, each ring labeled `depth:N`, hard-capped by
  `GREP_CAP`); `ffcallers` threads `depth` + cursor state. Downstream
  (`callees`) approximated only after pick 8 lands (needs enclosing-body
  ranges) — explicitly out of this pick.
- **Fit:** ADAPT (their graph is indexed/petgraph; ours is live-BFS,
  slower but never stale).
- **Cost:** Medium-low. Bounded by existing caps; depth defaults 1.
- **NOT this:** LanceDB/Tantivy indexes, embedding setup wizard,
  `install-hooks` git automation, binary-distribution wrapper.

## 10. Honest session stats — tokensave staleness check, minus the ledger marketing

- **Sources:** `aovestdipaperino/tokensave` @ `9ebe7ec`
  (local `../f10/.temp/references/tokensave/`; README fetched remote):
  on-demand staleness check on every MCP call (30s cooldown) + catch-up
  sync; `tokensave gain` savings ledger; crash-isolated extractor workers;
  `tokensave_record_decision`/`record_code_area`/`session_recall`
  cross-session memory. `zzet/gortex` @ `56a1c29` (README fetched remote):
  `gortex savings` $-priced dashboard, GCX1 wire format (−27% vs JSON).
- **What:** The portable half is *freshness + accountability without an
  index*: we already scan live (staleness impossible by construction) but
  we report nothing about the session. The ledger half is rejected as
  marketing (modeled $-saved numbers are unverifiable; same lens as the
  codebase-memory-mcp headlines, pick 12).
- **Exact change:** `src/commands.ts` `/find-health` gains a session-stats
  block (calls served per tool, rg-vs-walker mix, timeouts, avg ms —
  in-memory counters in `src/tools.ts`, reset by `/find-rescan`);
  `src/search.ts` `status()` unchanged. No persistence (frecency file
  stays the only disk state).
- **Fit:** ADAPT (their staleness check guards an index; our counters
  guard live-scan performance claims with facts).
- **Cost:** Low. Counters + one health block.
- **NOT this:** savings ledgers / $-dashboards / GCX1 (our plain-text rows
  already beat JSON on tokens), git-hook auto-sync, cross-session memory
  DB (host owns memory; our `ffnote` equivalent stays out per prior
  triage), subprocess-isolated parsers (no native parsers to crash).

## 11. Tiered tool surface + `hot` — codedb profiles done our way

- **Source:** `justrach/codedb` @ `4eaca89`
  (local `../f10/.temp/references/codedb/README.md:134-263` verified):
  22 MCP tools but agents see **five one-shots by default**
  (`context|explain|callpath|list_dir|status`), profiles
  `mini|core|slim|full` via env; `codedb_hot` (recently modified files);
  `codedb_explain` (def body + callers, one call); `codedb_read`
  (`if_hash` skip-unchanged, `compact`); sensitive-file blocking;
  portable snapshot; DeepWiki for public repos (local-only by design).
- **What:** Validation of our 4-tool surface (their data says five
  one-shots is the sweet spot) + two portable rows.
- **Exact change:** (a) `fffind` gains `hot` sort note — already covered
  by `git:modified` + frecency recency; document the recipe
  (`git:modified` query ≈ `codedb_hot`) in README instead of code.
  (b) `codedb_explain` ≈ pick 5's `ffcapsule` — no separate change.
  (c) Adopt the *profile* idea at our scale: `OMP_FIND_MODE` already
  switches names; add `OMP_FIND_TOOLS=core|full` (default `core` =
  fffind+ffgrep+outline+callers+ffmap+ffcapsule+ffstructural as they land;
  `full` adds nothing today — reserved) so future tools don't bloat the
  default surface. `src/tools.ts` gate only.
- **Fit:** KEEP (a+b are docs/composition), ADAPT (c).
- **Cost:** Low. Mostly documentation + one env gate.
- **NOT this:** trigram/word indexes, file watcher, snapshot format,
  `codedb_query` pipeline language, `edit` fallback (retrieval-only),
  sensitive-file blocking (silent drops = lying empties per fff #830 —
  hosts own secret handling via approval tiers), DeepWiki remote.

## 12. Skepticism anchor: what codebase-memory-mcp's headlines teach us to measure

- **Source:** `DeusData/codebase-memory-mcp` @ `055fbb7`
  (local `../f10/.temp/references/codebase-memory-mcp/`; README fetched
  remote 2026-09-11): 42.9k★, "158 languages, sub-ms queries, 99% fewer
  tokens", "Linux kernel in 3 min", arXiv:2603.27277 preprint claiming
  "83% answer quality, 10× fewer tokens, 2.1× fewer tool calls vs
  file-by-file across 31 repos". Adjacent: `Muvon/octocode` @ `bd7a8a5`
  (local `doc/` verified: live tree-sitter graph with **no index** for
  graphrag base ops; indexed enrichment optional) and its benchmark
  showing a generic reranker **regressing** code retrieval
  (Hit@5 0.732→0.598) — the honest negative result most READMEs omit.
- **What:** Apply the required skepticism lens symmetrically: headline
  ratios compare against the weakest baseline (naive file-by-file reads),
  not against a tuned live-scan tool; star counts measure distribution,
  not retrieval quality; preprint evals are self-graded harnesses. The
  portable residue is real but narrow: (a) edge-confidence taxonomy —
  their `CALLS` vs `CALL_REFERENCE` vs `USAGE` tiers map directly onto
  pick 3's `exact|possible` labels; (b) `get_architecture` single-call
  overview maps onto pick 4's `ffmap`; (c) Muvon's **live-graph-first,
  index-optional** split is the existence proof that our no-index stance
  scales to graph queries.
- **Exact change:** none beyond picks 3+4 — this pick is the decision
  record. Our counter-practice (stolen from roam-code's published losses,
  local `../f10/.temp/references/roam-code/` README bench archaeology, and
  Muvon's reranker regression): every future claim in our README ships
  with corpus + n + baseline (`rg`/`walker` on the same tree), losses
  published alongside wins.
- **Fit:** REJECT the system (daemon + watcher + SQLite + bundled
  embeddings + 3D UI + 45-client installer + cross-repo galaxies);
  KEEP the measurement discipline.
- **Cost:** Zero code. Ongoing honesty cost only.
- **NOT this:** everythingdaemon-shaped — coordination daemon, background
  watcher, auto-index, `.codebase-memory/graph.db.zst` committed artifacts
  (a lying cache with merge conflicts), Hybrid-LSP C resolvers, Cypher
  endpoint, ADRs, Louvain clustering (their own README admits symbols are
  never embedded — clustering file-level architecture is host-work).

---

## Explicit REJECT bin (surveyed, staying out)

- **LSP-spawn backends** (`isaacphi/mcp-language-server` @ `e439584`,
  local `tools.go:1-83` verified thin-shim shape; hermes 11 LSP tools;
  octocode `--with-lsp`): spawning/heating per-language servers violates
  zero-deps + no-daemon. Our `callersOf`/`outlineFile` interface stays
  LSP-swappable later — that upgrade path is the only takeaway.
- **Watcher/indexer embedding systems** (`johnhuang316/code-index-mcp` @
  `d395cbf`, verified README `:274-306`: shallow/deep indexes, file
  watcher, `needs_deep_index` errors): the index-that-lies, now with two
  staleness tiers. Their portable bits (literal-by-default, ugrep/rg/ag
  auto-detect, per-field param docs) we already have or cover in pick 2.
- **Rewrite-apply tools** (ast-grep `rewrite`/`update_all`, hermes
  `code_refactor` apply, tokensave edit primitives, gortex
  `preview_edit`/`simulate_chain`): retrieval-only scope. Preview diffs
  only (pick 1).
- **Repo-map chat coupling, task-compiler injection, PR gates, diagnostics
  loops** (roam-code hooks/preflight-gates, hermes `code_diagnostics`,
  serena `DiagnosticsContext`): host/CI owns verification and prompts.
- **Surface bloat**: 80–246 MCP tools (tokensave/roam-code), 175
  configurable tools (gortex), MCP prompts/skills registries, graph UIs,
  $ dashboards — pick 11's profile gate is the firewall.
- **Distribution surface**: npm/binary installers, MCPB registry,
  marketplace plugins, signed releases — our `dist/`-committed +
  marketplace wrapper already solves install (`docs/extension.md`).

## Suggested order (0.5.0 train)

2 → 6 → 7 (packaging + coaching, all low-cost, one minor) →
3 → 5 (honesty labels + dossier) → 8 → 9 (grep-shape growth) →
1 → 4 (structural + map; the two medium builds) → 10 → 11 (stats + gate).
Pick 12 is process, ongoing. All additive → single `0.5.0` minor per
`docs/RELEASE.md` §2 (new tools + optional params, no contract break).

## Refs

- Ours: `docs/extension.md`, `docs/serena-findings.md`,
  `docs/fff-findings.md`, `docs/fff-intel.md`, `docs/SIMULATOR.md`,
  `docs/RELEASE.md`, `src/tools.ts`, `src/search.ts`, `package.json` (0.4.0).
- Local clones (`C:/Users/nikko/Desktop/cc/f10/.temp/references/`,
  revs 2026-09-11): pi-fff `9a2f378` (`src/index.ts:305-564`),
  ast-grep `fc2b153`, hermes-code-intel-plugin `87b9c32`
  (`README.md:1-123`, `code_intel_nudges.py:1-83`), octocode (Muvon)
  `bd7a8a5` (`doc/MCP_INTEGRATION.md`), octocode-mcp (bgauryy) `c265e3f`,
  codanna `12e823c`, codeseek `981bd23` (`README.md:1-126`), gograph
  `7019bc0` (`docs/query-contracts.md:1-103`, `README.md:1-84`), roam-code
  `6feecbd`, codebase-memory-mcp `055fbb7`, codedb `4eaca89`
  (`README.md:134-263`), code-index-mcp `d395cbf` (`README.md:104-333`),
  mcp-language-server `e439584` (`tools.go:1-83`), tokensave `9ebe7ec`,
  gortex `56a1c29`, ox-codes `c9f5545`.
- Remote (no clone needed): `dmtrKovalenko/fff/packages/pi-fff`
  (README + `src/index.ts` via raw), ast-grep docs
  (`/guide/pattern-syntax`, `/reference/rule`), aider repo-map docs
  (aider.chat + PageRank explainers via web search).
