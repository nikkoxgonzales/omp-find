# Serena findings for omp-find

Research on [oraios/serena](https://github.com/oraios/serena) (`701e7c84`, 2026-09-08,
"Fix: health-check reported success after reference search failed (#1998)", v1.7.1.dev0).
Read-only; no `src/` changes. Constraint: anything proposed must fit omp-find
philosophy — no watcher, no stale index, no picker UI, host-native, zero deps,
fresh-scan + frecency re-rank, Node stdlib only.

## 1. Serena architecture (9 points)

1. **Symbol-level MCP toolbox, not text search.** Core read tools: `get_symbols_overview`
   (top-level symbols per file, depth param), `find_symbol` (name-path pattern
   `Class/method`, substring/kind filters), `find_referencing_symbols` (callers + 1-line
   context window), `find_implementations` / `find_declaration`,
   `get_diagnostics_for_file` / `get_diagnostics_for_symbol`. Edit tools mirror them:
   `replace_symbol_body`, `insert_after/before_symbol`, LSP `rename_symbol`, safe-delete.
   (`src/serena/tools/symbol_tools.py`)
2. **Dynamic LSP backend (SolidLSP, `src/solidlsp/`).** Spawns real per-language servers
   (~78 adapters: pyright/basedpyright/jedi, typescript/vts, gopls, rust-analyzer, clangd,
   omnisharp, jdtls…). All symbol queries go through live LSP
   document-symbol/references/hover/rename; edits sync back into the server. No static
   index — accuracy comes from the compiler, at the cost of spawning/heating servers.
3. **Thin static/file layer underneath.** `file_tools` (`read_file` with line ranges,
   `list_dir` recursive, `find_file` by mask, `search_for_pattern` regex + globs +
   context lines) covers non-code files and languages with no server.
   `restrict_search_to_code_files` routes "is this a definition?" queries to symbols,
   everything else to text.
4. **Onboarding + modes + contexts steer the agent before retrieval.** The onboarding
   tool emits a system-specific prompt that inventories structure/build/test and writes
   it to memory; modes (`editing`/`planning`/`one-shot`/`no-onboarding`/`benchmark`
   YAMLs) and contexts (claude-code, codex, copilot, ide…) subset which tools are even
   exposed per client. Retrieval quality is treated as a prompt + tool-subset problem.
5. **Markdown memory system** (`.serena/memories/`, write/read/list/delete/rename/edit,
   `mem:` cross-refs, `global/` prefix). Cross-session project knowledge — the layer our
   per-project frecency JSON only hints at.
6. **Answer-budget discipline everywhere.** Nearly every tool takes `max_answer_chars`
   plus `_limit_length` with tiered fallbacks (references → refs-without-context →
   per-file counts → "N references"; overview → depth-0 → kind counts).
   Pagination-by-truncation-with-summary, not cursors.
7. **Editing is verify-by-default.** Every editing tool wraps in `DiagnosticsContext`
   (re-query LSP diagnostics after the edit); `ReplaceInFiles` uses
   dry-run → occurrence-ids → apply with `expected_count` guard. Retrieval and
   verification are one loop.
8. **Language support = LSP marketplace breadth.** 78 server adapters behind a
   `DependencyProvider` pattern (auto-install/discover launch command). Jedi/static
   servers are fallbacks only; no Tree-sitter layer — unsupported language ⇒ text
   search only.
9. **Heavy tail: multi-project + dashboard + JetBrains plugin** (activate/remove/list
   queryable projects, cross-repo query, GUI log viewer). All server/daemon-shaped;
   irrelevant to a host-native plugin.

## 2. Portable ideas, ranked

### 1. `ffoutline` — approximate per-file symbol overview
- **What:** Serena's `get_symbols_overview` without LSP: top-level definitions per file
  (`path:line:col: kind name`), depth 0 default.
- **Why:** Serena's own guidance says overview-first before reading a new file. A 10-line
  outline answers "what lives here" at ~5% of the tokens and composes with ffgrep
  (outline → grep one symbol → read range).
- **Fit:** KEEP (adapted). No LSP, no deps, no index — fresh scan + frecency preserved.
  The "poor man's document symbols".
- **Shape:** Tool `ffoutline` (alias `outline`). Params `{ path (required, single file),
  depth?: 0|1, limit, cursor }`. Output:
  ```
  > ffoutline { "path": "src/search.ts" }
  src/search.ts:17:1: fn parseFindQuery
  src/search.ts:30:1: fn globToRegExp
  src/search.ts:151:1: fn findPaths
  … (8 more; pass cursor "c1" for the next page)
  ```
- **Sketch:** New `src/outline.ts` — regex pattern table per language family (TS/JS
  class|function|interface|enum|const-arrow, Python def/class, Go func/type, Rust
  fn/struct/enum/impl, Java/C# class/interface/method sigs, C++ coarse). `search.ts`
  untouched; `tools.ts` registers `ffoutline` + cursor state `{kind:'outline'}` reusing
  `storeCursor`/`pageOf`. Record frecency on outline→open, not on outline itself.
- **Cost/risks:** Low. Pure-TS regexes; false positives on weird formatting — mitigated
  because output is explicitly approximate and every hit carries a line number the agent
  verifies with read/ffgrep.

### 2. ffgrep context lines
- **What:** `contextBefore`/`contextAfter` params (default 0, max ~5) plus optional
  `codeOnly` (skip blank/comment-only context). Serena parity: `search_for_pattern`
  context lines + `content_around_reference`.
- **Why:** Serena's reference lookup always returns the 1-line window — agents
  disambiguate callers without a follow-up read. Our single-line rows force that extra
  read on every ambiguous hit.
- **Fit:** KEEP. Pure rg/walker + Node reads; no index. Generalizes ffgrep's
  `path:line:col: text` rows.
- **Shape:** `ffgrep` gains params; output keeps rows with `±N` context lines marked.
- **Sketch:** Extend `GrepOptions`/`GrepMatch` in `src/search.ts` (match carries optional
  context lines); rg path uses `rg --context N`, walker path reads the file once per
  file-with-hits and slices. `tools.ts` threads params through cursor state; frecency
  ranking unchanged (rank by match file, not context).
- **Cost/risks:** Medium-low. Two-pass cost only when flag set; bloat contained by the
  same 30/50 pagination and a hard per-call window cap.

### 3. `ffcallers` — approximate "who calls X?"
- **What:** Serena's `find_referencing_symbols` emulated with literal-aware text search
  (word-boundary / import-aware), explicitly approximate.
- **Why:** "Who calls X?" is Serena's highest-quoted agent value ("8–12 steps collapse
  into one call"). ffgrep can answer it today but needs 2–3 crafted queries
  (definition vs import vs call) that agents routinely get wrong.
- **Fit:** ADAPT. Serena uses LSP references; we use regex heuristics. Must NOT promise
  LSP accuracy.
- **Shape:** Tool `ffcallers` (alias `callers`). Params `{ symbol (required,
  e.g. 'parseFindQuery'), path?, limit, cursor }`. ffgrep-style rows over likely
  reference sites (imports + call parens + member access).
- **Sketch:** New `src/callers.ts` or `search.ts` function `callersOf(symbol, opts)`:
  2–3 rg patterns (`\bSYM\s*\(`, import lines, `\.SYM\b`), merge/dedupe by path:line,
  frecency-rank, page. Upgrade path: swap regex core for per-language LSP later —
  interface stays.
- **Cost/risks:** Medium. False positives (comments, same-named locals) — mitigated by
  labeling output approximate and documenting "confirm with read". No correctness risk
  to edits: we ship no rename.

### 4. `maxChars` + tiered summaries (Serena's `_limit_length`)
- **What:** Global `maxChars` param on fffind/ffgrep/ffoutline. When exceeded, return a
  shortened summary + refinement hint instead of a silent cut: `Matched 120>50 symbols.
  Per-file counts: {…}. Refine path/filter or raise maxChars.` Serena's tiered
  fallbacks (full → depth-0 → kind counts) map to ours (page → per-dir/per-file counts
  → totals).
- **Why:** Most transferable UX idea: degrade to counts/summaries instead of dumping 200
  hits. Our cursors solve the same problem mechanically but always cost a second call;
  summary-first lets the agent refine without paging.
- **Fit:** KEEP. Pure output-shaping; complements (does not replace) cursor pagination.
- **Shape:** Param + footer-family wording; per-tool fallback factories.
- **Sketch:** `tools.ts`: `_limitLength` helper + fallback per tool (find→per-dir counts,
  grep→per-file counts, outline→kind counts). `search.ts` untouched. Document in README
  tool cards.
- **Cost/risks:** Low-medium. Bookkeeping per call; surprise truncation mitigated by
  always emitting the deterministic summary line.

### 5. `ffnote` — single project-notes file (shrunk memory layer)
- **What:** Serena's `.serena/memories` + 6 memory tools ⇒ one local notes file the
  agent reads/writes through one tool. No onboarding workflow, no `mem:` graph, no
  global scope.
- **Why:** Serena's memory is where cross-session knowledge lives ("entry point X,
  generated dir Y, don't touch Z"); frecency learns *which files* matter but never
  *why*. A 20-line notes file saves a re-exploration scan every session.
- **Fit:** ADAPT (shrink). No retrieval-ranking interaction.
- **Shape:** Tool `ffnote` + file `.omp/var/omp-find/<hash>/notes.md` (next to
  frecency.json). `ffnote {text}` appends; `ffnote {}` (or `/find-notes`) reads.
- **Sketch:** New `src/notes.ts` (append/read/clear, Node fs only, ~60 lines);
  `commands.ts` gains `/find-notes` or folds into `/find-health` (`notes: N lines`).
  Zero interaction with `search.ts` ranking.
- **Cost/risks:** Low. One JSON-adjacent file; staleness mitigated by agent-owned writes
  only, small size cap, `/find-rescan` listing (not auto-dropping) notes.

## 3. Non-goals (what NOT to steal, and why)

- **LSP daemon / server spawning (SolidLSP):** violates zero-deps + no-daemon +
  host-native. Requires language binaries, warm-up, crash recovery — the exact
  process weight the README strips out. Outline + callers cover ~80% of the value.
- **LMDB/persistent symbol index + file watcher:** explicitly rejected by philosophy
  ("caches that lie are worse than a fresh scan"). Serena itself avoids a static index
  (LSP is live); we go further — live rg/walker every call.
- **MCP server / multi-editor bindings / picker UI:** already cut; Serena's MCP +
  dashboard + JetBrains client are distribution surface, not retrieval.
- **Symbolic edit tools** (`replace_symbol_body`, insert_after/before, LSP rename,
  safe-delete, dry-run occurrence-ids editing): out of scope — retrieval-only; the
  host owns mutation. (The dry-run→ids→apply *protocol* is worth copying only if we
  ever add a bulk-edit tool.)
- **Full Tree-sitter grammar set as a dependency:** native-module/wasm grammars break
  "Node stdlib only". Revisit only if regex outlines prove embarrassing; even then one
  optional grammar, not a set.
- **Modes/contexts prompt machinery + multi-project query:** session-prompt and fleet
  concerns belong to the host (omp), not a two-tool plugin.

## 4. Next step

Implement **`ffoutline` first** (idea 1: smallest, pure-TS, proves the symbol-direction
value without LSP), then **ffgrep context lines** (idea 2: touches only `GrepOptions` +
`tools.ts` params). Both are additive — no changes to fffind/ffgrep ranking,
pagination, or frecency — each verifiable with a throwaway script (outline a real src
file; grep with context 2), not new permanent tests.

## Refs

- Serena: https://github.com/oraios/serena — commit `701e7c84` (2026-09-08),
  v1.7.1.dev0.
  - `src/serena/tools/symbol_tools.py` — GetSymbolsOverviewTool, FindSymbolTool,
    FindReferencingSymbolsTool, FindImplementationsTool, FindDeclarationTool,
    GetDiagnosticsForFile/SymbolTool, ReplaceSymbolBodyTool, InsertAfter/BeforeSymbolTool,
    RenameSymbolTool, SafeDeleteSymbol.
  - `src/serena/tools/file_tools.py` — ReadFileTool, ListDirTool, FindFileTool,
    SearchForPatternTool (context lines, include/exclude globs,
    `restrict_search_to_code_files`), ReplaceInFilesTool (dry_run + occurrence_ids +
    expected_count).
  - `src/serena/tools/workflow_tools.py` — OnboardingTool, InitialInstructionsTool;
    `src/serena/tools/memory_tools.py` — Write/Read/List/Delete/Rename/EditMemoryTool;
    `src/serena/tools/config_tools.py` — ActivateProjectTool et al.
  - `src/solidlsp/language_servers/` — 78 LSP adapters (DependencyProvider pattern);
    `src/serena/symbol.py` — LanguageServerSymbol/name-path model;
    `src/serena/tools/tools_base.py` — `_limit_length`/`max_answer_chars`.
- omp-find files read: `README.md`, `src/tools.ts`, `src/search.ts`, `src/frecency.ts`,
  `src/extension.ts`, `src/commands.ts`.
