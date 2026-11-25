# dsh-team-janitor

Team collaboration QoL for DeepSeek Harness (DSH): the agent can decide to close subagents whose work is done — single close, idle sweep, compact team overview, and restore.

## Why

Subagent trees grow cluttered: finished children stay in `list_agents` forever and their sessions pile up in the workspace sidebar. A subagent that finishes normally settles by itself and frees its activation slot (`maxActiveSubagents`) — no plugin is needed for capacity. What DSH lacks is a **model-facing way to close a member for good**: archive it, see it as `closed`, and reopen it if needed. This plugin fills that gap — model-side archiving, sidebar hygiene, a visible `closed` status, and reversible restore.

## Install

- From npm: `plugin_manager install_bundle dsh-team-janitor`.
- Or clone/download this repository and in DSH: **Plugins → Add plugin**, selecting the folder.

Requirements: the `subagents` and `tools` services (present in any preset with subagent delegation, e.g. Web/Desktop defaults). Without the `workspaceRegistry` service the plugin degrades to idle; without `subagents` it never activates.

The plugin is a single self-contained ESM file (`lib/index.js`) with zero dependencies. Targets DSH 44.7.0 (built-in `@deepseek-ai/dsh-subagent` 0.2.2-rc.5).

## Tools

All tools act only on the **caller's own subtree** (the root or any subagent can use them on their descendants):

| Tool | Effect |
|---|---|
| `team_overview` | Compact roster: `running` / `inactive` / `closed` per member, each member's last closing words (from the `subagent/end` event cache), and a `closable now` list |
| `team_close` | Close specific descendants (names from `team_overview`/`list_agents`, or session ids): stops their running work (and their running descendants), archives their sessions so they leave the workspace sidebar |
| `team_sweep` | Batch-close idle descendants; `preview` defaults to true (list only), `preview: false` executes, `includeRunning: true` also closes running agents |
| `team_restore` | Unarchive previously closed members so they are visible and continuable again |

A short `team-janitor:hygiene` system-prompt context nudges the agent toward closing finished subagents whenever the tools are visible.

## Closing semantics

1. `workspaceRegistry.archiveSession(childId, { stopActivity: true })` writes a durable archive;
2. the session's own running turn is cancelled (like the user's stop button) and running descendants are cancelled with parent cause;
3. the archived session leaves the workspace sidebar; `team_restore` (or unarchiving in the GUI) brings it back;
4. later model steps are blocked by DSH's built-in gates: since DSH 44.7.0 the session controller rejects steps for agents whose **own** session is archived, and the subagent runtime's archive admission also checks managed ancestors — the plugin adds no gate of its own;
5. capacity: a subagent that finishes normally settles by itself and frees its activation slot — no plugin needed. Archiving changes activity and visibility, not settlement guarantees: an idle member whose inbox still holds parked input may stay resident and keep its slot after archiving (DSH exposes no public dispose or inbox-clear API).

Closing never deletes history; archived sessions stay recoverable. Closing frees **neither** the child's name nor its `list_agents` row (catalog entries are permanent); whether the activation slot frees depends on the manager's settlement (point 5).

## Limitations

- `list_agents` reads parent-owned catalogs whose membership entries are permanent: closed members may still appear there as `inactive`. Use `team_overview` for the closed marker.
- Closing does not free the child's name; names stay reserved among the creator's children (Harness rule).
- Archiving does not force-free capacity: a member idle with parked input in its inbox may stay resident (slot still occupied) after `team_close`/`team_sweep`.
- Requires a host composition with `subagents` + `tools`; `workspaceRegistry` is optional (close/restore degrade with a logged warning if absent).

## 中文说明

让智能体自己决策清理用完的子代理。安装：`plugin_manager install_bundle dsh-team-janitor`，或克隆本仓库后在 DSH 的 **Plugins → Add plugin** 里选择文件夹。四个工具（`team_overview` / `team_close` / `team_sweep` / `team_restore`）只作用于调用者自己的子树：关闭 = 停止运行 + 会话归档（从侧栏消失）。唤醒拦截由 DSH 内置闸门完成：44.7.0 起内置闸门已覆盖「自身已归档」与「祖先已归档」，插件不再自建闸门。正常完成的子代理会自动结算并释放槽位，无需插件；若空闲成员的 inbox 里还停放着输入，归档后槽位可能仍被占用（DSH 没有公开的 dispose/清空 inbox API）。`team_restore` 可反悔；关闭不删历史、不释放名字。详见 `docs/DETAIL.md`。

## Changelog

- **1.1.3** — Target DSH 44.7.0 (`@deepseek-ai/dsh-subagent` 0.2.2-rc.5): dropped the plugin's own `agent/pre-step` archive gate (built-in gates now cover self-archived sessions and managed ancestors); reworded tool descriptions so closing no longer promises a freed capacity slot. Tool names, parameters, and output shapes unchanged.
- **1.1.2** — First clean npm release: strips the UTF-8 BOM that made strict JSON parsing reject 1.1.0/1.1.1 (both deprecated).
- **1.1.0** — Initial release: `team_overview` / `team_close` / `team_sweep` / `team_restore`.

## License

[MIT](LICENSE)
