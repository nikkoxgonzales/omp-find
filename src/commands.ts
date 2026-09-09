/**
 * `/find-health` (index/frecency status) and `/find-rescan` (drop caches).
 *
 * Both handlers run through the `deps` bag with `any` types so this file
 * compiles before the core worker (`search.ts`, `frecency.ts`) lands.
 * Every core call is optional-chained with a plain-text fallback, and
 * `ctx.ui.notify` itself is best-effort.
 */

export interface FindCommandDeps {
  search?: any;
  frecency?: any;
  [key: string]: any;
}

function notify(ctx: any, text: string, kind: string): void {
  try {
    ctx?.ui?.notify?.(text, kind);
  } catch {
    // Notify is best-effort.
  }
}

function healthText(deps: FindCommandDeps): string {
  const lines: string[] = ['find status'];
  try {
    const status =
      typeof deps?.search?.status === 'function'
        ? deps.search.status()
        : deps?.search?.status;
    if (status !== undefined) {
      lines.push(`index: ${typeof status === 'string' ? status : JSON.stringify(status)}`);
    } else {
      lines.push('index: ok (no status reported)');
    }
  } catch (err) {
    lines.push(`index: error (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    const fstat =
      typeof deps?.frecency?.status === 'function'
        ? deps.frecency.status()
        : deps?.frecency?.status;
    if (fstat !== undefined) {
      lines.push(`frecency: ${typeof fstat === 'string' ? fstat : JSON.stringify(fstat)}`);
    } else {
      lines.push('frecency: ok (no status reported)');
    }
  } catch (err) {
    lines.push(`frecency: error (${err instanceof Error ? err.message : String(err)})`);
  }
  return lines.join('\n');
}

async function rescanText(deps: FindCommandDeps): Promise<string> {
  const dropped: string[] = [];
  try {
    if (typeof deps?.search?.clearCache === 'function') {
      await deps.search.clearCache();
      dropped.push('index');
    } else if (typeof deps?.search?.rescan === 'function') {
      await deps.search.rescan();
      dropped.push('index');
    }
  } catch (err) {
    return `/find-rescan failed (index): ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    if (typeof deps?.frecency?.clear === 'function') {
      await deps.frecency.clear();
      dropped.push('frecency');
    }
  } catch (err) {
    return `/find-rescan failed (frecency): ${err instanceof Error ? err.message : String(err)}`;
  }
  return dropped.length === 0 ? 'caches dropped (nothing cached)' : `caches dropped: ${dropped.join(', ')}`;
}

export function registerFindCommands(pi: any, deps: FindCommandDeps = {}): void {
  pi.registerCommand('find-health', {
    description: 'Show omp-find index and frecency status',
    handler: async (_args: string, ctx: any) => {
      notify(ctx, healthText(deps), 'info');
    },
  });
  pi.registerCommand('find-rescan', {
    description: 'Drop omp-find index and frecency caches',
    handler: async (_args: string, ctx: any) => {
      notify(ctx, await rescanText(deps), 'info');
    },
  });
}
