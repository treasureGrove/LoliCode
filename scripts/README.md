# 工程脚本

脚本按用途分组，从仓库根目录执行。日常开发优先使用根目录 `package.json` 提供的 `pnpm` 命令。返回[总架构入口](../ARCHITECTURE.md)。

- `dev/`：开发版启动、构建快照与本机入口注册；`pnpm dev`、`pnpm build:dev` 的实现。
- `build/`：Agent 与运行时资源准备、便携包、资源包、图标及 Vite/PostCSS 构建辅助。
- `release/`：产品版本、下载清单、安装包验证、签名更新清单与发布工具。发布流程见[发布指南](../docs/guides/lolicode-release.md)。
- `data/`：模型榜单更新、渠道预设导出等数据维护。
- `tests/`：脚本回归测试与独立 smoke/基准验证；运行前查看具体脚本所需资源与环境。

例如：

```sh
pnpm dev
pnpm build:renderer
pnpm prepare:agent-assets
node --test scripts/tests/lolicode-development.test.mjs
```

新增脚本按用途放入对应目录；会被多个脚本使用的路径从脚本所在位置解析，不依赖调用者恰好处于哪个工作目录。移动脚本时同步导入、根目录定位、`package.json`、CI 与文档中的直接调用。

日志和临时验证结果放进已忽略的 `tmp/`，构建输出放入约定的 `dist/`、`release/` 或 Rust `target/`。
