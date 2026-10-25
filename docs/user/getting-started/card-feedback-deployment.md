# AI 卡片点赞点踩：完整部署与升级指引

适用对象：维护 OpenClaw `2026.7.1-2` 与社区钉钉插件旧版兼容分支的开发、平台和运维人员。本文针对 **AI 流式回答卡片的评价功能**，与独立的代回复助手无关。

核对日期：2026-10-25。本次 HTTP 上报增量的交付分支为个人仓库的 [`codex/feedback-http-reporting`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/codex/feedback-http-reporting)，以 `6da056b` 为基线；部署时使用经审阅并固定 SHA 的实际交付构建。基础评价源码分支为个人仓库的 [`codex/card-feedback-recording`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/codex/card-feedback-recording)，开发基线为 `9db293b`（基线本身不含本功能）。本改造尚未发布到上游 npm，`package.json` 仍标记 `3.6.11`；**普通更新上游同名插件不能保证拿到本功能，不能只用版本号识别构建产物。** 分发前应固定已审阅源码、内部构建号及产物 SHA-256。

## 1. 是否只更新插件就够了

首次部署需要同时满足四项：

1. 加载包含本改造的插件运行时。
2. 配置 `messageType: "card"`、`feedbackEnabled: true`。
3. 实际使用的模板开启赞踩，并回传 **`feedback_vote`**。
4. 网关使用正确模板 ID，且反馈数据目录位于可写、持久的员工状态卷。

插件升级不会自动修改钉钉开放平台模板。模板已经符合要求、插件配置和持久卷也已准备好时，后续代码升级才可以只换插件构建并重启。

### 按当前部署状态选择升级路径

| 当前状态 | 本次需要做什么 |
| --- | --- |
| 尚未部署本分支评价功能 | 按全文部署：指定构建、开关、模板及持久化路径都要核对 |
| 已部署本分支赞踩统计，尚未包含精确问答关联 | 更新到包含 `feedback-transcript` / `feedback-detail` 的构建并重启；沿用符合 `feedback_vote` 协议的模板和现有配置，无须再改模板 |
| 已部署精确关联，需集中入库 | 更新包含 `feedbackReporting` 的构建及独立 Worker 资产，按第 10 节配置公司接收服务；沿用原评价模板 |
| 不需集中入库 | 保持 `feedbackReporting.enabled: false`（默认）；按第 9 节复验 |

旧记录和已有投放卡片不会在升级后自动补写转录 ID；精确反查应使用升级后新建并正常完成的回答卡片。基础评价与精确关联的回归为 1420 项；加入 HTTP 上报后的最终全量回归为 **1458 项通过**，真实同文回答隔离、点踩反查、重启及撤销均已验收；新版仓库尚未实施迁移，不能据此宣称新版宿主已通过。

### 已有模板如何处理

| 现有情况 | 应采取的操作 | 模板 ID 是否变化 |
| --- | --- | --- |
| 自己可编辑的 V2 AI 流式模板，已有原生“操作区 / Feedback” | 修改三个设置并保存；如平台要求发布版本，按该模板的发布流程生效 | 通常保留，仍需核对平台返回值 |
| 已发布，平台允许在同一模板下创建新版本 | 更新版本中的同类设置，按平台流程发布并确认生效 | 以平台实际版本机制为准 |
| 原作者共享模板、无编辑权限，或已发布且不能编辑/升级 | 创建自己管理的新模板，导入随插件交付的 `card-template-v2.json` | 变化，需要更新网关环境变量 |
| 现有自定义模板没有原生 Feedback 组件，或变量协议不同 | 保留旧模板备份；优先新建并导入已验证的 V2 模板。若必须保留自定义布局，需要开发适配后验收 | 使用新模板则变化 |
| 模板已开启显示，Action ID 已是 `feedback_vote`，且真实回调测试通过 | 无需再次替换模板 | 不变 |

不需要删除旧模板。不要覆盖原作者共享模板，也不要仅为了启用评价重做整张流式卡片。

## 2. 发布前准备

- 备份现有插件构建、OpenClaw 配置、服务环境变量及旧模板导出文件。
- 确定实际运行的 OpenClaw 二进制、配置路径、状态路径、插件加载目录和钉钉 `accountId`。
- 使用仓库要求的 Node / pnpm 版本构建。当前 `package.json` 要求 Node `>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`，pnpm `10.33.0`。
- 钉钉应用已有正常的 Stream 机器人收消息能力、卡片创建/流式写入及机器人发送权限；应用可使用选定模板。沿用[钉钉权限与凭证](./permissions.md)，不因本功能额外开放用户数据权限。
- 模型能正常回答，避免把认证失败提示当作功能验收答案。
- 验收时让测试消息和卡片回调由受测实例接收；使用独立测试应用最容易排除同应用其他实例的分流干扰。

**默认内置模板不会被本补丁在平台上自动更新。** 未设置环境变量时，此旧版默认 ID 是 `675cde2f-f526-40cb-b828-f5b2b57b8b77.schema`，来自 `src/card/card-template.ts`。需要使用具备 `feedback_vote` 事件且实际应用有权使用的模板；不能假定有权限修改共享的预置模板。

## 3. 构建并交付正确的插件

### 3.1 生成内部安装包

在包含本改造的源码目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run pack:check
npm pack --ignore-scripts
```

`pnpm run build` 同时生成运行时和类型声明。归档应包含：

```text
package.json
openclaw.plugin.json
dist/index.js
dist/index.d.ts
dist/feedback-reporting-worker.js
docs/user/features/feedback-http-reporting.md
docs/user/reference/feedback-reporting-api.md
docs/user/reference/feedback-reporting-examples.json
docs/user/reference/feedback-reporting.openapi.json
docs/user/reference/feedback-reporting-oceanbase.sql
scripts/feedback-reporting-receiver.mjs
docs/assets/card-template-v2.json
docs/user/features/card-feedback.md
docs/user/getting-started/card-feedback-deployment.md
scripts/feedback-export.mjs
```

保存归档及 `dist/index.js` 的 SHA-256。由于包内版本号暂未更改，建议通过唯一内部构建号或镜像 digest 分发，避免同名 `3.6.11` 产物被缓存或混用。本文不表示该构建已经发布到上游仓库或 npm。

### 3.2 已使用本地源码/链接安装

在原插件加载路径换入本次源码，重新构建，再重启实际使用该路径的网关：

```bash
pnpm install --frozen-lockfile
pnpm run build
openclaw plugins list
openclaw gateway restart
```

不要只修改 `src/` 而不构建。此旧版真机加载的是 `dist/index.js`。

### 3.3 安装内部 tgz

以下命令是本机 `2026.7.1-2` CLI 帮助中核对过的安装入口。将归档路径换成实际内部产物路径：

```bash
# 首次安装
openclaw plugins install /path/to/dingtalk-feedback-build.tgz

# 替换已有同 ID 插件：先确认备份和目标目录
openclaw plugins install --force /path/to/dingtalk-feedback-build.tgz
```

若使用 `plugins.load.paths` 明确选择了另一个源码目录，安装 tgz 不一定改变实际加载来源；必须一起核对加载路径。保留其他插件及其信任配置，不要将原有 `plugins.allow` 整个替换成只有 `dingtalk` 的数组。

### 3.4 Kubernetes 镜像交付

在公司原有插件镜像构建流程中替换插件产物，并沿用原有依赖安装与运行用户配置。检查容器内实际插件目录的运行时 SHA-256；不要因为镜像里有新源码，就假定挂载的旧扩展目录已经失效。

如果状态 PVC 覆盖了 `~/.openclaw/extensions`，只更新镜像中的同名目录可能不会更新实际运行插件。可将完整插件产物和生产依赖放在镜像内固定的 `/opt/openclaw-plugins/dingtalk`，并在已有配置中显式选择：

```json5
{
  plugins: {
    load: { paths: ["/opt/openclaw-plugins/dingtalk"] },
    entries: { dingtalk: { enabled: true } },
  },
}
```

这只是相关字段示例；保留已有的其他加载路径和条目，并避免旧、新两个同 ID 插件同时成为候选。产物应带有可解析的生产依赖，不能照搬指向构建机目录的失效依赖链接。

不建议在 15000 个运行中的员工 Pod 内逐个执行在线 npm 更新。构建一次不可变镜像，按公司发布机制分批替换实例，更容易核对版本与回滚。

## 4. 在钉钉开放平台配置模板

### 4.1 复用可编辑的同类模板

打开**实际正在使用的模板**，依次设置：

1. **完成状态 → 操作区 → 属性 → 显示赞踩：开启**。
2. **同一操作区 → 属性 → 显示控制 → 显示：是**。
3. **同一操作区 → 事件 → 回传 Action ID：`feedback_vote`**。
4. 保留原生点踩原因组件和其字段协议。不要用 `feedback_up` / `feedback_down` 替换本方案的原生交互。
5. 保存，再按该模板在平台上的版本/发布机制生效。

本次本地真机在已保存、未发布的自有模板上能创建卡片并收回调；这不代表所有生产应用都能免发布、跨应用使用。生产需核实模板发布状态、授权范围及实际机器人应用的可用性。若平台提示发布后不可编辑，应先保留导出备份，并按企业流程管理版本。

### 4.2 需要新模板时

1. 在有权管理该应用模板的账号下创建自己的 AI 卡片模板。
2. 使用搭建器“导入卡片模板”导入安装包中的 `docs/assets/card-template-v2.json`。
3. 检查第 4.1 节的三个设置，并保留流式变量：`content`、`blockList`、`flowStatus`、`hasAction`、`statusLine`、`copy_content`、`quoteContent`。
4. 保存，按生产平台流程发布/授权，记录**实际返回的完整模板 ID**。
5. 将该 ID 注入网关进程环境，见第 6 节。

导入应使用完整平台导出包。它同时包含 `editorData` 和编译后的 `widgetInfo`，不能只手工修改前者而继续分发旧的后者。随包模板已对两部分做契约测试。

### 4.3 不要混淆三个“回调设置”

- 机器人收消息的 Stream 模式：钉钉应用的机器人设置。
- 卡片业务事件：模板中的 `feedback_vote`。
- 卡片投放回调模式：创建卡片 OpenAPI 中的 `callbackType: "STREAM"`，本插件已设置。

只在开发平台打开机器人 Stream，不等于卡片回调已经配置。这个区别见[钉钉官方说明](https://open-dingtalk.github.io/developerpedia/docs/learn/card/intro/)。本功能复用现有 Stream 连接，不要求新增公网 HTTP 回调地址，也不需要注册一个 `feedback_vote` 的平台事件订阅。

## 5. OpenClaw 配置

将以下字段合并进**已有的**配置，不覆盖原有凭据、访问策略、Agent 路由或其他插件。先确认插件全局开关没有禁用运行；在原 `plugins.allow` 中追加 `dingtalk`（保留其他 ID），并启用对应条目：

```json5
{
  plugins: {
    entries: { dingtalk: { enabled: true } },
  },
}
```

渠道侧的共同配置：

```json5
{
  channels: {
    dingtalk: {
      messageType: "card",
      feedbackEnabled: true,
      feedbackRetentionDays: 30,
    },
  },
}
```

- `feedbackEnabled`：默认 `false`。只有开启后新建并正常完成的关联回答可评价。
- `feedbackRetentionDays`：默认 `90`，可设 `1～365`。示例设 `30` 是容量规划起点，不是代码默认值。
- 这里只记录统计，不需要开启 `learningEnabled` 或 `learningAutoApply`。
- 多账号可以在 `channels.dingtalk.accounts.<accountId>` 下覆盖上述字段，继承规则沿用原渠道配置。
- 修改保留期只影响**随后新建的记录**；不会缩短已有记录里已经写入的 `expiresAt`。

## 6. 模板 ID 必须进入实际网关环境

当前旧版使用环境变量：

```text
DINGTALK_CARD_TEMPLATE_ID=<平台返回的完整模板ID>
```

变量值原样填写平台返回的完整 ID（通常以 `.schema` 结尾），不要重复追加后缀。`channels.dingtalk.cardTemplateId` 在这条内置 AI 流式卡片创建路径中不生效，不能只改它。变量在模块加载时读取，修改后必须重启/重建网关进程。

- 前台启动：将变量放在同一次启动命令的环境中，例如 `DINGTALK_CARD_TEMPLATE_ID='实际ID.schema' openclaw gateway run`。
- systemd / launchd：写入实际服务环境，按该服务管理方式重载并重启；另一个终端的 `export` 不会修改已运行服务的环境。
- 容器：写入 Pod `env`，再由控制器重建 Pod。ConfigMap 作为 `env` 来源时，改 ConfigMap 不会自动刷新现有进程。

该旧版模板变量是进程级配置；同一实例内多个钉钉账号共用它。`feedbackEnabled` 仍可按账号控制。不要假定一个模板 ID 可被不同企业/应用直接复用；共享是否成立取决于平台模板权限。

## 7. Kubernetes：一员工一 Pod 的部署要点

可以统一下发以下不含个人身份的配置：评价开关、保留期、插件构建/镜像、经授权可共用的模板 ID。继续使用现有员工身份和机器人凭据注入方式。

下面只是已有工作负载中需要具备的字段示例，不是要求替换整套 Deployment。容器名、PVC 名、配置生成方式均应替换为本公司的真实值：

```yaml
# 已有员工工作负载的 Pod spec 片段
containers:
  - name: openclaw
    # 使用包含本改造插件的内部不可变镜像
    image: registry.example.com/company/openclaw-dingtalk:approved-feedback-build
    env:
      - name: OPENCLAW_STATE_DIR
        value: /home/node/.openclaw
      - name: DINGTALK_CARD_TEMPLATE_ID
        valueFrom:
          configMapKeyRef:
            name: dingtalk-feedback
            key: card-template-id
    volumeMounts:
      - name: employee-state
        mountPath: /home/node/.openclaw
volumes:
  - name: employee-state
    persistentVolumeClaim:
      claimName: employee-specific-openclaw-state
```

部署必须满足：

- 状态卷属于这个员工，运行用户可写；不要把反馈数据放在镜像层、`emptyDir` 或只读 ConfigMap 中。
- 如果 `session.store` 指向另一个目录，那个目录也必须持久化。只挂载默认 `.openclaw` 并不能覆盖配置指向卷外的路径。
- 不同员工不可共用同一个未隔离的 `dingtalk-state` 路径；共享 PVC 时，必须采用稳定、隔离的员工子目录。
- 同一员工的旧、新进程避免同时写同一状态目录。当前锁是进程内锁，不支持共享目录的多写入者。
- 若一员工对应一个 Deployment，可采用 `replicas: 1`、`strategy.type: Recreate`，或无 surge 的滚动策略；如果使用自研控制器，应在控制器实现同等的单写入者约束。
- 先在少量员工实例验证，再按公司发布节奏扩展；不要一次重启全部实例制造连接与元数据 I/O 峰值。

基础评价不新增常驻进程。可选 HTTP 上报最多启动一个按需 Worker 线程，空闲回收，前台活动时退让；它不是另一个常驻进程，也不需要每员工部署数据库进程。没有修改自研 Web Channel 或 Agent Gateway 的要求。

## 8. 数据在哪里、占多少空间

### 8.1 实际路径

路径规则为：

```text
dirname(钉钉账号对应的 session storePath)/dingtalk-state/feedback.ratings.*.json
```

该旧版通过宿主 `resolveStorePath(cfg.session?.store, { agentId: accountId })` 解析存储位置。这里使用的是**钉钉 accountId**，不要直接把它当作会话实际运行的 Agent ID `main`。

默认状态根、未覆盖 `session.store`、钉钉账号为 `default` 时，典型容器路径是：

```text
/home/node/.openclaw/agents/default/sessions/dingtalk-state/
```

本次本机兼容环境的实际目录是：

```text
/Users/admin/.local/share/openclaw-compat-v3.6.11/state/agents/default/sessions/dingtalk-state/
```

### 8.2 保存的内容及增长方式

每张开启反馈后的关联 AI 卡片一个 JSON 文件，包括归属、原消息 ID、Agent/会话、完成时间、回答哈希、可用时的转录消息 ID、当前评价、原因及有界历史。**不保存问答全文，但在用户点击之前就保存归属记录。** 流式中断/失败卡片也可能留下未完成记录，只是不进入正常回答统计。

- 文件权限 `0600`；新建状态目录请求权限 `0700`，不会自动改写已有父目录权限。
- 最多 100 次状态变化和 256 个去重事件 ID；不按每次点击不断创建新文件。
- 没有总卡片数/总磁盘字节的硬配额。
- 清理在新卡片注册时触发：同一进程中，每个账号路径最多每 24 小时一次异步扫描；重启后首次注册可能再次触发。
- 统计查询也会清理过期记录。关闭功能或长期没有新卡片/查询时，过期文件可能仍留在磁盘上，不能把保留期当作每天定时删除的承诺。
- 异步清理是尽力执行，失败不阻塞回答；当前没有单独的清理失败告警。权限问题、损坏文件和异常退出留下的临时文件仍需运维关注。

### 8.3 本机测量与集群估算

基础评价阶段、尚未增加转录引用时抽样的 6 条真机记录（含未完成记录）：JSON 内容共 **4156 字节**，单文件 **404～1618 字节**；本机文件系统实际分配 **24576 字节**，即每文件一个 4 KiB 分配块。小文件的内容大小不等于 PVC 实际占用。

填满 100 条历史、256 个约 35 字符事件 ID 的合成样本约 **22 KB**；这不是硬上限，实际大小还受标识符长度影响。

估算公式：`保留文件数 ≈ 每日新建关联卡片数 × 保留天数`。下表假设每文件占 4 KiB、正常清理，未计目录/inode、较大历史记录、存储副本、快照与备份：

| 每人每日卡片 | 保留天数 | 每 Pod 文件数 | 每 Pod 分配空间 | 15000 实例文件数 | 合计分配空间 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 30 | 1500 | 5.9 MiB | 2250 万 | 85.8 GiB |
| 100 | 30 | 3000 | 11.7 MiB | 4500 万 | 171.7 GiB |
| 100 | 90 | 9000 | 35.2 MiB | 1.35 亿 | 515.0 GiB |

因此单个 Pod 通常较轻，但 15000 实例不能只看 JSON 字节数。应测量实际卡片产生率、PVC 可用量/inode、目录扫描及备份耗时。当前统计需要扫描该账号保留记录，是随记录数增长的工作量；本机 300 条记录约 17 ms 的查询结果，不能直接推算大规模共享存储的延迟。

若没有 90 天本地查询要求，可从 30 天保留期开展容量评估。上述表格仅估算基础评价记录；HTTP 上报另外产生 outbox/receipt 和未确认正文，失败期间会增长，不能把该表当作开启上报后的全部容量。需要长期集团分析时可使用第 10 节的 HTTP 同步；小文件数量优化仍需另行更换存储实现。

### 8.4 只读测量当前目录

将路径和账号改成实际值，在对应员工 Pod 内执行。脚本只输出数量和大小，不输出员工身份或正文：

```bash
FEEDBACK_STATE_DIR=/home/node/.openclaw/agents/default/sessions/dingtalk-state \
FEEDBACK_ACCOUNT=default node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = process.env.FEEDBACK_STATE_DIR;
const prefix = `feedback.ratings.account-${Buffer.from(process.env.FEEDBACK_ACCOUNT).toString('base64url')}.target-`;
let files = 0, bytes = 0, allocated = 0, allocationKnown = true;
for (const name of await fs.readdir(dir)) {
  if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
  const st = await fs.stat(path.join(dir, name));
  files++; bytes += st.size;
  if (typeof st.blocks === 'number') allocated += st.blocks * 512;
  else allocationKnown = false;
}
process.stdout.write(JSON.stringify({ files, contentBytes: bytes,
  allocatedBytes: allocationKnown ? allocated : null }, null, 2) + '\n');
JS
```

目录尚未创建时，说明该位置还没有成功保存过反馈归属；先核对实际路径和一条新卡片，不要据此把所有存储问题都判成“零占用”。

### 8.5 精确反查所需的会话数据

此次补充精确关联能力**不需要再改模板或增加配置项**。同一构建中，`feedbackEnabled` 开启时为新回答尝试捕获宿主已持久化的消息 ID；没有宿主能力或证据不足时保留评价，记录无法精确反查的原因。

反馈文件仍在钉钉 **accountId** 的存储目录。原始问答转录位于实际 **agentId** 的会话存储目录，两者可能不同。反查使用记录中的 `agentId`、`sessionKey`、实际 `sessionId` 和两条消息 ID，通过宿主公开转录读取接口定位；不能只保留 `agents/default` 而遗漏实际运行 Agent 的转录。

- 需要反查的期限内，应同时保留评价记录和对应 Agent 的转录。`feedbackRetentionDays` 不控制宿主转录清理策略。
- 旧记录不批量回填；新记录关联失败不会影响正常回答和赞踩。
- 原提问者私聊 `/feedback detail <outTrackId>`，只读取对应会话；找不到指定消息或指纹不符时不会回退到最近回答。
- 基础精确关联的典型三个 UUID 增加约 224 字节 JSON；开启 HTTP 上报后还可能增加一个本地转录路径提示及评价版本元数据，大小随实际路径变化。路径不上传，完成与评价写入仍合并在原记录中；outbox/receipt 由后台另行写入。字段增加后实际分配块可能因跨过块边界而增多，应按第 8.4 节测量。
- 本机 10000 次、8400 字符回答基准中，新增 tracker 捕获处理 P95 为约 0.0011 ms；这是新增逻辑的局部测量，不是完整回复延迟，也不等同公司 Pod 压测。新增 CPU / 临时内存并非绝对零；正常回复没有因此增加网络或模型调用。
- 关闭 HTTP 上报时，仅主动查询 `detail` 读取相应转录；开启上报后，空闲 Worker 也按精确引用有界读取被评价问答。手动查询与后台上报的成本需分别评估。
- 不依赖在每次点赞时搜索日志或读取全部会话。管理员 JSON/CSV 导出同时提供关联状态与三个 ID，字段说明见第 10 节。

## 9. 上线验收、观测与回滚

1. `openclaw plugins list` 核对实际加载来源，比较运行时 SHA-256。
2. 重启/重建进程；`openclaw channels status --probe --json` 确认 `running: true`、对应账号 `connected: true`。启动过早返回未连接时稍后再查。
3. 发一个新的真实问题，等模型正常回答。模型认证错误卡片不算验收通过。
4. 依次点赞、撤销、点踩、提交原因、互切，核对 UI 与 `[DingTalk][Feedback] ... status=saved vote=...` 一致。
5. 重启后再操作这张卡，确认评价与归属恢复。
6. 群内成员 B 提问：B 可评价，A 点击被拒绝，B 原有评价不变。
7. 私聊 `/feedback stats`；核对本人数据，错误卡片及其他人的评价不计入。群聊查询不会公开个人统计。
8. 在同一会话发两条不同问题，要求两次输出同一句固定测试答案；两张卡分别点赞/点踩。导出中两条 `answerHash` 可相同，但 `userMessageId` / `assistantMessageId` 应不同，`transcriptStatus` 为 `linked`。
9. 从导出取完整 `cardId`，由原提问者在机器人私聊发送 `/feedback detail <cardId>`。分别确认当前评价、原问题及回答准确；尤其在第二条回答出现后反查第一条，不能串到最近回答。群内执行详情命令只能提示到私聊查询。
10. 重启后反查、撤销评价后再反查：评价状态更新，原问题与回答 ID 不变。历史未关联记录要提示未保存 ID，不能自动替换为其他问答。
11. 使用导出脚本读取当前快照，核对状态、关联字段及撤销结果，不用“点击次数”代替有效票数。

正常运行重点看：状态卷可写、反馈保存错误、过期清理后的文件量、统计/显式详情查询延迟、Pod 重启后的归属恢复，以及新记录 `transcriptStatus=unavailable` 的原因。评价正常保存不等于一定能够精确反查。`Persistence failed; callback not acknowledged` 说明本次未确认保存，平台重试存在边界，不能当作无限可靠消息队列。

回滚顺序：保留反馈记录、所需 Agent 转录及备份；恢复旧插件/镜像及相应配置；按需要恢复模板事件设置或旧模板 ID；再重启。新模板仍指向 `feedback_vote` 而旧代码没有处理器时，按钮不会正常保存。仅将 `feedbackEnabled` 设为 `false` 会拒绝评价和统计/详情命令，不会自动隐藏平台上的按钮，也不会删除已保存文件。重新启用、换模板或改 ID 都不会给升级前历史卡片自动补建可信归属。

如果仅从精确关联构建回退到此前的本分支赞踩统计构建，可沿用已有评价模板；旧构建不提供详情能力，也不会为后续回答捕获引用。回滚前后都应保留已有记录，而不是批量删除或重新生成。

不要删除整个 `dingtalk-state` 目录：其中还有其他渠道状态。应用离线、待评价记录保留及数据删除应按企业自己的变更流程处理。

## 10. 集中入库：HTTP 同步与离线导出

### 10.1 推荐：通用 HTTP 上报

已实现可选 `feedbackReporting`。插件发送最新有效评价和被评价的一问一答，公司接收服务认证实例后按版本幂等写入 OceanBase 4.2.5.7 MySQL 模式。插件不直连数据库；现有 `feedback_vote` 模板无需修改。


**调用方向：员工 Pod 内的钉钉插件主动 POST → 公司接收服务 → OceanBase；公司服务在 COMMIT 后返回 ACK。** 接收服务负责提供接口，管理员将其完整 URL 填入 `feedbackReporting.endpoint`。接收服务不需要调用插件接口，不需要为上报安排定时拉取任务，也不需要仅为本功能开放员工 Pod 的入站端口。

#### 10.1.1 触发与重试：部署人员必须了解

| 情况 | 默认行为 | 是否需要外部定时任务 |
| --- | --- | --- |
| 有效点赞、点踩、原因提交、撤销 | 插件先本地保存，再等待约 5 秒的前台空闲窗口后 POST；连续变化可能合并成最新状态 | 不需要，评价事件触发 |
| 正在聊天或资源紧张 | 插件后台退让，满足空闲/资源条件再发；5 秒不是到达时间保证 | 不需要 |
| HTTP 超时、非 200、非法 ACK | 插件自动重试；基准 5 秒逐步增至 300 秒，±20% 抖动，忙时可更晚 | 不需要，插件内部调度 |
| gateway / Pod 重启后有待发记录 | 随机延迟约 30～90 秒开始恢复发现，再按空闲条件及原退避时间补传；前提是状态卷和实例身份保留 | 不需要，插件恢复待办 |
| content.status=pending 已获 ACK | 默认约 5 分钟重新尝试采集正文，成功后用更高版本更新 | 不需要，插件复查 |
| 无新评价、无待办 | 不发请求；已确认的正文终态不周期性重传 | 不需要 |

开启功能不会自动上传全部历史；仅生成回答、尚未评价也不会触发上报。接收端必须允许重复和晚到，并在数据库提交成功后返回 **HTTP 200 + 协议 ACK**；202/204 或 `200 {"ok":true}` 均无效。发送超时默认 5 秒，已入库但 ACK 丢失时重发由接收端幂等处理。持续 401/403/409 要处理授权或数据冲突，不能让服务伪造成功来停止重试。

这些定时行为都在插件内完成，不要额外配置 OpenClaw cron、PowerJob 或接收端轮询。它们受前台活动、资源和数据保留期约束，不承诺固定时刻送达或无限离线补传。详细时间规则与停止条件见[接口调用与触发说明](../reference/feedback-reporting-api.md#_1-调用方向、触发时机与双方职责)。

#### 10.1.2 部署步骤

1. 先部署公司接收服务的 POST 路由，确认各 Pod 可访问；无需建立反向拉取入口。阅读[接口对接手册](../reference/feedback-reporting-api.md)及[完整示例](../reference/feedback-reporting-examples.json)，再按 [OpenAPI 协议](../reference/feedback-reporting.openapi.json)实现公司接收服务，参考随包文件 `docs/user/reference/feedback-reporting-oceanbase.sql` 的 DDL 与事务步骤。确认事务提交后才返回 `applied/duplicate/stale` ACK。
2. 为员工配发稳定的 `tenantId`、`instanceId` 和受保护凭据；Pod 重建后身份不变。接收端必须将凭据与企业/实例绑定。
3. 更新运行包、执行 `pnpm run build`，核对 `dist/feedback-reporting-worker.js` 随包存在。
4. 按[完整配置及资源说明](../features/feedback-http-reporting.md)设置 `feedbackReporting`；默认关闭，不自动补传此前所有卡片。
5. 在灰度实例重启并确认渠道 connected；真实点赞、点踩、撤销，核对中心最新状态、精确问答、无重复计票。
6. 接收端 503/超时后恢复、网关重启、员工继续聊天，核对本地交互正常且后台最终补传。公司 OceanBase 及生产 PVC 必须由公司环境补验，本机已验证的是通用协议接收器和同资源规格测试 Pod。
7. 回滚优先设 `feedbackReporting.enabled: false` 并重启，保留状态卷；不要删除待发送记录。关闭后本地赞踩继续可用。回退到不含上报的旧插件不能承诺跟踪回退期间的同步版本，恢复时需核对中心状态。

前台不等待网络，后台读取/解析在 Worker；高负载可延迟上报。并非“零资源开销”或“无限离线仍保证补传”。保留期、缺失正文、SQLite 边界及故障处理均见完整说明。

### 10.2 离线 JSON/CSV 导出

`src/command/feedback-store.ts` 是内部实现，不是公共数据库 SDK。原有离线导出仍可使用：

```bash
node scripts/feedback-export.mjs \
  --state-dir /home/node/.openclaw/agents/default/sessions/dingtalk-state \
  --account default --days 30 --format json
```

关键导出字段如下；原始记录使用嵌套 `transcript`，导出将其展开为便于报表使用的列：

| 导出字段 | 含义 |
| --- | --- |
| `cardId` | 等于原始记录 `outTrackId`；作为 `/feedback detail` 的完整参数，保留 `card_` 前缀 |
| `agentId`、`sessionKey` | 回答的实际 Agent 与路由会话键；单独使用不能确定某条回答 |
| `transcriptStatus` | `linked`：已保存精确引用；`unavailable`：本轮未能唯一关联；`not-recorded`：旧记录无引用字段 |
| `transcriptReason` | `unavailable` 时的原因；其他情况为空字符串 |
| `sessionId` | 关联成功时保存的当时实际会话 ID，不一定是该会话键当前指向的会话 |
| `userMessageId`、`assistantMessageId` | 原问题与回答的转录消息 ID；非 `linked` 时为空字符串 |
| `answerHash` | 最终回答 SHA-256，用于核对文本一致性，不能还原正文 |

`transcriptStatus` 描述回答完成时是否建立了关联，不是原转录当前可读性的实时探测；转录后来被删除时，导出仍可能为 `linked`，但详情查询会明确报告不可读取或消息缺失。

例如导出的 `cardId` 为 `card_example_001`，原提问者输入 `/feedback detail card_example_001`；该值仅为文档占位示例，实际必须使用本实例记录返回的完整 ID。

也可加 `--user '<UserId>'` 或 `--format csv`。导出是仍在保留期内、已完成回答的**当前快照**，包含 `none` 状态，不包含完整操作历史、去重状态和全部生命周期字段。因此：

- 离线导出可以用于一次性报表或核对；持续集中入库优先采用 HTTP 协议。两种方式都按稳定实例标识与卡片覆盖最新状态，撤销为 `none`，不能不断累加。
- 该方式仍保留本地 JSON，不是“配置数据库后本地零存储”。导出缺失的一行不自动等于业务删除；也不能从现有导出恢复完整的可交互状态。
- 要让数据库成为主存储：需要新增存储适配层，迁移归属、完成标记、回答指纹、可选转录引用、评价、去重及查询，保持事务与 ACK 顺序；卡片模板可以继续使用同一协议。
- 15000 个 Pod 接中心库时，优先评估汇聚服务/连接治理，不要默认每个 Pod 配置一组数据库长连接。

HTTP 接口字段、完整示例、ACK/异常、数据映射及联调步骤见[接口手册](../reference/feedback-reporting-api.md)。源码内部存储适配草案、迁移与新版仓库复用步骤见配套源码中的 `docs/spec/card-feedback-reuse-and-storage-design.md`（开发交接材料，不作为公开文档站页面或运行时 API）。其中通用 HTTP 同步已实现，替换本地权威存储的数据库适配器仍是后续设计。

## 相关材料

- [员工使用说明](../features/card-feedback.md)
- [HTTP 上报配置](../features/feedback-http-reporting.md)
- [HTTP 接口对接手册](../reference/feedback-reporting-api.md)
- 源码内验收记录：`docs/spec/2026-10-25-card-feedback-verification.md`
- 源码内新版复用与存储扩展设计：`docs/spec/card-feedback-reuse-and-storage-design.md`

本功能基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。
