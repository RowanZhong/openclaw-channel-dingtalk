# 评价 HTTP 上报文档同步检查

日期：2026-10-25。范围为旧版兼容仓库当前 `codex/feedback-http-reporting`。本轮校正文档及文档资产的打包约束，不改变业务运行时或卡片模板；随 HTTP 上报功能一并交付。

## 检查结论

部署、配置、新版复用指南先前已加入上报内容，但仍残留基础评价阶段的个别绝对表述；原 OpenAPI 主要列结构，缺逐字段说明和完整请求示例。本轮逐项与 `feedback-reporting-{config,protocol,content,worker,service,transport}`、`feedback-transcript-content`、转录 tracker、接收器及 SQL 对照后补齐。

| 材料 | 同步结果 |
| --- | --- |
| `docs/user/getting-started/card-feedback-deployment.md` | 区分模板首次部署与仅升级上报；补接口阅读顺序、新打包资产、后台读取/容量/回滚边界 |
| `docs/user/features/feedback-http-reporting.md` | 全部 11 个配置字段、SecretInput 子字段/provider 示例、凭据缓存和轮换、正文终态、目的地迁移 |
| `docs/user/reference/feedback-reporting-api.md` | 独立中文对接手册：逐字段、类型/必填/条件、单位/ID、哈希、状态/原因、HTTP/ACK、事务、数据映射、运维和联调 |
| `docs/user/reference/feedback-reporting.openapi.json` | 43 处属性定义有 description；available 必填正文/hash，非 available 或 preserve 不携带问答；嵌入完整示例 |
| `docs/user/reference/feedback-reporting-examples.json` | 7 份完整合成请求、3 种 ACK；稳定 ID 与文本哈希真实计算，无员工数据 |
| `docs/user/reference/feedback-reporting-oceanbase.sql` | 明确 preserve 无原记录应拒绝、request_hash 算法与不可变关联；生产 SQL 尚待公司验收 |
| `docs/spec/card-feedback-reuse-and-storage-design.md` | 补公共正文解析模块、基础回调直接导入的 config/events、Worker 接线与资产；区分基础 SQLite 接口核对与尚未实现的有界上报适配 |
| `docs/user/features/card-feedback.md` | 修正“只有 detail 才读转录”“不复制全文”的适用范围，说明上报 outbox 暂存正文 |
| 配置参考、用户首页与侧栏 | 增加配置/接口导航；用户无需通过源码猜测文档入口 |
| package.json / 包校验脚本 / 对应既有测试 | 强制交付中文接口手册与示例 JSON |

## 语义补全重点

- linked 不代表转录现在还在；reference_not_recorded 不代表文件被删除。
- accountId、Pod 逻辑 instanceId、questionerUserId 是不同身份；群内提问者可不是实例员工。
- 同版本请求必须一致；撤销为 none，不累计票；pending 补正文也能递增版本。
- available/missing/unverified 已确认后均为正文终态；不是再次点赞就重新采集。只有 pending 定期复查。
- 仅 HTTP 200 严格 ACK 有效，202/204 不算成功；非 200 仍重试，当前不读取 Retry-After。
- 中心只有被评价卡片，不能单靠此表计算全部回答的评价率。
- env 凭据轮换需进入网关实际进程环境；中心失库后 preserve 不能空建行并确认。
- 基础评价、HTTP 最新快照同步和未来数据库主存储替换是不同能力，避免将未来多表草案写成第一版必建表。

## 验证

- 使用已安装 Ajv 8 的 JSON Schema 2020-12 校验全部 7 请求、3 ACK；4 个反例（缺正文、null 正文、额外 localFile、缺顶层 hash）按预期拒绝。
- 43 个属性定义均有逐字段描述；示例集合与 OpenAPI 内嵌示例一致，recordId 和 answerHash 逐一核对。
- 启动临时本机接收器，以纯合成数据执行 14 次 HTTP 契约请求：applied、duplicate、撤销、stale、409、401/403、pending 后 available、missing、unverified、503，全部通过；最终 none 且正文保留。接收器已停止，临时数据清理。
- 文档站构建及死链检查通过；运行包资产检查通过；既有打包测试 3 项通过；`git diff --check` 通过。
- 此次为文档/契约验收，不重启实际 OpenClaw 或操作钉钉；之前 1458 项全量与真机/Pod 压力结果保留原测试范围，见上报验收文档。

未覆盖项仍明确保留：公司 OceanBase 实连与生产 PVC、新版 SQLite 有界读取及新版真机。没有因文档补齐而将这些项目标成已通过。

本材料基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。
