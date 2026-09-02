#!/usr/bin/env bash
#
# 每日搜索引擎推送兜底。装到服务器上用 cron 跑，见同目录 README.md。
#
# 为什么需要它：后台上架游戏时已经会自动推 IndexNow 和百度，但那条路有三种漏法 ——
#   1. 百度当天配额用完（新站常见 10~100 条/天），后面的游戏当场被丢掉；
#   2. 第三方接口抖动，代码只降级记日志，不会重试到成功；
#   3. 队列在内存里，进程重启（部署、崩溃）时未发出的那批就没了。
# 所以每天再按「最近 N 天有变动」补一遍。重复提交同一个 URL 对两家都是允许的。
set -uo pipefail

# 改成你的实际部署路径
APP_DIR="${APP_DIR:-/var/www/8bitgo}"
# 百度补交回溯多少天。要覆盖住「配额用完 → 隔天补」的间隔，3 天很宽裕。
BAIDU_DAYS="${BAIDU_DAYS:-3}"

cd "$APP_DIR/server" || { echo "找不到目录：$APP_DIR/server"; exit 1; }

echo "===== $(date '+%F %T') 百度普通收录补交 ====="
# 不用 set -e：百度失败了 IndexNow 还是该照推。
node scripts/submit-baidu.mjs --days "$BAIDU_DAYS"
baidu_status=$?

echo "===== $(date '+%F %T') IndexNow 补交 ====="
# IndexNow 没有实际配额压力，直接全量重推最省心。
node scripts/submit-indexnow.mjs
indexnow_status=$?

echo "===== 结束：百度 exit=$baidu_status，IndexNow exit=$indexnow_status ====="
# 任一失败就以非零退出，cron 的 MAILTO 才会把这次日志发出来。
[ "$baidu_status" -eq 0 ] && [ "$indexnow_status" -eq 0 ]
