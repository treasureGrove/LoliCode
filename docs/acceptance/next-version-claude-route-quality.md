# 下一版：Claude Code 路由的思考强度与输出预算

状态：开发分支修复，尚未打包发布；官网现有 4.0.21 不含本次改动。

## 已确认的问题与修复

1. **模型目录中的小输出窗口限制了所有模型。** 旧配置把全部已选模型的最小输出上限写成 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，使大模型的回答与思考共用较小的预算。现在不再生成这个全局限制；网关在每次 Messages 请求中，只按实际路由模型声明的上限约束输出。切换回大模型后，不沿用小模型上限。用户在请求中设置的更小预算保持不变，未知上限不猜测。
2. **跨协议转换把明确的高强度请求降成 low。** Messages 请求可以带 `output_config.effort=high` 而省略单独的 `thinking`。旧转换将省略理解为关闭思考，转发给 OpenAI Chat / Responses 时变成 low。现在 LoliCode 网关为这种明确指定强度的请求保留转换意图，最终上游收到 high。用户明确发送 `thinking.type=disabled` 时仍沿用关闭语义，不强制开启思考；原生 Anthropic 协议的思考字段不做上述补充。
3. **旧配置清理。** 更新后重新应用 Claude 配置，会移除上一版由 LoliCode 管理、且用户未自行改动的全局输出限制。用户自己的全局限制和思考偏好不盲目清除；原生配置备份仍可恢复。

较小模型使用旧式 `budget_tokens` 时，降低输出上限会相应收紧思考预算，保持 budget 小于输出上限；如果模型窗口小到无法容纳合法思考预算，则明确报错，不静默关闭思考。

这是对已确认配置 / 转发缺陷的修复，不代表已经复现用户所说的所有效果差异。具体渠道、模型、Claude Code 版本和同题对比仍需补充；未对真实上游做质量 A/B 验收。模型别名的客户端能力识别，以及多模型共用进程时的保守上下文窗口策略，也仍需结合实际模型核对，本次没有伪造模型身份或把所有请求强制改成最高强度。

官方参考：[Claude Code 模型与上下文配置](https://code.claude.com/docs/en/model-config)、[Anthropic 思考与 effort 的关系](https://platform.claude.com/docs/en/build-with-claude/thinking)。思考开关和 effort 是不同控制；总输出预算需要容纳思考与回答。

## 自动验证

使用临时本地 HTTP 上游捕获真实出站请求，覆盖 Chat / Responses / Anthropic 三种协议，共 18 次请求：明确 high 但省略 thinking、明确关闭思考、大小模型往返切换、系统指令、工具定义与工具历史、按模型限制输出。同时检查旧版限制移除及原生 Key / 输出偏好恢复。

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4
```

Rust lib 完整回归 3,869 项通过、12 项跳过，结果见本地 `release/acceptance/claude-quality-full-rust.log`；网关专项 16 项通过，日志为 `release/acceptance/claude-quality-gateway.log`。不改真实外部工具配置，不调用付费模型。

## 下次打包后人工检查

- [ ] 重新应用 Claude Code 的 LoliCode 路由配置，重启 Claude Code / 新建会话。
- [ ] 同时配置一个小输出模型和一个大输出模型；选择大模型后不再出现目录最小输出限制。
- [ ] 使用出问题的实际渠道、模型和同一任务，对比原生直连与 LoliCode 路由，记录 Claude Code 版本及 `/model`、`/effort` 状态。
- [ ] 请求明确为 high 时，跨协议上游收到 high；明确关闭思考时不被自动重新开启。
- [ ] 连续调用读写文件等工具，系统指令与工具结果保持完整。
- [ ] 切回原生配置后，原有 Key / 登录与用户自己的输出偏好恢复。
