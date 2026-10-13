# TAI Switch Windows 测试版

此版本基于完整 CC Switch 4.0.10 主分支快照（`479964f2`），保留供应商切换、路由、模型配置和计费逻辑。原项目的 MIT 许可证与 Jason Young 署名保留。

## 如何测试

1. 双击交付目录中的 `tai-switch.exe`，或安装 `TAI Switch Test_4.0.10_x64-setup.exe`。安装包使用独立的 `TAI Switch Test` 目录。
2. 在供应商页面添加自己的渠道和 Key，选择要使用的模型并测试连接。此前 FreeHub 中保存的 Key 不自动迁移。
3. 试用添加、编辑、复制、切换供应商，以及路由模式和用量统计，记录异常页面与操作步骤即可；反馈时不要包含 Key。

TAI 自身的默认数据、设备设置和备份位于 `%USERPROFILE%\.tai-switch`；应用标识为 `art.treasuregrove.tai-switch`，可与 CC Switch 共存。原 CC Switch 的数据库和旧 FreeHub 数据不会被自动采用。切换客户端供应商仍会按 CC Switch 原逻辑修改该客户端的配置并备份，这是本版的核心功能。

本版默认路由端口沿用上游。若 CC Switch 正在运行路由服务，请在 TAI 设置里选择另一个端口后再启用 TAI 路由。

自动更新暂时关闭，避免测试版被原 CC Switch 安装包替换。暂不注册 `ccswitch://` 链接，保留原应用的链接归属。后续新增 TAI 更新源与专用链接。

本次交付先验证完整复制基线。新的 Astra 界面、免费模型导航和额外的免费额度扣减规则留待此基线验收后开发。

## 构建

```powershell
$env:CARGO_BUILD_JOBS = '1'
pnpm install --frozen-lockfile
pnpm exec tauri build --bundles nsis --config src-tauri/tauri.test.conf.json
```

安装包位于 `src-tauri/target/release/bundle/nsis/`，直接运行程序位于 `src-tauri/target/release/tai-switch.exe`。Windows 需要 WebView2 Runtime；安装包沿用 Tauri 的运行时检测与安装流程。
