/** omp-find frecency: per-project open counts with time decay. Node builtins only. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;

interface Entry { count: number; last: number }
interface Store { entries: Record<string, Entry>; clearedAt?: number }

// Null-prototype entries map: `store.entries["__proto__"] = {...}` on a plain
// object invokes the proto setter and silently drops the key — a path literally
// named `__proto__` would never persist or score.
function fresh(): Store { return { entries: Object.create(null) as Record<string, Entry> }; }
let cache: Store | null = null;
let cacheFile: string | null = null;

function projectHash(root: string): string {
  return crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
}

/** Single per-project JSON: %LOCALAPPDATA%/omp-find or ~/.omp/var/omp-find, keyed by cwd hash. */
export function storePath(root: string = process.cwd()): string {
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
function keyOf(p: string): string {
  // `?q=`/`#tag` selectors first — a URI's own query/fragment goes with the URI.
  let s = p.replace(/[?#].*$/, "");
  // `scheme:`/`scheme://` that isn't a one-letter drive (`C:`) isn't a path.
  const scheme = s.match(/^[A-Za-z][A-Za-z0-9+.-]*:/);
  if (scheme !== null && scheme[0].length > 2) {
    if (scheme[0].toLowerCase() !== "file:") return NON_FILE;
    try { s = fileURLToPath(s); } catch { return NON_FILE; }
  }
  s = s.replace(/\\/g, "/");
  // Trailing `:selector` segments — a `:` past index 1 (the `X:` drive prefix
  // survives) whose tail is only selector characters (digits, letters, `+`,
  // `,`, `-`). Loops for stacked selectors like `:raw:2-4`.
  for (;;) {
    const i = s.lastIndexOf(":");
    if (i <= 1 || !/^[A-Za-z0-9+,-]*$/.test(s.slice(i + 1))) break;
    s = s.slice(0, i);
  }
  if (s === "") return NON_FILE;
  const abs = path.resolve(s);
  const rel = path.relative(process.cwd(), abs);
  const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  return (inside ? rel : abs).replace(/\\/g, "/");
}

/** Read + sanitize the store file straight from disk (no cache). Never throws:
 * missing/corrupt files return a fresh store. */
async function readDisk(file: string): Promise<Store> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    const entries: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
    if (parsed && typeof parsed.entries === "object" && parsed.entries !== null) {
      // Sanitize persisted entries: a hand-edited/corrupt store can carry
      // wrong-typed count/last (e.g. strings) that would turn score() into NaN
      // and poison sort comparators. Coerce via Number(); drop non-finite or
      // negative-count rows.
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof v !== "object" || v === null) continue;
        const count = Number((v as Partial<Entry>).count);
        const last = Number((v as Partial<Entry>).last);
        if (!Number.isFinite(count) || !Number.isFinite(last) || count < 0) continue;
        entries[k] = { count, last };
      }
    }
    // Tombstone: a clear() stamps `clearedAt`; merge-on-save drops entries
    // older than it so a stale in-memory cache can't resurrect cleared keys.
    const clearedAt = Number(parsed?.clearedAt);
    return { entries, ...(Number.isFinite(clearedAt) ? { clearedAt } : {}) };
  } catch { return fresh(); }
}

async function load(file: string): Promise<Store> {
  if (cache !== null && cacheFile === file) return cache;
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
 * Mutating `store` also freshens the shared cache. Remaining limit: no lock —
 * simultaneous same-key writes keep the max, not the sum, so counts can
 * under-count across processes. */
async function save(store: Store, file: string, merge = false): Promise<void> {
  if (merge) {
    const disk = await readDisk(file);
    // Tombstone wins over entries: anything last-touched before the newest
    // clear() is dead, whether it lives in this store or on disk.
    const tombstone = Math.max(store.clearedAt ?? 0, disk.clearedAt ?? 0);
    if (tombstone > 0) store.clearedAt = tombstone;
    // A tombstone in the future means the clock regressed (or was patched) —
    // timestamp ordering is meaningless then, so the drop rule stays inert
    // rather than eating every entry written under the skewed clock.
    const drop = tombstone > 0 && tombstone <= Date.now();
    if (drop) {
      for (const [k, e] of Object.entries(store.entries)) {
        if (e.last < tombstone) delete store.entries[k];
      }
    }
    for (const [k, e] of Object.entries(disk.entries)) {
      if (drop && e.last < tombstone) continue;
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
  } finally {
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
let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(work: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(work, work);
  writeQueue = run.then(undefined, () => undefined);
  return run;
}

/** Append-on-open: bump count + recency for a path. Never throws. */
export async function recordOpen(p: string): Promise<void> {
  return enqueueWrite(async () => {
    try {
      const file = storePath();
      const store = await load(file);
      const key = keyOf(p);
      if (key === NON_FILE) return; // non-file URI — don't write noise
      const prev = store.entries[key];
      store.entries[key] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
      await save(store, file, true);
    } catch { /* frecency tracking never breaks a session */ }
  });
}

/** Decay-on-read: count × 0.5^(age/half-life). Unknown paths score 0. Never throws. */
export async function score(p: string): Promise<number> {
  try {
    const store = await load(storePath());
    const key = keyOf(p);
    if (key === NON_FILE) return 0;
    const e = store.entries[key];
    if (!e) return 0;
    const s = e.count * 0.5 ** (Math.max(0, Date.now() - e.last) / HALF_LIFE_MS);
    return Number.isFinite(s) ? s : 0;
  } catch { return 0; }
}

/** One-line status for `/find-health` (string form, read synchronously). */
export function status(): string {
  try {
    const file = storePath();
    const raw = fs.readFileSync(file, "utf8");
    const n = Object.keys((JSON.parse(raw) as Partial<Store>).entries ?? {}).length;
    return `${n} paths tracked (${file})`;
  } catch {
    return `empty (${storePath()})`;
  }
}

/** Drop the persisted store + memory cache (for `/find-rescan`). Never throws. */
export async function clear(): Promise<void> {
  return enqueueWrite(async () => {
    try {
      const next = fresh();
      next.clearedAt = Date.now();
      cache = next;
      await save(next, storePath());
    } catch { /* best-effort */ }
  });
}
