# Harness 原生会话与聊天模块复用推进方案

状态：2026-11-09，已接通官方 Gateway 的只读会话通道、被动实时订阅与开发版原生会话预览；逐 token 的临时流式显示、官方聊天插件挂载和主聊天迁移仍待验证。

## 目标与当前判断

保留 LoliCode 的 Tauri/Rust 桌面能力、渠道与账号体系，优先复用官方的会话事件、会话控制器及聊天插件。先验证组合边界，再决定是否进一步采用官方 Web Host 的插件组合。采用官方 Host 与更换 Electron 外壳是两项独立决策。

当前官方运行时已持有原生会话日志。主要问题出现在显示链路：

1. `packages/lolicode-harness-runtime/host-operations.mjs` 扩展官方 SDK 服务，转发会话事件，并另行发布 Assistant 流式通知。
2. `src-tauri/src/services/harness_snapshot.rs` 把选定事件转成 `AgentSnapshot`，内部虽使用 turn/step 协调流式与提交消息，但没有把完整关系传入聊天 DTO；turn 结束原因也被折叠为界面状态或错误。
3. `crates/lolicode-agent/src/dto.rs` 与 `src/types/agent.ts` 的 `AgentMessage` 以角色和内容片段为主，没有原生事件序号、turn、step 等结构。
4. `src/features/agent/AgentTranscript.tsx` 因而按照消息内容推断分组。

这不代表原生日志已经被删减；需要减少的是客户端为了恢复原生含义而重复实现的逻辑。不要另建一套长期维护的“完整 Harness 日志格式”，也不要先给旧 DTO 大量补字段，再从它反向构造官方事件。

## 已验证的复用边界

基线固定为 `@deepseek-ai/dsh@0.2.2-rc.1`，对应上游提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。

离线验证命令：

```powershell
node packages/lolicode-harness-runtime/probes/session-reuse.mjs
```

探针直接使用已安装的官方包，不启动 Agent，不调用模型，不读取用户会话，也不修改官方 npm 包。实际通过的检查：

- 官方 `Session` 与 `SessionProjectionRegistry` 可以在没有完整 Web Host 的 Node 环境中运行。
- 探针自有的投影 fold 能保留样例事件的 seq、time、type、data、turn/step 和 `max-tokens` 结束原因；快照具有对应的 `asOfSeq`。
- 未声明客户端 wire 视图的投影不会出现在客户端快照中。
- 增量读取与 checkpoint 后缀冷恢复在同一日志位置一致；投影版本不符时可退回全量回放。
- 使用种子创建 Session 会额外产生官方 `session/end-seed` 生命周期事件，不能假设创建后日志长度或序号不变。
- 官方 Session Controller、UI Session、UI Chat 的已发布客户端文件能向官方模块加载器注册。

最后一项只捕获模块注册，没有执行插件工厂、挂载 React 或验证服务组合。不能据此宣称官方聊天已经在 LoliCode 内可用。探针自有的 fold 也不等于对官方全部业务投影的验证。

官方客户端产物使用 `window.__ModuleLoader__`，不是可以直接放进现有 Vite 页面 import 的独立 React 聊天组件。UI Chat 声明了会话、工作区、连接、布局、渲染器、设置等依赖；UI Session 还需要 Remote Access 等服务。

官方 Session Controller 则已经提供原生事件分页、follow、带序号的投影、流式与持久化事件衔接、断线补齐等能力。它经官方 API Gateway 工作，不能假设当前 SDK JSON-RPC 与它的 Remote 接口兼容。

## 实际 SDK 组合验证结果

可重复检查：

```powershell
node --test packages/lolicode-harness-runtime/tests/session-controller-reuse.test.mjs
```

该测试启动真实官方 SDK，并加载当前 LoliCode 的 `profile.cordis.patch.yml` 与 `host-operations.cordis.patch.yml`，额外组合以下官方插件：

- `dsh-client-connection`：提供 Connection 服务；没有 Web Server 时不会因此开启 HTTP 监听。
- `dsh-client-file-upload`：满足官方控制器的文件上传服务依赖。
- `dsh-workspace`：提供 Workspace Registry。
- `dsh-api-session-controller`：目标会话控制器。
- `dsh-session-stats` 与 `dsh-session-turn-outline`：附加官方统计和 turn 导航投影，不是上面四项服务依赖的最小性证明。

没有替换 SDK 服务、仿写官方依赖或修改官方包。测试使用独立临时 HOME/工作区与 Node IPC 探针，不读取用户配置或用户日志。专用 fixture 通过官方 Session/JSONL 后端生成并持久化，随后所有检查只读。fixture 包含三轮、三个 step、`max-tokens` 结束原因、用户来源/请求 ID、surface 元数据，以及官方插件补写的标题事件，共 16 条事件。

已通过：

- SDK 的真实 `initialize` / `shutdown` 与新增服务可以共存。
- 官方控制器分多页返回的事件，按原始顺序拼接后与 `sessionQuery.readSession` 的事件逐字段一致。
- 投影水位与事件日志末尾一致；官方 turn 导航、统计投影可以直接获得。
- `follow` 的首个快照携带一致的日志位置与状态投影。
- 退出进程、重新启动后，不先恢复 Agent，仍能读取一致的完整事件与投影。
- 热读与冷读前后 Agent 数均为零，运行时未挂载 Web Server。
- 热读、冷读及退出后，已有 fixture JSONL 文件的字节保持不变。

这项早期探针经专用 IPC 直接调用官方宿主服务，只证明服务可组合；后续实际接入使用下面的正式 Gateway 通道，不将探针 IPC 作为产品接口。

由此确定第一批优化的优先级：先打通客户端到官方控制器的正式传输并保持官方事件/投影契约，再验证官方聊天渲染。暂时没有为了获得只读会话能力而切换完整 Host 的必要。

## 第一批实现与使用方式

开发版选择一个原生 Harness 会话后，通过“对话更多选项”菜单的“原生会话预览”打开只读面板。默认关闭，主聊天界面保持原有路径。支持查看已提交事件、结束原因、被动实时更新、手动刷新和向前分页；不展示原始 JSON，也不执行模型、工具或授权操作。

链路是 `agentApi.readSessionNative` → Tauri `read_agent_session_native` → 已有私有 SDK stdio 的 `lolicode/session/read-native` → 官方 Gateway 的 `session/events`、`session/projections`、`session/state`。Node 桥先执行现有 root/worker 归属检查，再使用固定 `owner`、`interactions: none` Peer 调用；线上的请求不能指定身份或任意服务方法。输入和结果由固定版本的官方生成契约校验，校验后返回原始值，不丢弃额外事件字段。

Rust 的冷热读取与 Markdown 共用项目窗口、会话归属、迁移历史和私有目录校验。冷读取启动独立临时 HOME 的官方 SDK 基底，禁用 SDK 应用入口与服务器；不恢复 Agent，不继承渠道凭据，不修改原 JSONL。冷读取全局最多同时运行两个 helper，排队与执行共用一个超时期限，避免快速切换会话放大进程数量。桌面调用的临时 HOME 由 Rust 持有，独立任务负责进程退出与清理，包含调用取消和超时路径；独立运行 Node CLI 时仍由 Node 创建和清理。

会话控制器及必要服务只在首次原生读取时装配，已有服务会复用；不会因普通聊天启动而额外装配整套 Web Host，也不新增 HTTP 监听。开发资源包已包含新 helper，构建脚本会将根目录 runtime 文件纳入输入哈希。

前端直接引用固定上游的公开类型，保留原始事件和投影。历史分页固定首次页面的 `cursor`；状态与投影保留各自的官方水位，运行中允许比历史页面更新。切换会话或刷新后丢弃过期响应，不混入其他会话的数据。超过 8 MiB 的响应明确拒绝而不截断事件。

相关检查：

```powershell
pnpm prepare:harness-runtime
pnpm typecheck
node --test packages/lolicode-harness-runtime/tests/*.test.mjs
pnpm exec vitest run tests/hooks/useAgentNativeSession.test.tsx tests/components/AgentNativeSessionPreview.test.tsx tests/lib/agentNativeWatch.test.ts
```

真实 stdio/Gateway 测试已覆盖热读、冷读、完整事件、来源元数据、结束原因、越权子会话、分页边界与输出限制；冷读前后原日志内容、mtime 和原 HOME 文件集合保持一致。Rust 还验证了模型请求和授权未答时并发只读不会阻塞执行通道。

### 被动实时订阅

预览先读取历史，然后尝试 `watch_agent_session_native` → `lolicode/session/follow-native` → 官方 Gateway `session/follow`。仅对已有运行时与归属明确的驻留会话建立订阅；冷会话保留手动历史读取，不启动额外长期监听进程，也不轮询文件。

官方发布的客户端 `SessionEventStream` 会设置 `activate: true` 与 `assistantStream: true`；直接复用会恢复 Agent，不符合只读预览的边界。本批因此只复用官方 Gateway 的被动 follow，不传这两个选项。原样转交官方起始快照与已提交事件，完整保留最终 `assistant/message` 的 `data.stream`，不把临时 token 拼成日志事件，也不声称已复用官方客户端的自动重连。后续事件只推进日志位置，不在前端重写投影 fold；投影与 state 仍保留各自读取时的官方水位，不能当作持续刷新的状态。

前端按官方序号检查连续性，忽略重复事件；序号缺口、重复起始快照或连接结束会停止订阅并保留已收到的历史，用户可以刷新重新取得官方快照。刷新失败也保留上一次成功结果。实时跟随期间暂停历史分页；点击“暂停实时更新”后可加载更早记录，刷新会重新开启订阅。会话切换、面板关闭及过期启动响应会关闭对应订阅，不停止正常对话。

实时通知不进入主聊天的 Harness 事件队列。每个 SDK 最多八个订阅，Rust 为每个订阅单独限制 64 帧、16 MiB 队列，单帧最多 8 MiB。Node 在发送预览帧前也检查共享输出的缓冲高水位，超过 16 MiB 时停止该订阅继续加帧，不在共享传输上等待 drain。Tauri 每次只投递一帧，渲染层处理后确认；起始快照或投递确认等待 30 秒超时后终止该订阅，成功连接后的订阅没有普通 RPC 的生命周期时限。队列溢出或界面失联只结束观察，不取消模型请求、工具或授权。确认与停止命令验证窗口归属，避免其他项目窗口干扰。

以上限制约束 Rust 队列与 WebView 投递，并非对整个 Node stdio 或预览累计历史内存的端到端上限证明。后续进入主聊天前仍须测量长会话和极端事件突发的资源使用。

本批回归使用真实 SDK 与本地模型 fixture，验证并发订阅、同编号竞争、八订阅上限、观察期间模型调用数不变、临时 token 不进入被动日志、单独停止、重新取得快照和带活动订阅的正常退出。故障注入覆盖首次初始化失败后的重试与输出缓冲保护；前端覆盖旧响应隔离、序号缺口、断流保留、刷新失败和暂停/翻页。Rust 另外验证队列溢出仍可继续处理执行/授权消息、窗口确认隔离及冷读 helper 的取消清理。

这仍是可回退的开发入口，尚未替换主聊天 reducer，未接入逐 token 临时显示，也未挂载官方 UI Chat。下一步应验证官方聊天插件与事件源的组合，并完成下面的验收门槛。

## 实施顺序与交付边界

### 第一批：官方会话控制器接入实验

新增一个默认关闭、使用隔离配置与临时会话的实验入口，先只显示一个选中会话的事件和状态，不替换现有聊天区。

先运行官方 Web 组合，作为行为参照；再尝试在现有 SDK 运行环境中组合最少量的官方 Session Controller、Gateway 与必要服务。记录实际需要增加的插件及其依赖，不通过模拟官方服务来宣布复用成功。

客户端保留官方 `SessionWireEvent` / Session 事件源和投影契约。Rust 只承担确有必要的进程、授权与通道桥接；不把事件先压平成 `AgentMessage`，也不把流式临时片段存成已提交事件。保留官方日志作为唯一会话事实来源，快照缓存可以重建。

先通过只读路径，再接提交与取消。实验入口不得开放未认证的本地端口；所有读写保持项目、根会话和子会话的归属限制。宿主内部对象、凭据与未声明 wire 视图的投影不得随意转交渲染层。若确需脱敏，明确列出字段与语义，不把任意裁剪称为完整事件。

交付：可重复运行的实验入口、真实服务依赖清单、与官方参照的结果比较。失败时明确是传输、插件依赖、会话身份还是存储边界阻塞。

### 第二批：官方聊天插件挂载实验

在同一实验入口使用官方模块加载与插件环境，依次组合 UI Session、UI Conversation 和 UI Chat；保留其 SessionBinding、事件源、投影及 Slot/Factory 扩展机制。

先验证历史显示、流式回复与 turn 过程折叠，再验证权限请求、工具、附件和子会话。LoliCode 的文件打开、渠道状态与产品操作通过正式扩展面接入，不复制官方私有 store、组件或事件 reducer。

在 Tauri WebView 中检查样式作用域、React 运行时、快捷键和滚动所有权。模块注册或浏览器打包成功不算聊天验收通过。

交付：同一段会话在官方参照和实验入口的对照结果，以及必须保留的适配代码清单。

### 第三批：根据实验决定 Host 范围

若少量官方服务即可复用会话控制器与聊天插件，保留现有宿主组合，逐步删除重复的会话显示转换。

若需要不断仿写 Gateway、会话生命周期、重连和官方服务，优先评估引入官方 Web Host 的完整组合，让 Rust 通过少量明确接口提供产品能力。评估内容包括宿主启动与退出、模型网关和凭据归属、工具执行、冷历史迁移、渠道切换及打包更新。

不以“能渲染聊天”单独决定迁移，也不预设 Rust 或 Electron 的性能结论。记录启动耗时、内存和长会话交互基线后再比较。

### 第四批：小范围替换与删除旧链路

选定方案通过验收后，以可回退的功能开关接入主聊天区。当前 `AgentSnapshot` 继续服务尚未迁移的功能，不要求一次重写整个工作台；新聊天路径直接消费官方会话模型。

逐项迁移消费者后，删除对应的 `harness_snapshot.rs` 显示投影、前端推断分组与重复流式衔接逻辑。旧引擎迁移历史单独处理；没有完整原生日志时明确标识，不能从旧 DTO 伪造完整官方历史。

## 进入主界面的验收门槛

- 同一日志位置的热读取、冷读取和重启后读取保留相同事件内容、turn/step、结束原因和投影状态；官方恢复补写的生命周期事件单独核对。
- 分页、重复通知、掉线和序号缺口不会丢消息或重复显示；临时 Assistant attempt 与最终持久化事件正确交接。
- 一个 turn 内多条 Assistant 消息、同一步重试、工具失败、取消、token 上限与进程中断均有正确呈现。
- fork 保留精确继承前缀；子会话、后台执行和不同项目之间的身份与权限正确。
- 历史加载和重连不会自动重发提示、重复执行工具或代答授权；附件和工具结果的原生引用保持可用。
- 渠道切换、关闭窗口、重启恢复与现有原生 Markdown 导出不退化；长会话滚动、分页耗时和内存有实测对照。

当前实现不覆盖上述全部端到端门槛。被动实时提交已接通，后续应继续验证临时 Assistant 流、官方客户端事件源与聊天插件，而不是继续扩充旧聊天 DTO。

## 上游依据

- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/README.md)：Remote、历史、流式、重连、投影与访问控制。
- [Session Projection](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/session-projection/README.md)：投影注册、客户端 wire 视图与状态恢复；实际导出与类型以安装包为准。
- [UI Chat](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-chat/README.md) 与 [UI Session](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-session/README.md)：会话绑定与聊天渲染扩展面。
