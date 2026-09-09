/**
 * omp-find OMP/pi extension entry.
 *
 * Wires the core worker's modules (`tools.ts`, `search.ts`, `frecency.ts`)
 * with dynamic `import()` so this scaffold installs and compiles BEFORE the
 * core lands: a failed import just leaves tool registration for later.
 * The two `/find-*` commands register synchronously against a shared `deps`
 * bag that the async wiring fills in once the core modules resolve.
 */

import { registerFindCommands } from './commands.js';

type DepsBag = Record<string, unknown>;

// Core module specifiers stay `string`-typed (never literals): the core
// worker owns tools.ts/search.ts/frecency.ts and they may not exist yet, so
// a resolvable import specifier would fail the build until they land.
const TOOLS_SPEC: string = './tools.js';
const SEARCH_SPEC: string = './search.js';
const FRECENCY_SPEC: string = './frecency.js';

async function wireTools(pi: { registerTool?: unknown }, deps: DepsBag): Promise<void> {
  let tools: Record<string, unknown>;
  try {
    tools = (await import(TOOLS_SPEC)) as Record<string, unknown>;
  } catch {
    return;
  }
  const registerFindTools = tools['registerFindTools'];
  if (typeof registerFindTools !== 'function') return;
  let search: unknown;
  let frecency: unknown;
  try {
    search = await import(SEARCH_SPEC);
  } catch {
    search = undefined;
  }
  try {
    frecency = await import(FRECENCY_SPEC);
  } catch {
    frecency = undefined;
  }
  deps['search'] = search;
  deps['frecency'] = frecency;
  try {
    (registerFindTools as (host: unknown, d: unknown) => void)(pi, { search, frecency });
  } catch {
    // Tool registration is best-effort until the core lands.
  }
}

async function warmScan(deps: DepsBag): Promise<void> {
  const search = deps['search'] as Record<string, unknown> | undefined;
  const warm = search?.['warmScan'] ?? search?.['warm'] ?? search?.['rescan'];
  if (typeof warm === 'function') {
    try {
      await (warm as () => Promise<unknown>).call(search);
    } catch {
      // Warm scan never fails session start.
    }
  }
}

export default function ompFindExtension(pi: {
  registerCommand?: unknown;
  registerTool?: unknown;
  on?: (event: string, listener: (...args: never[]) => unknown) => void;
}): void {
  const deps: DepsBag = {};
  try {
    registerFindCommands(pi, deps);
  } catch {
    // Command registration is best-effort on unknown hosts.
  }
  void wireTools(pi, deps);
  try {
    pi.on?.('session-start', () => {
      void warmScan(deps);
    });
  } catch {
    // Hosts without an event emitter simply skip the warm scan.
  }
}
