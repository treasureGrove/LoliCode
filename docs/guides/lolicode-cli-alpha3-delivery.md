# LoliCode CLI Alpha 3

2026-11-20 发布。新增 `lolicode [项目]`、`mini`、`-c`、`-s`、`--dir`、`-m 渠道/模型`、`session list`、`auth login` 和 `auth list`。交互提示符的斜杠命令支持 Tab 补全。脚本可用 `run --format json` 读取 LoliCode JSONL 事件。原有 `resume`、`sessions` 和输出选项仍可使用。

- 源码提交 `5e4c9f2c4353716c740a8fdef6b59e2b82414e1f`，分支 `feat/lolicode-cli`
- GitHub 预发布 `lolicode-cli-v0.1.0-alpha.3`，Release ID `452470498`
- npm 包 117,894 字节，SHA256 `bcd9f6022a0c8840a2f2f2f316f1efc41f1f2a0d35c6bb9015a2448c36ba406c`
- Windows 和 Linux x64 安装件各 13 项通过。Linux PTY 测试了带空格的项目路径、补全、隐藏密钥与历史、权限、问答和取消。Windows ConPTY 测试了 `auth login` 配置和 `auth list`。

官网 CLI 页面在 `/var/www/lolicode-site/releases/20261120-cli-alpha3-v1`，首页在 `20261120-home-community-portal-v3`。生产 CLI 页面与官网下载包完成 SHA256 校验，测试站已恢复。发布脚本在私有恢复点 `/root/lolicode-20261120-cli-alpha3-v1/`，清单 SHA256 `9c32bb70e898f6daa29150f118d633a2b2088c880bed7742f8d9f59736e12696`，生产 snippet SHA256 `2b5b09041274e0477e95d13790ae991dc0695a38ccfab8816a42a74ad7c86354`。
