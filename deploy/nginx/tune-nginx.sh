#!/usr/bin/env bash
#
# 抬高 nginx 的连接槽上限。在源站上以 root 跑：sudo ./tune-nginx.sh
#
# 背景（2026-09-09）：源站是 Ubuntu 出厂的 `worker_connections 768`，
# worker_processes auto 解出 2 —— 合计 1536 个槽。而**一条被反代出去的 SSE 占两个槽**
# （面向客户端一个 + 面向 upstream 一个），一次页面加载又开两条 SSE，
# 于是约 384 个并发访客就把槽位吃光。槽满之后 nginx 接得下 TCP 却完不成 TLS 握手，
# Cloudflare 那头报的就是 **525**（不是 502 —— 502 是后端挂了，这里 nginx 自己没资源）。
#
# 这三个值分别在两个不同的上下文里，**都不能靠 conf.d/ 或 sites-enabled/ 的 include 改**
# （那两处 include 都在 http{} 里面），只能直接改 /etc/nginx/nginx.conf 本体。
#
#   worker_processes       main 上下文
#   worker_rlimit_nofile   main 上下文
#   worker_connections     events 上下文
#
# 脚本是幂等的：改过一次再跑不会重复插入。
set -euo pipefail

CONF="${CONF:-/etc/nginx/nginx.conf}"
CONNECTIONS="${CONNECTIONS:-8192}"
NOFILE="${NOFILE:-65535}"

[ "$(id -u)" -eq 0 ] || { echo "要 root：sudo $0"; exit 1; }
[ -r "$CONF" ] || { echo "找不到 $CONF"; exit 1; }

BACKUP="$CONF.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BACKUP"
echo "已备份到 $BACKUP"

restore() {
  echo "❌ 校验没过，回滚到备份"
  cp -a "$BACKUP" "$CONF"
  exit 1
}

# ── worker_connections（events 上下文）──
if grep -qE '^\s*worker_connections\s+[0-9]+\s*;' "$CONF"; then
  sed -i -E "s/^(\s*)worker_connections\s+[0-9]+\s*;/\1worker_connections $CONNECTIONS;/" "$CONF"
  echo "worker_connections → $CONNECTIONS"
else
  echo "⚠️ $CONF 里没有 worker_connections，不敢替你猜位置。"
  echo "   请手动在 events { } 块里加一行：worker_connections $CONNECTIONS;"
  restore
fi

# ── worker_rlimit_nofile（main 上下文）──
# 每条连接要一个 fd，槽位抬上去而 fd 没跟上，就会变成
# 「accept() failed (24: Too many open files)」—— 症状和槽位不够几乎一样。
if grep -qE '^\s*worker_rlimit_nofile\s+[0-9]+\s*;' "$CONF"; then
  sed -i -E "s/^(\s*)worker_rlimit_nofile\s+[0-9]+\s*;/\1worker_rlimit_nofile $NOFILE;/" "$CONF"
  echo "worker_rlimit_nofile → $NOFILE"
elif grep -qE '^\s*worker_processes\s+' "$CONF"; then
  sed -i -E "0,/^(\s*worker_processes\s+.*;)/s//\1\nworker_rlimit_nofile $NOFILE;/" "$CONF"
  echo "worker_rlimit_nofile → $NOFILE（新加在 worker_processes 后面）"
else
  echo "⚠️ 连 worker_processes 都没有，这个 nginx.conf 不像标准布局，跳过 rlimit"
fi

# ── systemd 的硬上限 ──
# nginx 自己 setrlimit 只能抬到**硬上限**为止；systemd 给服务的默认硬上限可能低于
# 我们要的值，那样 worker_rlimit_nofile 会被静默截断。
if [ -d /run/systemd/system ]; then
  mkdir -p /etc/systemd/system/nginx.service.d
  cat > /etc/systemd/system/nginx.service.d/nofile.conf <<EOF
[Service]
LimitNOFILE=$NOFILE
EOF
  systemctl daemon-reload
  echo "systemd LimitNOFILE → $NOFILE"
fi

echo
echo "── 校验 ──"
nginx -t || restore

echo "── 平滑重载（不断现有连接）──"
systemctl reload nginx 2>/dev/null || nginx -s reload

sleep 1
echo
echo "── 现在的值 ──"
nginx -T 2>/dev/null | grep -E "worker_processes|worker_rlimit_nofile|worker_connections" | sed 's/^/  /'
W=$(pgrep -c -f "nginx: worker" || echo '?')
echo "  实际 worker 进程数：$W"
if [ "$W" != "?" ]; then
  echo "  → 连接槽合计约 $((W * CONNECTIONS))，可撑约 $((W * CONNECTIONS / 2)) 条并发反代连接"
fi
echo
echo "✅ 完事。备份留在 $BACKUP，出事就 cp 回去再 nginx -s reload。"
