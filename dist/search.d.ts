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
    scan?: string;
    followSymlinks?: boolean;
    timeoutMs?: number;
}
export interface GrepMatch {
    path: string;
    line: number;
    col: number;
    text: string;
}
export interface GrepResult {
    matches: GrepMatch[];
    total: number;
}
/** Split a raw query into dir prefix, globs, exclusions, and fuzzy text. */
export declare function parseFindQuery(q: string): ParsedFindQuery;
/** Minimal glob → RegExp (`*`, `**`, `?`, `{a,b}`, `[...]`); reused for tool-layer path filters. */
export declare function globToRegExp(glob: string): RegExp;
/** Ranked file paths (workspace-relative, native separators), paged by limit/offset. */
export declare function findPaths(query: string, opts?: FindOptions): Promise<string[]>;
export declare function grepContents(pattern: string, opts?: GrepOptions): Promise<GrepResult>;
/** Best-effort warm scan (no watcher/index — primes the OS cache). Never throws. */
export declare function warmScan(): Promise<void>;
/** One-line status for `/find-health` (string form, read synchronously). */
export declare function status(): string;
/** Drop caches (nothing persistent — resolves for the `/find-rescan` contract). */
export declare function clearCache(): Promise<void>;
