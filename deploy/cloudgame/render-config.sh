#!/usr/bin/env bash
# 由 config.template.yaml + .env 生成 config.yaml（docker-compose 会把它挂进容器）
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "先 cp .env.example .env 并填写 PUBLIC_IP / TURN_SECRET"; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${PUBLIC_IP:?.env 里需要 PUBLIC_IP}"
: "${TURN_SECRET:?.env 里需要 TURN_SECRET}"

sed -e "s|__PUBLIC_IP__|${PUBLIC_IP}|g" -e "s|__TURN_SECRET__|${TURN_SECRET}|g" config.template.yaml > config.yaml
echo "已生成 config.yaml（PUBLIC_IP=${PUBLIC_IP}）"
