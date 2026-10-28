# 本机 Agent 用量

用量页统一显示 LoliCode 路由请求与本机客户端的逐请求明细。GitHub Copilot 官方账单保留独立面板，不与本地估算金额相加。

## LoliCode 会话费用与筛选

内置 Agent 的主请求、标题生成和上下文压缩使用同一会话标识进入现有网关账本，每个模型请求只记一次。工作台底部显示本会话的已定价估算；辅助调用计入费用，Token 与轮数仍保持主任务的回报口径。价格缺失、用量未回报和缓存计价不完整会单独提示，不能把它们理解为免费。

旧记录没有可靠会话身份时，费用继续保留在总用量中，不按时间或 Token 数猜测分配给某个会话。缺少已关联请求时，工作台显示“费用待关联”。

用量页的 **Agent 来源** 和 **渠道** 可分别选择、组合或清除，概览、渠道明细与热力图使用相同筛选。同名独立渠道按 ID 和来源区分；由同一共享渠道产生的不同 Agent 请求可以一起查看。小于 `$0.0001` 的已知正费用显示为 `<$0.0001`。

## 支持的数据源

- **WorkBuddy**：`~/.workbuddy/projects/**/*.jsonl` 与新版 `~/.workbuddy-ai/projects/**/*.jsonl` 的 `providerData.usage`。按会话和 `providerData.messageId` 去重；工具调用与文字块共享同一模型响应时不会重复入账。`session_usage.used/size` 是上下文指标，不当作历史消费。
- **DeepSeek Harness**：`~/.dsh/sessions/**/session*.jsonl[.zstd]`。每目录以最高 `session.vN` 代际为准，只统计 `assistant/message`、`assistant/attempt` 与 `compaction/summary` 的直接终态 usage，用 `request/context` 识别模型；流式 chunk、保留的 shadow stream 和冻结旧代际不重复统计。按官方 `session/end-seed{inherited:true}` 的最后一个边界排除 fork 继承前缀，普通 resume 标记不丢弃已有消费，新子会话调用正常入账。
- **ZCode**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage`。只读终态请求的计量列；不叠加 `turn_usage` 聚合，也不额外重复加 reasoning token。
- **MiMo**：`~/.local/share/mimocode/mimocode.db` 或 Windows `%LOCALAPPDATA%/mimocode/mimocode.db` 的 assistant message。依次支持绝对路径的 `MIMOCODE_DB`、`MIMOCODE_HOME/data/mimocode.db`、`XDG_DATA_HOME/mimocode/mimocode.db` 覆盖。独立于 MiniMax Code；沿用 MiMo 的输入、缓存、输出与 reasoning 分项，应用自报 cost 明确作为估算。
- Claude Code、Codex、Gemini、OpenCode、Grok Build、Pi、MiniMax Code 的现有导入继续保留。

旧版默认路径已在本机实际只读验收，重定位路径通过隔离夹具验证。DSH 支持绝对路径 `DSH_HOME/sessions`。其他版本/自定义路径/云端使用情况没有可读日志时，不声称已记录；来源面板显示检测状态，格式或权限读取失败时保留历史并提示重试。

## 口径与缺失值

导入统一转为 fresh input + output + cache read/write，避免缓存重复计数。模型真实 token 缺失时不按文本长度估填。价格未知或计价需要的缓存分项缺失时标为“待定价”，不是免费；之后同步模型定价也不能把缺失缓存计数猜成零。

模型回传、应用自报估算和本地单价估算都不是官方扣费。实际结算以服务商账单为准。MiMo 自报估算只保留总额，不伪造无法拆分的成本明细。

本机会话中缺少缓存计数会在来源状态中明确标记，不能把未回报当作零命中。LoliCode 主 Agent 的 footer 仅统计收到完整输入/输出回报的请求；新请求等待回报或中断时保留已有累计，缓存命中率只使用成对的缓存读/输入分母数据。

## 同步与去重

后台与手动同步共用同步锁。终态记录等待约 60 秒再导入，为同一请求的路由日志留出落库时间；尚未达到沉降时间的文件不前移游标。数据库同时观察主文件与 WAL 的修改时间。

请求身份进入独立的持久化去重账本，明细汇总删除或源文件复制、改写后也不会重导。专属客户端路由与本地日志按模型/发布的请求模型、规范化 token、请求开始/结束时间匹配，并逐条认领路由请求，避免把两笔数值相同的真实请求压成一笔。只识别我们配置生成的 `lolicode/` provider 前缀，不按最后一个斜杠截断合法 `vendor/model`。

读取限制为每个解压后文件 128 MiB、每行 16 MiB；不跟随扫描目录里的符号链接。超限或格式错误只提示读取失败，不清空旧记录。仅保存计量数据与必要的模型、请求/会话身份，不保存对话、工具参数或凭据。

## 验证

```powershell
cargo test --manifest-path src-tauri/Cargo.toml session_usage_desktop --lib
cargo test --manifest-path crates/lolicode-agent/Cargo.toml native::usage
pnpm exec vitest run tests/components/AgentUsageFooter.test.tsx tests/components/SimpleUsagePage.test.tsx tests/components/usageProviderLabel.test.ts
```

显式只读本机验收（只向新的内存测试库写入；只输出汇总计数）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml local_desktop_sources_acceptance_read_only --lib -- --ignored --nocapture
```
