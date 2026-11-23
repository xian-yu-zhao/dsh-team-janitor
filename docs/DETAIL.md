# Team janitor

让智能体自己决策清理用完的子代理。安装后，调用方（root 或任意子代理）会获得四个工具，全部只作用于**调用者自己的子树**：

| 工具 | 作用 |
|---|---|
| `team_overview` | 紧凑花名册：每个成员标 `running` / `inactive` / `closed`（已归档）及 `closable now` 列表 |
| `team_close` | 关闭指定后代（名字或 session id）：停止其运行中的工作（含其运行中的后代），并把会话归档，从侧边栏消失 |
| `team_sweep` | 批量关闭闲置后代；默认 `preview=true` 只列候选，`preview=false` 才执行；`includeRunning=true` 连运行中的也关 |
| `team_restore` | 把已关闭（归档）的成员取消归档，恢复可见与可继续对话 |

## 关闭的语义

关闭 = 停止 + 归档，全部通过 DSH 公共 API 完成：

1. `workspaceRegistry.archiveSession(childId, { stopActivity: true })` 写入持久归档；
2. 会话自身的运行回合被取消（等价用户点停止），运行中的后代被以父因取消；
3. 子代理管理器的自然结算观察器随后释放驻留激活与容量槽位；
4. 归档的会话从工作区侧边栏消失；`team_restore`（或用户在界面取消归档）可恢复；
5. 插件自带 `agent/pre-step` 闸门：自身会话已归档的成员会拒绝一切新模型步，直到被恢复——DSH 内置闸门只拦「祖先已归档」，这道闸让「关闭」名副其实（关闭后 send_message 不会把它唤醒干活）。

关闭**不会删除历史**；归档可逆。`team_overview` 会把归档成员标为 `closed`，并展示成员最近一次收尾发言（来自 `subagent/end` 事件缓存），方便判断「是否真的用完了」。

## 已知限制

- `list_agents` 基于父会话日志里的 catalog 条目，条目是永久的：已关闭的成员可能仍以 `inactive` 出现在其中。判断「谁已关闭」请用 `team_overview`。
- 关闭不释放名字：名字在创建者的子代理目录里仍然占用（Harness 规则）。
- 需要宿主组合里有 `subagents` 与 `tools` 服务；`workspaceRegistry` 缺失时插件自动闲置并在日志提示。
