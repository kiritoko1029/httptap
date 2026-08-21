#!/usr/bin/env bash
# HTTP Interceptor 一键启动/停止
#
# 用法（推荐 source，这样代理环境变量直接生效在当前终端）:
#   source ./proxy.sh on    启动服务 + 设置代理环境变量 + 打开 Web 界面
#   source ./proxy.sh off   停止服务 + 清除环境变量，恢复网络
#
# 也可以直接执行（./proxy.sh on），服务照常启动，但环境变量不会带进当前终端。

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROXY_PORT="${PROXY_PORT:-8888}"
UI_PORT="${UI_PORT:-8880}"
PID_FILE="$DIR/.proxy.pid"
LOG_FILE="$DIR/proxy.log"
CA_FILE="$DIR/.http-mitm-proxy/certs/ca.pem"
SOURCED=0
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && SOURCED=1

is_running() {
  lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

cmd_on() {
  if is_running; then
    echo "服务已在运行（代理 127.0.0.1:${PROXY_PORT}，界面 http://127.0.0.1:${UI_PORT}）"
  else
    nohup node "$DIR/index.js" --proxy-port "$PROXY_PORT" --ui-port "$UI_PORT" >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 20); do
      curl -s -o /dev/null "http://127.0.0.1:$UI_PORT/api/config" && break
      sleep 0.3
    done
    if is_running; then
      echo "已启动: 代理 127.0.0.1:${PROXY_PORT}，界面 http://127.0.0.1:${UI_PORT}（日志 ${LOG_FILE}）"
    else
      echo "启动失败，查看日志: $LOG_FILE"
      return 1
    fi
  fi

  if [[ "$SOURCED" == 1 ]]; then
    export http_proxy="http://127.0.0.1:$PROXY_PORT"
    export https_proxy="http://127.0.0.1:$PROXY_PORT"
    export no_proxy="127.0.0.1,localhost"
    [[ -f "$CA_FILE" ]] && export NODE_EXTRA_CA_CERTS="$CA_FILE"
    echo "代理环境变量已设置（用完执行 source ./proxy.sh off 恢复）"
  else
    echo "提示: 用 source 运行可同时设置代理环境变量:  source ./proxy.sh on"
  fi

  open "http://127.0.0.1:$UI_PORT" 2>/dev/null || true
}

cmd_off() {
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY NODE_EXTRA_CA_CERTS

  local killed=0
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null && killed=1
    rm -f "$PID_FILE"
  fi
  # 兜底：按端口找进程
  local pids
  pids=$(lsof -nP -tiTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null && killed=1
  fi

  [[ "$killed" == 1 ]] && echo "服务已停止" || echo "服务未在运行"
  echo "代理环境变量已清除，网络恢复正常"
}

case "${1:-on}" in
  on|start)  cmd_on ;;
  off|stop)  cmd_off ;;
  *) echo "用法: source $0 [on|off]" ;;
esac
