# Release process — omp-find

How versioning works here, what the next bump is, and the exact order of
operations for cutting a release. Process only: this doc never bumps anything.

## 1. Version spots inventory

The version lives in **three fields across two files**, all `0.3.1` today.
They move in lockstep or not at all.

| # | File | Field | Location |
|---|---|---|---|
| 1 | `package.json` | `version` | `package.json:3` — the single source of truth (`docs/extension-manual.md:15`) |
| 2 | `.omp-plugin/marketplace.json` | `metadata.version` | `marketplace.json:8` — must mirror `package.json` (`docs/extension-manual.md:98`) |
| 3 | `.omp-plugin/marketplace.json` | `plugins[0].version` | `marketplace.json:13` — same mirror requirement |

One-line agreement check (run from the repo root; expect three identical numbers):

```sh
node -p "[require('./package.json').version, require('./.omp-plugin/marketplace.json').metadata.version, require('./.omp-plugin/marketplace.json').plugins[0].version].join(' ')"
```

Non-field spots that reference the version:

- **`dist/` — no version string, rebuilt from source.** `dist/` is committed on
  purpose because plugin installs load `dist/extension.js` with no build step
  (`README.md:118–125`, `docs/extension-manual.md:110–114`, `docs/extension.md:113–118`;
  `package.json:6–7,14–16,25–34` wire `main`/`exports`/`files`/`omp`/`pi` to
  `./dist/extension.js`). A release with a stale `dist/` ships the old code under
  the new number — see the build-then-test-then-commit rule in §3.
- **`README.md` — carries no version reference** (verified: install/verify/dev
  sections only, no version string). Nothing to bump on release.
- **`docs/extension.md:4` — pins `(v0.3.1)`** as the as-built reference revision.
  Update the pin to the new version on release so the doc keeps describing the
  code it claims to ground.
- **`docs/extension-manual.md:98` — states both manifests are `0.3.1` "today".**
  Historical statement; refresh the numbers when they move.

## 2. Semver policy

`package.json:3` is the authority; the two `marketplace.json` fields follow it.

- **Patch** (`0.3.1` → `0.3.2`): bug fix, copy/text-only change, test-only change.
  No new params, no new tools, no output-shape change.
- **Minor** (`0.3.1` → `0.4.0`): new additive tool or new optional param.
  Backward compatible — existing calls behave as before.
- **Major** (→ `1.0.0`): contract break — tool rename/removal, param removal or
  rename, pagination/cursor or error-text format change, dropping the `override`
  default (`resolveFindMode` in `src/tools.ts:32–44`, default documented in
  `README.md:84–95`). While `0.x`, keep releases additive-only; a break means
  leaving `0.x`, so think twice.

### Pending work → required bump

The currently-pending items (sibling sessions, unmerged at the time of writing)
map as follows:

| Pending item | Kind | Bump it requires |
|---|---|---|
| Tool-card copy (descriptions, `promptGuidelines`, per-field docs) | Copy-only; additive guidance, no shape change (`docs/extension-manual.md:54–68`) | Patch |
| Health facts (`/find-health` reporting backend/entry/store facts instead of `ok (no status reported)`) | Bug fix — the manual already forbids tautologies (`docs/extension-manual.md:85–87`); current fallbacks live in `src/commands.ts:24–52` and are visible in `README.md:52–55` | Patch |
| Retry (transient-failure robustness, no contract change) | Bug fix | Patch |
| `cwd` param on `fffind`/`ffgrep` | New optional param, backward compatible | Minor |
| `ffoutline` | New additive tool | Minor |
| `ffcallers` | New additive tool | Minor |
| Context lines (grep `-C`/before/after params) | New optional params, backward compatible | Minor |
| `maxChars` output cap | New opt-in param/limit, backward compatible | Minor — **reassess as major if it ever changes default output shape** (truncating previously-full output is a pagination/format change) |

**Expected next version: `0.4.0`.** The pending set contains minor-grade additive
work (`ffoutline`, and likely `ffcallers`, `cwd`, context lines), so the next
release is a minor bump from `0.3.1`. If the release train ever carried patch-only
items it would be `0.3.2` instead; if any contract break slips in, it becomes a
major (`1.0.0`) and should be split out, not bundled.

## 3. Bump checklist (in order)

1. **Implement** — land the feature/fix work first; version spots untouched.
2. **`npm test` green** — `npm test` is build-then-test
   (`tsc -p tsconfig.json && node --test`, `package.json:22`), never
   test-against-stale-dist (`docs/extension-manual.md:112–114`).
3. **Coverage ≥ 85%** — `npm run coverage` enforces the `c8` gate (lines /
   branches / functions 85, `package.json:23`); new code without tests fails the
   gate (`docs/extension-manual.md:134–135`).
4. **Bump all three spots in lockstep** — `package.json:3`,
   `marketplace.json:8`, `marketplace.json:13`, plus the `docs/extension.md:4`
   pin. Re-run the §1 one-liner to confirm agreement.
5. **Rebuild `dist`** — `npm run build` (`package.json:21`); `dist/` is committed
   on purpose (`README.md:125`).
6. **Re-run tests against fresh `dist`** — `npm test` again post-build, so the
   committed build output is what was verified.
7. **Commit + tag** — one commit, then `git tag vX.Y.Z` (e.g. `v0.4.0`).
8. **Verify the marketplace install path** — fresh
   `omp plugin install omp-find@omp-find` (or the marketplace add + install flow
   in `README.md:103–108`), restart omp, run `/find-health` and confirm it
   reports real backend/frecency status (`README.md:116`).

## 4. Practice rules

- **Never bump mid-workstream.** Version bumps happen only on green `main` with
  the release set fully merged — bumping while feature work is unmerged tags a
  number that doesn't describe any real tree state.
- **Never bump one spot without the others.** A `package.json` / `metadata` /
  `plugins[0]` mismatch means the marketplace advertises a version the package
  doesn't carry (or vice versa). The §1 one-liner is the gate.
- **Never commit `dist` stale.** Build, then test, then commit — in that order,
  every time. A commit whose `dist/` predates its `src/` ships dead code under a
  live number.
- **One version per release.** No drive-by bumps inside feature commits; the
  bump is its own commit (+ tag) per §3 steps 4–7.

## 5. CHANGELOG proposal

No `CHANGELOG` exists today (confirmed: no `CHANGELOG*` in the repo root).
**Proposal: add `CHANGELOG.md` (Keep-a-Changelog shape: `Added` / `Fixed` /
  `Changed` per release) starting with the `0.4.0` release, maintained as part
  of §3 step 7.** Rationale: marketplace users upgrade via
  `omp plugin upgrade` (`README.md:103`) and currently have no way to learn what
  a new number contains; the per-release cost is five lines. Not created by this
  change — this change is the process doc only.
