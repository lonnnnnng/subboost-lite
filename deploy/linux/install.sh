#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    '用法: bash deploy/linux/install.sh --source 构建目录 --node Linux-Node绝对路径 [--host 局域网IP] [--port 9999] [--check]' \
    '先以普通账号在 Linux 执行 npm ci 和 npm run build，再用 sudo 安装。' \
    '首次安装必须指定 --host；更新保留已有环境、DNS 和 TUN 配置。--check 只读预检。'
}
fail() { printf '部署失败: %s\n' "$*" >&2; exit 1; }

source_dir=''
node_path=''
host=''
port=9999
check_only=false
while (($#)); do
  case "$1" in
    --source|--node|--host|--port)
      (($# >= 2)) || fail "$1 缺少参数"
      case "$1" in
        --source) source_dir=$2 ;;
        --node) node_path=$2 ;;
        --host) host=$2 ;;
        --port) port=$2 ;;
      esac
      shift 2 ;;
    --check) check_only=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; fail "未知参数: $1" ;;
  esac
done

[[ $(uname -s) == Linux ]] || fail '安装脚本只能在 Linux 服务器运行，不能安装 macOS 构建产物'
for tool in realpath tar install systemctl curl getent useradd readlink awk; do
  command -v "$tool" >/dev/null || fail "缺少命令: $tool"
done
[[ -d /run/systemd/system ]] || fail '需要使用 systemd 的主机'
[[ -n "$source_dir" && -d "$source_dir" ]] || fail '请指定已构建的 --source 目录'
source_dir=$(realpath "$source_dir")
[[ "$source_dir" != / ]] || fail '源码目录不能是根目录'
[[ "$node_path" == /* && -x "$node_path" ]] || fail '--node 必须是可执行文件的绝对路径'
node_path=$(realpath "$node_path")
"$node_path" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(process.platform!=="linux" || !(major===22 && minor>=19 || major>=24)) process.exit(1)' || fail '需要符合项目 engines 的 Linux Node.js'
for item in package.json package-lock.json apps/web/.next/BUILD_ID node_modules/next/package.json scripts/start.mjs deploy/linux/subboost-lite.service; do
  [[ -f "$source_dir/$item" ]] || fail "构建不完整，缺少 $item；请先在 Linux 执行 npm ci 和 npm run build"
done
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || fail '端口必须是 1–65535'
[[ -z "$host" || "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail '--host 只接受 IPv4 或主机名'

base=/opt/subboost-lite
unit=/etc/systemd/system/subboost-lite.service
env_file=/etc/subboost-lite.env
[[ ! -e "$base/current" || -L "$base/current" ]] || fail 'current 不是软链接，拒绝覆盖'
previous=''
if [[ -L "$base/current" ]]; then
  previous=$(readlink -f "$base/current")
  [[ -d "$previous" ]] || fail 'current 指向不存在的发布目录，请先修复软链接'
fi
if [[ -f "$env_file" ]]; then
  # long: 环境文件不是 shell 脚本，不能 source；更新必须保留管理员配置的白名单和内核路径。
  host=$(awk -F= '$1=="SUBCONVERT_HOST" {sub(/^[^=]*=/, ""); print; exit}' "$env_file")
  port=$(awk -F= '$1=="PORT" {print $2; exit}' "$env_file")
fi
[[ -n "$host" ]] || fail '首次安装必须指定 --host；已有环境文件必须包含 SUBCONVERT_HOST'
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$port" =~ ^[0-9]{1,5}$ ]] || fail '环境文件中的监听地址或端口格式不支持，请检查配置'
((10#$port >= 1 && 10#$port <= 65535)) || fail '环境文件中的端口超出范围'
if [[ -e "$base/runtime/node" ]]; then
  [[ $("$base/runtime/node" --version) == $("$node_path" --version) ]] || fail '已有服务 Node 与本次构建版本不同，请先规划运行时升级；脚本不会覆盖共享运行时'
fi
if $check_only; then
  printf '预检通过。源码: %s\n监听: %s:%s\n现有配置将保留；未执行安装或重启。\n' "$source_dir" "$host" "$port"
  exit 0
fi
((EUID == 0)) || fail '安装阶段需要 sudo；依赖安装和构建请使用普通账号'

# long: 每次生成独立发布目录，构建和复制失败不触碰正在提供服务的 current。
install -d -m 755 "$base/releases" "$base/runtime"
release=$(mktemp -d "$base/releases/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
chmod 755 "$release"
tar -C "$source_dir" --exclude='.env' --exclude='.env.*' --exclude='apps/web/data' --exclude='apps/web/.next/cache' \
  -cf - package.json package-lock.json apps packages scripts deploy node_modules |
  tar --no-same-owner -C "$release" -xf -
chown -R root:root "$release"
chmod -R a+rX "$release"
if [[ -f "$source_dir/REVISION" ]]; then
  install -m 644 "$source_dir/REVISION" "$release/REVISION"
elif command -v git >/dev/null && git -C "$source_dir" rev-parse HEAD > "$release/REVISION" 2>/dev/null; then
  :
else
  printf '%s\n' 'unknown (source archive without REVISION)' > "$release/REVISION"
fi
if ! getent passwd subconvert >/dev/null; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin subconvert
fi
[[ $(id -u subconvert) != 0 ]] || fail '服务账号不能使用 root UID'
getent group subconvert >/dev/null || fail '缺少 subconvert 服务组'
[[ -e "$base/runtime/node" ]] || install -m 755 "$node_path" "$base/runtime/node"
if [[ ! -e "$env_file" ]]; then
  printf 'SUBCONVERT_HOST=%s\nPORT=%s\nSUBCONVERT_ALLOWED_ORIGINS=http://%s:%s\nSUBCONVERT_MIHOMO_DIR=/var/cache/subboost-lite/mihomo\nNODE_ENV=production\nNEXT_TELEMETRY_DISABLED=1\n' \
    "$host" "$port" "$host" "$port" > "$env_file"
  chown root:subconvert "$env_file"
  chmod 640 "$env_file"
fi

backup=$(mktemp -d "$base/releases/.activation.XXXXXX")
[[ ! -f "$unit" ]] || cp -p "$unit" "$backup/service"
was_active=false
systemctl is-active --quiet subboost-lite.service && was_active=true
had_service=false
systemctl cat subboost-lite.service >/dev/null 2>&1 && had_service=true
completed=false
switched=false
rollback() {
  result=$?
  trap - EXIT INT TERM
  if ! $completed && $switched; then
    # long: 健康检查失败时恢复原来的软链接和服务文件，保留失败发布与备份便于排查，不自动清理历史版本。
    systemctl stop subboost-lite.service || true
    if [[ -n "$previous" && -d "$previous" ]]; then
      ln -s "$previous" "$backup/restore-current"
      mv -Tf "$backup/restore-current" "$base/current"
    fi
    [[ ! -f "$backup/service" ]] || cp -p "$backup/service" "$unit"
    systemctl daemon-reload || true
    if $was_active; then systemctl start subboost-lite.service || true; fi
    printf '激活未完成；已尝试恢复原服务。失败发布: %s；配置备份: %s\n' "$release" "$backup" >&2
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
switched=true
# long: 必须先停止旧版，确保其 ExecStopPost 仍通过旧 current 回收 TUN 路由。
if $had_service; then systemctl stop subboost-lite.service; fi
ln -s "$release" "$backup/new-current"
mv -Tf "$backup/new-current" "$base/current"
install -m 644 "$release/deploy/linux/subboost-lite.service" "$unit"
systemctl daemon-reload
systemctl start subboost-lite.service
probe_host=$host
[[ "$probe_host" != 0.0.0.0 ]] || probe_host=127.0.0.1
healthy=false
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet subboost-lite.service && curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 "http://$probe_host:$port/" -o /dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
$healthy || fail '服务未通过 HTTP 健康检查，请检查 journalctl；将尝试恢复旧版'
systemctl enable subboost-lite.service
completed=true
printf '部署完成: %s\n浏览器: http://%s:%s\n前一版本: %s\n' "$release" "$host" "$port" "${previous:-无}"
