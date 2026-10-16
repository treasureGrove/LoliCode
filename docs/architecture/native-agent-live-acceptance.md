# Native Agent 实际渠道验收

2026-10-17 在 Windows 上使用 `glm-5.3-flash`、`medium` 档位，完成一次真实主 Agent 验收。不是替代运行时或只 mock 模型的检查。

入口是 `src-tauri/examples/lolicode_native_glm_smoke.rs`（需要 `test-hooks` feature）。它只读获取已授权的 GLM 订阅渠道和账户引用，通过生产渠道 gateway 解析认证；项目、会话数据和测试代理均隔离。没有修改用户渠道配置，也不输出、导出或写入实际 token。

## 实际结果

- NativeEngine → 有界本机测试 relay → 生产 channel gateway → GLM 订阅渠道，共 3 次模型请求，每次最大输出 4096 tokens。
- 真实执行 `view_image`、`read_file`、`apply_patch`，均已完成。
- 图片由测试生成：左红、右蓝、底部绿。模型正确识别左右色块并用中文报告。
- 将 `add(a,b)` 的 `a-b` 改为 `a+b`；测试宿主运行 Node 验证 3 个算术断言全部通过。
- 输入 4633、输出 179、合计 4812 tokens；缓存读取 2944，缓存命中率约 63.54%；3/3 请求上报用量。耗时约 15.4 秒。
- 最终会话 `idle`、无错误，临时项目销毁，用户配置未写入。

本机脱敏证据：`release/native-glm-managed-acceptance-20261017.json`。该目录用于验收产物，不保证随仓库提交。

```powershell
C:/Users/admin/.cargo/bin/cargo.exe run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_native_glm_smoke -j2 -- --out D:/projectGithub/TAI-Switch/release/native-glm-managed-acceptance-20261017.json
```

执行会真实消耗当前明确授权的 GLM 订阅。示例仅适用于已有相应 managed channel/account 的本机环境，不会自动换用其它渠道或猜测密钥。

此前用 ZCode 手工配置的订阅 key 对 Coding endpoint 请求得到 401，工具和用量均为零，已保留失败证据 `release/native-glm-acceptance-20261017.json`，没有将这次失败计为通过。成功证据来自生产托管账户解析路径；两次结果不能混淆。

## 跨会话记忆真实验收

同日另跑 `--memory-smoke`，保留上述图片与 JS 验收证据不变。使用全新的临时 NativeEngine 存储及项目，不读取或改变用户实际记忆。

```powershell
C:/Users/admin/.cargo/bin/cargo.exe run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_native_glm_smoke -j2 -- --memory-smoke --out D:/projectGithub/TAI-Switch/release/native-glm-memory-acceptance-20261017.json
```

- 保持默认记忆开关与确认策略，首会话使用 `ask` 权限。模型实际调用 `memory` 的 `add/user`；观察到 `user-once` 权限请求，确认前用户记忆为空，测试仅批准这条合成偏好。工具返回完成，临时 `memory.json` 中保存了内容与来源会话。
- 合成偏好为“用户偏好的演示输出标记是 PINKDOG_MEMORY_47”。另建全新会话，提问不包含标记；真实发出的上下文包含记忆，模型正确只回复 `PINKDOG_MEMORY_47`，没有工具调用。
- 关闭记忆后再建新会话，检查真实 NativeEngine 请求体：不包含该标记、不广告 `memory` 工具。最后一次请求仅由本机离线 SSE 响应器接收，未转发给 GLM；没有用模型是否猜中来判断关闭成功。
- 硬限 3 次真实模型请求、每次最大输出 4096 tokens。实际写入 2 次请求、3601 tokens；新会话读回 1 次请求、1628 tokens，合计 5229 tokens，全部 3 次都上报用量。读回缓存命中约 91.20%；写入及读回分别约 10.7 秒、4.2 秒。

脱敏证据 `release/native-glm-memory-acceptance-20261017.json` 包含实际工具回执、权限回执、新会话回答、用量及每次请求的布尔审计。证据不包含 gateway token 或上游凭据；临时项目与存储在验收结束后清理。这个分支不执行图片和 JS 验收，分别独立记录结论。

## 离线回归

同批次 `lolicode-agent` 全部 100 个测试通过；内置记忆 8 个 Rust 测试、外部模型配置 writer 6 个 fixture 测试通过。前端 `AgentPage` 73、`AgentImage` 8、`AgentPreviewPanel` 7 个测试通过，类型检查通过。前端覆盖运行中切模型/权限、配置请求等待时仍可停止、打断发送及未知接收状态沿用原 requestId 重试。

这些结果验证了上述有界任务和交互，不代表已验证每个第三方客户端的 live 写入、所有 GLM 模型或发布更新链路；外部客户端 writer 只对隔离 fixture 写入。
