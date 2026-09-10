export interface OutlineSymbol {
    line: number;
    col: number;
    kind: string;
    name: string;
}
export interface OutlineResult {
    symbols: OutlineSymbol[];
    total: number;
}
export interface OutlineOptions {
    cwd?: string;
    depth?: number;
    limit?: number;
    offset?: number;
}
/**
 * Approximate symbols in one file. `file` resolves against `opts.cwd`.
 * Depth 0 keeps top-level (unindented) symbols; depth 1 additionally keeps
 * members indented one level (<= 4 columns) via `nested` rules. Paged by
 * limit/offset; `total` counts all hits. Throws when the file cannot be read.
 */
export declare function outlineFile(file: string, opts?: OutlineOptions): Promise<OutlineResult>;
