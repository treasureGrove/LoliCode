# LoliCode CLI Alpha 6

2026-11-24 发布。默认进入全屏对话，消息输入框、模型和命令提示固定在底部。`/connect`、`/models` 与字段输入采用弹层。PgUp 和 PgDn 回看，Ctrl+P 打开命令建议，退出恢复原终端缓冲。经典 Windows 终端采用兼容字形。`mini` 和 `--plain` 提供逐行模式。

- 源码提交 `4f0956135569f589d6b380c2db8e2b0d923a96bb`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.6`，Release ID `456401011`
- npm 包 128,705 字节，SHA256 `378e71d03ebcfb0d0b6c55bbe7c74e66e73d3a7dda451a42df483a528ce09275`
- Windows 与 Linux x64 安装包各通过 13 项 Harness 回归。Windows ConPTY 验证弹层、密钥隐藏、中文流式回复、缩放、长对话翻页与退出。Linux PTY 验证全屏、中文、括号粘贴、密钥隐藏和退出。测试使用本地模拟模型。

CLI 专页目录 `/var/www/lolicode-site/releases/20261124-cli-alpha6-v1`。根首页已核对原 SHA256 `c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25`，测试站配置已恢复。私有恢复点在 `/root/lolicode-20261124-cli-alpha6-v1/`，清单 SHA256 `747a5f5880dac0c1fb84573b82930e929e3a680052230c52d2829231d2c6153d`，生产 snippet SHA256 `939ffb5739117cecccebbb51f706c34db21909d639cc9891e717e115db3655fc`。
