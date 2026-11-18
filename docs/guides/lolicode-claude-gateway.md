# 通过 LoliCode Gateway 使用 Claude Code

在「渠道与模型」页面添加渠道、保存密钥并启用支持工具调用的模型，选好默认模型后，找到 **Gateway 路由服务**。

1. 点击「1. 启动路由服务」，等待服务显示运行中。
2. 点击「2. 进入 Claude Code」。LoliCode 将模型目录写入 Claude Code 配置，保存切换前的原生配置，并打开 Claude Code 终端。用 `/status` 确认 Anthropic Base URL 指向本机，用 `/model` 选择渠道中的模型。
3. 使用期间保持 LoliCode 在后台运行。切换回原来的连接时，在下方「Codex / Claude 连接方式」中选择 Claude Code 的「原生配置」。

连接时只修改 Claude Code；现有插件、MCP 和其他设置由原有配置写入器保留。不要把复制得到的配置覆盖到整个 settings.json 上，手动配置时应合并对应字段。

## 服务与手动配置

「启动路由服务」只启动本机服务并发布已保存的模型目录，不改动外部工具配置；服务运行后，此按钮变为「更新路由目录」。页面显示实际 Base URL、默认模型、可用模型数和共享服务的请求计数。「进入 Claude Code」需要本机已经安装 Claude Code；可以在本地工具管理中安装、升级和诊断。

「检查连接」向本机模型目录发送带鉴权的请求，验证地址、密钥和目录可用性，不调用上游模型。它不能证明上游余额、套餐或模型推理正常，需要在 Claude Code 中发送消息验证。

「复制接入配置」按需复制 Claude Code 的配置 JSON，包含 `env` 和模型菜单。`ANTHROPIC_AUTH_TOKEN` 是本机网关密钥；上游密钥保留在 LoliCode 后端。手动配置目标是 `~/.claude/settings.json`，Windows 上为 `%USERPROFILE%\.claude\settings.json`。

配置地址类似 `http://127.0.0.1:15721/tai/catalogs/<版本>/clients/claude`，以页面显示的实际值为准；开发版默认端口不同。不要在 Anthropic Base URL 后面手动添加 `/v1/messages`。

## 支持范围

Gateway 复用现有 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 和 Gemini 原生协议适配器，负责请求、JSON/SSE 响应与工具调用转换。具体模型能力、上下文和输出上限以渠道声明为准。模型必须支持工具调用才能用于 Claude Code 的文件、终端等操作。

Claude / Gemini 的官方原生订阅入口继续由对应工具直接登录使用；LoliCode 公益模型仅供内置客户端使用，不会发布到 Claude Code 的 Gateway 模型菜单。支持的其他登录渠道仍需在 LoliCode 中保持有效授权。

模型目录按版本固定。修改渠道后，先点击「更新路由目录」，再点击「进入 Claude Code」应用新模型，或者复制新版配置手动合并并重开会话。已有会话使用的旧目录仍然可用。应用重启会恢复需要后台运行的 Gateway；完全退出 LoliCode 会使本机网关停止。

当前不提供可选的 `count_tokens` 端点；Claude Code 会使用字符估算上下文用量，具体规则见[官方网关兼容说明](https://code.claude.com/docs/en/llm-gateway-protocol)。

Gateway 只接受来自本机 TCP 环回连接且携带有效本机密钥的请求，不提供局域网或公网服务。

Claude Code 环境变量和配置文件规则参见 [Claude Code 官方网关接入文档](https://code.claude.com/docs/en/llm-gateway-connect)。
