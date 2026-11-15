# shellcheck shell=bash
#
# npm_ci_if_changed <目录>：package-lock.json 和上次成功安装时一样就跳过 npm ci。
#
# 为什么（2026-11-15 系统优化）：redeploy.sh 每天定时跑，绝大多数提交不动依赖，
# 但 npm ci 每次都先删光 node_modules 再从头装（根目录几百 MB），部署因此多花几分钟，
# 4GB 的生产机在这段时间里还和线上进程抢内存 / 磁盘 IO。
#
# 判据是「上次成功 npm ci 时 lock 文件的 sha256」，记在 node_modules/.8bitgo-lock-sha256：
#   - 记在 node_modules 里面：node_modules 被删 / 换机 / 半装失败，戳也跟着没了，下次必然重装；
#   - 只在 npm ci 成功之后才写，失败的安装不会留下「看起来装好了」的戳；
#   - 不看 git 提交差异：人工改 lock、PULL_LATEST=0、回滚之后再部署都能判对。
# 两个仓库都没有 install / postinstall 钩子（2026-11-15 核对过），跳过 npm ci 不会漏掉生成步骤；
# 以后若加了这类钩子，要把它们的产物也纳入判据，或设 FORCE_NPM_CI=1。
#
# FORCE_NPM_CI=1 一律重装（怀疑 node_modules 被手动改坏时用）。

npm_lock_digest() {
  local lock="$1/package-lock.json"
  [ -f "$lock" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$lock" | awk '{print $1}'
  else
    shasum -a 256 "$lock" | awk '{print $1}'
  fi
}

npm_ci_if_changed() {
  local dir="$1" stamp digest
  stamp="$dir/node_modules/.8bitgo-lock-sha256"
  digest="$(npm_lock_digest "$dir")" || digest=""
  if [ "${FORCE_NPM_CI:-0}" != "1" ] && [ -n "$digest" ] && [ -f "$stamp" ] \
     && [ "$(cat "$stamp" 2>/dev/null)" = "$digest" ]; then
    echo "npm ci 跳过：$dir 的 package-lock.json 与上次安装一致"
    return 0
  fi
  ( cd "$dir" && npm ci ) || return 1
  # 只有装成功才写戳；没有 lock 文件（digest 为空）就不写，下次照样重装
  if [ -n "$digest" ]; then
    printf '%s\n' "$digest" > "$stamp" || true
  fi
  return 0
}
