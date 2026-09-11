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
export declare function registerFindTools(pi: any, deps: FindToolsDeps, opts?: RegisterFindToolsOptions): void;
