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

同批次 `lolicode-agent` 全部 100 个测试通过；内置记忆 8 个 Rust 测试、外部模型配置 writer 最终 11 个 fixture 测试通过。全量前端最终 3,072 项、桌面 Rust 3,795 项通过，类型检查通过。前端覆盖运行中切模型/权限、配置请求等待时仍可停止、打断发送及未知接收状态沿用原 requestId 重试。

这些结果验证了上述有界任务和交互，不代表已验证每个第三方客户端的 live 写入、所有 GLM 模型或发布更新链路；外部客户端 writer 只对隔离 fixture 写入。

## 定时与闲时自动化补充调试（2026-10-18）

新增 `--automation-smoke`，继续使用此前明确授权的 GLM 订阅作补充调试；`designatedTestkeyAcceptance=false`，不替代用户本次指定 testkey。先前图片、记忆、标题、工作流和酒馆证据保留，不把多个独立场景合并成一次验收。

```powershell
C:/Users/admin/.cargo/bin/cargo.exe run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_native_glm_smoke -- --automation-smoke --out D:/projectGithub/TAI-Switch/release/acceptance/glm-supplemental-automation.json
```

测试注册临时项目，使用生产自动化创建服务、调度检查、派发和结果监测，运行同一个 NativeEngine 与生产渠道网关。桌面宿主适配器继续负责真实账号解析和工程绑定；隔离适配器只替换宿主环境，未复制另一套调度或回执实现。

- 定时任务选择真实的下一分钟，等待实际时钟到达，不修改保存的 `nextRunAt` 或传入模拟当前时间。3 次真实模型请求完成读取与修复 `sum.js`，Node 对正数、负数、零的结果断言通过；生产运行记录为 succeeded，NativeEngine 命令回执为 completed。
- 闲时任务读取真实 Win32 系统输入闲置时间，满足一分钟阈值后执行，未合成用户输入或绕过检测。1 次模型请求返回检查标记，生产记录和命令回执完成。
- 两个任务都是单次任务。再次运行调度检查无新领取、无新模型调用，只有两条运行记录。用量分别为 4,687 tokens（缓存读取 2,944）与 1,466 tokens（缓存读取 0），零和未知保持不同含义；此处不推断订阅收费金额。

脱敏证据为 `release/acceptance/glm-supplemental-automation.json`，合计 4 次真实模型请求，预算上限 8 次、每次最大输出 4096 tokens。调试中的检查间隔为一秒；未验证桌面 worker 的十五秒周期、真实按钮/IPC、跨进程自动化数据库恢复、全部权限取消路径或 SSH/WSL，相关完整范围仍保持待验收。
