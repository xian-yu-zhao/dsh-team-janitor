# Changelog

All notable changes to `dsh-team-janitor`. 2.0.0 is the first release that changes the tool surface: `team_sweep` is gone.

## 2.0.0 — results instead of residency (breaking)

### Removed

- **`team_sweep` is gone.** It duplicated `team_close` and its "preview, then execute" round-trip cost an extra model turn. Migration: replace `team_sweep({ preview: false })` with `team_close({ agents: [...] })` using the names from `team_overview`, and drop the preview call entirely — `team_close` already returns one `outcome` row per target, so a mistyped name costs one refused/unknown row, not a whole extra round-trip. `includeRunning` has no replacement: `team_close` accepts running members by name, but `team_overview` no longer offers them in `closable`.
- The `parked` / `settled` residency vocabulary is gone from `team_overview` (see below); the `settled` / `resident` / `unobserved` counters went away with `team_sweep`.

### Changed

- **`team_overview` is a result view.** One row per member: `name [status]` + last words, where `status` is `running` | `done` | `failed` | `refused` | `aborted` | `idle` | `closed` | `unknown`. The gap it closes is real: `list_agents` reports `inactive`, and its own description warns that inactive "does not indicate task completion, success, or failure".
- **The `lastWords` cache became a result cache.** `subagent/end` now records `{ stopReason, endedAt, excerpt, runId }` per member (256-entry FIFO, invalidated on restore, 100-char excerpt) instead of plain words. `stopReason` is projected as `completed→done`, `error→failed`, `max-tokens→failed`, `refusal→refused`, `aborted→aborted`; unknown backend variants project to `unknown` and are rendered verbatim (`[unknown: <reason>]`).
- **`unknown` is preferred over a guessed `done`.** The cache is process-local, so it is lost on restart. A member with no record whose catalog row predates the plugin's start is `unknown`; only a row created while the plugin was watching may be `idle`.
- **Archived wins.** An archived member reports `closed` and still shows its last recorded result (`result: done|failed|…`) and last words.
- **`closable`** now lists the caller's finished-or-unobserved descendants, recorded outcomes first, and excludes running members (closing a running member is still possible by name).
- **Every tool is gated by `when`.** A tool is declared only for an agent that can spawn subagents (a `subagent*` tool visible in its scope) or that owns the live subagent-tree root; a plain child receives no declarations and no hygiene nudge. Measured with `dsh-tools` 0.2.2-rc.5: `when` false excludes a tool from both declarations and dispatch, and `tools.get(name, scope, toolSet)` agrees — the hygiene context re-applies the gate because request-time context refresh carries no `toolSet`.
- **Tool declarations shrank to ~1475 characters total** (from ~3200 for four tools), so a delegating agent pays about half the roster tokens.
- Ordering fix in `team_close` / `team_restore`: the self and tree-root refusals are checked before the catalog lookup. The root is not a member of its own descendant list, so it used to be reported as `unknown` ("no such member") instead of `refused`.

### Added

- `test/smoke.mjs` grows to 158 checks: every status projection, the `unknown` scenarios (no record / archived with a historical result / unknown backend variant), `when` allow-and-deny paths, hygiene consistency with the visible tool set, the removed-tool sweep across shipped files, and a hard assertion that the three declarations stay ≤1500 characters.

## 1.1.5 — correctness, tokens, and a real test suite

### Fixed

- **`team_sweep` could close the caller itself.** The subtree walk included the caller's own node (`idsUnder` started at the node and accepted `id === owner`), so a subagent that swept could archive itself. The walk is now strictly under the owner, and `team_sweep` additionally skips the caller.
- **`team_overview` offered uncloseable siblings as `closable`.** Rows still cover the whole tree for context, but `closable` now only lists the caller's own descendants — anything else would be refused by `team_close`.
- **`team_restore` accepted a self-restore**, which then failed inside `sendMessage` with `UNAUTHORIZED`; it is now refused with a clear detail. `team_restore` + `prompt` on a one-shot/external child is refused *before* the archive is touched.
- **Cancellation was reported as a verdict.** An aborted `team_close` used to report `still resident`; it now reports `settlement not observed (call cancelled)`, and `team_sweep` counts such rows in `unobserved` instead of folding them into `resident`.
- **An unmatched name was diagnosed as "not your descendant".** A typo is now reported as `unknown` instead of inviting a retry with another name.
- **Stop wording was overstated.** Say `stop requested` — `archiveSession` dispatches cancellation and returns, it does not await the stops.
- **`inject` hard-required optional services.** `agents` and `systemPrompt` are now read with `ctx.get()` + guards, so a composition without them loads the plugin (status/settlement degrade) instead of dropping it at activation. Activation also verifies `rootOf` / `listDescendants` / `resolveName` before registering anything.

### Token efficiency

- One settlement poll budget per call instead of one per target: closing twelve members costs ~2s in total, not ~2s each.
- Tool descriptions trimmed (~1.1 KB → ~0.5 KB total) and the `team-janitor:hygiene` context rebuilt from the tools that are actually visible, in under 260 characters.
- `team_overview` gained `lastWords:false` for large trees; running members hide stale closing words; closing words are capped at 100 characters; the rendered roster no longer repeats the root id, the legend line, or a session id that equals the name.

### Changed

- The `lastWords` cache is bounded (256 entries, FIFO) and invalidated on restore, so a reopened member never shows the previous run's words as final.
- `team_close` rows carry a structured `settled` boolean; `outcome` values are enumerated in the output schema.
- `engines.dsh` is **not** declared, and the reason is worth recording: DSH's version gate compares that field against its package version (`0.2.2-rc.5` for the 44.7.0 build), not against the `44.7.0` product number. Declaring `>=44.7.0` made profiles refuse to load the plugin ("incompatible with dsh 0.2.2-rc.5 … profile startup denies it"). The supported build is documented instead.
- Docs are precise about the archive set being **profile-global**: the Host view answers "is this session archived in this profile", the per-conversation scope belongs to the Web marker only. `workspaceRegistry` absence produces an explicit tool error rather than a silent no-op.

### Added

- `test/smoke.mjs` — a zero-dependency test suite (104 checks) that drives the Host half against a fake Cordis context: tool registration, roster statuses, `closable` scope, settlement verdicts, dedupe, refusal paths, cancellation, restore-and-continue, plus packaging invariants (no `@deepseek-ai` imports, bundle/web manifest, shipped files).
- `npm run check` / `npm run test` / `npm run verify`, and a GitHub Actions workflow running them on Node 20 and 22.
- This changelog.

## 1.1.4

- `team_overview` distinguishes `parked` (registered idle, slot may be held) from `settled` (disposed, slot released) and orders `closable now` accordingly.
- `team_close` polls ~2s after archiving and reports the observed settlement.
- `team_sweep` returns per-failure rows in `failuresDetail`.
- `team_restore` accepts an optional `prompt` for restore-and-continue.
- New browser half: a red **已清除 / Cleared** roster in the subagent catalog menu footer, driven by the live Workspace archive stream.

## 1.1.3

- Target DSH 44.7.0 (`@deepseek-ai/dsh-subagent` 0.2.2-rc.5).
- Dropped the plugin's own `agent/pre-step` archive gate: built-in gates now cover self-archived sessions and managed ancestors.
- Reworded tool descriptions so closing no longer promises a freed capacity slot.

## 1.1.2

- First clean npm release: strips the UTF-8 BOM that made strict JSON parsing reject 1.1.0 / 1.1.1 (both deprecated).

## 1.1.0

- Initial release: `team_overview` / `team_close` / `team_sweep` / `team_restore`.
