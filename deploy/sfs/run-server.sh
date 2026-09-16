#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${RUNTIME_DIRECTORY:-/run/8bitgo-sfs}"
stdin_pipe="${runtime_dir}/stdin"
install -d -m 700 "${runtime_dir}"
rm -f "${stdin_pipe}"
mkfifo -m 600 "${stdin_pipe}"

# 上游启动器会持续读 stdin；systemd 默认给 /dev/null，读到 EOF 后它会立刻关掉所有房间。
# 留一个不写数据的 writer，既保持 stdin 存活，也让 ExecStop 能写两次 stop 做优雅退出。
tail -f /dev/null > "${stdin_pipe}" &

exec /usr/bin/java -Xms64m -Xmx512m \
  -jar /opt/8bitgo-sfs/flashserver.jar \
  /etc/8bitgo-sfs/flash.properties < "${stdin_pipe}"

