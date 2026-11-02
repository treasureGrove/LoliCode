#!/usr/bin/env bash
#
# LoliCode 开发容器入口脚本。
#
# 做的事：
#   1. 修正命名卷目录的属主（首次创建时可能是 root）
#   2. 启动会话 D-Bus 与 gnome-keyring（应用保存渠道凭据要 use secret service）
#   3. 启动 Xvfb + openbox + x11vnc + noVNC（START_GUI=1 时）
#   4. exec 传入的命令（默认 sleep infinity，配合 docker compose exec 使用）
#
set -euo pipefail

log() { printf '[lolicode-dev] %s\n' "$*"; }

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/tmp/dbus-dev}"
export SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1680x1050x24}"

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

###############################################################################
# 1. 命名卷目录属主修正（只在目录不可写时做，避免每次启动递归 chown）
###############################################################################
fix_owner() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  [ -w "$dir" ] && return 0
  log "fixing ownership of $dir"
  sudo chown -R "$(id -u):$(id -g)" "$dir" 2>/dev/null || true
}

for dir in \
  /workspace/node_modules \
  /workspace/packages/contracts/node_modules \
  /workspace/packages/platform-client/node_modules \
  /workspace/packages/platform-host/node_modules \
  /workspace/packages/adapters/opencode/node_modules \
  /workspace/.pnpm-store \
  /workspace/src-tauri/target \
  /workspace/crates/lolicode-agent/target \
  "$HOME/.cargo/registry" \
  "$HOME/.cargo/git" \
  "$HOME/.local/share/pnpm" \
  "$HOME/.npm"; do
  fix_owner "$dir"
done

###############################################################################
# 2. D-Bus + keyring
###############################################################################
if [ ! -S /tmp/dbus-dev ]; then
  if dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" >/dev/null 2>&1; then
    log "session bus started"
  else
    log "warning: could not start session bus"
  fi
fi

start_keyring() {
  command -v gnome-keyring-daemon >/dev/null 2>&1 || return 0
  # --unlock 后接空密码：开发容器里常见的免交互用法
  eval "$(printf '' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)" || true
  log "keyring ready"
}

start_keyring

###############################################################################
# 3. 无头桌面（Xvfb + openbox + x11vnc + noVNC）
###############################################################################
is_gui_enabled() { [ "${START_GUI:-1}" != "0" ]; }

wait_for_x() {
  for _ in $(seq 1 100); do
    [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && return 0
    sleep 0.1
  done
  return 1
}

start_gui() {
  if ! wait_for_x; then
    log "starting Xvfb on ${DISPLAY} (${SCREEN_GEOMETRY})"
    Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp -ac \
      >/tmp/xvfb.log 2>&1 &
  fi
  if ! wait_for_x; then
    log "error: Xvfb did not come up; see /tmp/xvfb.log"
    return 0
  fi

  log "starting openbox"
  openbox >/tmp/openbox.log 2>&1 &

  log "starting x11vnc on :5900"
  x11vnc -display "$DISPLAY" -rfbport 5900 -nopw -forever -shared -quiet \
    -noxdamage >/tmp/x11vnc.log 2>&1 &

  log "starting noVNC on :6080"
  websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 \
    >/tmp/novnc.log 2>&1 &

  log "desktop ready -> http://localhost:6080/vnc.html?autoconnect=1&resize=scale"
}

if is_gui_enabled; then
  start_gui
else
  log "START_GUI=0, skip virtual desktop"
fi

###############################################################################
# 4. 交棒给真正的命令
###############################################################################
if [ "$#" -eq 0 ]; then
  set -- sleep infinity
fi

exec "$@"
