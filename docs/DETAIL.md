# Team janitor

一句话：**只归档、不删除；可恢复；看得到子代理结束后的结果。**

从 npm 安装（`plugin_manager install_bundle dsh-team-janitor`），或克隆本仓库后在 DSH 的 **Plugins → Add plugin** 选择文件夹（本地开发直接用 `link:D:\path\to\dsh-team-janitor`）。插件给调用方（树根或任意能派活的子代理）提供三个模型工具，全部只作用于**调用者自己的子树**：

| 工具 | 作用 |
|---|---|
| `team_overview` | 结果视图：每个成员一行「名字 + 状态 + 收尾原话」。状态为 `running` / `done` / `failed` / `refused` / `aborted` / `idle` / `closed` / `unknown`，另附 `closable`（调用者自己可关的后代，有结果的在前，运行中的不列）。`lastWords:false` 只要花名册与原话之外的信息 |
| `team_close` | 关闭指定后代（名字或 session id）：归档会话（可逆，不删任何东西）+ 请求停止其运行中的工作及其后代；整批只做一次结算轮询，逐条回报 `outcome`（`closed` / `already-closed` / `duplicate` / `unknown` / `refused` / `cancelled` / `failed`）与 `settled`（`true` 已释放 / `false` 仍驻留） |
| `team_restore` | 取消归档：恢复可见与可继续；可选 `prompt` 在恢复后立即投递（恢复并继续，冷目标会重新占槽）；一次性子代理不接受 `prompt` |

`team_sweep` 在 2.0.0 被移除（与 `team_close` 重复，且「先预览再执行」多一次模型往返）：原来 `team_sweep({ preview:false })` 的用法改为 `team_close({ agents: [...] })`，名字取自 `team_overview`；预览调用可以整段删掉，因为 `team_close` 本来就会逐条回报 outcome，打错名字只是多一行 `unknown`/`refused`。

## 结果视图：状态怎么投影

状态按以下优先级判定（先命中先返回）：

| 顺序 | 条件 | 状态 |
|---|---|---|
| 1 | 会话在归档集合 `archivedSessionIds` 里 | `closed`（仍带 `result:` 上次结果与收尾原话） |
| 2 | `ctx.agents.get(id).status === 'running'`（无 `agents` 时退回目录条目的 `activity === 'running'`） | `running`（隐藏上一次运行的旧原话） |
| 3 | 有 `subagent/end` 结果记录 | `done`（completed）/ `failed`（error、max-tokens）/ `refused`（refusal）/ `aborted`（aborted）；其它后端变体 → `unknown` |
| 4 | 无记录，但目录条目 `createdAt` 晚于插件启动时刻 | `idle`（注册中、这次加载还没记到结果） |
| 5 | 无记录（内存与磁盘都没有），且条目早于插件启动时刻 | `unknown` |

**宁可报 `unknown`，不许把「没有记录」说成「已完成」。** 记录来自内存缓存与磁盘文件（见下节）：只要任一有记录，就按 `stopReason` 投影；两边都没有记录的成员，说明它结束在插件第一次看到它之前，如实报 `unknown`。树根自己不是子代理运行，没有结果记录，因此显示 `idle` 或 `running`。

原始 `stopReason` 会保留在输出的 JSON 里；当状态本身说不清时，渲染文本里也会写出来，例如 `[failed: max-tokens]`、`[unknown: transport-broke]`。已知取值来自 `@deepseek-ai/dsh-subagent` 的 `SubagentStopReasonMap`：`completed` / `aborted` / `error` / `max-tokens` / `refusal`（该联合类型可被后端扩展，所以未识别的取值一律 `unknown`）。

## 结果缓存与落盘文件

监听只读事件 `subagent/end`，按其 `SubagentRunEndInfo`（`{ runId, provider, parentSessionId, id, local, stopReason, lastAssistantMessage? }`）记录 `{ stopReason, endedAt, excerpt, runId }`：

- 上限 256 条，FIFO 淘汰（长会话可能见上千次运行），内存与文件用同一份裁剪顺序；
- `excerpt` 取 `lastAssistantMessage` 的文本、压平空白、截断到 100 字（成本分摊到每次调用）；
- `team_restore` 成功后删除该成员的记录并**立即**写盘——上一次运行的结果不属于重开后的新回合；
- 缓存只为花名册服务，异常一律吞掉，绝不打断事件分发。

### 文件位置与格式

`<DSH 主目录>/team-janitor/results.json`，`<DSH 主目录>` 先看环境变量 `DSH_HOME`，没有就用 `os.homedir()/.dsh`（即默认 `~/.dsh/team-janitor/results.json`）；目录不存在时创建。

```json
{ "version": 1, "updatedAt": 1700000000000,
  "results": { "<成员 session id>": { "stopReason": "completed", "endedAt": 1700000000000, "excerpt": "…", "runId": "…" } } }
```

- **加载**：激活时读一次并并入内存缓存（同一成员以内存中新到的记录为准，因为合并进的是空 Map）；文件里读取时字段缺失/类型不对的记录直接丢弃，不阻断加载。
- **写盘**：每次 `subagent/end` 后标记脏，并把一波事件合并成一次约 500ms 的写；写盘是**原子**的（先写 `results.json.tmp` 再 `rename`），按同一 256 条顺序裁剪；定时器 `unref()`，绝不拖住宿主进程退出；插件卸载时把窗口里未落盘的记录刷一次。
- **损坏**：不是合法 JSON、`version` 不符、`results` 形状不对——把文件改名成 `results.json.corrupt`，打一条 warn，从空缓存开始。**激活不会因为坏文件失败。**
- **读写失败**（磁盘满、权限不足）：只打日志，内存缓存照常工作。

### 隐私

文件里保存每个成员最后一条回复的前 100 个字符（以及 `stopReason` / `endedAt` / `runId`）。**卸载插件不会自动删除这个文件**，介意的话手动删 `~/.dsh/team-janitor/results.json`。

### 开关 `persistResults`

默认 `true`。在插件 config 里设 `false` 即只用内存（不读也不写文件）：

```yaml
- insert:
    - id: team-janitor
      name: 'dsh-team-janitor'
      config:
        persistResults: false
```

插件**没有声明 `Config` schema**：声明它需要 `@deepseek-ai/schemastery`，而本插件的硬约束是零 `@deepseek-ai/*` 导入。DSH 的加载器在没有 schema 时把 patch 里的原始 config 对象原样传给 `apply(ctx, config)`（`resolveConfig` 无 schema 即「returns config unchanged」），所以这个值从 patch 能生效，但**插件管理界面不会有对应的表单字段**。

## 工具声明范围（`when`）

三个工具都用 `tools.register(definition, { when })` 注册。`when(context)` 的放行条件：

1. `subagents.rootOf(agent).id === agent.id` —— 它是这棵子代理树的根；或
2. `tools.definitions(agent)` 里存在以 `subagent` 开头（`subagent` / `subagent_fork` / 自定义 `subagent_*`）的工具 —— 这一步它确实能派活。

`ToolActivationContext` 只带 `{ agent, modelSelection, signal }`（核自 `dsh-tools/src/contracts.ts`），所以判定全部来自「活代理的 scope」。取不到 agent 时**放行**（模型步不会出现这种情况，而看不懂上下文时把工具藏起来更糟）。`rootOf` 抛错（无活的运行时所有者）时退回条件 2。

已验证的宿主行为（`dsh-tools/src/index.ts`，0.2.2-rc.5）：

- `when` 为假 → 「excludes it from both declarations and dispatch」：既不进本步 `schemas()`，也不可分发；
- `tools.get(name, scope, toolSet)` 在给了本步 `toolSet` 时走 `toolSet.view(scope)`，**会**反映 `when` 结果；不给 `toolSet` 时走 `view(scope)`，只反映注册与限制，**不**反映 `when`；
- 系统提示的动态上下文在装配时带 `toolSet`，但**请求期 `refreshContext` 不带**（`dsh-agent-loop/src/agent.ts` 只传 `assembleContextFor(this, signal)` 与 `modelSelection`）。因此 `team-janitor:hygiene` 的文本在「按 `tools.get` 过滤可见工具」之外，**再执行一次 `when` 的条件**，保证它宣传的工具模型一定调得到。

三个工具发给模型的定义（名称 + 描述 + 参数，`{type:'function',function:{…}}` 序列化）合计约 **1486 字符**，由 `test/smoke.mjs` 的断言兜住（≤1500）。

## 关闭的语义

关闭 = 停止 + 归档，全部通过 DSH 公共 API 完成：

1. `workspaceRegistry.archiveSession(childId, { stopActivity: true })` 写入持久归档；
2. 会话自身的运行回合被取消（等价用户点停止），运行中的后代被以父因取消；
3. 归档的会话从工作区视图消失；`team_restore`（或用户在界面取消归档）可恢复；
4. 后续模型步由 DSH 内置闸门拦截：DSH 44.7.0 起会话控制器拒绝「自身会话已归档」成员的新模型步，子代理运行时的归档准入还会检查托管祖先——插件不自建闸门；
5. 容量：正常完成的子代理由管理器自动结算并释放槽位，无需插件；归档改变的是活动与可见性，不改变结算保证——空闲成员的 inbox 若还停放着输入，归档后可能仍驻留占槽（DSH 没有公开的 dispose 或清空 inbox 的 API）；
6. 结算确认：整批归档后**只做一次**轮询（约 2 秒预算、200ms 步长、尊重取消）——目标离开注册表则如实回报 `settled`（只陈述观察到的事实：已不在代理注册表里；**不说「腾出了槽位」**，因为成员通常早在关闭前就已完成并释放了槽位），超时仍在则 `still resident — slot may be retained (parked inbox input)`，调用被取消则 `settlement not observed (call cancelled)`；没有 `agents` 服务时如实回报无法观测。

`team_restore` 让成员重新驻留并重新占槽，带 `prompt` 时恢复后立即投递（投递失败不回滚恢复，只在 detail 里说明）。子树判定严格排除调用者自身（不能关/恢复自己）与树根，且「自己 / 树根」检查在目录查找之前——树根不在自己的后代列表里，否则会被误报成 `unknown`。

关闭**不会删除历史**：不删会话目录、不改会话日志、不写墓碑、不删数据库记录。名字不释放（Harness 规则），`list_agents` 的目录条目也永久保留（已关闭成员仍以 `inactive` 出现）。

归档集合（`archivedSessionIds`）是**profile 全局**的：`team_overview` 回答的是「这个会话在本 profile 里是否已归档」。按对话独立的是网页端标记（见下）。

## Web 界面的「已清除」标记

插件附带浏览器端模块（`client.js`，通过 `dsh.client` 声明）。在会话头部的子代理目录菜单中，树下方新增红色**「已清除的子代理」**区块：

- 数据来自 Host 权威的 Workspace follow 流（客户端 `ctx.workspaces.list`），归档/取消归档（`team_close` / `team_restore` / 界面手动）实时反映；
- 覆盖范围是**本对话自己的子树**：从当前会话的目录投影出发，只沿已加载的子目录逐层下探；
- 覆盖层级跟随目录树已加载的部分（与 lineage 渲染器读同一份 `subagentCatalog` 投影）；
- 菜单行在 DOM 上不带 session id、也没有行级扩展位（44.7.0 限制），因此落点是官方认可的根目录 footer slot；根会话的目录菜单可见，子会话面包屑里不显示。

## 已知限制

- `list_agents` 只看驻留（`inactive` 不代表完成与否），且条目永久：判断「谁关闭了、谁成功了、谁失败、谁拒答」请用 `team_overview`。
- 结果落盘到 `<DSH_HOME>/team-janitor/results.json`，里面是每个成员最后一条回复的前 100 字（外加 `stopReason` / `endedAt` / `runId`）。**卸载插件不会删除它**；`persistResults: false` 可改为只留内存。文件损坏会被改名成 `results.json.corrupt` 并清空缓存（旧记录因此丢失，但插件不会崩）。
- 早于插件第一次运行就结束、且没有记录在案的成员只能显示 `unknown`——`list_agents` 和会话目录都不提供历史结果，插件不读会话日志。
- 归档不强制释放容量：空闲成员若 inbox 里有停放输入，关闭后可能仍驻留占槽；`team_close` 只说 `settled`，不再声称腾出槽位。
- 关闭不释放名字；会话历史不会被删除（这是设计，不是缺陷）。
- 需要 `subagents`（含 `rootOf` / `listDescendants` / `resolveName`）与 `tools`；`workspaceRegistry` 缺失时插件照常加载，但关闭/恢复工具返回明确的「服务不可用」错误、不碰任何会话。
- `agents` 缺失时 `running` 退回目录条目的 `activity`，且无法观测结算；`systemPrompt` 缺失时只是没有卫生提示。
- `when` 只能按「本步能否派活 / 是否树根」收窄；达到 `maxDepth` 上限的子代理仍然能看到工具（上限只在调用 `subagent` 时报错），插件拿不到这个信息。

## 自检

仓库自带零依赖自检，不需要装 DSH：

```sh
npm run check   # 两个半球做语法检查
npm test        # 195 项断言，跑在假的 Cordis context 上
npm run verify  # 两者都跑
```

`test/smoke.mjs` 覆盖：工具注册（恰好三个、无 `team_sweep`）、每种 status 投影（done / failed / refused / aborted / closed 带历史结果 / idle / unknown / 未知后端变体 / 无 `agents` 时退回 `activity`）、`unknown` 的两种场景（无记录、重启语义）、`closable` 范围与排序、`when` 的放行与拒绝（树根 / 能派活 / 纯子代理 / 空上下文）、卫生提示与可见工具的一致性（含 `toolSet` 缺失的请求期刷新）、结算结论、去重、拒绝路径、恢复并继续、恢复后旧结果失效、声明预算 ≤1500 字符、以及打包不变量（无 `@deepseek-ai` 导入、bundle 与网页半身清单、发布文件集、宿主端只写一个原子文件且不碰会话日志、`client.js` 无 `node:` 导入）。

落盘相关的新用例：一次合并写盘并校验文件格式；模拟重启后新实例从文件读回（`done` / `aborted` / `refused` 都正确投影，无记录者仍是 `unknown`）；有记录时 `watchingSince` 不再压制；坏 JSON 与错版本都被改名成 `.corrupt` 且激活不失败；`team_restore` 立即把记录从文件删除；文件里同样是 256 条上限；`persistResults: false` 完全不写盘。**所有用例的 `DSH_HOME` 都指向系统临时目录**，绝不碰真实的 `~/.dsh/team-janitor/`。CI 在 Node 20 / 22 上跑同一套。
