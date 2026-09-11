import type { OutlineSymbol } from "./outline.js";
export declare const PAGE_DEFAULT = 30, PAGE_MAX = 50;
export interface ParsedFindQuery {
    fuzzy: string;
    dirPrefix?: string;
    extGlobs: string[];
    excludes: string[];
    gitModifiedOnly: boolean;
}
export interface FindOptions {
    cwd?: string;
    limit?: number;
    offset?: number;
    scan?: string;
    followSymlinks?: boolean;
    scope?: string;
}
export interface GrepOptions {
    cwd?: string;
    limit?: number;
    offset?: number;
    literal?: boolean;
    ignoreCase?: boolean;
    wholeWord?: boolean;
    smartCase?: boolean;
    scan?: string;
    followSymlinks?: boolean;
    timeoutMs?: number;
    contextBefore?: number;
    contextAfter?: number;
    expand?: "none" | "function";
    scope?: string;
}
export interface GrepMatch {
    path: string;
    line: number;
    col: number;
    text: string;
    before?: string[];
    after?: string[];
    enclosing?: {
        kind: string;
        name: string;
        line: number;
    };
    depth?: number;
    via?: string;
}
export interface GrepResult {
    matches: GrepMatch[];
    total: number;
    backend: ScanBackend;
}
/** Which listing/grep backend served a call: rg when on PATH, otherwise the builtin walker. */
export type ScanBackend = "rg" | "walker";
/** Ranked paths plus scan metadata (files listed + serving backend) for zero-state counts. */
export interface FindScan {
    paths: string[];
    scanned: number;
    backend: ScanBackend;
}
/** Split a raw query into dir prefix, globs, exclusions, and fuzzy text. */
export declare function parseFindQuery(q: string): ParsedFindQuery;
/** Minimal glob → RegExp (`*`, `**`, `?`, `{a,b}`, `[...]`); reused for tool-layer path filters. */
export declare function globToRegExp(glob: string): RegExp;
export declare function pageOf<T>(arr: T[], limit: number | undefined, offset: number | undefined): T[];
/** Subsequence fuzzy score (lower is better; Infinity = no match). Exact and stem basename matches win. */
export declare function fuzzyScore(pattern: string, target: string): number;
/** Full ranked listing plus scan metadata (files listed + serving backend) for zero-state counts. */
export declare function findScanned(query: string, opts?: FindOptions): Promise<FindScan>;
/** Ranked file paths (workspace-relative, native separators), paged by limit/offset. */
export declare function findPaths(query: string, opts?: FindOptions): Promise<string[]>;
/** Regex walk+scan shared by the worker thread (grep-worker.ts imports this).
 * Exported for the worker and for tests comparing worker output to the inline
 * scan; not part of the tool contract. */
export declare function walkerRegexGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, deadline?: number, timeoutMs?: number, wholeWord?: boolean, scope?: string): Promise<GrepMatch[]>;
/** Context window cap: contextBefore/contextAfter clamp to 0..5, default 0. */
export declare function clampContext(n: number | undefined): number;
/** Slice ±N surrounding lines onto each match (rg --vimgrep drops -B/-C, so both
backends share this file-slicing pass; each file is read once). Never throws. */
export declare function attachContext(cwdDir: string | undefined, matches: GrepMatch[], before: number, after: number): Promise<void>;
/** Enclosing-symbol attribution (goldmine pick 8): one `outlineFile` depth-0
pass per file-with-hits, each match attributed to the nearest symbol at/above
its line. Outline misses (unreadable/binary/symbol-free files) leave the match
untagged — never throws. Only runs on request (`expand: "function"`). */
export declare function attachEnclosing(cwdDir: string | undefined, matches: GrepMatch[]): Promise<void>;
export declare function grepContents(pattern: string, opts?: GrepOptions): Promise<GrepResult>;
export interface CallersOptions {
    cwd?: string;
    limit?: number;
    offset?: number;
    ignoreCase?: boolean;
    scan?: string;
    followSymlinks?: boolean;
    timeoutMs?: number;
    contextBefore?: number;
    contextAfter?: number;
    depth?: 1 | 2 | 3;
}
/** Approximate "who calls X": literal-aware text heuristics (call parens, import
lines, member access), merged/deduped by path:line. Explicitly NOT LSP-accurate:
same-named locals and comments can match; definition lines are filtered out.
Callers confirm hits with read. `depth` 2|3 BFS-transitively follows each ring's
enclosing symbols (cycle-guarded by the visited path:line set, rings labeled
`depth:N` on every row, hard-capped by GREP_CAP); downstream callees are out of
scope. Default 1 keeps the single-ring shape. */
export declare function callersOf(symbol: string, opts?: CallersOptions): Promise<GrepResult>;
/** ffmap core: ranked per-file depth-0 outlines for a fitted repo overview.
 * Fresh scan every call (no index): one walker/rg listing, one git status,
 * one text read per file for import-centrality plus one outline pass.
 * Ranking inputs (frecency re-rank happens tools-side) are returned raw:
 * `modified` (git porcelain membership) and `inDegree` (importer count over
 * approximate import-specifier extractors — centrality only, never shown). */
export interface MapFile {
    path: string;
    symbols: OutlineSymbol[];
    modified: boolean;
    inDegree: number;
}
export interface MapResult {
    files: MapFile[];
    total: number;
    scanned: number;
    backend: ScanBackend;
}
export interface MapOptions {
    cwd?: string;
    scan?: string;
    followSymlinks?: boolean;
}
export declare function rankMap(opts?: MapOptions): Promise<MapResult>;
/** ffcapsule core: fused symbol dossier from existing cores only (no new scan
 * machinery). Definition = first name-matching non-import depth-0 outline row
 * across the most-mentioned candidate files (capped at 30); doc = up to 5
 * contiguous comment lines above it; callers/imports = bounded live queries. */
export interface CapsuleResult {
    symbol: string;
    found: boolean;
    defFile?: string;
    defLine?: number;
    defKind?: string;
    doc: string[];
    callers: GrepMatch[];
    imports: GrepMatch[];
    filesInvolved: number;
    backend: ScanBackend;
}
export interface CapsuleOptions {
    cwd?: string;
    ignoreCase?: boolean;
    pathFilter?: string;
    limit?: number;
    scan?: string;
    followSymlinks?: boolean;
    timeoutMs?: number;
}
export declare function capsuleOf(symbol: string, opts?: CapsuleOptions): Promise<CapsuleResult>;
/** Best-effort warm scan (no watcher/index — primes the OS cache). Never throws. */
export declare function warmScan(): Promise<void>;
/** Fresh rg presence + version and serving backend for `/find-health` (string form, read synchronously). */
export declare function status(): string;
/** Drop caches (nothing persistent — resolves for the `/find-rescan` contract). */
export declare function clearCache(): Promise<void>;
/** ffoutline core lives in outline.ts; re-exported here so the tool layer's
`search` dep carries it without extra host wiring. */
export { outlineFile } from "./outline.js";
export type { OutlineSymbol, OutlineResult, OutlineOptions } from "./outline.js";
/** ffstructural core lives in structural.ts; re-exported here so the tool layer's
`search` dep carries it without extra host wiring (same shape as outlineFile). */
export { compileStructural, structuralGrep, previewRewrite, normalizeLanguage } from "./structural.js";
export type { CompiledStructural, StructuralMode, StructuralOptions } from "./structural.js";
