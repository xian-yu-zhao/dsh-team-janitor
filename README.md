# dsh-team-janitor

Team collaboration QoL for DeepSeek Harness (DSH): the agent can decide to close subagents whose work is done — single close, idle sweep, compact team overview, and restore.

## Why

Subagent trees grow cluttered: finished children stay in `list_agents` forever, stalled children hold activation capacity slots (`maxActiveSubagents`, default 8), and their sessions pile up in the workspace sidebar. DSH ships stop (`interrupt_agent`) and messaging, but **no model-facing way to close a member for good** — the control package's own README defers deletion to "a later product decision". This plugin fills that gap.

## Install

1. Clone or download this repository.
2. In DSH: **Plugins → Add plugin** and select the cloned folder. From an agent session, `plugin_manager install_bundle` with the folder path works too.
3. Requirements: the `subagents` and `tools` services (present in any preset with subagent delegation, e.g. Web/Desktop defaults). Without the `workspaceRegistry` service the plugin degrades to idle; without `subagents` it never activates.

No npm package yet — install from source. The plugin is a single self-contained ESM file (`lib/index.js`) with zero dependencies.

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
3. the subagent manager's natural-settlement watcher then releases the resident activation and its capacity slot;
4. the archived session leaves the workspace sidebar; `team_restore` (or unarchiving in the GUI) brings it back;
5. the plugin registers an extra `agent/pre-step` gate: an agent whose **own** session is archived rejects every later model step until restored. DSH's built-in gate only covers archived *ancestors*, so without this gate a closed member could still be woken by `send_message` — with it, closing is authoritative.

Closing never deletes history; archived sessions stay recoverable. Closing frees the capacity slot but **not** the child's name (catalog entries are permanent) or its `list_agents` row.

## Limitations

- `list_agents` reads parent-owned catalogs whose membership entries are permanent: closed members may still appear there as `inactive`. Use `team_overview` for the closed marker.
- Closing does not free the child's name; names stay reserved among the creator's children (Harness rule).
- Requires a host composition with `subagents` + `tools`; `workspaceRegistry` is optional (close/restore degrade with a logged warning if absent).

## 中文说明

让智能体自己决策清理用完的子代理。安装：克隆本仓库后在 DSH 的 **Plugins → Add plugin** 里选择文件夹（或让智能体用 install_bundle 装载）。四个工具（`team_overview` / `team_close` / `team_sweep` / `team_restore`）只作用于调用者自己的子树：关闭 = 停止运行 + 会话归档 + 阻断后续唤醒（插件自带 pre-step 闸门补上了 DSH 内置闸门只拦祖先的缺口），容量槽位随之释放；`team_restore` 可反悔。关闭不删历史、不释放名字。详见 `docs/DETAIL.md`。

## License

[MIT](LICENSE)
