# Linux 局域网部署

本项目不是纯静态页面：订阅抓取、TCP 预检、代理延迟、出口查询和下载测速需要 Node.js 后端以及可执行的 Mihomo。推荐 Linux x64/arm64 + Node.js 24 LTS + systemd。无需数据库、Docker 或用户注册，访问工作台需输入首次启动生成的密码。

## 本次服务器约定

| 项目 | 路径或地址 |
| --- | --- |
| 浏览器 | `http://192.168.1.2:9999` |
| 发布目录 | `/opt/subboost-lite/releases/<发布标识>` |
| 当前版本软链接 | `/opt/subboost-lite/current` |
| Node 可执行文件 | `/opt/subboost-lite/runtime/node` |
| 环境配置 | `/etc/subboost-lite.env` |
| 访问密码 | `/var/lib/subboost-lite/.access-password`，首次启动生成，重启和升级保留 |
| 服务专用 DNS（有 TUN 时） | `/etc/subboost-lite-resolv.conf` |
| 服务 | `subboost-lite.service`，运行账号 `subconvert` |
| Mihomo 缓存 | `/var/cache/subboost-lite/mihomo` |

Node 不依赖交互式 nvm 初始化。运行时只复制服务器已有的 Linux Node 可执行文件；npm 仅在部署构建时需要。不要上传 macOS 的 node_modules、.next 或二进制缓存。

## 部署入口

- [install.sh](../deploy/linux/install.sh)：安装、更新、只读预检和启动失败恢复。
- [subboost-lite.service](../deploy/linux/subboost-lite.service)：非 root 的 systemd 服务。
- [subboost-lite.env.example](../deploy/linux/subboost-lite.env.example)：环境变量参考。
- [direct-routing.conf](../deploy/linux/direct-routing.conf)、[direct-routing.sh](../deploy/linux/direct-routing.sh)、[resolv.conf.example](../deploy/linux/resolv.conf.example)：可选 TUN 隔离配置，安装脚本不会自动启用。

安装脚本面向使用 systemd、GNU tar、`useradd` 的 Linux，已部署的主机为 Ubuntu 24.04。服务器先准备好符合项目 engines 的 Linux Node/npm、curl、tar 和 Git（Git 仅克隆时需要）。脚本不会安装系统软件、修改防火墙、停止已有代理或改动全局 DNS。

## 1. 上传源码（在 macOS 执行）

在本仓库根目录执行。私有仓库不必给服务器配置 GitHub 凭证：使用 Git 已提交文件打包上传，不携带 `.git`、本地环境文件、node_modules、构建产物或节点缓存。`git archive` 不会产生 macOS 的 `._*` 扩展属性文件。

```zsh
bundle_dir=$(mktemp -d)
git archive --format=tar.gz --output="$bundle_dir/subboost-lite.tar.gz" HEAD
git rev-parse HEAD > "$bundle_dir/REVISION"
ssh -i ~/.ssh/id_ed25519 lee@192.168.1.2 'mkdir -p /home/lee/subboost-lite-upload'
scp -i ~/.ssh/id_ed25519 "$bundle_dir/subboost-lite.tar.gz" "$bundle_dir/REVISION" \
  lee@192.168.1.2:/home/lee/subboost-lite-upload/
ssh -i ~/.ssh/id_ed25519 lee@192.168.1.2
```

另一种方式是在服务器已具备私有仓库读取权限时 `git clone https://github.com/lonnnnnng/subboost-lite.git`，然后进入仓库执行下一节的安装与构建。不要把访问令牌写进 URL 或脚本。

## 2. 构建并安装（在 Linux 执行）

先确认 `9999` 未被其他服务占用，服务器能够访问 npm registry、GitHub API/Release、订阅地址和测试目标。以下构建命令由普通账号 `lee` 执行，**不要使用 sudo npm**。每次使用新目录，避免覆盖正在运行的 `.next`。

```sh
release_source=$(mktemp -d /home/lee/subboost-lite-build.XXXXXX)
tar --no-same-owner -xzf /home/lee/subboost-lite-upload/subboost-lite.tar.gz -C "$release_source"
cp /home/lee/subboost-lite-upload/REVISION "$release_source/REVISION"
cd "$release_source"
node --version
npm --version
npm ci
npm run build

# 只读检查构建、Node、监听配置；不安装、不切换、不重启。
sudo bash deploy/linux/install.sh --source "$PWD" --node "$(command -v node)" \
  --host 192.168.1.2 --port 9999 --check

# 确认后安装并激活，管理员密码只在终端中输入。
sudo bash deploy/linux/install.sh --source "$PWD" --node "$(command -v node)" \
  --host 192.168.1.2 --port 9999
```

脚本会创建独立发布目录、复制 Linux 构建及依赖、首次创建无登录服务账号和 Node 运行时、安装 systemd 服务、检查 HTTP 响应并启用开机自启。启动或健康检查失败时，尝试恢复原软链接及服务文件；失败发布和配置备份保留，便于排查。首次安装没有旧版本时，失败后服务会停止，修正原因后重新执行即可。

更新仍执行以上流程：**已有 `/etc/subboost-lite.env`、DNS 文件和 systemd drop-in 不覆盖**，因此更新命令中的 `--host` / `--port` 不会更改现有监听配置；要改地址请手动编辑环境文件后重启。已有运行时与本次构建 Node 版本不同时脚本会拒绝安装，不擅自升级共享运行时；先规划并备份 Node 运行时升级，再重新构建。自动恢复不包括管理员手工修改的配置或 Node 版本。

### 查看访问密码

systemd 创建仅服务账号可访问的 `/var/lib/subboost-lite`，程序首次启动时在其中写入 `.access-password`，文件权限为 `600`。启动日志只显示位置，不输出密码；应用升级和重启会继续读取同一文件。

```sh
sudo cat /var/lib/subboost-lite/.access-password
```

浏览器访问工作台，输入查看到的密码即可登录。会话固定有效 12 小时，退出或服务重启后需重新登录。要更换密码，使用编辑器将文件替换为单行 12–256 个字符，保留属主 `subconvert` 和权限 `600`，再重启服务。可在环境文件中用 `SUBCONVERT_PASSWORD_FILE` 指定其他绝对路径，但目录应提前创建并允许服务账号读写。

配置完成后可生成 10 分钟临时 HTTP 链接及二维码，直接交给 FlClash 导入；这些文件仅存内存，过期或服务重启后需要重新生成。链接本身就是读取凭据，无需客户端登录，不要分享给他人。HTTP 仍只适合可信局域网，外网访问应使用 HTTPS。

示例环境为此服务器地址；换服务器时必须同步修改 `SUBCONVERT_HOST` 与 `SUBCONVERT_ALLOWED_ORIGINS`。`PORT` 必须是 1–65535 的整数。监听 `0.0.0.0` 不等于允许所有访问地址：API 仍要求来源白名单。

服务首次测试会自动下载平台对应的 Mihomo，校验 GitHub Release 提供的 SHA-256 后缓存。也可在环境文件指定 `SUBCONVERT_MIHOMO_PATH=/absolute/path/to/mihomo`，可执行文件及父目录必须允许服务账号读取/执行，且不能放在被 `ProtectHome=true` 隔离的家目录。

## 已有 Clash / Mihomo TUN 的服务器

节点测试必须区分“服务器直接连接被测节点”和“服务器先经过现有代理再连接被测节点”。独立临时 Mihomo 不会自动绕开宿主机 TUN。

本次主机已有 TUN 路由，普通账号的公网连接被导向 `Meta`，宿主机 DNS 还会返回 `198.18.x.x` Fake-IP。因此采用独立 `subconvert` 账号，并在服务运行期间为该 UID 添加 IPv4/IPv6 的主路由规则；仅在服务挂载命名空间内使用真实 DNS（示例为 `223.5.5.5`、`119.29.29.29`）。不修改宿主机的 resolv.conf、Clash 配置、TUN 规则、其他账号流量，也不影响导出 YAML 中的 DNS 设置。

可选片段只适用于确认过的主机：检查 `ip rule` / `ip -6 rule`，确认优先级 `5280` 空闲，且该位置在 TUN 规则之前、必要的 Tailscale 路由之后。不同主机应重新评估，不能照搬优先级。

```sh
sudo install -d /etc/systemd/system/subboost-lite.service.d
sudo install -m 644 deploy/linux/resolv.conf.example /etc/subboost-lite-resolv.conf
sudo install -m 644 deploy/linux/direct-routing.conf /etc/systemd/system/subboost-lite.service.d/direct-routing.conf
sudo systemctl daemon-reload
sudo systemctl restart subboost-lite.service
id -u subconvert
# 用上一步 UID 验证：应显示主网卡，而不是 Meta/TUN。
ip route get 1.1.1.1 uid <UID>
# 在服务命名空间核对真实解析（不要只看宿主机的 Fake-IP）：
sudo nsenter -t "$(systemctl show subboost-lite.service -p MainPID --value)" -m runuser -u subconvert -- getent ahostsv4 api.github.com
```

路由准备和回收由 systemd 以 root 执行，Web 和临时 Mihomo 始终是非 root；停止服务时只删除本服务匹配的 UID 规则。优先级冲突会使启动失败，不覆盖其他规则。不要通过禁用公网 IP 校验、开放私网节点或全局关闭代理来绕过这个问题。

## 运维、更新与回滚

```sh
sudo systemctl status subboost-lite.service --no-pager
sudo systemctl restart subboost-lite.service
sudo systemctl stop subboost-lite.service
sudo journalctl -u subboost-lite.service -n 100 --no-pager
```

更新代码时，重新执行“上传源码”和“构建并安装”，无需卸载服务。脚本不会自动删除旧版本、上传包或构建目录。

如需手动回滚，先查找发布目录和 `REVISION`，确认要恢复的绝对路径（不要直接粘贴示例占位符）：

```sh
readlink -f /opt/subboost-lite/current
ls -lt /opt/subboost-lite/releases
cat /opt/subboost-lite/releases/<旧发布标识>/REVISION

# 先停旧服务再切换，使旧 ExecStopPost 能正确回收可选 TUN 路由。
sudo systemctl stop subboost-lite.service
sudo ln -sfn /opt/subboost-lite/releases/<旧发布标识> /opt/subboost-lite/current
sudo install -m 644 /opt/subboost-lite/current/deploy/linux/subboost-lite.service /etc/systemd/system/subboost-lite.service
sudo systemctl daemon-reload
sudo systemctl start subboost-lite.service
sudo systemctl status subboost-lite.service --no-pager
curl --noproxy '*' -fsS http://192.168.1.2:9999/ -o /dev/null
```

回滚仅切换代码与基础服务文件，保留环境配置和可选 drop-in。如果旧版需要不同的环境、路由脚本或 Node，必须恢复对应备份后再启动。不要删除 `current` 正在使用的发布目录。

## 验证和边界

- 安装器分支测试可在本机一次性容器中运行：`docker run --rm --network none -e SUBBOOST_DEPLOY_TEST_CONTAINER=1 -v "$PWD:/repo:ro" --entrypoint bash postgres:16 /repo/deploy/linux/install.test.sh`。另加 `-e SUBBOOST_DEPLOY_TEST_FAIL_FIRST=1` 可验证首次激活失败。测试使用模拟的 Node、systemd 和 HTTP 探测，验证预检无写入、配置保留、更新切换及失败恢复；不代替真实 Linux 服务验收，严禁在生产主机直接执行测试脚本。
- 2026-10-24 已在此服务器验证：Ubuntu 24.04 x64、Node.js 24.15.0、Next.js 16.4.3、Mihomo 1.19.33 compatible；Linux 与 macOS 均通过 488 项 Vitest 测试、3 项启动测试、类型检查、Lint 和生产构建。此次锁文件的 npm audit 为 0 项已知告警，不代表未来不会出现新公告。
- 使用用户提供的真实订阅成功导入 28 个节点，抽取 6 个进行 TCP/代理延迟检测并逐条返回结果；另以 15 秒、10 条下载流、50 MB 上限验证真实下载测速和进度消息。属于部署冒烟验证，不代表订阅内所有节点或所有协议都已验收。
- 浏览器打开页面，测试来源导入、模板预览、复制/下载、节点测试流式进度。
- 节点实测由 Linux 服务器执行；不代表浏览器所在电脑的网络性能。
- TCP 端口通不代表代理协议及固定测试目标一定可用，具体协议边界仍以 README 的检测说明为准。
- 本次为可信局域网 HTTP，工作台和业务接口需密码登录；登录不会加密 HTTP 传输。允许来源不是认证机制；不要公网转发 `9999`，也不要把来源白名单配成任意通配符。
- 如果后续使用 HTTPS 反向代理，须保留原始 Host，核对后端的协议/来源判断；不要仅靠伪造转发头放行。NDJSON 接口须关闭响应缓冲并设置足够读超时，本次直连部署不需要反向代理。

参考：[Next.js 自托管](https://nextjs.org/docs/app/guides/self-hosting)、[Mihomo 平台下载](https://wiki.metacubex.one/startup/)。
