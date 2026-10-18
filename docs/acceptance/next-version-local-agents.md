# 国产 Agent 工具管理（待下次打包）

本次源码支持 WorkBuddy、DeepSeek Harness、ZCode、MiMo Code。保持版本 4.0.21，不发布安装包。

## 验收

- [ ] 模型与渠道 → 展开工具管理，四个工具出现在已有 CLI 列表上方。
- [ ] 显示已安装程序的位置与可获取的版本；仅存在模型配置文件时，不标为已安装。
- [ ] Windows 可检测卸载注册表中登记的自定义安装位置；macOS 检测 Applications，Linux 检测 PATH 和常用 bin 位置。
- [ ] 未自动识别时，选择已安装程序，立即保存；取消选择不修改记录；自动检测可移除手动路径。
- [ ] 手动路径保存在本机 `~/.tai-switch/local-agent-paths.json`，不随渠道同步到其他电脑。
- [ ] “打开位置”进入安装目录；“官网下载／更新”打开官方页面，由用户选择安装包。
- [ ] “配置模型”选中对应目标、定位到一键配置区；已有其他目标选择保留。确认目标清单、点击一键配置后才写入外部应用。
- [ ] 配置区繁忙或存在未完成编辑时，工具行的配置按钮禁用。
- [ ] ZCode 在工具管理、配置目标、消费筛选等共用图标的地方显示黑白 Z；断网也可显示。

## 来源与边界

- ZCode 图标来自官方站点 <https://zcode.z.ai/favicon-192x192.png?v=20260707-transparent>，2026-10-19 获取，保持原图，用于识别该产品。资源：`src/icons/extracted/zcode.png`。商标权归相应权利人。
- WorkBuddy 官方下载：<https://www.codebuddy.cn/work/>。
- DeepSeek Harness 官方源码／发布：<https://github.com/deepseek-ai/deepseek-harness>。
- MiMo Code 官方源码／安装文档：<https://github.com/XiaomiMiMo/MiMo-Code>。CLI 为 `mimo`，默认独立安装位置 `~/.mimocode/bin`；不把 Xiaomi MiMo 桌面客户端当作该 CLI。

检测不联网、不启动程序、不执行安装器；官网入口不替用户接受协议、卸载或升级。模型配置继续使用已有适配器和防覆盖机制。

## 本轮验证

- 相关前端测试 123 项通过，类型检查、前端生产构建通过。
- 本地工具探测单测 3 项、已有外部配置适配器回归 17 项通过。
- 只读实机检测：WorkBuddy 5.3.14（D 盘）、DeepSeek Harness 0.2.1-rc.2、ZCode 3.15.3 正确识别；MiMo Code 仅有配置，不误标为已安装。
- 使用真实管理组件和隔离示例数据在浏览器检查布局、路径显示及黑白 Z 图标；临时预览已清理。
- macOS／Linux 检测分支尚未在对应系统做实机验证。
