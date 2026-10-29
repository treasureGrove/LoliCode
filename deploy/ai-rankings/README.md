# AI 榜单每日采集

此目录只管理 AI 榜单的代码、凭据、状态和公开 JSON 路由，不修改社区、账号服务或其他采集任务。

任务直接抓取 Artificial Analysis、LiveBench 和 Arena 的公开成绩；至少两个新鲜来源、十个交叉型号才发布，失败来源保留为空，不把旧成绩冒充新数据。GLM 使用订阅专属搜索 MCP 进行两次搜索，再通过真实 OpenCode CLI 调用 `glm-5.3-flash` 整理最多八条近七天的官方消息。模型不能执行命令、访问本机文件或改写排名分数；消息链接必须出现在实际搜索结果中。

完整采集、消息核验与数据校验都通过后，原子替换公开文件，并在私有目录保存历史和状态。失败时保留上次公开数据。桌面端启动、聚焦和每三十分钟检查更新，也支持手动刷新及离线缓存。

部署前可查看本地计划；此命令不连接服务器，也不读取凭据：

```powershell
python deploy/ai-rankings/deploy.py --host lolicode --dry-run
```

实际部署使用已有 SSH 别名，目标账号需具备 root 权限。添加 `--credential-stdin` 时，从标准输入接收一份包含 `apiKey` 和可选 `model` 的 JSON；凭据不出现在 SSH 参数、服务定义或部署回执中。添加 `--run-now` 会在安装后异步请求一次任务运行。

```powershell
python deploy/ai-rankings/deploy.py --host lolicode --credential-stdin --run-now
```

不提供新凭据时保留已有文件；首次安装若没有凭据，只创建空模板，回执不会声称密钥已验证。

- 定时器：`lolicode-ai-rankings.timer`，每天 **09:00 Asia/Singapore**，补跑错过的计划。
- 执行身份：专用 `lolicode-rankings` 用户；代码由 root 管理，服务仅可写自己的状态目录。
- 代码：`/usr/local/lib/lolicode-ai-rankings`。
- 私有状态与运行结果：`/var/lib/lolicode-ai-rankings/private`，运行状态为 `private/status.json`。
- 凭据：`/etc/lolicode-ai-rankings/glm.json`，root 所有、`0600`，通过 systemd `LoadCredential` 提供。
- 公开数据：`/var/lib/lolicode-ai-rankings/public/latest.json`，`0644`；只在该文件不存在时放置内置研究快照。
- 公开 URL：`https://lolicode.com/desktop-assets/ai-rankings.json`，允许 GET/HEAD，CORS 为 `*`，缓存 300 秒。
- 安装备份：代码目录的 `backups`，root 所有、`0700`；可能含旧凭据，不应发布。

安装器固定下载官方 npm 包 `@opencode/cli-linux-x64-baseline@2.0.12`，先校验 SHA-512 完整性，再仅提取 `package/bin/opencode`，无需在服务器安装 Node 或 npm。二进制和来源摘要保存在 `runtime.json`。

重装会核对归属标记、已安装文件摘要与现有站点配置；遇到陌生目录、服务、路由或并发改动会保留现场。nginx 验证或 reload 失败时恢复安装前的受管配置。服务通过 `journalctl -u lolicode-ai-rankings.service` 查看日志；检查任务是否成功应以私有运行状态和公开 JSON 为准，安装成功不等于本次联网采集成功。

本地测试不会访问服务器或模型服务：

```powershell
python -m unittest discover -s deploy/ai-rankings -p test_deploy.py -v
```
