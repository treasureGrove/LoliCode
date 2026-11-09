# Harness 原生会话与聊天模块复用推进方案

状态：2026-11-09，原生 Harness 会话的默认聊天已直接读取官方事件并接收临时 Assistant 流；独立“原生会话预览”入口已删除。完整官方 UI Chat 插件和 Web Host 尚未挂载，桌面业务兼容投影仍保留。

## 目标与当前判断

保留 LoliCode 的 Tauri/Rust 桌面能力、渠道与账号体系，优先复用官方的会话事件、会话控制器及聊天插件。先验证组合边界，再决定是否进一步采用官方 Web Host 的插件组合。采用官方 Host 与更换 Electron 外壳是两项独立决策。

默认会话原本就由官方 Harness 执行并保存原生日志。本轮改造前，显示链路存在以下重复转换：

1. `packages/lolicode-harness-runtime/host-operations.mjs` 扩展官方 SDK 服务，转发会话事件，并另行发布 Assistant 流式通知。
2. `src-tauri/src/services/harness_snapshot.rs` 把选定事件转成 `AgentSnapshot`，内部虽使用 turn/step 协调流式与提交消息，但没有把完整关系传入聊天 DTO；turn 结束原因也被折叠为界面状态或错误。
3. `crates/lolicode-agent/src/dto.rs` 与 `src/types/agent.ts` 的 `AgentMessage` 以角色和内容片段为主，没有原生事件序号、turn、step 等结构。
4. `src/features/agent/AgentTranscript.tsx` 因而按照消息内容推断分组。

当前默认原生聊天已改用官方 `SessionWireEvent` 和 Assistant attempt，不再从这条 `AgentMessage[]` 链路恢复聊天历史。旧快照仍供桌面状态、权限、问题、队列、重试和明确分类的旧迁移会话使用；不能据此宣称全部 Rust 转换已经删除。

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

## 早期 SDK 组合验证结果

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

## 当前默认聊天实现与使用方式

正常打开由 Harness 创建的 `lc:` 会话即可使用新路径，无需选择额外模式或打开预览。“原生会话预览”组件、菜单入口及其专用测试已移除。默认聊天显示原生用户/助手消息、推理、工具执行与结果、失败尝试、结束原因和临时回复；发送、取消、授权、提问和桌面队列继续使用现有产品操作。

链路是 `agentApi.readSessionNative` → Tauri `read_agent_session_native` → 已有私有 SDK stdio 的 `lolicode/session/read-native` → 官方 Gateway 的 `session/events`、`session/projections`、`session/state`。Node 桥先执行现有 root/worker 归属检查，再使用固定 `owner`、`interactions: none` Peer 调用；线上的请求不能指定身份或任意服务方法。输入和结果由固定版本的官方生成契约校验，校验后返回原始值，不丢弃额外事件字段。

Rust 的冷热读取与 Markdown 共用项目窗口、会话归属、迁移历史和私有目录校验。冷读取启动独立临时 HOME 的官方 SDK 基底，禁用 SDK 应用入口与服务器；不恢复 Agent，不继承渠道凭据，不修改原 JSONL。冷读取全局最多同时运行两个 helper，排队与执行共用一个超时期限，避免快速切换会话放大进程数量。桌面调用的临时 HOME 由 Rust 持有，独立任务负责进程退出与清理，包含调用取消和超时路径；独立运行 Node CLI 时仍由 Node 创建和清理。

正常会话打开、提交和恢复请求交给官方 SDK 执行前，先装配官方会话观察服务，已有服务会复用。这样即使前端稍后才建立订阅，官方 reconnect 快照也保有从 attempt 开始累积的临时流前缀。读取本身仍不能启动 Agent；没有额外装配整套 Web Host，也不新增 HTTP 监听。资源包包含读取 helper，构建脚本会将根目录 runtime 文件纳入输入哈希。

前端直接引用固定上游的公开类型，保留原始事件和投影。`AgentNativeTranscript` 按官方事件、turn、step 和 callId 渲染，不先构造 `AgentMessage[]`。人类聊天使用 append-origin 消息；模型侧 compaction replacement 不覆盖用户已经看到的历史，系统提示也不会冒充用户消息。工具视图只在渲染边界适配到现有卡片，不重写原始事件。

发送请求 ID 与官方消息 ID 的对应关系由宿主提供独立 `messageAliases` 映射，供本地发送回显去重、附件缓存和重试等桌面业务使用。映射不写入或改写官方事件的 id、source、序号或内容，也不凭文本与显示顺序推测身份。`AgentSnapshot` 继续承担桌面控制与旧数据兼容；默认聊天不会把普通读取失败当作切回旧 DTO 的理由。旧引擎迁移记录由宿主专用 `LOLICODE_SESSION_LEGACY_HISTORY` 分类明确进入兼容显示，不能伪装成完整原生历史。

历史分页固定起始历史 cut，实时日志 cursor 单独推进；状态与投影保留各自的官方水位，运行中允许比历史页面更新。原始记录窗口最多缓存最近三个会话，切换时先保留已有内容，再重新核对官方记录；临时 attempt 不作为持久化历史缓存。切换会话、隐藏工作台或刷新后，过期响应不能混入当前会话。超过 8 MiB 的响应明确拒绝而不截断事件。

相关检查：

```powershell
pnpm prepare:harness-runtime
pnpm typecheck
node --test packages/lolicode-harness-runtime/tests/*.test.mjs
pnpm exec vitest run tests/hooks/useAgentNativeSession.test.tsx tests/hooks/useAgentSnapshot.test.tsx tests/components/AgentNativeTranscript.test.tsx tests/components/AgentTranscript.test.tsx tests/components/AgentPage.test.tsx tests/lib/agentNativeWatch.test.ts
```

真实 stdio/Gateway 测试已覆盖热读、冷读、完整事件、来源元数据、结束原因、越权子会话、分页边界与输出限制；冷读前后原日志内容、mtime 和原 HOME 文件集合保持一致。Rust 还验证了模型请求和授权未答时并发只读不会阻塞执行通道。

### 官方实时记录与临时 Assistant 流

默认聊天先读取历史，然后尝试 `watch_agent_session_native` → `lolicode/session/follow-native` → 官方 Gateway `session/follow`。仅对已有运行时与归属明确的驻留会话建立订阅；冷会话按需读取已有日志，不启动额外长期监听进程，也不轮询文件。新请求使运行时可用后，桌面活动通知会触发重新读取和订阅。

官方发布的客户端 `SessionEventStream` 会设置 `activate: true` 与 `assistantStream: true`。当前接入使用同一个官方 Gateway follow，设置 `assistantStream: true` 接收即时回复，同时不传 `activate`，因此观察本身不会恢复 Agent。传输原样保留官方快照、提交事件和临时帧，不声称完整复用了官方客户端的自动重连或 UI Chat。

临时流使用官方公开的 `AssistantStreamAccumulator`、`expandAssistantStream` 与 `assembleAssistantStream`：接收起始 baseline 和增量 chunk，校验 attempt/revision/index，按上游格式保留时间戳与 chunk 边界，再交给上游 assembler 显示。最终 `assistant/message` 或 `assistant/attempt` 到达后撤下匹配的临时展示，避免同一回复显示两遍；临时内容不会被编造成已提交事件。投影与 state 仍保留各自读取时的官方水位，不由前端另写 fold 假装持续更新。

前端按官方序号检查连续性并忽略重复事件。序号缺口、无效起始快照或未完成 turn 的连接中断会停止订阅并保留已收到的历史；读取或刷新失败显式提示，允许重试，不静默降级到旧消息转换。尚未产生原生日志的新空会话仍可正常输入，请求开始后再按活动通知连接数据源。实时跟随期间也可加载更早记录：历史读取固定自己的 cut，将旧页合并到当前原始事件窗口，同时保留加载期间收到的新事件与活动 attempt，不要求暂停实时更新。会话切换、隐藏工作台及过期启动响应会关闭对应订阅，不停止正常执行。

原生观察通知使用独立传输队列，不进入桌面执行/授权事件队列。每个 SDK 最多八个订阅，Rust 为每个订阅单独限制 64 帧、16 MiB 队列，单帧最多 8 MiB。Node 在发送观察帧前检查共享输出的缓冲高水位，超过 16 MiB 时停止该订阅继续加帧，不在共享传输上等待 drain。Tauri 每次只投递一帧，渲染层处理后确认；起始快照或投递确认等待 30 秒超时后终止该订阅，成功连接后的订阅没有普通 RPC 的生命周期时限。队列溢出或界面失联只结束观察，不取消模型请求、工具或授权。确认与停止命令验证窗口归属，避免其他项目窗口干扰。

以上限制约束 Rust 队列与 WebView 投递，并非整个 Node stdio、临时 attempt 或累计聊天历史内存的端到端上限证明。长会话和极端事件突发的资源使用仍需量化。

回归覆盖真实 SDK 的热读、冷读、归属、观察期间不额外调用模型、并发订阅、取消和退出，以及官方临时流前缀与最终提交的交接；前端覆盖默认页面消费原生事件、旧响应隔离、消息别名、同一步重试、工具关联、结束原因、实时分页和三会话窗口缓存。故障注入覆盖首次初始化失败后的重试及输出缓冲保护；Rust 另外验证执行/授权消息不被观察队列溢出阻塞、窗口确认隔离及冷读 helper 的取消清理。

当前改造交付的是默认聊天的数据源与流式展示路径。聊天外观仍由 LoliCode 组件提供，完整官方 UI Chat、其插件依赖及完整 Web Host 组合仍待单独验证。

## 实施顺序与交付边界

### 已完成：控制器正式通道与默认聊天接入

早期独立预览用于验证真实服务和传输组合；该入口已经删除，验证过的通道已接入默认原生聊天。提交、取消和其他产品操作保留原来的桌面边界，显示侧直接消费官方记录及临时流。

持续要求是保留官方事件和投影契约、以原生日志作为唯一会话事实来源，不额外创建一种持久化 Harness 日志。任何读写都保持项目、根会话和子会话的归属限制，不开放未认证的本地端口；宿主内部对象、凭据与未声明 wire 视图的投影不得随意转交渲染层。

### 待评估：完整官方聊天插件组合

在隔离测试环境使用官方模块加载与插件环境，依次验证 UI Session、UI Conversation 和 UI Chat；保留其 SessionBinding、事件源、投影及 Slot/Factory 扩展机制。当前默认聊天复用官方事件和流处理库，不等于这些官方 UI 插件已经挂载。

先验证历史显示、流式回复与 turn 过程折叠，再验证权限请求、工具、附件和子会话。LoliCode 的文件打开、渠道状态与产品操作通过正式扩展面接入，不复制官方私有 store、组件或事件 reducer。

在 Tauri WebView 中检查样式作用域、React 运行时、快捷键和滚动所有权。模块注册或浏览器打包成功不算聊天验收通过。

交付：同一段会话在官方参照与 LoliCode 默认聊天的对照结果，以及必须保留的适配代码清单。

### 待决策：根据组合验证决定 Host 范围

若少量官方服务即可复用会话控制器与聊天插件，保留现有宿主组合，逐步删除重复的会话显示转换。

若需要不断仿写 Gateway、会话生命周期、重连和官方服务，优先评估引入官方 Web Host 的完整组合，让 Rust 通过少量明确接口提供产品能力。评估内容包括宿主启动与退出、模型网关和凭据归属、工具执行、冷历史迁移、渠道切换及打包更新。

不以“能渲染聊天”单独决定迁移，也不预设 Rust 或 Electron 的性能结论。记录启动耗时、内存和长会话交互基线后再比较。

### 持续收敛：剩余业务兼容与旧链路

默认原生聊天已接通，不再把“接入主聊天”列为未来交付。`AgentSnapshot` 仍服务桌面权限、问题、状态、队列、重试和旧历史兼容；应按这些消费者逐项判断能否继续减少转换，不要求一次重写整个工作台。

逐项迁移消费者后，删除对应的 `harness_snapshot.rs` 显示投影、前端推断分组与重复流式衔接逻辑。旧引擎迁移历史单独处理；没有完整原生日志时明确标识，不能从旧 DTO 伪造完整官方历史。

## 默认聊天的回归门槛与后续验收

- 同一日志位置的热读取、冷读取和重启后读取保留相同事件内容、turn/step、结束原因和投影状态；官方恢复补写的生命周期事件单独核对。
- 分页、重复通知、掉线和序号缺口不会丢消息或重复显示；临时 Assistant attempt 与最终持久化事件正确交接。
- 一个 turn 内多条 Assistant 消息、同一步重试、工具失败、取消、token 上限与进程中断均有正确呈现。
- fork 保留精确继承前缀；子会话、后台执行和不同项目之间的身份与权限正确。
- 历史加载和重连不会自动重发提示、重复执行工具或代答授权；附件和工具结果的原生引用保持可用。
- 渠道切换、关闭窗口、重启恢复与现有原生 Markdown 导出不退化；长会话滚动、分页耗时和内存有实测对照。

当前已覆盖默认聊天的原生历史、临时流与提交交接及主要操作回归，尚不能据此宣称上述全部端到端门槛和资源测量已经完成。后续重点是长会话实测、完整官方聊天插件组合、其生命周期与 Host 范围，而不是继续扩充旧聊天 DTO。

## 上游依据

- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/README.md)：Remote、历史、流式、重连、投影与访问控制。
- [Session Projection](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/session-projection/README.md)：投影注册、客户端 wire 视图与状态恢复；实际导出与类型以安装包为准。
- [UI Chat](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-chat/README.md) 与 [UI Session](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-session/README.md)：会话绑定与聊天渲染扩展面。
