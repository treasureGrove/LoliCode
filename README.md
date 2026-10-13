# TAI Switch · 太极 AI 路由器

Windows 本地 AI 路由器。管理自己的供应商 Key、多模型、用量与免费额度，通过一个 OpenAI Chat Completions 兼容入口连接客户端。

## 使用

1. 启动 TAI Switch，在“模型渠道”添加供应商与自己的 Key，填写一个或多个模型 ID。
2. 在“价格与额度”逐模型选择按量计费、免费模型或免费额度抵扣；按控制台实际权益录入额度，可自定义。
3. 点击“测试连接”会对所选模型发起两次短请求，付费模型可能产生费用。
4. 在“客户端接入”复制地址、本地令牌和公共模型 ID，填写到 Cherry Studio 等兼容客户端。
5. 在侧栏直接打开提供商/免费模型站，或使用资源页的过滤与搜索。

默认地址 `http://127.0.0.1:4310/v1`。真实 Key 只存 Windows Credential Manager；费用按高精度 USD 单价估算，支持输入/输出/缓存读取/缓存写入。价格和 usage 未知时不记作零；账户余额需从控制台核对后录入，未实现通用余额自动查询。共享额度不要重复分配。日月账本本轮按 UTC+8 重置。

升级保留 FreeHub 的原应用标识、数据目录、数据库和系统凭据命名空间，已有配置无需重填。项目目录保留 `D:\projectGithub\FreeHub`。

## 开发与验证

需要 Node.js、Rust MSVC、Visual Studio C++ 构建工具和 WebView2。

```powershell
npm ci
npm run desktop:dev
npm run desktop:build
cargo test -p freehub-gateway
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
npm run test:ui
```

`test:ui` 需要先启动 `npm run dev` 并安装 Playwright Chromium；它使用合成 IPC，不能替代原生操作验收。`test:startup` 需要先构建带 custom-protocol 的 debug 桌面程序并保证 4310 端口空闲；仅停止测试自身创建的进程，使用隔离数据/凭据。

Windows 输出：`target/release/tai-switch.exe` 与 `target/release/bundle/nsis/TAI Switch_0.2.0_x64-setup.exe`。安装包尚未签名。

任务书：[TASKBOOK.md](TASKBOOK.md)。参考记录：[CC Switch](docs/reference-cc-switch.md)。验收：[v0.2.0](docs/tai-switch-acceptance.md)、[最初 M0](docs/m0-acceptance.md)。

自动故障切换、云端目录订阅、Responses/Messages 转换、自动修改客户端配置、账户余额同步、自动升级、Pro 授权与支付尚未实现。填写任意模型 ID 不代表已经适配其所有原生协议。Cherry Studio 和干净 Windows 安装仍需单独验收。
