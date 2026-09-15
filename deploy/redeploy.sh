#!/usr/bin/env bash
#
# 8BitGo 一键重部署（给 systemd timer 或人工调用）：
#   备份 → 拉取最新 → 安装依赖 → CI 卡点 → 构建 → 迁移 → 重启 → 健康检查 → 失败回滚
#
# 为什么是这个顺序（见下面的「顺序铁律」）：
#   - 备份必须在**任何改动之前**：仓库 / 迁移 / 构建哪一步炸了，手里有改动前的库快照可回。
#   - 重启的是 systemd 服务（8bitgo），不是整机 reboot；整机重启没必要，而且把 DB 连接池、
#     缓存、JIT 全部摔一遍，启动更慢。
#   - CI 卡点（lint + 类型检查）不过就不构建不重启，避免把明显坏的提交带上线。
#   - 健康检查失败自动回滚到上一个 git 提交并重新构建。⚠️ 数据库迁移**不会**自动回滚，
#     所以带「破坏性迁移」的提交请用维护窗口手动上，别指望这个脚本兜底。
#
# 定时（systemd timer）默认每天 04:15 跑一次 —— 不是 00:00。原因：
#   对中文用户为主的站点，00:00 北京时间是夜猫子活跃期，还和日期切换/缓存刷新叠在一起；
#   而重启有 2~5s 的 502。低峰通常在 04:00~05:00。
#   想改回 00:00：把 timer 里的 OnCalendar 改成 *-*-* 00:00:00 即可。
#
# 两个开关（环境变量，timer 里可设）：
#   PULL_LATEST=1  拉取最新并部署（默认）；=0 只做「重启 + 备份」，当纯安全网用
#   RUN_TESTS=1    CI 卡点额外跑 npm test（需要可用的测试库），默认关
set -uo pipefail

# ───────────── 可调参数（环境变量覆盖）─────────────
REPO_DIR="${REPO_DIR:-/var/www/8bitgo}"
SERVER_DIR="${SERVER_DIR:-$REPO_DIR/server}"
UNIT="${UNIT:-8bitgo}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8788/api/health}"
PS2_CHECK_URL="${PS2_CHECK_URL:-http://127.0.0.1:8788/play/ps2/__deploy_check__}"
PLAY_JS_CHECK_URL="${PLAY_JS_CHECK_URL:-http://127.0.0.1:8788/play/Play.js}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$REPO_DIR/deploy/backup/8bitgo-backup.sh}"
LOG_DIR="${LOG_DIR:-/var/log}"
LOG="$LOG_DIR/8bitgo-redeploy.log"
BRANCH="${BRANCH:-$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
PULL_LATEST="${PULL_LATEST:-1}"
RUN_TESTS="${RUN_TESTS:-0}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"   # 重启后最多轮询 30 次，每次 2s

log()  { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }
die()  { log "❌ $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "要 root：sudo -E ./redeploy.sh"
[ -d "$REPO_DIR/.git" ] || die "不是 git 仓库：$REPO_DIR"
[ -x "$BACKUP_SCRIPT" ] || die "备份脚本不在/不可执行：$BACKUP_SCRIPT"
command -v systemctl >/dev/null || die "没有 systemctl"
command -v curl >/dev/null || die "没有 curl"
command -v git >/dev/null || die "没有 git"
mkdir -p "$LOG_DIR"

# ───────────── 把 node/npm 塞进 PATH ─────────────
# systemd 的 oneshot service 默认 PATH 很窄，Node 若是 nvm/volta 装的就找不到。
# 沿用 install-service.sh 的探测顺序，找到后把它的目录加进 PATH。
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in /usr/local/bin/node /usr/bin/node /opt/node/bin/node \
           /root/.nvm/versions/node/*/bin/node /home/*/.nvm/versions/node/*/bin/node \
           /root/.volta/bin/node /usr/local/n/versions/node/*/bin/node; do
    [ -x "$c" ] && { NODE_BIN="$c"; break; }
  done
fi
[ -n "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"
command -v node >/dev/null || die "找不到 node，用 NODE_BIN=/绝对路径/node 指定"

# ───────────── 记录起点，供回滚 ─────────────
cd "$REPO_DIR"
BEFORE_COMMIT="$(git rev-parse HEAD)"
log "当前提交 ${BEFORE_COMMIT}（分支 ${BRANCH}）"

# ── 1. 先备份（改动之前）──
log "── 步骤 1/7  数据库备份 → R2 ──"
"$BACKUP_SCRIPT" || die "备份失败，整个流程中止（不动线上）"

# ── 2. 拉取最新 ──
if [ "$PULL_LATEST" = "1" ]; then
  log "── 步骤 2/7  拉取最新代码 ──"
  # reset --hard 到远端，避免本地脏改动 / 合并冲突卡死自动部署
  git fetch --quiet origin "$BRANCH" || die "git fetch 失败"
  git reset --hard "origin/$BRANCH" || die "git reset 失败"
  log "已更新到 $(git rev-parse --short HEAD)"
else
  log "── 步骤 2/7  跳过拉取（PULL_LATEST=0）──"
fi

# ── 3. 安装依赖（根 + server 两套；API 跑的是 server/src 源码）──
log "── 步骤 3/7  安装依赖（npm ci）──"
( cd "$REPO_DIR"  && npm ci ) || die "根 npm ci 失败"
( cd "$SERVER_DIR" && npm ci ) || die "server npm ci 失败"

# ── 4. CI 卡点：lint + 类型检查（不碰库、秒级）──
log "── 步骤 4/7  CI 卡点：oxlint + tsc ──"
( cd "$REPO_DIR" && npm run lint ) || die "oxlint 不过，停下"
( cd "$REPO_DIR" && npx tsc -b ) || die "tsc 不过，停下"
if [ "$RUN_TESTS" = "1" ]; then
  ( cd "$REPO_DIR" && npm test ) || die "npm test 不过，停下"
fi

# ── 5. 构建 ──
log "── 步骤 5/7  构建（client + server 包）──"
( cd "$REPO_DIR" && npm run build ) || die "构建失败"

# ── 6. 迁移 ──
log "── 步骤 6/7  数据库迁移 ──"
( cd "$SERVER_DIR" && npm run migrate ) || die "迁移失败"

# ── 7. 重启 + 健康检查 ──
log "── 步骤 7/7  重启 $UNIT + 健康检查 ──"
systemctl restart "$UNIT" || die "systemctl restart 失败"
if health_ok && ps2_headers_ok; then
  log "✅ 部署完成：$(git rev-parse --short HEAD)"
  exit 0
fi
log "⚠️ 健康检查或 PS2 隔离响应头未通过，回滚到 ${BEFORE_COMMIT}"
rollback
log "❌ 部署失败且回滚后仍不健康，请立即人工处理"
exit 1

health_ok() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

ps2_headers_ok() {
  local page_headers play_headers
  # 404 的测试 slug 也必须带隔离头；只测已发布游戏会受数据库内容变化影响。
  page_headers="$(curl -sSI --max-time 5 "$PS2_CHECK_URL")" || return 1
  play_headers="$(curl -sSI --max-time 5 "$PLAY_JS_CHECK_URL")" || return 1
  # 前端构建成功而后端没重启时，健康接口照样 200；这两项能抓出新旧版本错配。
  printf '%s\n' "$page_headers" | grep -qi '^cross-origin-opener-policy: same-origin' || return 1
  printf '%s\n' "$page_headers" | grep -qi '^cross-origin-embedder-policy: require-corp' || return 1
  printf '%s\n' "$play_headers" | grep -qi '^cross-origin-embedder-policy: require-corp' || return 1
  return 0
}

rollback() {
  log "回滚：恢复 ${BEFORE_COMMIT} 并重新构建"
  # 注意：npm ci 已经在上面按「新提交」装过了，这里直接 checkout 旧提交 + 重建。
  # 若两个提交的依赖不同，旧源码可能和当前 node_modules 不完全匹配；
  # 真遇到这种情况，回滚后手动在 server/ 和根目录各跑一次 npm ci 即可。
  git checkout --quiet "$BEFORE_COMMIT" || { log "⚠️ git checkout 失败，需人工介入"; return; }
  ( cd "$REPO_DIR"  && npm run build ) || { log "⚠️ 回滚构建失败，需人工介入"; return; }
  ( cd "$SERVER_DIR" && npm run migrate ) || log "⚠️ 回滚迁移失败（破坏性迁移无法自动还原）"
  systemctl restart "$UNIT" || { log "⚠️ 回滚重启失败，需人工介入"; return; }
  if health_ok; then
    log "✅ 已回滚到 ${BEFORE_COMMIT}"
  else
    log "❌ 回滚后仍不健康"
  fi
}
