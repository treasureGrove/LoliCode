# LoliCode 主 Agent 记忆

主 Agent 在本机私有的 `agent/native/memory.json` 中保存简短、可检查的事实。用户偏好跨项目使用，上限 1375 Unicode 字符；项目约定仅注入当前已打开项目，上限 2200 字符。两类合计最多 3575 字符，不伪造为精确 tokenizer 计量。

模型通过 `memory` 工具读取、增加、局部修改、删除条目。容量不足直接报错并保留原文；不会静默截断或把整段聊天、工具输出、AGENTS.md 抄进记忆。写入前默认单次确认，沿用现有权限检查；用户明确选择完整权限时可直接执行。只读分析模式禁止写入。用户可以从 Agent 记忆面板编辑、删除、关闭及清除所有记忆。

每次模型请求读取一份稳定快照，同一存储未更改时前缀保持一致。与 Hermes 的整会话冻结不同，本实现会在下一次模型请求反映删除和关闭操作。记忆作为明确标记的 user-role JSON 事实数据注入，既不是 system instructions，也不覆盖当前用户指示；内容计入现有上下文预算。模型更新必须返回工具成功，文字承诺不代表保存。

存储采用串行、原子替换；UI 修改必须匹配 revision，模型修改必须匹配唯一旧原文，避免不同会话覆盖彼此。项目的规范化路径作为隔离键。文件、容量和格式不正确时保留原文件并报错。内置最佳努力的凭据与不可见字符检查，拒绝常见 API Key、Bearer、私钥、账号密码 URL 和口令字段；不应把任何秘密放入记忆。启用后记忆会随普通 Agent 模型请求发送给选定渠道，不调用额外第三方记忆服务。

## 上游参考与许可

- 官方仓库：https://github.com/NousResearch/hermes-agent
- 核验 revision：`848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c`（2026-10-17）
- 官方功能说明：https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- LICENSE：https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/LICENSE
- 许可：MIT，Copyright (c) 2025 Nous Research。

参考有界双存储、显式工具整理和快照注入思路，由 LoliCode 独立实现 Rust 存储、权限、上下文和 UI。未引入或打包 Hermes 程序，未复制其源码；目前也不声称兼容其外部记忆插件、向量检索或历史会话搜索。若以后直接复用上游代码，应随相应文件保留 MIT 版权与许可文本。

离线验收：`cargo test --manifest-path crates/lolicode-agent/Cargo.toml memory`，覆盖重启持久化、项目隔离、权限等待与通过、关闭后隐藏工具和注入、编辑容量与版本冲突、凭据拒绝。
