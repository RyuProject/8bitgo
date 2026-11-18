#!/usr/bin/env bash
set -Eeuo pipefail

VERSION=6.0.195
RELEASE=v6.0-r3
ARCHIVE_NAME=SRS-CentOS7-x86_64-6.0-r3.zip
ARCHIVE_MD5=bae979970ce8b84d2ba9130865583fdb
ARCHIVE_SHA256=ecf2bbbbb759b2a77ce6f262854849fdd68f0e5c1b82de92d4283709dddbcc33
ARCHIVE_URL="https://github.com/ossrs/srs/releases/download/${RELEASE}/${ARCHIVE_NAME}"

if [[ "$(id -u)" != 0 ]]; then
  echo "请以 root 运行：sudo bash deploy/live/srs/install-native.sh <服务器公网 IPv4>" >&2
  exit 1
fi

PUBLIC_IP="${1:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "用法：sudo bash deploy/live/srs/install-native.sh <服务器公网 IPv4>" >&2
  exit 2
fi
python3 - "$PUBLIC_IP" <<'PY'
import ipaddress
import sys
ipaddress.IPv4Address(sys.argv[1])
PY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_ENV="${APP_ENV:-$REPO_ROOT/server/.env}"
CONF_DIR=/etc/8bitgo-live-srs
ROOT_DIR=/opt/8bitgo-live-srs
RELEASE_DIR="$ROOT_DIR/releases/$VERSION"
SECRETS_FILE="$CONF_DIR/app-secrets.env"
SRS_ENV_FILE="$CONF_DIR/srs.env"

for command in curl md5sum sha256sum python3 openssl ufw systemctl ss flock; do
  command -v "$command" >/dev/null 2>&1 || { echo "缺少必要命令：$command" >&2; exit 1; }
done
[[ -f "$APP_ENV" ]] || { echo "找不到应用环境文件：$APP_ENV" >&2; exit 1; }
ufw status | grep -q '^Status: active' || { echo "UFW 未启用；为避免绕过现有防火墙策略，停止安装。" >&2; exit 1; }

# 和自动开局巡检 / 正常部署共用同一把锁，防止同时改 .env 并重启服务。
DEPLOY_LOCK_FILE=/run/lock/8bitgo-deploy.lock
exec 8>"$DEPLOY_LOCK_FILE"
flock -w 900 8 || { echo "等待部署锁超时；没有修改应用配置。" >&2; exit 1; }

available_kb="$(df -Pk /opt | awk 'NR == 2 { print $4 }')"
if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < 400000 )); then
  echo "磁盘可用空间不足 400 MiB，停止安装 SRS。" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d /tmp/8bitgo-srs-install.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [[ ! -x "$RELEASE_DIR/objs/srs" ]]; then
  curl --fail --location --retry 2 --connect-timeout 10 --max-time 180 \
    --output "$TEMP_DIR/$ARCHIVE_NAME" "$ARCHIVE_URL"
  printf '%s  %s\n' "$ARCHIVE_MD5" "$TEMP_DIR/$ARCHIVE_NAME" | md5sum --check --status || {
    echo "SRS 官方压缩包 MD5 不匹配，拒绝安装。" >&2
    exit 1
  }
  printf '%s  %s\n' "$ARCHIVE_SHA256" "$TEMP_DIR/$ARCHIVE_NAME" | sha256sum --check --status || {
    echo "SRS 压缩包 SHA-256 与仓库固定值不匹配，拒绝安装。" >&2
    exit 1
  }
  mkdir -p "$TEMP_DIR/release"
  python3 - "$TEMP_DIR/$ARCHIVE_NAME" "$TEMP_DIR/release" <<'PY'
from pathlib import Path, PurePosixPath
from stat import S_ISLNK
from zipfile import ZipFile
import sys

archive = Path(sys.argv[1])
destination = Path(sys.argv[2]).resolve()
prefix = PurePosixPath("SRS-CentOS7-x86_64-6.0-r3/usr/local/srs")
with ZipFile(archive) as package:
    found_binary = False
    for item in package.infolist():
        name = PurePosixPath(item.filename)
        try:
            relative = name.relative_to(prefix)
        except ValueError:
            continue
        if not relative.parts:
            continue
        if name.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
            raise SystemExit("SRS package contains an unsafe path")
        mode = (item.external_attr >> 16) & 0o777
        if S_ISLNK((item.external_attr >> 16) & 0o170000):
            raise SystemExit("SRS package contains an unexpected symlink")
        target = destination.joinpath(*relative.parts)
        if not target.resolve().is_relative_to(destination):
            raise SystemExit("SRS package path escapes installation directory")
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with package.open(item) as source, target.open("wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        target.chmod(mode or 0o644)
        if relative.as_posix() == "objs/srs":
            found_binary = True
    if not found_binary:
        raise SystemExit("official SRS package has no objs/srs binary")
PY
  install -d -m 0755 "$ROOT_DIR/releases"
  mv "$TEMP_DIR/release" "$RELEASE_DIR"
fi

"$RELEASE_DIR/objs/srs" -v >/dev/null
getent group srs >/dev/null || groupadd --system srs
id srs >/dev/null 2>&1 || useradd --system --gid srs --home-dir /var/lib/8bitgo-live-srs --no-create-home --shell /usr/sbin/nologin srs
install -d -o root -g root -m 0755 "$ROOT_DIR/releases" "$CONF_DIR" /usr/local/libexec
install -d -o srs -g srs -m 0750 /var/lib/8bitgo-live-srs
chown -R root:root "$RELEASE_DIR"
chmod 0755 "$RELEASE_DIR/objs/srs"

if [[ ! -f "$SECRETS_FILE" ]]; then
  umask 077
  printf 'LIVE_SRS_TOKEN_SECRET=%s\nLIVE_SRS_HOOK_SECRET=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$SECRETS_FILE"
fi
chmod 0600 "$SECRETS_FILE"
# 该文件由脚本生成且 root 独占写权限，变量值只有 64 位十六进制密钥。
# shellcheck disable=SC1090
. "$SECRETS_FILE"
[[ "${LIVE_SRS_TOKEN_SECRET:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "SRS token secret 格式错误。" >&2; exit 1; }
[[ "${LIVE_SRS_HOOK_SECRET:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "SRS hook secret 格式错误。" >&2; exit 1; }
[[ "$LIVE_SRS_TOKEN_SECRET" != "$LIVE_SRS_HOOK_SECRET" ]] || { echo "SRS 两把密钥不能相同。" >&2; exit 1; }

umask 077
cat > "$SRS_ENV_FILE" <<EOF
SRS_PUBLIC_IP=$PUBLIC_IP
SRS_HOOK_SECRET=$LIVE_SRS_HOOK_SECRET
SRS_HOOK_ORIGIN=127.0.0.1:8788
SRS_HTTP_API_LISTEN=127.0.0.1:1985
EOF
chown root:srs "$SRS_ENV_FILE"
chmod 0640 "$SRS_ENV_FILE"
install -o root -g srs -m 0640 "$SCRIPT_DIR/srs.conf.template" "$CONF_DIR/srs.conf.template"
install -o root -g root -m 0755 "$SCRIPT_DIR/render-native-config.sh" /usr/local/libexec/8bitgo-live-srs-render-config
install -o root -g root -m 0644 "$SCRIPT_DIR/8bitgo-live-srs.service" /etc/systemd/system/8bitgo-live-srs.service

ln -sfn "$RELEASE_DIR" "$ROOT_DIR/current.new"
mv -Tf "$ROOT_DIR/current.new" "$ROOT_DIR/current"

if ! ufw status | grep -Eq '^8000/tcp[[:space:]]'; then
  ufw allow 8000/tcp comment '8BitGo SRS WebRTC'
fi
if ! ufw status | grep -Eq '^8000/udp[[:space:]]'; then
  ufw allow 8000/udp comment '8BitGo SRS WebRTC'
fi

systemctl daemon-reload
systemctl enable 8bitgo-live-srs
# enable --now 不会重启已存在的服务；重装/升级时必须加载刚写入的沙箱策略。
systemctl restart 8bitgo-live-srs || true

healthy=false
for _ in $(seq 1 20); do
  if curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:1985/api/v1/versions > "$TEMP_DIR/versions.json"; then
    if python3 - "$TEMP_DIR/versions.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    data = json.load(source)
version = data.get("data", {}).get("version") or data.get("version")
raise SystemExit(0 if version == "6.0.195" else 1)
PY
    then
      healthy=true
      break
    fi
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  # 启动失败时停止 systemd 重试循环，避免无效进程和日志持续增长。
  systemctl stop 8bitgo-live-srs || true
  systemctl status --no-pager 8bitgo-live-srs >&2 || true
  journalctl -u 8bitgo-live-srs -n 50 --no-pager >&2 || true
  echo "SRS API 未通过本机健康检查，未启用应用的强制 SRS 配置。" >&2
  exit 1
fi
systemctl is-active --quiet 8bitgo-live-srs || { echo "SRS systemd 服务未处于 active 状态。" >&2; exit 1; }

# API 仅应在回环地址；媒体只开放 WebRTC 的 UDP/TCP 8000。
if ! ss -lnt | grep -Eq '127\.0\.0\.1:1985([[:space:]]|$)'; then
  echo "SRS 管理 API 没有绑定到 127.0.0.1:1985，拒绝启用直播。" >&2
  exit 1
fi
if ! ss -lun | grep -Eq '(:|\])8000([[:space:]]|$)'; then
  echo "SRS UDP/8000 没有监听，拒绝启用直播。" >&2
  exit 1
fi
if ! ss -lnt | grep -Eq '(:|\])8000([[:space:]]|$)'; then
  echo "SRS TCP/8000 没有监听，拒绝启用直播。" >&2
  exit 1
fi

BACKUP_DIR=/var/backups/8bitgo
install -d -o root -g root -m 0700 "$BACKUP_DIR"
ENV_BACKUP="$BACKUP_DIR/server.env.before-srs.$(date +%Y%m%d%H%M%S)"
install -o root -g root -m 0600 "$APP_ENV" "$ENV_BACKUP"
export LIVE_SRS_ENABLED=true
export LIVE_SRS_REQUIRED=true
export LIVE_SRS_INTERNAL_API_ORIGIN=http://127.0.0.1:1985
export LIVE_SRS_TOKEN_SECRET LIVE_SRS_HOOK_SECRET
export LIVE_SRS_MAX_VIEWERS=100
export LIVE_SRS_MAX_TOTAL_VIEWERS=50
python3 - "$APP_ENV" <<'PY'
from pathlib import Path
import os
import stat
import sys
import tempfile

path = Path(sys.argv[1])
values = {
    key: os.environ[key]
    for key in (
        "LIVE_SRS_ENABLED",
        "LIVE_SRS_REQUIRED",
        "LIVE_SRS_INTERNAL_API_ORIGIN",
        "LIVE_SRS_TOKEN_SECRET",
        "LIVE_SRS_HOOK_SECRET",
        "LIVE_SRS_MAX_VIEWERS",
        "LIVE_SRS_MAX_TOTAL_VIEWERS",
    )
}
original = path.stat()
lines = path.read_text(encoding="utf-8").splitlines()
written = set()
updated = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else ""
    if key not in values:
        updated.append(line)
    elif key not in written:
        updated.append(f"{key}={values[key]}")
        written.add(key)
for key, value in values.items():
    if key not in written:
        updated.append(f"{key}={value}")
fd, temporary = tempfile.mkstemp(prefix=".server.env.srs.", dir=path.parent, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        target.write("\n".join(updated) + "\n")
    os.chown(temporary, original.st_uid, original.st_gid)
    os.chmod(temporary, stat.S_IMODE(original.st_mode))
    os.replace(temporary, path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY

rollback_app_env() {
  install -o root -g root -m 0600 "$ENV_BACKUP" "$APP_ENV"
  systemctl restart 8bitgo || true
}

if ! systemctl restart 8bitgo; then
  rollback_app_env
  echo "8BitGo 无法重启；已恢复原环境文件并尝试恢复服务。SRS 服务保留运行，便于诊断。" >&2
  exit 1
fi
app_healthy=false
for _ in $(seq 1 30); do
  if curl --connect-timeout 1 --max-time 2 -fsS -o /dev/null http://127.0.0.1:8788/api/health; then
    app_healthy=true
    break
  fi
  sleep 1
done
if [[ "$app_healthy" != true ]]; then
  rollback_app_env
  echo "8BitGo 健康检查失败；已回滚应用环境文件并恢复原服务。SRS 服务保留运行，便于诊断。" >&2
  exit 1
fi

echo "✅ SRS $VERSION 已启动；UDP/TCP 8000 已开放，管理 API 仅监听 127.0.0.1:1985。"
echo "✅ 8BitGo 已强制新直播使用 SRS；SRS 不可用时会拒绝开播，不会退回主播直连。"
