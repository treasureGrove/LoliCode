# LoliCode 命名统一（待下次打包）

保持版本 4.0.21，本轮不创建安装包或发布 Release。

## 验收项目

- [ ] Rust 包、可执行目标、库分别为 `lolicode`、`lolicode`、`lolicode_lib`；桌面安装包继续使用显示名称 `LoliCode`，发行方设为 `LoliCode`。
- [ ] Claude Desktop 中已有的托管配置继续使用相同 ID，显示名称改为 `LoliCode`，不另建重复配置。
- [ ] 渠道聚合和用量界面的网关名称显示为 `LoliCode Gateway`。
- [ ] 新的 Codex 模型目录为 `lolicode-model-catalog.json`；已有旧文件引用仍视为本应用托管文件，并继续做路径范围校验。
- [ ] 新日志为 `logs/lolicode.log`，终端启动提示、网络请求标识、模型看到的工具媒体标记使用 LoliCode。
- [ ] 新生成的思考／压缩传输标记使用 `lolicode-`；旧会话中的 `ccswitch-` 标记可以继续解码和恢复，不丢失签名或摘要。
- [ ] 主题、缓存和技能安装目标改用 `lolicode` 存储键，自动读取旧键；已保存的新值优先，写入失败也保留原偏好。
- [ ] 新建数据库使用 `lolicode.db`；已经存在 `cc-switch.db` 的数据目录继续原地读写该文件。已有项目、渠道、API Key 不因品牌改名而搬家或被空库覆盖。
- [ ] 新建同步配置默认目录 `lolicode-sync`；旧配置已保存的目录和缺省旧目录继续保留。新同步清单使用 LoliCode 格式，仍接受旧清单。
- [ ] 数据恢复入口同时接受新旧数据库；数据库升级页的官网入口指向 `https://lolicode.com/`。
- [ ] SQL 导出使用 LoliCode 标题；旧 CC Switch 标题的 SQL 备份仍能完整导入并恢复数据。
- [ ] 供应商预设移除继承的上游推广参数及合作徽章，不假称 LoliCode 已取得上游的合作或优惠。

## 兼容与署名

保留安装身份 `art.treasuregrove.tai-switch` 和已有 `.tai-switch` 数据根目录，保证覆盖升级、WebView 偏好、登录与配置路径稳定。保留历史协议 ID、迁移字段与旧文件名的读取能力；它们不是新产品的显示名称。

原项目的 MIT 版权、许可证和来源记录继续保留。本轮不重写第三方程序、许可证或上游源码中的品牌。

新版本能读取旧同步清单和 SQL 备份；旧客户端不识别新格式，多设备共用同步目录时需一起升级。

## 本轮已完成的自动验证

- 前端全量测试：268 个文件、3,130 项通过。
- Rust 库全量测试：3,895 项通过，14 项按原有条件忽略。
- 最后清理推广链接后，预设与对应表单金标回归：837 项通过。
- `pnpm typecheck`、`cargo check --all-targets`、`pnpm build:renderer` 和 `git diff --check` 通过。
- Cargo 元数据确认包／二进制目标为 `lolicode`、库为 `lolicode_lib`；主题引导脚本的 CSP 哈希与 Tauri 配置一致。

以上为本机 Windows 源码验证。尚未创建或验证新安装包，也未进行 macOS／Linux 的实机安装验收；上方勾选项供下一次打包后逐项检查。
