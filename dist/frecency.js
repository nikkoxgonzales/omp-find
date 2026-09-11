/** omp-find frecency: per-project open counts with time decay. Node builtins only. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
// Null-prototype entries map: `store.entries["__proto__"] = {...}` on a plain
// object invokes the proto setter and silently drops the key — a path literally
// named `__proto__` would never persist or score.
function fresh() { return { entries: Object.create(null) }; }
let cache = null;
let cacheFile = null;
function projectHash(root) {
    return crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
}
/** Single per-project JSON: %LOCALAPPDATA%/omp-find or ~/.omp/var/omp-find, keyed by cwd hash. */
export function storePath(root = process.cwd()) {
    const hash = projectHash(path.resolve(root));
    if (process.platform === "win32") {
        const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
        return path.join(base, "omp-find", hash, "frecency.json");
    }
    return path.join(os.homedir(), ".omp", "var", "omp-find", hash, "frecency.json");
}
function keyOf(p) {
    return p.replace(/\\/g, "/");
}
/** Read + sanitize the store file straight from disk (no cache). Never throws:
 * missing/corrupt files return a fresh store. */
async function readDisk(file) {
    try {
        const raw = await fs.promises.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        const entries = Object.create(null);
        if (parsed && typeof parsed.entries === "object" && parsed.entries !== null) {
            // Sanitize persisted entries: a hand-edited/corrupt store can carry
            // wrong-typed count/last (e.g. strings) that would turn score() into NaN
            // and poison sort comparators. Coerce via Number(); drop non-finite or
            // negative-count rows.
            for (const [k, v] of Object.entries(parsed.entries)) {
                if (typeof v !== "object" || v === null)
                    continue;
                const count = Number(v.count);
                const last = Number(v.last);
                if (!Number.isFinite(count) || !Number.isFinite(last) || count < 0)
                    continue;
                entries[k] = { count, last };
            }
        }
        return { entries };
    }
    catch {
        return fresh();
    }
}
async function load(file) {
    if (cache !== null && cacheFile === file)
        return cache;
    cache = await readDisk(file);
    cacheFile = file;
    return cache;
}
/** Atomic persist: sidecar write + fsync, then copyFile over live (never rename-over-live on Windows).
 * With `merge` the live file is re-read first and folded in per key — max count,
 * max last — so a concurrent process's batch survives instead of being clobbered
 * (last-writer-wins → merge-on-save). Monotonic, so the merge can only add or
 * raise entries; mutating `store` also freshens the shared cache. Remaining
 * limit: no lock — simultaneous same-key writes keep the max, not the sum, so
 * counts can under-count across processes. */
async function save(store, file, merge = false) {
    if (merge) {
        const disk = await readDisk(file);
        for (const [k, e] of Object.entries(disk.entries)) {
            const cur = store.entries[k];
            store.entries[k] = cur === undefined ? e : { count: Math.max(cur.count, e.count), last: Math.max(cur.last, e.last) };
        }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    const fh = await fs.promises.open(tmp, "w");
    try {
        await fh.writeFile(JSON.stringify(store));
        await fh.sync();
    }
    finally {
        await fh.close();
    }
    await fs.promises.copyFile(tmp, file);
    await fs.promises.rm(tmp, { force: true });
}
/** In-process write queue: parallel recordOpen calls otherwise race load→bump→save
 * (each loads a fresh store before the other saves) and all but one bump is lost.
 * Chained so every write sees the previous write's store. Cross-process writes
 * merge per key on save (max count, max last) instead of last-writer-wins; no
 * lock, so simultaneous same-key bumps can still under-count — documented in
 * README + docs/extension.md. */
let writeQueue = Promise.resolve();
function enqueueWrite(work) {
    const run = writeQueue.then(work, work);
    writeQueue = run.then(undefined, () => undefined);
    return run;
}
/** Append-on-open: bump count + recency for a path. Never throws. */
export async function recordOpen(p) {
    return enqueueWrite(async () => {
        try {
            const file = storePath();
            const store = await load(file);
            const key = keyOf(p);
            const prev = store.entries[key];
            store.entries[key] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
            await save(store, file, true);
        }
        catch { /* frecency tracking never breaks a session */ }
    });
}
/** Decay-on-read: count × 0.5^(age/half-life). Unknown paths score 0. Never throws. */
export async function score(p) {
    try {
        const store = await load(storePath());
        const e = store.entries[keyOf(p)];
        if (!e)
            return 0;
        const s = e.count * 0.5 ** (Math.max(0, Date.now() - e.last) / HALF_LIFE_MS);
        return Number.isFinite(s) ? s : 0;
    }
    catch {
        return 0;
    }
}
/** One-line status for `/find-health` (string form, read synchronously). */
export function status() {
    try {
        const file = storePath();
        const raw = fs.readFileSync(file, "utf8");
        const n = Object.keys(JSON.parse(raw).entries ?? {}).length;
        return `${n} paths tracked (${file})`;
    }
    catch {
        return `empty (${storePath()})`;
    }
}
/** Drop the persisted store + memory cache (for `/find-rescan`). Never throws. */
export async function clear() {
    return enqueueWrite(async () => {
        try {
            const next = fresh();
            cache = next;
            await save(next, storePath());
        }
        catch { /* best-effort */ }
    });
}
