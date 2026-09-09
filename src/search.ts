/** omp-find core search: rg-backed listing/grep with a TS walker fallback. Node builtins only. */
import { execFile, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
export const PAGE_DEFAULT = 30, PAGE_MAX = 50;
const RG_BUFFER = 64 * 1024 * 1024, GREP_CAP = 20000, MAX_DEPTH = 25;
export interface ParsedFindQuery { fuzzy: string; dirPrefix?: string; extGlobs: string[]; excludes: string[]; gitModifiedOnly: boolean }
export interface FindOptions { cwd?: string; limit?: number; offset?: number; scan?: string; followSymlinks?: boolean }
export interface GrepOptions { cwd?: string; limit?: number; offset?: number; literal?: boolean; ignoreCase?: boolean; scan?: string; followSymlinks?: boolean }
export interface GrepMatch { path: string; line: number; col: number; text: string }
export interface GrepResult { matches: GrepMatch[]; total: number }
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
function runCmd(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: RG_BUFFER }, (err, stdout) => {
      if (err && !(cmd === "rg" && errCode(err) === 1)) reject(err); else resolve(stdout ?? ""); // rg exit 1 = no matches
    });
  });
}
function pageOf<T>(arr: T[], limit: number | undefined, offset: number | undefined): T[] {
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
async function walkFiles(cwd: string, follow: boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true }); } catch { return; }
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
async function listFiles(cwd: string, scan: string | undefined, follow: boolean): Promise<string[]> {
  if (scan !== "mock") {
    try {
      const stdout = await runCmd("rg", ["--files", "--no-messages", follow ? "--follow" : "--no-follow"], cwd);
      return stdout.split("\n").map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean);
    } catch (err) { if (errCode(err) !== "ENOENT") throw err; }
  }
  return walkFiles(cwd, follow);
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
/** Subsequence fuzzy score (lower is better; Infinity = no match). Basename matches win. */
function fuzzyScore(pattern: string, target: string): number {
  if (!pattern) return 0;
  const p = pattern.toLowerCase().replace(/\s+/g, ""), t = target.toLowerCase();
  let pi = 0, score = 0, last = -1;
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) { score += last < 0 ? ti * 2 : (ti - last - 1) * 2; last = ti; pi++; }
  }
  if (pi < p.length) return Number.POSITIVE_INFINITY;
  const base = t.slice(t.lastIndexOf("/") + 1);
  let bi = 0;
  for (let ti = 0; ti < base.length && bi < p.length; ti++) if (base[ti] === p[bi]) bi++;
  return bi >= p.length ? score - 20 : score;
}
const toNative = (p: string): string => p.split("/").join(path.sep);
/** Ranked file paths (workspace-relative, native separators), paged by limit/offset. */
export async function findPaths(query: string, opts: FindOptions = {}): Promise<string[]> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  const q = parseFindQuery(query);
  const files = await listFiles(cwd, opts.scan, opts.followSymlinks ?? false);
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
  return pageOf(scored, opts.limit, opts.offset).map((e) => toNative(e.p));
}
async function rgGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean): Promise<GrepMatch[]> {
  const args = ["--vimgrep", "--no-heading", "--no-messages", "--max-columns", "500", follow ? "--follow" : "--no-follow"];
  if (literal) args.push("--fixed-strings");
  if (ignoreCase) args.push("--ignore-case");
  args.push("--", pattern);
  const out: GrepMatch[] = [];
  for (const line of (await runCmd("rg", args, cwd)).split("\n")) {
    if (!line) continue;
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (m) out.push({ path: toNative(m[1].replace(/\\/g, "/")), line: Number(m[2]), col: Number(m[3]), text: m[4].trim().slice(0, 500) });
  }
  return out;
}
async function fallbackGrep(cwd: string, pattern: string, literal: boolean, ignoreCase: boolean, follow: boolean): Promise<GrepMatch[]> {
  let re: RegExp | null = null;
  if (!literal) {
    try { re = new RegExp(pattern, ignoreCase ? "i" : ""); } catch { throw new Error(`invalid regex: ${pattern}`); }
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const out: GrepMatch[] = [];
  for (const f of await walkFiles(cwd, follow)) {
    let text: string;
    try {
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
export async function grepContents(pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  guardCwd(cwd);
  if (!pattern) throw new Error("grep pattern must not be empty");
  const literal = opts.literal ?? true;
  if (!literal) { try { new RegExp(pattern); } catch { throw new Error(`invalid regex: ${pattern}`); } }
  const follow = opts.followSymlinks ?? false, ignoreCase = opts.ignoreCase ?? false;
  let matches: GrepMatch[];
  if (opts.scan === "mock") matches = await fallbackGrep(cwd, pattern, literal, ignoreCase, follow);
  else {
    try { matches = await rgGrep(cwd, pattern, literal, ignoreCase, follow); }
    catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
      matches = await fallbackGrep(cwd, pattern, literal, ignoreCase, follow);
    }
  }
  return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length };
}
/** Best-effort warm scan (no watcher/index — primes the OS cache). Never throws. */
export async function warmScan(): Promise<void> {
  try { await findPaths("", { limit: 1 }); } catch { /* warm scan never fails session start */ }
}
/** One-line status for `/find-health` (string form, read synchronously). */
export function status(): string {
  try {
    const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
    return `rg: ${r.status === 0 ? r.stdout.split("\n")[0].trim() : "missing"}; index: none (direct scan, no watcher)`;
  } catch { return "rg: missing; index: none (direct scan, no watcher)"; }
}
/** Drop caches (nothing persistent — resolves for the `/find-rescan` contract). */
export async function clearCache(): Promise<void> {}
