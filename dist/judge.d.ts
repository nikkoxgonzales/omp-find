/** One noul (yes/no probability) question keyed by entry. */
export interface NoulQuestion {
    type: "noul";
    instructions: string;
}
/** Judge request: JSON state plus noul questions keyed by entry. */
export interface JudgeRequest {
    state: Record<string, unknown>;
    questions: Record<string, NoulQuestion>;
}
/** Judge result: per-key noul probabilities plus token/cost usage. */
export interface JudgeResult {
    answers: Record<string, {
        noul?: number;
    }>;
    usage: {
        input: number;
        output: number;
        cost: {
            total: number;
        };
    };
}
/** Something that can answer noul questions about a state. */
export interface Judge {
    label: string;
    judge(req: JudgeRequest, opts?: {
        signal?: AbortSignal;
    }): Promise<JudgeResult>;
}
/** Published price: $42 per billion input tokens; output tokens are free. */
export declare const USD_PER_INPUT_TOKEN: number;
interface Provider {
    url: string;
    auth?: string;
}
/**
 * Key lookup: process env first (non-empty wins), then `~/.env`
 * (KEY=VALUE lines, `export ` prefix with any whitespace and matched-pair quotes tolerated) — never
 * overriding existing env. Mirrors jegrep's env::lookup.
 */
export declare function lookupKey(name: string): string | undefined;
export interface SystemOneClientOptions {
    providers: Provider[];
    model?: string;
    label?: string;
}
/**
 * System One HTTP client over fetch(): failover between hosted providers
 * on 401/402/403/408/429/5xx/transport/decode, per-provider retry of
 * transient failures with backoff. Cost is input_tokens * $42/1e9 for
 * hosted endpoints, 0 for the unauthenticated local endpoint.
 */
export declare class SystemOneClient implements Judge {
    readonly label: string;
    private readonly providers;
    private readonly model;
    private active;
    constructor(opts: SystemOneClientOptions);
    /** Unauthenticated local endpoint: explicit URL or the 127.0.0.1 default. No failover. */
    static local(url?: string, model?: string): SystemOneClient;
    /** Hosted endpoints from env/~/.env keys with failover. Undefined when no keys resolve. */
    static hosted(model?: string): SystemOneClient | undefined;
    judge(req: JudgeRequest, opts?: {
        signal?: AbortSignal;
    }): Promise<JudgeResult>;
    private send;
}
interface HostJudgeModule {
    resolveJudge?: (args: Record<string, unknown>) => unknown;
    journalJudgmentUsage?: (sessionManager: unknown, tool: string) => unknown;
}
/**
 * Resolve the judge for one ffjfind call, best-effort. Order:
 * (a) OMP_FIND_JUDGE_URL/JEGREP_ENDPOINT_URL → unauthenticated local client
 * (explicit user intent wins); (b) the host judgment module via a literal
 * dynamic import (host-rewritten at load; try/catch for hosts without it) +
 * pi.pi.settings + ctx; (c) env/~/.env keys → hosted client with failover.
 * Returns undefined when nothing resolves. Every host read is optional-chained
 * so unknown hosts degrade cleanly to the next step.
 *
 * NOTE(ts-no-dynamic-import exception): the specifier MUST stay a literal
 * `await import("...")` — the host Babel-rewrites literal host specifiers at
 * load; a variable specifier is NOT rewritten and fails resolution.
 */
export declare function resolveJudge(pi: unknown, ctx: unknown): Promise<Judge | undefined>;
/**
 * Settle a host module's resolveJudge result — sync or async — into our Judge.
 * Hosts may resolve the judge asynchronously; awaiting here keeps async hosts
 * working (an unawaited Promise would fall through adaptHostJudge as shapeless
 * and risk an unhandled rejection).
 */
export declare function adaptHostModule(mod: Partial<HostJudgeModule> | undefined, args: Record<string, unknown>): Promise<Judge | undefined>;
export {};
