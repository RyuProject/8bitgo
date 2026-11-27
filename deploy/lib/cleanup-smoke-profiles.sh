# Chrome can outlive smoke-start.mjs after an uncatchable exit; remove the profile only after
# its dedicated process group has stopped, otherwise it can keep open files consuming disk.
cleanup_stale_smoke_profiles() {
  local temp_root="${1:-${TMPDIR:-/tmp}}"
  local max_age="${2:-1800}"
  local process_list refreshed profile stale_by_mtime stale_by_process seen_groups age_minutes
  local pid pgid elapsed command still_running

  case "$max_age" in
    ''|*[!0-9]*) max_age=1800 ;;
  esac
  age_minutes=$(( (max_age + 59) / 60 ))

  if ! process_list="$(ps -ww -eo pid=,pgid=,etimes=,args= 2>/dev/null)"; then
    printf '⚠️ 无法读取进程表，跳过冒烟 profile 清理\n' >&2
    return 1
  fi

  for profile in "$temp_root"/8bitgo-smoke-*; do
    [ -d "$profile" ] || continue
    stale_by_mtime=0
    stale_by_process=0
    seen_groups=' '
    if find "$profile" -maxdepth 0 -mmin +"$age_minutes" -print -quit 2>/dev/null | grep -q .; then
      stale_by_mtime=1
    fi

    while read -r pid pgid elapsed command; do
      [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$elapsed" =~ ^[0-9]+$ ]] || continue
      [[ "$command" == *chrome* || "$command" == *chromium* ]] || continue
      [[ " $command " == *" --user-data-dir=$profile "* ]] || continue
      if [ "$stale_by_mtime" = 1 ] || [ "$elapsed" -ge "$max_age" ]; then
        stale_by_process=1
        case "$seen_groups" in
          *" $pgid "*) continue ;;
        esac
        seen_groups="$seen_groups$pgid "
        printf '终止陈旧 Chrome 进程组 %s（profile %s，运行 %ss）\n' "$pgid" "$profile" "$elapsed"
        kill -TERM -- "-$pgid" 2>/dev/null || true
        sleep 1
        kill -0 -- "-$pgid" 2>/dev/null && kill -KILL -- "-$pgid" 2>/dev/null || true
      fi
    done <<< "$process_list"

    if [ "$stale_by_mtime" != 1 ] && [ "$stale_by_process" != 1 ]; then
      continue
    fi

    if ! refreshed="$(ps -ww -eo pid=,pgid=,etimes=,args= 2>/dev/null)"; then
      printf '⚠️ 无法复核 profile 是否仍被 Chrome 使用：%s\n' "$profile" >&2
      continue
    fi
    still_running=0
    while read -r pid pgid elapsed command; do
      [[ "$command" == *chrome* || "$command" == *chromium* ]] || continue
      if [[ " $command " == *" --user-data-dir=$profile "* ]]; then
        still_running=1
        break
      fi
    done <<< "$refreshed"

    if [ "$still_running" = 0 ]; then
      rm -rf -- "$profile"
      printf '已删除陈旧 Chrome profile：%s\n' "$profile"
    else
      printf '⚠️ Chrome 仍在使用 profile，保留目录待下次清理：%s\n' "$profile" >&2
    fi
  done
}
