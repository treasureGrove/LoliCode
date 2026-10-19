# 国产 Agent 工具管理（待下次打包）

本次源码支持 WorkBuddy、DeepSeek Harness、ZCode、MiMo Code、CodeBuddy、Qoder 的本地管理。CodeBuddy 使用一键配置，Qoder 使用官方模型向导指引。保持版本 4.0.21，不发布安装包。

## 验收

- [ ] 模型与渠道 → 展开工具管理，六个工具出现在已有 CLI 列表上方。
- [ ] 显示已安装程序的位置与可获取的版本；仅存在模型配置文件时，不标为已安装。
- [ ] Windows 可检测卸载注册表中登记的自定义安装位置；macOS 检测 Applications，Linux 检测 PATH 和常用 bin 位置。
- [ ] 未自动识别时，选择已安装程序，立即保存；取消选择不修改记录；自动检测可移除手动路径。
- [ ] 手动路径保存在本机 `~/.tai-switch/local-agent-paths.json`，不随渠道同步到其他电脑。
- [ ] “打开位置”进入安装目录；“官网下载／更新”打开官方页面，由用户选择安装包。
- [ ] “配置模型”选中对应目标、定位到一键配置区；已有其他目标选择保留。确认目标清单、点击一键配置后才写入外部应用。
- [ ] 配置区繁忙或存在未完成编辑时，工具行的配置按钮禁用。
- [ ] ZCode 在工具管理、配置目标、消费筛选等共用图标的地方显示黑白 Z；断网也可显示。
- [ ] CodeBuddy 独立写入 `~/.codebuddy/models.json`，不改 WorkBuddy 配置；保留已有模型和设置，并将新增模型加入已有的非空显示白名单。
- [ ] CodeBuddy 通过 LoliCode 路由发出的请求可以在用量页单独筛选，并按原渠道统计消费。
- [ ] Qoder 显示“模型设置指引”，不出现在一键配置复选框中；打开指引后可查看添加步骤和官方文档。
- [ ] Qoder 不凭通用 `settings.json` 就标记模型已配置；不伪造路由用量。其 API Key 仍由 Qoder 自己验证和保存。
- [ ] Qoder 优先读取已安装产品自身的版本号，避免把编辑器底座版本显示成产品版本。

## 来源与边界

- ZCode 图标来自官方站点 <https://zcode.z.ai/favicon-192x192.png?v=20260707-transparent>，2026-10-19 获取，保持原图，用于识别该产品。资源：`src/icons/extracted/zcode.png`。商标权归相应权利人。
- WorkBuddy 官方下载：<https://www.codebuddy.cn/work/>。
- DeepSeek Harness 官方源码／发布：<https://github.com/deepseek-ai/deepseek-harness>。
- MiMo Code 官方源码／安装文档：<https://github.com/XiaomiMiMo/MiMo-Code>。CLI 为 `mimo`，默认独立安装位置 `~/.mimocode/bin`；不把 Xiaomi MiMo 桌面客户端当作该 CLI。
- CodeBuddy 模型格式：<https://www.codebuddy.cn/docs/ide/Features/models>；官网下载：<https://www.codebuddy.cn/downloads/>。本轮适配桌面 IDE 的模型格式。
- Qoder 模型设置：<https://docs.qoder.com/zh/qoder/custom-models>；官网下载：<https://qoder.com/download>。未找到公开的模型导入格式，因此不推测私有凭据存储结构。
- 两个新增品牌图标均保存为本地资源，用于识别相应产品，商标归原权利人。CodeBuddy 图标来自官方页面指定的 <https://download.codebuddy.cn/web/website/f3549c299d2e32b9331b868677ac1bfbc84d807a/assets/logo.svg>；Qoder 图标来自 <https://qoder.com/favIcon.svg>，2026-10-19 获取。

检测不联网、不启动程序、不执行安装器；官网入口不替用户接受协议、卸载或升级。模型配置继续使用已有适配器和防覆盖机制。

## 本轮验证

- 新增 CodeBuddy／Qoder 后，相关前端测试 120 项通过，类型检查、前端生产构建通过。
- 外部配置适配器回归 19 项通过，覆盖原有四个工具及 CodeBuddy 的重复配置、能力参数、白名单、冲突保护。
- 本地工具探测单测 4 项通过；渠道目标持久化、网关转发隔离和用量归一化 3 项回归通过，包含 CodeBuddy 客户端。
- 只读实机检测：WorkBuddy 5.3.14（D 盘）、DeepSeek Harness 0.2.1-rc.2、ZCode 3.15.3 正确识别；MiMo Code 仅有配置，不误标为已安装。
- 新增只读实机检测：Qoder IDE 正确识别为 1.25.1（非卸载记录中的底座版本 1.106.3）；本机未安装 CodeBuddy，安装状态如实显示。
- 使用真实管理组件和隔离示例数据在浏览器检查布局、路径显示及黑白 Z 图标；临时预览已清理。
- macOS／Linux 检测分支尚未在对应系统做实机验证。
