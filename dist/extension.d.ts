/**
 * omp-find OMP/pi extension entry.
 *
 * Static wiring: the core modules (`tools.ts`, `search.ts`, `frecency.ts`) are
 * imported directly, so a missing core fails loudly at load instead of
 * silently skipping tool registration. Host interactions (command/tool
 * registration, event subscription) stay best-effort `try/catch` — an unknown
 * host must never take down extension load.
 */
interface FindExtensionHost {
    registerCommand?: unknown;
    registerTool?: unknown;
    on?: (event: string, listener: (...args: never[]) => unknown) => void;
}
export default function ompFindExtension(pi: FindExtensionHost): void;
export {};
