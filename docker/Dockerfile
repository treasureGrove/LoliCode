# LoliCode 开发容器
#
# 目标：把 LoliCode（Tauri 2 + React + TypeScript + Rust）开发所需的一切都装进镜像，
#       宿主机只需要 Docker，不需要 Node / pnpm / Rust / WebKitGTK。
#
# 关键版本来源（与仓库保持一致）：
#   .node-version          -> 22.12.0
#   package.json           -> packageManager: pnpm@10.12.3
#   rust-toolchain.toml    -> 1.95 (rustfmt, clippy)
#   README.md              -> Tauri Linux 系统依赖

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=10.12.3
ARG RUST_VERSION=1.95
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000

ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/home/dev/.cargo \
    PATH=/home/dev/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-dev \
    GDK_BACKEND=x11 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NO_AT_BRIDGE=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_fund=false \
    npm_config_update_notifier=false

###############################################################################
# 1. 基础工具 + Tauri / WebKitGTK 系统依赖 + 无头桌面（Xvfb / noVNC）
###############################################################################
RUN apt-get update && apt-get install -y --no-install-recommends \
      # 基础工具链
      build-essential pkg-config ca-certificates curl wget git git-lfs \
      file unzip zip xz-utils jq ripgrep fd-find less procps iproute2 \
      sudo vim nano tmux openssh-client \
      # 构建 / 链接工具
      cmake clang lld patchelf \
      # 脚本工具（仓库里的 deploy / scripts 会用到 python）
      python3 python3-pip python3-venv \
      # Tauri / WebKitGTK 编译依赖（见 .github/workflows/ci.yml 的 Linux 步骤）
      libssl-dev libdbus-1-dev libsecret-1-dev \
      libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
      libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
      # X11 / 剪贴板 / 全局快捷键相关
      libxdo-dev libx11-dev libxcb1-dev libxkbcommon-dev \
      libxcursor-dev libxdamage-dev libxrandr-dev libxi-dev libxtst-dev \
      # 无头图形环境：虚拟显示 + VNC + 浏览器访问 + 窗口管理器
      xvfb x11vnc novnc websockify openbox dbus-x11 x11-utils scrot \
      # 软件渲染（llvmpipe），容器里没有 GPU 也能跑 WebKit
      libgl1-mesa-dri libglx-mesa0 libegl1 libgles2 mesa-utils \
      # 中文字体（界面是中文的）+ emoji
      fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
      # keyring（应用用 keyring 保存渠道凭据）
      gnome-keyring libsecret-tools \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

###############################################################################
# 2. 非 root 用户（UID/GID 与宿主机对齐，避免生成 root 拥有的文件）
###############################################################################
RUN groupadd --gid "${USER_GID}" "${USERNAME}" \
    && useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home \
       --shell /bin/bash "${USERNAME}" \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}" \
    && git config --system --add safe.directory /workspace \
    && git config --system core.fileMode false

###############################################################################
# 3. Rust 工具链（版本来自 rust-toolchain.toml），cargo 缓存目录给 dev 用户
###############################################################################
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal \
       --default-toolchain "${RUST_VERSION}" \
       --component rustfmt --component clippy \
    && rm -f /tmp/rustup-init.sh \
    && rustc --version && cargo --version \
    && mkdir -p "${CARGO_HOME}/registry" "${CARGO_HOME}/git" \
    && chown -R "${USERNAME}:${USERNAME}" /home/"${USERNAME}"

###############################################################################
# 4. Node.js + pnpm（版本来自 .node-version / package.json）
###############################################################################
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    node --version; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    pnpm --version

###############################################################################
# 5. 工作区挂载点（这些目录在运行时会变成命名卷，先建好并把属主设为 dev）
###############################################################################
RUN mkdir -p \
      /workspace/node_modules \
      /workspace/packages/contracts/node_modules \
      /workspace/packages/platform-client/node_modules \
      /workspace/packages/platform-host/node_modules \
      /workspace/packages/adapters/opencode/node_modules \
      /workspace/.pnpm-store \
      /workspace/src-tauri/target \
      /workspace/crates/lolicode-agent/target \
      /home/dev/.local/share/pnpm \
      /home/dev/.npm \
    && chown -R "${USERNAME}:${USERNAME}" /workspace /home/"${USERNAME}"/.local /home/"${USERNAME}"/.npm

###############################################################################
# 6. 容器入口：启动 D-Bus / 虚拟显示 / noVNC，然后切换成普通命令
###############################################################################
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY profile/lolicode-dev.sh /etc/profile.d/lolicode-dev.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh /etc/profile.d/lolicode-dev.sh

USER ${USERNAME}
WORKDIR /workspace

# noVNC 默认端口；Vite 3000（正式渠道）/ 3001（开发渠道）
EXPOSE 3000 3001 5900 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
