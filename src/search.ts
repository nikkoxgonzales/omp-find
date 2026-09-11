/** omp-find core search: rg-backed listing/grep with a TS walker fallback. Node builtins only. */
import { execFile, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { outlineFile } from "./outline.js";
import type { OutlineSymbol } from "./outline.js";
export const PAGE_DEFAULT = 30, PAGE_MAX = 50;
const RG_BUFFER = 64 * 1024 * 1024, GREP_CAP = 20000, MAX_DEPTH = 25;
/** Per-file ceiling for content scans (fallback stat skip + rg --max-filesize); oversized files never match. */
const MAX_GREP_BYTES = 2 * 1024 * 1024, MAX_GREP_SIZE = "2M";
/** Default wall-clock budget for one grep call (overridable via GrepOptions.timeoutMs). */
const GREP_TIMEOUT_DEFAULT = 30000;
export interface ParsedFindQuery { fuzzy: string; dirPrefix?: string; extGlobs: string[]; excludes: string[]; gitModifiedOnly: boolean }
export interface FindOptions { cwd?: string; limit?: number; offset?: number; scan?: string; followSymlinks?: boolean }
export interface GrepOptions { cwd?: string; limit?: number; offset?: number; literal?: boolean; ignoreCase?: boolean; wholeWord?: boolean; smartCase?: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; contextBefore?: number; contextAfter?: number }
export interface GrepMatch { path: string; line: number; col: number; text: string; before?: string[]; after?: string[] }
export interface GrepResult { matches: GrepMatch[]; total: number; backend: ScanBackend }
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
/** Cooperative deadline: the timeout race already rejected, so stop burning CPU
after the budget (rg is kill-guarded; the walker is not). Throws timeout text. */
function checkDeadline(deadline: number, timeoutMs: number): void {
  if (deadline > 0 && Date.now() > deadline) throw new Error(`grep timed out after ${timeoutMs / 1000}s`);
}
async function walkFiles(cwd: string, follow: boolean, deadline = 0, timeoutMs = 0): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true }); } catch { return; }
    checkDeadline(deadline, timeoutMs); // per directory batch: abort the orphaned scan, don't finish the tree
    for (const e of entries) {
      if (e.isSymbolicLink() && !follow) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink() && follow) {
        try { isDir = (await fs.stat(path.join(cwd, dir, e.name))).isDirectory(); } catch { continue; }
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (isDir) { if (e.name !== "node_modules" && e.name !== ".git" && !e.name.startsWith(".")) await walk(path.join(dir, e.name), relPath, depth + 1); }
      else out.push(relPath);
    }
  }
  await walk(".", "", 0);
  return out;
}
async function listFiles(cwd: string, scan: string | undefined, follow: boolean): Promise<{ files: string[]; backend: ScanBackend }> {
  if (scan !== "mock") {
    try {
      const stdout = await runCmd("rg", ["--files", "--no-messages", follow ? "--follow" : "--no-follow", "."], cwd);
      return { files: stdout.split("\n").map((l) => stripDotSlash(l.trim().replace(/\\/g, "/"))).filter(Boolean), backend: "rg" };
    } catch (err) { if (errCode(err) !== "ENOENT") throw err; }
  }
  return { files: await walkFiles(cwd, follow), backend: "walker" };
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
  const q = parseFindQuery(query);
  const { files, backend } = await listFiles(cwd, opts.scan, opts.followSymlinks ?? false);
  let modified: Set<string> | null = null;
  if (q.gitModifiedOnly) {
    modified = await gitModifiedSet(cwd);
    if (modified === null) throw new Error("git:modified requires a git repository (git status failed)");
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
async function rgGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, timeoutMs: number, wholeWord = false): Promise<GrepMatch[]> {
  const args = ["--vimgrep", "--no-heading", "--no-messages", "--max-columns", "500", "--max-filesize", MAX_GREP_SIZE, follow ? "--follow" : "--no-follow"];
  if (literal) args.push("--fixed-strings");
  if (ignoreCase) args.push("--ignore-case");
  if (wholeWord) args.push("--word-regexp"); // composes with --fixed-strings: literal whole words, no regex needed
  args.push("--", pattern, ".");
  const out: GrepMatch[] = [];
  for (const line of (await runCmd("rg", args, cwd, timeoutMs)).split(/\r?\n/)) {
    if (!line) continue;
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (m) out.push({ path: toNative(stripDotSlash(m[1].replace(/\\/g, "/"))), line: Number(m[2]), col: Number(m[3]), text: m[4].trim().slice(0, 500) });
  }
  return out;
}
async function fallbackGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean, deadline = 0, timeoutMs = 0, wholeWord = false): Promise<GrepMatch[]> {
  let re: RegExp | null = null;
  if (!literal || wholeWord) {
    // Whole words need a regex even for literal patterns (escape first, then
    // wrap); a bare regex pattern wraps as-is. ASCII \b: patterns that start
    // or end with a non-word char may not match — same as rg -w.
    try { re = new RegExp(wholeWord ? `\\b(?:${literal ? escapeRegExp(pattern) : pattern})\\b` : pattern, ignoreCase ? "i" : ""); } catch { throw new Error(`invalid regex: ${pattern}`); }
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const out: GrepMatch[] = [];
  for (const f of await walkFiles(cwd, follow, deadline, timeoutMs)) {
    checkDeadline(deadline, timeoutMs); // per file batch: abort the orphaned scan between reads
    let text: string;
    try {
      if ((await fs.stat(path.join(cwd, f))).size > MAX_GREP_BYTES) continue; // oversized skip
      const buf = await fs.readFile(path.join(cwd, f));
      if (buf.indexOf(0) >= 0) continue; // binary skip
      text = buf.toString("utf8");
    } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let col = -1;
      if (re) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m?.[0] !== undefined) col = (m.index ?? 0) + 1;
      } else {
        const idx = (ignoreCase ? lines[i].toLowerCase() : lines[i]).indexOf(needle);
        if (idx >= 0) col = idx + 1;
      }
      if (col > 0) {
        out.push({ path: toNative(f), line: i + 1, col, text: lines[i].trim().slice(0, 500) });
        if (out.length >= GREP_CAP) return out;
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
        const buf = await fs.readFile(path.join(cwd, m.path));
        if (buf.indexOf(0) >= 0) continue; // binary skip
        lines = buf.toString("utf8").split("\n");
      } catch { continue; }
      cache.set(m.path, lines);
    }
    if (cb > 0) m.before = lines.slice(Math.max(0, m.line - 1 - cb), m.line - 1).map((t) => t.trim().slice(0, 500));
    if (ca > 0) m.after = lines.slice(m.line, m.line + ca).map((t) => t.trim().slice(0, 500));
  }
}
export async function grepContents(pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  if (!pattern) throw new Error("grep pattern must not be empty");
  const literal = opts.literal ?? true;
  if (!literal) { try { new RegExp(pattern); } catch { throw new Error(`invalid regex: ${pattern}`); } }
  const follow = opts.followSymlinks ?? false;
  // smartCase is opt-in and wins when enabled: lowercase patterns match
  // case-insensitively, any uppercase letter restores sensitivity. ignoreCase
  // keeps working exactly as before when smartCase is off.
  const ignoreCase = opts.smartCase === true ? !/[A-Z]/.test(pattern) : (opts.ignoreCase ?? false);
  const wholeWord = opts.wholeWord ?? false;
  const timeoutMs = opts.timeoutMs ?? GREP_TIMEOUT_DEFAULT;
  const deadline = Date.now() + timeoutMs; // cooperative abort for the walker path
  const run = (async (): Promise<GrepResult> => {
    let matches: GrepMatch[];
    let backend: ScanBackend;
    if (opts.scan === "mock") { matches = await fallbackGrep(cwd, pattern, literal, ignoreCase, follow, deadline, timeoutMs, wholeWord); backend = "walker"; }
    else {
      try { matches = await rgGrep(cwd, pattern, literal, ignoreCase, follow, timeoutMs, wholeWord); backend = "rg"; }
      catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
        matches = await fallbackGrep(cwd, pattern, literal, ignoreCase, follow, deadline, timeoutMs, wholeWord); backend = "walker";
      }
    }
    return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length, backend };
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const overdue = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`grep timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    const res = await Promise.race([run, overdue]);
    await attachContext(opts.cwd, res.matches, opts.contextBefore ?? 0, opts.contextAfter ?? 0);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
export interface CallersOptions { cwd?: string; limit?: number; offset?: number; ignoreCase?: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; contextBefore?: number; contextAfter?: number }
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Approximate "who calls X": literal-aware text heuristics (call parens, import
lines, member access), merged/deduped by path:line. Explicitly NOT LSP-accurate:
same-named locals and comments can match; definition lines are filtered out.
Callers confirm hits with read. */
export async function callersOf(symbol: string, opts: CallersOptions = {}): Promise<GrepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  if (!symbol) throw new Error("callers symbol must not be empty");
  const esc = escapeRegExp(symbol);
  const patterns = [`\\b${esc}\\s*\\(`, `(?:import|from|require|use|include)\\b[^\\n]*\\b${esc}\\b`, `\\.${esc}\\b`];
  const defRe = new RegExp(`^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+)*(?:function|def|fn|func|class)\\b[^\\n]*\\b${esc}\\b`);
  const seen = new Map<string, GrepMatch>();
  const base = { cwd: opts.cwd, ignoreCase: opts.ignoreCase ?? false, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
  let backend: ScanBackend = "rg";
  for (const p of patterns) {
    const r = await grepContents(p, { ...base, literal: false });
    backend = r.backend;
    for (const m of r.matches) {
      if (defRe.test(m.text)) continue;
      const key = `${m.path}:${m.line}`;
      if (!seen.has(key)) seen.set(key, m);
    }
  }
  const merged = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  const page = pageOf(merged, opts.limit, opts.offset);
  await attachContext(opts.cwd, page, opts.contextBefore ?? 0, opts.contextAfter ?? 0);
  return { matches: page, total: merged.length, backend };
}
/** Tools-side path rule mirrored for capsule scoping (dir/ prefix, glob, or bare name). */
function matchPathFilter(p: string, filter: string): boolean {
  const d = p.replace(/\\/g, "/");
  const f = filter.startsWith("./") ? filter.slice(2) : filter;
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
 * machinery). Definition = first name-matching non-import depth-0 outline row
 * across the most-mentioned candidate files (capped at 30); doc = up to 5
 * contiguous comment lines above it; callers/imports = bounded live queries. */
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
  if (!symbol) throw new Error("capsule symbol must not be empty");
  const ignoreCase = opts.ignoreCase ?? false;
  const eq = (a: string, b: string): boolean => ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const esc = escapeRegExp(symbol);
  const base = { cwd: opts.cwd, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
  const mentions = await grepContents(`\\b${esc}\\b`, { ...base, literal: false, ignoreCase });
  const inScope = (p: string): boolean => !opts.pathFilter || matchPathFilter(p.replace(/\\/g, "/"), opts.pathFilter);
  const byFile = new Map<string, number>();
  for (const m of mentions.matches) {
    const p = m.path.replace(/\\/g, "/");
    if (inScope(p)) byFile.set(m.path, (byFile.get(m.path) ?? 0) + 1);
  }
  const ordered = [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 30);
  let def: { file: string; line: number; kind: string } | undefined;
  for (const f of ordered) {
    let syms: OutlineSymbol[];
    try { syms = (await outlineFile(f, { cwd, depth: 0 })).symbols; } catch { continue; }
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
  const imp = await grepContents(`(?:import|from|require|use|include)\\b[^\\n]*\\b${esc}\\b`, { ...base, literal: false, ignoreCase, limit: lim });
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
  } catch { /* rg missing → walker fallback below */ }
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
