import type { GrepMatch, GrepResult } from "./search.js";
export type StructuralMode = "pattern" | "kind" | "symbol" | "references" | "inside" | "has";
export interface StructuralOptions {
    cwd?: string;
    limit?: number;
    offset?: number;
    ignoreCase?: boolean;
    scan?: string;
    followSymlinks?: boolean;
    timeoutMs?: number;
    language?: string;
    contextBefore?: number;
    contextAfter?: number;
}
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
    outer?: {
        regex: string;
        description: string;
    };
    /** True when a repeated metavar compiled to a \N backreference. */
    hasBackref: boolean;
    /** One-line agent-facing account of what the lowering does and does not do. */
    description: string;
    /** references: target symbol (mode "references" only). */
    symbolName?: string;
}
/** Alias map to the outline.ts language families; unknown input stays generic
(the atom is shared, so nothing throws on a new language). */
export declare function normalizeLanguage(lang: string | undefined): string;
/** Compile one structural pattern to a regex lowering. Throws on empty input,
unknown kind:, malformed two-phase separators, or >9 distinct metavariables. */
export declare function compileStructural(pattern: string, opts?: {
    language?: string;
}): CompiledStructural;
export declare function structuralGrep(pattern: string, opts?: StructuralOptions): Promise<GrepResult>;
/** Preview a rewrite template against matches: `$NAME` (and `$$$NAME`) slots
fill from first-occurrence capture groups; unknown slots stay literal. Pure
preview — callers never write. Blocks are `approx: path:line:col:` + `-`/`+`. */
export declare function previewRewrite(compiled: CompiledStructural, rewrite: string, matches: GrepMatch[]): string[];
