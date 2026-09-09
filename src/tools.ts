/** omp-find tool surface: `fffind` + `ffgrep` always; override mode additionally claims `find` + `grep`. */
import fs from "node:fs";
import path from "node:path";
import type * as SearchNS from "./search.js";
import type * as FrecencyNS from "./frecency.js";

export type FindMode = "additive" | "override";
export interface FindToolsDeps { search?: typeof SearchNS; frecency?: typeof FrecencyNS }
export interface RegisterFindToolsOptions { mode?: FindMode; cwd?: string }

const FIND_PAGE = 30;
const GREP_PAGE = 30;
const PAGE_MAX = 50;
const FILTER_FETCH_CAP = 200;

type CursorState =
  | { kind: "find"; query: string; limit: number; nextOffset: number; cwd?: string }
  | { kind: "grep"; pattern: string; literal: boolean; ignoreCase: boolean; pathFilter?: string; limit: number; nextOffset: number; cwd?: string };

const cursors = new Map<string, CursorState>();
let cursorSeq = 0;

function storeCursor(s: CursorState): string {
  const id = `${s.kind === "find" ? "find_c" : "grep_c"}${++cursorSeq}`;
  cursors.set(id, s);
  if (cursors.size > 200) {
    const first = cursors.keys().next().value;
    if (first !== undefined) cursors.delete(first);
  }
  return id;
}

/** Flag > OMP_FIND_MODE env > omp-find.json > override. */
export function resolveFindMode(explicit?: FindMode, cwd: string = process.cwd()): FindMode {
  if (explicit === "additive" || explicit === "override") return explicit;
  const env = (process.env.OMP_FIND_MODE ?? "").toLowerCase();
  if (env === "additive" || env === "override") return env;
  try {
    const raw = fs.readFileSync(path.join(cwd, "omp-find.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const mode = typeof parsed === "object" && parsed !== null && "mode" in parsed ? parsed.mode : undefined;
    if (mode === "additive" || mode === "override") return mode;
  } catch { /* missing/unparseable → default */ }
  return "override";
}

function text(t: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: t }] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), PAGE_MAX) : undefined;
}

async function safeScore(frecency: FindToolsDeps["frecency"], p: string): Promise<number> {
  try { return (await frecency?.score(p)) ?? 0; }
  catch { return 0; }
}

function toDisplay(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Tools-layer path filter for ffgrep (dir/ prefix, glob, or bare name). */
function applyPathFilter(paths: string[], filter: string, glob: ((g: string) => RegExp) | undefined): string[] {
  const f = filter.startsWith("./") ? filter.slice(2) : filter;
  if (f.endsWith("/")) {
    const dir = f.slice(0, -1);
    return paths.filter((p) => { const d = toDisplay(p); return d === dir || d.startsWith(`${dir}/`); });
  }
  if (/[*?[{]/.test(f) && glob) {
    const re = glob(f);
    return paths.filter((p) => { const d = toDisplay(p); return re.test(d) || re.test(d.slice(d.lastIndexOf("/") + 1)); });
  }
  return paths.filter((p) => {
    const d = toDisplay(p);
    return d === f || d.startsWith(`${f}/`) || d.slice(d.lastIndexOf("/") + 1) === f;
  });
}

export function registerFindTools(pi: any, deps: FindToolsDeps, opts: RegisterFindToolsOptions = {}): void {
  const search = deps.search;
  const frecency = deps.frecency;
  if (!search?.findPaths || !search?.grepContents) return;
  const mode = resolveFindMode(opts.mode, opts.cwd ?? process.cwd());
  const isOverride = mode === "override";
  // Canonical form is the single ExtensionHostLike object {name, label, ...};
  // the scaffold test fake takes (name, def) but asserts name/label live on
  // the def, so both arities receive the full object.
  const register = (name: string, label: string, def: Record<string, unknown>): void => {
    const tool = { name, label, ...def };
    if (pi.registerTool.length >= 2) pi.registerTool(name, tool);
    else pi.registerTool(tool);
  };

  const findDef = (toolName: string): Record<string, unknown> => ({
    description: "Fuzzy file-name search (omp-find). Supports dir/ prefix, *.ext globs, !exclusions, git:modified.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Fuzzy query, e.g. 'main.ts src/ !*.test.ts'" },
        path: { type: "string", description: "Directory constraint, e.g. 'src/'" },
        limit: { type: "number", description: "Max results per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        let query: string, limit: number, offset: number, cwd: string | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "find") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          query = st.query; limit = st.limit; offset = st.nextOffset; cwd = st.cwd;
        } else {
          const pattern = strParam(params, "pattern") ?? "";
          query = [strParam(params, "path"), pattern].filter(Boolean).join(" ");
          if (!query) return text(`${toolName} failed: provide a pattern or path`);
          limit = numParam(params, "limit") ?? FIND_PAGE;
          offset = 0;
          cwd = strParam(params, "cwd");
        }
        const all = await search.findPaths(query, { cwd, limit: PAGE_MAX, offset: 0 });
        const ranked = await Promise.all(all.map(async (p) => ({ p, s: await safeScore(frecency, p) })));
        ranked.sort((a, b) => b.s - a.s); // stable: frecency first, fuzzy order otherwise
        const total = ranked.length;
        const page = ranked.slice(offset, offset + limit);
        const lines = page.map((r) => toDisplay(r.p));
        if (offset + page.length < total) {
          const next = storeCursor({ kind: "find", query, limit, nextOffset: offset + page.length, cwd });
          lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        return text(lines.length > 0 ? lines.join("\n") : "No files found matching pattern");
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });

  const grepDef = (toolName: string): Record<string, unknown> => ({
    description: "Content search (omp-find). Literal by default, regex when literal=false.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search text or regex" },
        path: { type: "string", description: "File constraint, e.g. 'src/', '*.ts'" },
        literal: { type: "boolean", description: "Literal match (default true)" },
        ignoreCase: { type: "boolean", description: "Case-insensitive match" },
        limit: { type: "number", description: "Max matches per page (default 30, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        let pattern: string, literal: boolean, ignoreCase: boolean, pathFilter: string | undefined;
        let limit: number, offset: number, cwd: string | undefined;
        const cursorId = strParam(params, "cursor");
        if (cursorId) {
          const st = cursors.get(cursorId);
          if (!st || st.kind !== "grep") return text(`${toolName} failed: unknown or expired cursor "${cursorId}"`);
          pattern = st.pattern; literal = st.literal; ignoreCase = st.ignoreCase;
          pathFilter = st.pathFilter; limit = st.limit; offset = st.nextOffset; cwd = st.cwd;
        } else {
          const p = strParam(params, "pattern");
          if (!p) return text(`${toolName} failed: provide a pattern`);
          pattern = p;
          literal = params["literal"] === undefined ? true : params["literal"] === true;
          ignoreCase = params["ignoreCase"] === true;
          pathFilter = strParam(params, "path");
          limit = numParam(params, "limit") ?? GREP_PAGE;
          offset = 0;
          cwd = strParam(params, "cwd");
        }
        // Path filters apply tools-side over a bounded fetch so counts stay exact.
        const fetchLimit = pathFilter ? FILTER_FETCH_CAP : limit;
        const res = await search.grepContents(pattern, {
          cwd, literal, ignoreCase, limit: fetchLimit, offset: pathFilter ? 0 : offset,
        });
        const pool = pathFilter ? applyPathFilter(res.matches.map((m) => m.path), pathFilter, search.globToRegExp) : null;
        const matches = pool === null ? res.matches : res.matches.filter((m) => pool.includes(m.path));
        const total = pool === null ? res.total : matches.length;
        const page = pool === null ? matches : matches.slice(offset, offset + limit);
        const lines = page.map((m) => `${toDisplay(m.path)}:${m.line}:${m.col}: ${m.text}`);
        if (offset + page.length < total) {
          const next = storeCursor({
            kind: "grep", pattern, literal, ignoreCase, pathFilter, limit, nextOffset: offset + page.length, cwd,
          });
          lines.push("", `... (${total - offset - page.length} more; pass cursor "${next}" for the next page)`);
        }
        return text(lines.length > 0 ? lines.join("\n") : "No matches found");
      } catch (err) {
        return text(`${toolName} failed: ${errMsg(err)}`);
      }
    },
  });
  register("fffind", "Find files", findDef("fffind"));
  register("ffgrep", "Grep content", grepDef("ffgrep"));
  if (isOverride) {
    register("find", "Find files", findDef("find"));
    register("grep", "Grep content", grepDef("grep"));
  }
}
