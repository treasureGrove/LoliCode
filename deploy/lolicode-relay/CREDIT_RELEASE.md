# Credit 上线记录（2026-10-30）

中转站 `https://relay.lolicode.com/admin` 已提供每日个人/全站 Credit 与各模型输入、输出、缓存读写费率编辑，单位为 Credit / 1,000 token，支持零值和六位小数。普通账户的余额、图表与请求记录显示 Credit，保留原始 token 辅助统计。

本次初始按四类费率均为 1 固定迁移，保留个人每日 10,000 Credit、全站每日 100,000 Credit，以及原来的请求数、并发和频率限制。保存配置已经在真实浏览器完成，版本为 2、revision 为 7；重读确认持久化。改价仅影响新请求，在途与历史请求使用原费率快照；先按最高费率预留，再按实际分类结算。

选择性发布批次 `credit-20261030T075500Z`，发布执行约为 15:07（Asia/Singapore）。恢复材料在服务器 `/opt/lolicode-relay/credit-releases/credit-20261030T075500Z/`，发布前原有全量备份为 `/opt/lolicode-relay/backups/relay-20261030T070719092941Z.tar.gz`。未改 Nginx、论坛、数据库身份、密钥或渠道；服务器有差异的旧说明和安装器保留。发布脚本为 `release_credit.py`，必须先 prepare 隔离测试与迁移核对，再 apply；已有批次禁止重复应用。

验证通过：85 项服务端回归、38 项网站交互回归、67 项桌面前端/导航回归、9 项 Rust relay 回归及 TypeScript 检查。服务器隔离副本迁移两次后原 34 笔记录全部不变；上线后逐笔核对仍完整，Credit 换算正确，SQLite quick_check 为 ok。公网管理隔离、Origin、过期 revision、未开放模型拒绝及只读状态检查通过；没有调用真实模型或修改真实用量。实际浏览器完成小数配置的本地模拟保存/刷新，以及线上初始配置保存、桌面和 390px 手机费率表单验收。

服务器最终证明文件为 `credit-final-verification.json` 与 `public-settings-verification.json`，本地截图及证明在 `tmp/relay-credit-evidence/`。桌面端来源代码已支持 Credit 合同和旧接口换算，本次没有构建或发布新安装包。

回退不能恢复旧数据库或覆盖后续配置。当前已在后台保存 version 2，早期桥接不认识该结构；需要回退时先检查当前 revision、费率和新用量，采用兼容迁移或经审阅的配置转换，不能直接覆盖 `public-settings.json`。保留所有加列后的账本数据和上线后的新请求。
