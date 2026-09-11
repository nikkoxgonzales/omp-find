import type * as SearchNS from "./search.js";
import type * as FrecencyNS from "./frecency.js";
export type FindMode = "additive" | "override";
export interface FindToolsDeps {
    search?: typeof SearchNS;
    frecency?: typeof FrecencyNS;
}
export interface RegisterFindToolsOptions {
    mode?: FindMode;
    cwd?: string;
    tools?: FindToolsTier;
}
/** Flag > OMP_FIND_MODE env > omp-find.json > override. */
export declare function resolveFindMode(explicit?: FindMode, cwd?: string): FindMode;
/** Pick 10 — honest session stats: in-memory counters only (no persistence; */
/** the frecency file stays the only disk state). Each tool execute records one */
/** call plus wall-clock ms; scan-backed tools also record the serving backend */
/** (rg vs walker) and timeout rejections. Rendered by /find-health, reset by */
/** /find-rescan. */
export interface FindSessionStats {
    calls: Record<string, number>;
    totalCalls: number;
    rg: number;
    walker: number;
    timeouts: number;
    totalMs: number;
}
/** Copy of the live counters (callers must not mutate module state). */
export declare function getSessionStats(): FindSessionStats;
/** /find-rescan drops these alongside the frecency store (nothing persists). */
export declare function resetSessionStats(): void;
/** One-line session block for /find-health; zero-state stays a plain count. */
export declare function sessionStatsText(): string;
/** Pick 11 — tiered tool surface: OMP_FIND_TOOLS=core|full (default core = */
/** the current surface as it stands; full adds nothing today and is reserved */
/** for future tools so they don't bloat the default). Unknown values fall */
/** back to core. */
export type FindToolsTier = "core" | "full";
export declare function resolveFindToolsTier(explicit?: string): FindToolsTier;
/** Standard xxHash32 over raw bytes. Stripe rounds use P2/rotl13/P1; the
 * leftover 4-byte tail lane uses P3/rotl17/P4. NO lane-merge round after
 * combining v1..v4 (that merge belongs to XXH64): h is rotl(v1,1)+
 * rotl(v2,7)+rotl(v3,12)+rotl(v4,18), then len, tail, avalanche. Every
 * multiply is Math.imul — plain `*` overflows float64 past 2^53 and
 * silently mismatches. */
export declare function xxh32Bytes(bytes: Uint8Array, seed?: number): number;
/** 4-hex hashline content tag for whole-file text (path contributes zero
 * bytes). Pipeline mirrors hashline_file_hash (pi-natives edit.rs) over
 * store::file_hash (pi-edit store.rs): strip exactly one leading U+FEFF BOM,
 * normalize CRLF and lone CR to LF, per line rstrip ' '/'\t'/'\r' while
 * preserving LF structure (split_inclusive('\n') semantics), then xxh32
 * low 16 bits as 4 uppercase hex chars. */
export declare function hashlineFileHash(text: string): string;
/** `[displayPath#TAG]` section header for a file's whole text. */
export declare function hashlineHeader(displayPath: string, text: string): string;
export declare function registerFindTools(pi: any, deps: FindToolsDeps, opts?: RegisterFindToolsOptions): void;
