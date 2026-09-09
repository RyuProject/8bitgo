#!/usr/bin/env bash
#
# 8BitGo 源站看门狗 —— 探到故障才重启，平时零打扰
#
#   525 = Cloudflare 边缘 → 源站的 TLS 握手失败，故障点在 **前置代理（443）**，
#   502 = 前置代理连不上 Node，故障点在 **后端（8788）**。
#   所以这个脚本分两层探、坏哪层修哪层，绝不无差别重启。
#
# 用法：
#   ./8bitgo-watchdog.sh            正常跑（给 cron / systemd timer 用）
#   ./8bitgo-watchdog.sh --dry-run  只探不动手，先拿来验证探测结果对不对
#   ./8bitgo-watchdog.sh --status   打印当前探测结果 + 最近状态，然后退出
#
# 配置写在 /etc/8bitgo-watchdog.conf（shell 语法，KEY=value），见同目录 README.md
#
set -uo pipefail

CONF="${CONF:-/etc/8bitgo-watchdog.conf}"
[ -r "$CONF" ] && . "$CONF"

DOMAIN="${DOMAIN:-8bitgo.com}"
TLS_PORT="${TLS_PORT:-443}"
BACKEND_PORT="${BACKEND_PORT:-8788}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"

LOG="${LOG:-/var/log/8bitgo-watchdog.log}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-5242880}"
STATE_DIR="${STATE_DIR:-/var/lib/8bitgo-watchdog}"

FAIL_STREAK="${FAIL_STREAK:-2}"      # 连续 N 次探失败才动手（防单次抖动）
COOLDOWN="${COOLDOWN:-600}"          # 同一层两次重启之间至少隔多少秒
MAX_PER_DAY="${MAX_PER_DAY:-4}"      # 同一层一天最多重启几次，超了只告警不动手
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"

PM2_USER="${PM2_USER:-}"             # pm2 是按用户存的；root 跑 cron 看不到别人的进程列表
PM2_APP="${PM2_APP:-}"               # 留空 = 重启该用户的全部 pm2 进程
BACKEND_UNIT="${BACKEND_UNIT:-}"     # 例如 8bitgo-api.service，留空则自动探
FRONT_UNIT="${FRONT_UNIT:-}"         # 例如 nginx.service，留空则自动探

# ⚠️ 源站开了 Authenticated Origin Pulls（nginx 的 ssl_verify_client on）的话，
#    本机不带客户端证书去探会被拒 → 看门狗会误判成故障、每分钟重启一次 nginx。
#    开了就必须把 CF 那张客户端证书填在这里。
CLIENT_CERT="${CLIENT_CERT:-}"
CLIENT_KEY="${CLIENT_KEY:-}"

DRY_RUN=0
STATUS_ONLY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --status)  STATUS_ONLY=1; DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

# ---------- 基础设施 ----------

mkdir -p "$STATE_DIR" 2>/dev/null
mkdir -p "$(dirname "$LOG")" 2>/dev/null

log() {
  local line
  line="$(date '+%F %T') $*"
  echo "$line"
  # 日志超过阈值就砍掉前半截，不依赖 logrotate
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    tail -c $((LOG_MAX_BYTES / 2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  echo "$line" >> "$LOG" 2>/dev/null
}

# 同一时刻只允许一个实例（重启期间探测必然失败，重入会连环重启）
LOCK="$STATE_DIR/lock"
exec 9>"$LOCK" 2>/dev/null
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { echo "另一个实例还在跑，跳过这一轮"; exit 0; }
fi

# ---------- 探测 ----------

# TLS 层：模拟 Cloudflare 回源。用 --resolve 打到本机，SNI 照真实域名发。
# -k 是**故意**的：Full（非严格）模式下 CF 自己也不验证书，这里要探的是「握手成不成」
# 而不是「证书可不可信」。证书不可信是 526，不是 525。
probe_tls() {
  local args=(-sS -o /dev/null -k --max-time "$PROBE_TIMEOUT"
              --resolve "$DOMAIN:$TLS_PORT:127.0.0.1"
              "https://$DOMAIN:$TLS_PORT/")
  [ -n "$CLIENT_CERT" ] && args+=(--cert "$CLIENT_CERT")
  [ -n "$CLIENT_KEY" ]  && args+=(--key "$CLIENT_KEY")
  local out rc
  out="$(curl "${args[@]}" 2>&1)"; rc=$?
  TLS_DETAIL=""
  case $rc in
    0)  return 0 ;;
    35|58|59|60|77|83) TLS_DETAIL="TLS 握手失败（curl $rc）：$out" ;;   # ← 这一类就是 525 的源头
    7)  TLS_DETAIL="443 拒绝连接（curl 7）——代理没在跑，对应 CF 521" ;;
    28) TLS_DETAIL="443 超时（curl 28）——对应 CF 522" ;;
    52) TLS_DETAIL="握手过了但没回响应（curl 52）" ;;
    *)  TLS_DETAIL="curl 退出码 $rc：$out" ;;
  esac
  return 1
}

# 后端层：Node 自己活着吗。事件循环被顶住的时候这里会超时——这正是要抓的。
probe_backend() {
  local out rc
  out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
        "http://127.0.0.1:$BACKEND_PORT$HEALTH_PATH" 2>&1)"; rc=$?
  BACKEND_DETAIL=""
  if [ $rc -ne 0 ]; then
    BACKEND_DETAIL="健康检查连不上（curl $rc）：$out"
    return 1
  fi
  if [ "$out" != "200" ]; then
    BACKEND_DETAIL="健康检查回了 HTTP $out"
    return 1
  fi
  return 0
}

# 顺带记一笔源站证书的实际情况，下次再出 525 时日志里直接有据可查
cert_note() {
  local txt
  txt="$(echo | timeout "$PROBE_TIMEOUT" openssl s_client -connect "127.0.0.1:$TLS_PORT" \
        -servername "$DOMAIN" 2>/dev/null \
        | openssl x509 -noout -subject -enddate -ext extendedKeyUsage 2>/dev/null \
        | tr '\n' ' ')"
  [ -n "$txt" ] && echo "$txt" || echo "（取不到证书）"
}

# 故障当下的现场快照。525 最常见的原因之一是 **nginx 的连接槽被 SSE 长连接占满**
# （每条代理出去的 SSE 占 2 个槽：客户端一个 + upstream 一个），槽满之后新连接
# 握不上手 —— CF 那边看到的就是 525 而不是 502。事后再查这些数字就已经变了，
# 所以在探测失败的当下抄一份进日志。
load_note() {
  {
    echo "  ── 现场快照 ──"
    echo "  负载/内存：$(uptime | sed 's/.*load/load/') | $(free -m 2>/dev/null | awk '/Mem:/{print "内存 "$3"/"$2" MB"}')"
    echo "  连接数    ：$(ss -s 2>/dev/null | head -2 | tr '\n' ' ')"
    echo "  到 8788   ：$(ss -tnH state established "dport = :$BACKEND_PORT" 2>/dev/null | wc -l) 条已建立"
    echo "  nginx 槽位：worker_processes=$(nginx -T 2>/dev/null | grep -m1 -oP 'worker_processes\s+\K\S+' | tr -d ';') worker_connections=$(nginx -T 2>/dev/null | grep -m1 -oP 'worker_connections\s+\K[0-9]+')"
    echo "  最近 OOM  ：$(journalctl -k --since '-1h' 2>/dev/null | grep -ci 'out of memory') 次（近 1 小时）"
  } | tee -a "$LOG"
}

# ---------- 探服务怎么重启 ----------

have_unit() { systemctl list-unit-files --no-legend "$1" 2>/dev/null | grep -q .; }
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

detect_front() {
  [ -n "$FRONT_UNIT" ] && { echo "$FRONT_UNIT"; return; }
  for u in nginx caddy openresty httpd; do
    if have_unit "$u.service" && unit_active "$u.service"; then echo "$u.service"; return; fi
  done
  echo ""
}

pm2() {
  if [ -n "$PM2_USER" ] && [ "$(id -un)" != "$PM2_USER" ]; then
    su - "$PM2_USER" -c "pm2 $*"
  else
    command pm2 "$@"
  fi
}

detect_backend() {
  # 1) 显式配了 systemd unit
  if [ -n "$BACKEND_UNIT" ]; then echo "systemd:$BACKEND_UNIT"; return; fi
  # 2) pm2（注意按 PM2_USER 切过去看）
  if command -v pm2 >/dev/null 2>&1 || [ -n "$PM2_USER" ]; then
    if pm2 jlist >/dev/null 2>&1; then echo "pm2"; return; fi
  fi
  # 3) 猜一个常见命名的 systemd 服务
  for u in 8bitgo 8bitgo-api 8bitgo-server; do
    if have_unit "$u.service"; then echo "systemd:$u.service"; return; fi
  done
  # 4) 都没有：看谁占着 8788，至少能报出 PID
  local pid
  pid="$( (ss -lptnH "sport = :$BACKEND_PORT" 2>/dev/null || true) | grep -oP 'pid=\K[0-9]+' | head -1)"
  [ -n "$pid" ] && { echo "pid:$pid"; return; }
  echo ""
}

# ---------- 防抖 / 限频 ----------

streak_get() { cat "$STATE_DIR/streak_$1" 2>/dev/null || echo 0; }
streak_set() { echo "$2" > "$STATE_DIR/streak_$1"; }

can_restart() {  # $1 = 层名
  local layer="$1" now last count day
  now=$(date +%s); day=$(date +%F)
  last=$(cat "$STATE_DIR/last_$layer" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$COOLDOWN" ]; then
    log "[$layer] 距上次重启只有 $((now - last))s（冷却 ${COOLDOWN}s），这轮不动手"
    return 1
  fi
  read -r d count < <(cat "$STATE_DIR/count_$layer" 2>/dev/null || echo "$day 0")
  [ "$d" != "$day" ] && count=0
  if [ "$count" -ge "$MAX_PER_DAY" ]; then
    log "[$layer] ⚠️ 今天已经重启 $count 次（上限 $MAX_PER_DAY），停手。这不是抖动，是真故障，去查根因"
    return 1
  fi
  return 0
}

mark_restart() {
  local layer="$1" day count d
  day=$(date +%F)
  read -r d count < <(cat "$STATE_DIR/count_$layer" 2>/dev/null || echo "$day 0")
  [ "$d" != "$day" ] && count=0
  echo "$day $((count + 1))" > "$STATE_DIR/count_$layer"
  date +%s > "$STATE_DIR/last_$layer"
}

# ---------- 动手 ----------

restart_front() {
  local unit; unit="$(detect_front)"
  if [ -z "$unit" ]; then log "[front] 探不到前置代理服务（nginx/caddy 都没在 systemd 里跑），跳过"; return 1; fi
  if [ "$DRY_RUN" = 1 ]; then log "[front] --dry-run：本该重启 $unit"; return 0; fi
  can_restart front || return 1

  # nginx 有配置就先校验：配置写错时 restart 会直接起不来，reload 则会保留旧进程
  if [[ "$unit" == nginx* ]] && command -v nginx >/dev/null 2>&1; then
    if ! nginx -t >/dev/null 2>&1; then
      log "[front] ⚠️ nginx -t 不过，**不敢重启**（重启会彻底起不来）。配置错在："
      nginx -t 2>&1 | sed 's/^/          /' | tee -a "$LOG"
      return 1
    fi
  fi

  log "[front] reload $unit"
  systemctl reload "$unit" 2>&1 | sed 's/^/          /' | tee -a "$LOG"
  sleep 3
  if probe_tls; then
    mark_restart front; log "[front] ✅ reload 后 TLS 恢复"; return 0
  fi
  log "[front] reload 没救回来，改 restart"
  systemctl restart "$unit" 2>&1 | sed 's/^/          /' | tee -a "$LOG"
  mark_restart front
  sleep 5
  probe_tls && { log "[front] ✅ restart 后 TLS 恢复"; return 0; }
  log "[front] ❌ restart 后仍然失败：$TLS_DETAIL"
  return 1
}

restart_backend() {
  local how; how="$(detect_backend)"
  if [ -z "$how" ]; then log "[backend] 探不到 Node 是怎么守着的，跳过（在 conf 里显式配 BACKEND_UNIT 或 PM2_USER）"; return 1; fi
  if [ "$DRY_RUN" = 1 ]; then log "[backend] --dry-run：本该重启（$how）"; return 0; fi
  can_restart backend || return 1

  log "[backend] 重启（$how）"
  case "$how" in
    pm2)        if [ -n "$PM2_APP" ]; then pm2 restart "$PM2_APP"; else pm2 restart all; fi ;;
    systemd:*)  systemctl restart "${how#systemd:}" ;;
    pid:*)      log "[backend] ⚠️ 只找到裸跑进程 PID ${how#pid:}，没有守护进程就没法安全拉起来 —— 先给它配个 systemd 或 pm2"; return 1 ;;
  esac 2>&1 | sed 's/^/          /' | tee -a "$LOG"
  mark_restart backend

  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    probe_backend && { log "[backend] ✅ 起来了（等了 $((i * 3))s）"; return 0; }
  done
  log "[backend] ❌ 30s 内没起来：$BACKEND_DETAIL"
  return 1
}

# ---------- 主流程 ----------

tls_ok=0; be_ok=0
probe_tls    && tls_ok=1
probe_backend && be_ok=1

if [ "$STATUS_ONLY" = 1 ]; then
  echo "域名        : $DOMAIN"
  echo "TLS(:$TLS_PORT)  : $([ $tls_ok = 1 ] && echo 正常 || echo "失败 —— $TLS_DETAIL")"
  echo "后端(:$BACKEND_PORT): $([ $be_ok = 1 ] && echo 正常 || echo "失败 —— $BACKEND_DETAIL")"
  echo "前置代理    : $(detect_front || true)"
  echo "后端守护    : $(detect_backend || true)"
  echo "源站证书    : $(cert_note)"
  echo "连败计数    : tls=$(streak_get tls) backend=$(streak_get backend)"
  exit 0
fi

# 后端先修：TLS 正常但后端挂了是 502，两个都挂时也应该先有后端再谈前置
if [ "$be_ok" = 0 ]; then
  n=$(( $(streak_get backend) + 1 )); streak_set backend "$n"
  log "[backend] 探测失败（连续第 $n 次）：$BACKEND_DETAIL"
  load_note
  if [ "$n" -ge "$FAIL_STREAK" ]; then
    restart_backend && streak_set backend 0
  fi
else
  [ "$(streak_get backend)" != "0" ] && log "[backend] 恢复正常"
  streak_set backend 0
fi

if [ "$tls_ok" = 0 ]; then
  n=$(( $(streak_get tls) + 1 )); streak_set tls "$n"
  log "[tls] 探测失败（连续第 $n 次）：$TLS_DETAIL"
  log "[tls] 当前源站证书：$(cert_note)"
  load_note
  if [ "$n" -ge "$FAIL_STREAK" ]; then
    restart_front && streak_set tls 0
  fi
else
  [ "$(streak_get tls)" != "0" ] && log "[tls] 恢复正常"
  streak_set tls 0
fi

exit 0
