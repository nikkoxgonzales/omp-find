/** omp-find tool surface (core default; OMP_FIND_TOOLS=full reserved) with session counters for /find-health. `fffind` + `ffgrep` always; override mode additionally claims `find` + `grep`. */
import fs from "node:fs";
import path from "node:path";
const FIND_PAGE = 30;
const GREP_PAGE = 30;
const PAGE_MAX = 50;
const cursors = new Map();
let cursorSeq = 0;
const CURSOR_PREFIX = { find: "find_c", grep: "grep_c", outline: "outline_c", callers: "callers_c", structural: "structural_c" };
function storeCursor(s) {
    const id = `${CURSOR_PREFIX[s.kind]}${++cursorSeq}`;
    cursors.set(id, s);
    if (cursors.size > 200) {
        const first = cursors.keys().next().value;
        if (first !== undefined)
            cursors.delete(first);
    }
    return id;
}
/** Flag > OMP_FIND_MODE env > omp-find.json > override. */
export function resolveFindMode(explicit, cwd = process.cwd()) {
    if (explicit === "additive" || explicit === "override")
        return explicit;
    const env = (process.env.OMP_FIND_MODE ?? "").toLowerCase();
    if (env === "additive" || env === "override")
        return env;
    try {
        const raw = fs.readFileSync(path.join(cwd, "omp-find.json"), "utf8");
        const parsed = JSON.parse(raw);
        const mode = typeof parsed === "object" && parsed !== null && "mode" in parsed ? parsed.mode : undefined;
        if (mode === "additive" || mode === "override")
            return mode;
    }
    catch { /* missing/unparseable → default */ }
    return "override";
}
const STAT_KINDS = ["find", "grep", "outline", "callers", "structural", "map", "capsule"];
const sessionStats = { calls: {}, totalCalls: 0, rg: 0, walker: 0, timeouts: 0, totalMs: 0 };
function recordCall(kind, ms, backend, timedOut) {
    sessionStats.calls[kind] = (sessionStats.calls[kind] ?? 0) + 1;
    sessionStats.totalCalls += 1;
    sessionStats.totalMs += ms;
    if (backend === "rg")
        sessionStats.rg += 1;
    else if (backend === "walker")
        sessionStats.walker += 1;
    if (timedOut === true)
        sessionStats.timeouts += 1;
}
/** Copy of the live counters (callers must not mutate module state). */
export function getSessionStats() {
    return { calls: { ...sessionStats.calls }, totalCalls: sessionStats.totalCalls, rg: sessionStats.rg, walker: sessionStats.walker, timeouts: sessionStats.timeouts, totalMs: sessionStats.totalMs };
}
/** /find-rescan drops these alongside the frecency store (nothing persists). */
export function resetSessionStats() {
    sessionStats.calls = {};
    sessionStats.totalCalls = 0;
    sessionStats.rg = 0;
    sessionStats.walker = 0;
    sessionStats.timeouts = 0;
    sessionStats.totalMs = 0;
}
/** One-line session block for /find-health; zero-state stays a plain count. */
export function sessionStatsText() {
    if (sessionStats.totalCalls === 0)
        return "session: 0 calls";
    const per = STAT_KINDS.filter((k) => (sessionStats.calls[k] ?? 0) > 0).map((k) => `${k}: ${sessionStats.calls[k]}`).join(", ");
    const avg = Math.round(sessionStats.totalMs / sessionStats.totalCalls);
    return `session: ${sessionStats.totalCalls} calls (${per}); backend rg: ${sessionStats.rg} walker: ${sessionStats.walker}; timeouts: ${sessionStats.timeouts}; avg ${avg}ms`;
}
export function resolveFindToolsTier(explicit) {
    const v = (explicit ?? process.env.OMP_FIND_TOOLS ?? "").trim().toLowerCase();
    return v === "full" ? "full" : "core";
}
function text(t) {
    return { content: [{ type: "text", text: t }] };
}
function withDetails(t, details) {
    return { ...text(t), details };
}
/** pi-fff limit-reached notice, emitted next to our cursor footer when a next page exists. */
function limitNotice(limit) {
    return `${limit} matches limit reached. Use limit=${limit * 2}`;
}
/** gograph query contracts: cursors bind to the fetched snapshot (total + backend).
 * Resume re-fetches and compares; a mismatch returns restart guidance, never a
 * silently re-offset page. Cursor id format is unchanged (kind_cN). */
function snapshotMismatch(stored, live) {
    return stored.total !== live.total || stored.backend !== live.backend;
}
function staleCursor(toolName) {
    return text(`${toolName}: results changed since page 1; re-run without cursor`);
}
/** gograph certainty: import/call-paren sites are exact; member access `.SYM`,
 * comments, and anything else unresolvable by text heuristics is possible. */
function callerCertainty(symbol, rowText, ignoreCase) {
    const flags = ignoreCase ? "i" : "";
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\s*\\(`, flags).test(rowText))
        return "exact";
    if (new RegExp(`(?:import|from|require|use|include)\\b[^\n]*\\b${esc}\\b`, flags).test(rowText))
        return "exact";
    return "possible";
}
/** Tag possible caller rows; the match row renders first, context rows stay indented.
 * With showDepth (ffcallers depth 2|3) each ring is labeled `depth:N` first.
 * Certainty is judged against the ring's own symbol (`via`, falling back to the
 * query) so transitive import/call sites stay exact instead of mistagging. */
function tagCallerRows(symbol, m, ignoreCase, showDepth = false) {
    const rows = renderGrepRows(m);
    if (showDepth && typeof m.depth === "number")
        rows[0] = `depth:${m.depth} ${rows[0]}`;
    if (callerCertainty(m.via ?? symbol, m.text, ignoreCase) === "possible")
        rows[0] = `[possible] ${rows[0]}`;
    return rows;
}
/** hermes nudges: budgeted rotating cross-tool tips on non-trivial results.
 * Static card copy can't react to what just happened; nudges are the dynamic,
 * budgeted complement — one rotating tip per call, 3 per tool per process
 * (same eviction spirit as storeCursor), only when hits > 5 so trivial calls
 * stay clean. Footer-only; never blocks or redirects. */
const NUDGE_BUDGET = 3;
const nudgeUsed = new Map();
const NUDGES = {
    find: [
        "tip: ffoutline <file> shows a file's shape before you read it",
        "tip: ffcallers <name> finds call sites without grep chains",
        "tip: ffmap gives a fitted repo overview in one call",
    ],
    grep: [
        "tip: ffcallers <name> finds call sites without grep chains",
        "tip: ffstructural 'f($A)' finds call shapes, not strings",
        "tip: ffcapsule <name> fuses signature, doc, callers and next step in one call",
    ],
};
/** One rotating tip for non-trivial results; empty for trivial calls. */
function nudge(kind, hits) {
    if (hits <= 5)
        return [];
    const tips = NUDGES[kind];
    if (!tips)
        return [];
    const used = nudgeUsed.get(kind) ?? 0;
    if (used >= NUDGE_BUDGET)
        return [];
    nudgeUsed.set(kind, used + 1);
    return ["", tips[used % tips.length]];
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function strParam(params, key) {
    const v = params[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function numParam(params, key) {
    const v = params[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), PAGE_MAX) : undefined;
}
async function safeScore(frecency, p) {
    try {
        return (await frecency?.score(p)) ?? 0;
    }
    catch {
        return 0;
    }
}
function toDisplay(p) {
    return p.replace(/\\/g, "/");
}
/** xxHash32 primes (seed 0 throughout the hashline tag path). */
const XXH_P1 = 0x9e3779b1;
const XXH_P2 = 0x85ebca77;
const XXH_P3 = 0xc2b2ae3d;
const XXH_P4 = 0x27d4eb2f;
const XXH_P5 = 0x165667b1;
function xxhRotl(x, r) {
    return ((x << r) | (x >>> (32 - r))) | 0;
}
function xxhRead32(b, p) {
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0;
}
function xxhRound(acc, input) {
    acc = (acc + Math.imul(input, XXH_P2)) | 0;
    acc = xxhRotl(acc, 13);
    return Math.imul(acc, XXH_P1) | 0;
}
/** Standard xxHash32 over raw bytes. Stripe rounds use P2/rotl13/P1; the
 * leftover 4-byte tail lane uses P3/rotl17/P4. NO lane-merge round after
 * combining v1..v4 (that merge belongs to XXH64): h is rotl(v1,1)+
 * rotl(v2,7)+rotl(v3,12)+rotl(v4,18), then len, tail, avalanche. Every
 * multiply is Math.imul — plain `*` overflows float64 past 2^53 and
 * silently mismatches. */
export function xxh32Bytes(bytes, seed = 0) {
    const len = bytes.length;
    let p = 0;
    let h;
    if (len >= 16) {
        let v1 = (((seed + XXH_P1) | 0) + XXH_P2) | 0;
        let v2 = (seed + XXH_P2) | 0;
        let v3 = seed | 0;
        let v4 = (seed - XXH_P1) | 0;
        while (p + 16 <= len) {
            v1 = xxhRound(v1, xxhRead32(bytes, p));
            p += 4;
            v2 = xxhRound(v2, xxhRead32(bytes, p));
            p += 4;
            v3 = xxhRound(v3, xxhRead32(bytes, p));
            p += 4;
            v4 = xxhRound(v4, xxhRead32(bytes, p));
            p += 4;
        }
        h = (xxhRotl(v1, 1) + xxhRotl(v2, 7) + xxhRotl(v3, 12) + xxhRotl(v4, 18)) | 0;
    }
    else {
        h = (seed + XXH_P5) | 0;
    }
    h = (h + len) | 0;
    while (p + 4 <= len) {
        h = (h + Math.imul(xxhRead32(bytes, p), XXH_P3)) | 0;
        h = xxhRotl(h, 17);
        h = Math.imul(h, XXH_P4) | 0;
        p += 4;
    }
    while (p < len) {
        h = (h + Math.imul(bytes[p], XXH_P5)) | 0;
        h = xxhRotl(h, 11);
        h = Math.imul(h, XXH_P1) | 0;
        p += 1;
    }
    h ^= h >>> 15;
    h = Math.imul(h, XXH_P2) | 0;
    h ^= h >>> 13;
    h = Math.imul(h, XXH_P3) | 0;
    h ^= h >>> 16;
    return h >>> 0;
}
/** 4-hex hashline content tag for whole-file text (path contributes zero
 * bytes). Pipeline mirrors hashline_file_hash (pi-natives edit.rs) over
 * store::file_hash (pi-edit store.rs): strip exactly one leading U+FEFF BOM,
 * normalize CRLF and lone CR to LF, per line rstrip ' '/'\t'/'\r' while
 * preserving LF structure (split_inclusive('\n') semantics), then xxh32
 * low 16 bits as 4 uppercase hex chars. */
export function hashlineFileHash(text) {
    let body = text.startsWith("\uFEFF") ? text.slice(1) : text;
    if (body.includes("\r"))
        body = body.replace(/\r\n?/g, "\n");
    const parts = body.split("\n");
    let normalized = "";
    for (let i = 0; i < parts.length; i++) {
        normalized += parts[i].replace(/[ \t\r]+$/, "");
        if (i < parts.length - 1)
            normalized += "\n";
    }
    return ((xxh32Bytes(new TextEncoder().encode(normalized), 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0"));
}
/** `[displayPath#TAG]` section header for a file's whole text. */
export function hashlineHeader(displayPath, text) {
    return `[${displayPath}#${hashlineFileHash(text)}]`;
}
/** Whole-file hashline tags for one grep page: each file read once per call
 * (files already on disk post-search), backend-agnostic (rg + walker share
 * it). Unreadable/binary files get no tag — their rows still render, just
 * without a header. Never throws. */
async function hashlineTagsFor(cwdDir, files) {
    const cwd = path.resolve(cwdDir ?? process.cwd());
    const tags = new Map();
    await Promise.all([...new Set(files)].map(async (f) => {
        try {
            const buf = await fs.promises.readFile(path.join(cwd, f));
            if (buf.indexOf(0) >= 0)
                return; // binary skip (same rule as the walker)
            tags.set(f, hashlineFileHash(buf.toString("utf8")));
        }
        catch { /* missing/unreadable → rows render without a header */ }
    }));
    return tags;
}
/** Group one page of per-match row blocks by file (first-seen file order,
 * page order within a file) and prefix each group with its hashline header.
 * Backends already emit file-contiguous pages, so grouping is a no-op on
 * order there; run-length output would be identical. */
function groupGrepBlocks(blocks, tags) {
    const order = [];
    const buckets = new Map();
    for (const b of blocks) {
        let bucket = buckets.get(b.path);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(b.path, bucket);
            order.push(b.path);
        }
        bucket.push(...b.rows);
    }
    const out = [];
    for (const p of order) {
        const tag = tags.get(p);
        if (tag !== undefined)
            out.push(`[${toDisplay(p)}#${tag}]`);
        out.push(...(buckets.get(p) ?? []));
    }
    return out;
}
/** Tools-layer path filter for ffgrep (dir/ prefix, glob, or bare name). */
function applyPathFilter(paths, filter, glob) {
    const flat = filter.replace(/\\/g, "/");
    const f = flat.startsWith("./") ? flat.slice(2) : flat;
    if (f.endsWith("/")) {
        const dir = f.slice(0, -1);
        return paths.filter((p) => { const d = toDisplay(p); return d === dir || d.startsWith(`${dir}/`); });
    }
    if (/[*?[{]/.test(f) && glob) {
        const re = glob(f);
        return paths.filter((p) => { const d = toDisplay(p); return re.test(d) || re.test(d.slice(d.lastIndexOf("/") + 1)); });
    }
    return paths.filter((p) => {
        const d = toDisplay(p);
        return d === f || d.startsWith(`${f}/`) || d.slice(d.lastIndexOf("/") + 1) === f;
    });
}
/** Explicit-pin detector for the `path` filter: a concrete `dir/` or
 * `dir/file` pin (contains a slash, no glob magic) is forwarded to the core
 * as a backend scope so rg/walker search it directly — hidden/ignored files
 * included. Glob (`*.py`) and bare-basename (`file.py`) forms return
 * undefined and keep today's multi-directory post-filter. */
function scopePin(filter) {
    if (!filter)
        return undefined;
    const flat = filter.replace(/\\/g, "/");
    const f = flat.startsWith("./") ? flat.slice(2) : flat;
    if (!f.includes("/"))
        return undefined;
    if (/[*?[{]/.test(f))
        return undefined;
    const segs = f.split("/").filter(Boolean);
    if (segs.length === 0 || segs.includes(".."))
        return undefined;
    return segs.join("/");
}
function ctxParam(params, key) {
    const v = params[key];
    if (typeof v !== "number" || !Number.isFinite(v))
        return 0;
    return Math.max(0, Math.min(5, Math.floor(v)));
}
function charsParam(params, key) {
    const v = params[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
        return undefined;
    return Math.min(Math.floor(v), 1000000);
}
/** Top-counts summary fragment: "b: 3, a: 1", at most 10 entries. */
function countSummary(entries) {
    return [...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(", ");
}
function overBudget(rendered, maxChars) {
    return maxChars !== undefined && rendered.length > maxChars;
}
/** Optional scan root: must be an absolute directory when given. Resolution plus the */
/** filesystem-root/home runaway guard live in the core (guardCwd); relative input is */
/** rejected here so a bare "src" can never silently resolve against process.cwd(). */
function cwdParam(params) {
    const raw = strParam(params, "cwd");
    if (raw === undefined)
        return undefined;
    if (!path.isAbsolute(raw))
        throw new Error(`cwd must be an absolute directory path (got "${raw}")`);
    return raw;
}
function renderGrepRows(m) {
    const disp = toDisplay(m.path);
    const rows = [`${disp}:${m.line}:${m.col}: ${m.text}`];
    const before = m.before ?? [];
    for (let i = 0; i < before.length; i++)
        rows.push(`  ${disp}:${m.line - before.length + i}: ${before[i]}`);
    const after = m.after ?? [];
    for (let i = 0; i < after.length; i++)
        rows.push(`  ${disp}:${m.line + i + 1}: ${after[i]}`);
    return rows;
}
/** Expand knob: only "function" enables enclosing-symbol attribution, anything else is "none". */
function expandParam(params) {
    return strParam(params, "expand") === "function" ? "function" : "none";
}
function asFindScanned(v) {
    // Named-const cast with reason: typeof-narrowed functions are not directly callable.
    const fn = typeof v === "function" ? v : undefined;
    return fn;
}
function asFindScanLike(v) {
    if (v === null || typeof v !== "object" || !("paths" in v))
        return undefined;
    const paths = v.paths;
    if (!Array.isArray(paths))
        return undefined;
    const like = { paths };
    if ("scanned" in v)
        like.scanned = v.scanned;
    if ("backend" in v)
        like.backend = v.backend;
    return like;
}
/** One find round: ranked paths plus scan metadata when the core exposes findScanned. */
async function runFind(search, query, opts) {
    const detailed = "findScanned" in search ? asFindScanned(search.findScanned) : undefined;
    if (detailed !== undefined) {
        const like = asFindScanLike(await detailed(query, opts));
        if (like !== undefined && like.paths.every((p) => typeof p === "string")) {
            return {
                paths: like.paths,
                scanned: typeof like.scanned === "number" ? like.scanned : undefined,
                backend: like.backend === "rg" || like.backend === "walker" ? like.backend : undefined,
            };
        }
    }
    return { paths: await search.findPaths(query, opts) };
}
/** Zero-state with scan facts when known, mirroring fff's `0 results (N indexed)`. */
function zeroFind(scanned, backend, relaxed) {
    if (relaxed !== undefined) {
        const facts = scanned !== undefined && backend !== undefined ? ` (${scanned} files scanned, ${backend}; relaxed to "${relaxed.to}")` : ` (relaxed to "${relaxed.to}")`;
        return `0 matches for "${relaxed.from}"${facts}`;
    }
    return scanned !== undefined && backend !== undefined ? `0 matches (${scanned} files scanned, ${backend})` : "0 matches";
}
export function registerFindTools(pi, deps, opts = {}) {
    const search = deps.search;
    const frecency = deps.frecency;
    if (!search?.findPaths || !search?.grepContents)
        return;
    const mode = resolveFindMode(opts.mode, opts.cwd ?? process.cwd());
    const isOverride = mode === "override";
    const tier = resolveFindToolsTier(opts.tools);
    // Canonical host form is the single object {name, label, ...}: registerTool(tool)
    // (verified against the omp host ExtensionAPI types — no (name, def) arity exists).
    const register = (name, label, def) => {
        pi.registerTool({ name, label, ...def });
    };
    const findDef = (toolName) => ({
        description: "Use instead of shell grep/rg/find/ls because results are fuzzy-ranked, frecency-ordered, paged, and counted. Fuzzy 1-2 terms plus dir/glob/exclusion/git:modified filters with auto-retry on long queries and scan counts; e.g. pattern 'srv usr' with path 'src/' lists ranked matches under src/.",
        promptSnippet: "Find files by fuzzy name (frecency-ranked, paged, counted)",
        approval: "read",
        promptGuidelines: [
            "fffind: Never use shell find/ls/dir to locate files — use fffind with 1-2 short terms.",
            "fffind: Keep fffind queries SHORT: 1-2 terms (e.g. 'user_service'); add terms only to narrow, never as OR.",
            "fffind: Prefer bare identifiers over sentences; when the top hit is an exact filename match, read it directly.",
        ],
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Fuzzy query: 1-2 short terms (e.g. 'srv usr'); supports dir/ prefix, *.ext globs, !exclusions, git:modified" },
                path: { type: "string", description: "Within-tree filter prepended to the query (e.g. 'src/'); same as embedding 'src/' in pattern" },
                cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd; refused for filesystem-root and home" },
                limit: { type: "number", description: "Max results per page (default 30, max 50)" },
                cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
                maxChars: { type: "number", description: "Max output chars; when exceeded returns per-dir counts instead of rows" },
                concise: { type: "boolean", description: "Concise paths-only rows (default false) — drops notes and tips, same ranking" },
            },
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                let query, limit, offset, cwd, maxChars, concise, scope;
                let all;
                let relaxed;
                let scanned, backend;
                let bound;
                const cursorId = strParam(params, "cursor");
                if (cursorId) {
                    const st = cursors.get(cursorId);
                    if (!st || st.kind !== "find")
                        return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
                    query = st.query;
                    limit = st.limit;
                    offset = st.nextOffset;
                    cwd = st.cwd;
                    scope = st.scope;
                    maxChars = st.maxChars;
                    concise = st.concise === true;
                    bound = { total: st.total, backend: st.backend };
                    const live = await runFind(search, query, scope === undefined ? { cwd, limit: PAGE_MAX, offset: 0 } : { cwd, limit: PAGE_MAX, offset: 0, scope });
                    all = live.paths;
                    scanned = live.scanned;
                    backend = live.backend;
                }
                else {
                    const pattern = strParam(params, "pattern") ?? "";
                    const dirParam = strParam(params, "path");
                    query = [dirParam, pattern].filter(Boolean).join(" ");
                    if (!query)
                        return text(`${toolName} failed: provide a pattern or path`);
                    limit = numParam(params, "limit") ?? FIND_PAGE;
                    offset = 0;
                    cwd = cwdParam(params);
                    scope = scopePin(dirParam);
                    maxChars = charsParam(params, "maxChars");
                    concise = params["concise"] === true;
                    let fetched = await runFind(search, query, scope === undefined ? { cwd, limit: PAGE_MAX, offset: 0 } : { cwd, limit: PAGE_MAX, offset: 0, scope });
                    scanned = fetched.scanned;
                    backend = fetched.backend;
                    const words = pattern.trim().split(/\s+/).filter(Boolean);
                    if (fetched.paths.length === 0 && words.length >= 3) {
                        // One auto-retry with the first 2 terms (fff find_files behavior); the
                        // directory constraint is preserved, only the fuzzy tail is shortened.
                        const shorter = [dirParam, words.slice(0, 2).join(" ")].filter(Boolean).join(" ");
                        fetched = await runFind(search, shorter, scope === undefined ? { cwd, limit: PAGE_MAX, offset: 0 } : { cwd, limit: PAGE_MAX, offset: 0, scope });
                        scanned = fetched.scanned ?? scanned;
                        backend = fetched.backend ?? backend;
                        relaxed = { from: query, to: shorter };
                        query = shorter;
                    }
                    all = fetched.paths;
                }
                const ranked = await Promise.all(all.map(async (p) => ({ p, s: await safeScore(frecency, p) })));
                ranked.sort((a, b) => b.s - a.s); // stable: frecency first, fuzzy order otherwise
                const total = ranked.length;
                statBackend = backend;
                if (bound !== undefined && snapshotMismatch(bound, { total, backend }))
                    return staleCursor(toolName);
                const page = ranked.slice(offset, offset + limit);
                const lines = page.map((r) => toDisplay(r.p));
                if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
                    const byDir = new Map();
                    for (const r of ranked) {
                        const d = toDisplay(r.p), slash = d.lastIndexOf("/");
                        const dir = slash < 0 ? "." : d.slice(0, slash);
                        byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
                    }
                    return withDetails(`Matched ${total} files (output exceeds ${maxChars} chars). Per-dir counts: ${countSummary([...byDir])}. Refine path/pattern or raise maxChars.`, { totalMatched: total, totalFiles: scanned ?? total, truncated: true });
                }
                const hasMore = offset + page.length < total;
                const details = { totalMatched: total, totalFiles: scanned ?? total, truncated: hasMore };
                if (hasMore) {
                    const next = storeCursor(scope === undefined ? { kind: "find", query, limit, nextOffset: offset + page.length, cwd, maxChars, concise, total, backend } : { kind: "find", query, limit, nextOffset: offset + page.length, cwd, scope, maxChars, concise, total, backend });
                    lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`, limitNotice(limit));
                }
                if (lines.length === 0)
                    return withDetails(zeroFind(scanned, backend, relaxed), { totalMatched: 0, totalFiles: scanned ?? 0, truncated: false });
                if (!concise && relaxed !== undefined)
                    lines.unshift(`note: no matches for "${relaxed.from}"; showing results for "${relaxed.to}"`, "");
                if (!concise)
                    lines.push(...nudge("find", total));
                return withDetails(lines.join("\n"), details);
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("find", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    const grepDef = (toolName) => ({
        description: "Use instead of shell grep/rg/find/ls because results are literal-safe, frecency-ranked, paged, and counted. Literal-safe any string (no escaping ever): e.g. pattern 'Chat ID (CHT-XXXX from list_chats or search_chats)' with path 'server.py' searches that one file literally (total returned, no counting needed). Bare-file/dir/glob path filter, zero-state scan facts, context lines, cwd scan root (no cd), maxChars budgets. Regex when literal=false.",
        promptSnippet: "Search file contents literally or by regex (ranked, paged, counted)",
        approval: "read",
        promptGuidelines: [
            "ffgrep: Never use shell grep/rg/select-string for code search — use ffgrep with literal:true and a path filter.",
            "ffgrep: Prefer bare identifiers (e.g. 'frecency') over sentences; stay literal unless regex is needed.",
            "ffgrep: Scope with the path filter (dir/ prefix, *.ext glob, or bare filename like 'server.py') before broadening the search.",
        ],
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Search text or regex (required). Literal by default: quotes/parens need no escaping" },
                path: { type: "string", description: "File filter: dir/ prefix ('src/'), glob ('*.ts'), or bare filename ('server.py'); applies over the full result set" },
                literal: { type: "boolean", description: "Literal match (default true); set false to use regex" },
                ignoreCase: { type: "boolean", description: "Case-insensitive match (default false)" },
                wholeWord: { type: "boolean", description: "Whole-word match (default false) — no more hand-rolled \\b regexes; ASCII \\b limits apply, so patterns starting/ending with a non-word char may not match" },
                smartCase: { type: "boolean", description: "Smart case (default false) — no more case juggling in shell pipes: lowercase patterns match case-insensitively, any uppercase letter restores sensitivity; overrides ignoreCase when enabled" },
                cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd) — pass cwd instead of cd; refused for filesystem-root and home" },
                limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
                cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
                contextBefore: { type: "number", description: "Context lines before each match (default 0, max 5)" },
                contextAfter: { type: "number", description: "Context lines after each match (default 0, max 5)" },
                expand: { type: "string", description: "Enclosing-symbol attribution: 'function' adds an 'in <kind> <name>' header per match via an outline pass (default 'none') — approximate, line-anchored" },
                maxChars: { type: "number", description: "Max output chars; when exceeded returns per-file counts instead of rows" },
                concise: { type: "boolean", description: "Concise path:line rows (default false) — existence probe without text; ignores context params" },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                let pattern, literal, ignoreCase, wholeWord, smartCase, pathFilter, scope;
                let limit, offset, cwd;
                let contextBefore, contextAfter, expand, maxChars, concise;
                const cursorId = strParam(params, "cursor");
                let bound;
                if (cursorId) {
                    const st = cursors.get(cursorId);
                    if (!st || st.kind !== "grep")
                        return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
                    pattern = st.pattern;
                    literal = st.literal;
                    ignoreCase = st.ignoreCase;
                    wholeWord = st.wholeWord;
                    smartCase = st.smartCase;
                    pathFilter = st.pathFilter;
                    scope = st.scope ?? scopePin(st.pathFilter);
                    limit = st.limit;
                    offset = st.nextOffset;
                    cwd = st.cwd;
                    contextBefore = st.contextBefore;
                    contextAfter = st.contextAfter;
                    expand = st.expand === "function" ? "function" : "none";
                    maxChars = st.maxChars;
                    concise = st.concise === true;
                    bound = { total: st.total, backend: st.backend };
                }
                else {
                    const p = strParam(params, "pattern");
                    if (!p)
                        return text(`${toolName} failed: provide a pattern`);
                    pattern = p;
                    literal = params["literal"] === undefined ? true : params["literal"] === true;
                    ignoreCase = params["ignoreCase"] === true;
                    wholeWord = params["wholeWord"] === true;
                    smartCase = params["smartCase"] === true;
                    pathFilter = strParam(params, "path");
                    scope = scopePin(pathFilter);
                    limit = numParam(params, "limit") ?? GREP_PAGE;
                    offset = 0;
                    cwd = cwdParam(params);
                    contextBefore = ctxParam(params, "contextBefore");
                    contextAfter = ctxParam(params, "contextAfter");
                    expand = expandParam(params);
                    maxChars = charsParam(params, "maxChars");
                    concise = params["concise"] === true;
                }
                // Path filters apply tools-side over the full result set: a bounded fetch
                // first would drop hits outside the page (false empty zero-states). Word
                // boundaries and totals likewise hold over the full set before slicing —
                // cursor paging re-fetches with the same flags, so limits never skew them.
                // Context and expand keys only travel when set: absence keeps the core call identical.
                const pageOpts = { cwd, literal, ignoreCase, wholeWord, smartCase, limit, offset };
                if (!concise && contextBefore > 0)
                    pageOpts.contextBefore = contextBefore;
                if (!concise && contextAfter > 0)
                    pageOpts.contextAfter = contextAfter;
                if (!concise && expand === "function")
                    pageOpts.expand = expand;
                // Explicit pins additionally scope the backend: rg receives the pin as
                // its positional path (hidden/ignored files included) and the walker
                // seeds traversal at the pin; the post-filter below still applies, so
                // glob/bare-basename forms and totals render exactly as before.
                const res = await search.grepContents(pattern, pathFilter ? (scope === undefined ? { cwd, literal, ignoreCase, wholeWord, smartCase } : { cwd, literal, ignoreCase, wholeWord, smartCase, scope }) : pageOpts);
                const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
                const matches = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
                const total = pool === null ? res.total : matches.length;
                const liveBackend = typeof res.backend === "string" ? res.backend : undefined;
                statBackend = liveBackend;
                if (bound !== undefined && snapshotMismatch(bound, { total, backend: liveBackend }))
                    return staleCursor(toolName);
                const page = pool === null ? matches : matches.slice(offset, offset + limit);
                if (!concise && pool !== null && (contextBefore > 0 || contextAfter > 0) && typeof search.attachContext === "function") {
                    await search.attachContext(cwd, page, contextBefore, contextAfter);
                }
                if (!concise && expand === "function" && pool !== null && typeof search.attachEnclosing === "function") {
                    await search.attachEnclosing(cwd, page);
                }
                // Hashline file groups: per-match row blocks grouped by file and prefixed
                // with `[path#TAG]` (whole-file tag, read once per file per call). The
                // expand collapse state threads through page order first, so consecutive
                // same-symbol headers collapse exactly as in the ungrouped rendering.
                let blocks;
                if (concise) {
                    blocks = page.map((m) => ({ path: m.path, rows: [`${toDisplay(m.path)}:${m.line}`] }));
                }
                else if (expand === "function") {
                    let last = "";
                    blocks = page.map((m) => {
                        const head = m.enclosing ? `in ${m.enclosing.kind} ${m.enclosing.name}` : "";
                        const rows = [...(head !== "" && head !== last ? [head] : []), ...renderGrepRows(m)];
                        last = head;
                        return { path: m.path, rows };
                    });
                }
                else {
                    blocks = page.map((m) => ({ path: m.path, rows: renderGrepRows(m) }));
                }
                const ungrouped = blocks.flatMap((b) => b.rows);
                if (total > 0 && overBudget(ungrouped.join("\n"), maxChars)) {
                    // Unfiltered fetches are paged, so counting the page would under-report
                    // files while printing the full total — re-fetch unbounded for the count
                    // pass (filtered fetches already hold the full set; rows stay paged).
                    let counted = matches;
                    if (pool === null) {
                        try {
                            counted = (await search.grepContents(pattern, { cwd, literal, ignoreCase, wholeWord, smartCase })).matches;
                        }
                        catch {
                            counted = matches;
                        }
                    }
                    const byFile = new Map();
                    for (const m of counted)
                        byFile.set(toDisplay(m.path), (byFile.get(toDisplay(m.path)) ?? 0) + 1);
                    const fileWord = byFile.size === 1 ? "file" : "files";
                    return withDetails(`Matched ${total} hits in ${byFile.size} ${fileWord} (output exceeds ${maxChars} chars). Per-file counts: ${countSummary([...byFile])}. Refine path/pattern or raise maxChars.`, { totalMatched: total, totalFiles: byFile.size, truncated: true });
                }
                const tags = await hashlineTagsFor(cwd, page.map((m) => m.path));
                const lines = groupGrepBlocks(blocks, tags);
                if (lines.length === 0) {
                    const backend = typeof res.backend === "string" ? res.backend : undefined;
                    return withDetails(backend !== undefined ? `0 matches for "${pattern}" (${backend})` : `0 matches for "${pattern}"`, { totalMatched: 0, totalFiles: 0, truncated: false });
                }
                lines.push(`(${total} match${total === 1 ? "" : "es"} total)`);
                if (!concise)
                    lines.push(...nudge("grep", total));
                const hasMore = offset + page.length < total;
                const details = { totalMatched: total, totalFiles: new Set(matches.map((m) => m.path)).size, truncated: hasMore };
                if (hasMore) {
                    const next = storeCursor(scope === undefined ? {
                        kind: "grep", pattern, literal, ignoreCase, wholeWord, smartCase, pathFilter, limit, nextOffset: offset + page.length, cwd, contextBefore, contextAfter, expand, maxChars, concise, total, backend: liveBackend,
                    } : {
                        kind: "grep", pattern, literal, ignoreCase, wholeWord, smartCase, pathFilter, scope, limit, nextOffset: offset + page.length, cwd, contextBefore, contextAfter, expand, maxChars, concise, total, backend: liveBackend,
                    });
                    lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`, limitNotice(limit));
                }
                return withDetails(lines.join("\n"), details);
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("grep", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    const outlineDef = (toolName) => ({
        description: "Approximate per-file symbol overview (omp-find). Use instead of reading whole files or ctags shells to learn file shape: a 10-line outline composes as outline->grep->read. Regex-based, not LSP-accurate; every hit carries a line number — verify with read/ffgrep. Does not record frecency.",
        promptSnippet: "Outline one file's symbols (approximate shape; verify with read)",
        approval: "read",
        promptGuidelines: [
            "ffoutline: Outline a new file before reading it: a 10-line shape answers 'what lives here' at ~5% of the tokens — never read whole files or run ctags shells to learn shape.",
            "ffoutline: Compose outline->grep->read: outline for shape, ffgrep on one symbol, read the range.",
        ],
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Single file to outline, e.g. 'src/search.ts' (resolved under cwd)" },
                cwd: { type: "string", description: "Scan root: absolute directory holding the file (default: session cwd)" },
                depth: { type: "number", description: "0 = top-level symbols (default), 1 = also one nesting level" },
                limit: { type: "number", description: "Max symbols per page (default 30, max 50)" },
                cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
                maxChars: { type: "number", description: "Max output chars; when exceeded returns kind counts instead of rows" },
                concise: { type: "boolean", description: "Concise name-only rows (default false) — minified shape probe; drops locations" },
            },
            required: ["path"],
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let dispForError = "";
            try {
                if (typeof search.outlineFile !== "function")
                    return text(`${toolName} failed: outline unavailable`);
                let file, depth, limit, offset, cwd, maxChars, concise;
                let bound;
                const cursorId = strParam(params, "cursor");
                if (cursorId) {
                    const st = cursors.get(cursorId);
                    if (!st || st.kind !== "outline")
                        return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
                    file = st.file;
                    dispForError = toDisplay(st.file);
                    depth = st.depth;
                    limit = st.limit;
                    offset = st.nextOffset;
                    cwd = st.cwd;
                    maxChars = st.maxChars;
                    concise = st.concise === true;
                    bound = { total: st.total };
                }
                else {
                    const f = strParam(params, "path");
                    if (!f)
                        return text(`${toolName} failed: provide a path`);
                    file = f;
                    dispForError = toDisplay(f);
                    const d = params["depth"];
                    depth = d === 1 ? 1 : 0;
                    limit = numParam(params, "limit") ?? FIND_PAGE;
                    offset = 0;
                    cwd = cwdParam(params);
                    maxChars = charsParam(params, "maxChars");
                    concise = params["concise"] === true;
                }
                const res = await search.outlineFile(file, { cwd, depth });
                if (bound !== undefined && snapshotMismatch(bound, { total: res.total }))
                    return staleCursor(toolName);
                const disp = toDisplay(file);
                const page = res.symbols.slice(offset, offset + limit);
                const lines = concise ? page.map((s) => s.name) : page.map((s) => `${disp}:${s.line}:${s.col}: ${s.kind} ${s.name}`);
                if (res.total > 0 && overBudget(lines.join("\n"), maxChars)) {
                    const byKind = new Map();
                    for (const s of res.symbols)
                        byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
                    return withDetails(`Matched ${res.total} symbols in ${disp} (output exceeds ${maxChars} chars). Kind counts: ${countSummary([...byKind])}. Refine path or raise maxChars.`, { totalMatched: res.total, totalFiles: 1, truncated: true });
                }
                const hasMore = offset + page.length < res.total;
                if (hasMore) {
                    const next = storeCursor({ kind: "outline", file, depth, limit, nextOffset: offset + page.length, cwd, maxChars, concise, total: res.total });
                    lines.push("", `... (${res.total - offset - page.length} more; pass cursor "${next}" for the next page)`, limitNotice(limit));
                }
                const details = { totalMatched: res.total, totalFiles: 1, truncated: hasMore };
                return withDetails(lines.length > 0 ? lines.join("\n") : `No symbols found in ${disp} (approximate scan)`, details);
            }
            catch (err) {
                // Missing-file reads surface raw syscall text + the absolute path —
                // collapse to the relative display form (core error text untouched).
                const msg = errMsg(err);
                if (dispForError !== "" && msg.startsWith("outline: cannot read"))
                    return text(`${toolName} failed: outline: cannot read ${dispForError}`);
                return text(`${toolName} failed: ${msg}`);
            }
            finally {
                recordCall("outline", Date.now() - t0);
            }
        },
    });
    const callersDef = (toolName) => ({
        description: "Approximate 'who calls X' (omp-find). Use instead of shell grep chains for who-calls-X: definition vs import vs call-site queries collapse into one ranked call. Text heuristics over call parens, imports, and member access — not LSP-accurate; confirm with read.",
        promptSnippet: "Find who calls a symbol (approximate; confirm with read)",
        approval: "read",
        promptGuidelines: [
            "ffcallers: Never chain shell greps for who-calls-X (definition vs import vs call site) — one ffcallers call ranks them all.",
            "ffcallers: Confirm shortlisted sites with read; output is approximate text heuristics, not LSP references.",
        ],
        parameters: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Symbol name, e.g. 'parseFindQuery'" },
                path: { type: "string", description: "File constraint, e.g. 'src/', '*.ts'" },
                cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd); refused for filesystem-root and home" },
                maxChars: { type: "number", description: "Max output chars; when exceeded returns per-file counts instead of rows" },
                ignoreCase: { type: "boolean", description: "Case-insensitive match" },
                limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
                cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
                exact_only: { type: "boolean", description: "Exact-only: drop possible mentions (member access `.SYM`, comments), keep import/call-paren sites" },
                depth: { type: "number", description: "Caller depth 1|2|3 (default 1) — BFS over enclosing symbols for transitive callers; rows labeled depth:N; downstream callees out of scope" },
            },
            required: ["symbol"],
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                let symbol, ignoreCase, pathFilter, exactOnly;
                let depth, limit, offset, cwd, maxChars;
                let bound;
                const cursorId = strParam(params, "cursor");
                if (cursorId) {
                    const st = cursors.get(cursorId);
                    if (!st || st.kind !== "callers")
                        return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
                    symbol = st.symbol;
                    ignoreCase = st.ignoreCase;
                    pathFilter = st.pathFilter;
                    exactOnly = st.exactOnly;
                    depth = st.depth === 2 ? 2 : st.depth === 3 ? 3 : 1;
                    limit = st.limit;
                    offset = st.nextOffset;
                    cwd = st.cwd;
                    maxChars = st.maxChars;
                    bound = { total: st.total, backend: st.backend };
                }
                else {
                    const s = strParam(params, "symbol");
                    if (!s)
                        return text(`${toolName} failed: provide a symbol`);
                    symbol = s;
                    ignoreCase = params["ignoreCase"] === true;
                    pathFilter = strParam(params, "path");
                    exactOnly = params["exact_only"] === true;
                    depth = params["depth"] === 2 ? 2 : params["depth"] === 3 ? 3 : 1;
                    limit = numParam(params, "limit") ?? GREP_PAGE;
                    offset = 0;
                    cwd = cwdParam(params);
                    maxChars = charsParam(params, "maxChars");
                }
                const res = depth > 1 ? await search.callersOf(symbol, { cwd, ignoreCase, depth }) : await search.callersOf(symbol, { cwd, ignoreCase });
                const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
                const filtered = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
                const certain = exactOnly ? filtered.filter((m) => callerCertainty(m.via ?? symbol, m.text, ignoreCase) === "exact") : filtered;
                const ranked = await Promise.all(certain.map(async (m) => ({ m, s: await safeScore(frecency, m.path) })));
                ranked.sort((a, b) => b.s - a.s); // stable: frecency first, path order otherwise
                const total = ranked.length;
                const liveBackend = typeof res.backend === "string" ? res.backend : undefined;
                statBackend = liveBackend;
                if (bound !== undefined && snapshotMismatch(bound, { total, backend: liveBackend }))
                    return staleCursor(toolName);
                const page = ranked.slice(offset, offset + limit);
                const lines = page.flatMap((r) => tagCallerRows(symbol, r.m, ignoreCase, depth > 1));
                if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
                    const byFile = new Map();
                    for (const r of ranked)
                        byFile.set(toDisplay(r.m.path), (byFile.get(toDisplay(r.m.path)) ?? 0) + 1);
                    return withDetails(`Matched ${total} approximate references to ${symbol} in ${byFile.size} files (output exceeds ${maxChars} chars). Per-file counts: ${countSummary([...byFile])}. Refine path or raise maxChars.`, { totalMatched: total, totalFiles: byFile.size, truncated: true });
                }
                if (!exactOnly && total > 0 && certain.length > 0 && !certain.some((m) => callerCertainty(m.via ?? symbol, m.text, ignoreCase) === "exact")) {
                    lines.unshift(`note: no exact call/import sites for "${symbol}"; ${total} possible mention${total === 1 ? "" : "s"} — confirm with read`, "");
                }
                const hasMore = offset + page.length < total;
                const details = { totalMatched: total, totalFiles: new Set(certain.map((m) => m.path)).size, truncated: hasMore };
                if (hasMore) {
                    const next = storeCursor({ kind: "callers", symbol, ignoreCase, pathFilter, exactOnly, depth, limit, nextOffset: offset + page.length, cwd, maxChars, total, backend: liveBackend });
                    lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`, limitNotice(limit));
                }
                return withDetails(lines.length > 0 ? lines.join("\n") : `No approximate references to ${symbol} found`, details);
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("callers", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    const structuralDef = (toolName) => ({
        description: "Approximate structural code search (omp-find). Use instead of hand-rolled AST-ish shell grep chains (piped rg/sed for call shapes, def sites, usages): ast-grep-style $VAR/$$$ patterns lower to one ranked regex call with exactly one of pattern/symbol/references. Regex lowering over live text — not AST-accurate; every row is approx: labeled with a line number — verify with read. rewrite returns a preview diff only and never writes.",
        approval: "read",
        promptSnippet: "Search code by AST shape with $VAR/$$$ patterns (approximate; preview-only rewrite)",
        promptGuidelines: [
            "ffstructural: Never hand-roll AST-ish shell grep chains (rg pipes/sed for call shapes, def sites, who-calls-X) — one ffstructural call lowers a $VAR/$$$ pattern to a ranked regex search.",
            "ffstructural: Give exactly one of pattern, symbol, references; rows are approx: labeled — confirm with read. rewrite is preview-only and never writes.",
        ],
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Structural pattern: $VAR one atom (identifier/string), $$$ zero-or-more, $A…$A same-shape backreference; kind:/inside:/has: prefixes — e.g. 'console.log($MSG)', 'kind:call', 'inside: import >> $X'" },
                symbol: { type: "string", description: "Definition lookup by name (regex-lowered, not LSP) — e.g. 'parseFindQuery'" },
                references: { type: "string", description: "Usage lookup by name via callersOf heuristics — e.g. 'parseFindQuery'" },
                language: { type: "string", description: "Language family hint for the lowering (ts, py, go, rust, java, cpp; default generic)" },
                path: { type: "string", description: "File constraint, e.g. 'src/', '*.ts'" },
                cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd); refused for filesystem-root and home" },
                ignoreCase: { type: "boolean", description: "Case-insensitive match" },
                limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
                cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
                contextBefore: { type: "number", description: "Context lines before each match (default 0, max 5)" },
                contextAfter: { type: "number", description: "Context lines after each match (default 0, max 5)" },
                maxChars: { type: "number", description: "Max output chars; when exceeded returns per-file counts instead of rows" },
                rewrite: { type: "string", description: "Rewrite template with $NAME slots filled from captures; returns a unified -/+ preview only — nothing is ever written" },
            },
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                if (typeof search.structuralGrep !== "function" || typeof search.compileStructural !== "function" || typeof search.previewRewrite !== "function")
                    return text(`${toolName} failed: structural unavailable`);
                let query, language, ignoreCase, pathFilter, rewrite;
                let limit, offset, cwd, contextBefore, contextAfter, maxChars;
                const cursorId = strParam(params, "cursor");
                let bound;
                if (cursorId) {
                    const st = cursors.get(cursorId);
                    if (!st || st.kind !== "structural")
                        return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
                    query = st.query;
                    language = st.language;
                    ignoreCase = st.ignoreCase;
                    pathFilter = st.pathFilter;
                    rewrite = st.rewrite;
                    limit = st.limit;
                    offset = st.nextOffset;
                    cwd = st.cwd;
                    contextBefore = st.contextBefore;
                    contextAfter = st.contextAfter;
                    maxChars = st.maxChars;
                    bound = { total: st.total, backend: st.backend };
                }
                else {
                    const p = strParam(params, "pattern");
                    const s = strParam(params, "symbol");
                    const r = strParam(params, "references");
                    const given = [p, s, r].filter((v) => v !== undefined && v !== "");
                    if (given.length !== 1)
                        return text(`${toolName} failed: provide exactly one of pattern, symbol, references`);
                    query = s !== undefined && s !== "" ? `symbol:${s}` : r !== undefined && r !== "" ? `references:${r}` : p;
                    language = strParam(params, "language");
                    ignoreCase = params["ignoreCase"] === true;
                    pathFilter = strParam(params, "path");
                    rewrite = strParam(params, "rewrite");
                    limit = numParam(params, "limit") ?? GREP_PAGE;
                    offset = 0;
                    cwd = cwdParam(params);
                    contextBefore = ctxParam(params, "contextBefore");
                    contextAfter = ctxParam(params, "contextAfter");
                    maxChars = charsParam(params, "maxChars");
                }
                // Full-set fetch first (path filter + ranking over everything, like ffgrep);
                // context attaches pre-slice so filtered-out files never steal the window.
                const res = await search.structuralGrep(query, { cwd, ignoreCase, language, contextBefore, contextAfter });
                const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
                const filtered = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
                const ranked = await Promise.all(filtered.map(async (m) => ({ m, s: await safeScore(frecency, m.path) })));
                ranked.sort((a, b) => b.s - a.s); // stable: frecency first, scan order otherwise
                const total = ranked.length;
                const liveBackend = typeof res.backend === "string" ? res.backend : undefined;
                statBackend = liveBackend;
                if (bound !== undefined && snapshotMismatch(bound, { total, backend: liveBackend }))
                    return staleCursor(toolName);
                const page = ranked.slice(offset, offset + limit);
                let lines;
                if (rewrite !== undefined) {
                    const compiled = search.compileStructural(query, { language });
                    if (compiled.mode === "references")
                        return text(`${toolName} failed: rewrite preview needs pattern: or symbol:, not references:`);
                    lines = search.previewRewrite(compiled, rewrite, page.map((r) => r.m)).flatMap((b) => b.split("\n"));
                    if (lines.length > 0)
                        lines.push("", "[preview only — nothing was written]");
                }
                else {
                    lines = page.flatMap((r) => renderGrepRows(r.m).map((row) => `approx: ${row}`));
                }
                const backend = typeof res.backend === "string" ? res.backend : undefined;
                if (total > 0 && overBudget(lines.join("\n"), maxChars)) {
                    const byFile = new Map();
                    for (const r of ranked)
                        byFile.set(toDisplay(r.m.path), (byFile.get(toDisplay(r.m.path)) ?? 0) + 1);
                    return withDetails(`Matched ${total} approximate structural hits in ${byFile.size} files (output exceeds ${maxChars} chars). Per-file counts: ${countSummary([...byFile])}. Refine path/pattern or raise maxChars.`, { totalMatched: total, totalFiles: byFile.size, truncated: true });
                }
                if (lines.length === 0) {
                    return text(backend !== undefined ? `0 structural matches for "${query}" (${backend})` : `0 structural matches for "${query}"`);
                }
                const hasMore = offset + page.length < total;
                const details = { totalMatched: total, totalFiles: new Set(filtered.map((m) => m.path)).size, truncated: hasMore };
                if (hasMore) {
                    const next = storeCursor({ kind: "structural", query, language, ignoreCase, pathFilter, rewrite, limit, nextOffset: offset + page.length, cwd, contextBefore, contextAfter, maxChars, total, backend: liveBackend });
                    lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`, limitNotice(limit));
                }
                return withDetails(lines.join("\n"), details);
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("structural", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    const mapDef = (toolName) => ({
        description: "Fitted repo overview (omp-find). Use instead of reading directory trees or shell ls -R to learn a repo: per-file symbol outlines ranked by frecency, git recency and import-centrality, cut to fit maxChars. Fresh scan every call — never stale. Rows are approximate outlines; verify with ffoutline/read.",
        promptSnippet: "Map the repo: ranked file overview fitted to a budget",
        approval: "read",
        promptGuidelines: [
            "ffmap: Map an unfamiliar repo before exploring — one fitted overview beats a shell ls -R plus N file reads.",
            "ffmap: Follow the map with ffoutline <file> for shape, ffgrep for content, read for the range.",
        ],
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Dir-scope filter, e.g. 'src/' — map only this subtree" },
                cwd: { type: "string", description: "Scan root: absolute directory to map (default: session cwd); refused for filesystem-root and home" },
                maxChars: { type: "number", description: "Overview budget in chars (default 8000) — the file cutoff is fitted to it" },
            },
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                if (typeof search.rankMap !== "function")
                    return text(`${toolName} failed: map unavailable`);
                const cwd = cwdParam(params);
                const scope = strParam(params, "path");
                const budget = charsParam(params, "maxChars") ?? 8000;
                const res = await search.rankMap({ cwd });
                statBackend = res.backend;
                const pool = scope ? applyPathFilter(res.files.map((f) => f.path), scope, search.globToRegExp) : null;
                const files = pool === null ? res.files : res.files.filter((f) => pool.includes(f.path));
                const ranked = await Promise.all(files.map(async (f) => ({ f, s: (await safeScore(frecency, f.path)) + (f.modified ? 1 : 0) + Math.log1p(f.inDegree) })));
                ranked.sort((a, b) => b.s - a.s); // stable: frecency + git recency + centrality, path order otherwise
                const shown = ranked.filter((r) => r.f.symbols.length > 0);
                const blocks = shown.map((r) => [`${toDisplay(r.f.path)}:`, ...r.f.symbols.map((s) => `  ${s.kind} ${s.name}`)]);
                // Binary-search the file cutoff to fit the budget (prefix sums over block sizes).
                const sizes = [];
                let acc = 0;
                for (const b of blocks) {
                    acc += b.join("\n").length + 1;
                    sizes.push(acc);
                }
                let lo = 0, hi = blocks.length;
                while (lo < hi) {
                    const mid = Math.floor((lo + hi + 1) / 2);
                    if (mid === 0 || sizes[mid - 1] - 1 <= budget)
                        lo = mid;
                    else
                        hi = mid - 1;
                }
                const lines = blocks.slice(0, lo).flat();
                const omitted = shown.length - lo;
                if (lines.length === 0) {
                    return withDetails(shown.length === 0 ? `No symbols found${scope ? ` under ${scope}` : ""} (${res.scanned} files scanned, ${res.backend})` : `Overview exceeds ${budget} chars with zero files fitting; raise maxChars`, { totalMatched: shown.length, totalFiles: res.scanned, truncated: omitted > 0 });
                }
                if (omitted > 0)
                    lines.push("", `... (${omitted} files omitted; raise maxChars or ffoutline <file>)`);
                return withDetails(lines.join("\n"), { totalMatched: shown.length, totalFiles: res.scanned, truncated: omitted > 0 });
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("map", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    const capsuleDef = (toolName) => ({
        description: "Fused symbol dossier (omp-find). Use instead of N round-trips (outline file, grep symbol, grep imports, list callers) to learn one symbol: signature + doc comment + top callers + import sites + a data-driven next step in one call. All rows are approximate text heuristics with line numbers — confirm with read.",
        promptSnippet: "Dossier on one symbol: def, doc, callers, imports, next step",
        approval: "read",
        promptGuidelines: [
            "ffcapsule: Learn one symbol with a single ffcapsule call instead of chaining ffoutline, ffgrep and ffcallers by hand.",
            "ffcapsule: Follow the Guidance: footer — it names the cheapest next call from the data.",
        ],
        parameters: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Symbol name, e.g. 'parseFindQuery'" },
                path: { type: "string", description: "File constraint, e.g. 'src/', '*.ts'" },
                cwd: { type: "string", description: "Scan root: absolute directory to search (default: session cwd); refused for filesystem-root and home" },
                ignoreCase: { type: "boolean", description: "Case-insensitive match" },
                limit: { type: "number", description: "Max callers/imports shown each (default 10, max 50)" },
                maxChars: { type: "number", description: "Max output chars; caller/import rows shrink to fit, noted when they do" },
            },
            required: ["symbol"],
            additionalProperties: false,
        },
        execute: async (_toolCallId, params) => {
            const t0 = Date.now();
            let statBackend = undefined;
            let statTimeout = false;
            try {
                if (typeof search.capsuleOf !== "function")
                    return text(`${toolName} failed: capsule unavailable`);
                const s = strParam(params, "symbol");
                if (!s)
                    return text(`${toolName} failed: provide a symbol`);
                const cwd = cwdParam(params);
                const ignoreCase = params["ignoreCase"] === true;
                const pathFilter = strParam(params, "path");
                const limit = numParam(params, "limit") ?? 10;
                const maxChars = charsParam(params, "maxChars");
                const res = await search.capsuleOf(s, { cwd, ignoreCase, pathFilter, limit });
                statBackend = res.backend;
                const disp = (p) => toDisplay(p);
                const lines = [];
                if (res.defFile !== undefined)
                    lines.push(`symbol ${s} — ${res.defKind} in ${disp(res.defFile)}:${res.defLine}`);
                else
                    lines.push(`symbol ${s} — no definition found (approximate scan)`);
                lines.push(...(res.doc.length > 0 ? ["doc:", ...res.doc.map((d) => `  ${d}`)] : ["(no doc comment)"]));
                let callRows = res.callers.map((m) => `${disp(m.path)}:${m.line}:${m.col}: ${m.text}`);
                let impRows = res.imports.map((m) => `${disp(m.path)}:${m.line}:${m.col}: ${m.text}`);
                let shrunk = false;
                const topCaller = res.callers[0];
                const guidance = topCaller !== undefined
                    ? `Guidance: ffoutline ${disp(topCaller.path)} for the top caller's shape`
                    : res.defFile !== undefined
                        ? `Guidance: read ${disp(res.defFile)} around line ${res.defLine}`
                        : `Guidance: ffgrep ${s} for raw matches across the tree`;
                if (maxChars !== undefined) {
                    const fixed = [...lines, `callers (${res.callers.length}):`, `imports (${res.imports.length}):`, guidance].join("\n").length + 2;
                    let room = maxChars - fixed;
                    const take = (rows) => {
                        const out = [];
                        for (const r of rows) {
                            if (out.length > 0 && room - (r.length + 1) < 0) {
                                shrunk = true;
                                break;
                            }
                            out.push(r);
                            room -= r.length + 1;
                        }
                        if (out.length < rows.length)
                            shrunk = true;
                        return out;
                    };
                    callRows = take(callRows);
                    impRows = take(impRows);
                }
                lines.push(`callers (${res.callers.length}):`, ...(callRows.length > 0 ? callRows : ["(none found)"]));
                lines.push(`imports (${res.imports.length}):`, ...(impRows.length > 0 ? impRows : ["(none found)"]));
                if (shrunk)
                    lines.push(`(rows shrunk to fit ${maxChars} chars; raise maxChars)`);
                lines.push(guidance);
                return withDetails(lines.join("\n"), { totalMatched: res.found ? 1 : 0, totalFiles: res.filesInvolved, truncated: shrunk });
            }
            catch (err) {
                if (/timed out/i.test(errMsg(err)))
                    statTimeout = true;
                return text(`${toolName} failed: ${errMsg(err)}`);
            }
            finally {
                recordCall("capsule", Date.now() - t0, statBackend, statTimeout);
            }
        },
    });
    register("fffind", "Find files", findDef("fffind"));
    register("ffgrep", "Grep content", grepDef("ffgrep"));
    if (typeof search.outlineFile === "function") {
        register("ffoutline", "Outline file", outlineDef("ffoutline"));
        try {
            register("outline", "Outline file", outlineDef("outline"));
        }
        catch { /* alias where the host allows */ }
    }
    if (typeof search.callersOf === "function") {
        register("ffcallers", "Find callers", callersDef("ffcallers"));
    }
    if (typeof search.structuralGrep === "function") {
        register("ffstructural", "Structural search", structuralDef("ffstructural"));
        try {
            register("structural", "Structural search", structuralDef("structural"));
        }
        catch { /* alias where the host allows */ }
    }
    if (typeof search.rankMap === "function") {
        register("ffmap", "Repo map", mapDef("ffmap"));
        try {
            register("map", "Repo map", mapDef("map"));
        }
        catch { /* alias where the host allows */ }
    }
    if (typeof search.capsuleOf === "function") {
        register("ffcapsule", "Symbol dossier", capsuleDef("ffcapsule"));
        try {
            register("capsule", "Symbol dossier", capsuleDef("capsule"));
        }
        catch { /* alias where the host allows */ }
    }
    if (tier === "full") {
        // Reserved: full adds nothing today — future tools register here so the
        // default core surface stays lean.
    }
    if (isOverride) {
        register("find", "Find files", findDef("find"));
        register("grep", "Grep content", grepDef("grep"));
    }
}
