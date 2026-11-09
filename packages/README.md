# 运行时与伴随服务

桌面使用 DeepSeek Harness。这里的两个集成分别维护依赖及锁文件，不加入根目录 pnpm 工作区。返回[总架构入口](../ARCHITECTURE.md)。

- [lolicode-harness-runtime/](lolicode-harness-runtime/README.md)：固定官方 Harness npm 发行物、依赖锁和宿主覆盖层。根目录的 `pnpm prepare:harness-runtime --bundle` 准备随桌面分发的运行资源；SDK 测试见该目录 README。
- [companion-relay/](companion-relay/README.md)：设备发现、配对和信令的 Node 服务，使用自己的包与启动命令。部署配置见 `deploy/companion/`。

未接入当前桌面的 OpenCode 平台实验（contracts、platform-client、platform-host、adapters/opencode）以及旧 ZCode 运行时桥接已经移除，原实现可从 Git 历史查阅。ZCode 来源的五个默认内容技能继续保存在 `third-party/zcode/`，由 `scripts/build/prepare-agent-assets.mjs` 校验和打包。

清理前基线为 `7dae5521d76e0d00a503817d669437ee692fae9c`，可在该提交查阅退役实现和对应测试。`deploy/ai-rankings/` 的独立采集服务仍使用其自行准备的 OpenCode CLI，与桌面执行路径分开维护。
