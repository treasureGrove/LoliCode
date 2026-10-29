# LoliCode Windows 测试版 · 连续交互

> 历史说明：本文记录 4.0.10 隔离测试构建，不代表当前发行包的版本或文件名。产品显示名称统一为 LoliCode；旧数据目录和应用标识仅作为兼容性标识保留。

此版本基于完整 CC Switch 4.0.10 主分支快照（`479964f2`），保留供应商切换、路由、模型配置和计费逻辑。原项目的 MIT 许可证与 Jason Young 署名保留。

## 如何测试

1. 启动交付目录中的 Windows 测试程序，或安装对应的 4.0.10 x64 测试包。安装包使用独立目录。
2. 在供应商页面添加自己的渠道和 Key，选择要使用的模型并测试连接。此前 FreeHub 中保存的 Key 不自动迁移。
3. 试用添加、编辑、复制、切换供应商，以及路由模式和用量统计，记录异常页面与操作步骤即可；反馈时不要包含 Key。

本测试构建的默认数据、设备设置和备份位于 `%USERPROFILE%\.tai-switch`；历史兼容应用标识为 `art.treasuregrove.tai-switch`，可与 CC Switch 共存。原 CC Switch 的数据库和旧 FreeHub 数据不会被自动采用。切换客户端供应商仍会按 CC Switch 原逻辑修改该客户端的配置并备份，这是本版的核心功能。

本版默认路由端口沿用上游。若 CC Switch 正在运行路由服务，请在 LoliCode 设置里选择另一个端口后再启用 LoliCode 路由。

该历史测试构建暂时关闭自动更新，避免被上游安装包替换；不注册 `ccswitch://` 链接，保留上游应用的链接归属。当前 LoliCode 更新与链接配置以对应版本的发布说明为准。

本轮在太极主题上重组客户端切换、任务导航、供应商详情与操作，并统一导航、面板、分段、开关和菜单的运动规则。新增/编辑直接取消与返回也受草稿保护；用量和设置采用新的内容层级。外壳、设置及用量由 Astra 负责设计与实现，其余由主执行者与协作代理完成。

本轮调整界面、交互与前端状态保护，模型、路由、计费和数据格式继续沿用现有 CC Switch 基线。免费模型站导航与额外的免费额度扣减规则仍属后续功能。

4.0.10 测试交付物位于 `release/` 下的独立子目录；其他历史测试产物继续保留，不覆盖。新版继续使用兼容数据根目录下已有的配置。对照试用时请先退出旧版本，再启动新版本。

随包界面预览图使用隔离的示例数据，金额与供应商不是用户的真实记录。实际 EXE 使用正常本地数据，不包含预览模拟服务。

## 本轮范围

供应商工作台、外壳、用量和设置完成具体布局调整。MCP、Skills、会话、授权与客户端专属复杂编辑器保留原业务布局，接入共享组件与动效；不将这些页面称为逐页重做。逐项映射见 `docs/UI_REBUILD_COVERAGE.md`，运动规则见 `docs/UI_MOTION_DESIGN.md`。

## 构建

```powershell
$env:CARGO_BUILD_JOBS = '1'
pnpm install --frozen-lockfile
pnpm exec tauri build --bundles nsis --config src-tauri/tauri.test.conf.json
```

安装包位于 `src-tauri/target/release/bundle/nsis/`，直接运行程序位于 `src-tauri/target/release/`。Windows 需要 WebView2 Runtime；安装包沿用 Tauri 的运行时检测与安装流程。