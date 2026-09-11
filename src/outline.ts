/** ffoutline core: approximate per-file symbol overview. Pure-TS regex table, Node builtins only.

Explicitly approximate (no LSP, no parser): every hit carries a line number so the
agent verifies with read/ffgrep. `outlineFile` never records frecency — recording
happens on open, not on outline. Oversized (>2 MB, same ceiling as grep) and
binary (NUL byte) files yield no symbols. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pageOf } from "./search.js";

/** Per-file ceiling mirrors the grep scan ceiling in search.ts. */
const MAX_OUTLINE_BYTES = 2 * 1024 * 1024;

export interface OutlineSymbol { line: number; col: number; kind: string; name: string }
export interface OutlineResult { symbols: OutlineSymbol[]; total: number }
export interface OutlineOptions { cwd?: string; depth?: number; limit?: number; offset?: number }

interface Rule { re: RegExp; kind: string; nameIdx: number; nested?: boolean; heuristic?: boolean }

const IDENT = "[A-Za-z_$][\\w$]*";
const WORD = "[A-Za-z_]\\w*";

/** `nested` rules only apply at depth 1 (indented members); others match at any depth. */
const TS: Rule[] = [
  { re: new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`), kind: "class", nameIdx: 1 },
  { re: new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`), kind: "function", nameIdx: 1 },
  { re: new RegExp(`^(?:export\\s+)?interface\\s+(${IDENT})`), kind: "interface", nameIdx: 1 },
  { re: new RegExp(`^(?:export\\s+)?(?:const\\s+)?enum\\s+(${IDENT})`), kind: "enum", nameIdx: 1 },
  { re: new RegExp(`^(?:export\\s+)?type\\s+(${IDENT})`), kind: "type", nameIdx: 1 },
  { re: new RegExp(`^(?:export\\s+)?const\\s+(${IDENT})\\s*=.*=>`), kind: "const", nameIdx: 1 },
  { re: new RegExp(`^(?:(?:public|private|protected|static|async|abstract|override|readonly)\\s+|\\*\\s*)*(?:get\\s+|set\\s+)?(${IDENT})\\s*\\([^;]*\\)\\s*(?::\\s*[^{};]+)?\\s*(?:\\{[^\\n]*)?,?\\s*$`), kind: "method", nameIdx: 1, nested: true, heuristic: true },
];

const PY: Rule[] = [
  { re: new RegExp(`^(?:async\\s+)?def\\s+(${WORD})`), kind: "def", nameIdx: 1 },
  { re: new RegExp(`^class\\s+(${WORD})`), kind: "class", nameIdx: 1 },
];

const GO: Rule[] = [
  { re: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${WORD})`), kind: "func", nameIdx: 1 },
  { re: new RegExp(`^type\\s+(${WORD})`), kind: "type", nameIdx: 1 },
];

const RUST: Rule[] = [
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, kind: "", nameIdx: 2 },
  { re: /^impl\s+(?:<[^>]*>\s*)?([A-Za-z_][\w:]*)/, kind: "impl", nameIdx: 1 },
];

const JAVA: Rule[] = [
  { re: new RegExp(`^(?:(?:public|private|protected|static|final|abstract|sealed|partial|internal|synchronized)\\s+)*(class|interface|enum|record|struct)\\s+(${WORD})`), kind: "", nameIdx: 2 },
  // Ctor BEFORE method: the method rule's return-type group would otherwise
  // backtrack and consume `public` as the type, mislabeling `public Foo()`.
  { re: new RegExp(`^(?:(?:public|private|protected)\\s+)*(${WORD})\\s*\\([^;]*\\)\\s*(?:throws\\s+[\\w,\\s.]+)?\\s*(?:\\{[^\\n]*)?,?\\s*$`), kind: "ctor", nameIdx: 1, nested: true, heuristic: true },
  { re: new RegExp(`^(?:(?:public|private|protected|static|final|async|override|virtual|synchronized)\\s+)*[\\w<>.\\[\\],? ]+\\s+(${WORD})\\s*\\([^;]*\\)\\s*(?:throws\\s+[\\w,\\s.]+)?\\s*(?:\\{[^\\n]*)?,?\\s*$`), kind: "method", nameIdx: 1, nested: true, heuristic: true },
];

/** C/C++ kept coarse: type declarations plus plausible top-level function definitions. */
const CPP: Rule[] = [
  { re: new RegExp(`^(?:template\\s*<[^>]*>\\s*)?(class|struct|enum(?:\\s+class)?)\\s+(${WORD})`), kind: "", nameIdx: 2 },
  { re: new RegExp(`^(?:[A-Za-z_][\\w:<>*&]*\\s+)?([A-Za-z_]\\w*)\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?(?:noexcept\\s*)?(?:override\\s*)?\\{?\\s*$`), kind: "function", nameIdx: 1, heuristic: true },
];

/** Unknown extensions: only the unambiguous cross-language keywords, behind the
 * common modifier prefixes (Kotlin `sealed class`/`data class`, C# `internal`,
 * etc.). `fun` is deliberately NOT a keyword here — GENERIC stays
 * declaration-keyword-only; .kt still lists classes. */
const GENERIC: Rule[] = [
  { re: new RegExp(`^(?:(?:public|private|protected|internal|sealed|open|data|abstract|final|static|export|async)\\s+)*(class|function|def|fn|func|interface|enum|struct|type)\\s+(${WORD})`), kind: "", nameIdx: 2 },
];
/** Method-name blocklist: control-flow/calls that mimic a signature. Applied
 * only to `heuristic` rules (name captured by shape, not anchored on a
 * keyword) — keyword-anchored rules legitimately declare names like Rust's
 * `pub fn new`. Own-property test only — `constructor`, `toString` & friends
 * are real method names that must not be dropped via Object.prototype leakage. */
const NOT_A_METHOD: Record<string, true> = { if: true, for: true, while: true, switch: true, catch: true, return: true, new: true, super: true, this: true, typeof: true, sizeof: true, assert: true, print: true, println: true };

/** Comment-only line openers (checked on the trimmed line). A leading `*` is a
 * JSDoc continuation EXCEPT when it opens a sync generator method (`*gen()`,
 * `* gen()`) — star + identifier + paren is a signature, not prose. */
function isComment(line: string): boolean {
  if (/^\*\s*[A-Za-z_$][\w$]*\s*\(/.test(line)) return false;
  return line.startsWith("//") || line.startsWith("#") || line.startsWith("/*")
    || line.startsWith("*") || line.startsWith("<!--") || line.startsWith("--");
}

function rulesFor(ext: string): Rule[] {
  switch (ext) {
    case ".ts": case ".tsx": case ".mts": case ".cts":
    case ".js": case ".jsx": case ".mjs": case ".cjs":
      return TS;
    case ".py": return PY;
    case ".go": return GO;
    case ".rs": return RUST;
    case ".java": case ".cs": return JAVA;
    case ".c": case ".h": case ".cc": case ".cpp": case ".cxx": case ".hpp": return CPP;
    default: return GENERIC;
  }
}

/** Leading-indent width in columns (tab counts as 4); -1 when the line is blank. */
function indentOf(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 4;
    else return w;
  }
  return -1;
}

/**
 * Approximate symbols in one file. `file` resolves against `opts.cwd`.
 * Depth 0 keeps top-level (unindented) symbols; depth 1 additionally keeps
 * members indented one level (<= 4 columns) via `nested` rules. Paged by
 * limit/offset; `total` counts all hits. Throws when the file cannot be read.
 */
export async function outlineFile(file: string, opts: OutlineOptions = {}): Promise<OutlineResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const abs = path.resolve(cwd, file);
  const depth = opts.depth === 1 ? 1 : 0;
  let raw: Buffer;
  try {
    raw = await fs.readFile(abs);
  } catch (err) {
    throw new Error(`outline: cannot read ${file} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw.length > MAX_OUTLINE_BYTES || raw.indexOf(0) >= 0) return { symbols: [], total: 0 };
  const rules = rulesFor(path.extname(abs).toLowerCase());
  const lines = raw.toString("utf8").split("\n");
  const out: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const indent = indentOf(line);
    if (indent < 0) continue;
    if (indent > 0 && depth === 0) continue;
    if (indent > 4) continue;
    const trimmed = line.trim();
    if (!trimmed || isComment(trimmed)) continue;
    for (const rule of rules) {
      if (rule.nested && indent === 0) continue;
      const m = rule.re.exec(trimmed);
      if (!m) continue;
      const name = m[rule.nameIdx];
      if (!name || (rule.heuristic === true && Object.hasOwn(NOT_A_METHOD, name))) break;
      const kind = rule.kind || m[1];
      const col = line.indexOf(name) + 1;
      out.push({ line: i + 1, col: col > 0 ? col : 1, kind, name });
      break;
    }
  }
  return { symbols: pageOf(out, opts.limit, opts.offset), total: out.length };
}
