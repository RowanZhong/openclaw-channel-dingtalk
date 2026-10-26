# 评价与上报六项修复验收

日期：2026-10-26。被修复基线 `62d95592365363ae021c1e58f0521c181077156f`，旧版仓库交付分支 [`codex/feedback-http-reporting`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/codex/feedback-http-reporting)；部署时固定包含本修复的实际提交及下方构建摘要。保持 OpenClaw **2026.7.1-2**，第 6 条不适用、不调整版本要求。卡片模板及代回复助手未修改。

## 1. 修复范围

| 问题 | 最终行为 |
| --- | --- |
| 1、7：等待任务占用容量 / 恢复扫描放大重试延迟 | 128 就绪队列与 1024 延迟索引分离；普通已知任务直接到期处理。新评价优先取出，可提前唤醒；索引溢出只丢内存位置，通过持久记录和节流扫描恢复 |
| 2：详情全会话读取与物化 | 鉴权后单并发只读 Worker，先等上报 Worker 退出；8 MiB 总转录 / 128 KiB 正文 / 128 MiB JS 老生代 / 10 秒，支持取消；只返回核实问答或明确状态 |
| 3：超长行误判终态 | 超 1 MiB 行缓冲为 pending/resource_budget；真实损坏仍 unverified。旧 invalid_transcript 有一次受限复核；未 ACK 原样重试，确认后新版本纠正，stale 不纠正 |
| 4：账号预算切换假失败 | 堆预算双向变化正常重建，不进入错误退避；等待退出期间前台/停止优先，保留实际预算上限检查 |
| 5：stale 残留正文 | 合法 stale 清除本地正文、保留 superseded 与 delivered 区别；旧孤立 outbox 也在 Worker 内清理。真实新评价重新核验，不复用旧正文 |

维护标记 `maintenanceVersion=2` 只存在本地状态/回执，不进入 HTTP Schema。现有 v1 接收服务无须改接口或建表；需要允许既有规则下的更高 revision 正文更新。

## 2. 最终自动验证

- 全量：**147 个测试文件、1514 项通过**。
- TypeScript 类型检查、类型声明构建、runtime 构建、安装包检查通过。
- lint：0 错误，保留 90 条基线警告。
- 文档构建、死链检查、git diff --check 通过。
- 本功能模块格式检查通过；仓库总 format:check 仍报告与 62d9559 完全相同的 33 个既有文件格式问题，未将无关全库重排混入本修复。
- 包验证要求同时包含 `dist/feedback-reporting-worker.js` 与 `dist/feedback-detail-worker.js`。

新增 56 项定向测试，覆盖：128 pending 释放位置、1024 索引上限与较早期限保留、溢出不删源数据、账号/目的地隔离、旧回执不延迟新源版本、并发新提示保护、无扫描的到期重试、维护恢复、Worker 双向预算变化、退出竞争、真实故障与取消区分、详情权限/单并发/超时/取消、JSONL 长行、SQLite 有界分页契约，以及旧误判和 stale 的迁移顺序。

其中两项使用**真实 Worker 和本机 HTTP 接收器**，分别准备 128 / 1025 条持久化、已 ACK 的 pending。新评价均上报成功；128 条全部进入就绪状态时，新评价仍是第一条请求；1025 条场景到期任务直接处理，没有再次调用目录扫描。

## 3. 旧版真机验收

实际宿主：OpenClaw `2026.7.1-2 (0790d9f)`。先构建 runtime，再启动独立测试配置的 18961 网关，探测 running/connected 后测试。接收器仅监听本机 19072；测试评价及索引使用临时目录，实际转录文件由宿主按 Agent 存储规则生成。

| 用例 | 结果 |
| --- | --- |
| 128 条合成 pending 积压恢复 | 网关真实恢复日志 ready=0、waiting=128、overflow=false |
| 新问题 F6-2 与点赞 | 真实模型回答“【F6-2】积压不阻塞新评价。”；精确引用 linked，接收端 available 问答一致 |
| 点赞发送耗时样例 | 首轮本地保存 15:11:08.230，接收确认日志 15:11:09.823，约 1.6 秒；测试 idleMs=1000，不当作生产 SLA |
| 点踩并提交原因 | 最新状态 dislike、reasons=["2"]，第 3 版保留已确认正文 |
| 撤销 | 第 4 版 none，原因清空，原问答保持 available |
| /feedback detail | 钉钉真实显示正确问题、回答、Agent 和当前评价，精确 ID 与指纹校验通过 |
| 超限详情 | 合成 9 MiB 会话由真实 IM 命令触发，返回“无法在安全读取预算内取得”的明确提示，不输出正文或无限加载 |
| 重启恢复及历史维护 | 合成旧 invalid_transcript 终态复核后以第 2 版变为 available；源记录不存在的旧 stale 清除正文，仍 superseded=true、delivered=false，没有向中心发请求 |
| 冻结构建最终复验 | 再次真实点赞第 5 版、撤销第 6 版；接收端 none / available，详情仍准确展示原问答及已撤销状态 |

首条 F6-1 未计作完整通过：临时配置缺少 `plugins.entries.dingtalk.hooks.allowConversationAccess=true`，宿主日志明确 llm_output blocked，引用为 unavailable。补齐权限并重启后 F6-2 成功。部署指引已加入这一前置条件；不把普通模型回答成功当作精确关联成功。

最终受测构建 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| dist/index.js | b318f0430d9d8be6110d3d2cabb75fc68feb29c077fd720ef418c9a198272795 |
| dist/feedback-reporting-worker.js | 77298e9261c0e9e3e06ad2f9c593a720af7de17d3c927b80aaf3ae9695b85bf1 |
| dist/feedback-detail-worker.js | 73abdaddd801b85cf536ce8b47c0ab13919690cf2e0c02ee95c7d4703f5e1416 |

## 4. 性能观察与限制

本轮为 macOS 上 Node 26.8.1 的隔离模块探针，使用真实旧版 SDK 和实际新 Worker。以下是单次样例，不是 P95/P99、LLM 首 token 或公司 Kubernetes/PVC 的测量。

| 样例 | 详情总耗时 | 主线程堆峰值增量 | 结果 |
| --- | ---: | ---: | --- |
| 基线，小转录 | 1.20ms | 0.24MiB | 全量读后返回问答 |
| 修复，小转录 | 16.25ms | 0.17MiB | Worker 返回核实问答 |
| 基线，含无关 24MiB 行 | 22.19ms | 72.13MiB | 主线程物化大内容 |
| 修复，含无关 24MiB 行 | 15.55ms | 0.11MiB | 提前预算拒绝，返回 64 字节状态 |
| 修复，含合法 1.2MB 长行 | 18.03ms | 0.26MiB | pending/resource_budget，不误判损坏 |

小详情新增了 Worker 启动开销（样例约 15ms）；它是用户显式查询路径，不能说“零开销”。大转录的新结果为明确暂缓，不是声称在更少内存下已经读取了同一份大正文。旧记录没有可信本地提示时，Worker 懒加载 SDK 仍有更高冷启动成本，之前约 91MiB 的样例边界仍应考虑。

1025 个等待任务的合成插入后索引保持 1024 项，堆增量约 0.42MiB、插入约 3.4ms；任务身份长度和账号数会影响实际开销。原始指标位于 `docs/assets/feedback-fixes-2026-10-26/`。

本轮没有重新安装临时 Kubernetes 环境。2026-10-25 的同规格 Pod 压力数据属于旧基线，不能冒充本次修复后已复测的生产性能。仍应在公司真实 PVC/资源争抢环境灰度监测。资源限制与异步 Worker 不构成任意负载下绝对零延迟/OOM 的保证。

## 5. SQLite 与版本边界

保留旧版最低要求 `>=2026.7.1-2`。已对照官方 2026.10.7 的公开 raw-delta API 实现能力探测适配，接口契约测试覆盖分页、总量、重置、身份和指纹，但未在该新版真实 SQLite 宿主上验收。目标新版缺有界 API 时明确暂缓；不调用全量 hydration 兜底，不修改宿主数据库。

## 6. 交付与环境恢复

部署、接口、功能说明、新版复用指南已同步。卡片模板无改动；原 HTTP Schema 不变。日常网关恢复 connected，日常与旧版原配置 SHA-256 均未改变。测试接收器/网关已停止；截图与含身份的原始状态仅在本机私有验收目录保存，公开材料只包含合成指标及去身份化结论。

本实现基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。
