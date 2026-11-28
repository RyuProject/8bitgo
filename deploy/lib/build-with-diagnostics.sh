# 构建失败时保留完整输出，并把末尾写进发布日志。回滚构建可能发生在远程任务里，
# 如果只发一条「回滚失败」，值班人看不到到底是磁盘、门禁还是编译错误。
BUILD_FAILURE_LOG=""

build_with_diagnostics() {
  local repo_dir="$1"
  local deploy_log="$2"
  local log_dir="$3"
  local capture_file build_rc stamp

  BUILD_FAILURE_LOG=""
  capture_file="$(mktemp "$log_dir/8bitgo-build.XXXXXX")" || {
    printf '%s\n' "无法在 $log_dir 创建构建诊断文件" | tee -a "$deploy_log" >&2
    return 125
  }

  ( cd "$repo_dir" && npm run build ) 2>&1 | tee "$capture_file" >&2
  build_rc="${PIPESTATUS[0]}"
  if [ "$build_rc" -eq 0 ]; then
    rm -f "$capture_file"
    return 0
  fi

  stamp="$(date '+%Y%m%d-%H%M%S')"
  BUILD_FAILURE_LOG="$log_dir/8bitgo-build-failure-${stamp}-$$.log"
  if ! mv "$capture_file" "$BUILD_FAILURE_LOG"; then
    BUILD_FAILURE_LOG="$capture_file"
  fi

  {
    printf '构建失败（退出码 %s），完整输出：%s\n' "$build_rc" "$BUILD_FAILURE_LOG"
    tail -n 40 "$BUILD_FAILURE_LOG"
  } | tee -a "$deploy_log" >&2
  return "$build_rc"
}
