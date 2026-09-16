#!/usr/bin/env bash
# 把 Cloudflare R2 里的 ROM 同步到 ./games，供 cloud-game worker 读取。
#
# R2 的对象 key 约定（与前端 src/services/roms.ts 一致）：<prefix>/<platform>/<slug>.<ext>
# 同步后的目录：./games/<platform 小写>/<slug>.<ext>
#   - cloud-game 用「文件名去掉后缀」作为游戏名，前端 GAME_START 传的就是 slug，二者天然一致
#   - 目录名 = config.template.yaml 里 cores.list 的 key（folder），用来选核心
#   - 除 arcade / dos 外，.zip 会被解开（cloud-game 只让街机 / DOS 核心吃 zip）
#   - .8bg 先用本站脚本逐块还原；libretro 不认识 8BG，直接同步密文会让云端联机全挂
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
STAGE_ROOT="./.games-sync"

# 只同步前端联机支持的平台（与 CLOUD_PLATFORM_CORES 对应）
PLATFORMS=(nes snes gba gb n64 psx arcade dos segaMD)

mkdir -p "$DEST" "$STAGE_ROOT"
for p in "${PLATFORMS[@]}"; do
  lower="$(echo "$p" | tr '[:upper:]' '[:lower:]')"
  echo "==> $p  ->  $DEST/$lower"
  # 暂存目录必须在 games/ 外：Docker 把整个 games/ 挂进 worker，放在里面仍可能被 watchMode
  # 提前扫到密文或半成品，隔离就失去意义。
  stage="$STAGE_ROOT/$lower"
  rm -rf "$stage"
  mkdir -p "$stage"
  # 先同步到 worker 看不见的暂存目录。若密钥配错，不能让 rclone 先删掉上一份明文 ROM，
  # 再因为 8BG 解不开而把正在运行的云联机库留成空洞。
  rclone sync "$REMOTE:$BUCKET/$PREFIX/$p" "$stage" --create-empty-src-dirs --fast-list --transfers 8 || {
    echo "    （跳过：远端没有 $PREFIX/$p 或同步失败）"; continue; }

  # 新库可以只保留 .8bg；还原到去掉外层扩展名的位置后，下面原有的 ZIP 解包规则照常工作。
  # 用 -print0 保住中文/空格文件名，任何一包解密失败就中止同步，不能把密文交给 worker 凑数。
  while IFS= read -r -d '' packed; do
    plain="${packed%.8bg}"
    node ../../scripts/unpack-rom.mjs "$packed" "$plain"
    rm -f "$packed"
    echo "    还原 $(basename "$packed") -> $(basename "$plain")"
  done < <(find "$stage" -maxdepth 1 -type f -name '*.8bg' -print0)

  # 非街机 / DOS：把 zip 解开成裸 ROM（保留 slug 作为文件名）
  if [ "$lower" != "arcade" ] && [ "$lower" != "dos" ]; then
    find "$stage" -maxdepth 1 -name '*.zip' | while read -r z; do
      slug="$(basename "$z" .zip)"
      inner="$(unzip -Z1 "$z" | grep -v '/$' | head -n1 || true)"
      [ -z "$inner" ] && continue
      ext="${inner##*.}"
      unzip -p "$z" "$inner" > "$stage/$slug.$ext"
      rm -f "$z"
      echo "    解压 $slug.zip -> $slug.$ext"
    done
  fi

  # 全部解密/解压成功才替换正式库；这一步失败时旧目录仍完整可用。
  mkdir -p "$DEST/$lower"
  rclone sync "$stage" "$DEST/$lower" --create-empty-src-dirs --fast-list --transfers 8
  rm -rf "$stage"
done

rm -rf "$STAGE_ROOT"

echo "同步完成。worker 开启了 watchMode，会自动发现新 ROM；如未生效可 docker compose restart worker-1 worker-2"
