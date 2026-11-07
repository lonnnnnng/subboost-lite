<div align="center">
  <img src="apps/web/app/icon.png" width="88" height="88" alt="SubConvert Lite" />

  <h1>SubConvert Lite</h1>

  <p><strong>在浏览器里完成订阅聚合、规则编排、节点实测与 Mihomo 配置生成。</strong></p>
  <p>SubBoost 的本地文件化精简版：无账号、无数据库、无远程后台服务依赖。</p>

  <p>
    <img src="https://img.shields.io/badge/Next.js-16-111827?logo=nextdotjs" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" alt="React 19" />
    <img src="https://img.shields.io/badge/Mihomo-1.19-0F806F" alt="Mihomo 1.19" />
    <img src="https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22 or 24" />
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0" />
  </p>
</div>

![SubConvert Lite 浏览器工作台](docs/assets/subboost-lite-workbench.png)

## 项目定位

SubConvert Lite 面向只需要“导入节点 -> 选择规则 -> 生成配置”的 FlClash / Mihomo 用户。它保留了 SubBoost 的协议解析和配置生成能力，将工作流收敛到一个桌面浏览器宽屏工作台中。当前页面采用自适应三栏布局，可对整个工作台或单独的节点列表进入浏览器全屏。

所有来源和模板状态仅保存在当前浏览器会话内。你可以把模板导出为 JSON，把最终配置下载为 YAML；项目不会创建用户、订阅记录或业务数据库。

## 核心能力

| 能力 | 当前实现 |
| --- | --- |
| 来源导入 | 订阅 URL、Clash / Mihomo YAML、节点分享链接 |
| 批量订阅 | 支持粘贴或多选文本文件追加 URL，默认 10 条并发；进度逐条实时更新，单条 15 秒超时 |
| 证书异常 | 证书过期、主机名不匹配时进入人工审核，可切换 Base64 原文与解码明文 |
| 规则模板 | 轻量、日常、高级三套预设；规则集来源、AI、广告、完整国内域名规则和分流模块均可调整；模板名称由预设自动管理 |
| 模板文件 | `subconvert-template/v1` JSON 导入与导出 |
| 域名直连 | 统一配置域名直连；专用 DNS 可选，不填只生成 `DOMAIN-SUFFIX,...,DIRECT`，填写后额外生成 `fake-ip-filter` 和 `nameserver-policy` |
| 节点管理 | 名称和区域可编辑，支持按出口区域批量命名、筛选、查看详情、导出、删除选中、按服务器 IP 去重和移除大陆节点 |
| 连通/延迟 | 真实 TCP 与 Mihomo 代理测试，最多 6 个独立 worker 并行，结果逐节点实时显示 |
| 出口区域 | 请求实际经过被测节点，多个公网 IP 服务投票，不根据节点名称或入口 IP 猜测 |
| 下载测速 | Cloudflare、GitHub Release 或自定义 HTTPS 源；实时速度、峰值、平均值和稳定性 |
| 配置预览 | 节点列表可视化预览、筛选、节点详情、YAML 语法高亮、复制与下载 |
| 浏览器交互 | 三栏自适应布局、来源/模板/预览统一卡片、批量进度、结果确认、证书人工审核和节点列表独立全屏 |

## 工作流

```text
订阅 URL / YAML / 节点链接
              |
              v
      解析、去重与人工审核
              |
              v
     节点编辑、连通测试与测速
              |
              v
       选择或自定义规则模板
              |
              v
     可视化预览 -> 下载 YAML
```

### 1. 导入来源

- **订阅链接**：每行一个链接，也可一次选择多个文本文件并按选择顺序追加；默认 10 个 worker 并发执行，来源面板会实时显示已完成、处理中、排队、成功、失败和待审核数量。输入中的完全重复 URL 会自动忽略。
- **YAML 配置**：支持粘贴或选择本地 `.yaml` / `.yml` 文件。完整 Clash / Mihomo YAML 导入后，会自动把未由转换器重建的基础配置（例如端口、DNS、Fake-IP、TUN、嗅探、hosts、profile、geodata、listeners、proxy-providers 及未来的扩展字段）带入“基础配置 / DNS YAML”中继续编辑；`proxies`、`proxy-groups`、`rule-providers`、`rules` 由当前模板和节点重新生成，其中 `DOMAIN/DOMAIN-SUFFIX,...,DIRECT` 会转换为直连域名设置。
- **节点连接**：支持常见的 SS、SSR、VMess、VLESS、Trojan、Hysteria、TUIC、AnyTLS、WireGuard 等格式。
- 节点列表支持按选中项或全部节点导出为可复用 YAML；导出的 `proxies` 配置可以重新粘贴到“节点连接”来源中解析。
- 批量订阅会先展示“导入成功 / 导入失败 / 待人工确认”的结果确认框；用户确认后，才会逐条打开证书审核窗口。失败 URL 会保留在输入框中，方便重试。
- 证书审核窗口固定尺寸并支持纵向滚动，可在 Base64 原文和解码明文之间切换；证书过期、主机名与 IP 不匹配等证书错误只有在返回内容成功解析出节点后才进入审核。

服务端会并行尝试 `v2rayN` 和 `mihomo` User-Agent，以兼容不同订阅端点；必要时再补充浏览器 User-Agent。每条链接取得并发槽后才开始计算 15 秒超时，排队等待不会消耗该链接的超时窗口；单条订阅超时也不会阻塞同批其他链接。

### 2. 设计规则模板

- 使用轻量、日常、高级预设快速开始。
- 三套预设均包含“⚡ 自动选择”（`url-test`）和“🛟 故障转移”（`fallback`）；“🚀 节点选择”默认仍使用自动选择，导入 FlClash 后可改选故障转移，服务分流和漏网之鱼默认跟随节点选择。
- 故障转移按生成配置中的节点列表顺序优先使用第一个可用节点，优先节点不可用时使用后面的备用节点；沿用模板的检测 URL 和检测间隔，不按测速结果排序，不把订阅流量/到期提示节点作为候选。页面“核心”分类可单独关闭此组，导入旧模板时保留其原有启用项。
- 模板名称随内置预设自动管理，界面聚焦规则选择，不需要手动维护名称。
- 按核心、服务、社交、媒体、游戏、技术、金融等分类选择规则模块。
- 默认使用 GitHub Raw；也可在页面内菜单中切换 jsDelivr、jsDelivr CF 或自定义 URL 前缀作为规则集下载源。
- 选择 AI 规则细分/聚合、轻量/AdRules 广告策略和完整国内域名规则。
- 基础配置支持恢复当前预设默认值（不会清空已导入节点），并可打开约 20 行高度的 YAML 语法高亮预览。
- 在“直连域名”中逐条填写域名；公网站点只填 `baidu.com`，公司内网域名在同一行补充专用 DNS，即可同时生成直连规则和 Fake-IP/DNS 策略。
- 导入或导出 JSON 模板，复用个人规则组合。
- 规则模块默认收起，展开后按核心、服务、社交、媒体、游戏、技术、金融和其他分类配置；`select` 与 `final` 为必需骨架模块，不能关闭。
- 基础配置默认收起，支持 Mixed 端口、允许局域网、完整基础/DNS YAML、直连域名和可选专用 DNS；“恢复默认”只恢复模板配置，不清空节点。
- 基础配置 / DNS YAML 查看窗口使用语法高亮并固定约 20 行高度；导入完整 Clash / Mihomo YAML 时，会尽量保留基础字段、DNS、监听器和代理提供者。

当前内置规则主要来自 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)，增强广告规则可选用 [AdRules](https://adrules.top/)。

### 3. 测试节点

连通/延迟测试分为三层：

1. 对节点入口执行真实 DNS 与 TCP 建连检查。
2. 启动隔离的临时 Mihomo 实例，通过目标节点访问延迟测试地址。
3. 通过该节点查询真实出口 IP，多服务投票后更新区域。

连通/延迟最多使用 6 个独立 Mihomo worker 并行执行。每个节点完成后会立即通过 NDJSON 流推送到页面，因此慢节点不会挡住已经完成的结果。

下载测速与延迟测试分开执行，避免误操作消耗大量流量：

- 每批最多选择 5 个节点。
- 单节点下载并发可设置为 `1-100`，默认 `10`。
- 测速窗口可设置为 `15-300` 秒。
- 稳态采样上限可设置为 `50-2048 MB`。
- 下载内容只在内存流中计数并丢弃，**不会保存到磁盘**。

> 节点测速会产生真实网络流量。高并发和较大的采样上限可能迅速消耗订阅流量及本机带宽。

节点列表还提供以下操作：

- 按名称、区域、协议、连通性、出口/服务器 IP 和延迟范围筛选；延迟筛选支持小于 `1000/2000/3000ms` 以及大于 `3000/5000ms`。
- 节点名称和区域可以直接在表格中编辑；测试得到真实出口地区后，可一键按区域命名，同一区域自动追加两位流水号。尚未测试或没有区域的节点不会被强行改名。
- “一键去重”只依据列表中 `服务器` 字段的字面 IP；同一 IP 的不同端口视为重复并保留列表中的第一条，域名服务器不会被猜测成 IP 后删除。
- “非大陆”会移除区域为“中国大陆”的节点；区域来自实际出口查询或用户手动编辑。
- 支持查看节点完整 JSON 信息、删除选中节点、导出选中或全部节点，以及只对节点列表区域进入全屏。
- 连通/延迟测试显示实时完成进度和成功/失败数量；每个节点结果返回后立即更新列表，而不是等待整批结束。

### 4. 检测实现与边界

三个检测的目标不同，不能把其中一个检测的成功结果直接等同于另一个检测成功：

| 检测 | 实际做什么 | 是否执行代理协议握手 | 目标地址 |
| --- | --- | --- | --- |
| TCP 连通性预检 | 从运行 SubConvert Lite 的本机解析节点地址并建立 TCP 连接 | 否 | 节点的 `server:port` |
| 代理延迟 | 启动临时 Mihomo，选中节点后通过节点发起 HTTPS 请求 | 是 | `https://www.gstatic.com/generate_204` |
| 下载测速 | 启动临时 Mihomo，通过节点读取下载源并统计流量 | 是 | Cloudflare、GitHub Release 或自定义 HTTPS 地址 |

#### 4.1 TCP 连通性预检

TCP 检测只回答“从运行应用的主机到节点入口的端口能不能建立连接”，不负责验证代理协议本身：

- 默认超时为 `3.5` 秒，页面可配置为 `1-30` 秒。
- 默认使用 `6` 个并发 worker。
- 目标是节点原始的域名/IP 和端口，由应用直接建立连接，不经过被测节点；宿主机若启用系统级 TUN，仍需单独核验路由，不能假定一定绕过宿主机代理。
- 域名会先经过公网 DNS 解析和 SSRF 安全检查；回环地址、内网地址及其他非公网地址不会作为普通探测目标。
- 不执行 VMess、VLESS、Trojan、Reality、Hysteria 等协议握手，也不验证 UUID、密码、TLS、SNI 或 Reality 公钥。
- DNS 能解析但 TCP 连接失败时，解析得到的 IP 仍可能作为后续 Mihomo 候选；最终是否可用由代理层测试决定。

因此，TCP 结果的含义是：

```text
TCP 可达 = 入口端口接受连接
TCP 可达 ≠ 代理协议可用
TCP 可达 ≠ 能访问互联网
```

#### 4.2 代理协议支持边界

延迟和测速不由本项目自行实现各类代理协议，而是把节点转换为临时 Mihomo 配置后交给 Mihomo 内核处理。导入解析器能识别的协议范围可能比测试器实际能运行的范围更宽。

当前测试器明确拒绝以下类型：

```text
socks4
h2-connect
trust-tunnel
trusttunnel
external
```

常见协议会继续交给 Mihomo 尝试，包括：

```text
SS、SSR、VMess、VLESS、Trojan、AnyTLS、
Hysteria、Hysteria2、TUIC、SOCKS5、
HTTP/HTTPS、SSH、WireGuard、Snell
```

节点还必须满足对应的最小字段要求：

| 协议 | 关键字段 |
| --- | --- |
| SS | `cipher`、`password` |
| SSR | `cipher`、`password`、`protocol`、`obfs` |
| VMess | `uuid` |
| VLESS | `uuid` |
| Trojan / AnyTLS | `password` |
| Hysteria2 | `password` |
| Snell | `psk` |
| WireGuard | 合法的 `private-key`；可选公钥和预共享密钥也必须合法 |
| SSH | `password` 或合法 PEM 格式 `private-key` |

另外，以下组合也可能在进入 Mihomo 前被判定为不支持：

- VLESS Reality 的 `public-key`、`short-id` 等字段格式不正确；
- VLESS XHTTP 参数不完整或格式不合法；
- SS 插件参数不符合 Mihomo 支持格式；
- 节点带有内部 `_subboost-invalid-mihomo-node` 标记；
- 原始节点字段经过安全清洗后，无法组成有效的 Mihomo 节点。

#### 4.3 固定 IP、TLS 与域名字段

为降低 DNS rebinding 风险，TCP 预检成功后，临时 Mihomo 配置通常会把节点的 `server` 固定为刚刚核验过的公网 IP。对于部分 TLS 协议，程序会把原始域名补回 SNI：

- VMess / VLESS：补回 `servername` 或 `sni`；
- Trojan / AnyTLS / Hysteria / Hysteria2 / TUIC：补回 `sni` 或 `servername`。

这套处理能兼顾公网地址安全校验和常见 TLS 节点，但并不是所有传输方式都能自动恢复原始域名语义。依赖特定 Host、WS、XHTTP 或其他嵌套传输字段的节点，仍可能出现“V2ray 可用、Mihomo 测试失败”的差异。此时应重点检查原始节点的 SNI、Host、路径、指纹、Reality 和传输层参数。

#### 4.4 代理延迟的成功条件

延迟测试使用 Mihomo 控制接口的 `delay` 检测，并固定请求：

```text
URL:      https://www.gstatic.com/generate_204
timeout:  6000ms
expected: 200/204
```

它测量的是“协议握手完成后，通过代理访问指定 HTTPS 目标”的耗时，不是 ICMP Ping，也不是单纯 TCP 建连时间。以下任何情况都会导致代理延迟失败：

- 协议握手失败；
- Reality、TLS、SNI、指纹或传输层参数不匹配；
- 节点出口无法访问该目标；
- 目标被网络策略拦截；
- 目标返回 403、404、503 等非 `200/204` 状态；
- Mihomo 节点切换失败、控制端口启动失败或内核不可用。

因此可能出现：

```text
TCP 端口通，但代理延迟测试失败
```

这表示入口端口可以连接，但还没有证明该节点能够按当前 Mihomo 参数完成代理访问。

连通/延迟模式不限制一次选择的节点数量。节点先进行 TCP 预检，再分配给最多 `6` 个独立 Mihomo worker；每个 worker 内部逐个切换节点。每个节点完成后立即通过 NDJSON 流推送结果，页面不会等整批节点全部结束才显示。

#### 4.5 下载测速的成功条件

测速同样必须先通过 Mihomo 代理链路。当前实现的边界如下：

- 单批最多 `5` 个节点；
- 节点之间在同一个 Mihomo 测速批次内依次执行；
- 单个节点内部使用并发下载流，范围 `1-100`，默认 `10`；
- 测速窗口范围 `15-300` 秒，默认 `15` 秒；
- 预热阶段 `1.5` 秒，不计入稳态平均速度；
- 稳态采样上限 `50-2048 MB`，默认 `300 MB`；
- 稳态有效样本少于 `1 MB` 时判定为失败；
- 下载内容只读取响应流并统计字节数，不保存到磁盘。

默认和可选测速源：

```text
Cloudflare: https://speed.cloudflare.com/__down?bytes=...
GitHub:     https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-linux-arm64-jetpack5.tar.zst
自定义:     仅允许 HTTPS URL
```

Cloudflare 源通过 `bytes` 参数请求指定大小；GitHub 和自定义源使用 HTTP `Range` 分块请求。测速源如果被节点出口拦截、返回错误页、无法提供有效响应体、不支持当前 Range 请求，或者实际收到的数据不足 `1 MB`，都会导致测速失败或样本不足。

测速期间页面会显示当前速度和峰值；窗口结束后显示稳态平均速度和峰值。若部分下载流失败但剩余流仍取得至少 `1 MB` 有效样本，结果仍可能显示为可用，同时记录 `stream-error` 和失败流数量。

这里的“并发 `20`”表示**一个节点同时开 20 条下载流**，不是 20 个节点同时测速。测速会产生真实流量，下载并发、测速时长和采样上限越大，消耗的订阅流量及本机带宽越多。

#### 4.6 出口 IP 与区域识别

延迟和测速过程中，程序会通过当前被选中的 Mihomo 节点访问多个公网 IP 查询服务，再使用多数结果确定出口 IP 和国家/地区：

- 查询服务最多 `7` 个；
- 单次出口查询超时为 `5` 秒；
- 需要形成唯一多数，结果分歧时不会强行覆盖区域；
- 出口查询失败只影响 IP、地区或服务商字段，不单独把代理节点判定为不可用。

这里识别的是**实际通过被测节点出去的出口地址**，不是节点入口 IP，也不是节点名称中的地区文字。不同数据库存在差异时，页面可能显示为空或保留已有区域，不能把 GeoIP 地区当作协议可用性的证明。

#### 4.7 页面状态与错误含义

测试结果分为两层：

- `TCP reachable`：入口 TCP 可达；
- `proxy available`：Mihomo 已完成代理层测试；
- `unavailable`：代理握手、目标访问或测速过程失败；
- `unsupported`：节点类型或字段组合不在当前 Mihomo 测试边界内；
- `core-unavailable`：Mihomo 内核无法准备或启动。

页面最终优先展示代理层结果。因此“端口通但代理测试失败”会显示为测试失败并使用红色标记，而不是把 TCP 成功误显示成节点可用。

对应实现位于：

- [TCP 预检](apps/web/src/lib/node-test/tcp.ts)
- [测试调度与并发](apps/web/src/lib/node-test/server.ts)
- [Mihomo 协议、延迟和测速](apps/web/src/lib/node-test/mihomo.ts)
- [Mihomo 节点字段校验](packages/core/src/mihomo/proxy-sanitizer.ts)
- [测速目标构造](apps/web/src/lib/node-test/speed-target.ts)
- [节点测试 API 参数边界](apps/web/app/api/node-test/route.ts)

## 快速开始

### 环境要求

- macOS / Linux，arm64 或 x64（Linux x64 自动选择 compatible 内核）
- Node.js `>=22.19.0 <23` 或 `>=24.0.0`，服务器建议 Node.js 24 LTS
- npm（使用仓库中的 `package-lock.json`）

首次执行节点测试时，应用会下载并校验适用于当前系统的 Mihomo 内核，缓存到 `apps/web/data/mihomo/`。Linux 必须在 Linux 上执行 `npm ci` 和构建，不要复用 macOS 的 `node_modules` 或内核缓存。

```zsh
git clone https://github.com/lonnnnnng/subboost-lite.git
cd subboost-lite
npm ci
npm run dev
```

浏览器打开 [http://127.0.0.1:3010](http://127.0.0.1:3010)。

### 生产模式

```zsh
npm run build
npm start
```

默认仍只监听 `127.0.0.1:3010`。局域网服务器可指定监听地址、端口和允许的页面来源：

```sh
SUBCONVERT_HOST=192.168.1.2 PORT=9999 \
SUBCONVERT_ALLOWED_ORIGINS=http://192.168.1.2:9999 npm start
```

浏览器打开 [http://192.168.1.2:9999](http://192.168.1.2:9999)。不需要数据库或登录；只用于可信局域网，不要直接映射到公网。HTTP 页面复制 YAML 使用传统兼容路径，受浏览器策略限制时仍可下载文件。

Linux 安装/更新入口：[部署脚本](deploy/linux/install.sh)。支持只读预检、独立发布目录、非 root 服务、开机自启、HTTP 健康检查和启动失败恢复；更新保留现有环境及可选 TUN 配置。

macOS 源码打包上传、Linux 构建、首次安装、更新回滚和已有 TUN 的完整命令见 [Linux 部署指南](docs/linux-deployment.md)。不需要把私有仓库凭证保存到服务器。

### 使用外部 Mihomo 内核

离线环境或需要固定内核版本时，可以显式指定兼容当前系统的可执行文件：

```zsh
SUBCONVERT_MIHOMO_PATH=/absolute/path/to/mihomo npm run dev
```

也可以使用 `SUBCONVERT_MIHOMO_DIR` 修改自动下载内核的缓存目录。

## 安全与隐私

- 订阅导入和节点测试 API 默认只接受本机同源请求；局域网部署通过 `SUBCONVERT_ALLOWED_ORIGINS` 显式允许完整来源（包含协议及端口，多个来源用英文逗号分隔）。不信任 `X-Forwarded-Host`，不开放跨站调用；该来源检查不是身份认证，可信局域网之外需要额外访问控制。
- 订阅抓取会校验公网目标并固定已核验 IP，重定向后会重新检查，降低 SSRF 与 DNS rebinding 风险。
- 默认严格验证 TLS。只有证书错误且返回内容确实能解析出节点时，才允许用户在弹窗中人工决定是否加入。
- 忽略证书错误不会把站点变得可信；审核前应检查 URL、节点内容和订阅来源。
- 订阅内容、节点列表和模板不会写入业务数据库，也不会自动上传到第三方服务。
- Mihomo 内核及其版本元数据属于本地工具缓存，不包含订阅内容。
- Linux 部署后，订阅抓取、TCP、代理延迟和下载测速由服务器执行，结果反映服务器网络。宿主机的全局代理/TUN 也可能影响结果，部署前必须确认路由；可用独立账号的专用路由隔离，不能因此关闭公网目标校验。

## 项目结构

```text
subboost-lite/
├── apps/web/                   # Next.js 浏览器工作台与本地 API
│   ├── app/api/import/         # 订阅抓取、证书异常审核候选
│   ├── app/api/node-test/      # 流式节点测试接口
│   └── src/lib/node-test/      # TCP、Mihomo、出口地区与测速实现
├── packages/core/              # 协议解析、规则模块、配置与 YAML 生成
├── packages/server-core/       # 订阅导入、兼容性与安全校验
└── docs/assets/                # README 图片资源
```

## 开发检查

```zsh
npm run typecheck
npm run lint
npx vitest run apps/web
npm run build
```

根目录的 `npm test` 当前执行 TypeScript 检查与生产构建。

## 与完整 SubBoost 的区别

此项目刻意移除了：

- 用户、登录和权限系统
- Prisma 及业务数据库
- 已保存订阅、访问 Token 和定时刷新
- 管理后台、模板广场及服务端模板存储
- 桌面客户端封装

如果需要多用户、持久化订阅或在线服务能力，请使用上游 [SubBoost](https://github.com/SubBoost/subboost)。

## License

项目基于 SubBoost 的核心代码精简而来，继续遵循 [GNU AGPL-3.0-only](LICENSE)。
