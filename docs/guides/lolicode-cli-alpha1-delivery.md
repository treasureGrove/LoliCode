# LoliCode CLI 0.1.0-alpha.1 交付

2026-11-20 发布首个 CLI Alpha。官方入口为 [lolicode.com/cli/](https://lolicode.com/cli/)，首页导航已加入 CLI。下载与使用说明见 [公开发行页](https://github.com/treasureGrove/LoliCode-Releases/releases/tag/lolicode-cli-v0.1.0-alpha.1) 和 [CLI README](../../packages/lolicode-cli/README.md)。

## 已交付能力

- 独立的交互终端，带粉色小狗字符画、流式文字、工具步骤和可关闭的等待动效。
- 使用 DeepSeek Harness `0.2.2-rc.5`，从共享运行时复制宿主覆盖层，并校验依赖版本。
- 读取、修改项目文件与执行系统命令，review / workspace / plan / full 权限模式，以及按次确认。
- 会话持久化、历史列表与恢复，模型渠道配置、切换和运行诊断。
- 单次任务、标准输入、JSON / JSONL、超时取消和状态退出码。

运行需要 Node.js 24.9 或更新版本。API Key 从环境变量读取。CLI 默认数据目录为 `~/.lolicode/cli`，实际模型服务使用用户提供的地址、模型和凭据。

## 冻结产物

- 源码提交 `46ed58d85f55f9db3630033909604c60e6e8cd3b`。
- 包名 `@lolicode/cli`，版本 `0.1.0-alpha.1`。
- 安装包 `lolicode-cli-0.1.0-alpha.1.tgz`，114,070 字节。
- SHA-256 `39753a9069a240daa53a18e5781ffb7510d994ff14293a72aa4906def75bedca`。
- GitHub Release ID `452409258`，预发布标签 `lolicode-cli-v0.1.0-alpha.1`。
- 附件同时提供 `LoliCode-CLI-README.md` 和 `SHA256SUMS`。

包携带 `npm-shrinkwrap.json` 固定依赖树。GitHub 上传附件摘要、匿名完整下载、官网跳转后的完整下载均与本地产物一致。通过官网 URL 全新安装后，Windows npm 命令入口输出 `0.1.0-alpha.1`。

## 验收

Windows x64 与 Linux x64 分别在 Node.js 24.19.0 上通过 12 项安装件测试，全部执行且零跳过。覆盖配置、诊断、原生会话恢复、读写文件、系统命令、权限拒绝、密钥脱敏、超时、标准输入、结构化问题，以及 OpenAI Completions / Responses 和 Anthropic Messages 三种协议。

测试使用本机合成模型服务，驱动真实 Harness 和本地工具。Linux 测试以 UID 65534 运行，另通过真实 PTY 验证交互允许、拒绝、结构化回答、Ctrl+C 和正常退出。其他系统和架构尚待验收。

官网已验证桌面与 390px 手机布局、无横向溢出、安装标签切换、键盘切换、复制命令和浏览器错误日志。正式首页显示 CLI 链接和桌面版 1.1.4 下载信息。CLI 页面、样式、脚本、版本清单与产品地图的公开字节均通过 SHA-256 核验，社区、账户 API 和原站点地图返回 200。

本地回执位于 `release/cli-final/`，包括 Windows / Linux 安装件证明、Linux 终端记录、官网生产验证、完整下载和桌面 / 手机截图。

## 分支与官网发布

LoliCode 代码在 `feat/lolicode-cli` 分支及 `.worktrees/lolicode-cli` 工作目录开发，原工作目录继续使用 `dev`。官网仓库 `TAWEBTOOL` 的同名分支保存首页导航和产品地图入口，提交为 `34519a95925b036e0d04118d54e0d7c060394235`。

CLI 页面源码与部署工具位于 `deploy/lolicode-cli-site/`。生产静态目录为 `/var/www/lolicode-site/releases/20261120-cli-alpha1-v1`，私有恢复点为 `/root/lolicode-20261120-cli-alpha1-v1/`。

本批 manifest SHA-256 为 `d83b10a006246a4a378ae9d60ee0f12c74e52cfbd809ad14cba3c8b16692e011`。最终首页 snippet SHA-256 为 `fcc0fce021e14f33fe127e98d0d5d6161a9b30048fd379682acdf1ff066571e1`。

测试站已恢复原配置，SHA-256 为 `7b100ffa18ac9aeb7b6df73553e07f60b13991ad938fe2587162acb74766d321`。生产主配置 SHA-256 为 `53513f0be19f511936092f6b32e17efe84b840f3b6547a877d80b705a764fe6d`，维护开关关闭。条件回退方式见 [官网发布说明](../../deploy/lolicode-cli-site/README.md)。
