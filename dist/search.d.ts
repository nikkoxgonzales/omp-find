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
}
export interface GrepMatch {
    path: string;
    line: number;
    col: number;
    text: string;
    before?: string[];
    after?: string[];
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
/** Context window cap: contextBefore/contextAfter clamp to 0..5, default 0. */
export declare function clampContext(n: number | undefined): number;
/** Slice ±N surrounding lines onto each match (rg --vimgrep drops -B/-C, so both
backends share this file-slicing pass; each file is read once). Never throws. */
export declare function attachContext(cwdDir: string | undefined, matches: GrepMatch[], before: number, after: number): Promise<void>;
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
}
/** Approximate "who calls X": literal-aware text heuristics (call parens, import
lines, member access), merged/deduped by path:line. Explicitly NOT LSP-accurate:
same-named locals and comments can match; definition lines are filtered out.
Callers confirm hits with read. */
export declare function callersOf(symbol: string, opts?: CallersOptions): Promise<GrepResult>;
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
