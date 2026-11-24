# LoliCode CLI Alpha 8

2026-11-24 发布。欢迎区沿用官网的樱桃酒红、奶油白与香槟金，新增原创像素小笨狗。对话采用平铺文字，底部集中显示模型和命令。模型弹层使用单层面板，打开时降低背景亮度。窄窗口与低色深终端使用精简布局。

- 源码提交 `9f0fa5be0d287ea8e43a44157ae3a2389b3ec3fb`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.8`，Release ID `456425129`
- npm 包 129,962 字节，SHA256 `1e8ff4582a0a9f96eea36ca51470e4c8e9ad20eb701365a6b67469232bb30c41`。官网下载通过校验。
- Windows 与 Linux x64 安装包各通过 13 项 Harness 回归。Windows ConPTY 验证了 52–160 列的缩放、中文流式回复、密钥隐藏、弹层和退出。Linux PTY 在 256 色及无颜色两种模式验证了中文粘贴、流式回复、密钥隐藏、模型切换和退出。测试使用本地模拟模型。

CLI 专页目录 `/var/www/lolicode-site/releases/20261124-cli-alpha8-v1`。根首页已核对原 SHA256 `c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25`，测试站配置已恢复。私有恢复点在 `/root/lolicode-20261124-cli-alpha8-v1/`，清单 SHA256 `7760ab4813b8b1f624f5fb6c3347af4c738240869c214e5f7326fb6fdc64b144`，生产 snippet SHA256 `3a7813e550baf266a794a97610b916451a993ab00d9ccf6366d85850f13fb4d1`。
