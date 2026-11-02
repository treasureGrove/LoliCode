# 按百万 token 计费与每小时巡检（2026-10-30）

已上线到 `https://relay.lolicode.com/admin`。直接 Credit 和费用单价均按每 1M（100万）token 填写，另支持按次固定费用。新费用与 Credit 换算为空，由管理员自行填写；原有配置 revision 7、两个公开模型、个人/全站额度、34 笔用量及旧费率保持等值。旧每千 API 单位仅作客户端兼容，界面已转换为每百万。

发布批次 `credit-20261030T074000Z`，实际发布约 15:47（Asia/Singapore）。恢复材料在 `/opt/lolicode-relay/credit-releases/credit-20261030T074000Z/`，发布前备份为 `/opt/lolicode-relay/backups/relay-20261030T074702030044Z.tar.gz`。SQLite 只增加费用快照/明细列和独立探针租约表；不恢复或重建用户库。Nginx 仅将 relay 管理设置接口的正文上限从 64k 提至 256k，已通过独立配置及正式 `nginx -t`；论坛路由和主配置未改。

152 项服务端回归及 49 项门户回归通过，服务器隔离测试、现有账本重复迁移校验、systemd 单元验证、只读 dry-run 与公网权限检查均通过。实际浏览器在本地模拟保存并刷新验证 `125.123456 Credit/M` 精度及按量价/换算，线上只读验证单位和真实巡检结果，没有代填采购价或 Credit 换算。

`lolicode-relay-health.timer` 已 enabled/active，每小时运行，当前验证的下一次计划为 2026-10-30 16:00:20（UTC+8）；页面显示整点计划，实际有最多 30 秒随机延迟。原生 `monitor_setting.auto_test_channel_enabled=false`，没有叠加第二套自动探测。

首轮于 15:47:33 开始，共三次测试尝试：渠道 12 DeepSeek 正常（797 ms）、渠道 11 智谱正常（2952 ms）、渠道 10 旧 Desktop Preview GLM 失败（79 ms）。失败已显示，未自动停用渠道或重试。用户 requests 仍为 34 笔、旧记录及 Credit 逐笔一致；三个探针使用独立表，不扣用户每日 Credit。账本 quick_check 为 ok，论坛/官网/中转站响应正常。

最终证明为服务器 `/opt/lolicode-relay/billing-health-final-verification.json` 及 `public-settings-verification.json`，本地 `tmp/relay-credit-evidence/billing-health-verification.json` 与 `billing-live-1m.png`。未来回退须保留新请求、探针历史与用户配置；不能直接恢复旧数据库或覆盖用户已编辑的报价。

同日美元预设更新：用户明确指定 1 USD = 100 Credit（10 USD = 1000 Credit）。框架默认值及缺配置页面预设已更新；现场用户已保存的 revision 8、USD/100 比例保持原字节，模型价格未代填。批次 `credit-20261030T075824Z`，发布前备份 `relay-20261030T075841288753Z.tar.gz`，未改 Nginx 或定时器。新增按次 $10 和按量 $10/M × 1M 均精确结算 1000 Credit 的回归通过；49 项门户回归及服务器隔离验证通过。
