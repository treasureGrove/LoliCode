# 原生会话 Markdown 复制

会话列表的更多菜单提供“复制会话为 Markdown”。入口读取所选会话的完整原生已提交日志，包括尚未在聊天区加载的历史。运行中的会话可以复制；尚未提交的流式片段不会混入结果。

使用固定上游 `0.2.2-rc.1` / `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` 的公开 [`formatSessionMarkdown`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session-query/session-log-export)，保留原生标题、用户引用、工具折叠、压缩前的历史和可用的原日志路径。推理、系统提示、非用户来源的上下文及附件字节按上游规则省略。只复制选中的会话；子会话及附件 ZIP 归档仍是独立待接入能力。

活动会话通过宿主 RPC `lolicode/session/read-markdown` 读取 `sessionQuery.readSession`。宿主检查根会话和子会话归属。程序重启后的会话由一个仅挂载官方 JSONL 持久化服务的辅助进程读取 `readColdSessionLog`，不会恢复 Agent、启动渠道或发起模型请求。该进程不继承渠道凭据。官方 npm 包保持原样。

旧引擎迁移的历史可能只作为背景注入原生日志，不等于完整原记录。这类会话和没有原生日志的空会话会明确返回错误；不退回到当前界面中的部分消息并宣称完整导出。超过 8 MiB 的 Markdown 会明确拒绝，不截断。剪贴板操作在整个窗口内串行，切换会话不会改变首次点击选定的复制对象。

可重复检查：

- `pnpm exec vitest run tests/components/AgentSessionMenu.test.tsx`：正确会话、并发复制、切换菜单、读失败和剪贴板失败。
- `node --test packages/lolicode-harness-runtime/tests/*.test.mjs`：真实官方 SDK 的日志、归属、只读和重启路径。
- `node scripts/tests/harness-desktop-acceptance.mjs --session-export`：隔离 Windows 开发版菜单、原生读取及重启验收。需要与当前源码一致的开发可执行文件；不使用用户配置或用户剪贴板。

本适配不添加模型工具，也不改变原生 Goal、计划、派工、授权或会话存储格式。
