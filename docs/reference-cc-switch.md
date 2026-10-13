# CC Switch 源码参考记录

参考仓库：https://github.com/farion1231/cc-switch
检查版本：`d9a62313c8a276216ed40245c638753606831e95`（2026-10-13）
许可证：MIT；本轮未复制其源文件或实现代码。

已阅读：

- `src-tauri/Cargo.toml`：Tauri/Rust/React/SQLite 与代理模块所用依赖。
- `src/components/providers/ProviderList.tsx`：渠道列表、编辑与测试操作的分层。
- `src/lib/api/providers.ts`：界面通过 Tauri invoke 访问 Rust 管理功能。
- `src-tauri/src/config.rs`：原子配置写入和持久化边界。
- `src-tauri/src/services/backup_storage.rs`：由后端限定备份目标，避免接收任意文件路径。

TAI Switch 采用的设计思路：渠道管理界面与网关分开；管理功能通过本地 IPC；数据变更由 Rust/SQLite 实施；后续配置辅助需要备份和冲突检查。

TAI Switch 的额外约束：真实 Key 保存在 Windows Credential Manager，网关只监听回环地址；M0 不修改 Claude Code/Codex/Cherry Studio 的现有配置。跨协议功能按任务书另行验收。

## 2026-10-13 用量与计费参考

另外阅读 `src-tauri/src/proxy/usage/calculator.rs`、usage parser、`response_processor.rs`、`src-tauri/src/database/dao/model_pricing.rs` 和 `src/types/usage.ts`。

- 金额使用 Decimal，按输入、输出、缓存读取、缓存写入四类 Token 各自乘每百万 Token 单价，再求和；金额接口使用字符串。
- OpenAI 兼容接口的输入用量包含缓存时，从新增输入中扣除缓存部分，避免重复计费。
- 流式计数取上游的累计 usage，不能逐个累计 chunk 中重复报告的同一用量。
- 参考版本 response_processor 的实际记录流程忽略旧 cost multiplier 覆盖；本项目不引入额外费用倍率。
- 本项目在此基础上独立实现免费模式、Token/美元/调用次数额度与原子抵扣账本。缺少 usage/单价保持未知，跨 Token 额度边界按 Token 比例估算。

本轮对齐核心用量与价格算法，不声称复制 CC Switch 的全部功能。Anthropic 原生协议和其缓存写入 1 小时倍率未在当前 Chat Completions 网关中实现。

后续如复制或改编实质源代码，须保留相应版权与 MIT 许可文本，并记录具体文件与版本。
