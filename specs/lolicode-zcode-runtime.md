# ZCode 3.15.1 行为接入

用户范围：现有编程功能及权限、项目会话、模型、技能插件，加上工作流、自动化、SSH/WSL 远程项目。现有界面样式和布局保持原样，后续按用户设计稿改版。

## 事实与所有者

- 基准为 `zai-org/ZCode` 的 `aac4755666d09fdcd70272fcf063c077a639015f`。复用其原生 CLI/runtime、V4 协议、Node services、工作流及远程连接；不把 OpenCode 的同名开关称作 ZCode 实现。
- Tauri 负责私有进程生命周期、已有渠道网关和 IPC。Node Host 负责原生服务与调度，CLI/runtime 负责会话、输入 admission、权限、事件日志与执行。Renderer 仅持未提交草稿和待对账请求。
- 新 ZCode 状态使用 LoliCode 独立目录。旧 OpenCode 引擎与数据库保留，按引擎标识路由旧会话，不覆盖或伪造历史迁移。
- `ask` 对应原生默认/build，`auto` 对应 `guarded`，`full_access` 对应 `yolo`；Plan 是独立状态。Guarded 的危险单次确认不得升级成项目永久授权。
- 自动化必须由真实持久服务及常驻调度 owner 执行，区分已接受、运行、终态和重启恢复。不能以 CRUD 或定时器触发本身冒充执行成功。
- 远程身份包含连接 ID 与工作目录；不按路径混用不同机器的会话。复用 SSH/WSL 的实际连接/部署流程，推理走受认证桥接，不向远端传上游 API Key 或 OAuth。

## 边界

私有 Host 仅绑定 loopback、使用随机 bearer 并限制消息大小；只有 Tauri 持有 Host 凭据。服务分派使用明确的公开 descriptor/method，不调用原型链和任意 JavaScript。跨进程事件保留真实顺序、请求身份和重连对账能力；EOF/退出时释放本轮子进程和租约。

默认不读取另一份 ZCode/OpenCode 安装的账号、配置或会话；不自动登录官方云服务，不新增付费推理。上游源码、Apache-2.0 许可及 NOTICE 与本项目 adapter 分开记录。

## 验收

真实原生运行时配合本机假模型验证创建/恢复、同 ID 幂等提交、排队、独立停止、模型与模式变更、Guarded 单次权限、Plan 拒写、默认技能/插件/MCP、工作流和持久自动化。远程连接用自有临时目录及测试连接，不操作生产项目；WSL 不可用时记录实际环境限制。前端回归不得改动样式/布局，并覆盖迟到 ACK 不清新草稿和不确定发送的对账/重试。
