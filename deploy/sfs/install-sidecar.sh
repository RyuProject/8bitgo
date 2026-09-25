#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 sudo 运行：sudo ./deploy/sfs/install-sidecar.sh" >&2
  exit 1
fi

for command_name in git java mvn; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "缺少 ${command_name}；先安装 git、JDK 17+ 和 Maven。" >&2
    exit 1
  fi
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_root=/opt/8bitgo-sfs
source_dir="${install_root}/source"
config_dir=/etc/8bitgo-sfs

if ! getent group 8bitgo-sfs >/dev/null 2>&1; then
  groupadd --system 8bitgo-sfs
fi
if ! id -u 8bitgo-sfs >/dev/null 2>&1; then
  useradd --system --gid 8bitgo-sfs --home-dir "${install_root}" --shell /usr/sbin/nologin 8bitgo-sfs
fi

install -d -m 755 "${install_root}" "${config_dir}"
if [[ ! -d "${source_dir}/.git" ]]; then
  git clone --branch v4.3 --depth 1 https://github.com/GlennnM/FlashPrivateServer.git "${source_dir}"
else
  git -C "${source_dir}" fetch --depth 1 origin tag v4.3
  git -C "${source_dir}" checkout --force v4.3
fi

# 标签名比 main 稳定，但 Git 标签理论上仍能被上游移动。必须核对完整 160 位提交哈希：
# 7 位短前缀只有 28 bit，恶意上游可以刻意制造同前缀提交，不能拿它做生产供应链边界。
expected_commit=7cd3983110c7632d69d08fc578ddfd257bb90d15
actual_commit="$(git -C "${source_dir}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${expected_commit}" ]]; then
  echo "FlashPrivateServer v4.3 指向 ${actual_commit}，预期 ${expected_commit}；已停止安装，请先审查上游变化。" >&2
  exit 1
fi

mvn -q -f "${source_dir}/pom.xml" -DskipTests package
shopt -s nullglob
jar_candidates=("${source_dir}"/target/flashserver-*.jar)
jar_path=
for candidate in "${jar_candidates[@]}"; do
  [[ "${candidate}" == *-sources.jar ]] || { jar_path="${candidate}"; break; }
done
if [[ -z "${jar_path}" ]]; then
  echo "Maven 已结束，但 target/ 下没找到 flashserver-*.jar。" >&2
  exit 1
fi

install -m 644 "${jar_path}" "${install_root}/flashserver.jar"
install -m 755 "${script_dir}/run-server.sh" "${install_root}/run-server.sh"
install -m 755 "${script_dir}/stop-server.sh" "${install_root}/stop-server.sh"
if [[ ! -e "${config_dir}/flash.properties" ]]; then
  install -m 644 "${script_dir}/flash.properties" "${config_dir}/flash.properties"
else
  echo "保留现有 ${config_dir}/flash.properties（模板未覆盖）。"
fi
install -m 644 "${script_dir}/8bitgo-sfs.service" /etc/systemd/system/8bitgo-sfs.service
chown -R root:root "${install_root}" "${config_dir}"
systemctl daemon-reload

echo
echo "SAS3 sidecar 已安装但尚未启动。"
echo "检查 ${config_dir}/flash.properties 后运行："
echo "  sudo systemctl enable --now 8bitgo-sfs"
echo "再在 8BitGo 的 server/.env 设置 SFS_ENABLED=1，并运行 sudo systemctl restart 8bitgo。"
