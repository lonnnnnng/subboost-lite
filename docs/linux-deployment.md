# Linux 局域网部署

本项目不是纯静态页面：订阅抓取、TCP 预检、代理延迟、出口查询和下载测速需要 Node.js 后端以及可执行的 Mihomo。推荐 Linux x64/arm64 + Node.js 24 LTS + systemd。无需数据库、Docker、账号或登录。

## 本次服务器约定

| 项目 | 路径或地址 |
| --- | --- |
| 浏览器 | `http://192.168.1.2:9999` |
| 发布目录 | `/opt/subboost-lite/releases/<发布标识>` |
| 当前版本软链接 | `/opt/subboost-lite/current` |
| Node 可执行文件 | `/opt/subboost-lite/runtime/node` |
| 环境配置 | `/etc/subboost-lite.env` |
| 服务专用 DNS（有 TUN 时） | `/etc/subboost-lite-resolv.conf` |
| 服务 | `subboost-lite.service`，运行账号 `subconvert` |
| Mihomo 缓存 | `/var/cache/subboost-lite/mihomo` |

Node 不依赖交互式 nvm 初始化。运行时只复制服务器已有的 Linux Node 可执行文件；npm 仅在部署构建时需要。不要上传 macOS 的 node_modules、.next 或二进制缓存。

## 准备与构建

1. 确认 `9999` 未被占用，服务器能够访问 npm registry、GitHub API/Release、订阅地址和测试目标。
2. 把源码上传到新的发布目录。使用仓库锁文件在 Linux 上执行 `npm ci`、`npm run build`；保留运行时依赖，不要只上传 `.next/static`。
3. 首次部署创建无登录的 `subconvert` 系统账号；确保该账号可读发布目录，不能赋予 sudo。创建 `/opt/subboost-lite/runtime`，放入所选 Linux Node 的 `node` 可执行文件。
4. 将 `current` 指向已构建的版本，然后安装配置与服务（以下命令需要管理员权限）：

```sh
sudo install -m 640 -o root -g subconvert deploy/linux/subboost-lite.env.example /etc/subboost-lite.env
sudo install -m 644 deploy/linux/subboost-lite.service /etc/systemd/system/subboost-lite.service
sudo systemctl daemon-reload
sudo systemctl enable --now subboost-lite.service
```

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

## 运维

```sh
sudo systemctl status subboost-lite.service --no-pager
sudo systemctl restart subboost-lite.service
sudo systemctl stop subboost-lite.service
sudo journalctl -u subboost-lite.service -n 100 --no-pager
```

更新时先在新的 `releases/<发布标识>` 目录安装依赖并构建，再短暂停止服务，切换 `current`，启动并核验；不要在服务运行中覆盖 `.next`。旧版本保留，失败时停止服务、把 `current` 切回旧版本后启动。若旧版本的服务或路由脚本不同，也需要同步恢复对应配置。

## 验证和边界

- 2026-10-24 已在此服务器验证：Ubuntu 24.04 x64、Node.js 24.15.0、Next.js 16.4.3、Mihomo 1.19.33 compatible；Linux 与 macOS 均通过 488 项 Vitest 测试、3 项启动测试、类型检查、Lint 和生产构建。此次锁文件的 npm audit 为 0 项已知告警，不代表未来不会出现新公告。
- 使用用户提供的真实订阅成功导入 28 个节点，抽取 6 个进行 TCP/代理延迟检测并逐条返回结果；另以 15 秒、10 条下载流、50 MB 上限验证真实下载测速和进度消息。属于部署冒烟验证，不代表订阅内所有节点或所有协议都已验收。
- 浏览器打开页面，测试来源导入、模板预览、复制/下载、节点测试流式进度。
- 节点实测由 Linux 服务器执行；不代表浏览器所在电脑的网络性能。
- TCP 端口通不代表代理协议及固定测试目标一定可用，具体协议边界仍以 README 的检测说明为准。
- 本次为可信局域网 HTTP，没有添加登录。允许来源不是认证机制；不要公网转发 `9999`，也不要把来源白名单配成任意通配符。
- 如果后续使用 HTTPS 反向代理，须保留原始 Host，核对后端的协议/来源判断；不要仅靠伪造转发头放行。NDJSON 接口须关闭响应缓冲并设置足够读超时，本次直连部署不需要反向代理。

参考：[Next.js 自托管](https://nextjs.org/docs/app/guides/self-hosting)、[Mihomo 平台下载](https://wiki.metacubex.one/startup/)。
