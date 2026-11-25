# dsh-team-janitor

Team collaboration QoL for DeepSeek Harness (DSH): the agent can decide to close subagents whose work is done — single close, idle sweep, compact team overview, and restore — and the Web UI marks cleared members in red.

## Why

Subagent trees grow cluttered: finished children stay in `list_agents` forever and their sessions pile up in the workspace sidebar. A subagent that finishes normally settles by itself and frees its activation slot (`maxActiveSubagents`) — no plugin is needed for capacity. What DSH lacks is a **model-facing way to close a member for good**: archive it, see it as `closed`, and reopen it if needed. This plugin fills that gap — model-side archiving, sidebar hygiene, a visible `closed` status, and reversible restore.

## Install

**npm is a first-class install path** — the package is published at [npmjs.com/package/dsh-team-janitor](https://www.npmjs.com/package/dsh-team-janitor):

```sh
# Recommended: install the bundle into the current DSH profile
plugin_manager install_bundle dsh-team-janitor

# Or fetch it with the npm CLI first, then load the same bundle
npm install dsh-team-janitor
```

Or clone/download this repository and in DSH: **Plugins → Add plugin**, selecting the folder.

Requirements: the `subagents` and `tools` services (present in any preset with subagent delegation, e.g. Web/Desktop defaults). Without the `workspaceRegistry` service the plugin degrades to idle; without `subagents` it never activates.

The plugin builds on one Host-side ESM file (`lib/index.js`); a small browser module (`client.js`) adds the red cleared marker to the Web UI. Zero dependencies. Targets DSH 44.7.0 (built-in `@deepseek-ai/dsh-subagent` 0.2.2-rc.5).

## Advantages

| Advantage | What it buys you |
|---|---|
| **Model-facing tools（模型工具）** | Four purpose-built tools — `team_overview`, `team_close`, `team_sweep`, `team_restore` — that the agent calls itself. Cleanup happens inside the conversation; no clicking around the UI. |
| **Reversible archiving（可逆归档）** | Closing only archives a session; nothing is deleted. `team_restore` reopens it anytime, and `prompt` makes it a restore-and-continue in one call. |
| **Status overview（状态总览）** | `team_overview` reports `closed` / `running` / `parked` / `settled` per member, so both the model and the user see who is still resident and who already released a slot. |
| **Zero intrusion（零侵入）** | Purely additive: no `@deepseek-ai` imports, no host-log edits, no `agent/pre-step` gate, no core patch. Uninstalling leaves sessions and the profile as they were. |
| **Subtree restricted（子树限定）** | Every tool acts only on the caller's own descendants. Siblings, ancestors, unrelated trees, and the tree root can never be touched — no cross-team accidents. |
| **Last words（收尾发言）** | Each member's closing remarks are cached from `subagent/end` and shown in the roster, so "is this one actually done?" is answered from evidence, not from a guess. |
| **Cleared marker（已清除标记）** | The Web subagent menu shows a red **已清除 / Cleared** roster, scoped to the current conversation and driven by the live archive stream. |

## Tools

All tools act only on the **caller's own subtree** (the root or any subagent can use them on their descendants):

| Tool | Effect |
|---|---|
| `team_overview` | Compact roster: `closed` / `running` / `parked` / `settled` per member (parked = registered idle, slot may be held; settled = disposed, slot released), each member's last closing words (from the `subagent/end` event cache), and a `closable now` list (parked first, then settled) |
| `team_close` | Close specific descendants (names from `team_overview`/`list_agents`, or session ids): stops their running work (and their running descendants), archives their sessions so they leave the workspace sidebar, then briefly polls and reports whether the member actually settled (slot released) or is still resident |
| `team_sweep` | Batch-close idle descendants; `preview` defaults to true (list only), `preview: false` executes, `includeRunning: true` also closes running agents; per-failure rows come back in `failuresDetail` |
| `team_restore` | Unarchive previously closed members so they are visible and continuable again; optional `prompt` delivers a message right after restoring (restore-and-continue — the target resumes and occupies a slot) |

A short `team-janitor:hygiene` system-prompt context nudges the agent toward closing finished subagents whenever the tools are visible.

## Cleared marker in the Web UI

The plugin also ships a small browser half (`client.js`). In the session header's subagent catalog (the menu behind the descendant count), a red **已清除 / Cleared** section lists whose sessions were cleared, below the tree. Data comes from the Host-authoritative Workspace follow stream (`ctx.workspaces.list`), so marks appear and disappear with real archive/unarchive events — `team_close`, `team_sweep`, and a manual GUI unarchive all reflect instantly.

Coverage follows what the tree has loaded: it matches the archived set against the same `subagentCatalog` projections the lineage renderer reads, so expanding a branch brings its levels into the roster. If the workspace state service is unavailable, the marker stays silent instead of guessing.

The roster is **per conversation**: it walks only the current session's own subtree (its catalog, then each loaded child catalog), so cleared members from other conversations never leak into this menu.

## Closing semantics

1. `workspaceRegistry.archiveSession(childId, { stopActivity: true })` writes a durable archive;
2. the session's own running turn is cancelled (like the user's stop button) and running descendants are cancelled with parent cause;
3. the archived session leaves the workspace sidebar; `team_restore` (or unarchiving in the GUI) brings it back;
4. later model steps are blocked by DSH's built-in gates: since DSH 44.7.0 the session controller rejects steps for agents whose **own** session is archived, and the subagent runtime's archive admission also checks managed ancestors — the plugin adds no gate of its own;
5. capacity: a subagent that finishes normally settles by itself and frees its activation slot — no plugin needed. Archiving changes activity and visibility, not settlement guarantees: an idle member whose inbox still holds parked input may stay resident and keep its slot after archiving (DSH exposes no public dispose or inbox-clear API);
6. settlement confirmation: `team_close` polls the agents registry for up to ~2s after archiving (200ms steps, honoring cancellation) and reports `settled, slot released` when the member leaves the registry, or `still resident — slot may be retained (parked inbox input)` on timeout;
7. `team_restore` makes a member resident again and occupies a capacity slot; with the optional `prompt` the message is delivered right after unarchiving (restore-and-continue), without it no turn starts.

Closing never deletes history; archived sessions stay recoverable. Closing frees **neither** the child's name nor its `list_agents` row (catalog entries are permanent); whether the activation slot frees depends on the manager's settlement (point 5).

## Limitations

- `list_agents` reads parent-owned catalogs whose membership entries are permanent: closed members may still appear there as `inactive`. Use `team_overview` for the closed marker.
- Closing does not free the child's name; names stay reserved among the creator's children (Harness rule).
- Archiving does not force-free capacity: a member idle with parked input in its inbox may stay resident (slot still occupied) after `team_close`/`team_sweep`.
- Requires a host composition with `subagents` + `tools`; `workspaceRegistry` is optional (close/restore degrade with a logged warning if absent).

## 中文说明

让智能体自己决策清理用完的子代理。**npm 正式支持**：`plugin_manager install_bundle dsh-team-janitor`（或先 `npm install dsh-team-janitor` 再装载同一 bundle），也可克隆本仓库后在 DSH 的 **Plugins → Add plugin** 里选择文件夹。

优势：**模型工具**（四个工具由智能体自主调用）、**可逆归档**（只归档不删除，`team_restore` 随时反悔，带 `prompt` 可恢复并继续）、**状态总览**（`closed`/`running`/`parked`/`settled` 四态）、**零侵入**（无 `@deepseek-ai` 依赖、不改宿主日志、不自建闸门）、**子树限定**（只作用于调用者自己的后代）、**last words**（缓存成员收尾发言辅助判断）、**已清除标记**（网页端子代理菜单下方红色徽章，按对话独立）。

四个工具（`team_overview` / `team_close` / `team_sweep` / `team_restore`）只作用于调用者自己的子树：关闭 = 停止运行 + 会话归档（从侧栏消失）。唤醒拦截由 DSH 内置闸门完成：44.7.0 起内置闸门已覆盖「自身已归档」与「祖先已归档」，插件不再自建闸门。正常完成的子代理会自动结算并释放槽位，无需插件；若空闲成员的 inbox 里还停放着输入，归档后槽位可能仍被占用（DSH 没有公开的 dispose/清空 inbox API）。`team_overview` 用 `parked`（仍驻留可能占槽）/`settled`（已结算已释放）区分空闲成员；`team_close` 归档后短轮询、如实回报是否结算。关闭不删历史、不释放名字。详见 `docs/DETAIL.md`。

## Changelog

- **1.1.4** — `team_overview` distinguishes `parked` (registered idle, slot may be held) from `settled` (disposed, slot released) and orders `closable now` accordingly; `team_close` polls ~2s after archiving and reports the observed settlement; `team_sweep` returns per-failure rows in `failuresDetail`; `team_restore` accepts an optional `prompt` for restore-and-continue. New browser half: a red **已清除 / Cleared** roster in the subagent catalog menu footer, driven by the live Workspace archive stream. Tool names and required parameters unchanged.
- **1.1.3** — Target DSH 44.7.0 (`@deepseek-ai/dsh-subagent` 0.2.2-rc.5): dropped the plugin's own `agent/pre-step` archive gate (built-in gates now cover self-archived sessions and managed ancestors); reworded tool descriptions so closing no longer promises a freed capacity slot. Tool names, parameters, and output shapes unchanged.
- **1.1.2** — First clean npm release: strips the UTF-8 BOM that made strict JSON parsing reject 1.1.0/1.1.1 (both deprecated).
- **1.1.0** — Initial release: `team_overview` / `team_close` / `team_sweep` / `team_restore`.

## License

[MIT](LICENSE)
