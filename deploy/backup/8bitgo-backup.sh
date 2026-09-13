#!/usr/bin/env bash
#
# 8BitGo 数据库每日备份 → Cloudflare R2
#
# 用法：
#   ./8bitgo-backup.sh              正常跑（给 systemd timer 用）
#   ./8bitgo-backup.sh --dry-run    走完整流程但不上传、不删旧的
#   ./8bitgo-backup.sh --local-only 只在本地留一份，不碰 R2
#
# 配置：默认读 /var/www/8bitgo/server/.env 里的 DB_*，R2 相关见下面 R2_* 那几个变量。
#
# ─────────────────────────────────────────────────────────────
#  这个脚本里每一处「多余」的写法都是在防一种具体的坏备份
# ─────────────────────────────────────────────────────────────
#
# ⚠️ 1. `set -o pipefail` **不能省**。`mysqldump … | gzip > f.gz` 的退出码默认是
#       gzip 的 —— 而 gzip 对着半截输入也会成功退出。没有 pipefail 的话，
#       数据库连不上、权限不够、磁盘满，脚本统统「成功」，你得到一个
#       能解压、内容截断的 .gz，而且它会把昨天那份好的挤掉。
#       **一份没人验过的备份等于没有备份，而且它还骗你说你有。**
#
# ⚠️ 2. `--no-tablespaces`：MySQL 8 的 mysqldump 默认要 **PROCESS** 权限（全局的）。
#       8bitgo 的应用账号是 `GRANT ALL ON eightbitgo.*` + `USAGE ON *.*`，
#       也就是**没有任何全局权限** —— 不加这个参数会直接
#       `Access denied; you need (at least one of) the PROCESS privilege(s)`。
#
# ⚠️ 3. 口令走 `--defaults-extra-file`，不走命令行。`mysqldump -p<密码>` 会让口令
#       出现在 `ps aux` 里，同机任何用户都看得见。
#
# ⚠️ 4. 先验后传。mysqldump 正常结束会在文件末尾写一行 `-- Dump completed`；
#       没有那一行就是中途断了。验不过一律不上传、不轮转 —— 宁可今天没有新备份，
#       也不要用一份坏的覆盖掉好的。
#
# ⚠️ 5. `--single-transaction`：InnoDB 下拿一个一致性快照，**不锁表**。
#       站还在跑，锁表备份会让所有写操作卡住几秒到几十秒。
#
set -euo pipefail

DRY_RUN=0
LOCAL_ONLY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$a" >&2; exit 2 ;;
  esac
done

ENV_FILE="${ENV_FILE:-/var/www/8bitgo/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/8bitgo}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
KEEP_REMOTE_DAYS="${KEEP_REMOTE_DAYS:-30}"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-8bitgo}"
R2_PREFIX="${R2_PREFIX:-backups/db}"
LOG="${LOG:-/var/log/8bitgo-backup.log}"

log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }
die() { log "❌ $*"; exit 1; }

[ -r "$ENV_FILE" ] || die "读不到 $ENV_FILE（用 ENV_FILE=... 指对路径）"

# 只取需要的那几个键，不 source 整个 .env —— 那里面有几十个变量，
# 而且 source 会执行里面任何意外的 shell 语法
envget() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
DB_HOST="$(envget DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(envget DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_USER="$(envget DB_USER)"
DB_PASSWORD="$(envget DB_PASSWORD)"
DB_NAME="$(envget DB_NAME)"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || die "从 $ENV_FILE 里没读出 DB_USER / DB_NAME"

command -v mysqldump >/dev/null || die "没装 mysqldump（apt install mysql-client）"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"
TMP="$OUT.partial"

# 口令文件。⚠️ trap 要在**创建之前**装好，否则中间任何一步失败都会把它留在盘上
CNF="$(mktemp)"
cleanup() { rm -f "$CNF" "$TMP"; }
trap cleanup EXIT
chmod 600 "$CNF"
cat > "$CNF" <<CNFEOF
[client]
user=$DB_USER
password=$DB_PASSWORD
host=$DB_HOST
port=$DB_PORT
CNFEOF

log "开始备份 $DB_NAME @ $DB_HOST:$DB_PORT -> $OUT"

# --defaults-extra-file 必须是 mysqldump 的**第一个**参数，这是它的硬性要求
mysqldump --defaults-extra-file="$CNF" \
  --single-transaction \
  --quick \
  --no-tablespaces \
  --routines --triggers --events \
  --default-character-set=utf8mb4 \
  --databases "$DB_NAME" \
  | gzip -9 > "$TMP"

# ---- 以下全是「验」，验不过就不算成功 ----
[ -s "$TMP" ] || die "dump 是空文件"
gzip -t "$TMP" 2>/dev/null || die "gz 校验不过，文件是坏的"

# mysqldump 正常结束一定会写这一行。没有 = 中途断了（连接掉、权限不够、磁盘满）
if ! gzip -cd "$TMP" | tail -5 | grep -q 'Dump completed'; then
  die "dump 末尾没有 'Dump completed' —— 中途断了，不上传也不轮转"
fi

# 体量哨兵：和上一份比，突然小很多多半是出了事（比如连错了一个空库）
SIZE="$(stat -c %s "$TMP")"
PREV="$(ls -1t "$BACKUP_DIR"/${DB_NAME}-*.sql.gz 2>/dev/null | head -1 || true)"
if [ -n "$PREV" ]; then
  PREV_SIZE="$(stat -c %s "$PREV")"
  if [ "$SIZE" -lt $((PREV_SIZE / 2)) ]; then
    die "新备份 $(numfmt --to=iec "$SIZE") 不到上一份 $(numfmt --to=iec "$PREV_SIZE") 的一半 —— 先人工看一眼，这轮不轮转"
  fi
fi

mv "$TMP" "$OUT"
chmod 600 "$OUT"
log "✅ 本地完成 $(numfmt --to=iec "$SIZE")：$OUT"

if [ "$LOCAL_ONLY" -eq 1 ]; then
  log "--local-only，跳过 R2"
elif ! command -v rclone >/dev/null; then
  log "⚠️  没装 rclone，只留了本地一份。装了之后配 remote：见本目录 README.md"
elif [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run，跳过上传"
else
  DEST="$R2_REMOTE:$R2_BUCKET/$R2_PREFIX"
  rclone copy "$OUT" "$DEST/" --s3-no-check-bucket 2>&1 | sed 's/^/    /' | tee -a "$LOG"
  # ⚠️ 上传完要**回头核对**。rclone copy 成功退出不代表对面那份是完整的，
  #    而「以为传上去了」是备份里最贵的一种错。
  REMOTE_SIZE="$(rclone size "$DEST/$(basename "$OUT")" --json 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
  [ "$REMOTE_SIZE" = "$SIZE" ] || die "上传后大小对不上：本地 $SIZE，R2 $REMOTE_SIZE"
  log "✅ 已上传到 $DEST/$(basename "$OUT")"
fi

# ---- 轮转。⚠️ 只在上面全部成功之后才删，否则可能删掉唯一一份好的 ----
if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run，跳过轮转"
else
  find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime "+$KEEP_LOCAL_DAYS" -print -delete \
    | sed 's/^/    本地删除 /' | tee -a "$LOG" || true
  if [ "$LOCAL_ONLY" -eq 0 ] && command -v rclone >/dev/null; then
    rclone delete "$R2_REMOTE:$R2_BUCKET/$R2_PREFIX/" --min-age "${KEEP_REMOTE_DAYS}d" 2>&1 \
      | sed 's/^/    R2 /' | tee -a "$LOG" || true
  fi
fi

log "备份结束"
