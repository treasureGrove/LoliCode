#!/usr/bin/env bash
#
# LoliCode 开发容器的一键入口。
#
#   ./docker/dev.sh up          # 构建镜像并启动容器（首次会安装依赖）
#   ./docker/dev.sh shell       # 进入容器（/workspace，dev 用户）
#   ./docker/dev.sh setup       # 安装/更新 npm 依赖 + 预热 cargo 依赖
#   ./docker/dev.sh pnpm dev    # 在容器里跑 pnpm dev（桌面显示在 noVNC）
#   ./docker/dev.sh open        # 用浏览器打开容器里的桌面
#   ./docker/dev.sh down        # 停止容器（保留缓存卷）
#   ./docker/dev.sh reset       # 停止并删除所有缓存卷（慎用）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/compose.yaml"

# 让容器用户与宿主机用户一致
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_UID HOST_GID

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "找不到 docker 命令，请先安装 Docker Desktop。" >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker 守护进程没有运行，请先启动 Docker Desktop。" >&2
    exit 1
  }
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' lolicode-dev 2>/dev/null || echo false)" = "true" ]
}

ensure_running() {
  if ! is_running; then
    echo "容器未运行，正在启动..." >&2
    compose up -d
  fi
}

deps_installed() {
  compose exec -T dev test -f /workspace/node_modules/.modules.yaml >/dev/null 2>&1
}

bootstrap() {
  echo "==> 安装 Node 依赖（pnpm install --frozen-lockfile）"
  compose exec -T dev pnpm install --frozen-lockfile
  echo "==> 预热 Rust 依赖（cargo fetch）"
  compose exec -T dev cargo fetch --manifest-path /workspace/src-tauri/Cargo.toml
  compose exec -T dev cargo fetch --manifest-path /workspace/crates/lolicode-agent/Cargo.toml
}

print_urls() {
  cat <<'EOF'

开发容器已就绪：

  桌面（noVNC）   http://localhost:6080/vnc.html?autoconnect=1&resize=scale
  界面预览        pnpm dev:renderer 之后 http://localhost:3001
  进入容器        ./docker/dev.sh shell
  跑应用          ./docker/dev.sh pnpm dev

EOF
}

cmd_up() {
  require_docker
  compose up -d --build
  # 等容器里的入口脚本完成初始化
  for _ in $(seq 1 60); do
    if compose exec -T dev true >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! deps_installed; then
    bootstrap
  fi
  print_urls
}

cmd_down() {
  require_docker
  compose down
}

cmd_reset() {
  require_docker
  printf '这会删除 node_modules / pnpm store / cargo 缓存卷。继续？[y/N] '
  read -r answer
  case "$answer" in
    y|Y) compose down -v ;;
    *) echo "已取消" ;;
  esac
}

cmd_shell() {
  ensure_running
  if [ "$#" -gt 0 ]; then
    compose exec -T dev "$@"
  else
    compose exec dev bash -l
  fi
}

cmd_setup() {
  ensure_running
  bootstrap
}

cmd_logs() {
  compose logs --tail "${1:-100}"
}

cmd_status() {
  require_docker
  compose ps
  echo
  if is_running; then
    compose exec -T dev bash -lc '
      echo "node    $(node -v)"
      echo "pnpm    $(pnpm -v)"
      echo "rustc   $(rustc -V)"
      echo "cargo   $(cargo -V)"
      echo "webkit  $(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo missing)"
      echo "display $DISPLAY"
    ' || true
  fi
}

cmd_open() {
  url="http://localhost:6080/vnc.html?autoconnect=1&resize=scale"
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url"
  else
    echo "$url"
  fi
}

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    reset) cmd_reset "$@" ;;
    shell|sh|exec) cmd_shell "$@" ;;
    setup) cmd_setup "$@" ;;
    pnpm) ensure_running; compose exec -T dev pnpm "$@" ;;
    cargo) ensure_running; compose exec -T dev cargo "$@" ;;
    node) ensure_running; compose exec -T dev node "$@" ;;
    logs) cmd_logs "$@" ;;
    status|ps) cmd_status "$@" ;;
    open) cmd_open "$@" ;;
    help|-h|--help) usage ;;
    *) echo "未知命令：$command" >&2; echo; usage; exit 1 ;;
  esac
}

main "$@"
