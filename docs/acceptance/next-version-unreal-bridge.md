# 下一版：UE 一键配置桥修复

日期：2026-10-19。仅修改与验证源码，未提高 LoliCode 版本号，未打包或发布桌面安装包。

## 对照源码发现的问题

本次核对固定提交 `ec65d7d1ae018944739d28cef18c78b4c53bca8f` 的 [UnrealAgentLink 模块](https://github.com/ueboxai/uebox/blob/ec65d7d1ae018944739d28cef18c78b4c53bca8f/plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/Core/UnrealAgentLink.cpp)、[工程信息实现](https://github.com/ueboxai/uebox/blob/ec65d7d1ae018944739d28cef18c78b4c53bca8f/plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/Commands/UAL_EditorCommands.cpp)、[上游安装流程](https://github.com/ueboxai/uebox/blob/ec65d7d1ae018944739d28cef18c78b4c53bca8f/src/main/utils/UnrealPathManager.ts) 及 [官方安装说明](https://uebox.ai/guide/plugin)。上游实际安装使用与引擎版本对应的编译产物；LoliCode 以前只解压源码就启用插件。

修复内容：

1. 插件 `project.info.payload.projectPath` 使用 `FPaths::ProjectDir()`，值是工程目录。以前拿它直接比较 `.uproject` 文件路径会拒绝有效连接。现先解析出本机唯一工程文件再比较，仍拒绝错误工程与歧义目录。
2. Windows `canonicalize` 产生的 `\\?\` 前缀与插件的普通路径不一致，也会让 .NET AutomationTool 的程序集 URI 解析失败。工程、引擎路径与前端连接状态都做相应归一化。
3. 配对 WebSocket URL 补上端口后的 `/`，避免带查询参数的请求形成无效握手路径。
4. `.uplugin` 存在、`Enabled=true` 不再代表就绪。增加 `pluginReady`，检查对应平台编辑器模块、二进制文件及当前引擎 BuildId。
5. 首次安装先在隔离目录编译，验证成功才安装并启用；旧的源码安装可从「修复并启用桥」补全模块。已兼容的模块直接复用，不重复编译。
6. 暂存与构建目录移到 `Intermediate/LoliCode/`，避免在 `Plugins/` 中出现多个同名插件。修复现有插件只更新派生模块，不覆盖源码或自定义文件；失败回滚，必要时保留恢复现场。
7. 界面显示准备状态、首次编译耗时提示和失败信息，期间阻止重复安装及移除。成功后明确提示从 LoliCode 本页启动编辑器完成配对。

## 前提与范围

当前从固定上游源码按本机引擎构建，首次需要 Windows C++ 编译工具链与 SDK；macOS 构建需要相应 Xcode 环境。这轮没有发布预编译插件下载服务。没有工具链时会报错并保留原工程，不会伪报“安装成功”。下载源码会使用本地缓存；已经匹配 BuildId 的插件不再编译。

上游默认连接 `17860`，LoliCode 使用带 token 的 `17861`。安装后直接双击工程不能代替本页的安全配对启动。目前断线后的配对恢复仍需要重新从本页启动；此项没有改成无认证自动接入。

## 验证

真实验证使用本机 Windows UE 5.8.3、独立空白工程、内存数据库及测试配置目录，不读取用户账户、Key 或桌面项目库。已完成：

- 固定源码通过真实 AutomationTool 构建（70 个构建动作），编辑器模块 BuildId 匹配。
- 插件写入隔离工程，MIT LICENSE 保留，`.uproject` 启用并创建原文件备份。
- 重复安装不改写模块、不触发重编译。
- 独立 `UnrealEditor-Cmd` 使用启动 token 接入 Rust 桥；工程目录上报通过校验。
- Rust 桥真实执行 `system.get_project_info`，返回 `project_name=LoliCodeBridgeAcceptance` 与 `ok=true`；测试完成关闭自己的编辑器进程。

证据摘要见 [UE 5.8.3 实测结果](evidence/ue58-bridge-2026-10-19.json)。自动测试另外覆盖源码安装/错误 BuildId 的就绪判定、修复时保留用户文件、启用失败回滚、WebSocket 握手与错误工程拒绝、Windows 路径，以及页面修复状态、失败重试和连接状态。

全量结果：Rust 本体 3,882 项通过、13 项默认忽略；独立 Agent 核心 112 项通过；前端 3,116 项通过。真实 UE 验收为显式单独运行的默认忽略用例，已额外通过。TypeScript 类型检查和 renderer 构建通过。

未将本次单平台、单引擎的结果扩大为全平台兼容或全部 UE 工具验收；写操作、其他引擎版本和真实桌面点击仍按后续清单验证。

## 人工检查

- [ ] 旧版仅装源码的工程显示「模块尚未为当前引擎编译，或版本不匹配」及「修复并启用桥」，不能提前进入“桥已启用”。
- [ ] 先保存并关闭该工程的 UE，点击安装/修复。可看到准备状态，不能重复点击。
- [ ] 编译成功后桥就绪，原工程自定义字段、其他插件和自有源码不变，备份存在。
- [ ] 缺少工具链或编译失败时有明确错误及本地日志位置，原工程配置不变。
- [ ] 从本页启动，已连接工程数增加；主 Agent 在相同工程中能够读取 UE 工程信息。
- [ ] 再次使用相同引擎和已兼容模块时无需重编译。
- [ ] 使用其他版本 UE、macOS 或 Linux 时单独验证，不套用本次 Windows 结果。
