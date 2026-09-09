/**
 * omp-find OMP/pi extension entry.
 *
 * Wires the core worker's modules (`tools.ts`, `search.ts`, `frecency.ts`)
 * with dynamic `import()` so this scaffold installs and compiles BEFORE the
 * core lands: a failed import just leaves tool registration for later.
 * The two `/find-*` commands register synchronously against a shared `deps`
 * bag that the async wiring fills in once the core modules resolve.
 */
export default function ompFindExtension(pi: {
    registerCommand?: unknown;
    registerTool?: unknown;
    on?: (event: string, listener: (...args: never[]) => unknown) => void;
}): void;
