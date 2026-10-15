# LoliCode 编程工作台

4.0.15 起，编程 Agent 运行在 LoliCode 主程序内。模型请求、任务循环、权限、问答与会话存储使用 Rust 核心，不再依赖 Node、ZCode 或 OpenCode 引擎进程。只有终端、SSH 等外部工具执行才需要系统进程；当前 SSH / WSL 项目功能尚未迁入。

## 使用

1. 在“渠道与模型”添加 API 或支持聚合的订阅账号，保存模型。
2. 进入编程工作台，选择本机项目并新建会话。
3. 选择模型，使用“分析”检查和规划，或使用“实现”修改代码。
4. 通过逐次确认、Auto 或完整访问控制工具执行。分析模式不写文件；转入实现需要确认计划。危险操作不会因 Auto 自动放行。
5. 可以展开工具记录、查看累计改动，并停止正在运行的任务。已完成的文件操作与文字保留；重启不会自动重放工具。

渠道保存后自动同步模型目录，也可手动刷新；忙碌时延后同步。编程请求走应用内带认证的固定版本渠道网关。账户凭据不返回聊天界面，不写入本体会话文件。

项目内本地图片可在聊天预览、放大及关闭。支持 PNG、JPEG、GIF、WebP、BMP、AVIF 和安全 SVG；项目外文件及超过 10 MB 的图片会显示明确提示。

项目与本体会话支持切换、搜索、置顶、重命名、归档与删除。连续修改同一文件显示初始到最新内容的差异，恢复原文后不再显示改动。旧 OpenCode 会话只读查看；旧 ZCode 文件保留，历史读取尚未接入。继续工作请新建 `lc:` 本体会话。

## 技能和迁移范围

默认提供 ZCode 官方默认清单的 skill-creator、docx、pdf、pptx、xlsx 内容技能，固定来源及许可见 `../third-party/zcode/`。完整正文经校验后由 `read_skill` 按需读取，不会全部塞入每次请求。文档转换仍需要本机的 Python、Node.js、LibreOffice 等相应依赖；技能内容不会自动安装它们。

工作流、自动化、SSH / WSL 远程项目、JavaScript 插件及 MCP 执行尚未迁入 Rust 核心，相关面板明确显示不可用。导入或启用配置不代表扩展已经执行。“按需可用”和“已加载”分别表示通过校验可读取，以及本体实际读过正文。

整体界面样式保留，等待后续设计稿。技能弹窗提供 X、Esc 和底部返回入口。

## 更新和开发

通过“软件更新”检查、下载并校验 LoliCode 专用签名。安装版支持应用内安装；便携版从[工具站下载页](https://tools.treasuregrove.art/lolicode/)下载完整 ZIP，解压到新目录，保留自己的数据。便携包应保留同级 `portable.ini` 和 `agent/extensions/`，无需旧引擎目录。

开发准备使用 `pnpm install`、`pnpm prepare:agent-assets`。运行 `pnpm typecheck`、`pnpm test:unit`、`cargo test --manifest-path crates/lolicode-agent/Cargo.toml native::` 和 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 验证。实际主程序还可运行 `--check-agent-runtime`，在自建中文与空格临时项目内验证本体读写、工具续轮、默认技能及会话恢复，不读取用户配置、不调用付费 API。

详见[本体架构](guides/lolicode-inprocess-agent.md)、[4.0.15 说明](guides/lolicode-4.0.15.md)和[签名发布流程](guides/lolicode-release.md)。[4.0.14 及以前的架构和验证记录](guides/lolicode-agent-before-4.0.15.md)仅用于历史查阅，不代表当前本体支持相同能力。