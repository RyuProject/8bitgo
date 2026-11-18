#!/usr/bin/env bash
#
# 8BitGo 定时开局巡检：用无头 Chrome 走公网真实路径（默认 https://8bitgo.com，经过 Cloudflare），
# 把一款 NES、一款 CPS1 街机跑到首帧；跑不通就发飞书（server/scripts/notify-lark.mjs）。
#
# 为什么（2026-11-17 全站 EmulatorJS 事故）：所有 EmulatorJS 游戏打不开了几个小时，进程健康检查一直是 200，
# 没有任何人被通知。玩家侧的启动失败聚集报警要等真有人来玩、还要诊断包能报上来；这条巡检不依赖玩家，
# 半夜没人访问也能发现，而且走的是 CDN 后面的真实路径（边缘缓存了坏引擎也能抓到）。
#
# 规则：
#   - 失败（退出码 1）先等 60 秒复核一次，仍失败才报警，排除 CDN / ROM 线路的瞬时抖动；
#   - 持续故障每 SMOKE_WATCH_REMIND_SEC（默认 2 小时）提醒一次；恢复时发一条「已恢复」；
#   - 巡检自己跑不起来（退出码 2：Chrome 没了、脚本出错）每天最多报一次；
#   - 部署进行中跳过（与 deploy/redeploy.sh 共用 /run/lock/8bitgo-deploy.lock）：构建期间 dist 是半新的、
#     重启有几秒 502，那时巡检只会误报；反过来巡检在跑时部署会等它结束，部署脚本也不会在巡检中途被替换。
#
# 安装：见 deploy/smoke-watch/README.md（systemd timer，每 15 分钟）。
set -uo pipefail

REPO_DIR="${REPO_DIR:-/var/www/8bitgo}"
BASE_URL="${SMOKE_WATCH_BASE:-https://8bitgo.com}"
GAMES="${SMOKE_WATCH_GAMES:-super-mario-bros,cadillacs-and-dinosaurs}"
STATE_DIR="${SMOKE_WATCH_STATE_DIR:-/var/lib/8bitgo/smoke-watch}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/run/lock/8bitgo-deploy.lock}"
REMIND_SEC="${SMOKE_WATCH_REMIND_SEC:-7200}"
RECHECK_SEC="${SMOKE_WATCH_RECHECK_SEC:-60}"
LOG="${SMOKE_WATCH_LOG:-/var/log/8bitgo-smoke-watch.log}"
LOG_MAX_BYTES=$((2 * 1024 * 1024))
NOTIFY="$REPO_DIR/server/scripts/notify-lark.mjs"

# systemd 的 PATH 很窄；node 可能在 /usr/local/bin 或 nvm 目录（与 redeploy.sh 同一套探测）
if ! command -v node >/dev/null 2>&1; then
  for c in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /root/.nvm/versions/node/*/bin/node /root/.volta/bin/node; do
    [ -x "$c" ] && { PATH="$(dirname "$c"):$PATH"; break; }
  done
fi

mkdir -p "$STATE_DIR" "$(dirname "$LOG")" 2>/dev/null

log() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    tail -c $((LOG_MAX_BYTES / 2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"
}

notify() {
  command -v node >/dev/null 2>&1 || { log "⚠️ 找不到 node，告警没发出去"; return 0; }
  [ -f "$NOTIFY" ] || { log "⚠️ 找不到 $NOTIFY，告警没发出去"; return 0; }
  node "$NOTIFY" "$@" >> "$LOG" 2>&1 || true
}

command -v node >/dev/null 2>&1 || { log "❌ 找不到 node"; exit 1; }
command -v flock >/dev/null 2>&1 || { log "❌ 找不到 flock"; exit 1; }

exec 9>"$LOCK_FILE" || { log "❌ 打不开锁文件 $LOCK_FILE"; exit 1; }
if ! flock -n 9; then
  log "部署进行中，跳过这一轮"
  exit 0
fi

# 兜底：清掉半小时以前的 Chrome 临时 profile（正常每次都会删；万一某次没删掉也不会越攒越多，系统盘只有 20GB）
find "${TMPDIR:-/tmp}" -maxdepth 1 -name '8bitgo-smoke-*' -mmin +30 -exec rm -rf {} + 2>/dev/null

RUN_OUT="$STATE_DIR/last-run.txt"
run_smoke() {
  # 9>&- ：Chrome 等子进程不继承部署锁，万一有残留进程也不会把下一次部署卡住
  ( cd "$REPO_DIR" && SMOKE_GAMES="$GAMES" node scripts/smoke-start.mjs --base "$BASE_URL" ) > "$RUN_OUT" 2>&1 9>&-
}

run_smoke; rc=$?
if [ "$rc" = "1" ]; then
  log "开局巡检失败，${RECHECK_SEC} 秒后复核：$(grep -m1 '✖' "$RUN_OUT" 2>/dev/null)"
  sleep "$RECHECK_SEC"
  run_smoke; rc=$?
fi

prev="$(cat "$STATE_DIR/status" 2>/dev/null || echo ok)"
detail="$(grep -E '✔|✖|^ {4}' "$RUN_OUT" 2>/dev/null | head -20)"

case "$rc" in
  0)
    echo ok > "$STATE_DIR/status"
    log "通过：$(grep -c '✔' "$RUN_OUT" 2>/dev/null) 款到首帧"
    if [ "$prev" = "down" ]; then
      notify --title "✅ 已恢复：游戏能正常开局了" --text "开局巡检（${BASE_URL}）重新通过：
${detail}"
      notify --clear smoke-down
    fi
    ;;
  1)
    echo down > "$STATE_DIR/status"
    log "❌ 复核仍失败，告警"
    notify --dedupe smoke-down --cooldown "$REMIND_SEC" --title "🔴 开局巡检失败：游戏跑不到首帧" --text "对 ${BASE_URL} 的开局巡检连续两次失败（间隔 ${RECHECK_SEC} 秒），玩家很可能打不开游戏：
${detail}

先看后台「错误诊断」：${BASE_URL%/}/admin/diagnostics
巡检日志：${LOG}；最近一次输出：${RUN_OUT}
故障持续期间每 $((REMIND_SEC / 60)) 分钟提醒一次，恢复后会再发一条。"
    ;;
  *)
    log "⚠️ 巡检没能运行（退出码 ${rc}）：$(tail -3 "$RUN_OUT" 2>/dev/null | tr '\n' ' ')"
    notify --dedupe smoke-env --cooldown 86400 --title "⚠️ 开局巡检没能运行" --text "巡检脚本退出码 ${rc}（Chrome 不见了 / 脚本出错），这段时间没有在自动检查游戏能不能开局：
$(tail -5 "$RUN_OUT" 2>/dev/null)

日志：${LOG}"
    ;;
esac
exit 0
