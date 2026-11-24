# LoliCode CLI Alpha 5

2026-11-24 发布。交互启动先绘制对话和 `you ›`，Harness 在首条消息提交时启动。未连接时输入的任务保留为草稿，连接后用 `/send` 发送。

`/connect` 提供已保存渠道、DeepSeek、OpenAI、Anthropic 和自定义 API。预设自带接口地址和协议。方向键、数字、Enter 与 Esc 可操作菜单。`/models` 在会话内选择模型并保留对话上下文。Key 可使用环境变量或临时隐藏输入，已保存渠道下次可直接补填 Key。

- 源码提交 `4960d3831a0de75846c3185aadb67641a8b6ac01`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.5`，Release ID `456388416`
- npm 包 121,078 字节，SHA256 `78f1215ffde21af51752954c3edef14ff7add63893e8d6f8326e75052b8c31ee`
- Windows 和 Linux x64 精确安装包各通过 13 项 Harness 回归，并通过 Windows ConPTY 和 Linux PTY 验收。模型请求使用本地模拟服务。

CLI 专页为 `/var/www/lolicode-site/releases/20261124-cli-alpha5-v1`。官网首页 SHA256 核对为 `c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25`，预览配置已恢复。私有恢复点 `/root/lolicode-20261124-cli-alpha5-v1/`，清单 SHA256 `bf7a14be6631b61b6c7a0d736ddc6f04fcdedd2b23b02d0f1fb7c5d8c6feb0a5`，生产 snippet SHA256 `6e142948ee10a2f3542606de728f44770373aadab8c7bb118554ae559cf38766`。
