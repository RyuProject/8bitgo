#!/usr/bin/env bash
# 生成 PvZ 网页版（中文 / 英文双入口）的资源清单，并提示如何把数据上传到 R2。
#
# 约定（与已部署结构一致）：
#   - 中文入口 PvZ/cn/ 用 R2 上的中文 main.pak（已部署在 properties/main.pak）。
#   - 英文入口 PvZ/en/ 用英文 main.pak，单独放在 properties/en-main.pak。
#   - reanim/ 是动画资源，中英文通用，两份清单共用同一批，只上传一份。
#
# ⚠️ 目标路径 = 页面里的 PVZ_DATA_BASE + 清单里的 r2，不是「/PvZ/ 前缀」这么简单。
#    当前 DATA_BASE = https://html5.8bitgo.com/PvZ/properties/（注意末尾的 properties/），
#    所以 reanim/ 要落在 PvZ/properties/reanim/ 下 —— 早期版本这里写的是 PvZ/reanim/，
#    与页面实际请求差一层，结果 2117 个动画文件全部 404、游戏根本起不来（2026-09-23 事故）。
#    上传完务必跑 `npm run pvz:check-assets` 自检一遍。
#
# 用法：
#   ./scripts/pvz-pack-data.sh <英文 GOTY 资源目录>
#
# 例：
#   ./scripts/pvz-pack-data.sh "$HOME/Downloads/Plants Vs Zombies Game of the Year Edition"
#
# 说明：
#   - 引擎要 FS 根的 /main.pak，以及一批散在文件系统根的资源目录，实测至少包含 /reanim/*
#     （动画 XML + 贴图，main.pak 里没有，缺了会 CppException）。
#   - 加载器按清单逐个 fetch 原始文件，不读 zip，所以这里上传的是散文件。
#   - 换了一版资源后，在页面 url 加 ?nocache=1 强制刷新浏览器缓存。
set -euo pipefail
SRC="${1:-}"
if [ -z "$SRC" ]; then echo "用法: $0 <英文 GOTY资源目录>"; exit 1; fi
if [ ! -f "$SRC/main.pak" ]; then echo "错误: $SRC/main.pak 不存在"; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CN_MANIFEST="$ROOT/public/web/PvZ/cn/pvz-manifest.json"
EN_MANIFEST="$ROOT/public/web/PvZ/en/pvz-manifest.json"

# 中文清单：main.pak 指向 R2 上已部署的中文版（properties/main.pak）
PVZ_MAIN_PAK_R2=properties/main.pak node "$HERE/pvz-web/gen-manifest.mjs" "$SRC" "$CN_MANIFEST"
# 英文清单：main.pak 指向 properties/en-main.pak（英文版，下面单独上传）
PVZ_MAIN_PAK_R2=properties/en-main.pak node "$HERE/pvz-web/gen-manifest.mjs" "$SRC" "$EN_MANIFEST"

echo
echo "清单已写入："
echo "  $CN_MANIFEST  (main.pak -> properties/main.pak，中文)"
echo "  $EN_MANIFEST  (main.pak -> properties/en-main.pak，英文)"
echo
echo "下一步：把以下数据上传到 html5.8bitgo.com（与引擎页同源，无需 CORS）。"
echo "⚠️ 目标路径 = 页面 PVZ_DATA_BASE + 清单 r2；当前 DATA_BASE 是 .../PvZ/properties/："
echo "  - $SRC/main.pak (英文)     ->  PvZ/properties/en-main.pak"
echo "  - $SRC/reanim/ 整个目录     ->  PvZ/properties/reanim/   （中英文共用，只传一份）"
echo "  - 中文 main.pak             ->  PvZ/properties/main.pak  （R2 上已有的那份，别覆盖成英文的）"
echo
echo "清单（$CN_MANIFEST / $EN_MANIFEST）不用上传：页面从主站 8bitgo.com/web/PvZ/<lang>/"
echo "取它，随仓库进 public/web/PvZ/ 并由 npm run build 带进 dist/client 即可。"
echo
echo "上传示例（rclone，bucket 名自取；aws s3 同理）："
echo "  rclone copy \"$SRC/main.pak\"        r2:<bucket>/PvZ/properties/en-main.pak"
echo "  rclone copy \"$SRC/reanim\"          r2:<bucket>/PvZ/properties/reanim"
echo
echo "上传后自检（发 HEAD 抽查，不下载字节）："
echo "  npm run pvz:check-assets              # 两个语言都查"
echo "  npm run pvz:check-assets -- --all     # 全量，慢但准"
