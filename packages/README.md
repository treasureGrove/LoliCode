# 共享包与独立运行时

这里既有 pnpm 工作区包，也有单独构建或运行的集成。成员范围由根目录 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 明确列出。返回[总架构入口](../ARCHITECTURE.md)。

## 平台工作区

- `contracts/`（`@lolicode/platform-contracts`）：共享协议、校验和 SSE 数据。
- `platform-client/`（`@lolicode/platform-client`）：平台客户端接口。
- `platform-host/`（`@lolicode/platform-host`）：平台宿主与存储；入口在 `src/entry.ts`。
- `adapters/opencode/`（`@lolicode/opencode-adapter`）：OpenCode 平台适配器。

依赖从宿主和客户端指向协议包；宿主使用 OpenCode 适配器。各包从 `src/index.ts` 导出接口，编译输出写入各自 `dist/`。在仓库根目录用 `pnpm build:platform` 编译、`pnpm test:platform` 验证。

## 独立集成

- [companion-relay/](companion-relay/README.md)：设备发现、配对和信令的 Node 服务，使用自己的包与启动命令。部署配置见 `deploy/companion/`。
- [lolicode-zcode-runtime/](lolicode-zcode-runtime/README.md)：固定上游源码的运行时构建边界与宿主适配；来源在 `third-party/zcode-runtime/`，准备脚本在 `scripts/build/`。

桌面默认使用 `crates/lolicode-agent/` 内的 Rust 核心。修改平台或独立运行时前，先确认实际使用它的入口和对应 README，避免把独立服务的构建当作桌面构建的一部分。
