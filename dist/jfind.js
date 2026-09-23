/**
 * ffjfind cascade engine: semantic passage maps before full-source reading.
 *
 * 1. Lexical scan ranks every eligible file by query keywords.
 * 2. Filename ranking judges the top candidates by name and place in the tree.
 * 3. Passage scoring reads the strongest files, cuts them into byte-bounded
 *    windows, and judges a budgeted verbatim sketch of each window.
 * 4. Verification judges the complete text of the sketches that survived.
 *
 * Sketch judgments are only routing signals: a reported heat range always
 * comes from a complete passage. Each judged phase runs its requests through
 * a bounded-parallel dispatcher and drains fully before the next begins, so
 * the critical path is three dependent waves.
 *
 * Ported from oh-my-pi `tools/jfind` (cascade/questions/keywords/lexical/
 * passages/text/tree). Host adaptations: listing and the lexical grep run
 * over this package's `search.ts` core (`findScanned` / `grepContents`)
 * instead of pi-natives, file reads use node:fs, and the tree renderer is a
 * standalone prefix-folding reimplementation.
 */
import fs from "node:fs";
import path from "node:path";
import * as search from "./search.js";
/** Requests in flight per dispatched phase. */
export const PARALLEL = envKnob("PARALLEL", 16, 1, 64);
/** Files per filename-ranking request. */
export const NAME_BATCH = envKnob("NAME_BATCH", 64, 1, 512);
/** Lexically ranked files that receive a filename judgment. */
export const CANDIDATES = envKnob("CANDIDATES", 128, 1, 4096);
/** Files whose content is read and sketched. */
export const FILES = envKnob("FILES", 20, 1, 256);
/** Windows kept per read file. */
export const WINDOWS = envKnob("WINDOWS", 24, 1, 256);
/** Bytes per window, tags included. */
export const WINDOW_BYTES = envKnob("WINDOW_BYTES", 8192, 256, 1_048_576);
/** Bytes per sketch card. */
export const SKETCH_BYTES = envKnob("SKETCH_BYTES", 384, 32, 65_536);
/** Complete passages verified across all files. */
export const FULL_LIMIT = envKnob("FULL_LIMIT", 40, 1, 512);
/** Sketch probability below which a passage is not verified. */
export const CUTOFF = envKnobFloat("CUTOFF", 0.45, 0, 1);
/** Verified-passage probability at or above which a file is a hit. */
export const THRESHOLD = envKnobFloat("THRESHOLD", 0.2, 0, 1);
/** Bytes of a file read for windowing. */
export const READ_LIMIT = envKnob("READ_LIMIT", 4 * 1024 * 1024, 4096, 268_435_456);
/** Sketch state budget per request; sized so cards stay well inside the judge's context. */
export const SKETCH_STATE_BYTES = envKnob("SKETCH_STATE_BYTES", 18_000, 512, 1_048_576);
/** Hard cap on sketch cards per request. */
export const SKETCH_CARDS_MAX = envKnob("SKETCH_CARDS_MAX", 48, 1, 512);
/** Passage state budget per verification request, tags included. */
export const VERIFY_STATE_BYTES = envKnob("VERIFY_STATE_BYTES", 24 * 1024, 512, 1_048_576);
/** Wall-clock budget for the lexical grep pass. */
export const SCAN_TIMEOUT_MS = envKnob("SCAN_TIMEOUT_MS", 30_000, 1000, 600_000);
/** Distinct failure messages retained for the report. */
export const FAILURES_KEPT = envKnob("FAILURES_KEPT", 5, 1, 100);
/** Integer env override `OMP_FIND_CASCADE_<NAME>`, clamped to [min,max]. */
function envKnob(name, def, min, max) {
    const raw = process.env[`OMP_FIND_CASCADE_${name}`]?.trim();
    if (raw === undefined || raw === "")
        return def;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** Float env override `OMP_FIND_CASCADE_<NAME>`, clamped to [min,max]. */
function envKnobFloat(name, def, min, max) {
    const raw = process.env[`OMP_FIND_CASCADE_${name}`]?.trim();
    if (raw === undefined || raw === "")
        return def;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, n));
}
// ── text primitives ─────────────────────────────────────────────────────────
/** Split like Rust `str::lines`: `\n`-separated, trailing `\r` stripped, no phantom last line after a final newline. */
export function lines(text) {
    if (text.length === 0)
        return [];
    const out = text.split("\n");
    if (out[out.length - 1] === "")
        out.pop();
    for (let i = 0; i < out.length; i++) {
        const line = out[i];
        if (line.endsWith("\r"))
            out[i] = line.slice(0, -1);
    }
    return out;
}
/** Longest prefix of `text` that fits in `bytes` UTF-8 bytes without splitting a code point. */
export function clipBytes(text, bytes) {
    if (Buffer.byteLength(text) <= bytes)
        return text;
    let used = 0;
    let end = 0;
    for (const char of text) {
        const width = Buffer.byteLength(char);
        if (used + width > bytes)
            break;
        used += width;
        end += char.length;
    }
    return text.slice(0, end);
}
/** First `count` code points of `text`. */
export function takeChars(text, count) {
    let end = 0;
    let taken = 0;
    for (const char of text) {
        if (taken === count)
            break;
        end += char.length;
        taken++;
    }
    return text.slice(0, end);
}
/** Non-overlapping occurrences of `needle` in `haystack`; 0 for an empty needle. */
export function countOccurrences(haystack, needle) {
    if (needle.length === 0)
        return 0;
    let count = 0;
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1)
            return count;
        count++;
        from = at + needle.length;
    }
}
export class ReadTextError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "ReadTextError";
    }
}
const BINARY_PROBE_BYTES = 8192;
/**
 * Read up to `maxBytes` of a text file. Rejects binaries (NUL in the first 8 KB)
 * and blank files; trims a truncated read back to the last full line.
 * @throws {ReadTextError} `binary`, `empty`, or `io`.
 */
export async function readText(filePath, maxBytes) {
    let buf;
    try {
        const fh = await fs.promises.open(filePath, "r");
        try {
            const slab = Buffer.alloc(maxBytes + 1);
            const { bytesRead } = await fh.read(slab, 0, maxBytes + 1, 0);
            buf = slab.subarray(0, bytesRead);
        }
        finally {
            await fh.close();
        }
    }
    catch (error) {
        throw new ReadTextError("io", error instanceof Error ? error.message : String(error));
    }
    const probe = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES));
    if (probe.includes(0))
        throw new ReadTextError("binary", "binary");
    const truncated = buf.length > maxBytes;
    if (truncated) {
        buf = buf.subarray(0, maxBytes);
        const newline = buf.lastIndexOf(0x0a);
        if (newline !== -1)
            buf = buf.subarray(0, newline + 1);
    }
    const text = new TextDecoder().decode(buf);
    if (lines(text).every(line => line.trim().length === 0))
        throw new ReadTextError("empty", "empty");
    return { text, bytes: buf.length, truncated };
}
// ── query keywords ──────────────────────────────────────────────────────────
/** Query-derived keywords for the lexical prior: quoted phrases whole, then
 * alphanumeric tokens minus stopwords, cheaply stemmed and deduplicated. */
const STOPWORDS = Object.fromEntries([
    "the", "a", "an", "or", "and", "to", "is", "are", "be", "when", "where",
    "how", "that", "this", "of", "in", "on", "at", "for", "with", "by", "its",
    "it", "as", "from", "into", "like", "gets", "get", "up", "which", "what",
    "does", "do", "code", "file", "files", "over", "all", "user", "using",
    "then", "than", "there", "their", "they", "them", "you", "your", "we",
    "our", "has", "have", "had", "was", "were", "been", "being", "will",
    "would", "should", "can", "could", "not", "but", "if", "so", "such",
    "via", "per", "any", "some", "each", "every", "also", "just", "only",
    "more", "most", "other", "out", "off", "about", "after", "before",
    "between", "through", "during", "without", "within", "one", "two", "new",
    "used", "use", "make", "makes", "made", "run", "runs", "way", "thing",
    "things", "something", "actually", "really", "still", "yet",
].map(word => [word, true]));
/** Cheap stem so a substring match covers inflections: spawned→spawn, compacted→compact. */
function stem(token) {
    for (const suffix of ["ing", "ed", "es", "s"]) {
        if (token.endsWith(suffix)) {
            const base = token.slice(0, -suffix.length);
            if (base.length >= 4)
                return base;
        }
    }
    return token;
}
/** Unicode letter, digit, or underscore — the token alphabet of the query. */
const TOKEN_RE = /[^\p{L}\p{N}_]+/u;
const DIGITS_RE = /^[0-9]+$/;
/** Keywords for the grep prior: quoted phrases whole, then tokens minus stopwords. */
export function keywordsFromQuery(query) {
    const out = [];
    let rest = "";
    const chars = Array.from(query);
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c !== '"' && c !== "'") {
            rest += c;
            continue;
        }
        let phrase = "";
        let closed = false;
        while (++i < chars.length) {
            if (chars[i] === c) {
                closed = true;
                break;
            }
            phrase += chars[i];
        }
        phrase = phrase.trim().toLowerCase();
        if (closed && Buffer.byteLength(phrase) >= 3) {
            out.push(phrase);
            rest += " ";
            continue;
        }
        rest += `${phrase} `;
    }
    for (const token of rest.split(TOKEN_RE)) {
        const lower = token.toLowerCase();
        if (Buffer.byteLength(lower) < 3 || Object.hasOwn(STOPWORDS, lower) || DIGITS_RE.test(lower))
            continue;
        const stemmed = stem(lower);
        if (!out.includes(stemmed))
            out.push(stemmed);
    }
    return out;
}
/** {@link keywordsFromQuery} plus the caller's extra keywords, lowercased and deduplicated. */
export function keywords(query, extra) {
    const out = keywordsFromQuery(query);
    for (const raw of extra) {
        const keyword = raw.trim().toLowerCase();
        if (keyword.length > 0 && !out.includes(keyword))
            out.push(keyword);
    }
    return out;
}
/** Regex-escape a literal keyword for the grep alternation. */
export function escapeRegex(keyword) {
    return keyword.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");
}
/** Forward-slash form of any scanned path (rg/walker emit native separators). */
function normRel(p) {
    return p.replace(/\\/g, "/");
}
/**
 * Count keyword occurrences (case-insensitive, any keyword) in every file under
 * `root`. Only lines containing a keyword are inspected, so counts are per
 * matching line rather than per file byte. `--vimgrep` emits one row per match,
 * so rows are deduplicated per (file, line) before counting — one line, one
 * count per keyword, exactly like the native Content-mode source.
 */
export async function grepIndex(root, rawKeywords, options) {
    const kws = rawKeywords.map(keyword => keyword.toLowerCase()).filter(keyword => keyword.length > 0);
    const index = { keywords: kws, perFileKw: new Map(), filesScanned: 0 };
    if (kws.length === 0)
        return index;
    const res = await search.grepContents(kws.map(escapeRegex).join("|"), {
        cwd: root,
        literal: false,
        ignoreCase: true,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        timeoutMs: options.timeoutMs,
    });
    throwIfAborted(options.signal);
    // `--vimgrep` emits one row per MATCH; a line matching several keywords (or
    // several times) yields several rows. Count each line once, like the native
    // Content-mode source this port replaces.
    const seenLines = new Set();
    for (const match of res.matches) {
        if (/^\[Omitted long (matching )?line/.test(match.text))
            continue;
        const rel = normRel(match.path);
        if (!eligibleFile(rel, 1, false))
            continue;
        const seenKey = `${rel}\u0000${match.line}`;
        if (seenLines.has(seenKey))
            continue;
        seenLines.add(seenKey);
        let counts = index.perFileKw.get(rel);
        if (counts === undefined) {
            counts = Array.from({ length: kws.length }, () => 0);
            index.perFileKw.set(rel, counts);
        }
        const line = match.text.toLowerCase();
        for (let k = 0; k < kws.length; k++) {
            counts[k] = (counts[k] ?? 0) + countOccurrences(line, kws[k]);
        }
    }
    return index;
}
/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export function idf(index) {
    return index.keywords.map((_, k) => {
        let df = 0;
        for (const counts of index.perFileKw.values()) {
            if ((counts[k] ?? 0) > 0)
                df++;
        }
        const weight = Math.log((index.filesScanned + 1) / (df + 1));
        return Math.min(6, Math.max(0.5, weight));
    });
}
/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export function fileScore(counts, weights, rel, keywords) {
    const lower = rel.toLowerCase();
    let score = 0;
    for (let k = 0; k < keywords.length; k++) {
        const inPath = lower.includes(keywords[k]) ? 1 : 0;
        score += weights[k] * (2 * inPath + Math.log1p(counts[k] ?? 0));
    }
    return score;
}
/**
 * Contiguous whole-line windows bounded by bytes, including the final line. A
 * single oversized line is clipped at a code-point boundary and keeps its real
 * line id.
 */
export function windows(text, bytes, keywords, weights) {
    const source = lines(text);
    const passages = [];
    let start = 0;
    while (start < source.length) {
        let end = start;
        let content = "";
        let used = 0;
        while (end < source.length) {
            const line = source[end];
            const prefix = `L${end + 1}| `;
            const overhead = prefix.length + 1;
            if (end > start && used + Buffer.byteLength(line) + overhead > bytes)
                break;
            const piece = `${prefix}${clipBytes(line, Math.max(0, bytes - (used + overhead)))}\n`;
            content += piece;
            used += Buffer.byteLength(piece);
            end++;
            if (used >= bytes)
                break;
        }
        const lower = content.toLowerCase();
        let score = 0;
        for (let k = 0; k < keywords.length; k++) {
            score += weights[k] * Math.log1p(countOccurrences(lower, keywords[k]));
        }
        passages.push({ start: start + 1, end, text: content, score });
        start = end;
    }
    return passages;
}
/**
 * Keep the best lexical windows and, when no words match, distribute the
 * budget evenly through the file instead of always falling back to its
 * opening bytes. Returned in file order.
 */
export function selectWindows(passages, limit) {
    let selected = passages;
    if (selected.length > limit) {
        if (selected.every(passage => passage.score === 0)) {
            const len = selected.length;
            const step = Math.max(limit - 1, 1);
            const keep = new Set();
            for (let k = 0; k < limit; k++)
                keep.add(Math.floor((k * (len - 1)) / step));
            selected = selected.filter((_, index) => keep.has(index));
        }
        else {
            selected = [...selected].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
        }
    }
    return [...selected].sort((a, b) => a.start - b.start);
}
/** Passage text with the generated `L<n>| ` tags stripped; the caller owns the line coordinates. */
export function plainContent(passage) {
    let out = "";
    const tagged = lines(passage.text);
    for (let i = 0; i < tagged.length; i++) {
        const line = tagged[i];
        const prefix = `L${passage.start + i}| `;
        out += `${line.startsWith(prefix) ? line.slice(prefix.length) : line}\n`;
    }
    return out;
}
/** Bytes reserved per selected sketch line for its `<line>: ` tag and separator. */
const SKETCH_LINE_OVERHEAD = 12;
/** Minimum bytes worth spending on one more sketch line. */
const SKETCH_MIN_LINE = 24;
/** Longest single sketch line. */
const SKETCH_MAX_LINE = 180;
/**
 * A budgeted map of verbatim source lines, not an invented summary. Lines are
 * ranked by keyword weight (plus a nudge for call-like lines) so deep
 * implementation text can outrank headers, then emitted in file order.
 */
export function sketch(passage, keywords, weights, budget) {
    const plain = lines(plainContent(passage));
    const ranked = [];
    for (let index = 0; index < plain.length; index++) {
        const line = plain[index];
        if (line.trim().length === 0)
            continue;
        const lower = line.toLowerCase();
        let score = line.includes("(") ? 0.1 : 0;
        for (let k = 0; k < keywords.length; k++) {
            if (lower.includes(keywords[k]))
                score += weights[k];
        }
        ranked.push({ index, score });
    }
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = [];
    let used = 0;
    for (const { index } of ranked) {
        const available = Math.max(0, budget - (used + SKETCH_LINE_OVERHEAD));
        if (available < SKETCH_MIN_LINE)
            break;
        const line = plain[index].trim();
        const text = `${passage.start + index}: ${clipBytes(line, Math.min(available, SKETCH_MAX_LINE))}`;
        used += Buffer.byteLength(text) + 1;
        selected.push({ index, text });
    }
    selected.sort((a, b) => a.index - b.index);
    return selected.map(entry => entry.text).join("\n");
}
/**
 * Union the judged-positive spans; never bridge an unjudged gap. A merged span
 * keeps the max probability so repeated or overlapping asks are not rewarded.
 * Strongest first, then earliest.
 */
export function mergeHeat(heat, threshold) {
    const kept = heat
        .filter(range => range.p >= threshold && range.p > 0 && range.start <= range.end)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of kept) {
        const last = merged[merged.length - 1];
        if (last !== undefined && range.start <= last.end + 1) {
            last.end = Math.max(last.end, range.end);
            if (range.p > last.p)
                last.p = range.p;
            continue;
        }
        merged.push({ ...range });
    }
    return merged.sort((a, b) => b.p - a.p || a.start - b.start);
}
/** The most relevant ranges, strongest first, then earliest. */
export function rankedHeat(heat, limit) {
    return heat
        .filter(range => range.p > 0)
        .sort((a, b) => b.p - a.p || a.start - b.start)
        .slice(0, limit);
}
const DENY_DIRS = {
    ".git": true,
    node_modules: true,
    target: true,
    dist: true,
    build: true,
    out: true,
    ".next": true,
    ".nuxt": true,
    ".turbo": true,
    ".cache": true,
    __pycache__: true,
    ".venv": true,
    venv: true,
    ".tox": true,
    coverage: true,
    ".idea": true,
    ".vscode": true,
    ".gradle": true,
    ".mypy_cache": true,
    ".pytest_cache": true,
    ".ruff_cache": true,
    ".parcel-cache": true,
};
const DENY_FILES = {
    "Cargo.lock": true,
    "package-lock.json": true,
    "yarn.lock": true,
    "pnpm-lock.yaml": true,
    "bun.lock": true,
    "bun.lockb": true,
    "poetry.lock": true,
    "Pipfile.lock": true,
    "composer.lock": true,
    "Gemfile.lock": true,
    "go.sum": true,
    "flake.lock": true,
    ".DS_Store": true,
    "Thumbs.db": true,
};
/** Credential files by exact name. Never listed or read, even when hidden files are included. */
const SECRET_FILES = {
    ".env": true,
    ".envrc": true,
    ".netrc": true,
    ".npmrc": true,
    ".pypirc": true,
    ".pgpass": true,
    ".boto": true,
    ".s3cfg": true,
    ".dockercfg": true,
    ".git-credentials": true,
    ".htpasswd": true,
    htpasswd: true,
    credentials: true,
    "credentials.json": true,
    "client_secret.json": true,
    "service-account.json": true,
    id_rsa: true,
    id_dsa: true,
    id_ecdsa: true,
    id_ed25519: true,
};
/** Credential files by extension: keys, certificate stores, encrypted vaults, and infrastructure state that embeds secrets. */
const SECRET_EXT = [
    "pem", "key", "p12", "pfx", "jks", "keystore", "bks", "ppk", "kdbx", "gpg",
    "pgp", "asc", "der", "crt", "cer", "tfvars", "tfvars.json", "tfstate", "tfstate.backup",
];
const BINARY_EXT = [
    "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "psd",
    "svg", "woff", "woff2", "ttf", "otf", "eot", "zip", "gz", "tgz", "tar",
    "bz2", "xz", "zst", "7z", "rar", "pdf", "mp3", "mp4", "mov", "avi", "mkv",
    "wav", "ogg", "flac", "wasm", "so", "dylib", "dll", "exe", "o", "a",
    "class", "jar", "pyc", "pyo", "bin", "dat", "db", "sqlite", "sqlite3",
    "lock", "map", "min.js", "min.css", "snap", "pb", "onnx", "safetensors",
    "parquet", "arrow", "ipynb",
];
const ENV_TEMPLATES = {
    ".env.example": true,
    ".env.sample": true,
    ".env.template": true,
    ".env.dist": true,
};
/** `lower` ends with `.<ext>` for some `ext` in `exts`. */
function hasExt(lower, exts) {
    return exts.some(ext => lower.length > ext.length && lower.endsWith(`.${ext}`));
}
/** Credential material: exact names, `.env.*` variants (except committed templates), and key/vault extensions. */
function secret(name) {
    if (Object.hasOwn(SECRET_FILES, name))
        return true;
    if (name.startsWith(".env."))
        return !Object.hasOwn(ENV_TEMPLATES, name);
    return hasExt(name.toLowerCase(), SECRET_EXT);
}
/** Whether a root-relative regular file is searchable. */
export function eligibleFile(rel, size, includeHidden) {
    if (size <= 0)
        return false;
    const segments = rel.split("/");
    const name = segments[segments.length - 1];
    for (let i = 0; i < segments.length - 1; i++) {
        const dir = segments[i];
        if (Object.hasOwn(DENY_DIRS, dir) || (!includeHidden && dir.startsWith(".")))
            return false;
    }
    if (!includeHidden && name.startsWith("."))
        return false;
    return !Object.hasOwn(DENY_FILES, name) && !secret(name) && !hasExt(name.toLowerCase(), BINARY_EXT);
}
/**
 * Every eligible file under `root`, in path order. The listing comes from the
 * search core's full scan (`findScanned` with an empty query = the complete
 * tree, gitignore-honoring); sizes are NOT gathered here — only the ≤CANDIDATES
 * tree-rendered candidates are statted later.
 */
export async function listFiles(root, options = {}) {
    const scan = await search.findScanned("", { cwd: root, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    throwIfAborted(options.signal);
    const entries = [];
    for (const raw of scan.paths) {
        const rel = normRel(raw);
        if (!eligibleFile(rel, 1, false))
            continue;
        entries.push({ path: path.join(root, ...rel.split("/")), rel, size: 1 });
    }
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return entries;
}
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
/** `812 B`, `3.4 KB`, … */
export function humanSize(bytes) {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}
/**
 * Model-facing listing of `entries` as a prefix-folded directory tree: one `#`
 * per relative depth, `# dir/` headers folding single-child directory chains,
 * and every file line tagged with its question key (`# e017 name (size)`),
 * with a blank line before every directory header and every root-level file
 * after the first line.
 */
export function renderTree(entries, tagOf) {
    const root = { files: [], dirs: [], dirIndex: new Map() };
    entries.forEach((entry, index) => {
        const segments = entry.rel.split("/");
        let node = root;
        for (let i = 0; i < segments.length - 1; i++) {
            const seg = segments[i];
            let child = node.dirIndex.get(seg);
            if (child === undefined) {
                child = { files: [], dirs: [], dirIndex: new Map() };
                node.dirIndex.set(seg, child);
                node.dirs.push({ name: seg, node: child });
            }
            node = child;
        }
        node.files.push({ name: segments[segments.length - 1], index });
    });
    const walk = function* (node, depth) {
        for (const file of node.files) {
            yield { kind: "file", depth, name: file.name, index: file.index };
        }
        for (const subdir of node.dirs) {
            let dirNode = subdir.node;
            const parts = [subdir.name];
            while (dirNode.files.length === 0 && dirNode.dirs.length === 1) {
                const only = dirNode.dirs[0];
                parts.push(only.name);
                dirNode = only.node;
            }
            yield { kind: "dir", depth, name: parts.join("/") };
            yield* walk(dirNode, depth + 1);
        }
    };
    let out = "";
    let emitted = false;
    for (const event of walk(root, 0)) {
        if (emitted && (event.kind === "dir" || event.depth === 0))
            out += "\n";
        emitted = true;
        const hashes = "#".repeat(event.depth + 1);
        if (event.kind === "dir") {
            out += `${hashes} ${event.name}/\n`;
            continue;
        }
        out += `${hashes} ${tagOf(event.index)} ${event.name} (${humanSize(entries[event.index]?.size ?? 0)})\n`;
    }
    return out;
}
// ── judgment requests ───────────────────────────────────────────────────────
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
export function entryKey(i) {
    return `e${String(i).padStart(3, "0")}`;
}
/** Question key of the `k`th passage in a sketch or verification batch. */
export function passageKey(k) {
    return `p${String(k).padStart(2, "0")}`;
}
const NAME_QUESTION_TEMPLATE = 'Is the file tagged {{key}} ("{{name}}") likely to contain what this search is looking for: "{{query}}"? Judge by its name, size, and place in `tree`; apply `criteria.file`.';
const SKETCH_QUESTION_TEMPLATE = 'Could passage {{key}} implement a requested step of "{{query}}"? Apply criteria.';
const PASSAGE_QUESTION_TEMPLATE = 'Does `passages.{{key}}` substantively implement, define, or explain part of "{{query}}"? Apply `criteria`.';
/** Inline `{{var}}` replacement over the question templates. */
function render(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}
const TASK = "Semantic grep over a source tree: locate files whose content matches the search description. Entries are judged by name, size, and position in the tree.";
const TREE_FORMAT = "`tree` is a directory listing. Lines starting with # are headers: `# dir/` is a folder; more #s means deeper nesting under the header above; a header may fold several levels (`# a/b/c/`). Every judgeable entry carries a tag like e017 right after the #s: files as `e017 name (size)`. Untagged header lines are only structure.";
const FILE_CRITERIA = {
    // Generated implementation is still implementation. File provenance must
    // not itself be negative evidence for source-code searches.
    no: "The file is unrelated by name and location; generated executable implementation can still be relevant.",
    yes: "A file at this path plausibly contains code, text, or data matching the search.",
};
const SKETCH_CRITERIA = {
    no: "Unrelated code; mere mentions, declarations, call sites, tests or configuration without implementation.",
    yes: "Likely substantive implementation, definition or explanation of any part of the requested behavior. A matching helper for one step counts. Excerpts omit most source: favor recall.",
};
const PASSAGE_CRITERIA = {
    no: "This passage only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.",
    yes: "This passage contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.",
};
/** Copy of `record` with keys in lexicographic order. */
function sorted(record) {
    const out = {};
    for (const key of Object.keys(record).sort())
        out[key] = record[key];
    return out;
}
/** One noul per file over a shared tree-rendered listing of the batch. */
export function nameBatch(project, query, entries) {
    const questions = {};
    entries.forEach((entry, i) => {
        const key = entryKey(i);
        const name = entry.rel.slice(entry.rel.lastIndexOf("/") + 1);
        questions[key] = {
            type: "noul",
            instructions: render(NAME_QUESTION_TEMPLATE, { key, name, query }).trim(),
        };
    });
    return {
        state: {
            criteria: { file: FILE_CRITERIA },
            format: TREE_FORMAT,
            project,
            search: query,
            tree: renderTree(entries, entryKey),
        },
        questions,
    };
}
/**
 * Mixed-file packing of sketch cards: one state ingestion pays for many
 * independent small cards instead of rereading a whole file to discover its
 * useful spans.
 */
export function sketchBatch(query, cards) {
    const files = {};
    const passages = {};
    const questions = {};
    cards.forEach((card, k) => {
        const key = passageKey(k);
        files[card.fileKey] = card.rel;
        passages[key] = [card.fileKey, card.sketch];
        questions[key] = { type: "noul", instructions: render(SKETCH_QUESTION_TEMPLATE, { key, query }).trim() };
    });
    return {
        state: { criteria: SKETCH_CRITERIA, files: sorted(files), passages, search: query },
        questions,
    };
}
/** Verification of complete passages from one file, judged independently. */
export function passageBatch(query, rel, passages) {
    const entries = {};
    const questions = {};
    passages.forEach((passage, k) => {
        const key = passageKey(k);
        entries[key] = plainContent(passage);
        questions[key] = {
            type: "noul",
            instructions: render(PASSAGE_QUESTION_TEMPLATE, { key, query }).trim(),
        };
    });
    return {
        state: { criteria: PASSAGE_CRITERIA, file: rel, passages: entries, search: query },
        questions,
    };
}
/** A finite probability, or `undefined` when the judge produced nothing usable for the key. */
function noul(outcome, key) {
    if (!outcome.ok)
        return undefined;
    const p = outcome.result.answers[key]?.noul;
    return p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}
function chunks(items, size) {
    const out = [];
    for (let start = 0; start < items.length; start += size)
        out.push(items.slice(start, start + size));
    return out;
}
function compareRel(a, b) {
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}
function throwIfAborted(signal) {
    if (signal?.aborted === true) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error("aborted");
    }
}
class Cascade {
    #options;
    stats = {
        listed: 0,
        requests: 0,
        errors: 0,
        judged: 0,
        filesRead: 0,
        fileBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        apiMs: 0,
        windowsJudged: 0,
        windowsPruned: 0,
        mapCards: 0,
        failures: [],
    };
    constructor(options) {
        this.#options = options;
    }
    #fail(phase, error) {
        const message = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
        const { failures } = this.stats;
        if (failures.length < FAILURES_KEPT && !failures.includes(message))
            failures.push(message);
    }
    async #ask(request) {
        const { judge, signal } = this.#options;
        const started = performance.now();
        try {
            const result = await judge.judge(request, { signal });
            this.stats.requests++;
            this.stats.apiMs += performance.now() - started;
            this.stats.inputTokens += result.usage.input;
            this.stats.outputTokens += result.usage.output;
            this.stats.cost += result.usage.cost.total;
            return { ok: true, result };
        }
        catch (error) {
            throwIfAborted(signal);
            this.stats.requests++;
            this.stats.errors++;
            this.stats.apiMs += performance.now() - started;
            return { ok: false, error };
        }
    }
    /**
     * Run every job with at most {@link PARALLEL} requests in flight, handing each
     * outcome to `settle` in completion order. Resolves once the queue drains.
     */
    async #dispatch(jobs, settle) {
        let next = 0;
        const worker = async () => {
            while (next < jobs.length) {
                throwIfAborted(this.#options.signal);
                const job = jobs[next++];
                settle(job, await this.#ask(job.request));
            }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
    }
    async run() {
        const { root, query, signal, onProgress, frecencyScore } = this.#options;
        const kws = keywords(query, this.#options.extraKeywords);
        onProgress?.("lexical scan");
        const [entries, index] = await Promise.all([
            listFiles(root, { signal }),
            grepIndex(root, kws, { signal, timeoutMs: SCAN_TIMEOUT_MS }),
        ]);
        this.stats.listed = entries.length;
        index.filesScanned = entries.length;
        const weights = idf(index);
        const noCounts = Array.from({ length: kws.length }, () => 0);
        const ranked = entries
            .map((entry, node) => ({
            node,
            lex: fileScore(index.perFileKw.get(entry.rel) ?? noCounts, weights, entry.rel, kws),
        }))
            .sort((a, b) => b.lex - a.lex || compareRel(entries[a.node], entries[b.node]))
            .slice(0, CANDIDATES);
        // Stat sizes only for the tree-rendered candidates, dropping vanished or
        // empty files before any judgment is spent on them.
        await Promise.all(ranked.map(async (candidate) => {
            try {
                entries[candidate.node].size = (await fs.promises.stat(entries[candidate.node].path)).size;
            }
            catch {
                candidate.lex = -1;
            }
        }));
        const viable = ranked.filter(candidate => candidate.lex >= 0);
        const nameScore = Array.from({ length: entries.length });
        // Wave 1: filename ranking over the lexical shortlist.
        const project = path.basename(root);
        const nameJobs = chunks(viable.map(candidate => candidate.node), NAME_BATCH).map(batch => ({
            batch,
            request: nameBatch(project, query, batch.map(node => entries[node])),
        }));
        let named = 0;
        onProgress?.(`filename ranking 0/${viable.length}`);
        await this.#dispatch(nameJobs, (job, outcome) => {
            named += job.batch.length;
            if (!outcome.ok)
                this.#fail("filenames", outcome.error);
            job.batch.forEach((node, k) => {
                const p = noul(outcome, entryKey(k));
                nameScore[node] = p;
                if (p === undefined) {
                    if (outcome.ok)
                        this.stats.errors++;
                }
                else {
                    this.stats.judged++;
                }
            });
            onProgress?.(`filename ranking ${named}/${viable.length}`);
        });
        // The two strongest lexical candidates are read regardless of the name
        // judgment; the rest of the budget follows name score, then lexical rank.
        const selected = viable.slice(0, Math.min(FILES, 2)).map(candidate => candidate.node);
        const ordered = [...viable].sort((a, b) => (nameScore[b.node] ?? 0) - (nameScore[a.node] ?? 0) || b.lex - a.lex);
        for (const candidate of ordered) {
            if (selected.length >= FILES)
                break;
            if (!selected.includes(candidate.node))
                selected.push(candidate.node);
        }
        onProgress?.(`reading ${selected.length} files`);
        const plans = await Promise.all(selected.map(async (node) => {
            const entry = entries[node];
            try {
                const read = await readText(entry.path, READ_LIMIT);
                const passages = selectWindows(windows(read.text, WINDOW_BYTES, kws, weights), WINDOWS);
                if (passages.length === 0)
                    return undefined;
                return { node, total: lines(read.text).length, truncated: read.truncated, passages };
            }
            catch (error) {
                // Binary and blank files are expected misses, not failures worth reporting.
                if (!((error instanceof ReadTextError)) || error.kind === "io")
                    this.#fail(`read ${entry.rel}`, error);
                return undefined;
            }
        }));
        const files = plans.filter((plan) => plan !== undefined);
        // Wave 2: sketch routing over mixed-file cards.
        const cards = [];
        files.forEach((plan, f) => plan.passages.forEach((_, p) => cards.push({ f, p })));
        let sketchSentBytes = 0;
        const sketchJobs = chunks(cards, Math.min(SKETCH_CARDS_MAX, Math.max(1, Math.floor(SKETCH_STATE_BYTES / SKETCH_BYTES)))).map(batch => {
            const sketches = batch.map(({ f, p }) => {
                const text = sketch(files[f].passages[p], kws, weights, SKETCH_BYTES);
                sketchSentBytes += Buffer.byteLength(text);
                return { fileKey: `f${f}`, rel: entries[files[f].node].rel, sketch: text };
            });
            return { batch, request: sketchBatch(query, sketches) };
        });
        this.stats.mapCards += cards.length;
        onProgress?.(`scoring ${cards.length} passage sketches across ${files.length} files`);
        const candidates = [];
        await this.#dispatch(sketchJobs, (job, outcome) => {
            if (!outcome.ok)
                this.#fail("sketches", outcome.error);
            job.batch.forEach(({ f, p }, k) => {
                const score = noul(outcome, passageKey(k));
                if (score === undefined && outcome.ok)
                    this.stats.errors++;
                // Failure is unknown, never grounds for a negative judgment.
                candidates.push({ f, p, score: score ?? 1 });
            });
        });
        candidates.sort((a, b) => b.score - a.score ||
            files[b.f].passages[b.p].score - files[a.f].passages[a.p].score ||
            compareRel(entries[files[a.f].node], entries[files[b.f].node]) ||
            files[a.f].passages[a.p].start - files[b.f].passages[b.p].start);
        const survivors = candidates.filter(candidate => candidate.score >= CUTOFF).slice(0, FULL_LIMIT);
        this.stats.windowsPruned += cards.length - survivors.length;
        const chosen = new Map();
        for (const { f, p } of survivors) {
            const list = chosen.get(f);
            if (list !== undefined)
                list.push(p);
            else
                chosen.set(f, [p]);
        }
        // Wave 3: verification of complete passages, grouped per file.
        const verifyJobs = [];
        for (const f of [...chosen.keys()].sort((a, b) => a - b)) {
            const ps = chosen.get(f).sort((a, b) => a - b);
            for (const group of chunks(ps, Math.max(1, Math.floor(VERIFY_STATE_BYTES / WINDOW_BYTES)))) {
                const passages = group.map(p => files[f].passages[p]);
                const rel = entries[files[f].node].rel;
                verifyJobs.push({ f, passages, request: passageBatch(query, rel, passages) });
            }
        }
        onProgress?.(`verifying ${survivors.length} passages in ${chosen.size} files`);
        const results = new Map();
        await this.#dispatch(verifyJobs, (job, outcome) => {
            if (!outcome.ok) {
                this.#fail("verification", outcome.error);
                return;
            }
            let entry = results.get(job.f);
            if (entry === undefined) {
                entry = { score: 0, heat: [], lines: 0, bytes: 0 };
                results.set(job.f, entry);
            }
            job.passages.forEach((passage, k) => {
                const score = noul(outcome, passageKey(k));
                if (score === undefined) {
                    this.stats.errors++;
                    return;
                }
                const text = plainContent(passage);
                entry.score = Math.max(entry.score, score);
                entry.heat.push({
                    start: passage.start,
                    end: passage.end,
                    p: score,
                    snippet: takeChars((lines(text).find(line => line.trim().length > 0)) ?? "", 100),
                });
                entry.lines += passage.end - passage.start + 1;
                entry.bytes += Buffer.byteLength(text);
                this.stats.windowsJudged++;
            });
        });
        const hits = [];
        for (const [f, entry] of results) {
            const plan = files[f];
            this.stats.filesRead++;
            this.stats.fileBytes += entry.bytes;
            if (entry.score < THRESHOLD)
                continue;
            hits.push({
                rel: entries[plan.node].rel,
                nameScore: nameScore[plan.node],
                contentScore: entry.score,
                ranges: mergeHeat(entry.heat, THRESHOLD),
                linesSeen: entry.lines,
                truncated: plan.truncated || entry.lines < plan.total,
            });
        }
        this.stats.fileBytes += sketchSentBytes;
        this.stats.filesRead += files.length - results.size;
        const freScores = await Promise.all(hits.map(async (hit) => {
            try {
                return frecencyScore === undefined ? 0 : Number(await frecencyScore(hit.rel)) || 0;
            }
            catch {
                return 0;
            }
        }));
        hits.map((hit, i) => ({ hit, fre: freScores[i] ?? 0 }))
            .sort((a, b) => b.hit.contentScore - a.hit.contentScore || b.fre - a.fre || (a.hit.rel < b.hit.rel ? -1 : 1))
            .forEach((pair, i) => { hits[i] = pair.hit; });
        return { hits, threshold: THRESHOLD, keywords: kws, stats: this.stats };
    }
}
/** Run one cascade search over `options.root`. Judge failures degrade coverage and are reported in `stats.failures`, never thrown. */
export function runCascade(options) {
    return new Cascade(options).run();
}
