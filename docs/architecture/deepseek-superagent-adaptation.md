# DeepSeek Superagent 原生适配记录

总秘书和工作会话由官方 DeepSeek Harness SDK 执行。任务报告与人工处理状态参考 DeepSeek 开源的研究原型，核对提交为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。[DeepSeek SuperAgent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)

## 保留的源码边界

- **协调者与工作者分工。** 秘书从用户目标决定分解方式和执行顺序，通过 Harness 原生子任务工具派工。工作会话使用上游的执行、权限和上下文接口。GitHub 来源与手工派工的授权记录由桌面端维护。
- **原请求与路由说明分开。** 父会话保留用户原始请求。独立工作会话接收秘书编写的工作说明，继续使用宿主绑定的项目和权限。桌面手工分派的输入本身是一次明确用户请求。
- **事实和执行授权分开。** 对应上游 `src/core/model.ts` 的 Trigger、Mandate、TicketInput 及 `src/core/intake.ts`。宿主保存工作状态报告，不把报告本身当成执行授权。不会唤醒任务的上下文便签仍待接入当前 Harness 路径，不能以普通子任务消息代替。发起新任务、恢复任务、取消任务或修改记忆仍需要明确用户请求。
- **停止与恢复分开。** 对应上游 `src/core/tickets.ts`、`src/core/assignments.ts`。取消发起原生停止，工具清理完成后才释放项目执行槽位；不会由自动报告恢复。应用关闭后保留任务与会话关系，未完成运行标为中断，不自动重放工具。孤儿工作会话补为可查看的中断记录。
- **持久投递与幂等。** 对应上游 `src/app/outbox.ts`、`src/app/delivery.ts`、`src/core/replies.ts`。任务报告和请求回执持久化，发送与跟进保留稳定编号；模型调用编号与本轮请求共同确定幂等键。队列恢复与新消息入队原子保存，失败不能解锁旧队列。
- **真实状态、按需交互。** 对应上游 `docs/000-philosophy.md` 和 `src/app/notices.ts`。工作结果、需要用户的权限及问答由真实执行状态决定。公开对话显示简短系统通知；模型完整报告留在私有历史。桌宠只读取精简状态，页面跳转由用户点击触发，不调用派工或批准权限。

宿主适配位于 `packages/lolicode-harness-runtime/host-operations.mjs`、`host-secretary-report.mjs` 和 `src-tauri/src/services/harness_secretary.rs`。桌面命令由 `src-tauri/src/commands/agent_dispatch.rs` 路由。秘书界面、桌宠状态与导航分别位于 `src/features/agent/AgentSecretaryTasks.tsx`、`src/hooks/useSecretaryActivity.ts`、`src/app/App.tsx`。

## 明确的适配差异

入口包括桌面内请求、明确交办的 GitHub 收件和可选的显式规则派工。GitHub 来源对应上游 `src/sources/github.ts`，按仓库与账户身份绑定，保存重叠读取游标和来源编号。规则派工参考 `src/policy.ts` 和 `src/core/intake.ts` 的准入与授权记录。这里用本地保存的精确触发词、条目类型与 GitHub 账户 ID 匹配新事件，记录规则版本和发起者，再用保存的任务要求启动 worker。首轮建立各来源基线，每轮最多派发两项。规则默认关闭，推断候选评估和完整线程订阅仍待适配。

本地 Git 项目可从当前提交创建独立工作树，原项目仍负责模型、权限与记忆的绑定。每项目提供三个独立工作树槽和一个当前目录槽。对应上游 `src/executor/dsh.ts` 的目录准备与 WorkerSlots，工作树是此处的本地适配。工作树模式的应用工具和 MCP 暂停，命令以任务目录为 cwd，权限继续由原生工具执行链检查。需要使用未提交文件的工作可选择当前目录。

工作会话通过 `report_task` 记录 `progress / waiting / ready / blocked / failed / dropped`。报告作为独立字段保存在任务记录里，执行结果仍由 Harness 回执决定。权限和问答优先显示，受阻或失败报告会提示人工处理。GitHub PR 状态由来源单独记录。

明确用户跟进通过 Harness 的子任务消息和宿主续跑接口投递，可以恢复工作。旧 Rust 实现中的 `send_task_note` 不是当前桌面 Harness 已注册的能力；上游 `src/core/tickets.ts` 拒绝向已结束任务投递便签，并将等待人工的开放任务继续挂起。仍开放的 ready 工作会话可按原型规则被唤醒。LoliCode 待接入的便签采用更严格的宿主约束，需验证只保存事实、保持任务状态、权限边界和重启幂等。自动线程订阅与持续的事实路由仍待接入。

GitHub 来源的自动收件是可选的桌面轮询。原线程回报和草稿 PR 都由用户审阅后发送。草稿发布借鉴 `src/sources/github-pull.ts` 的工单归属核验，将仓库、账号、任务分支和提交与 PR 关联，独立显示草稿、开放、关闭及已合并状态。回报和 PR 保存稳定的投递记录，重试前核对原线程或已发布分支及 PR，对应上游 `src/sources/github-channel.ts` 与 `src/app/outbox.ts`。飞书来源与云端常驻服务仍待接入。跨正式／开发版的手动会话同步跳过协调会话，以保留父子关系和任务目录边界。

## 来源与验证

参考源码的原始 MIT 许可与版权声明留档于 `third-party/deepseek-superagent/`，发行声明见根目录 `THIRD_PARTY_NOTICES.md`。当前为原生适配实现；后续采用具体上游文件时应继续登记文件、提交与改动，不能将整套 DSH 的依赖许可概括为单一根许可。

SDK 回归覆盖派工、权限、队列、跟进和重启。隔离 Windows 开发版验收使用本机确定性模型，检查总秘书派工、工作会话创建网页、报告交付就绪和右栏自动打开。`report_task` 的界面状态已覆盖。上游普通进度保留在任务记录，需处理的问答、结果及受阻等报告才定向送给父会话。当前仍需单独接入和验证定向报告的持久投递与重启幂等。

按上游提交归档的覆盖状态、待接线项和验收入口见 [Harness 上游能力清单](harness-upstream/README.md)。该清单保留未核对范围，不代表已经同步上游所有桌面和网页功能。
