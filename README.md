# dsh-team-janitor

Result-aware team cleanup for DeepSeek Harness (DSH): close a used-up subagent by **archiving** its session — nothing is deleted and `team_restore` brings it back — and read **how each run ended** (`done` / `failed` / `refused` / `aborted`) together with the member's last words, which `list_agents` cannot tell you.

*中文定位：把用完的子代理「归档关闭」而不是删除——随时可恢复；同时补上 `list_agents` 的缺口，看得到每个成员结束后的结果（完成 / 失败 / 拒答 / 中止）与收尾原话。*

`dsh-team-janitor` · **2.0.0** · MIT · Host ESM module + small Web half · DSH 44.7.0 (`@deepseek-ai/dsh-subagent` 0.2.2-rc.5)

> ⭐ **Star 一下，让我假装自己是个有影响力的开源作者。** — 一个 star 就是作者今天的好心情，右上角点一下只需两秒。

## Why

Three gaps this plugin fills, model-side:

1. **Closing must not be destructive.** `team_close` is `workspaceRegistry.archiveSession(id, { stopActivity: true })`: the run stops, later steps are blocked by DSH's built-in gates, and the durable session stays exactly where it was. No file, no session log, no database row is touched — the plugin has no delete path at all.
2. **A closed member must be recoverable.** `team_restore` unarchives it; with `prompt` it is a restore-and-continue in a single call.
3. **A finished run has an outcome nobody can read afterwards.** `list_agents` reports `inactive`, and its own description says that "does not indicate task completion, success, or failure". `team_overview` projects each member's `subagent/end` record (`stopReason` + the child's last assistant message) into `done` / `failed` / `refused` / `aborted`, and says `unknown` — never `done` — when there is no record in memory or on disk.

**中文说明：** 三件事：关闭只归档、绝不删文件；归档可逆、可一步恢复并续跑；结束后有结果可言——`list_agents` 的 `inactive` 不代表完成与否，结果视图用 `subagent/end` 的 `stopReason` + 收尾原话回答，结果落盘所以重载/重启后还在；完全查不到记录才如实报 `unknown`。

## Install

```sh
# Recommended: install the bundle into the current DSH profile
plugin_manager install_bundle dsh-team-janitor

# Or fetch the package with the npm CLI first, then load the same bundle
npm install dsh-team-janitor
```

| Source | `target` value | Notes |
|--------|----------------|-------|
| npm / DSH plugin manager | `dsh-team-janitor` | Recommended; loads the bundle into the current profile |
| GitHub or a local clone | `link:D:\path\to\dsh-team-janitor` | Repo checkout, no npm round-trip; re-install after editing |
| A downloaded tarball | `file:C:\path\to\dsh-team-janitor-2.1.0.tgz` | Handy for offline machines |

Or clone/download this repository and in DSH: **Plugins → Add plugin**, selecting the folder.

After editing a linked checkout you do **not** need a full restart: disabling and re-enabling the plugin (`plugin_manager set_plugin … enabled=false`, then `enabled=true`) re-imports the Host half. A full DSH restart works too.

**中文说明：** 首选 `plugin_manager install_bundle dsh-team-janitor`；本地开发用 `link:` 指向仓库目录。改完代码用两种办法之一让它生效：在 **Plugins** 里把插件禁用再启用（`plugin_manager set_plugin`，等价热重载），或者完全退出并重启 DSH。

## Requirements

- `subagents` + `tools` are required; activation also checks `rootOf` / `listDescendants` / `resolveName` and stays idle with one warning if any is missing.
- `workspaceRegistry` is optional: without it the plugin still loads, but `team_close` / `team_restore` return an explicit `workspaceRegistry service is unavailable` error and touch nothing.
- `agents` is optional: without it `running` falls back to the catalog's own `activity` field and settlement cannot be observed (reported as such).
- `systemPrompt` is optional: without it there is simply no hygiene nudge.
- Tools are declared only to an agent that can spawn subagents (a `subagent*` tool in its scope) or that owns the live subagent-tree root, and the three declarations together stay under 1500 characters.
- Results are mirrored to `<DSH_HOME>/team-janitor/results.json` (`DSH_HOME` defaults to `~/.dsh`), so the roster still answers "how did it end?" after a restart. Set `persistResults: false` in the plugin config to keep results in memory only.
- Targets DSH 44.7.0 / `@deepseek-ai/dsh-subagent` 0.2.2-rc.5. **No `engines.dsh`** on purpose: DSH compares that field against its *package* version (`0.2.2-rc.5` here), not the `44.7.0` product number, so declaring `>=44.7.0` makes profiles refuse to load the plugin.

**中文说明：** 必需 `subagents` + `tools`；`workspaceRegistry` / `agents` / `systemPrompt` 都按可选处理并提供降级行为。结果默认落盘到 `<DSH_HOME>/team-janitor/results.json`，可用 `persistResults: false` 关掉。刻意不写 `engines.dsh`——DSH 拿它跟包版本比而不是产品号。

## Advantages

| Advantage | What it buys you |
|-----------|------------------|
| **Non-destructive close（只归档不删除）** | Closing archives; the plugin contains no delete path — not a file, not a log, not a row. |
| **Reversible restore（可逆恢复）** | `team_restore` reopens a closed member, and `prompt` makes it restore-and-continue in one call. |
| **Outcome view（结果视图）** | `done` / `failed` / `refused` / `aborted` per member — the question `list_agents`' `inactive` refuses to answer. |
| **Honest unknown（宁可报 unknown）** | No record in memory or on disk ⇒ `unknown`, never a guessed `done`. |
| **Durable results（结果落盘）** | Records survive a restart or a plugin reload in one small file the plugin owns; a corrupt file is quarantined instead of crashing the plugin. |
| **Last words（收尾原话）** | Each recorded run keeps its final assistant excerpt (100 chars), so "is this one used up?" has evidence. |
| **Token-gated（按需声明）** | A plain child never receives these declarations; the delegating agent pays ~1.5k characters instead of ~3.2k. Caveat: that gap exists only in a profile where a child cannot delegate — where children may nest, the saving is just the removed `team_sweep`. |
| **Zero intrusion（零侵入）** | No `@deepseek-ai` imports, no host-log edits, no `agent/pre-step` gate, zero npm dependencies. |
| **Subtree scoped（子树限定）** | Only the caller's own descendants: never a sibling, an ancestor, the root, or yourself. |

**中文说明：** 优势集中在五点：不删除可恢复、结果可读、查不到就报 unknown、收尾原话可作证据、按代理收窄声明省 token；且零依赖零侵入、只作用于自己的子树。

## Use cases

- **The team is done.** `team_overview` → close the finished members: `team_close({ agents: ["reviewer", "explorer"] })`.
- **A child went quiet.** `team_overview` shows `failed` (with `max-tokens` spelled out) or `refused` and the child's last words, instead of `inactive`.
- **Post-compaction amnesia.** After a context compaction you no longer know who succeeded: one call re-reads every member's outcome.
- **A closed member is needed again.** `team_restore({ agents: ["reviewer"], prompt: "recheck the diff" })`.
- **Not an eraser.** To delete sessions from disk, use a delete plugin; this one keeps history by design.

**中文说明：** 典型动作：收工前清点并关闭；某个子代理不出声时查它的结束原因与收尾原话；压缩上下文后重新读一遍结果；需要时恢复并续跑。它不是擦除工具。

## Tools & Commands

All tools act only on the **caller's own subtree**, are declared only to agents that can delegate (or own the tree root), and are model-facing — there is no CLI or panel command.

| Tool | Effect |
|------|--------|
| `team_overview` | One row per member: `name [status]` + last words; `status` ∈ `running`, `done`, `failed`, `refused`, `aborted`, `idle`, `closed`, `unknown` (plus a read diagnostic's own reason). A raw `stopReason` that the status cannot express is rendered too (`[failed: max-tokens]`), archived rows still show `result: done/failed/…`, and `closable` lists your finished-or-unobserved descendants (used-up first, running excluded). `lastWords:false` gives names and outcomes only. |
| `team_close` | Archive the named descendants (names from `team_overview`, or session ids): stop requested for their running work and their descendants, one settlement poll for the whole batch, one `outcome` per target (`closed` / `already-closed` / `duplicate` / `unknown` / `refused` / `cancelled` / `failed`) plus `settled` (`true` = no longer in the agents registry, `false` = still resident). |
| `team_restore` | Unarchive closed members so they can take steps again; `prompt` delivers a message right after unarchiving (a cold target resumes and occupies a slot). One-shot children refuse a `prompt`. |

**中文说明：** 三个工具都只作用于调用者自己的子树，只对「能派活或拥有树根」的代理声明。`team_overview` 用结果语义投影状态；`team_close` 是归档 + 一次结算轮询 + 逐条 outcome；`team_restore` 可带 `prompt` 一步恢复并续跑。

## Web UI: cleared marker

The small browser half (`client.js`) adds a red **已清除 / Cleared** roster below the tree in the session header's subagent catalog, listing whose sessions are archived. It reads the Host-authoritative Workspace follow stream (`ctx.workspaces.list`), so `team_close` / `team_restore` and a manual GUI unarchive all reflect immediately, and it walks only the current conversation's own subtree — one conversation's marks never leak into another's menu. Only catalog levels that are loaded are covered, and it renders in root-conversation catalog menus.

**中文说明：** 网页端子代理菜单底部有红色「已清除」名单，数据来自宿主 Workspace 归档流，实时反映关闭/恢复；覆盖范围是本对话自己已加载的子树层级。

## Boundaries & limitations

Competitors, as described on their own intro pages (介绍页，未读源码核实):

| Project | Deletes files | Rewrites the session log | Reversible | Reports the end reason | Dependencies |
|---------|---------------|--------------------------|------------|------------------------|--------------|
| `dsh-team-janitor` (this) | No — archive only | No | Yes, `team_restore` (optionally + `prompt`) | Yes — `done`/`failed`/`refused`/`aborted` + last words, `unknown` when unobserved | Zero npm deps, no `@deepseek-ai` imports |
| `heiheiha798/dsh-plugin-subagent-delete` | Yes — deletes the session directory and the DB records | Deletes the records instead of rewriting | No | 介绍页未提及 | 据介绍页未说明（ships HTTP routes） |
| `dogbotowo-oss/dsh-agent-manager` | Moves to a recycle bin | Yes — writes a tombstone into the session log | Via its recycle bin | 介绍页未提及 | 据介绍页未说明（Web panel + offline CLI） |
| `SpaceRelay/dsh-subagent-control` | No | No | Not applicable | 介绍页未提及（只介绍了 list / message / interrupt） | 据介绍页未说明 |
| `REALOIYO/what-sub-agents-doing-now` | No | No | Not applicable | 介绍页未提及（自述不报告终止原因，结算后读不到） | 据介绍页未说明 |

Things to know before installing:

1. `list_agents` still lists a closed member (catalog rows are permanent) as `inactive`; use `team_overview` for `closed`.
2. Closing does not free the child's name — names stay reserved among the creator's children.
3. Results are stored in `<DSH_HOME>/team-janitor/results.json` (`DSH_HOME` defaults to `~/.dsh`): per member the last run's `stopReason`, `endedAt`, `runId`, and a **100-character excerpt of that member's final reply**. That file is what keeps `team_overview` useful after a restart; a member with no record there and none in memory is `unknown`. **Uninstalling the plugin does not delete this file** — delete it yourself if you do not want those excerpts kept. `persistResults: false` in the plugin config keeps everything in memory only.
4. The archive set is **profile-global**: `team_overview` answers "archived in this profile", not "in this conversation"; the per-conversation scope belongs to the Web marker.
5. Archiving does not force-free capacity: a member with parked inbox input may stay resident after closing (no public dispose / inbox-clear API).

**中文说明：** 对比表只写介绍页能确认的内容，未说明的标「未说明」。五条必须知道的限制：`list_agents` 仍显示已关闭成员、名字不释放、结果落盘到 `<DSH_HOME>/team-janitor/results.json`（里面有每个成员最后一条回复的前 100 字，卸载插件不会自动删除，可用 `persistResults: false` 只留内存）、归档集合是 profile 全局、归档不保证释放容量。

## Deep mechanics

Closing is `archiveSession(id, { stopActivity: true })` → the registry writes a durable archive and requests a stop of the session's own turn plus running descendants; wake-up blocking is DSH's built-in session gate (self-archived + managed-ancestor admission), so the plugin adds no gate. Results come from the **observe-only** `subagent/end` event (`{ runId, id, stopReason, lastAssistantMessage }`), held in a 256-entry FIFO cache, mirrored to `<DSH_HOME>/team-janitor/results.json` (atomic temp+rename, ~500ms coalesced writes, corrupt files quarantined to `results.json.corrupt`) and invalidated on restore; `stopReason` is `completed | aborted | error | max-tokens | refusal` (merge-extensible), and anything else projects to `unknown`. The `when` gate is evaluated per model step from the live agent (`tools.resolve`), and the hygiene sentence re-applies it because request-time context refresh carries no `toolSet`. Full detail — status table, store format, settlement semantics, gate evidence, limits — lives in [docs/DETAIL.md](docs/DETAIL.md); the zero-dependency test suite runs with `npm run verify` (195 checks).

**中文说明：** 归档 + 内置闸门、`subagent/end` 观察式结果缓存（256 条 FIFO、落盘到 `<DSH_HOME>/team-janitor/results.json`、恢复即失效、损坏文件改名隔离）、`when` 按步骤求值且提示语二次复检——细节与自检说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## Changelog

Full history: [CHANGELOG.md](CHANGELOG.md).

- **2.1.0** — Results now survive a restart: the cache is mirrored to `<DSH_HOME>/team-janitor/results.json` (atomic writes, ~500ms coalescing, corrupt files quarantined), so a reloaded plugin still reports `done`/`failed`/`refused`/`aborted` instead of `unknown`. Opt out with `persistResults: false`. Wording fixes: `team_close` no longer says "slot released" (closing does not free capacity), and the competitor table marks unverified cells as 介绍页未提及.
- **2.0.0** — **Breaking:** `team_sweep` removed (use `team_close`). `team_overview` is now a result view (`done`/`failed`/`refused`/`aborted`/`idle`/`closed`/`unknown`) built from a `subagent/end` result cache instead of residency (2.1.0 made that cache durable). All three tools are gated by `when` (only delegating agents and the tree root), and the three declarations fit in ~1.5k characters. Docs rewritten around "archive, don't delete".
- **1.1.5** — Correctness pass + a real test suite: fixed a `team_sweep` that could close the caller, sibling rows in `closable`, self-restore, `prompt` on one-shot children, and cancellation reported as a verdict; one settlement poll per call.
- **1.1.4** — `parked` vs `settled`, settlement polling, per-failure rows, restore-and-continue, and the red **已清除** roster in the Web subagent menu.
- **1.1.3** — Target DSH 44.7.0; dropped the plugin's own `agent/pre-step` gate; no more slot promises.
- **1.1.2** — First clean npm release (BOM fix).
- **1.1.0** — Initial release: `team_overview` / `team_close` / `team_sweep` / `team_restore`.

> ⭐ **觉得好用就 Star 一下，让我假装自己是个有影响力的开源作者。**

## License

[MIT](LICENSE)
