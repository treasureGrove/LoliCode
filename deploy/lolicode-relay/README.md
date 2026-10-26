# LoliCode 中转站基底

部署 New API、PostgreSQL 15、Redis 7.4 和 LoliCode 账号/每日额度桥接服务。
镜像由 `images.lock.json` 固定版本及摘要。网关部署脚本只管理自身目录和服务；
`install_bridge.py` 另外为既有 HTTPS 网站增加 `/relay/` 路由，并保存原站点配置备份。

## 安装

本地需要 Python 3 和已配置的 SSH 主机别名，目标服务器需要 Docker Compose、systemd 和 Python 3。

```powershell
python deploy/lolicode-relay/deploy.py --host lolicode
```

仅在检查过本任务创建的 `/opt/lolicode-relay` 后，才使用 `--resume` 恢复中断安装。
脚本保留已有密钥及数据，不覆盖陌生目录或已有服务定义。
`--prepare-only` 只安装配置和服务定义，不启动容器，供迁移恢复使用。

## 迁移到其他服务器

当前部署目标为 `lolicode`，与社区网站同机，容器数据库和缓存仍保持独立。
账号联动约束不因同机部署而改变，不能让两个系统直接共用用户表。

`migrate.py` 适用于尚未接入真实用户和模型渠道的基底迁移：

```powershell
python deploy/lolicode-relay/migrate.py --source tools --destination lolicode
```

目标机需先安装 Docker Compose，并按 `images.lock.json` 拉取三份固定镜像。
目标目录、容器、数据卷和服务定义都必须为空；脚本拒绝覆盖既有实例。
迁移会暂停源实例写入，导出数据库和配置，经本机内存中转到目标机，校验 SHA-256，
保留管理员凭据及密钥，并对照所有数据库表的记录数。备份和凭据不会落盘到本机。
新实例通过模拟转发、额度、重启持久性和备份恢复验收后，才停止并禁用源实例及其备份定时器。
源服务器的目录、数据卷和最终归档会保留，迁移记录在目标机 `migration.json` 和源机 `MIGRATED-TO.json`。

验收失败时脚本尝试停止目标实例、恢复源实例，不自动删除失败现场；需先查看错误及两端状态再恢复。
完成真实用户和上游接入后，应另行安排维护窗口及适合生产数据量的迁移验收，不能直接运行这个基底专用脚本。

## 管理入口

服务绑定服务器 `127.0.0.1:13000`，通过 SSH 隧道访问：

```powershell
ssh -N -L 127.0.0.1:13000:127.0.0.1:13000 lolicode
```

浏览器打开 `http://127.0.0.1:13000`。管理员用户名为 `relayadmin`。
初始随机密码保存在服务器 `/opt/lolicode-relay/admin-credentials.json`，权限为 `0600`。
该文件不复制到仓库，管理员可通过受信任 SSH 会话查看并在登录后改密。

初始关闭自助注册和自动赠额，没有预置真实模型渠道。确认上游套餐的适用范围后再添加渠道。
已接入 LoliCode 原账号和按账号共享的每日公益额度；设备指纹绑定及按模型分配独立额度未实现。

## LoliCode 账号联动约束

普通用户注册入口为 `https://relay.lolicode.com/register`，`/sign-up` 也兼容跳转，
均 302 到 `https://lolicode.com/all?account=register`。它们使用原有 Flarum 账号体系，
不开放第二套 New API 注册。已有账号可在 `https://relay.lolicode.com/account` 使用原用户名或邮箱、
密码登录查看额度，客户端也使用同一账号。`/sign-in` 和 `/login` 默认跳转普通账号页；
管理员入口为 `https://relay.lolicode.com/sign-in?admin=1`。
公益首页已提供注册、登录与额度入口和对应 FAQ。

`web_account.py` 通过原论坛 HTTPS `/api/token` 验证密码，不保存密码，不向浏览器返回论坛 token、
New API 密钥或管理员令牌。服务器在仅 root 可读的桥接 SQLite 中保存短期论坛 token 和随机会话摘要，
浏览器只得到 `__Host-` 前缀、Secure、HttpOnly、SameSite=Lax、55 分钟过期的本站 Cookie。
网页登录与论坛浏览器登录是两个会话，使用同一份账号凭据，不会自动互相登录。
网页请求实时复核论坛身份、封禁与公益停用状态；退出立即撤销该网页会话。
登录与退出校验精确 Origin 和 JSON 类型，登录入口受 Nginx 每 IP 限速保护。
网页会话只允许查看本人额度，不能用于原生管理 API 或模型推理；`/relay/web/` 被 404 阻断。
新账号按不可变论坛 ID 懒创建普通计量身份，网页和客户端读取同一份 20 次 / 100000 token 每日账本。
`test_bridge.py` 与 `test_web_account.py` 共 25 项回归通过；`verify_web_account.py` 通过公网 HTTPS
验证新普通账号登录、错误密码、Origin 拦截、额度一致、退出、封禁及管理员入口隔离，未调用模型。
回执为 `web-account-verification.json`，临时账号、会话和计量记录已清理。

首页及公开的模型广场、排行榜、关于页使用 `public-account.js/css` 渲染 LoliCode 账号导航，
顶部登录按钮和首页主按钮直接在首页打开同一个原账号登录弹窗，成功后留在首页显示用户名。
顶部「控制台」指向 `/account`，沿用同一 Cookie，无需再次输入密码；刷新、返回首页仍复核该会话。
退出后同时更新顶部和正文按钮。匿名首页不会把独立的 New API 管理员会话显示为普通用户登录状态。
原 New API 导航仅在管理页面显示，`/channels` 等管理员路由保持原界面。
首页 iframe 仍为不透明来源沙箱，父页仅向其发送登录布尔值和主题，不传用户名、凭据或个人额度；
子页的登录弹窗请求必须校验消息来源为当前受管 iframe。
公网浏览器验收覆盖首页正确/错误密码、首页保留登录、控制台免重复登录、返回首页状态、退出、
正文按钮唤起同一弹窗与管理员渠道页保留原导航；未调用模型，回执为 `homepage-account-verification.json`。
自动部署的 `Dashboard` 帮助类在进程结束时退出自己创建的管理会话，避免累积到 New API 会话上限。
2026-10-21 清理了 44 个明确属于 `LoliCodeRelaySetup/1.0` 的旧自动化会话，保留用户的两个浏览器会话。

`install_account_entry.py` 在原有 Flarum `custom_header` 末尾追加带所有权标记的脚本引用，
保留其他自定义内容。`forum-account-entry.js` 仅处理明确的 `account=register/login` 入口，
点击 Flarum 自带的注册/登录按钮来打开原生对话框；不读取表单凭据、不代填、不提交注册。
已登录访客收到无需重复注册的提示。普通访问不受影响。
原 header 首次快照、脚本及所有权标记保存在 relay 目录并纳入备份；迁移时先保留目标论坛
现有 header，再运行安装工具追加引用，不能用旧快照覆盖后续站点修改。

已验证公开跳转、匿名论坛页面加载脚本（会话 userId 为 0）、已登录提示和首页按钮。
New API 独立注册仍关闭，公益额度及 Flash 试用策略未变；没有提交新注册或发送邮件。
回执位于服务器 `account-entry-verification.json`。

账号唯一来源是 `lolicode.com` 上现有的 Flarum 1.8 社区，不在网关要求用户再次注册。
网关数据库只保留内部计量身份和稳定的 `lolicode_user_id -> gateway_user_id` 映射；
密码、Passkey 和邮箱验证由原账号服务维护，不复制到 New API；短期网页凭据仅保存在桥接私有状态库。

当前账号联动：

1. 从可信服务端验证的登录身份按需建立映射，以不可变用户 ID 匹配，不依赖可修改的昵称或邮箱。
2. 同步用户名、昵称，在 New API 中按 `lc_<论坛ID>` 创建普通计量用户。所有论坛角色均映射为普通用户，
   不复制邮箱、密码或管理员权限；目前没有社区分组差异化权益。
3. 每次推理都实时验证原论坛凭据、自身专属资料及封禁到期时间；账号删除、封禁、凭据撤销后，
   后续请求立即被拦截。论坛不可用时拒绝转发，不用旧缓存放行；已经开始的请求允许完成结算。
4. 每个用户的所有设备和凭证共用份额；同步资料不能重置用量或重复发放公益额度。
5. 对外推理入口必须经过账号校验。仅配置网页 OAuth 登录不会自动限制既有 API Key 的推理请求。

现有桌面登录会检查 Flarum 当前用户专属字段，避免把匿名可访问的公开用户资料误判为有效登录。
Flarum 用户详情接口还可为本人返回封禁到期时间；实际联动应验证匿名、伪造用户 ID、
失效凭据、封禁、解封、重命名、删除、重复同步和并发首次登录等场景。
账号桥接服务已部署并通过临时论坛账号验收。仅在用户首次访问公益功能时创建内部映射，
不批量导入社区用户。原论坛 PHP、数据库结构、登录接口和注册流程均未改动。

当前通过客户端系统凭据库、网页私有短期会话和服务端身份桥接完成联动，未增加 OIDC 或第二套用户注册页面。

## 每日公益额度与公开接口

公开接口是 `https://lolicode.com/relay/v1`；原始 New API 管理面板及推理端口继续只绑定环回地址。
客户端使用自身已保存的论坛登录凭据，由 Rust 层临时附加认证信息；网页 IPC、模型目录和客户端配置
都不保存或返回论坛 token、New API 密钥、内部随机密码或上游密钥。

每个论坛账号每天最多 **20 次成功请求、输入输出合计 100000 token**，所有设备共享；
新加坡时间零点按新的日期桶恢复，剩余额度不累积，改名、重新登录和重启服务都不重置额度。
转发前在 SQLite 事务内预留一次请求和 token，默认单账号最多 2 个在途请求。
仅支持文字和客户端函数工具，单次输出默认最多 4096 token，正文最多 128 KiB。
输入按 UTF-8 JSON 字节数和额外协议开销保守预留，因此上下文较长时可能提前提示剩余额度不足；
结束后按上游返回的 `usage` 结算。上游非 200 响应退还本次预留；连接中断、缺少用量、进程崩溃的
未完成请求保留预留额度，避免断线重试绕过上限。计量准确性依赖所接入上游正确报告用量。

`bridge-policy.json` 保存全局每日上限和公益模型白名单，调整后重启 `lolicode-relay-bridge.service`。
`models` 当前为空，尚未接入真实上游；用户能登录和查看额度，但没有可调用的公益模型。
接入渠道后，需明确将模型加入这里的白名单，例如模型目录项包含 `id`、`name`、`contextLimit` 和 `outputLimit`。
模型只能由服务端允许，客户端改名或改配置不能扩大服务端白名单。
可选 `require_confirmed_email` 默认关闭，保持原论坛账号登录后即可关联；开启后会额外要求邮箱已验证。
安装脚本保留已有策略文件，不覆盖管理员调整。

New API 中的普通用户只承担内部用量归属；其初始内部余额 50000000 计费单位与每日 raw token 份额是
两套不同量纲。该余额不会每日重置，余额耗尽后也会停止转发，管理员可在原 New API 后台按需调整。
内部令牌只保存在服务器 `bridge-state/bridge.sqlite3`，用户不能通过公开接口获取或绕过身份桥接直接调用 New API。

```bash
cd /opt/lolicode-relay
python3 manage_quota.py list
python3 manage_quota.py disable --user-id 123
python3 manage_quota.py enable --user-id 123
systemctl status lolicode-relay-bridge.service
```

管理员也可以在原论坛封禁用户，后续公益推理请求会跟随被拒绝。命令行的启停仅调整公益资格，
不会修改论坛账户，也不会清空历史用量。

桌面端已加入自动同步公益模型目录，以及头像菜单中的“公益模型与每日额度”入口。
本次客户端改动在当前源码工作区，尚未打包或发布安装包；已安装的旧版本需要更新到包含这些改动的版本。

## 资源预算

- New API：内存上限 512 MiB，最多 1.5 CPU；Go 内存软目标 320 MiB。
- PostgreSQL：内存上限 320 MiB，最多 0.75 CPU，40 个连接上限。
- Redis：内存上限 96 MiB，最多 0.25 CPU，缓存数据上限 64 MiB。
- 合计内存硬上限 928 MiB；数据库和缓存不映射主机端口。
- 账号桥接服务另设 192 MiB 内存上限，实际用量以 systemd 状态为准。
- Docker 日志各保留 3 份、每份最多 10 MiB；应用日志配置 logrotate。

这些是部署预算，不是并发能力承诺。模型在上游运行，本服务器处理鉴权、计量和流式转发。
需要以真实上游的延迟、限速、请求大小和实际峰值负载决定可开放人数。

## 运维

```bash
systemctl status lolicode-relay.service
systemctl status lolicode-relay-bridge.service
docker compose --project-directory /opt/lolicode-relay ps
docker compose --project-directory /opt/lolicode-relay logs --tail=100 new-api
systemctl start lolicode-relay-backup.service
systemctl list-timers lolicode-relay-backup.timer
```

安装验收脚本为 `verify.py`，只允许在没有真实上游渠道的基底上运行：

```bash
cd /opt/lolicode-relay
python3 verify.py
```

脚本临时使用 Docker 网桥上的本地模拟上游，验证鉴权、普通/流式工具调用、模型白名单、
零额度拦截、10 个并发请求、用量扣除、应用重启持久性，以及备份恢复到隔离临时数据库。
完成后移除自己创建的测试渠道和令牌，不调用外部模型；结果保存在 `verification.json`。
模拟并发测试不代表真实模型吞吐、实际服务人数或长时间稳定性验收。

桥接服务安装及独立验收：

```powershell
python deploy/lolicode-relay/install_bridge.py --host lolicode
```

全新实例先执行 `install_bridge.py --prepare-only` 暂存桥接源码和服务，再执行
`install_service_identity.py` 创建机器身份，最后执行不带 `--prepare-only` 的桥接安装命令。
机器身份为 `lc_bridge_service`；实际桥接只使用 `user:read`、`user:write` 两项权限的面板访问令牌。
令牌与服务账号凭据保存在仅 root 可读的 `bridge-service-credentials.json`，不传给客户端，
也不会在令牌失效时回退到管理员密码登录。

管理员可在 HTTPS 后台的「安全与访问 → 更改密码」修改自己的密码，桥接不依赖该密码。
`admin-credentials.json` 记录的是首次初始化密码；自行改密后该文件不会自动更新，
应使用你设置的新密码登录。后续需要人工管理权限的初始化、验收工具也应使用当前凭据。

目标机需安装 Ubuntu 维护的 `python3-aiohttp`。安装脚本先备份、运行 `test_bridge.py`，
再验证 Nginx 配置并平滑 reload，不重启论坛服务。公开路由按真实来源 IP 限制 30 次/分钟、突发 10 次，
仅转发至 `127.0.0.1:13001`，关闭响应缓冲和缓存以支持 SSE。

`python3 -m unittest -v test_bridge` 使用本地模拟服务验证身份与额度。
`python3 verify_bridge.py` 仅允许在尚无真实渠道且未开放模型的实例上运行，创建并清理临时论坛用户，
通过真实论坛原登录、公开 HTTPS 账号关联和本地模拟 New API 上游，验证 20 次后拒绝、流式用量、
封禁、改名、撤销凭据。原论坛的临时账号和中转渠道会清理，New API 只保留软删除测试用户及审计记录。
验收回执位于 `bridge-verification.json`，不包含凭据；测试不调用付费上游。

每天新加坡时间 03:20 后随机延迟最多 5 分钟备份，保留最新 7 份。
备份位于 `/opt/lolicode-relay/backups/`，包含 PostgreSQL 自定义格式导出、配置、应用数据和管理凭据。
归档另外包含桥接策略、服务源码与 `bridge-state/bridge.sqlite3` 的在线一致性快照。
机器身份凭据、权限标记、`portal-source` 中的公开页面源码、已修正的 Fail2Ban 过滤器副本
和本文档也包含在备份中。迁移时先检查新主机现有防护规则，不能直接覆盖其他站点的过滤器。
New API 账号、令牌和内部余额以 PostgreSQL 为准；每日请求/token 计量及论坛映射以桥接 SQLite 为准。
Redis 是缓存及限流辅助状态。换服务器必须一起恢复两个数据库、策略和密钥，不能重新初始化每日计量库。
每日备份目前仅在同一台服务器，尚未配置持续异地复制；迁移前的最终归档仍保留在 tools。
归档包含密钥，应保持仅管理员可读。

恢复时应先在隔离数据库验证 `database.dump`，再安排正式恢复；不要直接覆盖运行中的数据库。
镜像更新应先备份、修改锁定摘要并检查迁移兼容性，不能假定旧版本支持回退新数据库。

## 公网入口与剩余接入

`lolicode.com/relay/` 已使用现有 HTTPS 证书开放身份桥接，管理后台为
`https://relay.lolicode.com/sign-in?admin=1`；原始 13000 端口仍只绑定回环地址。
公网后台配置位于 `admin-nginx-*.conf`；准备命令仅上传并验证配置，不开放面板：

```powershell
python deploy/lolicode-relay/install_admin.py
```

`lolicode.com` 当前权威 DNS 为 Cloudflare。添加 DNS only 的 A 记录 `relay -> 43.108.86.66`，
且该名称没有其他 A/AAAA 记录后，可执行：

```powershell
python deploy/lolicode-relay/install_admin.py --activate
```

激活脚本使用现有证书账号和 webroot 为 `relay.lolicode.com` 获取独立证书、设置自动续期 reload，
启用 Secure Cookie、精确可信 HTTPS 地址，并仅信任当前 Docker 网桥网关的转发 IP。
公网仅提供后台页面和原有鉴权的管理接口；`/v1`、`/v1beta`、`/pg`、`/mj` 等推理入口返回 404。
管理登录另设每 IP 每分钟 10 次限制，后台 API 每分钟 120 次；不会修改论坛站点或公开原始 13000 端口。
激活后后台为 `https://relay.lolicode.com`；原来的本地 HTTP 隧道无法可靠续期安全 Cookie，
后台管理应改用 HTTPS 地址，服务器上的桥接服务继续使用本地 Bearer 认证。
配置失败会恢复原有 Nginx 文件及会话环境配置。

已完成公网验收，`python3 /opt/lolicode-relay/verify_admin.py` 可重复检查管理员登录、
安全 Cookie、会话刷新/退出、非可信 Origin 拦截、关闭注册、已登录用户仍不能直接推理、
原官网与桥接健康，以及独立证书的自动续期钩子。不调用模型上游，结果写入 `admin-verification.json`。
该脚本默认使用首次初始化凭据，管理员自行改密后应改用当前凭据运行人工验收。

`https://relay.lolicode.com/` 由官方应用提供，通过 `HomePageContent` 配置嵌入公益说明页，
保留原生主页、控制台、模型广场、排行榜、文档、关于及语言、主题、通知和账户菜单。
说明页复用官网的樱桃红、奶油白和看板娘素材，位于官方不带同源权限的沙箱中，
通过无凭据的 `/community-status` 读取开放状态与每日限额，不接触登录状态或内部账号。
只有该公开状态响应允许跨域读取，管理接口的鉴权和跨域策略保持原有设置。
`portal-host.js` 仅接受自己沙箱页面发出的尺寸与页内锚点消息，自动撑开正文，
保留一层页面滚动；滚动条及正文配色跟随原生主题，手机端使用原生折叠菜单。
`install_portal.py` 在备份后发布上述资源并配置首页，失败会恢复页面、Nginx 和原首页设置。
该操作需要当前管理员凭据；后台保留 `/sign-in?admin=1`、`/security`、`/channels` 等原生路由，
不修改上游压缩脚本或鉴权流程。

旧服务器的 `nginx-exploit` Fail2Ban 规则曾将合法 `/api/token` 请求误判为漏洞扫描，
连续三次就会封禁访客的 HTTP/HTTPS 24 小时。`fix_firewall.py` 仅移除此误判分支，
用六个合法请求和五个漏洞扫描样例回归测试，再解除当前管理员的误封，其他封禁保持不变。
`verify_password.py` 使用自动清理的临时账号验证密码变更、新密码登录、旧密码/会话失效，
并确认机器令牌仍能工作；不会修改管理员本人的密码，也不调用付费上游。
没有支付服务和第二套开放注册。当前仅开放下述 GLM Flash 限时试用，其余真实上游保持管理员预览。

## GLM Flash 普通账号试用（2026-10-21）

`open_glm_trial.py` 已启用渠道 10，渠道与桥接白名单都仅包含 `glm-5.3-flash`，
DeepSeek、ChatGPT 和非 Flash GLM 保持关闭。普通用户沿用原来的论坛账号。
客户端在「公益模型与每日额度」刷新模型后选择 GLM 5.3 Flash。

本轮服务端策略：

- 每账号每天 20 次请求、10 万原始输入输出 token；所有设备共用，UTC+8 零点重置，不累积。
- 每账号与全站同时均最多 1 个请求；繁忙返回 429，并提供短 `Retry-After`。
- 全站每分钟最多 6 次到达上游的请求；失败退回每日额度，但仍计入分钟速率。
- 全站每天共用最多 200 次请求、100 万 token；输入输出及正在处理的预留一起检查。
- 单次最多输出 4096 token、上下文上限 32768；文本及客户端函数工具请求，JSON 最多 128 KiB。
- 临时授权 2026-10-21 21:27:53（UTC+8）到期，本轮试用于 21:22:23 提前自动关闭，
  给正在处理的请求保留时间。到期后账户及模型发现返回未开放，推理在转发前拒绝。

全站与个人预留使用同一个 SQLite `BEGIN IMMEDIATE` 事务，多个账号不能竞争穿透共享上限。
匿名状态仅公开配置上限及结束时间，不公开账号、凭据或个人用量。后台原始推理端点仍为 404。
首页每分钟刷新开放状态，显示全站共享额度和本轮结束时间。

`test_bridge.py` 共 19 项本地回归测试通过，覆盖跨账号竞争、全站并发与 token 预留、
分钟限速、午夜重置、到期关闭和原有鉴权/计量逻辑。
`verify_glm_trial.py` 使用自动清理的普通论坛测试账号，通过公网 HTTPS 实测普通响应、
SSE、精确 token 结算、仅 Flash 可见、未登录拒绝和个人两类每日上限。
达到额度上限的验证仅修改该临时账号的测试计量记录，不发送额外模型请求，也不修改真实用户额度。
首轮调用通过后曾遇到测试账号清理权限限制，已改用原有夹具的精确软删除流程并清理现场；
两轮合计 4 次 Flash 调用、339 个原始 token。验收回执记录第二轮成功结果。
服务器回执为 `glm-trial-activation.json` 与 `glm-trial-verification.json`，均包含在后续备份中。

## 本机渠道试接入（2026-10-21）

已从本机 LoliCode 渠道中心只读导入三路配置，管理员可在 `/channels` 查看：

- `Desktop Preview - DeepSeek`（渠道 8）：官方 API，模型 `deepseek-flash`。
- `Desktop Preview - ChatGPT Pro`（渠道 9）：New API 原生 Codex 类型 57；
  保存本机启用的七个普通 GPT 模型，已验证 `gpt-6-luna` 的原生 Responses 流式调用。
- `Desktop Preview - GLM Coding Plan`（渠道 10）：自定义 OpenAI 兼容类型 8，
  使用完整 Coding Plan Chat Completions URL，保存 `glm-5.3`、`glm-5.3-flash`，已验证后者。

三次真实后台测试合计 94 个原始输入输出 token，均成功；GPT 测试为流式，另外两次为普通响应。
测试没有验证全部候选模型、工具调用或真实缓存命中。新增倍率 1 仅用于内部测试点数，
不能作为上游价格；不得据此向用户展示实际美元成本。

初次导入时三路均以手动停用状态保存，桥接白名单为空；随后仅按上一节开放 Flash 试用。
公网原始推理端点继续关闭，每日 20 次和 10 万 token 的个人额度保持不变。
按用户要求不接入内网 LiteLLM；它解析到私网地址，服务器无法直接访问，也没有为它建立隧道。
未导入 GitHub Copilot，未修改本机默认模型或登录文件。

`import_desktop_channels.py --apply --source-id <桌面渠道 ID>` 用于初次导入 API Key 渠道；
`--test` 仅测试尚未记录的条目，防止重复消耗上游额度。它通过 SSH 标准输入传输凭据，
凭据仅存入服务器上的 New API 数据库，日志和回执不含密钥。
`import_desktop_subscriptions.py` 用于一次性的私有订阅预览，不复制 ChatGPT refresh token，
也不在服务器持久保存 GLM 网页登录凭据，不会与本机并行刷新同一登录链。

本次 ChatGPT access token 有效至 2026-10-30 10:20（UTC+8）；
GLM 项目 token 有效至 2026-10-21 21:27（UTC+8）。未配置订阅令牌自动续期，
不能把这两条预览渠道视为持续可用的公共渠道。后续正式接入需要独立处理登录、续期、
分发授权及原生协议；当前公网桥接尚不支持 Responses。
服务器回执为 `desktop-channel-import.json`、`desktop-subscription-preview.json`。

## 渠道与缓存接入前提

个人订阅不自动等同于多人 API 分发额度。GLM Coding Plan 的官方 FAQ 明确限制套餐共享，
并要求自建应用使用标准 API；ChatGPT 订阅用量与 API 计费分开。添加真实渠道前确认具体套餐、
接入地区、模型权限及分发授权，再读取该渠道的实际 RPM、TPM/ITPM/OTPM 和并发上限。
当前 Flash 试用采用上述全站 1 并发及 6 RPM 控制，繁忙直接返回 429；
尚未实现等待队列或多个渠道的独立速率配置。

桥接已保留经格式校验的 `prompt_cache_key`、`prompt_cache_retention`，不会自动强制延长缓存时间。
文字内容块中的缓存标记、消息顺序及普通/流式响应中的缓存用量字段在桥接段保留。
上游缓存折扣不会改变每天 10 万原始输入输出 token 的额度规则。
当前公网桥接仅提供 Chat Completions；锁定的 New API 在此请求结构中没有新式
`prompt_cache_options` 字段，因此桥接对该选项明确返回 400，避免静默丢弃后误以为已启用。
需要该功能的模型应先完成原生 Responses 接入；Claude 的原生 Messages 路径也尚未公开。
真实缓存命中仍需根据选定模型、请求前缀、TTL、渠道转换和上游返回的 usage 验收。
Redis 缓存账号/调度信息不会自动建立模型的提示缓存；缓存字段的回归测试使用本地模拟上游，
上述三次真实渠道连通测试没有验收缓存命中。

参考：[OpenAI 缓存](https://developers.openai.com/api/docs/guides/prompt-caching)、
[OpenAI 限流](https://developers.openai.com/api/docs/guides/rate-limits)、
[Claude 缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、
[Claude 限流](https://platform.claude.com/docs/en/api/rate-limits)、
[GLM Coding Plan 常见问题](https://docs.bigmodel.cn/cn/coding-plan/faq)。

参考：[New API 官方部署文档](https://docs.newapi.pro/zh/docs/installation/deployment-methods/docker-compose-installation)。
