# DeepSeek Superagent 原生适配记录

参考仓库为 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`。上游明确将其定位为研究原型，公开代码与内部实现、设计文章不完全相同。本版在现有 Rust NativeEngine 中实现秘书协调机制，没有装入完整 DSH bundle，也没有将原版全部能力标为已接入。

## 保留的源码边界

- **协调者与工作者分工。** 对应上游 `prompts/orchestrator.md`、`prompts/worker.md` 和 `src/core/ports.ts`。秘书负责对话、路由和汇总；独立工作会话执行文件、终端和业务工具。工作会话不能递归分派，秘书的工具范围由引擎检查。
- **原请求与路由说明分开。** 上游 `prompts/dispatch.md` 保留原 Trigger 引用。原生模型派工由宿主附带本轮真实用户请求及来源编号，模型生成的工作说明不能替代原请求或扩大授权。桌面手工分派的输入本身是一次明确用户请求。
- **上下文不等于授权。** 对应上游 `src/core/model.ts` 的 Trigger、Mandate、TicketInput 及 `src/core/intake.ts`。工作状态报告只提供上下文；报告驱动的秘书轮次由引擎禁止发起新任务、恢复任务、取消任务或修改记忆。明确跟进才可继续工作。
- **停止与恢复分开。** 对应上游 `src/core/tickets.ts`、`src/core/assignments.ts`。取消发起原生停止，工具清理完成后才释放项目执行槽位；不会由自动报告恢复。应用关闭后保留任务与会话关系，未完成运行标为中断，不自动重放工具。孤儿工作会话补为可查看的中断记录。
- **持久投递与幂等。** 对应上游 `src/app/outbox.ts`、`src/app/delivery.ts`、`src/core/replies.ts`。任务报告和请求回执持久化，发送与跟进保留稳定编号；模型调用编号与本轮请求共同确定幂等键。队列恢复与新消息入队原子保存，失败不能解锁旧队列。
- **真实状态、按需交互。** 对应上游 `docs/000-philosophy.md` 和 `src/app/notices.ts`。工作结果、需要用户的权限及问答由真实执行状态决定。公开对话显示简短系统通知；模型完整报告留在私有历史。桌宠只读取精简状态，页面跳转由用户点击触发，不调用派工或批准权限。

原生实现位于 `crates/lolicode-agent/src/native/secretary.rs`。桌面命令位于 `src-tauri/src/commands/agent_secretary.rs`；秘书界面、桌宠状态与导航分别位于 `src/features/agent/AgentSecretaryTasks.tsx`、`src/hooks/useSecretaryActivity.ts`、`src/app/App.tsx`。

## 明确的适配差异

当前入口是桌面内用户请求。上游的 Source、Thread、Subscription、版本化 Policy、Mandate、Eval、Ticket 和 Assignment 是更完整的领域模型；本版的会话及任务记录没有实现它们的全部状态与关系。

模型派工中的原请求由宿主保存，不从模型改写后的历史里猜测；上下文压缩后仍可重新注入。仅自动转交同一已接受用户输入中已验证的图片。文档只转交名称、格式与大小等元数据，并明确正文未自动传递；不会把外部本机路径或文档 base64 编码当作已阅读的内容。需要文档正文时使用可访问的项目文件或在工作会话中明确提供附件。

同一项目的工作会话复用真实项目目录，按项目串行执行，以保留当前未提交文件的可见性。这与上游每工单准备独立目录的默认工作方式不同；本版没有宣称工作树隔离或同项目并行写入。

本版 `completed` 表示该工作轮次由原生执行回执确认完成，不等于上游显式 WorkerReport 的全部语义，也不表示 PR 已合并、外部需求已验收。上游 `progress / waiting / ready / blocked / failed / dropped` 报告和 PR 生命周期需分别适配。

`send_task_message` 表示明确用户跟进，可以恢复工作。上游独立的 context-only note、自动线程订阅及跨任务事实路由没有全部迁入，不能把一条普通事实说明当作恢复任务的授权。

GitHub／飞书事件监听、主动候选评估、来源账户策略、外部回传和云端常驻服务尚未接入。关闭桌面应用会停止执行。跨正式／开发版的手动会话同步跳过协调会话并说明原因，以免复制部分父子关系。

## 来源与验证

参考源码的原始 MIT 许可与版权声明留档于 `third-party/deepseek-superagent/`，发行声明见根目录 `THIRD_PARTY_NOTICES.md`。当前为原生适配实现；后续采用具体上游文件时应继续登记文件、提交与改动，不能将整套 DSH 的依赖许可概括为单一根许可。

回归覆盖原生任务分派、权限继承、项目串行、取消、原子跟进、报告授权限制、来源编号、重开不重放和桌宠只读状态。公开接口验收 `crates/lolicode-agent/tests/secretary_workflow.rs` 使用本机确定性模型传输，执行真实临时文件读写并核对自动汇总；不代表真实模型的路由质量或完整上游功能已验收。
