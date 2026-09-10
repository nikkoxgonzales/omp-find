/** omp-find frecency: per-project open counts with time decay. Node builtins only. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
function fresh() { return { entries: {} }; }
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
async function load(file) {
    if (cache !== null && cacheFile === file)
        return cache;
    try {
        const raw = await fs.promises.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed.entries === "object" && parsed.entries !== null ? { entries: parsed.entries } : fresh();
    }
    catch {
        cache = fresh();
    }
    cacheFile = file;
    return cache;
}
/** Atomic persist: sidecar write + fsync, then copyFile over live (never rename-over-live on Windows). */
async function save(store, file) {
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
/** Append-on-open: bump count + recency for a path. Never throws. */
export async function recordOpen(p) {
    try {
        const file = storePath();
        const store = await load(file);
        const key = keyOf(p);
        const prev = store.entries[key];
        store.entries[key] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
        await save(store, file);
    }
    catch { /* frecency tracking never breaks a session */ }
}
/** Decay-on-read: count × 0.5^(age/half-life). Unknown paths score 0. Never throws. */
export async function score(p) {
    try {
        const store = await load(storePath());
        const e = store.entries[keyOf(p)];
        if (!e)
            return 0;
        return e.count * 0.5 ** (Math.max(0, Date.now() - e.last) / HALF_LIFE_MS);
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
    try {
        const next = fresh();
        cache = next;
        await save(next, storePath());
    }
    catch { /* best-effort */ }
}
