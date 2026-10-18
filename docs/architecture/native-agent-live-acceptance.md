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

## 真实 SSH 与主 Agent 工具宿主（无外部模型）

```powershell
C:/Users/admin/.cargo/bin/cargo.exe run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_remote_agent_acceptance -- --ssh-config-alias tools --out D:/projectGithub/TAI-Switch/release/acceptance/remote-host-real-native-ssh-v2.json
```

此入口必须由操作者明确选择已授权 SSH alias。它真实连接 Linux，只操作 nonce 标记的独立 `/tmp/lolicode-native-remote-*` 工程；本机数据库、占位目录与 NativeEngine 存储都是临时的。生产 `RemoteProjects` 和 `DesktopToolHost` 经同一个 NativeEngine 完成读取、修改、图片、权限和打断链路；远端不部署另一套 Agent。用本机有界 SSE 模型确定工具顺序，5 次本机模型请求、0 次外部模型请求，不使用 GLM 或 testkey。

成功证据包括实际远端 JS 回读、本体累计差异及存储重开保留、真实 PNG 作为视觉输入进入下一次模型请求、仅写入发生一次范围明确的权限确认、本体打断后 `/proc` 确认测试命令停止、断开保留绑定但拒绝执行，以及安全清理成功。初次验收错误要求只读调用也弹权限，修正脚本期望后重验通过；失败证据未覆盖。

`lolicode_remote_transport_acceptance` 另做传输全量回归，`remote-host-transport-regression.json` 验证远端规范根目录被 symlink 重定向时，修改在写入前拒绝，原文件仍保留；其他读写、并发 CAS、超时、取消、断线和图片字节回归仍通过。以上不能替代远程 UI/IPC、预览、工作流与自动化耦合、WSL 或真实模型选择工具；完整功能保持未通过，见[持续验收](continuous-acceptance.md)。


### 远程入口、预览与工作流扩展

同一 lolicode_remote_agent_acceptance 命令现增加连接去重、远端项目工作流 CRUD/CAS/原文保留、生产 workflow_prompt 与运行回执无重放，以及远程 JS/PNG 预览和根目录范围验证。最新独立证据为 release/acceptance/remote-ui-real-ssh.json，passed=true、cleanupConfirmed=true；真实 SSH，5 次本地确定性模型请求，0 次外部提供商请求。远程页面已经接入桌面，预览和本地打开动作按远端身份区分；上述命令没有操作桌面按钮/IPC，也没有触发远程定时/闲时任务或验证真实 WSL，不能据此标记完整 A11 通过。


## 真实 SSH 定时、闲时与取消（无外部提供商）

```powershell
C:/Users/admin/.cargo/bin/cargo.exe run --manifest-path src-tauri/Cargo.toml --features test-hooks --example lolicode_remote_automation_acceptance -- --ssh-config-alias tools --out D:/projectGithub/TAI-Switch/release/acceptance/remote-automation-real-ssh-v3.json
```

此命令真实连接已授权 SSH alias，只写独立 nonce 工程和临时 SQLite/本体目录。实际等待下一分钟计划、读取当前 Windows 输入闲置时间，不修改 nextRunAt 或合成用户输入；生产调度器通过同一个 NativeEngine 的远程工具写入两份标记并回读。第三个远程进程由生产取消入口停止，/proc 确认退出。前台另选本地项目，范围隔离和跨工程取消拒绝均通过；本地确定性模型合计 5 次请求，无外部模型或凭据。

独立子进程重开 SQLite 和本体存储，三条记录与命令为 succeeded/completed、succeeded/completed、stopped/cancelled，不绑定模型网关、不重放。此处是已完成/停止回执的实际重开，未证明应用强杀期间的远程进程回收。首两次揭露的取消文案/哨兵不一致已修正并另存通过记录，原失败保留。详见持续验收记录；指定 testkey、真实桌面按钮、WSL、异常断线与强杀场景保持待验证。
