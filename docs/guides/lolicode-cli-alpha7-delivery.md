# LoliCode CLI Alpha 7

2026-11-24 发布。全屏终端统一采用可可底、奶油字和柔粉高亮，空白对话显示小笨狗字符画。消息区限制宽屏行长，输入区和弹层沿用同一套配色。窄终端自动收起角色，低色深终端采用兼容配色。

- 源码提交 `d037511c4e477c9445fd7ec71bd855a17f0d6d47`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.7`，Release ID `456416176`
- npm 包 129,547 字节，SHA256 `b3cfe09f5876b322956b8349ea3a8a3d7ab22775879156b08bf5e81d4b53b3e7`。官网下载的文件通过核对。
- Windows 与 Linux x64 安装包各通过 13 项 Harness 回归。Windows ConPTY 验证配色、弹层、缩放、中文流式回复、密钥隐藏和退出。Linux PTY 验证全屏、中文、括号粘贴、密钥隐藏和退出。测试使用本地模拟模型。

CLI 专页目录 `/var/www/lolicode-site/releases/20261124-cli-alpha7-v1`。根首页已核对原 SHA256 `c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25`，测试站配置已恢复。私有恢复点在 `/root/lolicode-20261124-cli-alpha7-v1/`，清单 SHA256 `92377c8ab3cbff6976bf9caf09246106b1069b5acb92bab1e4839056dcfcfcff`，生产 snippet SHA256 `d42e864e92391c9220300b572e1215a852bc8e3ad2d46ccaa858409b97905cd9`。
