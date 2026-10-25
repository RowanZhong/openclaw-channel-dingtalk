# AI 流式卡片评价：核实结论、实现方案与新版复用指南

更新日期：2026-10-25。本文是开发交接材料，方便将旧版已经验证的“仅原提问者、记录统计、精确反查原问答”能力迁移至新的社区钉钉插件分支，也说明后续数据库接入的边界。

**验证状态：** 旧版基础评价与精确反查均已通过真机验收，该阶段全量回归为 137 个文件、1420 项测试。R8 / R14 在同一实际会话中输出完全相同的回答，仍能分别反查正确问题；重启、点赞点踩和撤销后引用不变。详见[最终验收记录](./2026-10-25-card-feedback-verification.md)。

**状态区分：** 基础评价后已在交付分支 [`codex/feedback-http-reporting`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/codex/feedback-http-reporting)（基线 `6da056b`）增加通用 HTTP 同步，默认关闭。最终回归 1458 项，真机及同规格 Kubernetes 模块压力结果见[上报验收](./2026-10-25-feedback-http-reporting-verification.md)。“迁移步骤”尚未在新版执行；数据库成为本地主存储的适配器仍未实现。

## 1. 基线、目标与非目标

- 源仓库：`openclaw-channel-dingtalk-v3.6.11`。
- 开发基线：`9db293b`；源码交付分支为个人仓库的 [`codex/card-feedback-recording`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/codex/card-feedback-recording)。基线 SHA 不包含本功能；部署与迁移时固定实际选定的功能提交，不仅记录分支名。
- 真机宿主：OpenClaw `2026.7.1-2`；插件包仍标记 `3.6.11`，需要通过源码提交/内部构建号及产物摘要识别实际版本。
- 目标：对准确的回答记录原提问者的赞、踩、撤销与原因；提供本人统计、按卡片精确反查原问答及本地导出。
- 不做：模型自动学习、提示词改写、重答、代回复助手业务、DWS 监听、OpenClaw 核心改造。
- 新版适配必须以届时目标仓库最新可用基线为准，重新检查宿主与 SDK。旧版真机通过不等于任意新版宿主已经通过。

用户部署步骤见 `docs/user/getting-started/card-feedback-deployment.md`；具体真机过程见[验收记录](./2026-10-25-card-feedback-verification.md)。

## 2. 核实发现及证据边界

| 发现 | 证据 | 对实现的要求 |
| --- | --- | --- |
| “显示赞踩”与整个操作区的显示是两个设置 | 仅开前者时，真机操作区仍可能不可见 | 同时检查显示开关和整体显示控制 |
| 默认 `sys_action_like_component` 在本次环境中没有被本机捕获为业务 Stream 回调 | 客户端状态变化；改为 `feedback_vote` 后官方 SDK 立即收到真实事件，插件路径随后也通过 | 使用已验证的业务 Action ID，不能只看按钮变色 |
| 卡片创建和模板事件配置缺一不可 | 实际创建参数包含 `callbackType: "STREAM"`，Stream 订阅包含卡片 Topic | 新版迁移保留创建参数及回调订阅 |
| 业务事件不能仅回复 `{success:true}` | 仅 ACK 时没有持久选中状态；返回用户私有数据后选中/撤销正确 | 持久化后返回 `userPrivateData` |
| `null` 与空数组影响原生原因面板 | 初始回复空数组导致首次点踩不展开；改为 `null` 后正常 | 持久化 `reasonsSubmitted`，区分未选择和关闭/提交 |
| 模型错误也可能作为最终消息交付 | 认证错误占位卡走到了结束流程 | 检查 `payload.isError`，不能仅以“卡片完成”判定正常回答 |
| 临时运行注册表不能承担历史评价归属 | 运行记录结束会移除；新持久化记录在网关重启后仍可操作 | 创建时保存不可随便改写的归属，并按卡片 ID 精确匹配 |
| 私聊原问题和回答事件可能使用不同的会话键 | R8 / R14 原问题使用来源键、回答使用 `agent:main:main`，实际 SID 相同 | 仅接受宿主可信路由生成的别名，并继续核对实际 SID |
| 相同回答文本不能作为唯一关联键 | R8 / R14 指纹相同、两组消息 ID 不同，反查互不串联 | 保存持久化消息 ID，指纹只负责一致性校验 |
| 共用应用会使验收消息进入其他实例 | 部分测试消息由另一个连接器回答 | 通过受测卡片 ID、接收日志、磁盘记录确认，不能拿另一实例输出作证据 |

“默认系统事件不进入本机”的结论是本轮实测范围，不据此断言所有平台版本永远不转发它。确定可复用的结论是：本轮 `feedback_vote + 用户私有状态响应` 协议在真实客户端和插件 Stream 中通过。

钉钉[官方卡片说明](https://open-dingtalk.github.io/developerpedia/docs/learn/card/intro/)区分了机器人收消息配置与卡片创建时的回调模式；不能用开发平台的机器人 Stream 开关替代创建参数。

## 3. 已验证的事件和 UI 协议

### 3.1 入站回调

卡片 Topic 为 `/v1.0/card/instances/callback`。传输信封提供 `headers.messageId` 与 `headers.time`；业务载荷提供 `outTrackId`、`userId`、`userIdType`。当前只接受 `userIdType === 1` 的员工 UserId。

下面为脱敏后的结构；`content` 在实际回调中是 JSON 字符串，`value` 也可能携带相同结构：

```json
{
  "type": "actionCallback",
  "userIdType": 1,
  "userId": "owner-user-id",
  "outTrackId": "card-example",
  "content": "{\"cardPrivateData\":{\"actionIds\":[\"feedback_vote\"],\"params\":{\"variableKey\":\"node_example_likeOrDislike\",\"variableValue\":\"like\",\"extraParams\":{}}}}"
}
```

| 动作 | `params.variableKey` | `params.variableValue` |
| --- | --- | --- |
| 点赞 | `<componentId>_likeOrDislike` | `"like"` |
| 点踩 | 同上 | `"dislike"` |
| 撤销赞或踩 | 同上 | `"none"` |
| 提交原因 | `<componentId>_dislikeTags` | 字符串代码数组，例如 `["2","3"]` |
| 关闭原因面板 | 同上 | `[]` |

当前解析器支持 `node_` 开头的组件 ID 和这两个确定后缀，原因最多 6 项，仅接受 `1～6` 字符串代码。不要把任意按钮参数原样作为卡片变量写回；不要根据表单传入的 ownerUserId、文字来源标记或模型判断授权。

| 原因代码 | 含义 |
| --- | --- |
| `1` | 内容不匹配 |
| `2` | 内容不完整 |
| `3` | 表达不合逻辑 |
| `4` | 存在事实偏差 |
| `5` | 有敏感词或观点 |
| `6` | 回答不是我想要的 |

这些代码来自本次原生组件真实提交及模板，应在目标模板版本变化时复验，不能只按界面文案猜码。

### 3.2 返回值

```json
{
  "cardUpdateOptions": { "updatePrivateDataByKey": true },
  "userPrivateData": {
    "cardParamMap": {
      "node_example_likeOrDislike": "dislike",
      "node_example_dislikeTags": "null"
    }
  }
}
```

`cardParamMap` 的值按卡片接口要求使用字符串；上例的 `"null"` 是序列化值，不是漏填字段：

- 未选择原因：`JSON.stringify(null)`。
- 已关闭面板但未选择原因：`JSON.stringify([])`。
- 已提交原因：例如 `JSON.stringify(["2","3"])`。

普通赞踩切换会清空旧原因并把 `reasonsSubmitted` 置为 `false`；原因事件，包括关闭面板的空数组，将它置为 `true`。

只更新当前操作者的私有状态，不覆盖卡片公共回答，也不覆盖原提问者以外成员的私有数据。[官方 SDK 的响应模型](https://github.com/open-dingtalk/dingtalk-stream-sdk-go/blob/main/card/model.go)包含 `UserPrivateData` 和逐键更新选项。

### 3.3 ACK 责任

处理顺序为：解析 → 找到持久化归属 → 校验身份/期限/完成状态 → 去重/排序 → 持久化 → 返回私有状态 → ACK。

当前由网关的一个 ACK 入口调用 `socketCallBackResponse(messageId, response)`，让 SDK 按协议包装响应。不要在 handler 和 finally 中各 ACK 一次，也不要先 ACK 后再尝试写文件。

保存失败不发送成功状态、不 ACK，允许平台重试。但平台的重试不是无限可靠队列。业务拒绝会 ACK，并限频发送普通私聊说明；不生成带评价按钮的拒绝通知卡。

## 4. 当前实现及数据结构

### 4.1 调用链

```text
真实钉钉消息（已通过渠道访问策略）
  → 创建 / 复用回答卡片
  → registerFeedbackCard：保存 account、card、原提问者、原消息及会话
  → 在本轮回复期间订阅宿主已持久化消息事件（有界内存捕获）
  → 原有 Agent / 流式回复流程
  → 正常回答完成且最终消息不是错误
  → completeFeedbackCard：同次写入完成时间、回答哈希和可用的转录消息 ID

用户操作原生赞踩组件
  → Stream 卡片回调
  → parseFeedbackCallback / handleFeedbackCallback
  → applyFeedback：按 account + outTrackId 精确处理
  → 原子保存当前状态及有界历史
  → userPrivateData 响应与 ACK

原提问者私聊 /feedback detail <卡片ID>
  → 按账号与卡片读取记录，先检查身份/期限/完成状态
  → 使用保存的实际 SID 和两条消息 ID 读取对应 Agent 转录
  → 校验回答指纹，返回可见问答；缺失或不一致则明确提示
```

`feedbackDeliveryFailed` 应在已有“忽略正常回答之后晚到错误提示”的分支之后更新；否则正常回答可能被随后一个非终止警告错误取消评价资格。中止、异常收尾与恢复占位卡不调用正常完成标记。

### 4.2 文件状态

命名空间为 `feedback.ratings`；文件路径由已有 `resolveNamespacePath` 构造。账号编码为 base64url，卡片键先做 SHA-256，再按 namespace scope 编码，以免外部卡片 ID 形成过长或越界文件名。

`FeedbackRecord` 的核心字段：

| 类别 | 字段 |
| --- | --- |
| 版本及定位 | `version: 1`、`accountId`、`outTrackId` |
| 授权及关联 | `ownerUserId`、`conversationId`、`sessionKey`、`agentId`、`sourceMsgId` |
| 精确转录引用（可选） | `transcript.status`；成功时 `sessionId`、`userMessageId`、`assistantMessageId`、`source: runtime-events`，失败时 `reason` |
| 生命周期 | `createdAt`、`expiresAt`、可选 `completedAt`、`answerHash` |
| 当前评价 | `vote`、`reasons`、`reasonsSubmitted` |
| 去重及排序 | `lastEventAt`、最近 256 个 `seen` 事件 ID |
| 有界操作记录 | 最多 100 次 `history` 状态变化 |

上述基础评价文件不复制问答全文；可选上报 outbox 可在确认前暂存被评价问答。`history` 不是完整审计流水：相同状态不重复新增，关闭面板可能只更新私有状态标志及去重信息；历史与去重均有数量上限。若企业需要完整审计，应另行设计不可变事件表。

同一文件的操作用进程内 Promise 队列串行化。写入使用唯一临时文件、`0600` 权限、文件 fsync 和 rename；读取损坏数据时抛错，不能拿空对象覆盖。该实现不是跨进程事务锁，同一路径只适合单写入进程。

### 4.3 授权和统计口径

- `ownerUserId` 来自真实入站 `senderStaffId`，不是模型生成的字段；在创建卡片时绑定。
- 只按账号和卡片 ID 查询，不使用“最近回答”回退。
- 归属未知、身份不符、过期、未完成、非法参数：拒绝，不自动补建记录。
- 重复 messageId 不增票；事件时间比最后状态更早时不覆盖。当前未声称为任意同毫秒事件或跨进程事件提供全序。
- 当前有效赞和踩互斥；`none` 取消原票。原因仅在当前点踩时计入统计。
- 统计按回答创建时间筛选，分母仅包含仍保留且正常完成的本人回答；不是消息量、点击量或模型调用量。
- `/feedback stats [Nd]` 与 `/feedback detail <卡片ID>` 都在渠道授权之后直接处理，不交给 LLM。只在私聊返回本人数据；详情在读取转录前再次检查记录归属及保留期，群聊仅提示到私聊查询。

### 4.4 当前存储扩展入口是什么

内部函数集中在 `src/command/feedback-store.ts`：

```text
registerFeedbackCard
completeFeedbackCard
applyFeedback
feedbackStats
readFeedbackRecord
cleanupFeedbackRecords
```

它们是可迁移、可替换的源码接入点，**不是已发布的数据库接口**。调用方目前直接 import 具体文件实现，`package.json.exports` 也没有把它们作为公共 SDK 暴露。不能通过填一个数据库 URL 或外部注册 hook 就完成切换。

JSON/CSV 导出用 `cardId` 表示记录中的 `outTrackId`，并包含 `sessionKey`、`transcriptStatus`、`transcriptReason` 和成功关联时的三个消息定位 ID；不包含问答全文。导出只输出所选时间窗口内已完成、未过期记录的当前快照，省略了去重、历史、完成时间等部分状态。它可用于报表，不能无损恢复实时反馈存储，也没有承诺增量变更或删除事件协议。

### 4.5 精确关联原问题与回答

本次新增 `src/card/feedback-transcript.ts` 和 `src/command/feedback-detail.ts`。未改变既有点赞回调协议、模板、保留期和“仅提问者”规则。

#### 4.5.1 轻量捕获

1. 仅在启用评价的卡片回复期间订阅宿主 `runtime.events.onSessionTranscriptUpdate`，在现有会话锁内创建 tracker，`finally` 无条件释放。
2. 核对 Agent、可信路由会话键、来源、提问者和本轮问题文本，从已持久化事件中获取原问题 ID。私聊折叠到 `main` 时，宿主可能以 `per-account-channel-peer` 来源键发布用户事件；别名由宿主现有 `buildAgentSessionKey` 生成，不能由消息正文提供。
3. 回答事件必须匹配实际回复会话键，并与问题对应的实际 `sessionId` 一致。只提取可见 text 块，不取 thinking 或工具调用。对镜像事件另外核对同一轮身份；存在第二个问题、多个相同候选或冲突会话时放弃关联。
4. 泛用宿主事件可能不带 `sessionId`，由已有 `llm_output` hook 按当前 `runId` 补充；没有另加一个模型 hook。缺失时不从文件名推测。
5. 卡片正常完成时，最终正文必须精确匹配唯一的候选回答。关联结果与既有 `completedAt`、`answerHash` 一次写入；完成后不可重新绑定。

最多缓存 8 条候选可见文本，每条上限 128000 字符，每条消息最多检查 1024 个内容块；超过上限明确标记不可精确关联。无后台扫描、轮询、额外模型调用或网络调用，临时内存在回复结束时释放。

存储示例（下列 ID 为说明用占位值）：

```json
{
  "agentId": "main",
  "sessionKey": "agent:main:main",
  "answerHash": "实际回答的SHA256",
  "transcript": {
    "status": "linked",
    "source": "runtime-events",
    "sessionId": "当时实际会话UUID",
    "userMessageId": "原问题的转录消息ID",
    "assistantMessageId": "回答的转录消息ID"
  }
}
```

三个标识来自 OpenClaw 转录，不是钉钉 `sourceMsgId` 或卡片 `outTrackId`。它们分别负责定位会话与具体消息；指纹负责检查文本一致性，不充当数据库查询主键，也不能恢复正文。

#### 4.5.2 按需反查

`/feedback detail <outTrackId>` 在已有命令入口直接处理，禁用群聊输出。先读取精确卡片记录并检查账号、提问者、完成状态与保留期，通过后才调用 `openclaw/plugin-sdk/session-transcript-runtime` 的 `readSessionTranscriptEvents`。使用实际 Agent 的 `resolveStorePath`，并明确传入保存的 `sessionId`，不依赖会话键当前指向的会话。

从该转录中按两条外层消息 ID 查找；核对会话头、角色、顺序、可用的用户来源信息及回答 SHA-256。只呈现问题与最终可见回答，展示分别限 1000 / 2500 字符，不暴露思考或工具内容。转录不可读取、消息缺失或校验不通过时明确提示；不扫描其他会话、不回退最近答案、不补写旧记录。

这一手动查询会读取一个指定转录文件，成本与其大小有关；正常回答和点击路径不直接调用它。开启 HTTP 上报后，由独立 Worker 的有界读取路径采集被评价问答，可产生临时 outbox 正文；不借用手动全会话读取路径。

#### 4.5.3 宿主能力与降级边界

原始记录 `transcript.status` 只有 `linked` / `unavailable`；缺失整个字段的旧记录在导出时显示为 `not-recorded`。`linked` 表示完成时成功建联，不保证转录现在仍可读；后续详情读取失败不会重写已保存引用。

| `unavailable` 的 `reason` | 含义 |
| --- | --- |
| `events-unavailable` | 宿主未提供订阅能力，或订阅失败 |
| `question-not-observed` / `answer-not-observed` | 本轮未捕获到满足条件的原问题 / 回答 |
| `session-id-missing` | 事件和当前 run 都未提供实际 SID |
| `ambiguous-turn` | 存在第二个问题、多个匹配候选或相互冲突的会话身份 |
| `content-mismatch` | 没有候选可见正文与最终卡片正文完全相同 |
| `capture-limit` | 回答候选超过上限，或候选可见正文无法在轻量范围内提取（含过长文本、过多内容块等） |

- 验证实际宿主的转录事件包含持久化消息 ID，捕获时间早于卡片 finalize；不要假定所有模型后端的事件形态相同。
- 验证私聊 main 折叠、按成员隔离和群会话键；别名只能使用宿主可信路由规则，实际 SID 必须一致。
- 保留“不确定则不关联”的降级语义，以及失败、停止、跨用户/账号、重复回答、会话重置、转录缺失测试。
- 若新版无公开转录读取接口，保持评价功能正常并报告详情不可读取，不导入宿主私有文件或扫描工作区补猜。

#### 4.5.4 SQLite 宿主的源码兼容性核对

2026-10-25 已核对官方发布版 `2026.10.7`：默认运行会话与转录改用各 Agent 的 `openclaw-agent.sqlite`。这里指基础精确关联与手动详情：它们通过公开事件及 `readSessionTranscriptEvents()` 接入，而非自行解析 JSONL；新增 HTTP 上报的有界读取适配是另一条路径，见第 6 节；该版本保留所需 `target.agentId/sessionId/sessionKey`、`messageId` 和消息字段，公开读取接口通过宿主存储层读取 SQLite。公开事件不再提供 `sessionFile`，本 tracker 对该字段的检查是可选的，不以文件路径为必填身份。

这是**源码接口兼容性核对，不是新版整包或 SQLite 迁移的真机验收**。迁移时还需验证实际模型后端事件、完成时序、同文不同消息、原评价文件路径，以及历史 sessionId / 消息 ID 是否保留。当前已经通过真实验收的宿主仍为 `2026.7.1-2`。

当前 `detail` 读取指定会话的事件后再定位两条消息，不等于已实现数据库按 ID 只取两行；长会话反查需要另外测量读取延迟和内存。新宿主的备份/保留策略应覆盖实际 SQLite 存储与归档，不能照搬“只保留 JSONL 文件”的运维方案。

核对依据：[会话存储说明](https://github.com/openclaw/openclaw/blob/v2026.10.7/docs/concepts/session.md)、[公开转录事件](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/sessions/transcript-events.ts)、[公开读取接口](https://github.com/openclaw/openclaw/blob/v2026.10.7/src/plugin-sdk/session-transcript-runtime.ts)。

## 5. 向新版仓库迁移

### 5.1 先核对目标分支

从届时新版仓库的最新 main 或明确选定的发布基线创建独立分支，记录实际宿主版本、插件 SDK 和 dingtalk-stream 版本。不要整段 cherry-pick 旧版兼容分支：其中存在与本功能无关的旧版桥接及历史改造。

下表基于本地已模块化仓库核对到的目录，仅是位置提示；旧的 `2026.8.1` 工作副本与最新 main 不一定采用相同布局。

| 旧版实现位置 | 模块化新版对应位置/迁移点 |
| --- | --- |
| `src/command/feedback-store.ts` | 保持 `command/` 领域，调整持久化路径 helper import |
| `src/card/feedback-callback.ts` | 保持 `card/` 领域，调整 config/types import |
| `src/command/feedback-command.ts` | 保持 `command/` 领域，接入统计与详情两个子命令 |
| `src/card/feedback-transcript.ts` | 保持 `card/` 领域，核对宿主转录事件与会话别名契约 |
| `src/command/feedback-detail.ts` | 保持 `command/` 领域；runtime import 对应 `src/platform/runtime.ts`，核对公开转录读取接口 |
| `src/command/feedback-transcript-content.ts` | 基础详情与上报共用的纯解析/身份/指纹核对逻辑；即使不迁移 HTTP 上报也要复制 |
| `src/command/feedback-reporting-config.ts`、`feedback-reporting-events.ts` | 当前基础回调/存储已导入的配置和轻量通知支撑；即使保持上报关闭，复制当前源码时也不能漏掉 |
| `index.ts` | 沿用既有 `llm_output` hook，按 runId 传递实际 sessionId，不重复注册 hook |
| `src/reply-strategy-types.ts` | `src/messaging/reply-strategy-types.ts`，传递 tracker 给卡片策略 |
| `src/inbound-handler.ts` | `src/gateway/inbound-handler.ts` |
| `src/reply-strategy-card.ts` | `src/messaging/reply-strategy-card.ts` |
| `src/gateway/channel-gateway.ts` | 同名领域入口；检查现有通用卡片处理/扩展分发顺序 |
| `src/card-callback-service.ts` | `src/card/card-callback-service.ts` |
| `src/persistence-store.ts` | `src/shared/persistence-store.ts` |
| `src/config-schema.ts`、`src/types.ts` | `src/platform/config-schema.ts`、`src/platform/types.ts` |
| `src/command/inbound-command-dispatch-service.ts` | 同路径；检查命令鉴权和是否存在同名命令 |
| `docs/assets/card-template-v2.json` | 合并当前新版模板的 Feedback 设置，不用旧模板覆盖新版整张卡片 |

### 5.2 推荐实施顺序

1. 复制六个基础模块：`feedback-store`、`feedback-callback`、`feedback-command`、`feedback-transcript`、`feedback-detail`、`feedback-transcript-content`，以及当前导入的 `feedback-reporting-config` / `feedback-reporting-events` 支撑模块和对应测试，按上表修正 import；不要引入代回复助手依赖。
2. 在目标配置 schema、类型、插件 manifest 与多账号继承链加入 `feedbackEnabled`、`feedbackRetentionDays`，保持默认关闭。复制当前回调/config 代码还需保留 `feedbackReporting` 类型/schema；是否启用 HTTP 服务按第 6 节处理。
3. 找到实际的卡片创建/排队复用路径，从已授权入站身份注册归属。入口和卡片回调用相同账号存储 scope；详情读取转录时使用记录中的实际 Agent，不混用两者。
4. 按第 4.5 节接入转录事件：在会话锁内创建 tracker，交给回复策略，在 `finally` 释放；`onAgentRunStart` 绑定 runId，既有 `llm_output` hook 补充实际 SID。保留可信别名、候选上限与不确定降级。
5. 在成功完成实际回答的路径同次写入完成标记、回答指纹与可选转录引用；覆盖流式与非增量卡片模式，排除错误最终消息、停止、异常恢复及主动通知。不得后台补猜旧记录或重绑已完成记录。
6. 将反馈 handler 接入既有卡片分发器，只认确定的动作协议；保留 `/stop`、ask-user、通用卡片扩展及其他 handler。让最终响应与 ACK 由一个位置负责。
7. 接入 `/feedback stats [Nd]` 和 `/feedback detail <卡片ID>`；保留原 DM/群访问策略，先检查本人权限再读转录，禁止群内公开统计和问答。不增加 LLM 工具。
8. 合并模板最小设置。新版模板若更换组件、变量、状态或原因代码，重新采集真实载荷再适配；精确反查本身不需要额外模板变量或按钮。
9. 补齐打包资产、安装说明与只读导出脚本，保留导出的关联状态、原因及 ID。构建实际 runtime 后再重启真机环境。
10. 按第 7 节验收，记录目标版本自己的证据；不要把旧版真机通过标签当作新版兼容性证明。

### 5.3 模板迁移的注意点

新版优先复用其原生 Feedback 组件及新版布局，不回退整份旧卡片。模板需要 `feedback_vote`、两个确定的变量后缀，以及支持用户私有状态的回调响应。

旧版用进程环境变量 `DINGTALK_CARD_TEMPLATE_ID` 选择内置模板，`channels.dingtalk.cardTemplateId` 在这条路径不生效。新版应查阅实际创建路径及其正式配置能力，不把旧版环境变量方案直接当作永久接口。

旧版仓库中的模板导出同时包含 `editorData` 与 `widgetInfo`。修改 JSON 外层并不等于修改了嵌套编辑数据；只改 editorData 也不能保证编译内容同步。应从平台保存后重新导出，运行 `card-feedback-template.test.ts`。本次真实导出保持 41 个组件和 ID；另有平台默认字段规范化及此前线上已有的复制设置差异，详见验收记录。

## 6. 数据库接入：已实现同步与后续存储适配

已实现的第一版是本地评价为权威、HTTP 接收服务存最新快照，**只存被评价的一问一答**；不采集全会话，不要求中心数据库响应才能完成卡片操作。对接入口是 OpenAPI HTTP 协议，不是对外暴露内部 TS 函数。字段、事务、全部示例和错误处理见[接口手册](../user/reference/feedback-reporting-api.md)，机器可读定义及示例也须随运行包交付。配置、缺失正文、撤销与版本规则见[上报说明](../user/features/feedback-http-reporting.md)。

新版复用上报时，除基础六模块，还需迁移 `feedback-reporting-{config,events,io,protocol,content,transport,worker,service}` 及测试。需同步以下接线：

- `index.ts` 的服务注册/停止，`inbound-handler`、评价回调及可信 Agent 生命周期的前台活动通知。
- `feedback-store` 的同次源版本/目的地/保留期写入；不要在点击路径直接读转录或请求 HTTP。
- 转录 tracker 的可选可信 `localFile` 提示与回复完成时保存；仅 Worker 本地使用，协议显式排除路径。
- 构建与归档中的独立 Worker 入口、配置 schema、SecretInput、运行时资源和文件权限。
- SQLite 宿主先实现并验证有界读取适配，不能用全会话读取 API 冒充低开销按 ID 查询。旧版 JSONL 的真机和压力结果不能直接外推。

不必改评价卡片模板。新版必须复验前台抢占、冷启动内存、压力暂停/恢复、ACK 幂等、重启补传和故障退让。以下“存储适配层”仍为设计草案。

### 6.1 先选择要解决的问题

| 需求 | 建议路径 | 本地 JSON 是否保留 |
| --- | --- | --- |
| 集团报表、长期分析 | 已实现 HTTP 快照同步，公司实现接收服务入库；也可离线导出核对 | 保留；须核对正文及待发送保留策略 |
| 减少每 Pod 的小文件数量 | 存储模块替换为单库文件（例如 SQLite）或其他合适本地存储 | 不再每卡一个 JSON，但仍需持久卷；需要开发 |
| 中心数据库成为唯一权威存储 | 新增可替换存储层，经直接 DB 适配或内部汇聚服务实现 | 可以不保留现有 JSON 主副本；容错方案另定 |
| 网络中断仍可快速确认反馈，并最终集中入库 | 已实现源版本 + 后台耐久 outbox + 幂等 HTTP | 保留，超过保留期仍可能被清理；不是无限离线保证 |

现有导出不是增量 CDC：撤销以 `vote=none` 覆盖旧票，不能每次导入都加一。导出中消失的记录可能只是超期或不在窗口，不能自动判定中心库应删除。只有本地定期导出不能恢复完整历史；采集间隔内多次切换可能只留下最后状态。

### 6.2 存储适配层

可以保留业务操作边界，将当前 JSON 实现放到默认适配器，调用方通过工厂获得存储实现。下面是**设计草案，不是当前可调用接口/配置**：

```ts
interface FeedbackStore {
  registerCard(context: InstanceContext, binding: CardBinding): Promise<void>;
  completeCard(context: InstanceContext, cardId: string, completion: Completion): Promise<void>;
  applyFeedbackAtomic(context: InstanceContext, event: VerifiedFeedbackEvent): Promise<FeedbackResult>;
  getStats(context: InstanceContext, ownerId: string, range: StatsRange): Promise<FeedbackStats>;
  getCard(context: InstanceContext, cardId: string): Promise<FeedbackRecord | undefined>;
  purgeExpired(context: InstanceContext, now: number): Promise<void>;
}
```

`Completion` 应包含完成时间、回答指纹和可选 `FeedbackTranscriptLink`，并在同一事务中保存；`getCard` 供详情查询先读取归属，返回记录后必须校验本人身份再访问宿主转录。

`applyFeedbackAtomic` 必须在同一事务内完成归属/完成状态检查、去重、当前状态转换及事件写入。不要拆成无事务的 `get → update → incrementCounter`，也不要让每个调用方自行拼 SQL。

如果只替换内部存储实现且保持事件/UI 协议不变，模板不必再次改动。新增配置名、驱动依赖及对外入口应在数据库实现时单独定义和验收，当前文档不提供虚构的可用数据库配置。

### 6.3 中心库的隔离键与表职责（存储替换草案）

本节多表设计针对未来替换主存储/完整审计，不是第一版 HTTP 接收的必建表。第一版使用参考 `ai_reply_feedback` 最新快照表，具体列映射见接口手册。

15000 个实例很可能都使用 `accountId=default`，不能把它当作全局租户标识。

建议稳定主键至少包含：`企业/租户标识 + 逻辑实例标识 + accountId + outTrackId`。逻辑实例标识应来自可信的员工实例配发信息并跨 Pod 重建保持不变，不用易变化的 Pod 名/UID，也不接受表单自行声明实例身份。

- `feedback_cards`：归属、原消息/会话/Agent、创建及完成时间、过期时间、回答哈希、转录关联状态/原因及成功时的实际 SID 和两条消息 ID、当前 vote/reasons/reasonsSubmitted、版本/最后事件时间。
- `feedback_events`：传输 messageId 唯一约束、卡片外键、操作者、事件时间、处理结果及必要的状态变化。需要完整审计时单独保留，不照搬本地 100 项历史截断。
- 查询索引：实例、账号、owner、createdAt；必要时增加过期清理索引。

若采用内部汇聚服务，由服务认证绑定实例身份，再在事务中处理评价。避免 15000 个 Pod 各自创建默认大连接池。保留有界超时、幂等重试和清楚的失败结果。

只保存消息 ID 的离线导出不能还原正文。HTTP 同步会在 Worker 中按精确 ID 与指纹验证一问一答，并显式上报 available/missing/unverified/pending；可用正文只需首次确认，之后评价变化用 preserve 保留中心正文。不查询其他问题、不上传本地文件路径。

### 6.4 一致性、故障和迁移

- 数据库为主存储：提交成功后才回写成功 UI/ACK；数据库不可用时不伪造成功。需验证平台回调超时与重试窗口。
- 本地 Outbox：先保证本地状态与待上传事件一起耐久，再 ACK，后台幂等补传。简单地“写 JSON 后异步 HTTP”不是天然原子、无丢失的 Outbox；需要事务存储或可重建的可靠机制。
- 迁移已有实时状态时，应读完整源记录，而不是只用当前导出快照；必须保留归属、期限、完成标记、回答指纹、可选转录引用、最后事件、去重状态和 `reasonsSubmitted`。旧记录没有引用时仍保持缺失，不按最近会话补填。
- 推荐在灰度实例短暂停止反馈写入，复制/导入完整记录，核对数量和当前状态后切换唯一主存储，再用旧卡片测试。高可用迁移则需要版本号和可靠复制设计，不能无协调双写。
- 回滚不能只切回一份过期 JSON：迁移期间的新评价和撤销也必须回补或明确冻结窗口。
- 若决定不迁移历史记录，应明示“旧卡片无法核实归属”，只允许新建卡片评价；禁止根据最近回答猜测归属。

## 7. 复用时必须重跑的验证

### 自动测试

- `feedback-store.test.ts`：精确关联、非本人/账号隔离、撤销互切、重复及旧事件、并发、重启读取、损坏文件、保留期。
- `feedback-callback.test.ts`：真实协议形状、用户身份类型、非法变量及原因、null/[]/非空原因、私有 UI 响应、本人统计隔离。
- `reply-strategy-card-feedback.test.ts`：正常完成、认证错误、晚到警告、停止/异常、发送与存储失败、功能关闭，以及同次完成写入转录引用。
- `feedback-transcript.test.ts`：真实事件形状、run 会话补充、DM 来源别名、实际 SID 一致性、同文不同消息、不确定降级、候选上限及释放监听。
- `feedback-detail.test.ts`：按保存 SID/消息 ID 反查、读取前授权、角色/来源/指纹核对、旧记录不扫描补填、转录清理和群聊拒绝。
- `gateway-feedback-flow.test.ts`：保存前不 ACK、保存后私有响应、写入失败不 ACK、普通拒绝说明、旧回调不虚报保存。
- `card-feedback-template.test.ts`：显示、业务 Action ID、编译内容和流式变量协议。
- 打包检查：runtime、声明、模板、使用及部署文档、导出工具确实在归档内。

数据库驱动还必须执行同一套存储契约测试，以及事务回滚、竞争写入、连接耗尽、超时、重复投递和迁移回滚测试。不要因 JSON 实现通过就跳过新驱动验收。

### 真机验收矩阵

| 场景 | 验收标准 |
| --- | --- |
| 本人正常回答 | 新卡片有真实入站提问者与原消息绑定，正常模型回答完成后才可评 |
| 点赞、点踩、两种撤销 | UI、Stream、持久化状态一致 |
| 直接互切 | 只有一个有效状态，不重复计票；旧原因清空 |
| 原因未选、提交、关闭、再点踩 | 面板展示与 null/[] 语义一致 |
| 群内 B 提问，A 点击 | A 被拒绝，B 当前评价与历史不变 |
| B 自己点击 | 保存成功，A 的个人统计不包含 B 的票 |
| 重启与历史卡片 | 保存状态可恢复，操作仍指向那张卡片而非最新回答 |
| 模型/平台/存储失败 | 不虚报正常回答或评价保存成功 |
| 正常命令与其他卡片事件 | `/stop`、ask-user、通用扩展分发及原有发送不回归 |
| 本人统计与导出 | 按明确时间与有效状态口径一致；导出 ID/状态/原因准确，拒绝群内公开个人统计 |
| 同会话不同问题、完全相同回答 | 回答指纹可相同，但两组原问题/回答 ID 不同；分别点赞点踩，反查各自正确问答 |
| 重启、撤销后反查 | 当前评价与原问答对应一致，不重新绑定到最近回答 |
| 旧记录、宿主事件不足、转录缺失或内容变化 | 明确提示不可反查，评价仍按原规则处理；不扫描补猜或泄露其他人的正文 |

必须先构建实际 runtime，重启并探测 `running/connected`，再测客户端。记录实际受测构建、卡片关联和回调结果。原始连接日志可能含凭据或个人消息，不应直接提交到公开仓库。

## 8. 性能、容量和部署限制

基础 JSON 评价不新增常驻进程、数据库连接或 LLM 调用。可选 HTTP 上报增加一个按需 Worker 线程及后台文件/网络开销；前台运行期间暂停，不能把基础功能的成本测量直接当作开启上报的成本。每次有效写入涉及本地原子文件 I/O；反馈目录扫描发生在统计和低频清理中，不是每次点击都扫描全部记录。显式 `detail` 查询另外读取一个指定 Agent 的会话转录，耗时取决于转录大小。

本次 300 条合成记录的一次评价落盘中位约 5.3 ms、P95 约 6.3 ms，统计约 16.9 ms；这是本机结果，不包含钉钉网络耗时，不代表 Kubernetes 共享卷。新增转录捕获的 10000 次、8400 字符回答基准中，中位数为 0.875 μs、P95 为 1.083 μs；这是 tracker 本身的本机测量，不含宿主发出事件前的工作或模型/网络耗时。转录引用合并进原完成写入，两组各 60 次测量的文件操作次数相同；典型三个 UUID 增加约 224 字节 JSON。新增 CPU 和临时内存并非绝对零；移植后需按目标宿主及 Pod 条件复测。完整实测口径见[验收记录](./2026-10-25-card-feedback-verification.md)。

容量按所有已注册卡片估计，不按被点赞的条数估计。以 100 卡/人/天、90 天、每文件 4 KiB 为例，约 9000 文件和 35.2 MiB/Pod；15000 实例约 1.35 亿文件、515 GiB，尚未含元数据、副本和备份。具体计算、测量命令及清理限制见部署文档。

当前没有全目录配额，也没有每个线程、历史/去重数量的配置开关。缩短保留期只改变新记录；异步清理尽力执行，闲置实例的物理文件可能迟于过期时间删除。未来驱动设计不应把这些边界误写成“硬空间上限”或“永久审计完整性”。

## 9. 本机环境问题，不应混进通用功能补丁

本次模型验收还遇到：

1. `auth.openai.com` 被本机 Clash Fake-IP 解析为 `198.18.*`，宿主 SSRF 检查阻止刷新。通过该订阅扩展脚本，仅追加该域名到 Fake-IP 排除列表后，解析恢复公网地址。
2. 网络恢复后，服务端明确返回 `refresh_token_reused`；用户完成旧版环境的正常重新登录，实际模型探针返回 `AUTH_OK`。

这两项属于本机环境恢复，不是点赞插件的部署前置动作。不要把个人代理脚本、凭据、禁用 SSRF/TLS 或个人账号信息加入新版代码。Clash 的列表覆写行为可见[官方扩展配置说明](https://www.clashverge.dev/guide/extend.html)；本次选择追加脚本是为了保留原有过滤项。

## 10. 交接交付物

- 基础六个业务模块、当前直接导入的 config/events 支撑，以及第 6 节列出的可选 HTTP 上报模块、独立 Worker 资产与相应测试。
- 平台导出的完整模板资产；复用新版时只合并相关组件设置。
- `docs/user/features/card-feedback.md`：员工使用说明。
- `docs/user/getting-started/card-feedback-deployment.md`：完整部署、容量与回滚。
- `docs/spec/2026-10-25-card-feedback-verification.md`：旧版验收记录及证据边界。
- HTTP 上报说明、OpenAPI、OceanBase 参考 SQL、测试接收器、可复现压力工具和独立验收记录。
- 本文：通用实现结论、迁移顺序、已实现同步和未实现的存储替换方案。

正式移交时记录实际选定的源码提交 SHA、制品摘要与受测版本；分支后续会更新，部署不可只记录分支名。不得将本机的未发布模板 ID、账号凭据或测试状态目录硬编码到产品。

本实现及架构约定基于 **OpenClaw DingTalk Channel Plugin**，**YM Shen and contributors**，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。迁移代码时保留相应 MIT 版权和许可说明。
