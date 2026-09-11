/**
 * omp-find OMP/pi extension entry.
 *
 * Static wiring: the core modules (`tools.ts`, `search.ts`, `frecency.ts`) are
 * imported directly, so a missing core fails loudly at load instead of
 * silently skipping tool registration. Host interactions (command/tool
 * registration, event subscription) stay best-effort `try/catch` — an unknown
 * host must never take down extension load.
 */

import { registerFindCommands } from "./commands.js";
import { registerFindTools } from "./tools.js";
import * as search from "./search.js";
import * as frecency from "./frecency.js";

interface FindExtensionHost {
  registerCommand?: unknown;
  registerTool?: unknown;
  on?: (event: string, listener: (...args: never[]) => unknown) => void;
}

export default function ompFindExtension(pi: FindExtensionHost): void {
  const deps = { search, frecency };
  try {
    registerFindCommands(pi, deps);
  } catch {
    // Hosts without command support simply skip the /find-* commands.
  }
  try {
    registerFindTools(pi, deps);
  } catch {
    // Hosts that reject tool registration skip the tools but keep commands.
  }
  try {
    // Host event form is `session_start` (underscore) per the ExtensionAPI types.
    pi.on?.("session_start", () => {
      void search.warmScan();
    });
  } catch {
    // Hosts without an event emitter simply skip the warm scan.
  }
  try {
    // Frecency feed: a successful read/edit/write on a file counts as an open.
    // Without this hook recordOpen had zero call sites and frecency.json stayed
    // empty forever. Best-effort like session_start — a malformed event or a
    // host without the event must never break load.
    pi.on?.("tool_result", (event: unknown) => {
      try {
        const e = event as { isError?: unknown; toolName?: unknown; input?: { path?: unknown } } | null;
        if (e == null || e.isError === true) return undefined;
        if (e.toolName !== "read" && e.toolName !== "edit" && e.toolName !== "write") return undefined;
        const p = e.input?.path;
        if (typeof p !== "string" || p.length === 0) return undefined;
        return frecency.recordOpen(p).catch(() => undefined);
      } catch {
        return undefined;
      }
    });
  } catch {
    // Hosts without an event emitter simply skip frecency tracking.
  }
}
