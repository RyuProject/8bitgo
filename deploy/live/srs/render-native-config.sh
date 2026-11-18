#!/usr/bin/env bash
set -Eeuo pipefail

: "${SRS_PUBLIC_IP:?SRS_PUBLIC_IP is required}"
: "${SRS_HOOK_SECRET:?SRS_HOOK_SECRET is required}"
: "${SRS_HOOK_ORIGIN:?SRS_HOOK_ORIGIN is required}"
: "${SRS_HTTP_API_LISTEN:?SRS_HTTP_API_LISTEN is required}"

python3 - "$SRS_PUBLIC_IP" "$SRS_HOOK_SECRET" "$SRS_HOOK_ORIGIN" "$SRS_HTTP_API_LISTEN" <<'PY'
import ipaddress
import re
import sys

ipaddress.IPv4Address(sys.argv[1])
if not re.fullmatch(r"[a-f0-9]{64}", sys.argv[2]):
    raise SystemExit("SRS_HOOK_SECRET must be 64 lowercase hex characters")
if sys.argv[3] != "127.0.0.1:8788":
    raise SystemExit("native SRS hook must stay on the local 8BitGo API")
if sys.argv[4] != "127.0.0.1:1985":
    raise SystemExit("native SRS management API must stay on loopback")
PY

template=/etc/8bitgo-live-srs/srs.conf.template
target=/run/8bitgo-live-srs/srs.conf
temporary="${target}.tmp"
test -r "$template"

# 密钥只允许 hex，地址只允许 IPv4 / 固定回环端口，替换值不会被 sed 当成表达式。
sed \
  -e "s|__SRS_PUBLIC_IP__|$SRS_PUBLIC_IP|g" \
  -e "s|__SRS_HOOK_SECRET__|$SRS_HOOK_SECRET|g" \
  -e "s|__SRS_HOOK_ORIGIN__|$SRS_HOOK_ORIGIN|g" \
  -e "s|__SRS_HTTP_API_LISTEN__|$SRS_HTTP_API_LISTEN|g" \
  "$template" > "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$target"
