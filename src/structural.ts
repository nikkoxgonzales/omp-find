/** ffstructural core: ast-grep pattern subset compiled to regexes over grepContents.
Pure TS, zero deps, Node builtins only. No tree-sitter, no YAML rule engine,
no rewrite-apply — the subset is lowered to single-line regexes and every
result is explicitly approximate (line-anchored, verified with read).
Pattern syntax (verified against ast-grep pattern-syntax + rule reference):
`$VAR` one atom (identifier or string literal), `$$$` / `$$$ARGS` zero-or-more,
same-name reuse (`$A == $A`) is a backreference, `$$VAR` lowers like `$VAR`.
`kind:<k>` (call, function, class, import, return), `symbol:<name>`,
`references:<name>`, `inside: OUTER >> INNER`, `has: OUTER << INNER` are
accepted as pattern prefixes; two-phase modes filter file-by-file (outer and
inner must co-occur in one file), never by AST containment. */
import { grepContents, callersOf, pageOf } from "./search.js";
import type { GrepMatch, GrepResult } from "./search.js";

export type StructuralMode = "pattern" | "kind" | "symbol" | "references" | "inside" | "has";
export interface StructuralOptions { cwd?: string; limit?: number; offset?: number; ignoreCase?: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; language?: string; contextBefore?: number; contextAfter?: number }
export interface CompiledStructural {
  /** Original pattern text (prefix included). */
  source: string;
  /** Lowered single-line regex source ("" for references: — delegated to callersOf). */
  regex: string;
  /** Metavariable names in first-occurrence order (group N+1); shared by rewrite substitution. */
  groups: string[];
  /** Normalized language family ("ts", "py", "go", "rust", "java", "cpp", or "generic"). */
  language: string;
  mode: StructuralMode;
  /** Two-phase filter regex (outer for inside:, inner for has:). */
  outer?: { regex: string; description: string };
  /** True when a repeated metavar compiled to a \N backreference. */
  hasBackref: boolean;
  /** One-line agent-facing account of what the lowering does and does not do. */
  description: string;
  /** references: target symbol (mode "references" only). */
  symbolName?: string;
}

/** One atom: a string literal (double/single/backtick) or an identifier. Shared
across the outline.ts language families — deliberately language-agnostic. */
const ATOM = "((?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`|[A-Za-z_$][\\w$]*))";
/** Zero-or-more nodes (args, statements): non-greedy, may match empty. Single-line
only — nesting past one level is beyond regex lowering (documented, not attempted). */
const MULTI = "(.*?)";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lower one pattern body: metavars to groups/backrefs, everything else literal.
Appends first-occurrence names to `groups` (shared with rewrite substitution). */
function tokenize(body: string, groups: string[]): { source: string; backref: boolean } {
  let out = "";
  let lit = "";
  let backref = false;
  const flush = (): void => { if (lit) { out += escapeRegExp(lit); lit = ""; } };
  const useGroup = (key: string, atom: string): void => {
    const idx = groups.indexOf(key);
    if (idx >= 0) { out += `\\${idx + 1}`; backref = true; }
    else {
      if (groups.length >= 9) throw new Error("structural pattern has too many distinct metavariables (max 9 with repeats)");
      groups.push(key);
      out += atom;
    }
  };
  for (let i = 0; i < body.length;) {
    if (body[i] !== "$") { lit += body[i]; i++; continue; }
    if (body[i + 1] === "$" && body[i + 2] === "$") {
      let j = i + 3;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
      flush();
      useGroup(body.slice(i + 3, j) || "$$$", MULTI);
      i = j;
      continue;
    }
    if (body[i + 1] === "$") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 2));
      if (m) { flush(); useGroup(m[0], ATOM); i += 2 + m[0].length; continue; }
      lit += "$$"; i += 2; continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 1));
    if (m) { flush(); useGroup(m[0], ATOM); i += 1 + m[0].length; continue; }
    lit += "$"; i++; // $ + lowercase/digit/end-of-pattern stays literal ($HOME handled as metavar $HOME)
  }
  flush();
  return { source: out, backref };
}

/** Definition-line shapes per declaration family (line-anchored; ^ works because
both grep backends match line-by-line). */
const KIND_PATTERNS: Record<string, string> = {
  call: "\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\(",
  function: "^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+)*(?:function|def|fn|func)\\b",
  class: "^\\s*(?:export\\s+|default\\s+|abstract\\s+|public\\s+|private\\s+|protected\\s+|final\\s+|sealed\\s+|static\\s+)*(?:class|struct|enum|interface|trait)\\b",
  import: "^\\s*(?:import|from|require|use|include)\\b",
  return: "^\\s*return\\b",
};

function defPattern(name: string): string {
  // Edge-conditional boundary: \b when the name ends in a word char (rg-compatible);
  // a [\w$] lookaround otherwise — $ is an identifier char, so `foo` must not
  // match `foo$bar` and `foo$` must still resolve (walker serves those patterns).
  // The edge test reads the ESCAPED char against \w (not [\w$]): escaping only
  // prefixes non-word chars, so esc's last char is \w iff the raw name's is —
  // a [\w$] test would misread a trailing `\$` as a word edge and emit a \b
  // that can never match (`foo$ ` has no word/non-word transition).
  const esc = escapeRegExp(name);
  const right = /\w$/.test(esc) ? "\\b" : "(?![\\w$])";
  return `^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+|abstract\\s+|final\\s+|sealed\\s+)*(?:function|def|fn|func|class|struct|enum|interface|trait|type|const|let|var)\\s+${esc}${right}`;
}

/** Alias map to the outline.ts language families; unknown input stays generic
(the atom is shared, so nothing throws on a new language). */
export function normalizeLanguage(lang: string | undefined): string {
  const l = (lang ?? "").trim().toLowerCase();
  if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs|typescript|javascript)$/.test(l)) return "ts";
  if (/^(py|python)$/.test(l)) return "py";
  if (l === "go" || l === "golang") return "go";
  if (/^(rs|rust)$/.test(l)) return "rust";
  if (l === "java") return "java";
  if (/^(cs|csharp|c#)$/.test(l)) return "cs";
  if (/^(c|h|cc|cpp|cxx|hpp|c\+\+)$/.test(l)) return "cpp";
  return "generic";
}

/** A row-producing regex that matches "" hits every line of every file. */
function assertNotMatchAll(source: string, raw: string): void {
  if (new RegExp(source).test("")) {
    throw new Error(`structural "${raw}" matches everything — add a literal atom`);
  }
}

/** Compile one structural pattern to a regex lowering. Throws on empty input,
unknown kind:, malformed two-phase separators, >9 distinct metavariables, or a
lowering that matches the empty string (`$$$` alone floods every line). */
export function compileStructural(pattern: string, opts: { language?: string } = {}): CompiledStructural {
  const raw = pattern.trim();
  if (!raw) throw new Error("structural pattern must not be empty");
  const language = normalizeLanguage(opts.language);
  const pre = /^(kind|symbol|references|inside|has):\s*/.exec(raw);
  const groups: string[] = [];
  if (pre) {
    const tag = pre[1];
    const rest = raw.slice(pre[0].length);
    if (tag === "symbol") {
      if (!rest) throw new Error("symbol: needs a name (e.g. 'symbol: parseFindQuery')");
      const regex = defPattern(rest);
      return { source: raw, regex, groups, language, mode: "symbol", hasBackref: false, description: `structural symbol "${rest}" [${language}] → definition-line regex (approximate, not AST)` };
    }
    if (tag === "references") {
      if (!rest) throw new Error("references: needs a name (e.g. 'references: parseFindQuery')");
      return { source: raw, regex: "", groups, language, mode: "references", hasBackref: false, symbolName: rest, description: `structural references "${rest}" [${language}] → callersOf heuristics (approximate, not LSP)` };
    }
    if (tag === "kind") {
      if (!rest || /\s/.test(rest)) throw new Error(`kind: takes one bare kind (supported: ${Object.keys(KIND_PATTERNS).join(", ")}) — combine with a name via inside: or a $VAR pattern`);
      const base = Object.hasOwn(KIND_PATTERNS, rest) ? KIND_PATTERNS[rest] : undefined;
      if (!base) throw new Error(`unknown structural kind "${rest}" (supported: ${Object.keys(KIND_PATTERNS).join(", ")})`);
      return { source: raw, regex: base, groups, language, mode: "kind", hasBackref: false, description: `structural kind:${rest} [${language}] → line-shape regex (approximate, not AST)` };
    }
    const sep = tag === "inside" ? ">>" : "<<";
    const at = rest.indexOf(sep);
    if (at < 0) {
      if (/^(?:inside|has):/.test(rest)) throw new Error(`${tag}: combinators cannot be chained — got "${rest}"`);
      throw new Error(`${tag}: needs "OUTER ${sep} INNER" (e.g. '${tag}: import ${sep} $X')`);
    }
    const left = rest.slice(0, at).trim();
    const right = rest.slice(at + sep.length).trim();
    if (!left || !right) throw new Error(`${tag}: needs non-empty OUTER and INNER around "${sep}"`);
    // Chained combinators: an operand that itself starts with `inside:` or `has:`
    // is nesting a combinator, which would silently match nothing. `kind:`,
    // `symbol:`, and `references:` are acceptable as the actual pattern content.
    if (/^(?:inside|has):/.test(left) || /^(?:inside|has):/.test(right)) {
      throw new Error(`${tag}: combinators cannot be chained — operands must not be combinators (got "${left}" ${sep} "${right}")`);
    }
    function parseSide(side: "outer" | "inner" | "target" | "filter", raw: string, into: string[]): { source: string; backref: boolean; references?: string } {
      const m = /^(kind|symbol|references):\s*/.exec(raw);
      if (!m) {
        const t = tokenize(raw, into);
        assertNotMatchAll(t.source, raw);
        return { source: t.source, backref: t.backref };
      }
      const sub = m[1];
      const arg = raw.slice(m[0].length).trim();
      if (sub === "kind") {
        if (!arg || /\s/.test(arg)) throw new Error(`kind: takes one bare kind (supported: ${Object.keys(KIND_PATTERNS).join(", ")}) — combine with a name via inside: or a $VAR pattern`);
        const base = Object.hasOwn(KIND_PATTERNS, arg) ? KIND_PATTERNS[arg] : undefined;
        if (!base) throw new Error(`unknown structural kind "${arg}" (supported: ${Object.keys(KIND_PATTERNS).join(", ")})`);
        assertNotMatchAll(base, raw);
        return { source: base, backref: false };
      }
      if (sub === "symbol") {
        if (!arg) throw new Error(`symbol: needs a name (e.g. 'symbol: parseFindQuery')`);
        const r = defPattern(arg);
        assertNotMatchAll(r, raw);
        return { source: r, backref: false };
      }
      if (sub === "references") {
        if (!arg) throw new Error(`references: needs a name (e.g. 'references: parseFindQuery')`);
        return { source: "", backref: false, references: arg };
      }
      throw new Error(`${tag}: ${side} operand cannot use an unknown prefix`);
    }
    if (tag === "inside") {
      const outerT = parseSide("outer", left, []);
      const innerT = parseSide("inner", right, groups);
      if (outerT.references) throw new Error(`${tag}: outer operand cannot be references:`);
      return {
        source: raw, regex: innerT.source, groups, language, mode: "inside",
        outer: { regex: outerT.source, description: `outer "${left}"` },
        hasBackref: innerT.backref || outerT.backref,
        symbolName: innerT.references,
        description: `structural inside: "${left}" >> "${right}" [${language}] → inner matches in files containing outer (file-scoped, not AST containment)`,
      };
    }
    const targetT = parseSide("target", left, groups);
    const filterT = parseSide("filter", right, []);
    if (filterT.references) throw new Error(`${tag}: filter operand cannot be references:`);
    return {
      source: raw, regex: targetT.source, groups, language, mode: "has",
      outer: { regex: filterT.source, description: `filter "${right}"` },
      hasBackref: targetT.backref || filterT.backref,
      symbolName: targetT.references,
      description: `structural has: "${left}" << "${right}" [${language}] → outer matches in files containing the filter (file-scoped, not AST containment)`,
    };
  }
  const t = tokenize(raw, groups);
  assertNotMatchAll(t.source, raw);
  return {
    source: raw, regex: t.source, groups, language, mode: "pattern", hasBackref: t.backref,
    description: `structural "${raw}" [${language}] → single-line regex (approximate, not AST; $VAR one atom, $$$ any incl. empty, $A…$A backreference)`,
  };
}
export async function structuralGrep(pattern: string, opts: StructuralOptions = {}): Promise<GrepResult> {
  const compiled = compileStructural(pattern, { language: opts.language });
  const base: { cwd?: string; ignoreCase: boolean; scan?: string; followSymlinks?: boolean; timeoutMs?: number; contextBefore?: number; contextAfter?: number } =
    { cwd: opts.cwd, ignoreCase: opts.ignoreCase ?? false, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
  // Context keys only travel when set: absence keeps the core call identical.
  if ((opts.contextBefore ?? 0) > 0) base.contextBefore = opts.contextBefore;
  if ((opts.contextAfter ?? 0) > 0) base.contextAfter = opts.contextAfter;
  const scan = compiled.hasBackref ? "mock" : opts.scan;
  if (compiled.mode === "references" || compiled.symbolName) {
    const r = await callersOf(compiled.symbolName ?? "", { ...base, limit: opts.limit, offset: opts.offset });
    if (compiled.outer) {
      const outerRes = await grepContents(compiled.outer.regex, { ...base, scan, literal: false });
      const files = new Set(outerRes.matches.map((m) => m.path));
      const matches = r.matches.filter((m) => files.has(m.path));
      return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length, backend: r.backend, capped: r.capped };
    }
    return r;
  }
  if (compiled.outer) {
    const outerRes = await grepContents(compiled.outer.regex, { ...base, scan, literal: false });
    const files = new Set(outerRes.matches.map((m) => m.path));
    const innerRes = await grepContents(compiled.regex, { ...base, scan, literal: false });
    const matches = innerRes.matches.filter((m) => files.has(m.path));
    return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length, backend: innerRes.backend, capped: innerRes.capped };
  }
  const res = await grepContents(compiled.regex, { ...base, scan, literal: false });
  if (compiled.regex === KIND_PATTERNS.call) {
    // kind:call's `name(` shape also matches the definition line of that name
    // (`function foo(`, `foo(): void {`, `constructor(`). Drop rows whose line
    // defines the callee — same approximation callersOf's def filter makes.
    // The keyword-less shape needs signature evidence (`)` then `:`/`{`) so
    // bare call statements survive; `constructor(` is never a call.
    const callee = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    const isDefLine = (text: string): boolean => {
      let c: RegExpExecArray | null;
      callee.lastIndex = 0;
      while ((c = callee.exec(text)) !== null) {
        const name = c[1], esc = escapeRegExp(name);
        const right = /\w$/.test(esc) ? "\\b" : "(?![\\w$])";
        if (new RegExp(defPattern(name)).test(text)) return true;
        if (new RegExp(`^\\s*(?:(?:public|private|protected|static|async|abstract|override|readonly|final|sealed|get|set)\\s+)*${esc}${right}\\s*\\([^;]*\\)\\s*[:{]`).test(text)) return true;
        if (name === "constructor" && new RegExp(`^\\s*(?:(?:public|private|protected)\\s+)*${esc}${right}\\s*\\(`).test(text)) return true;
      }
      return false;
    };
    const kept = res.matches.filter((m) => !isDefLine(m.text));
    return { matches: pageOf(kept, opts.limit, opts.offset), total: kept.length, backend: res.backend, capped: res.capped };
  }
  return { matches: pageOf(res.matches, opts.limit, opts.offset), total: res.total, backend: res.backend, capped: res.capped };
}

/** Preview a rewrite template against matches: `$NAME` (and `$$$NAME`) slots
fill from first-occurrence capture groups; unknown slots stay literal. Pure
preview — callers never write. Blocks are `approx: path:line:col:` + `-`/`+`. */
export function previewRewrite(compiled: CompiledStructural, rewrite: string, matches: GrepMatch[]): string[] {
  if (!compiled.regex) return [];
  const re = new RegExp(compiled.regex);
  // Longest names first: substituting `$A` before `$AB` would corrupt `$AB`.
  // The bare-`$$$` slot substitutes last: `$$$ARGS` contains a `$$$` prefix.
  const order = compiled.groups
    .map((name, i) => ({ name, i }))
    .filter(({ name }) => name !== "$$$")
    .sort((a, b) => b.name.length - a.name.length);
  const bareIdx = compiled.groups.indexOf("$$$");
  const out: string[] = [];
  for (const m of matches) {
    const hit = re.exec(m.text);
    if (!hit) continue;
    let made = rewrite;
    for (const { name, i } of order) {
      const val = hit[i + 1] ?? "";
      made = made.split(`$$$${name}`).join(val).split(`$${name}`).join(val);
    }
    if (bareIdx >= 0) made = made.split("$$$").join(hit[bareIdx + 1] ?? "");
    out.push(`approx: ${m.path}:${m.line}:${m.col}:\n- ${m.text.trim().slice(0, 500)}\n+ ${made}`);
  }
  return out;
}
