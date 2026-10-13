# TAI Switch v0.2.0 验收记录

日期：2026-10-13。正式名称 TAI Switch · 太极 AI 路由器。用户授权在 FreeHub 基础上加入全部用户选定模型、Astra UI、网站导航与本地用量计费。

## 本轮交付

- Astra 实现六页太极风格工作台，含可点击的侧栏官网/免费模型入口、过滤搜索、多模型勾选与逐模型价格额度表单。
- 本地网关允许用户启用免费和付费模型，公共 ID 映射到同渠道内不同上游模型；测试可选择任意已保存模型。
- Decimal 四项 Token 计价、实际 usage 读取、SSE 累计用量、免费模式与三种额度抵扣、原子额度账本和历史价格快照。
- 保留旧应用标识、数据目录和 Windows 凭据命名空间，升级前备份现有数据库；旧免费模型策略迁移，新加模型默认价格未知的按量计费。
- Windows x64 可执行程序与 NSIS 安装包；产品版本 0.2.0。发布签名尚未配置。
- 服务器 TASKBOOK 更新为 v0.3；旧 v0.2 文件在本地 docs 和服务器备份目录保留。

## 已通过

- 21 项 Rust 测试：鉴权与 Origin、正常/SSE/工具/UTF-8、错误控制、不重放、取消/退出、凭据、付费第二模型路由、发现不启用模型、缓存计价、精确小数、三类额度边界、未知用量、并发消费、重启持久化、历史快照、旧库迁移和新模型不继承免费策略。
- Windows Credential Manager 的真实系统凭据往返测试；仅使用测试条目并清理。
- 全 workspace / all targets Clippy，warnings 作为错误；Rust 格式检查。
- TypeScript 类型检查与 Vite 生产构建。
- React 合成 IPC 8 个交互流程：付费可配置、编辑不回填 Key、候选手动选择、选定第二模型测试、价格额度保存、客户端复制、未知数据显示、侧栏与过滤导航、浏览器预览禁输 Key；860/1120/1280 宽无页面溢出。
- debug 桌面程序独立数据/凭据下启动真实本地网关：版本 0.2.0、模型查询鉴权、第二实例退出。
- 新版 release 真实用户数据下启动本地网关，已保存模型出现在已鉴权列表，原 Key 由系统凭据库读取，无需重填。
- 使用实际已保存 Key 扫描当前应用 DB / WAL / SHM 共 3 文件，无上游 Key 明文。

## 真实智谱与边界

最初 FreeHub M0 的真实 `glm-4.7-flash` 普通/SSE 调用已通过，见 `m0-acceptance.md`。

本轮通过新版本地网关发起已授权的真实免费模型测试，提供商返回 HTTP 429（upstream_rate_limit）；未暴露原始错误或 Key，未切换到付费模型，也未把新版真实普通/SSE 验收标为通过。需要账户额度/限流恢复后再测。429 不能单凭此类别区分日额度和短期速率限制。

UI 自动化使用合成 IPC，不能证明新版每个原生 UI 操作均已手动验收。真实 Key 读取、网关鉴权与上游请求链路使用实际桌面程序，不是模拟；完整原生操作/Cherry Studio 多轮使用和干净 Windows 安装卸载仍待单独验收。

额度为本地记录：按实际账户剩余额度录入，可自定义；不自动读取全部供应商余额或其他客户端消耗。每渠道模型独立，共享额度不可重复分配。日/月按 UTC+8；跨 Token 免费边界按比例估算。费用统一 USD，以供应商账单为准。

## 可复核产物

- `target/release/tai-switch.exe`
- `target/release/bundle/nsis/TAI Switch_0.2.0_x64-setup.exe`
- `artifacts/ui-acceptance/results.json` 和界面截图（合成数据，不提交仓库）
- `artifacts/tai-switch-startup-acceptance/results.json`（隔离数据，不提交仓库）
- 数据备份：`C:\Users\admin\.codex\artifacts\tai-switch-data-backup-20261013-172123`
- 服务器旧任务书：`/www/backups/free-gateway/taskbook/TASKBOOK.v0.2.20261013-172349.9cc3536e.md`
- 新任务书 SHA256：`38c18fe2443b7b34b5f3a91bd4395ca4aedd3ada484306a7edfd1585787b9e5e`

诊断程序保留内部名称 `freehub-doctor` 兼容已有工具；只自动测试显式免费计费模型。`--privacy-only` 不发起推理请求。
