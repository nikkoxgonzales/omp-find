# Simulator — the no-install installed-surface check

`npm run simulate` builds fresh `dist/` and then drives the **exact artifact an
OMP install loads** (`dist/extension.js`, default factory) with a faithful host
double. Green here means the registered tools and commands work as installed —
not just that the pure cores pass unit tests.

## Why this is 1:1

- **Same entry:** `scripts/simulate.mjs` imports `dist/extension.js` only.
  It never imports `src/*.ts` — that is the fidelity point. The factory wiring
  (`registerFindCommands` → `registerFindTools` → `session_start` subscribe),
  the tool `execute` closures, and the cursor stores are the real installed code.
- **Same registration calls:** the double exposes `registerTool`,
  `registerCommand`, and `on`/`emit` with the real host arity, and every
  deviation fails loudly instead of silently skipping (see Contract drift).
- **Same execute path:** tools are dispatched as
  `execute(toolCallId, params, signal, onUpdate, ctx)` and results are validated
  as `{content: [{type: 'text', text}], details?}` before the text is printed.
- **Same session event:** `session_start` is emitted after load, like the host,
  so the warm scan runs.
- **Only the host shell is doubled:** there is no approval UI, no marketplace
  install, no prompt injection — just the register/dispatch/notify surface.

## Fidelity table

| Piece | Real | Doubled |
|---|---|---|
| `dist/extension.js` factory + wiring | ✅ | |
| Tool `execute` bodies, cursor store, pagination, error text | ✅ | |
| Command handlers (`find-health`, `find-rescan`) | ✅ | |
| File scan (rg, walker fallback), grep (rg, fallback), ranking | ✅ | |
| Frecency scoring (cold store under temp HOME) | ✅ | |
| `/find-health` facts (rg version, store path) | ✅ | |
| `registerTool` single-object arity, `registerCommand(name, {description, handler})`, `session_start` | | ✅ (asserted, not implemented) |
| `ctx.ui.notify` capture | | ✅ (records text/kind) |
| Approval UI, marketplace install, prompt injection, TUI rendering | | ✅ (out of scope by design) |

Isolation: temp `HOME` (`LOCALAPPDATA`/`HOME`/`USERPROFILE`) and a temp
fixture tree per run — frecency never touches the real store, scans never touch
the real tree. Temp dirs are removed at exit.

## Scenarios (all print PASS/FAIL with the exact text the agent would see)

1. `fffind` ranked query + pagination cursor round-trip (3 hits, limit 2 →
   footer cursor → page 2; repeat query deterministic).
2. `ffgrep` literal phrase + bare-file filter — 35 root decoys sort before
   `src/`, so this proves the tools-side full-set filter: a bounded
   fetch-first implementation would page `server.py` out (the `grep -c`
   displacement case). Parens match literally, no escaping.
3. Unknown-cursor errors for `fffind` + `ffgrep` (error text, never throw).
4. `/find-health` facts output (`find status` + `index:`/`frecency:` lines, no
   `no status reported` tautology).
5. `/find-rescan` drop (`caches dropped: index, frecency`).
6. `ffoutline` symbol overview (`file:line:col:` rows).
7. `ffcallers` who-calls-X (import + call-paren sites).
8. Override aliases `find`/`grep` mirror `fffind`/`ffgrep` (runs only when the
   mode registers them — default `override` does).
9. `outline` alias mirrors `ffoutline` (runs only when registered).
10. Surface-coverage gate: every registered tool must have been dispatched, and
    any command beyond `find-health`/`find-rescan` needs a scenario — so a new
    tool without a scenario fails the run instead of going uncovered.

## How to add a scenario

Add an `await scenario('name', async () => {...})` block next to the others,
using `callTool(name, params)` / `invokeCommand(name)` and `show(label, text)`
to print what the agent sees. Use `assert(cond, msg)` — the message is the
FAIL detail. Pass `cwd: tree` explicitly on every tool call (never depend on
`process.cwd()`). If you add a tool or command to `src/`, the coverage gate
forces a scenario for it here too.

## How it differs from unit tests

`test/*.mjs` hits the **pure cores** (`search`, `frecency`, `parseFindQuery`,
edge cases, mocks) and is gated by the `c8` coverage threshold. The simulator
hits the **installed surface** (entry → registration → dispatch → text) with
no mocks and no coverage accounting — it lives in `scripts/`, outside the
`test/*.mjs` glob, so the coverage gate is untouched. Unit tests prove the
parts; the simulator proves the install.
