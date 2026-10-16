# LoliCode 4.0.18 验收与发布记录

2026-10-17，Windows x64。源码验收已完成；发布产物和线上更新结果在完成后补入本记录，不能把候选构建视为已经发布。

## 本轮交付

- 主 Agent 增加有界本地记忆：用户偏好与项目约定分开，默认写入需要确认，可以检查、编辑、关闭和清除。参考 Hermes 的设计，独立实现；没有打包 Hermes 或宣称支持其外部记忆插件。
- WorkBuddy、DeepSeek Harness、ZCode、MiMo Code 纳入用量导入与模型配置。客户端只得到本机网关 token，真实上游 Key 留在 LoliCode；使用这些路由时 LoliCode 必须运行。保留原配置、私有备份及冲突检查。WorkBuddy 与 DSH 添加后仍需要在客户端选择模型，不改动正在运行的会话。
- 新版 ZCode 正式 Personal 配置经其固定上游 decoder、resolver、registry 和 Option Maps 实际验证；旧版配置作为兼容路径。完整 YAML 校验防止 DSH 相似 provider 键误删，Windows 联接目录拒写。
- 工作流采用 Markdown 参数和持久化执行记录，支持查看、停止、错误状态与重启恢复。闲时任务读取实际系统闲置状态；Windows 已验收，Wayland 无可靠来源时明确不启动，不伪造空闲。
- 接入 8 类 ZCode 市场 CLI 技能，按需下载、校验哈希并受工具权限控制。没有打包第三方 CLI，也没有把尚未实现的 JavaScript／MCP 插件宿主标成可用。
- 会话用量保留已收到的 token 与缓存统计，不因新请求尚未上报就清空；缺失指标与真实零值分开。自动思考档位在真实支持列表中优先 medium、其次 high。运行中修改模型和档位在下一次模型请求生效。
- 移除旧 CC Switch 页面、导航和多余首次使用提示，保留现有数据、迁移、备份、配置兼容及必要版权声明。

## 验收证据

- 全量前端：258 文件、3,072 测试通过；TypeScript 检查通过。
- 桌面 Rust：3,795 通过、12 忽略、0 失败。主 Agent 独立核心另有 100 项通过。
- NSIS 升级保护：8 项通过，包含真实 makensis 编译和隔离的同名旧进程路径检查。旧版 `tai-switch.exe` 与新版 `LoliCode.exe` 都按注册安装目录校验，不关闭其它目录的同名程序。
- 发布准备工具：9 项通过，覆盖签名、篡改、版本和 latest 最后切换约束。
- 用量只读验收：22,571 条去重请求，WorkBuddy 283、DSH 20,350、ZCode 1,797、MiMo 141；重复同步新增为 0、错误为 0。DSH 排除 304 条 fork 继承记录。数量仅代表本机可读日志，不能当成官方完整账单。
- 真实 GLM 5.3 Flash／medium：3 次请求完成图片识别、读取文件、修改 JS，3 个算术断言通过；4,812 tokens。
- 另一组真实记忆验收：3 次请求、5,229 tokens；默认确认前存储为空，工具写入后新会话在未透露标记的提问中正确读回。关闭后的请求由离线 relay 检查，不含标记也不广告 memory 工具，没有第 4 次模型调用。
- 官网动效：47 项测试通过，线上桌面和 390px 页面无横向溢出、无控制台错误；支持系统减少动态效果。

本机详细日志和脱敏 GLM 回执位于忽略提交的 `release/` 目录；可重复命令及边界见 [主 Agent 实际渠道验收](../architecture/native-agent-live-acceptance.md)、[记忆](../architecture/agent-memory.md)、[外部配置](../architecture/external-model-config.md)、[本地用量](local-agent-usage.md)、[工作流与 CLI](agent-workflows-cli-adapter.md)。

## 验收边界

第三方配置 writer 使用隔离 fixture，没有覆盖用户真实客户端配置；真实软件重新打开后的端到端体验仍需跨机验收。费用缺少官方账单或价格时只展示可取得的用量或明确估算，不能保证读取所有应用的所有调用。

本轮发布 Windows x64；macOS／Linux 的安装包和系统闲时行为尚未完成真机验收。自动更新的下载与签名应使用最终公开产物再验收；真实 Windows 全量覆盖安装尚无独立 VM／Sandbox 证据，不以签名验证代替这一结论。
