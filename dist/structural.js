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
/** One atom: a string literal (double/single/backtick) or an identifier. Shared
across the outline.ts language families — deliberately language-agnostic. */
const ATOM = "((?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`|[A-Za-z_$][\\w$]*))";
/** Zero-or-more nodes (args, statements): non-greedy, may match empty. Single-line
only — nesting past one level is beyond regex lowering (documented, not attempted). */
const MULTI = "(.*?)";
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Lower one pattern body: metavars to groups/backrefs, everything else literal.
Appends first-occurrence names to `groups` (shared with rewrite substitution). */
function tokenize(body, groups) {
    let out = "";
    let lit = "";
    let backref = false;
    const flush = () => { if (lit) {
        out += escapeRegExp(lit);
        lit = "";
    } };
    const useGroup = (key, atom) => {
        const idx = groups.indexOf(key);
        if (idx >= 0) {
            out += `\\${idx + 1}`;
            backref = true;
        }
        else {
            if (groups.length >= 9)
                throw new Error("structural pattern has too many distinct metavariables (max 9 with repeats)");
            groups.push(key);
            out += atom;
        }
    };
    for (let i = 0; i < body.length;) {
        if (body[i] !== "$") {
            lit += body[i];
            i++;
            continue;
        }
        if (body[i + 1] === "$" && body[i + 2] === "$") {
            let j = i + 3;
            while (j < body.length && /[A-Za-z0-9_]/.test(body[j]))
                j++;
            flush();
            useGroup(body.slice(i + 3, j) || "$$$", MULTI);
            i = j;
            continue;
        }
        if (body[i + 1] === "$") {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 2));
            if (m) {
                flush();
                useGroup(m[0], ATOM);
                i += 2 + m[0].length;
                continue;
            }
            lit += "$$";
            i += 2;
            continue;
        }
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i + 1));
        if (m) {
            flush();
            useGroup(m[0], ATOM);
            i += 1 + m[0].length;
            continue;
        }
        lit += "$";
        i++; // $ + lowercase/digit/end-of-pattern stays literal ($HOME handled as metavar $HOME)
    }
    flush();
    return { source: out, backref };
}
/** Definition-line shapes per declaration family (line-anchored; ^ works because
both grep backends match line-by-line). */
const KIND_PATTERNS = {
    call: "\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\(",
    function: "^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+)*(?:function|def|fn|func)\\b",
    class: "^\\s*(?:export\\s+|abstract\\s+)*(?:class|struct|enum|interface|trait)\\b",
    import: "^\\s*(?:import|from|require|use|include)\\b",
    return: "^\\s*return\\b",
};
function defPattern(name) {
    // Edge-conditional boundary: \b when the name ends in a word char (rg-compatible);
    // a [\w$] lookaround otherwise — $ is an identifier char, so `foo` must not
    // match `foo$bar` and `foo$` must still resolve (walker serves those patterns).
    // The edge test reads the ESCAPED char against \w (not [\w$]): escaping only
    // prefixes non-word chars, so esc's last char is \w iff the raw name's is —
    // a [\w$] test would misread a trailing `\$` as a word edge and emit a \b
    // that can never match (`foo$ ` has no word/non-word transition).
    const esc = escapeRegExp(name);
    const right = /\w$/.test(esc) ? "\\b" : "(?![\\w$])";
    return `^\\s*(?:export\\s+|default\\s+|async\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|pub\\s+|abstract\\s+)*(?:function|def|fn|func|class|struct|enum|interface|trait|type|const|let|var)\\s+${esc}${right}`;
}
/** Alias map to the outline.ts language families; unknown input stays generic
(the atom is shared, so nothing throws on a new language). */
export function normalizeLanguage(lang) {
    const l = (lang ?? "").trim().toLowerCase();
    if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs|typescript|javascript)$/.test(l))
        return "ts";
    if (/^(py|python)$/.test(l))
        return "py";
    if (l === "go" || l === "golang")
        return "go";
    if (/^(rs|rust)$/.test(l))
        return "rust";
    if (l === "java")
        return "java";
    if (/^(cs|csharp|c#)$/.test(l))
        return "cs";
    if (/^(c|h|cc|cpp|cxx|hpp|c\+\+)$/.test(l))
        return "cpp";
    return "generic";
}
/** Compile one structural pattern to a regex lowering. Throws on empty input,
unknown kind:, malformed two-phase separators, or >9 distinct metavariables. */
export function compileStructural(pattern, opts = {}) {
    const raw = pattern.trim();
    if (!raw)
        throw new Error("structural pattern must not be empty");
    const language = normalizeLanguage(opts.language);
    const pre = /^(kind|symbol|references|inside|has):\s*/.exec(raw);
    const groups = [];
    if (pre) {
        const tag = pre[1];
        const rest = raw.slice(pre[0].length);
        if (tag === "symbol") {
            if (!rest)
                throw new Error("symbol: needs a name (e.g. 'symbol: parseFindQuery')");
            const regex = defPattern(rest);
            return { source: raw, regex, groups, language, mode: "symbol", hasBackref: false, description: `structural symbol "${rest}" [${language}] → definition-line regex (approximate, not AST)` };
        }
        if (tag === "references") {
            if (!rest)
                throw new Error("references: needs a name (e.g. 'references: parseFindQuery')");
            return { source: raw, regex: "", groups, language, mode: "references", hasBackref: false, symbolName: rest, description: `structural references "${rest}" [${language}] → callersOf heuristics (approximate, not LSP)` };
        }
        if (tag === "kind") {
            if (!rest || /\s/.test(rest))
                throw new Error(`kind: takes one bare kind (supported: ${Object.keys(KIND_PATTERNS).join(", ")}) — combine with a name via inside: or a $VAR pattern`);
            const base = Object.hasOwn(KIND_PATTERNS, rest) ? KIND_PATTERNS[rest] : undefined;
            if (!base)
                throw new Error(`unknown structural kind "${rest}" (supported: ${Object.keys(KIND_PATTERNS).join(", ")})`);
            return { source: raw, regex: base, groups, language, mode: "kind", hasBackref: false, description: `structural kind:${rest} [${language}] → line-shape regex (approximate, not AST)` };
        }
        const sep = tag === "inside" ? ">>" : "<<";
        const at = rest.indexOf(sep);
        if (at < 0)
            throw new Error(`${tag}: needs "OUTER ${sep} INNER" (e.g. '${tag}: import ${sep} $X')`);
        const left = rest.slice(0, at).trim();
        const right = rest.slice(at + sep.length).trim();
        if (!left || !right)
            throw new Error(`${tag}: needs non-empty OUTER and INNER around "${sep}"`);
        // Operands are plain patterns — a combinator prefix here means the user
        // chained combinators (`inside: inside: x >> y`), which used to compile
        // the prefix as literal text and silently match nothing.
        if (/^(?:kind|symbol|references|inside|has):/.test(left) || /^(?:kind|symbol|references|inside|has):/.test(right)) {
            throw new Error(`${tag}: combinators cannot be chained — operands must be plain patterns (got "${left}" ${sep} "${right}")`);
        }
        if (tag === "inside") {
            const outerT = tokenize(left, []);
            const innerT = tokenize(right, groups);
            return {
                source: raw, regex: innerT.source, groups, language, mode: "inside",
                outer: { regex: outerT.source, description: `outer "${left}"` },
                hasBackref: innerT.backref || outerT.backref,
                description: `structural inside: "${left}" >> "${right}" [${language}] → inner matches in files containing outer (file-scoped, not AST containment)`,
            };
        }
        const targetT = tokenize(left, groups);
        const filterT = tokenize(right, []);
        return {
            source: raw, regex: targetT.source, groups, language, mode: "has",
            outer: { regex: filterT.source, description: `filter "${right}"` },
            hasBackref: targetT.backref || filterT.backref,
            description: `structural has: "${left}" << "${right}" [${language}] → outer matches in files containing the filter (file-scoped, not AST containment)`,
        };
    }
    const t = tokenize(raw, groups);
    return {
        source: raw, regex: t.source, groups, language, mode: "pattern", hasBackref: t.backref,
        description: `structural "${raw}" [${language}] → single-line regex (approximate, not AST; $VAR one atom, $$$ any incl. empty, $A…$A backreference)`,
    };
}
export async function structuralGrep(pattern, opts = {}) {
    const compiled = compileStructural(pattern, { language: opts.language });
    const base = { cwd: opts.cwd, ignoreCase: opts.ignoreCase ?? false, scan: opts.scan, followSymlinks: opts.followSymlinks, timeoutMs: opts.timeoutMs };
    // Context keys only travel when set: absence keeps the core call identical.
    if ((opts.contextBefore ?? 0) > 0)
        base.contextBefore = opts.contextBefore;
    if ((opts.contextAfter ?? 0) > 0)
        base.contextAfter = opts.contextAfter;
    if (compiled.mode === "references") {
        const r = await callersOf(compiled.symbolName ?? "", { ...base, limit: opts.limit, offset: opts.offset });
        return r;
    }
    // rg (Rust regex) has no backreferences; the walker honors them.
    const scan = compiled.hasBackref ? "mock" : opts.scan;
    if (compiled.outer) {
        const outerRes = await grepContents(compiled.outer.regex, { ...base, scan, literal: false });
        const files = new Set(outerRes.matches.map((m) => m.path));
        const innerRes = await grepContents(compiled.regex, { ...base, scan, literal: false });
        const matches = innerRes.matches.filter((m) => files.has(m.path));
        return { matches: pageOf(matches, opts.limit, opts.offset), total: matches.length, backend: innerRes.backend, capped: innerRes.capped };
    }
    const res = await grepContents(compiled.regex, { ...base, scan, literal: false });
    return { matches: pageOf(res.matches, opts.limit, opts.offset), total: res.total, backend: res.backend, capped: res.capped };
}
/** Preview a rewrite template against matches: `$NAME` (and `$$$NAME`) slots
fill from first-occurrence capture groups; unknown slots stay literal. Pure
preview — callers never write. Blocks are `approx: path:line:col:` + `-`/`+`. */
export function previewRewrite(compiled, rewrite, matches) {
    if (!compiled.regex)
        return [];
    const re = new RegExp(compiled.regex);
    // Longest names first: substituting `$A` before `$AB` would corrupt `$AB`.
    // The bare-`$$$` slot substitutes last: `$$$ARGS` contains a `$$$` prefix.
    const order = compiled.groups
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => name !== "$$$")
        .sort((a, b) => b.name.length - a.name.length);
    const bareIdx = compiled.groups.indexOf("$$$");
    const out = [];
    for (const m of matches) {
        const hit = re.exec(m.text);
        if (!hit)
            continue;
        let made = rewrite;
        for (const { name, i } of order) {
            const val = hit[i + 1] ?? "";
            made = made.split(`$$$${name}`).join(val).split(`$${name}`).join(val);
        }
        if (bareIdx >= 0)
            made = made.split("$$$").join(hit[bareIdx + 1] ?? "");
        out.push(`approx: ${m.path}:${m.line}:${m.col}:\n- ${m.text.trim().slice(0, 500)}\n+ ${made}`);
    }
    return out;
}
