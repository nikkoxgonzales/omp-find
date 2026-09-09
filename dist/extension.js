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
// Core module specifiers stay `string`-typed (never literals): the core
// worker owns tools.ts/search.ts/frecency.ts and they may not exist yet, so
// a resolvable import specifier would fail the build until they land.
const TOOLS_SPEC = './tools.js';
const SEARCH_SPEC = './search.js';
const FRECENCY_SPEC = './frecency.js';
async function wireTools(pi, deps) {
    let tools;
    try {
        tools = (await import(TOOLS_SPEC));
    }
    catch {
        return;
    }
    const registerFindTools = tools['registerFindTools'];
    if (typeof registerFindTools !== 'function')
        return;
    let search;
    let frecency;
    try {
        search = await import(SEARCH_SPEC);
    }
    catch {
        search = undefined;
    }
    try {
        frecency = await import(FRECENCY_SPEC);
    }
    catch {
        frecency = undefined;
    }
    deps['search'] = search;
    deps['frecency'] = frecency;
    try {
        registerFindTools(pi, { search, frecency });
    }
    catch {
        // Tool registration is best-effort until the core lands.
    }
}
async function warmScan(deps) {
    const search = deps['search'];
    const warm = search?.['warmScan'] ?? search?.['warm'] ?? search?.['rescan'];
    if (typeof warm === 'function') {
        try {
            await warm.call(search);
        }
        catch {
            // Warm scan never fails session start.
        }
    }
}
export default function ompFindExtension(pi) {
    const deps = {};
    try {
        registerFindCommands(pi, deps);
    }
    catch {
        // Command registration is best-effort on unknown hosts.
    }
    void wireTools(pi, deps);
    try {
        pi.on?.('session-start', () => {
            void warmScan(deps);
        });
    }
    catch {
        // Hosts without an event emitter simply skip the warm scan.
    }
}
