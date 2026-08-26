#!/usr/bin/env bash
# 把 Cloudflare R2 里的 ROM 同步到 ./games，供 cloud-game worker 读取。
#
# R2 的对象 key 约定（与前端 src/services/roms.ts 一致）：<prefix>/<platform>/<slug>.<ext>
# 同步后的目录：./games/<platform 小写>/<slug>.<ext>
#   - cloud-game 用「文件名去掉后缀」作为游戏名，前端 GAME_START 传的就是 slug，二者天然一致
#   - 目录名 = config.template.yaml 里 cores.list 的 key（folder），用来选核心
#   - 除 arcade / dos 外，.zip 会被解开（cloud-game 只让街机 / DOS 核心吃 zip）
#
# 依赖 rclone（https://rclone.org）。先配置一个名为 r2 的 remote：
#   rclone config create r2 s3 provider=Cloudflare access_key_id=... secret_access_key=... \
#     endpoint=https://<account_id>.r2.cloudflarestorage.com acl=private
#
# .env 里：R2_BUCKET=8bitgo   R2_PREFIX=roms   （可选 R2_REMOTE=r2）
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; source .env; set +a; }

REMOTE="${R2_REMOTE:-r2}"
BUCKET="${R2_BUCKET:?.env 里需要 R2_BUCKET}"
PREFIX="${R2_PREFIX:-roms}"
DEST="./games"

# 只同步前端联机支持的平台（与 CLOUD_PLATFORM_CORES 对应）
PLATFORMS=(nes snes gba gb n64 psx arcade dos segaMD)

mkdir -p "$DEST"
for p in "${PLATFORMS[@]}"; do
  lower="$(echo "$p" | tr '[:upper:]' '[:lower:]')"
  echo "==> $p  ->  $DEST/$lower"
  rclone sync "$REMOTE:$BUCKET/$PREFIX/$p" "$DEST/$lower" --create-empty-src-dirs --fast-list --transfers 8 || {
    echo "    （跳过：远端没有 $PREFIX/$p 或同步失败）"; continue; }

  # 非街机 / DOS：把 zip 解开成裸 ROM（保留 slug 作为文件名）
  if [ "$lower" != "arcade" ] && [ "$lower" != "dos" ]; then
    find "$DEST/$lower" -maxdepth 1 -name '*.zip' | while read -r z; do
      slug="$(basename "$z" .zip)"
      inner="$(unzip -Z1 "$z" | grep -v '/$' | head -n1 || true)"
      [ -z "$inner" ] && continue
      ext="${inner##*.}"
      unzip -p "$z" "$inner" > "$DEST/$lower/$slug.$ext"
      rm -f "$z"
      echo "    解压 $slug.zip -> $slug.$ext"
    done
  fi
done

echo "同步完成。worker 开启了 watchMode，会自动发现新 ROM；如未生效可 docker compose restart worker-1 worker-2"
