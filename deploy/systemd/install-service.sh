#!/usr/bin/env bash
#
# 把裸跑的 Node 后端收进 systemd。在源站上以 root 跑：sudo ./install-service.sh
#
# 为什么要做（2026-09-09 发现）：看门狗的 `--status` 报「后端守护：pid:385543」——
# 这个格式的意思是**既没有 pm2 也没有 systemd unit**，Node 是 nohup / screen 裸跑的。
#
# 后果是那次事故里最关键、也最容易被忽略的一条：**01:39:28 进程死掉之后，没有任何
# 东西会把它拉起来**。站点一直 502 到有人手动去看为止 —— 那次的「npm ci + build 就恢复了」
# 其实就是这个：你手动重启了它。
#
# 装完之后：进程崩了 2 秒内自己起来，开机自启，日志进 journal，
# 看门狗的 detect_backend 也能认出 `8bitgo.service` 从而真的具备修复能力
# （它对裸跑进程是刻意不动手的 —— 没有守护就没法安全拉起来）。
set -euo pipefail

UNIT_NAME="${UNIT_NAME:-8bitgo}"
APP_DIR="${APP_DIR:-/var/www/8bitgo/server}"
HEALTH="${HEALTH:-http://127.0.0.1:8788/api/health}"
NOFILE="${NOFILE:-65535}"

[ "$(id -u)" -eq 0 ] || { echo "要 root：sudo $0"; exit 1; }
[ -f "$APP_DIR/src/index.js" ] || { echo "❌ $APP_DIR/src/index.js 不存在，用 APP_DIR=... 指对路径"; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || { echo "❌ 找不到 node"; exit 1; }

echo "── 先看现在是谁在跑 ──"
OLD_PID="$( (ss -lptnH 'sport = :8788' 2>/dev/null || true) | grep -oP 'pid=\K[0-9]+' | head -1)"
RUN_USER=root
if [ -n "$OLD_PID" ]; then
  RUN_USER="$(ps -o user= -p "$OLD_PID" | tr -d ' ')"
  echo "  PID $OLD_PID  用户 $RUN_USER"
  echo "  命令 $(tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null || echo '?')"
  # 别误杀：确认它确实是 node
  if ! tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null | grep -q node; then
    echo "❌ 占着 8788 的不是 node 进程，停手"; exit 1
  fi
else
  echo "  8788 上没有进程（现在是停着的）"
fi
echo "  node：$NODE_BIN"
echo "  工作目录：$APP_DIR"

# ⚠️ WorkingDirectory 必须是 server/ —— `dotenv/config` 是从 **process.cwd()**
#    找 .env 的，指到别处会静默地一个环境变量都读不到（数据库、Resend、JWT 全废）。
#    而 dist/client 的路径是按模块自身位置算的（ssr.js 用 import.meta.url），不受 cwd 影响。
cat > "/etc/systemd/system/${UNIT_NAME}.service" <<UNIT
[Unit]
Description=8BitGo SSR + API
Documentation=file://$APP_DIR/README.md
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/index.js
Environment=NODE_ENV=production

# 崩了就拉起来 —— 这条就是这次装它的全部理由
Restart=always
RestartSec=2
# 但别无限重启刷屏：5 分钟内起崩 10 次就停下，说明是真故障不是抖动
StartLimitIntervalSec=300
StartLimitBurst=10

# SSE 长连接每条吃一个 fd，和 nginx 那侧一起抬
LimitNOFILE=$NOFILE

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$UNIT_NAME

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "已写入 /etc/systemd/system/${UNIT_NAME}.service"

echo
echo "── 切换（有 2~5 秒 502，nginx 会立刻恢复）──"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
fi
systemctl enable --now "$UNIT_NAME"

echo "── 等它起来 ──"
for i in $(seq 1 20); do
  sleep 1
  if curl -fsS -o /dev/null --max-time 3 "$HEALTH"; then
    echo "✅ ${i}s 后健康检查通过"
    systemctl --no-pager --lines=0 status "$UNIT_NAME" | head -5
    echo
    echo "以后：systemctl restart $UNIT_NAME / journalctl -u $UNIT_NAME -f"
    exit 0
  fi
done

echo "❌ 20 秒还没起来。看日志："
echo "   journalctl -u $UNIT_NAME -n 60 --no-pager"
echo "回退：systemctl disable --now $UNIT_NAME && cd $APP_DIR && nohup node src/index.js &"
exit 1
