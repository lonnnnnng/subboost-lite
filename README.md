# SubConvert Lite

SubConvert Lite 是从 [SubBoost](https://github.com/SubBoost/subboost) 精简出的本地文件式 Clash/Mihomo 配置转换工作台。

## 保留功能

- 订阅链接、Clash/Mihomo YAML、节点连接导入
- 多来源节点聚合与常见协议解析
- 轻量、日常、高级三套内置规则模板
- MetaCubeX MRS 规则源镜像选择（GitHub Raw、jsDelivr、CF、自定义）
- 国内域名增强、AI 细分/聚合、AdRules 增强广告开关
- 按模块自定义规则模板，JSON 文件导入/导出
- YAML 与代理组拓扑双预览
- 基于多份本地 MMDB 的节点 GeoIP 区域识别与批量命名
- 直接下载生成的 YAML 配置

## 已移除

- 数据库、Prisma、账号与登录
- 已保存订阅、订阅 token、定时刷新
- 后台管理、模板广场和服务端模板存储

所有输入只存在于当前浏览器页面内。模板通过 JSON 文件保存，配置通过 YAML 文件下载；服务端只处理订阅抓取和 GeoIP 查询，不保存订阅内容。GeoIP 数据文件缓存在 `apps/web/data/geoip/`，不使用业务数据库。

## GeoIP 数据

服务启动时自动下载并定期更新以下本地 MMDB，节点名称不会参与区域判断：

- [MetaCubeX meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) `country.mmdb`
- [Loyalsoldier geoip](https://github.com/Loyalsoldier/geoip) `Country.mmdb`
- [P3TERX GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) `GeoLite2-Country.mmdb`

域名节点先通过本机 DNS 解析为 IP，再由可用数据库投票确定国家或地区。缓存默认每三天检查更新，可通过 `SUBCONVERT_GEOIP_DIR` 指定数据目录。

## 本地运行

要求 Node.js `>=22.13.0 <23` 或 `>=24.0.0`。

```zsh
npm install
npm run dev
```

打开 <http://127.0.0.1:3010>。

## 检查

```zsh
npm run typecheck
npm run build
```

## 许可

本项目复用了 SubBoost 的核心解析与生成代码，继续使用 GNU AGPL-3.0-only 许可。详见 [LICENSE](./LICENSE)。
