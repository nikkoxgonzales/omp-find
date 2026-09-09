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
}
/** Flag > OMP_FIND_MODE env > omp-find.json > override. */
export declare function resolveFindMode(explicit?: FindMode, cwd?: string): FindMode;
export declare function registerFindTools(pi: any, deps: FindToolsDeps, opts?: RegisterFindToolsOptions): void;
