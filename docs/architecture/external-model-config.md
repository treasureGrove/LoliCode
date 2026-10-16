# 外部 Agent 的 LoliCode 模型接入

独立模块 `src-tauri/src/services/external_agent_config.rs` 不扩充遗留 `AppType`，也不安装、运行或导入其它 Agent 程序。

`apply(target, source, default_route)` 只接受本机 HTTP OpenAI Chat 聚合源，真实上游 Key 不进入外部配置；写入数据库持久化的本机 gateway 访问 token（当前无到期时间，并非短期令牌）。调用需要 LoliCode 在后台运行。`apply_at(..., fixture_home)` 和 `apply_with_locations(..., Locations)` 用于隔离测试。目标为 `workbuddy`、`deepseek-harness`、`zcode`、`mimocode`。

- WorkBuddy：已有 `~/.workbuddy/models.json` 和 `~/.workbuddy-ai/models.json` 优先。本机 5.3.14 的 `resources/app.asar/main/initialize.js` 中 `getLocalCustomModels` 已只读核验：仅接受顶层数组或对象内的 `models` 数组；其它模型字典拒写，避免成功写入却不生效。保留原有模型及其它属性。写入完整 `/chat/completions` URL。添加后在 WorkBuddy 选择相应模型，不编造未确认的会话选择字段。
- DSH：`DSH_HOME` 或 `~/.dsh/profiles/web/cordis.patch.yml`，在已有 `llm-pi-ai` 序列项的 `config.providers` 中增加自有 `lolicode` 路由。标准 YAML 仅作数据解析，不求值 `!!js`。实际写入局部原文拼接，保留其它插件、动态脚本、注释和路由。动态的 `config` / `providers` 或无法确定的布局会拒写，避免破坏表达式。使用受支持的 `headers.Authorization` 携带本地 token；不写入不受 schema 支持的 `apiKey` 属性。添加后仍保留 DSH 会话原模型选择。
- ZCode：优先读取桌面和 CLI 共用的 `~/.zcode/v2/provider_config.json`，尊重 `ZCODE_DATA_BASE_DIR` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`。已有正式文件时只写 schemaVersion 1 的 Personal 规则：`config.providerConfigRules.providerRules` 内的自有 `providerId=lolicode`，以及 `config.modelConfigRules.providerModelRules` 内对应模型。采用 `access.type=api-key`、`api.type=openai-chat-completions`、`api.baseUrl`，仅保存本机 gateway token。保留其它 provider、智能／手动模型规则及顺序；设置 `defaultModelSelection` 为本次明确选择的默认模型，已有会话保持原选择。思考档位只使用渠道声明的列表，默认优先 medium、其次 high；未声明时只提供不发送思考参数的 `default` 选项。模型窗口、多模态和输出上限沿用真实声明，经官方 Option Maps 输出请求字段。正式文件不存在时沿用旧桌面 `config.json` 与 CLI `config.json` 写法（自有 `provider.lolicode`、`kind=openai-compatible`，CLI `model.main/lite`），不提前创建空 Personal 文件阻断 ZCode 首次迁移用户旧配置。未知正式版本或结构会拒写，不退回旧文件冒充成功。不修改 plugins 或其它 provider。
- MiMo Code：优先 `MIMOCODE_HOME/config`，再 `XDG_CONFIG_HOME/mimocode`，再已经存在的 `~/.config/mimocode`，最后平台缺省目录（Windows 为 `LOCALAPPDATA/mimocode`）。使用 `provider.lolicode` 的 `@ai-sdk/openai-compatible`、`options`、`models` 和顶层 `model`。复用 JsoncDocument 保留 JSONC 注释、MCP 和请求 headers。若同目录同时存在 JSON 与 JSONC，两份配置不猜测覆盖。

第一次写入前保留私有、逐字备份；多文件全部预处理和 stage 后再提交，失败时只回滚本次成功写入且没有被其它程序同时改变的文件。自有片段摘要单独记入私有 `~/.tai-switch/external-model-config/<target>.json`，不把管理标记塞入第三方严格 schema。未接管的同名 provider/model 或用户修改过的自有片段都报冲突，不覆盖用户内容。重复应用无变化不积累备份。同步进程外写入仍可能产生冲突，此时应在目标应用关闭设置页后重试；没有承诺跨进程事务或断电时多文件原子性。

## 官方参考

独立实现适配配置协议，不复制第三方大块源码。

- WorkBuddy 模型配置：https://cloud.tencent.com/document/product/1831/134445 （官方文档，核验 2026-10-17）。字段兼容性以已安装版本实际解析为准；本模块通过脱敏 fixture 验证文件读写与保留语义，未向个人 live 配置写入。
- DSH 官方：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md 以及 `packages/llm/llm-pi-ai/{README.md,src/config.ts}`。MIT。
- ZCode 固定上游：本仓 `third-party/zcode-runtime/upstream/apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-model-config.ts` 与已有第三方声明。
- MiMo Code 官方：https://github.com/XiaomiMiMo/MiMo-Code （MIT）；配置定义 `packages/opencode/src/config/{config.ts,paths.ts}` 以及内置 mimocode-docs 的 reference/config.md。上游路径会随版本调整。

验收命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib external_agent_config`。全部测试使用临时目录与合成 token，不读取或改变真实凭据。DSH 写后对照整棵 YAML 数据树，确认只改变自有 provider，保留 `!!js` 标签与其它值；包含合法冒号前缀 provider 名的回归用例。Windows 逐段拒绝 reparse point，使用实际 `mklink /J` 隔离 fixture 验证不能写入联接目标。

可选的真实 ZCode reader 验收：已有开发用依赖工作区时运行 `node scripts/tests/zcode-personal-config-interop.mjs`；缺少时先运行 `pnpm prepare:zcode-runtime`，这仅是开发验收依赖，不会把 ZCode runtime 加回主 Agent。脚本逐文件核对 reader 所依赖四个包的源码与本仓固定上游 `aac4755666d09fdcd70272fcf063c077a639015f` 一致，把 Rust 实际生成的脱敏 fixture 经 stdin 交给官方 `decodeProviderConfigFile`、`ProviderConfigResolver` 和 `ProviderRegistry`，并检验默认模型可执行、图像／上下文能力及 `reasoning_effort`／`max_tokens` 的实际 Option Maps 输出。临时打包文件完成后清除，不依赖 `release/` 目录或读取用户配置。
