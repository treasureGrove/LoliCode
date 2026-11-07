# macOS / Linux 原生构建验证（非正式发布）

此流程只验证指定提交在原生 runner 上能否完成检查、构建和打包。它不代表正式支持或上架，不写 GitHub Release、tag、官网、R2 或更新 feed。Windows 正式发布工作流保持原样。

## 触发方式

新增文件须先经维护者审核并推送；本地创建文件不会触发 CI。此次只授权推送 `fix/mail-ui-main-20261107` 分支后运行非发布验证，因此工作流的 push 分支白名单仅包含该完整分支名。它不响应其他分支、PR、tag 或定时事件，也不自动合入默认分支。父任务负责经批准的推送；添加此工作流本身不等于已推送或已通过。

同时保留 `workflow_dispatch`。该事件要求工作流已存在于默认分支，不能为了触发它擅自合入主线。以后符合条件时，在源仓库 Actions 中选择 **LoliCode native build checks (NOT A RELEASE)**，点 **Run workflow** 并选择待验证分支，或由维护者明确发起：

```sh
gh workflow run native-build-check.yml --repo treasureGrove/LoliCode --ref <reviewed-branch>
```

启动后核对 run 的 `head_sha` 与待验提交完全一致。首次新增工作流使用上述精确分支 push 触发，不声称默认分支尚无工作流时可直接手动运行。两个触发方式都只能构建验证包，没有正式发布入口。

`treasureGrove/LoliCode` 实际为公开仓库。用户已明确同意公开本次独立验证分支的源码改动，以及在该公开仓库中可见、保存 7 天的验证安装包、校验值和摘要。工作流仍严格限定精确仓库名，其他 fork 不执行；不改变仓库可见性。使用已有 GitHub Actions 标准 runner，不配置新服务或凭据。

上传路径使用显式白名单：验证 `.app.tar.gz` / `.deb`、`validation-report.json`、`SHA256SUMS` 和 `VALIDATION-ONLY.txt`，不上传整个 checkout、用户配置、密钥、诊断日志或源码归档。macOS 的 `.app.tar.gz` 是已构建应用包的归档，不是源码归档。公开验证 artifact 不等于 GitHub Release 或正式下载发布。

## 目标与依赖

| Runner           | 实际平台 / 架构             | Rust host / target         | 产物            |
| ---------------- | --------------------------- | -------------------------- | --------------- |
| `macos-15`       | macOS Apple Silicon / arm64 | `aarch64-apple-darwin`     | `.app.tar.gz`   |
| `macos-15-intel` | macOS Intel / x64           | `x86_64-apple-darwin`      | `.app.tar.gz`   |
| `ubuntu-22.04`   | Linux / x64                 | `x86_64-unknown-linux-gnu` | `.deb`（amd64） |

标签和架构依据 [GitHub 标准 runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 核对（2026-11-07），不依赖 `macos-latest` 的隐含架构。每次运行再次断言 Node platform/arch 和 `rustc -vV` host；不做交叉编译，不产 universal 包。

Node 版本来自 `.node-version`（本轮 24.19.0），Rust 来自 `rust-toolchain.toml`（本轮 1.95），pnpm 使用 packageManager 固定版本。每个 runner 各自执行 frozen-lockfile 安装、Harness 的独立 npm 安装和原生资源准备，绝不从 Windows 或其他架构复制 node_modules。当前 Harness 固定为 0.2.2-rc.1，捆绑 Node，不沿用旧版“默认不附 Node”的说明。

Linux 显式安装 WebKitGTK 4.1、GTK3、libsoup3、Ayatana AppIndicator、librsvg、libxdo、OpenSSL 和编译工具，不回退不兼容的 WebKitGTK 4.0。macOS 核查 runner 自带 Xcode/SDK/clang，不接受新许可或创建签名、公证凭据。依赖参考 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 验证内容

1. `product-release.json`、package、Cargo.toml/Cargo.lock 和 Tauri 的版本映射一致，Harness lock 与 package 一致。
2. TypeScript、构建验证脚本回归、agent assets 检查；Linux 额外运行一次完整 frontend format/unit checks。
3. 每个平台独立准备 Harness/Node，核对 runtime-manifest 的平台、架构、版本、Node 和 CLI SHA256、必需许可证。执行捆绑 Node 身份检查、Harness `--version` 及 node-pty 原生 `/bin/sh` smoke，不调用模型服务。
4. 每个平台运行 Rust fmt、Clippy（warnings 为错误）、nextest 全套后端测试，包含 macOS 菜单的库内契约测试。macOS 测试临时目录沿用现有 CI 的物理路径处理。
5. 使用独立 `.github/native-build-check.conf.json` 构建原生 app/deb。它设置 Validation 名称/应用标识、关闭 updater 产物和 feed；`--no-sign` 禁用打包签名。构建设置 development 通道，使用开发资料目录和凭据命名空间；不调用 Windows 发布脚本。保留正常 release 优化，测试调试符号和增量编译关闭以控制标准 runner 的资源开销。
6. 从真实 `.app` 或解出的 `.deb` 验证包版本、主程序 Mach-O/ELF 架构、所有映射资源的文件列表/字节/可执行权限与源码准备目录一致，包括扩展、Harness 全依赖与许可证。再次在包内路径执行 Node/Harness/PTY smoke。
7. 仅全部成功后上传上述公开验证 artifact，保留 7 天，附 `validation-report.json`、`SHA256SUMS`、`VALIDATION-ONLY.txt`。报告绑定源码 SHA、版本、平台和原生包摘要，并标记公开验证用途；输出目录必须恰好包含该目标包和这三个辅助文件。macOS 用 tar 保留权限。Tauri 的 Debian 资源目录是 `usr/lib/<productName>`，不同于 `usr/bin/<mainBinaryName>`。

原生产配置、Windows 发布工作流、正式 feed 和网站均不改变。工作流 `contents: read`，checkout 不保留 Git 凭据，无 secrets/environment/release write 权限。校验器拒绝接收签名或公证凭据。artifact 仅标“VALIDATION / 仅验证用，非正式版”，不得作为正式下载分发。

## 仍然必须验证的项目

- 此实现阶段只有 Windows 本地脚本/YAML/契约回归检查；没有运行 macOS/Linux runner，不能把新增工作流或朋友一次编译成功写成三个目标已经通过。
- 工作流跑绿后仍不代表真实桌面验收：要在各目标系统启动 WebView、操作聊天/工具/权限/文件选择、检查窗口关闭与重开、托盘与多窗口、字体和布局。
- macOS 特别检查四语言菜单即时保存与重启、⌘Z / ⇧⌘Z / ⌘X/C/V/A/W/Q、最小化/缩放/全屏、窗口列表和帮助搜索。原生系统菜单可能有系统语言控制的项目，须区分应用文本和系统文本。
- 用可丢弃的操作系统测试账号检查真实启动；不要在用户日常账号安装或启动这些验证包。Validation 使用开发资料目录，会与同一账号的其他开发构建共享该目录，并非全新独立的用户数据沙箱。
- macOS 15 构建不能证明配置中的 macOS 12 最低版本已可用；尚需最低系统兼容性、干净机器依赖、Intel/Apple Silicon 安装、Gatekeeper、正式签名、公证与升级验证。不要通过关停 Gatekeeper 来把失败当作通过。
- Linux 本轮只构建 Ubuntu 22.04 x64 的 deb；未验证其他发行版、AppImage、RPM、Wayland/X11 差异或 Linux arm64。macOS 不含 DMG/universal 分发验证。
- 当前正式签名 feed/发布器仍是 Windows 链路。未经真实平台验证及独立发布授权，不增加其他平台 feed 或正式资产。
- 任务因 runner 额度、磁盘、网络或平台依赖失败时保持失败，不跳过步骤、不借用其他平台依赖、不新增付费服务/凭据，也不把部分成功包装为完成。

## 本地验证这些检查本身

从已经按仓库要求安装依赖的 checkout 执行：

```sh
node --check scripts/tests/verify-native-build.mjs
node --check scripts/tests/native-build-check.test.mjs
node --test scripts/tests/native-build-check.test.mjs scripts/tests/prepare-agent-assets.test.mjs
pnpm exec prettier --check .github/workflows/native-build-check.yml .github/native-build-check.conf.json scripts/tests/verify-native-build.mjs scripts/tests/native-build-check.test.mjs docs/guides/native-build-check.md
```

回归包含 YAML 解析、精确授权分支 push 加手动触发/只读权限/无凭据边界、明确 runner 矩阵、版本错误、伪造或不匹配的架构、Node/CLI 字节篡改、缺失许可证和包资源丢失/多出检测。这些是校验器测试，合成 Mach-O/ELF 头仅用于测试错误检测能力，不是任何原生构建通过的证据。
