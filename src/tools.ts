/** omp-find tool surface: `fffind` + `ffgrep` always; override mode additionally claims `find` + `grep`. */
import fs from "node:fs";
import path from "node:path";
import type * as SearchNS from "./search.js";
import type * as FrecencyNS from "./frecency.js";

export type FindMode = "additive" | "override";
export interface FindToolsDeps { search?: typeof SearchNS; frecency?: typeof FrecencyNS }
export interface RegisterFindToolsOptions { mode?: FindMode; cwd?: string }

const FIND_PAGE = 30;
const GREP_PAGE = 30;
const PAGE_MAX = 50;

type CursorState =
  | { kind: "find"; query: string; limit: number; nextOffset: number; cwd?: string; maxChars?: number }
  | { kind: "grep"; pattern: string; literal: boolean; ignoreCase: boolean; wholeWord: boolean; smartCase: boolean; pathFilter?: string; limit: number; nextOffset: number; cwd?: string; contextBefore: number; contextAfter: number; maxChars?: number }
  | { kind: "outline"; file: string; depth: number; limit: number; nextOffset: number; cwd?: string; maxChars?: number }
  | { kind: "callers"; symbol: string; ignoreCase: boolean; pathFilter?: string; limit: number; nextOffset: number; cwd?: string; maxChars?: number };

const cursors = new Map<string, CursorState>();
let cursorSeq = 0;

const CURSOR_PREFIX: Record<CursorState["kind"], string> = { find: "find_c", grep: "grep_c", outline: "outline_c", callers: "callers_c" };

function storeCursor(s: CursorState): string {
  const id = `${CURSOR_PREFIX[s.kind]}${++cursorSeq}`;
  cursors.set(id, s);
  if (cursors.size > 200) {
    const first = cursors.keys().next().value;
    if (first !== undefined) cursors.delete(first);
  }
  return id;
}

/** Flag > OMP_FIND_MODE env > omp-find.json > override. */
export function resolveFindMode(explicit?: FindMode, cwd: string = process.cwd()): FindMode {
  if (explicit === "additive" || explicit === "override") return explicit;
  const env = (process.env.OMP_FIND_MODE ?? "").toLowerCase();
  if (env === "additive" || env === "override") return env;
  try {
    const raw = fs.readFileSync(path.join(cwd, "omp-find.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const mode = typeof parsed === "object" && parsed !== null && "mode" in parsed ? parsed.mode : undefined;
    if (mode === "additive" || mode === "override") return mode;
  } catch { /* missing/unparseable → default */ }
  return "override";
}

function text(t: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: t }] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), PAGE_MAX) : undefined;
}

async function safeScore(frecency: FindToolsDeps["frecency"], p: string): Promise<number> {
  try { return (await frecency?.score(p)) ?? 0; }
  catch { return 0; }
}

function toDisplay(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Tools-layer path filter for ffgrep (dir/ prefix, glob, or bare name). */
function applyPathFilter(paths: string[], filter: string, glob: ((g: string) => RegExp) | undefined): string[] {
  const f = filter.startsWith("./") ? filter.slice(2) : filter;
  if (f.endsWith("/")) {
    const dir = f.slice(0, -1);
    return paths.filter((p) => { const d = toDisplay(p); return d === dir || d.startsWith(`${dir}/`); });
  }
  if (/[*?[{]/.test(f) && glob) {
    const re = glob(f);
    return paths.filter((p) => { const d = toDisplay(p); return re.test(d) || re.test(d.slice(d.lastIndexOf("/") + 1)); });
  }
  return paths.filter((p) => {
    const d = toDisplay(p);
    return d === f || d.startsWith(`${f}/`) || d.slice(d.lastIndexOf("/") + 1) === f;
  });
}
function ctxParam(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(5, Math.floor(v)));
}
function charsParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(Math.floor(v), 1000000);
}
/** Top-counts summary fragment: "b: 3, a: 1", at most 10 entries. */
function countSummary(entries: Array<readonly [string, number]>): string {
  return [...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(", ");
}
function overBudget(rendered: string, maxChars: number | undefined): boolean {
  return maxChars !== undefined && rendered.length > maxChars;
}
/** Optional scan root: must be an absolute directory when given. Resolution plus the */
/** filesystem-root/home runaway guard live in the core (guardCwd); relative input is */
/** rejected here so a bare "src" can never silently resolve against process.cwd(). */
function cwdParam(params: Record<string, unknown>): string | undefined {
  const raw = strParam(params, "cwd");
  if (raw === undefined) return undefined;
  if (!path.isAbsolute(raw)) throw new Error(`cwd must be an absolute directory path (got "${raw}")`);
  return raw;
}
function renderGrepRows(m: { path: string; line: number; col: number; text: string; before?: string[]; after?: string[] }): string[] {
  const disp = toDisplay(m.path);
  const rows = [`${disp}:${m.line}:${m.col}: ${m.text}`];
  const before = m.before ?? [];
  for (let i = 0; i < before.length; i++) rows.push(`  ${disp}:${m.line - before.length + i}: ${before[i]}`);
  const after = m.after ?? [];
  for (let i = 0; i < after.length; i++) rows.push(`  ${disp}:${m.line + i + 1}: ${after[i]}`);
  return rows;
}
/** Core findScanned shape (newer core); older cores expose findPaths only. */
interface FindScanLike { paths: unknown[]; scanned?: unknown; backend?: unknown }
type FindScannedFn = (query: string, opts: { cwd?: string; limit: number; offset: number }) => Promise<unknown>;
function asFindScanned(v: unknown): FindScannedFn | undefined {
  // Named-const cast with reason: typeof-narrowed functions are not directly callable.
  const fn: FindScannedFn | undefined = typeof v === "function" ? (v as FindScannedFn) : undefined;
  return fn;
}
function asFindScanLike(v: unknown): FindScanLike | undefined {
  if (v === null || typeof v !== "object" || !("paths" in v)) return undefined;
  const paths: unknown = v.paths;
  if (!Array.isArray(paths)) return undefined;
  const like: FindScanLike = { paths };
  if ("scanned" in v) like.scanned = v.scanned;
  if ("backend" in v) like.backend = v.backend;
  return like;
}
type SearchCore = NonNullable<FindToolsDeps["search"]>;
/** One find round: ranked paths plus scan metadata when the core exposes findScanned. */
async function runFind(search: SearchCore, query: string, opts: { cwd?: string; limit: number; offset: number }): Promise<{ paths: string[]; scanned?: number; backend?: string }> {
  const detailed = "findScanned" in search ? asFindScanned(search.findScanned) : undefined;
  if (detailed !== undefined) {
    const like = asFindScanLike(await detailed(query, opts));
    if (like !== undefined && like.paths.every((p): p is string => typeof p === "string")) {
      return {
        paths: like.paths,
        scanned: typeof like.scanned === "number" ? like.scanned : undefined,
        backend: like.backend === "rg" || like.backend === "walker" ? like.backend : undefined,
      };
    }
  }
  return { paths: await search.findPaths(query, opts) };
}

/** Zero-state with scan facts when known, mirroring fff's `0 results (N indexed)`. */
function zeroFind(scanned: number | undefined, backend: string | undefined, relaxed?: { from: string; to: string }): string {
  if (relaxed !== undefined) {
    const facts = scanned !== undefined && backend !== undefined ? ` (${scanned} files scanned, ${backend}; relaxed to "${relaxed.to}")` : ` (relaxed to "${relaxed.to}")`;
    return `0 matches for "${relaxed.from}"${facts}`;
  }
  return scanned !== undefined && backend !== undefined ? `0 matches (${scanned} files scanned, ${backend})` : "0 matches";
}


export function registerFindTools(pi: any, deps: FindToolsDeps, opts: RegisterFindToolsOptions = {}): void {
  const search = deps.search;
  const frecency = deps.frecency;
  if (!search?.findPaths || !search?.grepContents) return;
  const mode = resolveFindMode(opts.mode, opts.cwd ?? process.cwd());
  const isOverride = mode === "override";
  // Canonical host form is the single object {name, label, ...}: registerTool(tool)
  // (verified against the omp host ExtensionAPI types — no (name, def) arity exists).
  const register = (name: string, label: string, def: Record<string, unknown>): void => {
    pi.registerTool({ name, label, ...def });
  };

  const findDef = (toolName: string): Record<string, unknown> => ({
    description: "Use instead of shell grep/rg/find/ls because results are fuzzy-ranked, frecency-ordered, paged, and counted. Fuzzy 1-2 terms plus dir/glob/exclusion/git:modified filters with auto-retry on long queries and scan counts; e.g. pattern 'srv usr' with path 'src/' lists ranked matches under src/.",
    approval: "read",
    promptGuidelines: [
      "fffind: Never use shell find/ls/dir to locate files — use fffind with 1-2 short terms.",
      "fffind: Keep fffind queries SHORT: 1-2 terms (e.g. 'user_service'); add terms only to narrow, never as OR.",
      "fffind: Prefer bare identifiers over sentences; when the top hit is an exact filename match, read it directly.",
    ],
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Fuzzy query: 1-2 short terms (e.g. 'srv usr'); supports dir/ prefix, *.ext globs, !exclusions, git:modified" },
        path: { type: "string", description: "Within-tree filter prepended to the query (e.g. 'src/'); same as embedding 'src/' in pattern" },
        cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd; refused for filesystem-root and home" },
        limit: { type: "number", description: "Max results per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
        maxChars: { type: "number", description: "Max output chars; when exceeded returns per-dir counts instead of rows" },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        let query: string, limit: number, offset: number, cwd: string | undefined, maxChars: number | undefined;
        let all: string[];
        let relaxed: { from: string; to: string } | undefined;
        let scanned: number | undefined, backend: string | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "find") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          query = st.query; limit = st.limit; offset = st.nextOffset; cwd = st.cwd; maxChars = st.maxChars;
          all = await search.findPaths(query, { cwd, limit: PAGE_MAX, offset: 0 });
        } else {
          const pattern = strParam(params, "pattern") ?? "";
          const dirParam = strParam(params, "path");
          query = [dirParam, pattern].filter(Boolean).join(" ");
          if (!query) return text(`${toolName} failed: provide a pattern or path`);
          limit = numParam(params, "limit") ?? FIND_PAGE;
          offset = 0;
          cwd = cwdParam(params);
          maxChars = charsParam(params, "maxChars");
          let fetched = await runFind(search, query, { cwd, limit: PAGE_MAX, offset: 0 });
          scanned = fetched.scanned; backend = fetched.backend;
          const words = pattern.trim().split(/\s+/).filter(Boolean);
          if (fetched.paths.length === 0 && words.length >= 3) {
            // One auto-retry with the first 2 terms (fff find_files behavior); the
            // directory constraint is preserved, only the fuzzy tail is shortened.
            const shorter = [dirParam, words.slice(0, 2).join(" ")].filter(Boolean).join(" ");
            fetched = await runFind(search, shorter, { cwd, limit: PAGE_MAX, offset: 0 });
            scanned = fetched.scanned ?? scanned; backend = fetched.backend ?? backend;
            relaxed = { from: query, to: shorter };
            query = shorter;
          }
          all = fetched.paths;
        }
        const ranked = await Promise.all(all.map(async (p) => ({ p, s: await safeScore(frecency, p) })));
        ranked.sort((a, b) => b.s - a.s); // stable: frecency first, fuzzy order otherwise
        const total = ranked.length;
        const page = ranked.slice(offset, offset + limit);
        const lines = page.map((r) => toDisplay(r.p));
        if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
          const byDir = new Map<string, number>();
          for (const r of ranked) {
            const d = toDisplay(r.p), slash = d.lastIndexOf("/");
            const dir = slash < 0 ? "." : d.slice(0, slash);
            byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
          }
          return text(`Matched ${total} files (output exceeds ${maxChars} chars). Per-dir counts: ${countSummary([...byDir])}. Refine path/pattern or raise maxChars.`);
        }
        if (offset + page.length < total) {
          const next = storeCursor({ kind: "find", query, limit, nextOffset: offset + page.length, cwd, maxChars });
          lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        if (lines.length === 0) return text(zeroFind(scanned, backend, relaxed));
        if (relaxed !== undefined) lines.unshift(`note: no matches for "${relaxed.from}"; showing results for "${relaxed.to}"`, "");
        return text(lines.join("\n"));
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });
  const grepDef = (toolName: string): Record<string, unknown> => ({
    description: "Use instead of shell grep/rg/find/ls because results are literal-safe, frecency-ranked, paged, and counted. Literal-safe any string (no escaping ever): e.g. pattern 'Chat ID (CHT-XXXX from list_chats or search_chats)' with path 'server.py' searches that one file literally (total returned, no counting needed). Bare-file/dir/glob path filter, zero-state scan facts, context lines, cwd scan root (no cd), maxChars budgets. Regex when literal=false.",
    approval: "read",
    promptGuidelines: [
      "ffgrep: Never use shell grep/rg/select-string for code search — use ffgrep with literal:true and a path filter.",
      "ffgrep: Prefer bare identifiers (e.g. 'frecency') over sentences; stay literal unless regex is needed.",
      "ffgrep: Scope with the path filter (dir/ prefix, *.ext glob, or bare filename like 'server.py') before broadening the search.",
    ],
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search text or regex (required). Literal by default: quotes/parens need no escaping" },
        path: { type: "string", description: "File filter: dir/ prefix ('src/'), glob ('*.ts'), or bare filename ('server.py'); applies over the full result set" },
        literal: { type: "boolean", description: "Literal match (default true); set false to use regex" },
        ignoreCase: { type: "boolean", description: "Case-insensitive match (default false)" },
        wholeWord: { type: "boolean", description: "Whole-word match (default false) — no more hand-rolled \\b regexes; ASCII \\b limits apply, so patterns starting/ending with a non-word char may not match" },
        smartCase: { type: "boolean", description: "Smart case (default false) — no more case juggling in shell pipes: lowercase patterns match case-insensitively, any uppercase letter restores sensitivity; overrides ignoreCase when enabled" },
        cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd; refused for filesystem-root and home" },
        limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
        contextBefore: { type: "number", description: "Context lines before each match (default 0, max 5)" },
        contextAfter: { type: "number", description: "Context lines after each match (default 0, max 5)" },
        maxChars: { type: "number", description: "Max output chars; when exceeded returns per-file counts instead of rows" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        let pattern: string, literal: boolean, ignoreCase: boolean, wholeWord: boolean, smartCase: boolean, pathFilter: string | undefined;
        let limit: number, offset: number, cwd: string | undefined;
        let contextBefore: number, contextAfter: number, maxChars: number | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "grep") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          pattern = st.pattern; literal = st.literal; ignoreCase = st.ignoreCase;
          wholeWord = st.wholeWord; smartCase = st.smartCase;
          pathFilter = st.pathFilter; limit = st.limit; offset = st.nextOffset; cwd = st.cwd;
          contextBefore = st.contextBefore; contextAfter = st.contextAfter; maxChars = st.maxChars;
        } else {
          const p = strParam(params, "pattern");
          if (!p) return text(`${toolName} failed: provide a pattern`);
          pattern = p;
          literal = params["literal"] === undefined ? true : params["literal"] === true;
          ignoreCase = params["ignoreCase"] === true;
          wholeWord = params["wholeWord"] === true;
          smartCase = params["smartCase"] === true;
          pathFilter = strParam(params, "path");
          limit = numParam(params, "limit") ?? GREP_PAGE;
          offset = 0;
          cwd = cwdParam(params);
          contextBefore = ctxParam(params, "contextBefore");
          contextAfter = ctxParam(params, "contextAfter");
          maxChars = charsParam(params, "maxChars");
        }
        // Path filters apply tools-side over the full result set: a bounded fetch
        // first would drop hits outside the page (false empty zero-states). Word
        // boundaries and totals likewise hold over the full set before slicing —
        // cursor paging re-fetches with the same flags, so limits never skew them.
        // Context keys only travel when set: absence keeps the core call identical.
        const pageOpts: { cwd?: string; literal: boolean; ignoreCase: boolean; wholeWord: boolean; smartCase: boolean; limit: number; offset: number; contextBefore?: number; contextAfter?: number } =
          { cwd, literal, ignoreCase, wholeWord, smartCase, limit, offset };
        if (contextBefore > 0) pageOpts.contextBefore = contextBefore;
        if (contextAfter > 0) pageOpts.contextAfter = contextAfter;
        const res = await search.grepContents(pattern, pathFilter ? { cwd, literal, ignoreCase, wholeWord, smartCase } : pageOpts);
        const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
        const matches = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
        const total = pool === null ? res.total : matches.length;
        const page = pool === null ? matches : matches.slice(offset, offset + limit);
        if (pool !== null && (contextBefore > 0 || contextAfter > 0) && typeof search.attachContext === "function") {
          await search.attachContext(cwd, page, contextBefore, contextAfter);
        }
        const lines = page.flatMap((m) => renderGrepRows(m));
        if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
          const byFile = new Map<string, number>();
          for (const m of matches) byFile.set(toDisplay(m.path), (byFile.get(toDisplay(m.path)) ?? 0) + 1);
          return text(`Matched ${total} hits in ${byFile.size} files (output exceeds ${maxChars} chars). Per-file counts: ${countSummary([...byFile])}. Refine path/pattern or raise maxChars.`);
        }
        if (lines.length === 0) {
          const backend = typeof res.backend === "string" ? res.backend : undefined;
          return text(backend !== undefined ? `0 matches for "${pattern}" (${backend})` : `0 matches for "${pattern}"`);
        }
        lines.push(`(${total} match${total === 1 ? "" : "es"} total)`);
        if (offset + page.length < total) {
          const next = storeCursor({
            kind: "grep", pattern, literal, ignoreCase, wholeWord, smartCase, pathFilter, limit, nextOffset: offset + page.length, cwd, contextBefore, contextAfter, maxChars,
          });
          lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });
  const outlineDef = (toolName: string): Record<string, unknown> => ({
    description: "Approximate per-file symbol overview (omp-find). Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline->grep->read. Regex-based, not LSP-accurate; every hit carries a line number — verify with read/ffgrep. Does not record frecency.",
    approval: "read",
    promptGuidelines: [
      "ffoutline: Outline a new file before reading it: a 10-line shape answers 'what lives here' at ~5% of the tokens — never read whole files or run ctags shells to learn shape.",
      "ffoutline: Compose outline->grep->read: outline for shape, ffgrep on one symbol, read the range.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Single file to outline, e.g. 'src/search.ts' (resolved under cwd)" },
        cwd: { type: "string", description: "Scan root: absolute directory holding the file (default: session cwd)" },
        depth: { type: "number", description: "0 = top-level symbols (default), 1 = also one nesting level" },
        limit: { type: "number", description: "Max symbols per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
        maxChars: { type: "number", description: "Max output chars; when exceeded returns kind counts instead of rows" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof search.outlineFile !== "function") return text(`${toolName} failed: outline unavailable`);
        let file: string, depth: number, limit: number, offset: number, cwd: string | undefined, maxChars: number | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "outline") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          file = st.file; depth = st.depth; limit = st.limit; offset = st.nextOffset; cwd = st.cwd; maxChars = st.maxChars;
        } else {
          const f = strParam(params, "path");
          if (!f) return text(`${toolName} failed: provide a path`);
          file = f;
          const d = params["depth"];
          depth = d === 1 ? 1 : 0;
          limit = numParam(params, "limit") ?? FIND_PAGE;
          offset = 0;
          cwd = cwdParam(params);
          maxChars = charsParam(params, "maxChars");
        }
        const res = await search.outlineFile(file, { cwd, depth });
        const disp = toDisplay(file);
        const page = res.symbols.slice(offset, offset + limit);
        const lines = page.map((s) => `${disp}:${s.line}:${s.col}: ${s.kind} ${s.name}`);
        if (res.total > 0 && overBudget(lines.join("\n"), maxChars)) {
          const byKind = new Map<string, number>();
          for (const s of res.symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
          return text(`Matched ${res.total} symbols in ${disp} (output exceeds ${maxChars} chars). Kind counts: ${countSummary([...byKind])}. Refine path or raise maxChars.`);
        }
        if (offset + page.length < res.total) {
          const next = storeCursor({ kind: "outline", file, depth, limit, nextOffset: offset + page.length, cwd, maxChars });
          lines.push("", `... (${res.total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        return text(lines.length > 0 ? lines.join("\n") : `No symbols found in ${disp} (approximate scan)`);
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });
  const callersDef = (toolName: string): Record<string, unknown> => ({
    description: "Approximate 'who calls X' (omp-find). Use instead of shell grep chains for who-calls-X: definition vs import vs call-site queries collapse into one ranked call. Text heuristics over call parens, imports, and member access — not LSP-accurate; confirm with read.",
    approval: "read",
    promptGuidelines: [
      "ffcallers: Never chain shell greps for who-calls-X (definition vs import vs call site) — one ffcallers call ranks them all.",
      "ffcallers: Confirm shortlisted sites with read; output is approximate text heuristics, not LSP references.",
    ],
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name, e.g. 'parseFindQuery'" },
        path: { type: "string", description: "File constraint, e.g. 'src/', '*.ts'" },
        cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd); refused for filesystem-root and home" },
        ignoreCase: { type: "boolean", description: "Case-insensitive match" },
        limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
        maxChars: { type: "number", description: "Max output chars; when exceeded returns per-file counts instead of rows" },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof search.callersOf !== "function") return text(`${toolName} failed: callers unavailable`);
        let symbol: string, ignoreCase: boolean, pathFilter: string | undefined;
        let limit: number, offset: number, cwd: string | undefined, maxChars: number | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "callers") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          symbol = st.symbol; ignoreCase = st.ignoreCase; pathFilter = st.pathFilter;
          limit = st.limit; offset = st.nextOffset; cwd = st.cwd; maxChars = st.maxChars;
        } else {
          const s = strParam(params, "symbol");
          if (!s) return text(`${toolName} failed: provide a symbol`);
          symbol = s;
          ignoreCase = params["ignoreCase"] === true;
          pathFilter = strParam(params, "path");
          limit = numParam(params, "limit") ?? GREP_PAGE;
          offset = 0;
          cwd = cwdParam(params);
          maxChars = charsParam(params, "maxChars");
        }
        const res = await search.callersOf(symbol, { cwd, ignoreCase });
        const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
        const filtered = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
        const ranked = await Promise.all(filtered.map(async (m) => ({ m, s: await safeScore(frecency, m.path) })));
        ranked.sort((a, b) => b.s - a.s); // stable: frecency first, path order otherwise
        const total = ranked.length;
        const page = ranked.slice(offset, offset + limit);
        const lines = page.flatMap((r) => renderGrepRows(r.m));
        if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
          const byFile = new Map<string, number>();
          for (const r of ranked) byFile.set(toDisplay(r.m.path), (byFile.get(toDisplay(r.m.path)) ?? 0) + 1);
          return text(`Matched ${total} approximate references to ${symbol} in ${byFile.size} files (output exceeds ${maxChars} chars). Per-file counts: ${countSummary([...byFile])}. Refine path or raise maxChars.`);
        }
        if (offset + page.length < total) {
          const next = storeCursor({ kind: "callers", symbol, ignoreCase, pathFilter, limit, nextOffset: offset + page.length, cwd, maxChars });
          lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        return text(lines.length > 0 ? lines.join("\n") : `No approximate references to ${symbol} found`);
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });
  register("fffind", "Find files", findDef("fffind"));
  register("ffgrep", "Grep content", grepDef("ffgrep"));
  if (typeof search.outlineFile === "function") {
    register("ffoutline", "Outline file", outlineDef("ffoutline"));
    try { register("outline", "Outline file", outlineDef("outline")); } catch { /* alias where the host allows */ }
  }
  if (typeof search.callersOf === "function") {
    register("ffcallers", "Find callers", callersDef("ffcallers"));
  }
  if (isOverride) {
    register("find", "Find files", findDef("find"));
    register("grep", "Grep content", grepDef("grep"));
  }
}
