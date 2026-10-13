# FreeHub M0 实现与验收记录

日期：2026-10-13。状态：首个真实渠道已打通；Cherry Studio 和干净 Windows 安装验收尚未完成，M0 不标记为全部完成。

## 已交付

- 独立项目 `D:\projectGithub\FreeHub`；独立 Git 仓库，分支 `TG/freehub-m0`。
- Windows Tauri 桌面界面：添加/编辑/删除渠道、测试连接、接入信息、调用元数据。
- Rust 本地网关：回环监听、本地令牌鉴权、模型列表、普通 Chat Completions 和 SSE。
- SQLite 配置与请求元数据；真实上游 Key 和本地令牌保存到 Windows Credential Manager。
- Windows x64 程序与 NSIS 安装包；安装包未配置发布签名。
- CC Switch 源码参考记录；独立实现，未复制源代码。

## 验证结果

| 验证 | 结果 | 范围 |
|---|---|---|
| Rust 网关测试 | 11 项通过 | 鉴权/Origin、模型映射、流式 UTF-8/工具片段、错误脱敏、不重放、取消、端口占用、退出、凭据持久化/轮换/删除 |
| Windows 凭据测试 | 通过 | 真实 Windows Credential Manager 写入、读取、删除测试条目 |
| 前端类型检查与构建 | 通过 | TypeScript 与 Vite 生产构建 |
| Rust 格式与 Clippy | 通过 | workspace / all targets，warnings 作为错误 |
| 桌面编译与打包 | 通过 | debug 与 release 可执行程序、Windows x64 NSIS 安装包 |
| Windows 程序启动 | 通过 | 编译后的程序启动本地网关；模型查询需要鉴权；第二实例退出 |
| React 界面流程 | 通过 | 合成 IPC 下的添加、免费确认、编辑不回填 Key、配置说明和删除；此测试不替代原生 IPC 验证 |
| 用户实际保存渠道 | 已观察到 | 用户在 FreeHub 窗口保存智谱配置，诊断工具读取到模型与系统凭据引用 |
| 真实智谱普通调用 | 通过 | 使用已保存凭据，经实际桌面网关调用 `glm-4.7-flash` |
| 真实智谱流式调用 | 通过 | 经实际桌面网关收到 SSE，正常 `[DONE]`；两次调用合计约 26 秒 |
| 实际 Key 持久化检查 | 通过 | 检查应用目录中的 SQLite 主文件、WAL、SHM 共 3 个文件，没有上游 Key 明文 |
| 第三方客户端验收 | 待完成 | Cherry Studio 的实际版本、流式多轮使用和操作记录 |
| 干净 Windows 安装/卸载 | 待完成 | 当前只在开发电脑验证构建与启动，未声明干净环境通过 |

真实调用由用户明确授权；Key 未出现在命令参数、工具输出或本记录中。调用只发送简短测试文本，结果只保存元数据。

## 验证工具

- `cargo test -p freehub-gateway`
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run build`
- `npm run desktop:build`
- `npm run test:startup`（应用退出、端口空闲时运行）
- `npm run test:ui`（需先运行 Vite 开发服务，使用合成数据）
- `cargo run -p freehub-gateway --bin freehub-doctor -- <FreeHub数据目录>`（真实模型列表、普通与流式链路；需要用户授权调用）
- 上述诊断工具增加 `--privacy-only` 参数时，只检查应用数据库文件是否包含上游 Key 明文，不发起推理请求。

## 剩余验收与实现边界

1. 在 Cherry Studio 手动配置本地地址、聚合令牌及模型，完成实际多轮流式对话。
2. 在干净 Windows 环境验证安装、启动、卸载和凭据清理；安装包签名属于公测工作。
3. M1 的自动切换、目录订阅和注册指引尚未完成；跨协议、其他系统、授权和支付按任务书后续阶段实现。

带远程调试参数的桌面诊断命令被自动审批拒绝，返回原因是 `blocked by policy`。后续验证使用普通程序启动、Rust 测试、真实本地网关调用和合成 IPC 的界面检查；未将受阻的桌面调试验收标为通过。
