# Changelog

All notable changes to `dsh-team-janitor`. Tool names and required parameters have never changed across releases.

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

- `lastWords` cache is bounded (256 entries, FIFO) and invalidated on restore, so a reopened member never shows the previous run's words as final.
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
