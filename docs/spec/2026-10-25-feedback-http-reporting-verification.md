# 评价 HTTP 上报：实现及验收记录

日期：2026-10-25。代码位于旧版 `openclaw-channel-dingtalk-v3.6.11`，分支 `codex/feedback-http-reporting`，基线 `6da056b1cc1ca720ce3f9e19308c3e4dd2e28d68`。交付时以该分支实际提交及下方构建摘要核对版本。宿主真机版本为 OpenClaw `2026.7.1-2`。未修改卡片模板、代回复助手或 OpenClaw 核心。

## 1. 实现与性能约束

- 默认关闭；只同步发生过本人有效评价的卡片及其对应一问一答，中心保存最新状态。
- 点击路径沿用原有本地持久化，版本元数据同次写入；不等待网络、不读取转录、不新增第二次评价文件落盘。
- 单个按需 Worker 完成有界转录读取、消息 ID/角色/来源/指纹校验、请求序列化和 HTTP。独立线程不等于独立资源，仍可能竞争 CPU/内存。
- 可信宿主的前台活动会终止 Worker；空闲后重新处理。无任务时调度器休眠。内存队列最多 128，持久源记录可恢复。
- Linux cgroup v2 CPU 压力、限流、内存及事件循环延迟触发退让；资源不足时优先延后同步。
- 耐久 outbox 在发送前写入；严格持久化 ACK、重复幂等、旧版本拒绝覆盖。收到 stale 不将旧状态自动抬高版本；真正的新评价才形成新版本。
- 正文缺失、校验不通过和预算不足分开表达。收到 available 后，后续评价通过 preserve 保留中心正文。

配置、OpenAPI、状态机及运维限制见[上报说明](../user/features/feedback-http-reporting.md)。OceanBase 4.2.5.7 MySQL 参考 DDL 由公司接收服务使用，本次未连接公司数据库。

## 2. 自动验证

最终全量：**141 个文件、1458 项测试通过**；TypeScript、lint（0 错误，保留原有警告）、runtime/types 构建及包资产检查通过。新增用例涵盖配置、并发版本、撤销、队列上限/丢通知恢复、ACK 后新变化竞态、stale 语义、超时、大小限制、重定向、错误 ACK、正文缺失/校验、前台抢占和重启恢复。

受测最终构建 SHA-256：

| 资产 | SHA-256 |
| --- | --- |
| `dist/index.js` | `d2be22eb0245c07c78e0be5157439589144d52d03fb48013c466b0ae5611dd8d` |
| `dist/feedback-reporting-worker.js` | `635fc790a9ec5ea7dba388440a193cfc880afb670ef0ee45cb4ffc5c8fe2f214` |

代码后续改动需重新记录摘要，不能把分支名当作不可变版本。历史基础精确关联的 1420 项与 224 字节估算仍属于此前功能，不代表本次上报成本。

## 3. 真机验证

使用独立旧版测试配置和状态目录，构建后启动端口 18961，先探测 running/connected，再使用真实钉钉客户端入站与卡片点击。HTTP 接收器仅监听本机 19071，保存文件模拟事务提交；没有把员工数据发送到外部服务器。

| 场景 | 实际结果 |
| --- | --- |
| 既有 R14 卡片点赞 | 本地评价、HTTP 接收状态一致；按精确引用找到对应问题和回答，指纹通过 |
| 接收端返回 503 | 钉钉点踩及原因仍保存，待发请求保留并退避 |
| 接收端延迟 10 秒 | 5 秒请求期限生效；继续切换、撤销、再点赞，本地保持最新状态 |
| 故障期间新问题 FHTTP-1 | 正常收到真实模型回答“前台回复正常。”；未评价，不进入接收库 |
| 接收端恢复并重启网关 | 无需再次点击，重启恢复补传 R14 的最新 revision=5、vote=like，保留已确认正文 |
| 最终构建新问题 FHTTP-2 | 真实模型回答“最终上报验收通过。”；点赞后 revision=1，原问题与该回答完整一致 |
| FHTTP-2 撤销 | revision=2、vote=none；正文 mode=preserve，接收端原问答保持一致 |
| 本地路径隔离 | 新记录存在可信 localFile 提示；HTTP 报文中没有 localFile 或本地路径 |

FHTTP-1 证明报告端故障不阻止真实聊天；当次 HTTP 超时发生在该新消息入站之前，**不作为“请求正在等待时恰好入站”的计时证明**。确定性活动抢占另外通过测试及下述 slow 场景验证。真实客户端页面与接收数据均核对，未将日志输出单独当作真机通过。

原始日志/截图含账号或会话信息，仅保留本机验收证据，不提交公开仓库。

## 4. 隔离 Kubernetes 实测

经用户授权临时安装官方 Lima 2.2.1，Ubuntu 24.04.5 ARM64 / Linux 6.8.0-147 / K3s v1.37.1+k3s1。VM 为 4 vCPU、10 GiB 内存，无 Mac 家目录或项目挂载。测试 Pod 使用 Node 22.23.4，加载实际上报模块、真实旧版公开 SDK helper、本地合成问答及独立接收线程。

资源配置与用户提供值相同：requests `cpu: 50m, memory: 100M`；limits `cpu: 4, memory: 8G`。实际 cgroup：`cpu.max=400000 100000`、`cpu.weight=11`、`memory.max=8000000000`。**requests 是调度申请和竞争权重，既不是 50m CPU 硬上限，也不是 100M 内存上限。**

探针每 10ms 进行小型前台事件循环任务；评价场景每秒 4 次本地操作，24 张合成卡片积压。数据在 [原始指标目录](../assets/feedback-reporting-2026-10-25/)。这是模块 A/B 测试，未模拟公司 Agent Gateway、生产 PVC、15,000 Pod 并发或 LLM 首 token 延迟。

### 常规 A/B（20 秒）

| 场景 | 探针延迟 P99 | 评价落盘 P95 / P99 | CPU 累计 | RSS 峰值 |
| --- | ---: | ---: | ---: | ---: |
| 关闭上报，空闲 | 5.253ms | — | 675.8ms | 125.49MiB |
| 开启上报，空闲 | 5.109ms | — | 1031.7ms | 145.59MiB |
| 关闭上报，持续评价 | 5.273ms | 8.104 / 12.704ms | 843.0ms | 126.14MiB |
| 开启上报，持续评价 | 5.241ms | 7.860 / 9.350ms | 856.9ms | 126.59MiB |

新记录快路径的空闲 RSS 相比自身初始值增加约 19.6MiB。持续评价时上报主动延后，Worker/HTTP 均为 0；较低延迟样本不能解读为功能提升性能。CPU 指整个探针进程累计（含测试接收线程），不是生产网关独立增量的精确分解。

### CPU 争抢（两轮）

另起同节点 4 个 busy-loop 的合成 Pod，与受测 Pod 竞争 4 vCPU。

| 场景 | 前台探针 P99（两轮） | 评价落盘 P95（两轮） | 上报行为 |
| --- | ---: | ---: | --- |
| 关闭上报 | 5.031 / 4.990ms | 28.941 / 29.003ms | — |
| 开启上报 | 4.978 / 4.996ms | 26.918 / 29.932ms | 两轮均 0 Worker、0 HTTP，扫描停止、调度器休眠 |

评价 P99 有较明显调度/I/O 波动，不能据两次测量声称更快。可确认的是本轮开启后无额外后台工作与明显前台 P99 退化。独立空闲压力用例也未启动 Worker/HTTP，等待资源恢复。

### 故障与恢复

- `slow`：第一次 HTTP 请求到达后触发前台运行，Worker 被终止，前台期间无常驻/活动 Worker，调度器关闭；探针 P99 5.199ms。
- `large`：9MiB 转录超过默认 8MiB 预算，只上报 pending 元数据，不物化整个转录；P99 5.145ms。
- `legacy`：旧记录无 localFile 提示时需在 Worker 懒加载 SDK。10 秒样本初始 RSS 123.19MiB、峰值 213.75MiB，**临时增加约 90.6MiB**；不能只报新记录约 20MiB 的快路径成本。探针 P99 5.197ms，最大 21.101ms。
- `pressure-recovery-complete`：前 15 秒压力下 0 Worker/0 HTTP；解除合成压力后，120 秒窗口内 24/24 条自动确认，队列清空、Worker 回收、调度器休眠，P99 2.983ms。此前一次恢复测试因压力 Pod 退出宽限期超过短观察窗口而未补传完，延长窗口并确认压力容器退出后复验通过；不将不完整样本算作通过。

本轮实测支持“前台不等待上报、压力时退让”。**不能保证任意负载下绝对零延迟或零资源占用。** Worker 与宿主共享进程/操作系统资源；上报可能延后，超出保留期不保证补传。老记录 SDK 冷启动和大量短小文件尤其应在公司真实 PVC 上灰度。

## 5. 复现方法

在源码目录构建开发探针（不包含员工配置或凭据）：

```bash
node scripts/build-feedback-benchmark.mjs
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --scenario ratings --seconds 20
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --enabled --scenario ratings --seconds 20
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --enabled --scenario idle --seconds 20
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --enabled --scenario idle --legacy --seconds 10
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --enabled --scenario slow --seconds 10
node .tmp/feedback-reporting-benchmark/feedback-reporting-benchmark.mjs --enabled --scenario large --seconds 10
```

隔离 Linux Pod 中将输出目录复制到 `/work`，在该目录安装 `openclaw@2026.7.1-2`、`zod@4.4.3`（`--ignore-scripts --omit=optional`），使用上述资源配额运行相同命令。不要复制真实状态卷、token 或 auth 文件。Worker 文件必须紧邻探针；若从其他目录加载，用 `--worker /absolute/path/feedback-reporting-worker.js`。

CPU 争抢可在专用测试节点部署 4 个 busy-loop 的临时 Pod；先确认 Ready，再运行 foreground A/B。恢复测试运行 `--enabled --scenario idle --seconds 120 --checkpoint 15000`，在第 20 秒停止压力容器，核对 checkpoint 为 0 请求、最终确认 24 条。必须确认压力进程确实退出，而不是只看 Pod 删除请求已接受。不要在员工生产节点创建压力负载。

## 6. 清理与未覆盖边界

测试结束恢复日常网关；原日常与旧版配置 SHA-256 核对不变。临时接收器、测试网关、CPU 负载、K3s、VM 与下载缓存由本次任务清理，测试数据不混入真实配置。

公司生产 OceanBase 事务执行、AMD64/其他内核、生产 PVC 和新版 SQLite 的有界正文读取未实测。SQLite 读取适配未实现时本增量安全降级为 pending，不使用主线程全会话读取；这不影响此前手动 detail 的公开接口适配。迁移新版必须重新做相应验收。

本实现基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。
