/** omp-find core search: rg-backed listing/grep with a TS walker fallback. Node builtins only. */
import { execFile, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { outlineFile } from "./outline.js";
import type { OutlineSymbol } from "./outline.js";
export const PAGE_DEFAULT = 30, PAGE_MAX = 50;
const RG_BUFFER = 64 * 1024 * 1024, GREP_CAP = 20000, MAX_DEPTH = 25;
/** Per-file ceiling for content scans (fallback stat skip + rg --max-filesize); oversized files never match. */
const MAX_GREP_BYTES = 2 * 1024 * 1024, MAX_GREP_SIZE = "2M";
/** Default wall-clock budget for one grep call (overridable via GrepOptions.timeoutMs). */
const GREP_TIMEOUT_DEFAULT = 30000;
export interface ParsedFindQuery { fuzzy: string; dirPrefix?: string; extGlobs: string[]; excludes: string[]; gitModifiedOnly: boolean }
export interface FindOptions { cwd?: string; limit?: number; offset?: number; scan?: string; followSymlinks?: boolean; scope?: string }
export interface GrepOptions { cwd?: string; limit?: number; offset?: number; literal?: boolean; ignoreCase?: boolean; wholeWord?: boolean; smartCase?: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; contextBefore?: number; contextAfter?: number; expand?: "none" | "function"; scope?: string }
export interface GrepMatch { path: string; line: number; col: number; text: string; before?: string[]; after?: string[]; enclosing?: { kind: string; name: string; line: number }; depth?: number; via?: string }
export interface GrepResult { matches: GrepMatch[]; total: number; backend: ScanBackend; capped?: boolean }
/** Which listing/grep backend served a call: rg when on PATH, otherwise the builtin walker. */
export type ScanBackend = "rg" | "walker";
/** Ranked paths plus scan metadata (files listed + serving backend) for zero-state counts. */
export interface FindScan { paths: string[]; scanned: number; backend: ScanBackend }
/** Split a raw query into dir prefix, globs, exclusions, and fuzzy text. */
export function parseFindQuery(q: string): ParsedFindQuery {
  const out: ParsedFindQuery = { fuzzy: "", extGlobs: [], excludes: [], gitModifiedOnly: false };
  const fuzzy: string[] = [];
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    if (/^git:modified$/i.test(tok)) out.gitModifiedOnly = true;
    else if (tok[0] === "!" && tok.length > 1) out.excludes.push(tok.slice(1));
    else if (tok.length > 1 && tok.endsWith("/") && out.dirPrefix === undefined) out.dirPrefix = tok.replace(/^\.\//, "").replace(/\/$/, "");
    else if (/[*?[{]/.test(tok)) out.extGlobs.push(tok);
    else fuzzy.push(tok);
  }
  out.fuzzy = fuzzy.join(" ");
  return out;
}
/** Minimal glob → RegExp (`*`, `**`, `?`, `{a,b}`, `[...]`); reused for tool-layer path filters. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length;) {
    const c = glob[i];
    if (c === "*") { if (glob[i + 1] === "*") { re += ".*"; i += glob[i + 2] === "/" ? 3 : 2; } else { re += "[^/]*"; i++; } }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === "{" || c === "[") {
      const j = glob.indexOf(c === "{" ? "}" : "]", i);
      if (j < 0) { re += `\\${c}`; i++; }
      else { re += c === "{" ? `(?:${glob.slice(i + 1, j).split(",").join("|")})` : glob.slice(i, j + 1); i = j + 1; }
    } else { re += c.replace(/[.+^${}()|\\]/, (m) => `\\${m}`); i++; }
  }
  return new RegExp(`${re}$`);
}
function errCode(err: unknown): unknown {
  return err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
}
/** execFile wrapper: rg exit 1 (no matches) resolves; overruns reject as `timed out` (child is killed). */
function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number = GREP_TIMEOUT_DEFAULT): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: RG_BUFFER, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        const killed = err !== null && typeof err === "object" && "killed" in err && err.killed === true;
        if (killed) { reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`)); return; }
        if (!(cmd === "rg" && errCode(err) === 1)) reject(err); else resolve(stdout ?? ""); // rg exit 1 = no matches
      } else resolve(stdout ?? "");
    });
  });
}
export function pageOf<T>(arr: T[], limit: number | undefined, offset: number | undefined): T[] {
  const off = Math.max(0, Math.floor(offset ?? 0));
  if (limit === undefined) return arr.slice(off);
  const n = Math.floor(limit);
  return arr.slice(off, off + (Number.isFinite(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT));
}
/** Refuse filesystem-root and home-directory scans (runaway-tree guard). */
function guardCwd(cwd: string): void {
  if (cwd === path.parse(cwd).root) throw new Error(`refusing to scan the filesystem root (${cwd}); run from a project directory`);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && path.resolve(home) === cwd) throw new Error(`refusing to scan the home directory (${cwd}); run from a project directory`);
}
/** Nonexistent scan root → clean error instead of silent zero-state (rg spawn
 * fails → walker readdir catch → []). Thrown before any backend runs; the tools
 * layer surfaces it as `<tool> failed: scan root not found: <dir>`. */
async function assertCwdExists(cwd: string): Promise<void> {
  try {
    const st = await fs.stat(cwd);
    if (!st.isDirectory()) throw new Error(`scan root not found: ${cwd}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("scan root not found")) throw err;
    throw new Error(`scan root not found: ${cwd}`);
  }
}
/** rg spawn/runtime failures that downgrade to the walker: rg missing (ENOENT),
 * argv too long for the OS (ENAMETOOLONG/E2BIG — 64KB+ patterns), stdout over
 * the 64MB maxBuffer (ERR_CHILD_PROCESS_STDIO_MAXBUFFER/ENOBUFS, or the bare
 * "maxBuffer" message on platforms that report no code), or a numeric exit
 * (e.g. exit 2 from one unscannable file — trailing-dot name, EACCES, broken
 * symlink, FIFO — with --no-messages hiding which file). Timeout rejections
 * carry no code and rethrow; rg exit 1 (no matches) never rejects. */
function rgRecoverable(err: unknown): boolean {
  const c = errCode(err);
  if (c === "ENOENT" || c === "ENAMETOOLONG" || c === "E2BIG" || c === "ENOBUFS" || c === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
  if (typeof c === "number") return true;
  return err instanceof Error && /maxBuffer/i.test(err.message);
}
/** Cooperative deadline: the timeout race already rejected, so stop burning CPU
after the budget (rg is kill-guarded; the walker is not). Throws timeout text. */
function checkDeadline(deadline: number, timeoutMs: number): void {
  if (deadline > 0 && Date.now() > deadline) throw new Error(`grep timed out after ${timeoutMs / 1000}s`);
}
/** Decode a scanned file the way rg does: BOM-sniffed UTF-16LE/BE transcode and
 * UTF-8 BOM strip happen BEFORE the binary check, so the NUL test applies to
 * decoded text (UTF-16 raw bytes are NUL-dense and would false-positive as
 * binary). Returns null for binary content; callers still catch stat/read. */
function decodeGrepText(buf: Buffer): string | null {
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString("utf16le", 2);
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    if (swapped.length % 2 === 1) return null; // odd byte count: malformed UTF-16BE
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else {
    text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM: strip so line 1 col 1 matches rg
  }
  return text.includes("\0") ? null : text;
}
/** Explicit-pin scope: workspace-relative path forwarded from the tools layer
 * (concrete `dir/` or `dir/file` pins only — never globs or bare basenames).
 * Normalized here so every backend treats the same pin the same way: leading
 * `./` and trailing slashes stripped, backslashes unified. Escape-shaped
 * scopes (`..` segments, absolute paths, drive pins) throw — mirroring the
 * tools layer's scopePin — because collapsing them to undefined would read
 * as "no scope" and silently widen to a full-tree scan. */
function normalizeScope(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  const noDot = scope.replace(/\\/g, "/").startsWith("./") ? scope.replace(/\\/g, "/").slice(2) : scope.replace(/\\/g, "/");
  const segs = noDot.split("/").filter(Boolean);
  if (segs.length === 0) return undefined; // "./" alone: degenerate, not escape-shaped
  if (noDot.startsWith("/") || segs.includes("..") || /^[A-Za-z]:$/.test(segs[0] ?? "")) {
    throw new Error(`path escapes the scan root: ${scope}`);
  }
  return segs.join("/");
}
async function walkFiles(cwd: string, follow: boolean, deadline = 0, timeoutMs = 0, scope?: string): Promise<string[]> {
  const out: string[] = [];
  const visited = new Set<string>();
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const abs = path.join(cwd, dir);
    let key: string;
    try { key = await fs.realpath(abs); } catch { key = path.resolve(abs); }
    if (visited.has(key)) return;
    visited.add(key);
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    checkDeadline(deadline, timeoutMs); // per directory batch: abort the orphaned scan, don't finish the tree
    for (const e of entries) {
      if (e.isSymbolicLink() && !follow) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink() && follow) {
        try { isDir = (await fs.stat(path.join(cwd, dir, e.name))).isDirectory(); } catch { continue; }
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (isDir) { if (e.name !== "node_modules" && e.name !== ".git" && !e.name.startsWith(".")) await walk(path.join(dir, e.name), relPath, depth + 1); }
      else if (e.name !== ".git") out.push(relPath); // linked worktrees carry a .git pointer FILE — skip it like the dir
    }
  }
  const root = normalizeScope(scope);
  if (root !== undefined) {
    // The explicitly requested root bypasses the dot-dir prune above (that
    // guard still applies to every directory met *under* the root); a pinned
    // file resolves to itself without any traversal.
    const abs = path.join(cwd, ...root.split("/"));
    let st;
    try { st = await fs.stat(abs); } catch { return out; }
    if (st.isFile()) { out.push(root); return out; }
    if (st.isDirectory()) { await walk(root.split("/").join(path.sep), root, 0); return out; }
    return out;
  }
  await walk(".", "", 0);
  return out;
}
async function listFiles(cwd: string, scan: string | undefined, follow: boolean, scope?: string): Promise<{ files: string[]; backend: ScanBackend }> {
  const root = normalizeScope(scope);
  if (scan !== "mock") {
    try {
      // A pinned path replaces "." positionally: rg searches an explicit file
      // or dir even when hidden/ignored, while unpinned calls keep today's
      // argv ("." root, no blanket --hidden/--no-ignore) byte-identical.
      const stdout = await runCmd("rg", ["--files", "--no-messages", follow ? "--follow" : "--no-follow", root === undefined ? "." : toNative(root)], cwd);
      return { files: stdout.split("\n").map((l) => stripDotSlash(l.trim().replace(/\\/g, "/"))).filter(Boolean), backend: "rg" };
    } catch (err) { if (!rgRecoverable(err)) throw err; }
  }
  return { files: await walkFiles(cwd, follow, 0, 0, root), backend: "walker" };
}
/** Fresh `git status --porcelain` per call; null when git fails (not a repo). */
async function gitModifiedSet(cwd: string): Promise<Set<string> | null> {
  try {
    const set = new Set<string>();
    for (const line of (await runCmd("git", ["status", "--porcelain"], cwd)).split("\n")) {
      if (line.length < 4) continue;
      let p = line.slice(3).trim().replace(/\\/g, "/");
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) set.add(p);
    }
    return set;
  } catch { return null; }
}
function matchesAny(p: string, res: RegExp[]): boolean {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return res.some((re) => re.test(p) || re.test(base));
}
function applyFindFilters(files: string[], q: ParsedFindQuery, modified: Set<string> | null): string[] {
  const globs = q.extGlobs.map(globToRegExp);
  return files.filter((f) => {
    if (q.dirPrefix && f !== q.dirPrefix && !f.startsWith(`${q.dirPrefix}/`)) return false;
    if (globs.length > 0 && !matchesAny(f, globs)) return false;
    for (const raw of q.excludes) {
      const ex = raw.replace(/^\.\//, "");
      if (ex.endsWith("/")) { const dir = ex.replace(/\/$/, ""); if (f === dir || f.startsWith(`${dir}/`)) return false; }
      else if (/[*?[{]/.test(ex) ? matchesAny(f, [globToRegExp(ex)]) : f === ex || f.startsWith(`${ex}/`) || f.split("/").includes(ex)) return false;
    }
    return modified === null || modified.has(f);
  });
}
/** Subsequence fuzzy score (lower is better; Infinity = no match). Exact and stem basename matches win. */
export function fuzzyScore(pattern: string, target: string): number { // exported for table tests (test-only export, no API change)
  if (!pattern) return 0;
  const p = pattern.toLowerCase().replace(/\s+/g, ""), t = target.toLowerCase();
  let pi = 0, score = 0, last = -1;
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) { score += last < 0 ? ti * 2 : (ti - last - 1) * 2; last = ti; pi++; }
  }
  if (pi < p.length) return Number.POSITIVE_INFINITY;
  const base = t.slice(t.lastIndexOf("/") + 1);
  if (p === base) return score - 20; // exact basename match
  // Stem match (upstream PR #728, open): the pattern is the basename minus a
  // single final extension — `user` vs `user.ts`, but not `user.test` vs
  // `user.test.ts` (no second dot) and not empty extensions. Tiers: exact -20,
  // stem -10, fuzzy 0.
  if (p.length + 2 <= base.length && base[p.length] === "." && base.indexOf(".") === base.lastIndexOf(".")) return score - 10;
  return score;
}
const toNative = (p: string): string => p.split("/").join(path.sep);
/** rg via execFile (piped stdout) prefixes relative paths with `./`; terminals strip it, so clean it here. */
const stripDotSlash = (p: string): string => p.startsWith("./") ? p.slice(2) : p;
/** Full ranked listing plus scan metadata (files listed + serving backend) for zero-state counts. */
export async function findScanned(query: string, opts: FindOptions = {}): Promise<FindScan> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  await assertCwdExists(cwd);
  const q = parseFindQuery(query);
  const { files, backend } = await listFiles(cwd, opts.scan, opts.followSymlinks ?? false, opts.scope);
  let modified: Set<string> | null = null;
  if (q.gitModifiedOnly) {
    modified = await gitModifiedSet(cwd);
    if (modified === null) {
      // git status fails in bare repos too — distinguish "no repo" from "no worktree".
      let bare = false;
      try { bare = (await runCmd("git", ["rev-parse", "--is-bare-repository"], cwd)).trim() === "true"; } catch { /* not a repo at all */ }
      throw new Error(bare ? "git:modified needs a worktree (bare repository)" : "git:modified requires a git repository (git status failed)");
    }
  }
  const scored: Array<{ p: string; s: number }> = [];
  for (const f of applyFindFilters(files, q, modified)) {
    const s = fuzzyScore(q.fuzzy, f);
    if (s !== Number.POSITIVE_INFINITY) scored.push({ p: f, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));
  return { paths: scored.map((e) => toNative(e.p)), scanned: files.length, backend };
}
/** Ranked file paths (workspace-relative, native separators), paged by limit/offset. */
export async function findPaths(query: string, opts: FindOptions = {}): Promise<string[]> {
  const scan = await findScanned(query, opts);
  return pageOf(scan.paths, opts.limit, opts.offset);
}
/** rg --vimgrep columns are BYTE offsets into the raw line; walker columns are
 * UTF-16 code units. Convert via the byte prefix of the decoded text. Fast
 * path: an all-ASCII prefix keeps byte col == char col. `text` is the raw
 * (untrimmed, un-sliced) row text; a byte col past its end (e.g. rg's
 * "[Omitted long matching line]" placeholder) passes through unchanged. */
function byteColToCharCol(text: string, byteCol: number): number {
  const n = byteCol - 1;
  if (n <= 0) return byteCol;
  // A byte col past the text's byte length (rg's "[Omitted long matching
  // line]" placeholder rows carry the real match col) passes through
  // unchanged — decoding a clamped prefix would mangle it to text.length+1.
  if (n > Buffer.byteLength(text, "utf8")) return byteCol;
  const prefix = text.slice(0, n);
  let ascii = prefix.length === n;
  if (ascii) for (let i = 0; i < prefix.length; i++) { if (prefix.charCodeAt(i) > 0x7f) { ascii = false; break; } }
  if (ascii) return byteCol;
  return Buffer.from(text, "utf8").subarray(0, n).toString("utf8").length + 1;
}
async function rgGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, timeoutMs: number, wholeWord = false, scope?: string): Promise<GrepMatch[]> {
  const args = ["--vimgrep", "--no-heading", "--no-messages", "--max-columns", "500", "--max-filesize", MAX_GREP_SIZE, follow ? "--follow" : "--no-follow"];
  if (literal) args.push("--fixed-strings");
  if (ignoreCase) args.push("--ignore-case");
  if (wholeWord) args.push("--word-regexp"); // composes with --fixed-strings: literal whole words, no regex needed
  const root = normalizeScope(scope);
  args.push("--", pattern, root === undefined ? "." : toNative(root));
  const out: GrepMatch[] = [];
  // Collect ALL rows — no early cap. rg's parallel emit order varies run to
  // run, so slicing the first GREP_CAP rows here would hand grepContents a
  // nondeterministic subset to sort (cursor resume would dupe/skip). The cap
  // is applied post-sort in grepContents; stdout is already bounded by the
  // 64MB maxBuffer, which is recoverable to the walker.
  for (const line of (await runCmd("rg", args, cwd, timeoutMs)).split(/\r?\n/)) {
    if (!line) continue;
    // [^\n] (not .) so a lone \r inside a matched line can't sink the row;
    // \r is stripped from the emitted text for walker parity.
    const m = /^([^\n]*?):(\d+):(\d+):([^\n]*)$/.exec(line);
    if (m) out.push({ path: toNative(stripDotSlash(m[1].replace(/\\/g, "/"))), line: Number(m[2]), col: byteColToCharCol(m[4], Number(m[3])), text: m[4].replace(/\r/g, "").trim().slice(0, 500) });
  }
  return out;
}
/** Pattern text embedded in `invalid regex` errors, truncated so a 64KB+
 * pattern can't produce a 64KB+ message (the raw-V8-message bug in miniature). */
const patForMsg = (p: string): string => (p.length > 200 ? `${p.slice(0, 200)}…` : p);
/** Regex walk+scan shared by the worker thread (grep-worker.ts imports this).
 * Exported for the worker and for tests comparing worker output to the inline
 * scan; not part of the tool contract. */
export async function walkerRegexGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, deadline = 0, timeoutMs = 0, wholeWord = false, scope?: string): Promise<GrepMatch[]> {
  // Whole words need a regex even for literal patterns (escape first, then
  // wrap); a bare regex pattern wraps as-is. wordWrap applies \b only at
  // word-char edges — punctuation-edged patterns get [\w$] lookarounds so
  // `cat.`/`.cat` match like rg -w. Global flag: one row per MATCH (rg parity),
  // not one row per line. Patterns using \p{…}/\u{…} need the u flag or the
  // escapes silently go dead.
  const src = literal ? escapeRegExp(pattern) : pattern;
  const wrapped = wholeWord ? wordWrap(src) : src;
  const wantsU = /\\[pu]\{/.test(src);
  const flags = (ignoreCase ? "gi" : "g") + (wantsU ? "u" : "");
  let re: RegExp;
  try { re = new RegExp(wrapped, flags); }
  catch (err) {
    // u-flag SyntaxError (e.g. `\p{Lu}\ ` — identity escapes are illegal under
    // u): retry without u. The pattern still runs; \p{…} degrades to a literal
    // class, matching rg's acceptance of the same source.
    if (wantsU && err instanceof SyntaxError) {
      try { re = new RegExp(wrapped, ignoreCase ? "gi" : "g"); }
      catch { throw new Error(`invalid regex: ${patForMsg(pattern)}`); }
    } else throw new Error(`invalid regex: ${patForMsg(pattern)}`);
  }
  // V8 lazy-compiles: `new RegExp` can succeed on a 64KB+ source and only throw
  // at first exec — inside the worker, surfacing the raw V8 message. Force the
  // compile here so the normalized `invalid regex` error fires at preflight.
  try { re.exec(""); }
  catch (err) {
    if (err instanceof SyntaxError) throw new Error(`invalid regex: ${patForMsg(pattern)}`);
    throw err;
  }
  re.lastIndex = 0;
  const out: GrepMatch[] = [];
  for (const f of await walkFiles(cwd, follow, deadline, timeoutMs, scope)) {
    checkDeadline(deadline, timeoutMs); // per file batch: abort the orphaned scan between reads
    let text: string | null;
    try {
      if ((await fs.stat(path.join(cwd, f))).size > MAX_GREP_BYTES) continue; // oversized skip
      text = decodeGrepText(await fs.readFile(path.join(cwd, f)));
    } catch { continue; }
    if (text === null) continue; // binary skip
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const snippet = lines[i].replace(/\r/g, "").trim().slice(0, 500); // strip \r: \r-only files embed raw CRs that overwrite terminal rows
      const lastNoEol = i === lines.length - 1 && !text.endsWith("\n");
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      for (;;) {
        try { m = re.exec(lines[i]); }
        catch (err) {
          // A lazy-compile SyntaxError that slipped past the preflight exec
          // reports the normalized message, never raw V8 text.
          if (err instanceof SyntaxError) throw new Error(`invalid regex: ${patForMsg(pattern)}`);
          throw err;
        }
        if (m === null) break;
        // rg omits the terminal zero-width position on a file-final line that
        // has no trailing newline (the walker used to emit lastLine:len+1).
        if (m[0] === "" && lastNoEol && m.index === lines[i].length) break;
        out.push({ path: toNative(f), line: i + 1, col: m.index + 1, text: snippet });
        if (out.length >= GREP_CAP) return out;
        if (m[0] === "") { re.lastIndex = m.index + 1; if (re.lastIndex > lines[i].length) break; } // zero-width rows still emit (rg parity for ^, ^$, z*)
      }
    }
  }
  return out;
}
/** Regex walker scan off-thread: a catastrophic pattern can starve the event
 * loop, which would keep grepContents' timeout race from ever firing. The
 * worker is terminated at the deadline; spawn failure propagates as a normal
 * error — never an inline fallback, which would reintroduce the hang. */
function workerGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, timeoutMs: number, wholeWord: boolean, scope?: string): Promise<GrepMatch[]> {
  const { promise, resolve, reject } = Promise.withResolvers<GrepMatch[]>();
  const worker = new Worker(new URL("./grep-worker.js", import.meta.url), {
    workerData: { cwd, pattern, literal, ignoreCase, follow, timeoutMs, wholeWord, scope },
  });
  worker.unref(); // a stuck worker must not pin the parent process open
  let settled = false;
  const done = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void worker.terminate();
    fn();
  };
  const timer = setTimeout(() => done(() => reject(new Error(`grep timed out after ${timeoutMs / 1000}s`))), timeoutMs);
  worker.once("message", (msg: { matches?: GrepMatch[]; error?: string }) =>
    done(() => (msg && typeof msg.error === "string" ? reject(new Error(msg.error)) : resolve(msg?.matches ?? []))));
  worker.once("error", (err) => done(() => reject(err)));
  worker.once("exit", (code) => done(() => reject(new Error(`grep worker exited with code ${code}`))));
  return promise;
}
async function fallbackGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, deadline = 0, timeoutMs = 0, wholeWord = false, scope?: string): Promise<GrepMatch[]> {
  if (!literal || wholeWord || ignoreCase) {
    // Regex scan runs in a worker: a catastrophic pattern would otherwise hang
    // the event loop and the timeout race could never fire. Spawn failure
    // propagates — silently falling back inline would reintroduce the hang.
    // Literal+ignoreCase rides along: an escaped literal can't hang, and the
    // 'gi' regex fold avoids toLowerCase/indexOf over-matching (Turkish İ) and
    // length-shifting folds that would corrupt columns.
    return workerGrep(cwd, pattern, literal, ignoreCase, follow, timeoutMs, wholeWord, scope);
  }
  // Literal case-sensitive scan stays inline: indexOf cannot hang, so no worker.
  const out: GrepMatch[] = [];
  for (const f of await walkFiles(cwd, follow, deadline, timeoutMs, scope)) {
    checkDeadline(deadline, timeoutMs); // per file batch: abort the orphaned scan between reads
    let text: string | null;
    try {
      if ((await fs.stat(path.join(cwd, f))).size > MAX_GREP_BYTES) continue; // oversized skip
      text = decodeGrepText(await fs.readFile(path.join(cwd, f)));
    } catch { continue; }
    if (text === null) continue; // binary skip
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const snippet = lines[i].replace(/\r/g, "").trim().slice(0, 500); // strip \r: \r-only files embed raw CRs that overwrite terminal rows
      const hay = lines[i];
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(pattern, from);
        if (idx < 0) break;
        out.push({ path: toNative(f), line: i + 1, col: idx + 1, text: snippet });
        if (out.length >= GREP_CAP) return out;
        from = idx + (pattern.length > 0 ? pattern.length : 1);
        if (from > hay.length) break;
      }
    }
  }
  return out;
}
/** Context window cap: contextBefore/contextAfter clamp to 0..5, default 0. */
export function clampContext(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.floor(n)));
}
/** Slice ±N surrounding lines onto each match (rg --vimgrep drops -B/-C, so both
backends share this file-slicing pass; each file is read once). Never throws. */
export async function attachContext(cwdDir: string | undefined, matches: GrepMatch[], before: number, after: number): Promise<void> {
  const cb = clampContext(before), ca = clampContext(after);
  if ((cb === 0 && ca === 0) || matches.length === 0) return;
  const cwd = path.resolve(cwdDir ?? process.cwd());
  const cache = new Map<string, string[]>();
  for (const m of matches) {
    let lines = cache.get(m.path);
    if (lines === undefined) {
      try {
        if ((await fs.stat(path.join(cwd, m.path))).size > MAX_GREP_BYTES) continue;
        const text = decodeGrepText(await fs.readFile(path.join(cwd, m.path)));
        if (text === null) continue; // binary skip
        lines = splitLines(text);
      } catch { continue; }
      cache.set(m.path, lines);
    }
    if (cb > 0) m.before = lines.slice(Math.max(0, m.line - 1 - cb), m.line - 1).map((t) => t.trim().slice(0, 500));
    if (ca > 0) m.after = lines.slice(m.line, m.line + ca).map((t) => t.trim().slice(0, 500));
  }
}
/** Enclosing-symbol attribution (goldmine pick 8): one `outlineFile` depth-0
pass per file-with-hits, each match attributed to the nearest symbol at/above
its line. Outline misses (unreadable/binary/symbol-free files) leave the match
untagged — never throws. Only runs on request (`expand: "function"`). */
export async function attachEnclosing(cwdDir: string | undefined, matches: GrepMatch[]): Promise<void> {
  if (matches.length === 0) return;
  const cwd = path.resolve(cwdDir ?? process.cwd());
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const bucket = byFile.get(m.path);
    if (bucket) bucket.push(m);
    else byFile.set(m.path, [m]);
  }
  for (const [file, ms] of byFile) {
    let symbols: OutlineSymbol[];
    try {
      symbols = (await outlineFile(file, { cwd, depth: 0 })).symbols;
    } catch { continue; }
    if (symbols.length === 0) continue;
    for (const m of ms) {
      let best: OutlineSymbol | undefined;
      for (const s of symbols) {
        if (s.line <= m.line) best = s;
        else break;
      }
      if (best) m.enclosing = { kind: best.kind, name: best.name, line: best.line };
    }
  }
}
export async function grepContents(pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  await assertCwdExists(cwd);
  if (!pattern) throw new Error("grep pattern must not be empty");
  const literal = opts.literal ?? true;
  // rg accepts a leading (?i) inline flag; JS RegExp doesn't. Translate it to
  // ignoreCase and strip it before the JS preflight — only at position 0, so
  // mid-pattern inline flags keep erroring like before.
  let pat = pattern;
  let inlineIgnoreCase = false;
  if (!literal && pat.startsWith("(?i)")) { pat = pat.slice(4); inlineIgnoreCase = true; }
  if (!literal) {
    try {
      const pre = new RegExp(pat);
      // V8 lazy-compiles: a 64KB+ source can pass construction and only throw
      // at first exec — force it here so the normalized error fires now.
      pre.exec("");
    } catch { throw new Error(`invalid regex: ${patForMsg(pattern)}`); }
  }
  const follow = opts.followSymlinks ?? false;
  // smartCase is opt-in and wins when enabled: lowercase patterns match
  // case-insensitively, any uppercase letter restores sensitivity. ignoreCase
  // keeps working exactly as before when smartCase is off; a leading (?i)
  // inline flag forces insensitive matching on top of either.
  const ignoreCase = inlineIgnoreCase || (opts.smartCase === true ? !/[A-Z]/.test(pat) : (opts.ignoreCase ?? false));
  const wholeWord = opts.wholeWord ?? false;
  const timeoutMs = opts.timeoutMs ?? GREP_TIMEOUT_DEFAULT;
  const deadline = Date.now() + timeoutMs; // cooperative abort for the walker path
  const run = (async (): Promise<GrepResult> => {
    let matches: GrepMatch[];
    let backend: ScanBackend;
    if (opts.scan === "mock") { matches = await fallbackGrep(cwd, pat, literal, ignoreCase, follow, deadline, timeoutMs, wholeWord, opts.scope); backend = "walker"; }
    else {
      try { matches = await rgGrep(cwd, pat, literal, ignoreCase, follow, timeoutMs, wholeWord, opts.scope); backend = "rg"; }
      catch (err) {
        if (!rgRecoverable(err)) throw err;
        matches = await fallbackGrep(cwd, pat, literal, ignoreCase, follow, deadline, timeoutMs, wholeWord, opts.scope); backend = "walker";
      }
    }
    // Deterministic page order on both backends: rg stdout order varies run to
    // run, so cursor resume (re-fetch + re-slice) would dupe/skip rows. Sort by
    // path, then line, then col on the forward-slash form rows render in, so
    // win32 backslash ordering cannot wobble. Same shape as callersOf's sort.
    matches.sort((a, b) => {
      const ap = a.path.replace(/\\/g, "/"), bp = b.path.replace(/\\/g, "/");
      return ap < bp ? -1 : ap > bp ? 1 : a.line - b.line || a.col - b.col;
    });
    // The hard cap lands AFTER the sort: rgGrep collects its full stdout (the
    // parallel emit order is nondeterministic, so capping pre-sort would make
    // the kept subset — and every cursor chain over it — unstable). The walker
    // already capped during collection; this slice is a no-op for it.
    if (matches.length > GREP_CAP) matches = matches.slice(0, GREP_CAP);
    return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length, backend, capped: matches.length >= GREP_CAP || undefined };
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const overdue = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`grep timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    const res = await Promise.race([run, overdue]);
    await attachContext(opts.cwd, res.matches, opts.contextBefore ?? 0, opts.contextAfter ?? 0);
    if (opts.expand === "function") await attachEnclosing(opts.cwd, res.matches);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
export interface CallersOptions { cwd?: string; limit?: number; offset?: number; ignoreCase?: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; contextBefore?: number; contextAfter?: number; depth?: 1 | 2 | 3 }
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Identifier-aware symbol boundaries: `$` is a word char here (JS identifiers),
 * so `$foo` resolves and `foo` never matches inside `$foo`/`foo$bar`. Edges are
 * conditional: a word-char edge stays `\b` (rg-compatible); a non-word edge uses
 * a `[\w$]` lookaround — rg rejects look-arounds, so those patterns recover to
 * the walker, which is still correct (previously they silently matched nothing).
 * The edge test reads the ESCAPED char against `\w` (not `[\w$]`): escaping only
 * prefixes non-word chars, so esc's edge char is `\w` iff the raw symbol's is.
 * Testing `[\w$]` would misread a `\$` edge as a word edge and emit a `\b` that
 * can never match (`foo$ ` has no word/non-word transition). */
function symBound(esc: string): string {
  const l = /^\w/.test(esc) ? "\\b" : "(?<![\\w$])";
  const r = /\w$/.test(esc) ? "\\b" : "(?![\\w$])";
  return `${l}${esc}${r}`;
}
/** rg -w parity for punctuation-edged patterns: `\b` only at edges that begin or
 * end with a word char; non-word edges use `[\w$]` lookarounds instead (a bare
 * `\b` wrap fails `cat.`/`.cat` — no boundary between two non-word chars). The
 * edge test is `\w` on the raw source char: a literal `\$`/`$` edge must take
 * the lookaround branch, not a `\b` that can never match. */
function wordWrap(src: string): string {
  const l = /^\w/.test(src) ? "\\b" : "(?<![\\w$])";
  const r = /\w$/.test(src) ? "\\b" : "(?![\\w$])";
  return `${l}(?:${src})${r}`;
}
/** File text → lines without the phantom element `split("\n")` leaves after a
 * trailing newline (rg sees no line there; an empty file has none either). */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
/** One ring of the callers matcher: the 3 text-heuristic patterns for a single
symbol, definition lines filtered, merged/deduped into `seen` (visited
`path:line` set doubles as the BFS cycle guard). Hard-capped by GREP_CAP. */
async function directCallers(sym: string, base: { cwd?: string; ignoreCase: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number }, seen: Map<string, GrepMatch>, ring: number): Promise<{ backend: ScanBackend; fresh: GrepMatch[] }> {
  const esc = escapeRegExp(sym);
  const bound = symBound(esc); // $foo resolves: $ counts as an identifier char here
  const rightEdge = /\w$/.test(esc) ? "\\b" : "(?![\\w$])";
  const patterns = [`${bound}\\s*\\(`, `(?:import|from|require|use|include)\\b[^\\n]*${bound}`, `\\.${esc}${rightEdge}`];
  const defRe = new RegExp(`^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+)*(?:function|def|fn|func|class)\\b[^\\n]*${bound}`);
  // rg's \b only sees \w, so `\bfoo\b\s*\(` matches inside `$foo(`/`foo$bar(` —
  // and the rg patterns can't use lookarounds (rg rejects them → walker for
  // every callers call). Post-filter instead: a row only survives when the
  // trimmed line text shows a real identifier-boundary call or import site.
  // Member-access rows (`\.esc`) need no left-edge check — the literal dot is
  // never an identifier char.
  const flags = base.ignoreCase ? "i" : "";
  const verifyCall = new RegExp(`(?<![\\w$])${esc}(?![\\w$])\\s*\\(`, flags);
  const verifyImport = new RegExp(`(?:import|from|require|use|include)\\b[^\\n]*(?<![\\w$])${esc}(?![\\w$])`, flags);
  const verify = [verifyCall, verifyImport, null];
  // m.text is the 500-char-sliced row text — a call site past col 500 (or rg's
  // "[Omitted long matching line]" placeholder) can't be verified against it.
  // Re-read the full line once per file when the slice can't decide.
  const cwdDir = path.resolve(base.cwd ?? process.cwd());
  const lineCache = new Map<string, string[] | null>();
  const fullLine = async (m: GrepMatch): Promise<string | undefined> => {
    let lines = lineCache.get(m.path);
    if (lines === undefined) {
      try {
        if ((await fs.stat(path.join(cwdDir, m.path))).size > MAX_GREP_BYTES) lines = null;
        else lines = splitLines(decodeGrepText(await fs.readFile(path.join(cwdDir, m.path))) ?? "");
      } catch { lines = null; }
      lineCache.set(m.path, lines);
    }
    return lines?.[m.line - 1];
  };
  let backend: ScanBackend = "rg";
  const fresh: GrepMatch[] = [];
  for (let pi = 0; pi < patterns.length; pi++) {
    const r = await grepContents(patterns[pi], { ...base, literal: false });
    backend = r.backend;
    const v = verify[pi];
    for (const m of r.matches) {
      if (v !== null && !v.test(m.text)) {
        const line = await fullLine(m);
        if (line === undefined || !v.test(line)) continue;
      }
      if (defRe.test(m.text)) continue;
      const key = `${m.path}:${m.line}`;
      if (seen.has(key)) continue;
      if (seen.size >= GREP_CAP) return { backend, fresh };
      m.depth = ring;
      m.via = sym;
      seen.set(key, m);
      fresh.push(m);
    }
    if (seen.size >= GREP_CAP) break;
  }
  return { backend, fresh };
}
/** Enclosing depth-1 symbol names for a ring of caller sites (outline misses
yield nothing — import-level and module-scope sites simply expand no further). */
async function enclosingNames(cwdDir: string | undefined, sites: GrepMatch[]): Promise<string[]> {
  if (sites.length === 0) return [];
  const cwd = path.resolve(cwdDir ?? process.cwd());
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of sites) {
    const bucket = byFile.get(m.path);
    if (bucket) bucket.push(m);
    else byFile.set(m.path, [m]);
  }
  const names: string[] = [];
  for (const [file, ms] of byFile) {
    let symbols: OutlineSymbol[];
    try {
      symbols = (await outlineFile(file, { cwd, depth: 1 })).symbols;
    } catch { continue; }
    for (const m of ms) {
      let best: OutlineSymbol | undefined;
      for (const s of symbols) {
        if (s.line <= m.line) best = s;
        else break;
      }
      if (best && best.name) names.push(best.name);
    }
  }
  return names;
}
/** Approximate "who calls X": literal-aware text heuristics (call parens, import
lines, member access), merged/deduped by path:line. Explicitly NOT LSP-accurate:
same-named locals and comments can match; definition lines are filtered out.
Callers confirm hits with read. `depth` 2|3 BFS-transitively follows each ring's
enclosing symbols (cycle-guarded by the visited path:line set, rings labeled
`depth:N` on every row, hard-capped by GREP_CAP); downstream callees are out of
scope. Default 1 keeps the single-ring shape. */
export async function callersOf(symbol: string, opts: CallersOptions = {}): Promise<GrepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  await assertCwdExists(cwd);
  if (!symbol) throw new Error("callers symbol must not be empty");
  const depth = opts.depth === 2 ? 2 : opts.depth === 3 ? 3 : 1;
  const seen = new Map<string, GrepMatch>();
  const base = { cwd: opts.cwd, ignoreCase: opts.ignoreCase ?? false, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
  let backend: ScanBackend = "rg";
  const queried = new Set<string>([opts.ignoreCase === true ? symbol.toLowerCase() : symbol]);
  let frontier: string[] = [symbol];
  for (let ring = 1; ring <= depth && frontier.length > 0 && seen.size < GREP_CAP; ring++) {
    const ringFresh: GrepMatch[] = [];
    const next: string[] = [];
    // Frontier symbols scan in parallel through a bounded pool: each
    // directCallers runs 3 full-tree greps, so sequential rings cost
    // 3×|frontier| scans (depth-2 on a wide tree took ~65s). Results land in
    // frontier order — the `seen` merge inside directCallers stays the single
    // writer, so dedup/cap semantics are unchanged.
    const results: Array<{ backend: ScanBackend; fresh: GrepMatch[] } | undefined> = new Array(frontier.length);
    let idx = 0;
    const POOL = 8;
    const workers = Array.from({ length: Math.min(POOL, frontier.length) }, async () => {
      while (idx < frontier.length && seen.size < GREP_CAP) {
        const i = idx++;
        results[i] = await directCallers(frontier[i], base, seen, ring);
      }
    });
    await Promise.all(workers);
    for (const r of results) {
      if (!r) continue;
      backend = r.backend;
      ringFresh.push(...r.fresh);
    }
    if (ring < depth && seen.size < GREP_CAP) {
      for (const name of await enclosingNames(opts.cwd, ringFresh)) {
        const key = opts.ignoreCase === true ? name.toLowerCase() : name;
        if (!queried.has(key)) {
          queried.add(key);
          next.push(name);
        }
      }
    }
    frontier = next;
  }
  const merged = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  const page = pageOf(merged, opts.limit, opts.offset);
  await attachContext(opts.cwd, page, opts.contextBefore ?? 0, opts.contextAfter ?? 0);
  return { matches: page, total: merged.length, backend, capped: seen.size >= GREP_CAP || undefined };
}
/** Tools-side path rule mirrored for capsule scoping (dir/ prefix, glob, or bare name). */
function matchPathFilter(p: string, filter: string): boolean {
  const d = p.replace(/\\/g, "/");
  const flat = filter.replace(/\\/g, "/");
  const f = flat.startsWith("./") ? flat.slice(2) : flat;
  if (f.endsWith("/")) {
    const dir = f.slice(0, -1);
    return d === dir || d.startsWith(`${dir}/`);
  }
  if (/[*?[{]/.test(f)) {
    const re = globToRegExp(f);
    return re.test(d) || re.test(d.slice(d.lastIndexOf("/") + 1));
  }
  return d === f || d.startsWith(`${f}/`) || d.slice(d.lastIndexOf("/") + 1) === f;
}
/** ffmap core: ranked per-file depth-0 outlines for a fitted repo overview.
 * Fresh scan every call (no index): one walker/rg listing, one git status,
 * one text read per file for import-centrality plus one outline pass.
 * Ranking inputs (frecency re-rank happens tools-side) are returned raw:
 * `modified` (git porcelain membership) and `inDegree` (importer count over
 * approximate import-specifier extractors — centrality only, never shown). */
export interface MapFile { path: string; symbols: OutlineSymbol[]; modified: boolean; inDegree: number }
export interface MapResult { files: MapFile[]; total: number; scanned: number; backend: ScanBackend }
export interface MapOptions { cwd?: string; scan?: string; followSymlinks?: boolean }
/** Import-specifier extractors (approximate — centrality only, never shown). */
const IMPORT_RES: RegExp[] = [
  /(?:import|from)\s+['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /from\s+(\S+)\s+import\s/g,
  /import\s+([\w.]+)/g,
  /#include\s+[<"]([^>"]+)[">]/g,
  /\buse\s+([\w:]+)/g,
];
/** Module key: last segment minus one extension (`./dir/search.js` → `search`). */
function moduleKey(spec: string): string {
  const seg = spec.split(/[\\/]/).pop() ?? spec;
  const dot = seg.lastIndexOf(".");
  return (dot > 0 ? seg.slice(0, dot) : seg).toLowerCase();
}
/** File key on the same terms, so `from search import` meets search.ts. */
function fileKeyOf(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}
export async function rankMap(opts: MapOptions = {}): Promise<MapResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  await assertCwdExists(cwd);
  const { files, backend } = await listFiles(cwd, opts.scan, opts.followSymlinks ?? false);
  const modified = await gitModifiedSet(cwd);
  const importers = new Map<string, Set<string>>();
  const texts = new Map<string, string>();
  for (const f of files) {
    let text: string;
    try {
      if ((await fs.stat(path.join(cwd, f))).size > MAX_GREP_BYTES) continue;
      const buf = await fs.readFile(path.join(cwd, f));
      if (buf.indexOf(0) >= 0) continue;
      text = buf.toString("utf8");
    } catch { continue; }
    texts.set(f, text);
    const specs = new Set<string>();
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) if (m[1]) specs.add(moduleKey(m[1]));
    }
    for (const s of specs) {
      let set = importers.get(s);
      if (!set) { set = new Set<string>(); importers.set(s, set); }
      set.add(f);
    }
  }
  const out: MapFile[] = [];
  for (const f of texts.keys()) {
    let symbols: OutlineSymbol[] = [];
    try { symbols = (await outlineFile(f, { cwd, depth: 0 })).symbols; } catch { symbols = []; }
    let inDegree = 0;
    const set = importers.get(fileKeyOf(f));
    if (set) for (const imp of set) if (imp !== f) inDegree++;
    out.push({ path: toNative(f), symbols, modified: modified !== null && modified.has(f), inDegree });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: out, total: out.length, scanned: files.length, backend };
}
/** ffcapsule core: fused symbol dossier from existing cores only (no new scan
 * machinery). Definition = first name-matching non-import depth-1 outline row
 * (methods included — a depth-0 pass can't see them) across the most-mentioned
 * candidate files (capped at 30); doc = up to 5 contiguous comment lines above
 * it; callers/imports = bounded live queries. */
export interface CapsuleResult {
  symbol: string; found: boolean;
  defFile?: string; defLine?: number; defKind?: string;
  doc: string[]; callers: GrepMatch[]; imports: GrepMatch[];
  filesInvolved: number; backend: ScanBackend;
}
export interface CapsuleOptions { cwd?: string; ignoreCase?: boolean; pathFilter?: string; limit?: number; scan?: string; followSymlinks?: boolean; timeoutMs?: number }
export async function capsuleOf(symbol: string, opts: CapsuleOptions = {}): Promise<CapsuleResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  await assertCwdExists(cwd);
  if (!symbol) throw new Error("capsule symbol must not be empty");
  const ignoreCase = opts.ignoreCase ?? false;
  const eq = (a: string, b: string): boolean => ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const esc = escapeRegExp(symbol);
  const bound = symBound(esc); // $foo resolves: $ counts as an identifier char here
  const base = { cwd: opts.cwd, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
  const mentions = await grepContents(bound, { ...base, literal: false, ignoreCase });
  const inScope = (p: string): boolean => !opts.pathFilter || matchPathFilter(p.replace(/\\/g, "/"), opts.pathFilter);
  const byFile = new Map<string, number>();
  for (const m of mentions.matches) {
    const p = m.path.replace(/\\/g, "/");
    if (inScope(p)) byFile.set(m.path, (byFile.get(m.path) ?? 0) + 1);
  }
  const ordered = [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 30);
  // A def in a file outside the top-30 mention files used to be unreachable:
  // seed candidates with a definition-shaped grep so such files get outlined too.
  const defHits = await grepContents(`(?:function|class|const|let|var|def|fn|func|interface|type|struct|enum|impl)\\b[^\\n]*${bound}`, { ...base, literal: false, ignoreCase });
  for (const m of defHits.matches) {
    if (ordered.length >= 60) break;
    if (inScope(m.path.replace(/\\/g, "/")) && !ordered.includes(m.path)) ordered.push(m.path);
  }
  let def: { file: string; line: number; kind: string } | undefined;
  for (const f of ordered) {
    // depth 1: methods (constructor, toString, …) are nested symbols — a
    // depth-0 pass can never see them, so capsuleOf('constructor') missed.
    let syms: OutlineSymbol[];
    try { syms = (await outlineFile(f, { cwd, depth: 1 })).symbols; } catch { continue; }
    const hit = syms.find((s) => eq(s.name, symbol) && s.kind !== "import") ?? syms.find((s) => eq(s.name, symbol));
    if (hit) { def = { file: f, line: hit.line, kind: hit.kind || "symbol" }; break; }
  }
  const doc: string[] = [];
  if (def) {
    try {
      const text = (await fs.readFile(path.join(cwd, def.file), "utf8")).split("\n");
      for (let i = def.line - 2; i >= Math.max(0, def.line - 7); i--) {
        const t = (text[i] ?? "").trim();
        if (/^(\/\/|#|\*|\/\*|--|"""|'''|;)/.test(t)) doc.unshift(text[i].replace(/\s+$/, ""));
        else break;
      }
    } catch { /* no doc without a readable file */ }
  }
  const lim = Math.min(Math.max(opts.limit ?? 10, 1), PAGE_MAX);
  const callers = await callersOf(symbol, { ...base, ignoreCase, limit: lim });
  const imp = await grepContents(`(?:import|from|require|use|include)\\b[^\\n]*${bound}`, { ...base, literal: false, ignoreCase, limit: lim });
  const files = new Set<string>();
  if (def) files.add(def.file);
  for (const m of callers.matches) if (inScope(m.path.replace(/\\/g, "/"))) files.add(m.path);
  for (const m of imp.matches) if (inScope(m.path.replace(/\\/g, "/"))) files.add(m.path);
  return {
    symbol, found: def !== undefined || callers.total > 0 || imp.total > 0,
    defFile: def?.file, defLine: def?.line, defKind: def?.kind, doc,
    callers: callers.matches.filter((m) => inScope(m.path.replace(/\\/g, "/"))),
    imports: imp.matches.filter((m) => inScope(m.path.replace(/\\/g, "/"))),
    filesInvolved: files.size, backend: mentions.backend,
  };
}
/** Best-effort warm scan (no watcher/index — primes the OS cache). Never throws. */
export async function warmScan(): Promise<void> {
  try { await findPaths("", { limit: 1 }); } catch { /* warm scan never fails session start */ }
}
/** Fresh rg presence + version and serving backend for `/find-health` (string form, read synchronously). */
export function status(): string {
  try {
    const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
    if (r.status === 0) {
      const version = r.stdout.split("\n")[0].trim();
      return `rg: ${version}; backend: rg; index: none (fresh scan, no watcher)`;
    }
    // rg resolved on PATH but failed: spawn error (EACCES/EINVAL) or a
    // nonzero exit — report it as present-but-broken, not missing.
    if (r.error) {
      const code = errCode(r.error);
      if (code === "ENOENT") return "rg: missing; backend: walker (fallback); index: none (fresh scan, no watcher)";
      return `rg: present but failed (${String(code ?? r.error.message)}); backend: walker (fallback); index: none (fresh scan, no watcher)`;
    }
    return `rg: present but failed (exit ${String(r.status ?? r.signal)}); backend: walker (fallback); index: none (fresh scan, no watcher)`;
  } catch { /* synchronous spawn throw → treated as missing below */ }
  return "rg: missing; backend: walker (fallback); index: none (fresh scan, no watcher)";
}
/** Drop caches (nothing persistent — resolves for the `/find-rescan` contract). */
export async function clearCache(): Promise<void> {}
/** ffoutline core lives in outline.ts; re-exported here so the tool layer's
`search` dep carries it without extra host wiring. */
export { outlineFile } from "./outline.js";
export type { OutlineSymbol, OutlineResult, OutlineOptions } from "./outline.js";
/** ffstructural core lives in structural.ts; re-exported here so the tool layer's
`search` dep carries it without extra host wiring (same shape as outlineFile). */
export { compileStructural, structuralGrep, previewRewrite, normalizeLanguage } from "./structural.js";
export type { CompiledStructural, StructuralMode, StructuralOptions } from "./structural.js";
