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

FreeHub 采用的设计思路：渠道管理界面与网关分开；管理功能通过本地 IPC；数据变更由 Rust/SQLite 实施；后续配置辅助需要备份和冲突检查。

FreeHub 的额外约束：真实 Key 保存在 Windows Credential Manager，网关只监听回环地址；M0 不修改 Claude Code/Codex/Cherry Studio 的现有配置。跨协议功能按任务书另行验收。

后续如复制或改编实质源代码，须保留相应版权与 MIT 许可文本，并记录具体文件与版本。
