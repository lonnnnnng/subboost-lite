#!/usr/bin/env bash
set -Eeuo pipefail

# long: 安装器会操作 /opt 和 /etc，分支测试只能在一次性容器中运行，绝不能用正式服务器代替测试沙盒。
[[ -f /.dockerenv && ${SUBBOOST_DEPLOY_TEST_CONTAINER:-} == 1 && $EUID == 0 ]] || {
  printf '%s\n' '仅允许在设置 SUBBOOST_DEPLOY_TEST_CONTAINER=1 的一次性 root Docker 容器中运行' >&2
  exit 1
}
[[ ! -e /opt/subboost-lite && ! -e /etc/subboost-lite.env ]] || exit 1
installer=$(realpath "$(dirname "$0")/install.sh")
fixture=$(mktemp -d)
export fixture
mkdir -p /run/systemd/system "$fixture/source/apps/web/.next" "$fixture/source/node_modules/next" \
  "$fixture/source/scripts" "$fixture/source/deploy/linux" "$fixture/source/packages" /etc/systemd/system
cp "$installer" "$fixture/source/deploy/linux/install.sh"
cp "$(dirname "$installer")/subboost-lite.service" "$fixture/source/deploy/linux/"
for item in package.json package-lock.json node_modules/next/package.json; do
  printf '{}\n' > "$fixture/source/$item"
done
printf 'fixture\n' > "$fixture/source/apps/web/.next/BUILD_ID"
printf '// fixture\n' > "$fixture/source/scripts/start.mjs"
printf 'must-not-be-deployed\n' > "$fixture/source/apps/web/.env.local"
printf 'must-not-be-deployed\n' > "$fixture/source/scripts/.access-password"
printf '#!/usr/bin/env bash\nfake_node "$@"\n' > "$fixture/node"
chmod 755 "$fixture/node"
fake_node() { if [[ ${1:-} == --version ]]; then printf 'v24.15.0\n'; fi; return 0; }
systemctl() {
  case "$1" in
    is-active) [[ -f "$fixture/active" ]] ;;
    cat) [[ -f /etc/systemd/system/subboost-lite.service ]] ;;
    start) touch "$fixture/active" ;;
    stop)
      # long: 首次安装不存在服务时，真实 systemctl stop 会失败，模拟这个分支可以发现首次安装被误当更新的问题。
      [[ -f /etc/systemd/system/subboost-lite.service ]] || return 5
      if [[ -f "$fixture/active" ]]; then mv "$fixture/active" "$fixture/stopped"; fi ;;
    daemon-reload|enable) return 0 ;;
    *) return 1 ;;
  esac
}
curl() { [[ ! -f "$fixture/fail-health" ]]; }
sleep() { :; }
export -f fake_node systemctl curl sleep
run_install() {
  bash "$installer" --source "$fixture/source" --node "$fixture/node" --host 192.168.1.2 --port 9999 "$@"
}

run_install --check
[[ ! -e /opt/subboost-lite && ! -e /etc/subboost-lite.env ]]
printf 'PASS: 只读预检不创建发布或配置\n'

if [[ ${SUBBOOST_DEPLOY_TEST_FAIL_FIRST:-} == 1 ]]; then
  touch "$fixture/fail-health"
  if run_install; then exit 1; fi
  [[ ! -f "$fixture/active" ]]
  [[ -f /opt/subboost-lite/current/apps/web/.next/BUILD_ID ]]
  printf 'PASS: 首次启动失败保持停止，不会生成自指向的 current 软链接\n'
  exit 0
fi

run_install
first=$(readlink -f /opt/subboost-lite/current)
[[ -f "$fixture/active" && -f "$first/apps/web/.next/BUILD_ID" ]]
[[ ! -e "$first/apps/web/.env.local" ]]
[[ ! -e "$first/scripts/.access-password" ]]
[[ $(id -u subconvert) != 0 ]]
! grep -Eq 'SUBCONVERT_PASSWORD_FILE|StateDirectory=' "$first/deploy/linux/subboost-lite.service"
printf 'PASS: 首次安装、非 root 账号和环境文件排除\n'

printf 'SUBCONVERT_HOST=192.168.1.2\nPORT=8888\nSUBCONVERT_ALLOWED_ORIGINS=http://192.168.1.2:8888\n' > /etc/subboost-lite.env
cp /etc/subboost-lite.env "$fixture/saved-env"
mkdir -p /etc/systemd/system/subboost-lite.service.d
printf '# administrator configuration\n' > /etc/systemd/system/subboost-lite.service.d/direct-routing.conf
run_install
second=$(readlink -f /opt/subboost-lite/current)
[[ "$first" != "$second" && -d "$first" ]]
cmp /etc/subboost-lite.env "$fixture/saved-env"
[[ -f /etc/systemd/system/subboost-lite.service.d/direct-routing.conf ]]
printf 'PASS: 更新切换独立发布，保留环境和可选 drop-in\n'

cp /etc/systemd/system/subboost-lite.service "$fixture/saved-unit"
touch "$fixture/fail-health"
if run_install; then
  printf 'FAIL: 健康检查失败却返回成功\n' >&2
  exit 1
fi
[[ $(readlink -f /opt/subboost-lite/current) == "$second" && -f "$fixture/active" ]]
cmp /etc/systemd/system/subboost-lite.service "$fixture/saved-unit"
cmp /etc/subboost-lite.env "$fixture/saved-env"
printf 'PASS: 健康检查失败返回非零，恢复旧软链接、服务和运行状态\n'
