/**
 * Judge abstraction + System One HTTP client for ffjfind.
 *
 * System One wire protocol (ported from jegrep's jev.rs): POST
 * {state, model, questions{key:{type:"noul",instructions}}} → 200
 * {model, answers{key:{type:"noul",noul}}, usage{input_tokens,output_tokens}}.
 * Hosted endpoints need bearer auth with failover between them; a local
 * endpoint is unauthenticated and standalone. Transient failures
 * (429/529/5xx/transport/decode on first contact) retry with backoff that
 * honors retry-after, up to 6 retries, 120s per request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** Published price: $42 per billion input tokens; output tokens are free. */
export const USD_PER_INPUT_TOKEN = 42 / 1e9;
/** Same-provider retries per request (jegrep max_retries): up to 6 in-place
 * retries of transient (429/529/5xx/transport) failures. Decode and
 * HTTP-failover errors fail over immediately with no same-provider retry,
 * so the cross-provider worst case is ~14 attempts (7 tries per provider
 * x 2 providers via failover). */
const MAX_RETRIES = 6;
/** Per-request wall-clock budget in ms (jegrep timeout_global 120s). */
const REQUEST_TIMEOUT_MS = 120_000;
/** Backoff base in seconds: 0.4 * 2^(n-1) + jitter, honoring retry-after, capped at 20s. */
const BACKOFF_BASE_S = 0.4;
const BACKOFF_CAP_S = 20;
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const LOCAL_DEFAULT_URL = "http://127.0.0.1:8756/";
/** Failover-worthy: 401/402/403/408/429/5xx/transport/decode (jegrep can_failover). */
function canFailover(status) {
    if (status === undefined)
        return true; // transport/decode
    return status === 401 || status === 402 || status === 403 || status === 408 ||
        status === 429 || status === 529 || (status >= 500 && status < 600);
}
/** Retry-worthy within one provider: 429/529/5xx/transport only. */
function transient(status) {
    if (status === undefined)
        return true;
    return status === 429 || status === 529 || (status >= 500 && status < 600);
}
function backoffMs(attempt, retryAfterMs) {
    // attempt is 1-based (jegrep backoff() takes the post-increment attempt).
    const base = BACKOFF_BASE_S * 2 ** (attempt - 1);
    const jitter = Math.random() * 0.25;
    return Math.min(BACKOFF_CAP_S, Math.max((retryAfterMs ?? 0) / 1000, base) + jitter) * 1000;
}
function sleep(ms, signal) {
    const { promise, resolve, reject } = Promise.withResolvers();
    if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return promise;
    }
    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
}
/** Parse a Retry-After header (seconds, possibly fractional); undefined when absent/unparseable. */
function retryAfterMs(headers) {
    const raw = headers.get("retry-after");
    if (raw === null)
        return undefined;
    const trimmed = raw.trim();
    const secs = Number(trimmed);
    if (Number.isFinite(secs) && secs >= 0)
        return secs * 1000;
    const when = Date.parse(trimmed);
    return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}
function truncate(s, n) {
    const t = s.trim();
    return [...t].length <= n ? t : `${[...t].slice(0, n).join("")}…`;
}
/**
 * Key lookup: process env first (non-empty wins), then `~/.env`
 * (KEY=VALUE lines, `export ` prefix with any whitespace and matched-pair quotes tolerated) — never
 * overriding existing env. Mirrors jegrep's env::lookup.
 */
export function lookupKey(name) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv !== undefined && fromEnv !== "")
        return fromEnv;
    try {
        const text = fs.readFileSync(path.join(os.homedir(), ".env"), "utf8");
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "" || trimmed.startsWith("#"))
                continue;
            const body = trimmed.replace(/^export\s+/, "");
            const eq = body.indexOf("=");
            if (eq === -1)
                continue;
            if (body.slice(0, eq).trim() !== name)
                continue;
            let value = body.slice(eq + 1).trim();
            if (value.length >= 2) {
                const first = value[0];
                const last = value[value.length - 1];
                if ((first === '"' && last === '"') || (first === "'" && last === "'"))
                    value = value.slice(1, -1);
            }
            if (value !== "")
                return value;
        }
    }
    catch {
        // No home dir or no ~/.env — hosted auth simply has one fewer source.
    }
    return undefined;
}
/** Non-empty OMP_FIND_JUDGE_MODEL, else undefined (caller falls back to jev-latest). */
function envModel() {
    const v = process.env.OMP_FIND_JUDGE_MODEL?.trim();
    return v !== undefined && v !== "" ? v : undefined;
}
/** Resolve hosted providers: both keys load independently, OpenRouter first. Empty when no keys. */
function hostedProviders() {
    const out = [];
    const openrouter = lookupKey("OPENROUTER_API_KEY");
    if (openrouter !== undefined)
        out.push({ url: OPENROUTER_URL, auth: `Bearer ${openrouter}` });
    const typesafe = lookupKey("TYPESAFE_API_KEY");
    if (typesafe !== undefined)
        out.push({ url: TYPESAFE_URL, auth: `Bearer ${typesafe}` });
    return out;
}
/** Local URL override: OMP_FIND_JUDGE_URL first, then JEGREP_ENDPOINT_URL. */
function localUrl() {
    for (const name of ["OMP_FIND_JUDGE_URL", "JEGREP_ENDPOINT_URL"]) {
        const v = process.env[name]?.trim();
        if (v !== undefined && v !== "")
            return v;
    }
    return undefined;
}
/**
 * System One HTTP client over fetch(): failover between hosted providers
 * on 401/402/403/408/429/5xx/transport/decode, per-provider retry of
 * transient failures with backoff. Cost is input_tokens * $42/1e9 for
 * hosted endpoints, 0 for the unauthenticated local endpoint.
 */
export class SystemOneClient {
    label;
    providers;
    model;
    active = 0;
    constructor(opts) {
        this.providers = opts.providers;
        this.model = opts.model ?? envModel() ?? "jev-latest";
        const sole = this.providers.length === 1 ? this.providers[0] : undefined;
        this.label = opts.label ?? (sole !== undefined && sole.auth === undefined
            ? `systemone-local (${sole.url})`
            : `systemone (${this.model})`);
    }
    /** Unauthenticated local endpoint: explicit URL or the 127.0.0.1 default. No failover. */
    static local(url, model) {
        return new SystemOneClient({ providers: [{ url: url ?? LOCAL_DEFAULT_URL }], model });
    }
    /** Hosted endpoints from env/~/.env keys with failover. Undefined when no keys resolve. */
    static hosted(model) {
        const providers = hostedProviders();
        if (providers.length === 0)
            return undefined;
        return new SystemOneClient({ providers, model });
    }
    async judge(req, opts = {}) {
        const first = this.active;
        try {
            return await this.send(first, req, opts.signal, this.providers.length > 1);
        }
        catch (err) {
            // Single-provider clients (local) never fail over; hosted clients fail
            // over once to the other provider on failover-worthy errors.
            if (this.providers.length <= 1 || !isFailoverWorthy(err))
                throw err;
            const fallback = 1 - first;
            const result = await this.send(fallback, req, opts.signal, true);
            this.active = fallback;
            return result;
        }
    }
    async send(providerIdx, req, callerSignal, retry) {
        const provider = this.providers[providerIdx];
        if (provider === undefined)
            throw new Error("systemone: no providers configured");
        const body = JSON.stringify({ state: req.state, model: this.model, questions: req.questions });
        let attempt = 0;
        for (;;) {
            throwIfAborted(callerSignal);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(new Error(`systemone request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)), REQUEST_TIMEOUT_MS);
            const onCallerAbort = () => ctrl.abort(callerSignal?.reason ?? new Error("aborted"));
            callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
            try {
                const headers = { "Content-Type": "application/json" };
                if (provider.auth !== undefined)
                    headers.Authorization = provider.auth;
                const resp = await fetch(provider.url, { method: "POST", headers, body, signal: ctrl.signal });
                if (resp.status === 200) {
                    let parsed;
                    try {
                        parsed = await resp.json();
                    }
                    catch (err) {
                        throw failoverError(`decode: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    if (parsed === null || typeof parsed !== "object" || !("answers" in parsed)) {
                        throw failoverError("decode: response has no answers object");
                    }
                    const answersWire = parsed.answers;
                    if (answersWire === null || typeof answersWire !== "object") {
                        throw failoverError("decode: response has no answers object");
                    }
                    const usageWire = "usage" in parsed && parsed.usage !== null && typeof parsed.usage === "object"
                        ? parsed.usage
                        : {};
                    const input = numField(usageWire.input_tokens);
                    const output = numField(usageWire.output_tokens);
                    // The native wire also carries extra answer fields (legend, …) — read
                    // only noul and ignore the rest, never exhaustively validate.
                    const answers = {};
                    for (const [key, value] of Object.entries(answersWire)) {
                        answers[key] = readNoul(value);
                    }
                    // Hosted endpoints bill input tokens; the local endpoint is free.
                    const cost = provider.auth === undefined ? 0 : input * USD_PER_INPUT_TOKEN;
                    return { answers, usage: { input, output, cost: { total: cost } } };
                }
                const text = await resp.text().catch(() => "");
                const status = resp.status;
                if (retry && transient(status) && attempt < MAX_RETRIES) {
                    attempt += 1;
                    await sleep(backoffMs(attempt, retryAfterMs(resp.headers)), callerSignal);
                    continue;
                }
                if (canFailover(status))
                    throw failoverError(`HTTP ${status}: ${truncate(text, 300)}`);
                throw new Error(`HTTP ${status}: ${truncate(text, 300)}`);
            }
            catch (err) {
                if (isAbort(err, callerSignal))
                    throw err instanceof Error ? err : new Error(String(err));
                if (retry && attempt < MAX_RETRIES && isTransport(err)) {
                    attempt += 1;
                    await sleep(backoffMs(attempt), callerSignal);
                    continue;
                }
                throw err instanceof Error ? err : new Error(String(err));
            }
            finally {
                clearTimeout(timer);
                callerSignal?.removeEventListener("abort", onCallerAbort);
            }
        }
    }
}
/** Read {noul} from a raw wire answer; extra fields tolerated, non-noul shapes read as unknown. */
function readNoul(value) {
    if (value !== null && typeof value === "object" && "noul" in value) {
        const n = value.noul;
        if (typeof n === "number")
            return { noul: n };
    }
    return {};
}
function numField(v) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
function throwIfAborted(signal) {
    if (signal?.aborted === true) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error("aborted");
    }
}
const FAILOVER_MARK = "systemone-failover:";
function failoverError(message) {
    const err = new Error(`${FAILOVER_MARK} ${message}`);
    err.failoverWorthy = true;
    return err;
}
/** Failover-worthy: marked errors (HTTP failover statuses, transport, decode). */
function isFailoverWorthy(err) {
    if (!(err instanceof Error))
        return true;
    if ("failoverWorthy" in err && err.failoverWorthy === true)
        return true;
    // fetch() transport failures are TypeErrors (aborts are handled separately).
    return err.constructor.name === "TypeError";
}
/** Transport failure (retryable inside one provider): a fetch TypeError, not an HTTP status. */
function isTransport(err) {
    return err instanceof Error && err.constructor.name === "TypeError" &&
        !(("failoverWorthy" in err) && err.failoverWorthy === true);
}
function isAbort(err, callerSignal) {
    if (callerSignal?.aborted === true)
        return true;
    return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
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
export async function resolveJudge(pi, ctx) {
    const local = localUrl();
    if (local !== undefined)
        return SystemOneClient.local(local);
    try {
        const mod = await import("@oh-my-pi/pi-coding-agent/judgment");
        if (typeof mod?.resolveJudge === "function") {
            const piSettings = pi !== null && typeof pi === "object" && "pi" in pi
                ? pi.pi?.settings
                : undefined;
            const ctxObj = ctx !== null && typeof ctx === "object" ? ctx : undefined;
            let onUsage;
            try {
                onUsage = typeof mod.journalJudgmentUsage === "function"
                    ? mod.journalJudgmentUsage(ctxObj?.sessionManager, "omp-find")
                    : undefined;
            }
            catch {
                onUsage = undefined;
            }
            let sessionId;
            try {
                sessionId = typeof ctxObj?.sessionManager?.getSessionId === "function"
                    ? ctxObj.sessionManager.getSessionId()
                    : undefined;
            }
            catch {
                sessionId = undefined;
            }
            const adapted = await adaptHostModule(mod, {
                settings: piSettings,
                registry: ctxObj?.modelRegistry,
                sessionModel: ctxObj?.model,
                sessionId,
                ...(onUsage !== undefined ? { onUsage } : {}),
            });
            if (adapted !== undefined)
                return adapted;
        }
    }
    catch {
        // Hosts without the judgment subpath reject the literal import — fall through.
    }
    return SystemOneClient.hosted();
}
/**
 * Settle a host module's resolveJudge result — sync or async — into our Judge.
 * Hosts may resolve the judge asynchronously; awaiting here keeps async hosts
 * working (an unawaited Promise would fall through adaptHostJudge as shapeless
 * and risk an unhandled rejection).
 */
export async function adaptHostModule(mod, args) {
    if (typeof mod?.resolveJudge !== "function")
        return undefined;
    return adaptHostJudge(await mod.resolveJudge(args));
}
/**
 * Adapt the host ChainJudge result shape to our Judge: answers keyed by
 * question with raw wire objects (extra fields tolerated), usage with
 * input/output/cost{total}. Returns undefined when the shape is unusable.
 */
function adaptHostJudge(judge) {
    if (judge === null || typeof judge !== "object" || !("judge" in judge))
        return undefined;
    const judgeFn = judge.judge;
    if (typeof judgeFn !== "function")
        return undefined;
    const labelRaw = "label" in judge ? judge.label : undefined;
    const label = typeof labelRaw === "string" ? labelRaw : "host judge";
    return {
        label,
        async judge(req, opts = {}) {
            // Bound to the host judge object: host judges are class instances whose
            // `judge` method reads `this` (e.g. `this.withCandidate`).
            const res = await judgeFn.call(judge, { state: req.state, questions: req.questions }, { signal: opts.signal });
            if (res === null || typeof res !== "object" || !("answers" in res)) {
                throw new Error("judge returned an unusable result");
            }
            const answersWire = res.answers;
            if (answersWire === null || typeof answersWire !== "object") {
                throw new Error("judge returned an unusable result");
            }
            const answers = {};
            for (const [key, value] of Object.entries(answersWire)) {
                answers[key] = readNoul(value);
            }
            const usageWire = "usage" in res && res.usage !== null && typeof res.usage === "object"
                ? res.usage
                : {};
            const costWire = usageWire.cost !== null && typeof usageWire.cost === "object" && "total" in usageWire.cost
                ? usageWire.cost.total
                : undefined;
            return {
                answers,
                usage: { input: numField(usageWire.input), output: numField(usageWire.output), cost: { total: numField(costWire) } },
            };
        },
    };
}
