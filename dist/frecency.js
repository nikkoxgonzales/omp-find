/** omp-find frecency: per-project open counts with time decay. Node builtins only. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
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
/** Store key for a path both `recordOpen` and `score` see. Canonicalizes so the
 * many spellings of one file collapse to a single entry:
 * - selectors are stripped (`:N`, `:N-M`, `:N+M`, `:raw`, `:img`, `:conflicts`,
 *   `?q=…`, `#tag`) — a `read` of `x.ts:10-20` counts as opening `x.ts`;
 * - non-file URIs (`xd://`, `artifact://`, `agent://`, `local://`, `skill://`,
 *   `rule://`, `history://`, `issue://`, `pr://`, `omp://`, `mcp://`, `ssh://`,
 *   `http(s)://`, …) return NON_FILE — `recordOpen` skips them, `score` is 0;
 * - `file://` URIs unwrap to their filesystem path;
 * - separators normalize to `/` and paths inside the project store
 *   cwd-relative, so `read src/x.ts`, `read C:/repo/src/x.ts`, and the relative
 *   paths fffind emits all hit the same key. */
const NON_FILE = "\0";
/** Resolve `p` to its store key plus the absolute filesystem path it names
 * (null for non-file URIs). `abs` is what recordOpen stats — the key alone
 * can't be statted (it's relative or already canonicalized). */
function keyOf(p) {
    // `?q=`/`#tag` selectors first — a URI's own query/fragment goes with the URI.
    let s = p.replace(/[?#].*$/, "");
    // `scheme:`/`scheme://` that isn't a one-letter drive (`C:`) isn't a path.
    const scheme = s.match(/^[A-Za-z][A-Za-z0-9+.-]*:/);
    if (scheme !== null && scheme[0].length > 2) {
        if (scheme[0].toLowerCase() !== "file:")
            return { key: NON_FILE, abs: null };
        try {
            s = fileURLToPath(s);
        }
        catch {
            return { key: NON_FILE, abs: null };
        }
    }
    s = s.replace(/\\/g, "/");
    // Trailing `:selector` segments — a `:` past index 1 (the `X:` drive prefix
    // survives) whose tail is only selector characters (digits, letters, `+`,
    // `,`, `-`). Loops for stacked selectors like `:raw:2-4`.
    for (;;) {
        const i = s.lastIndexOf(":");
        if (i <= 1 || !/^[A-Za-z0-9+,-]*$/.test(s.slice(i + 1)))
            break;
        s = s.slice(0, i);
    }
    if (s === "")
        return { key: NON_FILE, abs: null };
    const abs = path.resolve(s);
    const rel = path.relative(process.cwd(), abs);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    return { key: (inside ? rel : abs).replace(/\\/g, "/"), abs };
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
        // Tombstone: a clear() stamps `clearedAt`; merge-on-save drops entries
        // older than it so a stale in-memory cache can't resurrect cleared keys.
        const clearedAt = Number(parsed?.clearedAt);
        return { entries, ...(Number.isFinite(clearedAt) ? { clearedAt } : {}) };
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
 * (last-writer-wins → merge-on-save). The `clearedAt` tombstone is the one
 * exception to monotonicity: entries last-touched before the newest clear() are
 * dropped on both sides, so a stale cache can't resurrect cleared keys.
 * Mutating `store` also freshens the shared cache.
 *
 * Cross-process exclusion: a mkdir lockfile (`<file>.lock`) wraps the whole
 * readDisk→merge→copyFile critical section. Without it a concurrent save whose
 * readDisk predates our write but lands after clobbers our bump entirely —
 * and a readDisk that catches copyFile mid-flight parses a truncated file as
 * fresh(), dropping keys wholesale. mkdir is atomic on every platform; a lock
 * dir older than LOCK_STALE_MS is presumed abandoned (crashed holder) and
 * stolen. If the lock can't be acquired within LOCK_TIMEOUT_MS the save
 * proceeds unlocked — never-throws beats perfect exclusion. Remaining limit:
 * same-key bumps merge as max, not sum, so counts can under-count. */
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_BACKOFF_MS = 10;
/** Try to take the lock dir once. "acquired" | "held" (live holder) | "giveup"
 * (path exists but isn't a dir, or parent missing — locking impossible). */
async function tryLock(lockDir) {
    try {
        await fs.promises.mkdir(lockDir);
        return "acquired";
    }
    catch (err) {
        if (err.code !== "EEXIST")
            return "giveup";
    }
    try {
        const st = await fs.promises.stat(lockDir);
        if (!st.isDirectory())
            return "giveup"; // a file sits at the lock path
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Stale lock: the holder crashed mid-save. Steal it; a live holder that
            // loses this race still wrote a consistent file (copyFile is last).
            await fs.promises.rm(lockDir, { recursive: true, force: true });
            return "held"; // retry mkdir next pass
        }
    }
    catch { /* stat raced a release — retry mkdir */ }
    return "held";
}
async function acquireLock(lockDir) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        const r = await tryLock(lockDir);
        if (r === "acquired")
            return true;
        if (r === "giveup" || Date.now() >= deadline)
            return false;
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, LOCK_BACKOFF_MS);
        await promise;
    }
}
async function save(store, file, merge = false) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const lockDir = `${file}.lock`;
    const locked = await acquireLock(lockDir);
    if (!locked)
        return;
    try {
        if (merge) {
            // Re-read under the lock: anything committed while we waited is folded in.
            const disk = await readDisk(file);
            // Tombstone wins over entries: anything last-touched before the newest
            // clear() is dead, whether it lives in this store or on disk.
            const tombstone = Math.max(store.clearedAt ?? 0, disk.clearedAt ?? 0);
            if (tombstone > 0)
                store.clearedAt = tombstone;
            // A tombstone in the future means the clock regressed (or was patched) —
            // timestamp ordering is meaningless then, so the drop rule stays inert
            // rather than eating every entry written under the skewed clock.
            const drop = tombstone > 0 && tombstone <= Date.now();
            if (drop) {
                for (const [k, e] of Object.entries(store.entries)) {
                    if (e.last < tombstone)
                        delete store.entries[k];
                }
            }
            for (const [k, e] of Object.entries(disk.entries)) {
                if (drop && e.last < tombstone)
                    continue;
                const cur = store.entries[k];
                store.entries[k] = cur === undefined ? e : { count: Math.max(cur.count, e.count), last: Math.max(cur.last, e.last) };
            }
        }
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
    finally {
        if (locked)
            await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** In-process write queue: parallel recordOpen calls otherwise race load→bump→save
 * (each loads a fresh store before the other saves) and all but one bump is lost.
 * Chained so every write sees the previous write's store. Cross-process writes
 * serialize on a mkdir lockfile around readDisk→merge→copyFile (see save), so a
 * contended key's bumps merge instead of clobbering each other. */
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
            const { key, abs } = keyOf(p);
            if (key === NON_FILE || abs === null)
                return; // non-file URI — don't write noise
            // Only real files count as opens: a directory listing (`read src/`) or a
            // path that doesn't exist must not pollute the ranking.
            const st = await fs.promises.stat(abs).catch(() => null);
            if (st === null || !st.isFile())
                return;
            const store = await load(file);
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
        const { key } = keyOf(p);
        if (key === NON_FILE)
            return 0;
        const e = store.entries[key];
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
            next.clearedAt = Date.now();
            cache = next;
            await save(next, storePath());
        }
        catch { /* best-effort */ }
    });
}
