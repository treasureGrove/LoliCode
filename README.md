# FreeHub

Windows 本地模型渠道网关。桌面管理界面使用 Tauri 2、React 与 TypeScript；网关使用 Rust、axum 与 reqwest；配置存储在 SQLite，真实 API Key 存储在 Windows Credential Manager。

开发依据：[TASKBOOK.md](TASKBOOK.md)。当前实现 M0，真实智谱和 Cherry Studio 验收需用户在应用内填入自己的 Key。

## 使用

1. 启动 FreeHub，点击“连接智谱 BigModel”。
2. 核对账户中的免费模型，粘贴自己的 Key，确认免费条件并保存。
3. 点击“测试连接”。测试会发起两次简短请求，分别验证普通与流式调用。
4. 在“接入客户端”复制 API 地址、本地令牌和模型 ID，填写到 Cherry Studio 的 OpenAI 兼容供应商设置。

默认接口：`http://127.0.0.1:4310/v1`。上游 Key 不显示在第三方客户端配置中。只认证模型调用，管理功能通过受限的桌面 IPC。

## 开发

需要 Node.js、Rust MSVC、Visual Studio C++ 构建工具和 WebView2。Windows 脚本可使用用户 `.cargo/bin` 中的 Rust 工具，不修改系统 PATH。

```powershell
npm ci
npm run desktop:dev
npm run desktop:build
```

仅运行界面预览：`npm run dev`。浏览器预览不允许保存 Key 或调用模型，真实管理功能需要 Windows 桌面应用。

```powershell
cargo test -p freehub-gateway
cargo fmt --all --check
cargo clippy -p freehub-gateway --all-targets -- -D warnings
npm run build
npm run test:startup
npm run test:ui
```

依赖版本锁定在 `Cargo.lock` 和 `package-lock.json`。运行数据位于用户应用数据目录 `art.treasuregrove.freehub`，不会写入项目仓库。

## 已实现范围

- 渠道添加、编辑、删除与 Windows 系统凭据存取。
- 本地随机令牌、令牌轮换、凭据库保存与数据库摘要校验。
- 模型列表、Chat Completions 普通调用与 SSE；文本和工具事件透传。
- 首个有效 SSE 事件前验证上游，流式断流不自动重放。
- 受控错误分类、超时、取消、并发与响应体限制。
- 请求元数据记录，自动清理超过 30 天的记录。
- 单实例启动、端口冲突提示和网关退出取消。

多渠道自动切换、目录订阅、Responses/Messages 转换、配置接管、自动升级、授权和支付尚未实现。调用成功不自动证明模型免费；用户必须核对账户套餐。

源码参考：[CC Switch 检查记录](docs/reference-cc-switch.md)。本项目独立实现，未复制该项目源码。

界面测试使用合成 IPC 数据，不能代替真实桌面操作；启动测试使用隔离的数据目录与凭据命名空间。运行 `test:ui` 前先启动 `npm run dev`，并安装 Playwright 的 Chromium headless shell。启动测试需要先完成 debug 桌面构建，并保证生产应用已退出、4310 端口空闲。
