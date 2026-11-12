# Harness 0.2.2-rc.2 开发版兼容验证

2026-11-12 将 Harness 升级至官方 `0.2.2-rc.2`，对应上游提交
[`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`](https://github.com/deepseek-ai/deepseek-harness/tree/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c)。
本轮用于 `dev` 开发验证，不发布安装包，不修改正式更新通道。正式 1.1.1 的冻结产物仍使用 rc.1。

## 宿主兼容

- 子任务委派改用公开的 `listDescendants` 和扁平 `startActivation` 参数。重复委派只接受直属、可续聊的已发布任务；损坏或无法确认的记录不能当作成功回执。
- rc.2 的 `prompt` 不再以调用者提供的父 ID 授权。宿主先检查当前总秘书的真实任务目录，再恢复冷子任务，阻止其他根会话继续不属于自己的任务。
- 子任务权限和报告工具在官方 `subagent/start` 发布所有权后配置。使用官方 `rootOf` 支持中间父任务不驻留时恢复孙任务，继续保留审批、Plan 限制和报告归属。
- 冷读加载官方 Team 服务的持久化投影，默认关闭 Team；不恢复 Agent，不生成模型请求，冷读和在线投影保持一致。
- 显式选择持久终端组件时使用官方 headless shell 后端，Windows 使用 PowerShell；未选择时不添加终端工具，也不加载上游 Web 终端控制器。

## 依赖文件去重

根依赖将 `zod` 固定为官方 rc.2 组件要求的 `4.6.6`，通过 npm 锁文件共用一份依赖，保留官方包内容。
相对未经去重的 rc.2 锁，Zod 副本从 68 份降为 1 份，其余依赖条目保持不变；直接依赖和 peer 依赖约束均满足。

Windows 源运行时实际 `node_modules` 文件数：已发布 1.1.1 对应的 rc.1 为 70,167，新 rc.2 为 38,402，减少 31,765 个，约 45%。
这减少后续安装要创建和扫描的文件数量；本轮没有重打安装包，也没有把文件数变化当作已实测的安装时间提升。

开发版覆盖更新需要同时清理已移除依赖留下的空目录，否则 Node ESM 仍可能在旧的嵌套目录停止查找，无法使用新的根依赖。
清理只作用于受管理的运行时 `node_modules`，只删除空目录，不跟随链接，不删除未知文件。

正式 NSIS 覆盖升级目前只覆盖本轮资源，旧版不再使用的嵌套依赖文件也可能残留。
因此 **rc.2 首次正式发包前，必须补齐旧 SDK 资源清理及 rc.1→rc.2 实际覆盖安装验收**；开发版空目录修复不能替代这项发布条件。
验收须确认旧私有 Zod 不再遮蔽根依赖、会话与配置保留，且重复安装、失败恢复及未知文件保护符合预期。

## 验证

- 去重后的官方 SDK 全套测试：46 项通过。
- 会话、总秘书、原生记录组件与 hooks：5 个文件、313 项通过；TypeScript 检查通过。
- 运行时缓存、载荷校验与替换恢复：11 项通过。
- 另外使用已发布 1.1.1 的 rc.1 运行时创建真实主会话和子任务，在 rc.2 下只读检查原日志、继续主会话与原子任务，并验证总秘书收到子任务结果。去重前后均通过。
- 真实根→子→孙任务重启用例验证只恢复根和孙时，父任务保持未激活；审批绑定孙任务，Plan 限制有效，其他根会话无法读取或操作该孙任务。

可重复运行：

```powershell
pnpm prepare:harness-runtime
node --test packages/lolicode-harness-runtime/tests/*.test.mjs
node --test scripts/tests/prepare-harness-runtime-cache.test.mjs
pnpm typecheck
pnpm exec vitest run tests/components/AgentSecretaryTasks.test.tsx tests/components/AgentPage.test.tsx tests/components/AgentNativeTranscript.test.tsx tests/hooks/useAgentNativeSession.test.tsx tests/hooks/useSecretaryActivity.test.tsx
```

开发版会核对编入程序的 SDK 版本，因此不能仅把 rc.2 资源复制给旧程序。
在绑定源码的 `dev` 工作区执行 `pnpm build:dev`，或退出开发版后重新点击「LoliCode 开发版」，进行一次开发增量构建。
此路径不生成 NSIS 安装器或发布签名包；沿用开发版独立数据目录。
