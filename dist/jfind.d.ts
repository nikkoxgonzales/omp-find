import type { Judge, JudgeRequest } from "./judge.js";
/** Requests in flight per dispatched phase. */
export declare const PARALLEL: number;
/** Files per filename-ranking request. */
export declare const NAME_BATCH: number;
/** Lexically ranked files that receive a filename judgment. */
export declare const CANDIDATES: number;
/** Files whose content is read and sketched. */
export declare const FILES: number;
/** Windows kept per read file. */
export declare const WINDOWS: number;
/** Bytes per window, tags included. */
export declare const WINDOW_BYTES: number;
/** Bytes per sketch card. */
export declare const SKETCH_BYTES: number;
/** Complete passages verified across all files. */
export declare const FULL_LIMIT: number;
/** Sketch probability below which a passage is not verified. */
export declare const CUTOFF: number;
/** Verified-passage probability at or above which a file is a hit. */
export declare const THRESHOLD: number;
/** Bytes of a file read for windowing. */
export declare const READ_LIMIT: number;
/** Sketch state budget per request; sized so cards stay well inside the judge's context. */
export declare const SKETCH_STATE_BYTES: number;
/** Hard cap on sketch cards per request. */
export declare const SKETCH_CARDS_MAX: number;
/** Passage state budget per verification request, tags included. */
export declare const VERIFY_STATE_BYTES: number;
/** Wall-clock budget for the lexical grep pass. */
export declare const SCAN_TIMEOUT_MS: number;
/** Distinct failure messages retained for the report. */
export declare const FAILURES_KEPT: number;
/** Split like Rust `str::lines`: `\n`-separated, trailing `\r` stripped, no phantom last line after a final newline. */
export declare function lines(text: string): string[];
/** Longest prefix of `text` that fits in `bytes` UTF-8 bytes without splitting a code point. */
export declare function clipBytes(text: string, bytes: number): string;
/** First `count` code points of `text`. */
export declare function takeChars(text: string, count: number): string;
/** Non-overlapping occurrences of `needle` in `haystack`; 0 for an empty needle. */
export declare function countOccurrences(haystack: string, needle: string): number;
export interface ReadText {
    text: string;
    /** Bytes actually used (after trimming to a line boundary). */
    bytes: number;
    truncated: boolean;
}
/** Why a file was not read: not text, nothing in it, or the filesystem said no. */
export type ReadTextFailure = "binary" | "empty" | "io";
export declare class ReadTextError extends Error {
    readonly kind: ReadTextFailure;
    constructor(kind: ReadTextFailure, message: string);
}
/**
 * Read up to `maxBytes` of a text file. Rejects binaries (NUL in the first 8 KB)
 * and blank files; trims a truncated read back to the last full line.
 * @throws {ReadTextError} `binary`, `empty`, or `io`.
 */
export declare function readText(filePath: string, maxBytes: number): Promise<ReadText>;
/** Keywords for the grep prior: quoted phrases whole, then tokens minus stopwords. */
export declare function keywordsFromQuery(query: string): string[];
/** {@link keywordsFromQuery} plus the caller's extra keywords, lowercased and deduplicated. */
export declare function keywords(query: string, extra: readonly string[]): string[];
export interface GrepIndex {
    /** Lowercased, non-empty keywords; `perFileKw` vectors align with this. */
    keywords: string[];
    /** rel file path → per-keyword occurrence counts over matching lines. */
    perFileKw: Map<string, number[]>;
    /** Files the scan offered for ranking, including unmatched ones. */
    filesScanned: number;
}
/** Regex-escape a literal keyword for the grep alternation. */
export declare function escapeRegex(keyword: string): string;
/**
 * Count keyword occurrences (case-insensitive, any keyword) in every file under
 * `root`. Only lines containing a keyword are inspected, so counts are per
 * matching line rather than per file byte. `--vimgrep` emits one row per match,
 * so rows are deduplicated per (file, line) before counting — one line, one
 * count per keyword, exactly like the native Content-mode source.
 */
export declare function grepIndex(root: string, rawKeywords: readonly string[], options: {
    scope?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<GrepIndex>;
/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export declare function idf(index: GrepIndex): number[];
/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export declare function fileScore(counts: readonly number[], weights: readonly number[], rel: string, keywords: readonly string[]): number;
/** A contiguous run of tagged source lines (`L<n>| text`), 1-based inclusive. */
export interface Passage {
    start: number;
    end: number;
    text: string;
    /** Lexical score used for window selection and tie-breaking. */
    score: number;
}
/** A judged line range with its yes-probability and a one-line preview. */
export interface HeatRange {
    start: number;
    end: number;
    p: number;
    snippet: string;
}
/**
 * Contiguous whole-line windows bounded by bytes, including the final line. A
 * single oversized line is clipped at a code-point boundary and keeps its real
 * line id.
 */
export declare function windows(text: string, bytes: number, keywords: readonly string[], weights: readonly number[]): Passage[];
/**
 * Keep the best lexical windows and, when no words match, distribute the
 * budget evenly through the file instead of always falling back to its
 * opening bytes. Returned in file order.
 */
export declare function selectWindows(passages: Passage[], limit: number): Passage[];
/** Passage text with the generated `L<n>| ` tags stripped; the caller owns the line coordinates. */
export declare function plainContent(passage: Passage): string;
/**
 * A budgeted map of verbatim source lines, not an invented summary. Lines are
 * ranked by keyword weight (plus a nudge for call-like lines) so deep
 * implementation text can outrank headers, then emitted in file order.
 */
export declare function sketch(passage: Passage, keywords: readonly string[], weights: readonly number[], budget: number): string;
/**
 * Union the judged-positive spans; never bridge an unjudged gap. A merged span
 * keeps the max probability so repeated or overlapping asks are not rewarded.
 * Strongest first, then earliest.
 */
export declare function mergeHeat(heat: readonly HeatRange[], threshold: number): HeatRange[];
/** The most relevant ranges, strongest first, then earliest. */
export declare function rankedHeat(heat: readonly HeatRange[], limit: number): HeatRange[];
/** One eligible file under the search root. */
export interface FileEntry {
    /** Absolute path. */
    path: string;
    /** Root-relative display path with `/` separators. */
    rel: string;
    size: number;
}
/** Whether a root-relative regular file is searchable. */
export declare function eligibleFile(rel: string, size: number, includeHidden: boolean): boolean;
/**
 * Every eligible file under `root`, in path order. The listing comes from the
 * search core's full scan (`findScanned` with an empty query = the complete
 * tree, gitignore-honoring); sizes are NOT gathered here — only the ≤CANDIDATES
 * tree-rendered candidates are statted later.
 */
export declare function listFiles(root: string, options?: {
    signal?: AbortSignal;
}): Promise<FileEntry[]>;
/** `812 B`, `3.4 KB`, … */
export declare function humanSize(bytes: number): string;
/**
 * Model-facing listing of `entries` as a prefix-folded directory tree: one `#`
 * per relative depth, `# dir/` headers folding single-child directory chains,
 * and every file line tagged with its question key (`# e017 name (size)`),
 * with a blank line before every directory header and every root-level file
 * after the first line.
 */
export declare function renderTree(entries: readonly FileEntry[], tagOf: (index: number) => string): string;
/**
 * The three request shapes the cascade sends to the judge, as `state` plus
 * one noul question per entry. Nouls give absolute probabilities, so entries
 * are thresholded independently and batches are comparable with each other.
 *
 * State objects are built with alphabetically ordered keys so the wire bytes
 * match the reference implementation (which serializes through sorted maps);
 * judgment quality was benchmarked against that exact layout.
 */
/** Question key of the `i`th entry in a filename batch. */
export declare function entryKey(i: number): string;
/** Question key of the `k`th passage in a sketch or verification batch. */
export declare function passageKey(k: number): string;
/** One noul per file over a shared tree-rendered listing of the batch. */
export declare function nameBatch(project: string, query: string, entries: readonly FileEntry[]): JudgeRequest;
/** One sketch card: the file it came from and its budgeted verbatim lines. */
export interface SketchCard {
    fileKey: string;
    rel: string;
    sketch: string;
}
/**
 * Mixed-file packing of sketch cards: one state ingestion pays for many
 * independent small cards instead of rereading a whole file to discover its
 * useful spans.
 */
export declare function sketchBatch(query: string, cards: readonly SketchCard[]): JudgeRequest;
/** Verification of complete passages from one file, judged independently. */
export declare function passageBatch(query: string, rel: string, passages: readonly Passage[]): JudgeRequest;
export interface CascadeOptions {
    root: string;
    query: string;
    /** Caller-supplied lexical keywords, added to those derived from the query. */
    extraKeywords: readonly string[];
    judge: Judge;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    /** Last tie-break for the final hit order (e.g. frecency). Failures read as 0. */
    frecencyScore?: (rel: string) => number | Promise<number>;
}
export interface CascadeHit {
    /** Root-relative path with `/` separators. */
    rel: string;
    /** Filename-judgment probability, when the judge answered for this file. */
    nameScore?: number;
    contentScore: number;
    ranges: HeatRange[];
    linesSeen: number;
    truncated: boolean;
}
export interface CascadeStats {
    listed: number;
    requests: number;
    errors: number;
    judged: number;
    filesRead: number;
    fileBytes: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    apiMs: number;
    windowsJudged: number;
    windowsPruned: number;
    mapCards: number;
    failures: string[];
}
export interface CascadeResult {
    /** Files whose verified passages cleared the threshold, strongest first. */
    hits: CascadeHit[];
    threshold: number;
    keywords: string[];
    stats: CascadeStats;
}
/** Run one cascade search over `options.root`. Judge failures degrade coverage and are reported in `stats.failures`, never thrown. */
export declare function runCascade(options: CascadeOptions): Promise<CascadeResult>;
