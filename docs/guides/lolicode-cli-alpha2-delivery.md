# LoliCode CLI Alpha 2 首次使用修复

2026-11-20 发布 `0.1.0-alpha.2`，修复没有配置模型时打印错误并退出的问题。启动后会留在 `lolicode ›`；`/connect` 可在界面内引导连接模型，已有渠道可以复用。API Key 可隐藏输入供本次进程使用，不写入配置；长期使用仍可设置环境变量。配置与命令错误可以在会话中修正，原有单次任务和 JSON 退出码保持。

用户贴出的 `C:\Users\admin>` 是 Windows CMD 提示符；退出后的文字被 shell 当作系统命令解释。新版官网的 Windows 安装命令同时适用 CMD 与 PowerShell，安装后直接运行 `lolicode.cmd`，在 LoliCode 提示符中输入 `/connect`。

## 冻结与验证

- 源码提交 `60bd2c056b0e5352763a22de2af2c43d2687e506`，分支 `feat/lolicode-cli`。
- npm 包 `lolicode-cli-0.1.0-alpha.2.tgz`，115,736 字节；SHA256 `4b4f00dded2fbd041d29017bf3aa0f5b29196e305dd1fbc5e00216621a8a7bc6`。
- GitHub 预发行版本 `lolicode-cli-v0.1.0-alpha.2`，Release ID `452451065`；附件摘要与完整官网下载字节均一致。桌面版 latest 仍为 `lolicode-v1.1.4`。
- Windows x64 与 Linux x64 精确安装件各通过 12 项验收；Linux 以 UID 65534 运行。协议、读写工具、会话恢复、权限、取消、超时、标准输入和密钥脱敏均覆盖。
- Linux 真正 PTY 从无配置启动，经 `/connect` 隐藏输入模拟密钥后，运行权限拒绝/允许、结构化问题、无效渠道恢复与 Ctrl+C。密钥没有出现在终端记录或配置文件。
- Windows ConPTY 验证缺配置时的持续会话、`/help`、取消配置、完整引导及隐藏输入；模型连接后出现 `you ›`。模拟密钥没有回显或写入配置。

验证模型均为合成服务，驱动真实 Harness 与工具。临时输入的 Key 只在当前进程有效，退出后再次启动需重新输入或设置环境变量。

## 官网

入口 https://lolicode.com/cli/ ，生产目录 `/var/www/lolicode-site/releases/20261120-cli-alpha2-v1`；保留 Alpha 1 固定下载跳转。只更改已有 CLI 静态目录与新版本下载路由，旧版风格首页 SHA256 仍为 `a95cdb99d2f3582687816365318ca36d8c2208d93af1089d563e13c25ebc7bdf`。

测试站预览、精确字节、生产公共路由和完整包下载验证通过。测试配置已恢复，主配置未变。官网 snippet 当前 SHA256 `adad0e8d30c430507749da83e735490065a97f3973885453663eb380483ad552`；冻结恢复点 `/root/lolicode-20261120-cli-alpha2-v1/`，清单 SHA256 `020dccee62f320f3ce4e7ed2d3b6e55cdad29a0a7caefb4c203026151d72268a`。

部署工具与条件回退见 `deploy/lolicode-cli-alpha2/README.md`。本机回执在忽略目录 `release/cli-alpha2/`，主工作目录继续使用 `dev`。
