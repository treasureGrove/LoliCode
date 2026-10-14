# TAI Switch 统一渠道中心

本功能建立在仓库所保留的 CC Switch 4.0.10 基线上。用户只需选择服务、填入 Key 或完成账号登录，再选择模型和工具并点击一键配置。

## 与原生功能的差别

- 原版以客户端为入口，各客户端分别管理供应商；现在以共享渠道为入口，一次添加后向选中的客户端生成配置。
- 原版统一供应商覆盖 Claude、Codex、Gemini，并以默认/角色模型为主；现在保存完整模型目录、来源、账号引用、能力声明、默认模型与目标工具。
- 原版聚合名单主要服务 Claude Code/Codex；现在原生多供应商工具直接接收各渠道目录，需要转换或集中认证的工具使用统一网关。
- 原版常见表单展示协议、SDK 包、配置代码等；现在预设服务自动带入地址，复用原有 Logo，自定义服务才输入地址。
- 主导航保留渠道、账号、工具、基础用量及普通设置。MCP、Skills、提示词、会话管理和复杂路由入口从主界面移除；原有数据、底层代码与内部兼容入口保留。

## 使用流程

1. 选择已内置的 API 服务并填写 Key，或使用 GitHub Copilot/智谱 ZCode 浏览器登录。没有预设的服务选择自定义渠道。
2. 自动获取目录，勾选模型并指定默认模型。同名模型按渠道区分。
3. 勾选目标工具。默认选择 OpenCode、Hermes、OpenClaw。
4. 一键配置，逐个显示成功、未配置或失败。需要刷新的工具会给出提示。

当前适配目标包括 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code。配置格式、安装路径和菜单能力仍由各工具决定。Gemini CLI 使用原生 Gemini 上游，其他协议不会被发布为可用的 Gemini 模型。

模型目录中的条目不代表已完成生成、权限或工具调用实测。只有明确的能力声明才作为已知信息；未知能力保留未验证标记。发现过程只读取目录，不发送付费生成请求。

## 配置与认证

API Key 渠道尽量使用客户端原生配置。Copilot 与智谱账号的临时推理凭据留在 TAI Switch 内，由网关在实际请求时解析或刷新；客户端只接收本地地址和稳定本地凭据。使用网关期间需要 TAI Switch 保持运行，重启后恢复已经应用的服务。

智谱登录依据官方 ZCode 公开 CLI OAuth 和 Project Access Token 协议。项目凭据按有效期刷新；网页登录本身过期后需要重新授权。官方服务拒绝授权、套餐访问或模型目录时会明确报告，不能把拒绝当作登录或配置成功。真实账号授权与服务侧版本准入需要用户使用自己的账号验证。

草稿与已应用目录隔离。每次发布使用不可变版本地址，未选中的工具继续访问先前目录，一个工具失败不会改变其他工具既有目录。保存与应用均检查修订号，拒绝用另一个窗口的新草稿替代本次点击的配置。客户端写入后若最终状态记录失败，会报告错误，并保留服务恢复标记，保障可能已写入的版本仍可访问。

各客户端只修改托管条目；保留无关字段、注释和原生账号配置，复用原有备份和冲突检测。没有选中模型时不会清空已有配置，而是报告未改动。

## 开发入口与验证

- `src/components/channels/`：简单配置界面、预设、浏览器登录与草稿保护。
- `src-tauri/src/services/channel_center.rs`：目录存储、迁移、模型发现、客户端投影与逐项结果。
- `src-tauri/src/proxy/channel_gateway.rs`：本机鉴权、版本目录、模型分流与流式协议适配。
- `src-tauri/src/services/zhipu_login.rs`：官方网页登录与项目凭据生命周期。
- `src-tauri/src/services/channel_grok.rs`：保留用户配置的 Grok 多模型事务写入。

验证使用内存数据库、临时配置目录、环回假上游和前端模拟接口；不调用用户真实 Key，不写真实客户端配置。`docs/images/channel-center/` 中的界面截图标明示例数据，证明界面布局和交互，不能作为真实渠道调用成功的证据。

本次最终前端全量 224 个文件 / 2,676 项测试通过，类型检查通过。Rust 库全量 3,644 项通过，10 项既有测试忽略。目录访问、工具调用与流式转换、版本隔离、错误脱敏、项目凭据并发刷新、取消登录、缓存 Token 计费和配置事务回滚均有离线覆盖。

自定义上游需要开放受支持的模型目录；无法读取时明确提示，不把预设模型列表当作该账号的权限。目录已列出但能力未声明的模型会显示“未验证”。

官方参考：

- [OpenCode 服务与账号](https://opencode.ai/docs/providers/)
- [Hermes 模型服务](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- [OpenClaw Copilot](https://docs.openclaw.ai/providers/github-copilot)
- [OpenRouter Responses 与工具调用](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- [ZCode 连接模型](https://zcode.z.ai/cn/docs/configuration)
- [ZCode 官方源码](https://github.com/zai-org/ZCode)
