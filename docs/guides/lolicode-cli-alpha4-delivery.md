# LoliCode CLI Alpha 4

2026-11-24 发布。缺少 API Key 时，`auth login` 可在隐藏提示中输入临时密钥并直接进入会话。临时密钥只在本次进程供所选渠道使用。终端丢弃同一输入块中超出当前问题的行。

- 源码提交 `fbb5c329de441de937f46f3aafac79fded84d665`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.4`，Release ID `456373853`
- npm 包 118,641 字节，SHA256 `1ad7abae86a9d7e0e85afd17318f7bee57a190f953f872fafaac80b22faa8a0d`
- Windows 和 Linux x64 安装包分别通过 13 项回归。Windows ConPTY 验证了两条连接流程、额外粘贴行、密钥隐藏、发送第一条消息和退出。Linux PTY 验证了补全、模型连接、工具权限、问答和 Ctrl+C。模型验收使用本地模拟服务。
- CLI 安装页使用 npm 的 `--prefer-online`，以刷新本地缓存中陈旧的依赖版本信息。

官网 CLI 目录为 `/var/www/lolicode-site/releases/20261124-cli-alpha4-v2`。发布前后官网首页 SHA256 均为 `c91a66143342a5db00161098f0a3d19393d31973344b2bbb0a5d94ececed1e25`，测试站配置已恢复。私有恢复点在 `/root/lolicode-20261124-cli-alpha4-v2/`，清单 SHA256 `0a0b46cd20592c77ecc154876f26f235f3efff3b39a363e345d2eaccb2da9534`，生产 snippet SHA256 `2cebd7588f9347d21ffb9ecfd1e6f3f1d2f0f7065d720cfdac606793a4fec423`。
