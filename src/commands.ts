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

/** Worst-kind ordering for the notify tier: info < warn < error. */
function worstKind(a: string, b: string): string {
  const rank = (k: string): number => (k === "error" ? 2 : k === "warn" ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}

/** A status value is warn-worthy when it reports a missing backend or a fallback. */
function statusLevel(status: unknown): "ok" | "warn" {
  const text = typeof status === "string" ? status : JSON.stringify(status);
  return /missing|fallback|walker/i.test(text) ? "warn" : "ok";
}

function healthText(deps: FindCommandDeps): { text: string; kind: string } {
  const lines: string[] = ["find status"];
  let kind = "info";
  try {
    const status =
      typeof deps?.search?.status === "function" ? deps.search.status() : deps?.search?.status;
    if (status === undefined) {
      lines.push("index: warn (no status reported)");
      kind = worstKind(kind, "warn");
    } else {
      const level = statusLevel(status);
      lines.push(`index: ${level} (${typeof status === "string" ? status : JSON.stringify(status)})`);
      kind = worstKind(kind, level);
    }
  } catch (err) {
    lines.push(`index: error (${err instanceof Error ? err.message : String(err)})`);
    kind = "error";
  }
  try {
    const fstat =
      typeof deps?.frecency?.status === "function" ? deps.frecency.status() : deps?.frecency?.status;
    if (fstat === undefined) {
      lines.push("frecency: warn (no status reported)");
      kind = worstKind(kind, "warn");
    } else {
      lines.push(`frecency: ok (${typeof fstat === "string" ? fstat : JSON.stringify(fstat)})`);
      kind = worstKind(kind, "ok");
    }
  } catch (err) {
    lines.push(`frecency: error (${err instanceof Error ? err.message : String(err)})`);
    kind = "error";
  }
  return { text: lines.join("\n"), kind };
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
      const health = healthText(deps);
      notify(ctx, health.text, health.kind);
    },
  });
  pi.registerCommand('find-rescan', {
    description: 'Drop omp-find index and frecency caches',
    handler: async (_args: string, ctx: any) => {
      notify(ctx, await rescanText(deps), 'info');
    },
  });
}
