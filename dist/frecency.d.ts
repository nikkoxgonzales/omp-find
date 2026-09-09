/** Single per-project JSON: %LOCALAPPDATA%/omp-find or ~/.omp/var/omp-find, keyed by cwd hash. */
export declare function storePath(root?: string): string;
/** Append-on-open: bump count + recency for a path. Never throws. */
export declare function recordOpen(p: string): Promise<void>;
/** Decay-on-read: count × 0.5^(age/half-life). Unknown paths score 0. Never throws. */
export declare function score(p: string): Promise<number>;
/** One-line status for `/find-health` (string form, read synchronously). */
export declare function status(): string;
/** Drop the persisted store + memory cache (for `/find-rescan`). Never throws. */
export declare function clear(): Promise<void>;
