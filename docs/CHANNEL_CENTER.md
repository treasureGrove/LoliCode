# Lolicode 渠道与模型

本功能建立在仓库所保留的 CC Switch 4.0.10 基线上。用户只需选择服务、填入 Key 或完成账号登录，再选择模型和工具并点击一键配置。

## 与原生功能的差别

- 原版以客户端为入口，各客户端分别管理供应商；现在以共享渠道为入口，一次添加后向选中的客户端生成配置。
- 原版统一供应商覆盖 Claude、Codex、Gemini，并以默认/角色模型为主；现在保存完整模型目录、来源、账号引用、能力声明、默认模型与目标工具。
- 原版聚合名单主要服务 Claude Code/Codex；现在原生多供应商工具直接接收各渠道目录，需要转换或集中认证的工具使用统一网关。
- 原版常见表单展示协议、SDK 包、配置代码等；现在预设服务自动带入地址，复用原有 Logo，自定义服务才输入地址。
- 主导航保留渠道与模型、工具、基础用量及普通设置。账号登录属于渠道，账号维护在渠道页内打开弹窗。MCP、Skills、提示词、会话管理和复杂路由入口从主界面移除；原有数据、底层代码与内部兼容入口保留。

## 使用流程

1. 在“添加渠道”中选择 API 服务或带“账号登录”后缀的渠道。已内置的 API 服务只填写 Key，没有预设的服务选择自定义渠道并填写地址。
2. 账号渠道包括 GitHub Copilot、ZCode、OpenAI（ChatGPT 订阅）、xAI、Claude、Gemini。选中后在同一位置显示对应登录表单；已有账号也能直接加入或刷新模型。
3. 自动获取目录，勾选模型并指定默认模型。同名模型按渠道区分。Claude、Gemini 的原生订阅由工具管理模型选择。
4. 勾选目标工具。默认选择 OpenCode、Hermes、OpenClaw。
5. 一键配置，逐个显示成功、未配置或失败。需要刷新的工具会给出提示。Claude Code 与 Claude Desktop 分别配置并分别报告。

当前适配目标包括 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code。配置格式、安装路径和菜单能力仍由各工具决定。Gemini CLI 使用原生 Gemini 上游，其他协议不会被发布为可用的 Gemini 模型。

模型目录中的条目不代表已完成生成、权限或工具调用实测。只有明确的能力声明才作为已知信息；未知能力保留未验证标记。发现过程只读取目录，不发送付费生成请求。

## 配置与认证

API Key 渠道尽量使用客户端原生配置。Copilot、ChatGPT、xAI 与智谱账号的临时推理凭据留在 Lolicode 内，由网关在实际请求时解析或刷新；客户端只接收本地地址和稳定本地凭据。使用网关期间需要 Lolicode 保持运行，重启后恢复已经应用的服务。渠道绑定具体账号，账号失效或被删除时会报告问题，不自动改用另一个账号。

Claude、Gemini 订阅引用本机原生工具登录，只配置 Claude Code、Gemini CLI 各自的原生账号模式。它们的凭据不会被导出到聚合网关，也不会向 OpenCode、Hermes、OpenClaw 宣称可用。其他目标工具仍可接收所选 API 和支持聚合的账号渠道。Claude Desktop 的模型菜单能接收聚合目录，但默认模型选择依其实际菜单能力，结果中会提示重新打开客户端后选择。

智谱登录依据官方 ZCode 公开 CLI OAuth 和 Project Access Token 协议。项目凭据按有效期刷新；网页登录本身过期后需要重新授权。官方服务拒绝授权、套餐访问或模型目录时会明确报告，不能把拒绝当作登录或配置成功。真实账号授权与服务侧版本准入需要用户使用自己的账号验证。

草稿与已应用目录隔离。每次发布使用不可变版本地址，未选中的工具继续访问先前目录，一个工具失败不会改变其他工具既有目录。保存与应用均检查修订号，拒绝用另一个窗口的新草稿替代本次点击的配置。客户端写入后若最终状态记录失败，会报告错误，并保留服务恢复标记，保障可能已写入的版本仍可访问。

各客户端只修改托管条目；保留无关字段、注释和原生账号配置，复用原有备份和冲突检测。没有选中模型时不会清空已有配置，而是报告未改动。

## 开发入口与验证

- `src/features/channels/`：简单配置界面、预设、浏览器登录与草稿保护。
- `src-tauri/src/services/channel_center.rs`：目录存储、迁移、模型发现、客户端投影与逐项结果。
- `src-tauri/src/proxy/channel_gateway.rs`：本机鉴权、版本目录、模型分流与流式协议适配。
- `src-tauri/src/services/zhipu_login.rs`：官方网页登录与项目凭据生命周期。
- `src-tauri/src/services/channel_grok.rs`：保留用户配置的 Grok 多模型事务写入。

验证使用内存数据库、临时配置目录、环回假上游和前端模拟接口；不调用用户真实 Key，不写真实客户端配置。`docs/images/lolicode/` 中的界面截图标明示例数据，证明界面布局和交互，不能作为真实渠道调用成功的证据。

目录访问、工具调用与流式转换、版本隔离、错误脱敏、项目凭据并发刷新、取消登录、缓存 Token 计费和配置事务回滚均有离线覆盖。新增订阅覆盖明确账号绑定、Responses 工具与非流式回复、取消授权时的迟到响应，以及原生订阅向各工具的实际配置范围。最终测试数量和交付文件校验值记录在安装包随附的构建清单中。

本版类型检查通过，前端全量 224 个文件 / 2,696 项测试通过；Rust 库全量 3,660 项通过，10 项既有测试忽略。

## 界面资源

产品名称为 Lolicode。临时图标、装饰资源及替换说明在 `src/assets/brand/`，浅紫与深色主题在 `src/styles/lolicode.css`。桌面应用图标由同目录的 SVG 生成。现有数据路径、内部应用标识和客户端托管条目保持兼容，已有配置继续使用。

自定义上游需要开放受支持的模型目录；无法读取时明确提示，不把预设模型列表当作该账号的权限。目录已列出但能力未声明的模型会显示“未验证”。

官方参考：

- [OpenCode 服务与账号](https://opencode.ai/docs/providers/)
- [Hermes 模型服务](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- [OpenClaw Copilot](https://docs.openclaw.ai/providers/github-copilot)
- [OpenRouter Responses 与工具调用](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- [ZCode 连接模型](https://zcode.z.ai/cn/docs/configuration)
- [ZCode 官方源码](https://github.com/zai-org/ZCode)
- [Claude 模型配置](https://code.claude.com/docs/en/model-config)
- [Claude 订阅使用范围](https://code.claude.com/docs/en/legal-and-compliance)
- [Gemini CLI 账号与配置](https://geminicli.com/docs/reference/configuration/)
- [Gemini CLI 常见问题](https://geminicli.com/docs/resources/faq/)
