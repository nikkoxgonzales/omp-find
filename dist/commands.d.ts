/**
 * `/find-health` (index/frecency status) and `/find-rescan` (drop caches).
 *
 * Both handlers run through the `deps` bag with `any` types so this file
 * compiles before the core worker (`search.ts`, `frecency.ts`) lands.
 * Every core call is optional-chained with a plain-text fallback, and
 * `ctx.ui.notify` itself is best-effort.
 */
export interface FindCommandDeps {
    search?: any;
    frecency?: any;
    [key: string]: any;
}
export declare function registerFindCommands(pi: any, deps?: FindCommandDeps): void;
