#!/usr/bin/env bash
set -euo pipefail

stdin_pipe="${RUNTIME_DIRECTORY:-/run/8bitgo-sfs}/stdin"
if [[ -p "${stdin_pipe}" ]]; then
  printf 'stop\nstop\n' > "${stdin_pipe}"
fi

