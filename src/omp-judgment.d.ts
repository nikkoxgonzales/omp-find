/**
 * Local stub for the host-rewritten judgment module.
 *
 * `src/judge.ts` performs a LITERAL `await import("@oh-my-pi/pi-coding-agent/judgment")`
 * — the omp host rewrites literal host specifiers at load, so the specifier must
 * stay a string literal. This stub is wired through tsconfig `paths` so `tsc`
 * types the import here (loose shapes, everything unknown-tolerant) instead of
 * following the real monorepo sources under `node_modules`, whose layout breaks
 * `--moduleResolution nodenext`. Runtime resolution is untouched.
 */
export declare const resolveJudge: ((args: Record<string, unknown>) => unknown) | undefined;
export declare const journalJudgmentUsage: ((sessionManager: unknown, tool: string) => unknown) | undefined;
