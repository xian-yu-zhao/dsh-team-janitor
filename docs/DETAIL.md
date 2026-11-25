# Team janitor

让智能体自己决策清理用完的子代理。从 npm 安装（`plugin_manager install_bundle dsh-team-janitor`），或克隆本仓库后在 DSH 的 **Plugins → Add plugin** 选择文件夹；也支持先 `npm install dsh-team-janitor` 再装载其包目录。安装后，调用方（root 或任意子代理）会获得四个工具，全部只作用于**调用者自己的子树**：

| 工具 | 作用 |
|---|---|
| `team_overview` | 紧凑花名册：每个成员标 `closed`（已归档）/ `running` / `parked`（在注册表中但无运行回合，可能仍占槽）/ `settled`（已出注册表，槽位已释放），附最近收尾发言与 `closable now` 列表（parked 优先，settled 其后） |
| `team_close` | 关闭指定后代（名字或 session id）：停止其运行中的工作（含其运行中的后代），归档会话并从侧边栏消失，随后短轮询确认是否真的结算（回报 `settled, slot released` 或 `still resident`） |
| `team_sweep` | 批量关闭闲置后代；默认 `preview=true` 只列候选，`preview=false` 才执行；`includeRunning=true` 连运行中的也关；失败逐条记入 `failuresDetail` |
| `team_restore` | 取消归档恢复可见与可继续对话；可选 `prompt` 在恢复后立即投递消息（恢复并继续，目标重新占槽），不带 `prompt` 则只恢复可见性、不启动回合 |

## 特点

- **模型工具**：四个由智能体自主调用的工具，清理动作无需用户逐个点停；
- **可逆归档**：只归档不删除，`team_restore` 随时可反悔，还支持「恢复并继续」；
- **状态总览**：`closed` / `running` / `parked` / `settled` 四态一目了然，并附成员收尾发言；
- **零侵入**：不改宿主日志、不自建闸门、无 `@deepseek-ai` 依赖，卸载即恢复原状；
- **子树限定**：所有工具只作用于调用者自己的后代，旁支、父级与树根不可触碰；
- **lastwords**：通过 `subagent/end` 事件缓存每个成员的最后发言，辅助判断「是否真的用完了」；
- **已清除标记**：网页端子代理目录下方红色「已清除」徽章标出已归档成员。

## 状态语义

`team_overview` 的成员状态按 closed > running > parked > settled 判定：

- `closed`：会话在归档集合中（`archivedSessionIds` 命中），拒绝新模型步，直到 `team_restore`；
- `running`：`ctx.agents.get(id).status === 'running'`，回合在跑；
- `parked`：仍在注册表但无运行回合——成员可能仍驻留并占容量槽（如 inbox 停放着输入）；
- `settled`：id 已不在注册表——激活被 dispose，槽位已释放；对其关闭只剩「把会话归档出侧边栏」的意义。

`closable now` 先列 parked、再列 settled（不含 closed、调用者自身与树根）。

## 关闭的语义

关闭 = 停止 + 归档，全部通过 DSH 公共 API 完成：

1. `workspaceRegistry.archiveSession(childId, { stopActivity: true })` 写入持久归档；
2. 会话自身的运行回合被取消（等价用户点停止），运行中的后代被以父因取消；
3. 归档的会话从工作区侧边栏消失；`team_restore`（或用户在界面取消归档）可恢复；
4. 后续模型步由 DSH 内置闸门拦截：DSH 44.7.0 起会话控制器会拒绝「自身会话已归档」成员的新模型步，子代理运行时的归档准入还会检查托管祖先——唤醒拦截由内置机制完成，插件不再自建闸门；
5. 容量：正常完成的子代理由管理器自动结算并释放槽位，无需插件；归档改变的是活动与可见性，不改变结算保证——空闲成员的 inbox 若还停放着输入，归档后可能仍驻留占槽（DSH 没有公开的 dispose 或清空 inbox 的 API）；
6. `team_close` 的结算确认：归档后短轮询 agents 注册表（约 2 秒、200ms 步长、尊重取消）——目标离开注册表则回报 `settled, slot released`，超时仍在则回报 `still resident — slot may be retained (parked inbox input)`；`team_restore` 让成员重新驻留并重新占槽，带 `prompt` 时恢复后立即投递消息（投递失败不回滚恢复，只在 detail 中如实说明）。

关闭**不会删除历史**；归档可逆。`team_overview` 会把归档成员标为 `closed`，并展示成员最近一次收尾发言（来自 `subagent/end` 事件缓存），方便判断「是否真的用完了」。

## Web 界面的「已清除」标记

插件附带一个浏览器端模块（`client.js`，通过 `dsh.client` 声明）。在会话头部的子代理目录弹出菜单（后代计数触发的那个）中，树下方新增红色的**「已清除的子代理」**区块，列出会话 id 命中归档集合的目录条目：

- 数据来自 Host 权威的 Workspace follow 流（客户端 `ctx.workspaces.list`），归档/取消归档实时反映：`team_close`、`team_sweep` 或用户在界面里手动取消归档都会即时生效；
- 覆盖范围是**本对话自己的子树**：从当前会话的目录投影出发，只沿其已加载的子目录逐层下探，跨会话的已清除成员不会串进这个菜单；
- 覆盖层级跟随目录树已加载的部分：与 lineage 渲染器读的是同一份 `subagentCatalog` 投影，展开某分支后其层级才会进入名单；
- 菜单行本身在 DOM 上不带 session id、也没有行级扩展位（44.7.0 限制），因此官方认可的落点是根目录的 footer slot（与共享任务板同位）；根会话的目录菜单可见，子会话面包屑里不显示；
- workspace 状态服务缺失时标记保持沉默，不做猜测。

## 已知限制

- `list_agents` 基于父会话日志里的 catalog 条目，条目是永久的：已关闭的成员可能仍以 `inactive` 出现在其中。判断「谁已关闭」请用 `team_overview`。
- 关闭不释放名字：名字在创建者的子代理目录里仍然占用（Harness 规则）。
- 归档不强制释放容量：空闲成员若 inbox 里有停放输入，`team_close`/`team_sweep` 之后可能仍驻留占槽。
- 需要宿主组合里有 `subagents` 与 `tools` 服务；`workspaceRegistry` 缺失时插件自动闲置并在日志提示。
