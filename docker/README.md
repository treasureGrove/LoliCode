# LoliCode Docker 开发环境

这个目录把 LoliCode 开发所需的全部工具链放进一个 Docker 镜像里：

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Ubuntu | 24.04 | 基础镜像 |
| Node.js | 22.12.0 | `.node-version` |
| pnpm | 10.12.3 | `package.json` 的 `packageManager` |
| Rust | 1.95（含 rustfmt / clippy） | `rust-toolchain.toml` |
| Tauri 依赖 | WebKitGTK 4.1、gtk3、libsoup3、appindicator、patchelf 等 | `README.md` / CI |
| 图形环境 | Xvfb + openbox + x11vnc + noVNC | 容器内虚拟桌面 |

宿主机只需要 Docker Desktop，**不需要**再装 Node、pnpm、Rust 或 WebKitGTK。

## 目录结构

```
docker/
  Dockerfile          # 镜像定义（工具链 + 系统依赖 + 虚拟桌面）
  compose.yaml        # 服务、端口、卷
  entrypoint.sh       # 启动 D-Bus / keyring / 虚拟桌面后交棒
  dev.sh              # 日常使用的封装命令
  profile/            # 容器内登录 shell 的环境变量
.devcontainer/
  devcontainer.json   # VS Code / Cursor “Reopen in Container”
```

## 首次使用

```sh
# 1. 构建镜像并启动容器（第一次 10~20 分钟，主要花在 apt 和 Rust 工具链）
./docker/dev.sh up

# 2. 打开容器里的桌面：http://localhost:6080/vnc.html?autoconnect=1&resize=scale
./docker/dev.sh open
```

`up` 会自动执行 `pnpm install --frozen-lockfile` 和 `cargo fetch` 预热依赖；之后每次启动都是秒级。

## 日常开发

```sh
# 进入容器（/workspace，dev 用户，和宿主机 UID 对齐）
./docker/dev.sh shell

# 在容器里跑开发模式：Vite 热更新 + Rust 改动自动重启
./docker/dev.sh pnpm dev

# 其它常用命令
./docker/dev.sh pnpm typecheck
./docker/dev.sh pnpm test:unit
./docker/dev.sh pnpm build:renderer
./docker/dev.sh cargo test --manifest-path crates/lolicode-agent/Cargo.toml
./docker/dev.sh cargo test --manifest-path src-tauri/Cargo.toml --lib

# 停止 / 查看状态
./docker/dev.sh down
./docker/dev.sh status
```

`pnpm dev` 启动的窗口会出现在 noVNC 桌面里（1680×1050）。前端改动即时热更新；Rust 改动会自动重编并重启应用。

> 首次 `pnpm dev` 需要编译整个 Tauri 依赖树，8 核机器上大约 10~15 分钟，编译结果存在 `tauri-target` 卷里，后续只做增量编译。

## 端口

| 端口 | 用途 |
| --- | --- |
| 6080 | noVNC（浏览器里的桌面） |
| 5900 | 原生 VNC（可选，用任意 VNC 客户端） |
| 3001 | Vite 开发渠道界面（`pnpm dev` 使用） |
| 3000 | Vite 正式渠道界面（`pnpm dev:renderer`） |

端口都只绑定在 `127.0.0.1`，不会暴露到局域网。

## 数据放在哪

源码直接用绑定挂载（`..:/workspace`），所以在宿主机上用你习惯的编辑器改代码即可，改动即时可见。

体积大、文件碎的构建产物放在 Docker 命名卷里，避免 macOS 绑定挂载的 I/O 瓶颈：

| 卷 | 挂载点 |
| --- | --- |
| `lolicode-dev_node-modules` 等 | 各 `node_modules` |
| `lolicode-dev_pnpm-store` | `.pnpm-store` |
| `lolicode-dev_tauri-target` | `src-tauri/target` |
| `lolicode-dev_agent-target` | `crates/lolicode-agent/target` |
| `lolicode-dev_cargo-registry` / `cargo-git` | `~/.cargo/registry` / `~/.cargo/git` |

清空全部缓存（会重新下载依赖、重新编译）：

```sh
./docker/dev.sh reset
```

## 用 VS Code / Cursor

在宿主机打开仓库，执行 **Dev Containers: Reopen in Container**，会复用同一份 `docker/compose.yaml`，工作目录是 `/workspace`，并且自动跑 `pnpm install`。

## 容器里有什么

- `node` / `pnpm` / `corepack`、`rustc` / `cargo` / `rustfmt` / `clippy`
- `git`（已配置 `safe.directory=/workspace`）、`jq`、`rg`、`fd`、`tmux`、`vim`
- Python 3 + pip（`scripts/`、`deploy/` 里的脚本会用到）
- `scrot` / `x11-utils`：在无头桌面里截图调试
- `gnome-keyring`：应用保存渠道凭据需要 secret service，容器启动时会用空密码解锁

## 常见问题

**Q：`pnpm dev` 打不开窗口？**
先确认 noVNC 能打开（`./docker/dev.sh open`），再在容器里检查 `echo $DISPLAY` 应为 `:99`，`/tmp/xvfb.log` 和 `/tmp/openbox.log` 有错误时可以直接看。

**Q：WebKit 白屏 / 崩溃？**
镜像已默认设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1`、`WEBKIT_DISABLE_DMABUF_RENDERER=1`、`LIBGL_ALWAYS_SOFTWARE=1`（容器里没有 GPU）。如果仍异常，`./docker/dev.sh logs` 查看容器日志。

**Q：容器里生成的文件属主不对？**
`dev.sh` 会把宿主机 UID/GID 作为构建参数传进去，正常情况下文件属主与宿主机一致。改过 UID 后需要 `docker compose build` 重建镜像。

**Q：能构建 macOS / Windows 安装包吗？**
不能。Docker 里是 Linux 容器，只能构建 Linux 产物；macOS / Windows 打包仍需在对应系统上按 `.github/workflows` 的方式做。

**Q：想在 macOS 上用原生窗口而不是浏览器？**
启动容器时加 `START_GUI=0`，安装 XQuartz 后 `DISPLAY=host.docker.internal:0 ./docker/dev.sh shell` 再跑 `pnpm dev` 即可。
