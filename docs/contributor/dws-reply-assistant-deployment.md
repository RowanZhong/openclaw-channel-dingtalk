# 钉钉个人代回复助手 · 技术方案与安装配置

**开发及运维指南 · 0.5.1 · 2026-09-24**

面向开发人员和平台管理员。员工操作另见[员工使用手册](../user/dws-reply-assistant-manual.html)。适用一名员工一个 Pod、独立 OpenClaw 实例；兼容验证覆盖 OpenClaw 2026.7.1-2 与 2026.8.1。

## 1. 整体方案与定向控制原理

这套方案为每名员工的独立 OpenClaw 实例增加一条**受控的个人消息处理流程** ：DWS 用员工已登录的身份接收消息，自定义插件按员工设置筛选来信、生成草稿并管理授权，社区钉钉插件负责投递卡片和接收本人操作。员工可以确认后发送，也可以提前授权有范围、有期限的固定答复。平台统一部署代码和配置模板，员工自己的身份、监听偏好与状态保留在各自 Pod 的持久化目录中。

核心做法是**把来信内容与可执行权限分开** 。当前默认的助手模式不会把陌生人的消息交给有工具权限的主 Agent，而是调用宿主的无工具文本生成接口起草回复。拟稿输入限定为本条来信、同一会话的有限上下文、写作要求和本人为本条补充的资料。模型生成的文字不能直接执行命令或更换接收人；只有插件中的发送器能把经过授权的完整正文发回绑定的来源会话。

### 一条消息如何走到发送

1. **接入与筛选。** 从配置的 DWS profile 接收事件，检查监听开关、私聊/群 @本人/额外发送者规则，按业务消息去重；未命中范围的来信不进入助手。
2. **草稿与自动答复。** 普通消息生成待确认草稿；命中本人预授权规则时，只逐字使用已授权固定正文，并检查期限与频率。模型生成内容不进入免确认自动发送路径。
3. **本人确认。** 卡片回调使用社区插件提供的可信用户 ID，核对本人、账号、卡片、令牌、到期时间和草稿版本。页面上显示的接收对象和正文必须与即将发送的版本一致。
4. **定向发送。** 发送器再次核对监听范围、暂停状态及偏好版本，再用固定 DWS 可执行路径和参数发送；接收目标来自保存的事件，不接受模型或表单另行指定。先记录发送中状态，再执行请求，结果不明时不自动重试。

### 为什么正常主会话不会被一律拦截

当前助手模式的来信走上述专用流程，员工自己在钉钉机器人或 Web 中发起的日常请求仍走原来的主会话。保留的 `before_tool_call` 钩子为旧版监听 Agent 路径提供额外控制；它先判断**宿主工具上下文中的 `sessionKey`** ，再判断命令，而不是扫描所有用户消息或全局禁用 DWS 发信。

旧路径在派发任务之前，先把事件对应的专用会话登记到 `sources.json`：会话键形如 `agent:<agentId>:dws-listener:<hash>`，hash 来自已配置 profile 与事件 ID；登记记录也绑定 profile。钩子核对宿主传来的完整会话键、agentId 和登记记录。消息正文中自称“本人发起”“来自 Web”，或者包含同样的字符串，都不能替代这些宿主字段。

| 实际来源与动作 | 插件处理 | 对正常使用的影响 |
| --- | --- | --- |
| 本人在钉钉或 Web 主会话请求发消息；宿主提供正常会话键 | 来源判为 ordinary，钩子直接返回 | 不额外增加本插件审批；仍受 OpenClaw 原有权限约束 |
| DWS 事件进入默认助手模式 | 范围过滤 → 无工具拟稿/固定正文 → 本人确认或精确预授权 → 固定发送器 | 仅处理员工选择的消息范围 |
| 已登记的旧监听专用会话调用 `dws chat message send` 或 `dws chat +messages-send` | 按 block / approval 配置阻断或要求单次审批；有无 `--yes` 都检查 | 同一条发信命令在监听来源中受控，不因此限制已识别的普通主会话 |
| 会话键缺失，或使用监听标记但登记、profile、agentId 无法核实 | 对匹配的 DWS 发送拒绝执行；跨会话转交/延迟任务也拒绝 | 保守拒绝来源不明的操作，应修复上下文传递，不能假装来源可信 |

**“定向”有明确前提，不是绝对零误拦的承诺。** 正常主会话必须由宿主正确提供会话键，且不使用保留的监听标记；来源缺失时，对匹配的 DWS 发信及任务转交采取保守拒绝。旧路径的命令检测只覆盖指定 DWS 发信形式，不是任意脚本、HTTP、其他工具或主 Agent 的全局安全沙箱。当前助手模式通过无工具拟稿和固定发送器缩小权限面；员工主动补充的敏感资料仍可能出现在草稿里，发送前应核对全文。

## 2. 技术架构与边界

<div id="architecture"></div>

```text
DWS 认证事件 → 范围过滤、业务消息去重 → 持久化草稿/收件箱
                                      ├─ 已授权固定正文 → 确定性发送器
                                      └─ 无工具拟稿 → 本人卡片确认 → 确定性发送器
钉钉社区插件 ← 同进程桥接 → 自定义助手插件 ← SQLite + 个人偏好
```

- **社区插件** 只新增卡片投递与 Stream 回调适配层。通过已有 Stream 连接传递回调的用户 ID、账号、卡片 ID，不从消息正文或表单字段推断身份。没有新增 HTTP 端口或第二条社区插件 Stream 连接。
- **自定义插件** 负责个人偏好、监听、草稿、自动授权、通知和发送。两个仓库使用同一份 0.5.1 业务代码，社区适配层按两版 SDK 的导入路径分别编译。
- **无工具拟稿** 使用宿主 `runtime.llm.complete`，只传写作要求、当前来信、同一会话最近最多 5 条已监听消息及本条本人提供的资料；不启动有工具的 Agent。不同会话上下文不混合，历史未发送草稿不作为已发事实。
- **确认校验** 绑定本人 staffId、社区账号、outTrackId、一次性按钮令牌、到期时间和草稿版本。接收会话只能来自可信 DWS 事件，表单不能更换接收人、DWS profile 或执行命令。本人以外点击、转发卡、旧版本、重复点击都会被拒绝。
- **发送器** 用固定可执行路径和 argv 调用 `dws --profile … chat +messages-send --as user --chat-id … --text … --title 消息 --yes --format json`，`shell:false`。`--yes` 只在插件已完成授权校验后由代码添加；模型不控制它。
- **重启恢复** 先把 sending 状态写入数据库，再发出请求。发送成功才记 sent；超时、断线或进程中断记 unknown，不自动重试，避免重复发信。卡片和草稿可恢复；结果不明时需本人核对钉钉实际记录。

新版等待用户确认只保存状态，不占 main 执行 lane；模型拟稿有自己的串行队列，单次最长 30 秒。DWS 调用最长 20 秒，卡片 API 请求最长 15 秒。Stream 回调接收后异步处理，避免模型请求占住回调确认。

这不表示完全没有同步工作：SQLite 的短事务是同步执行，CPU、磁盘、内存、模型额度仍与主实例共享。命令注册和后台服务通过完整配置指纹绑定，兼容宿主的运行时预热重新注册。持久化不可用、队列超限等情况会停止监听接入，不静默丢弃后继续自动发送。修复问题后由员工重新开启；若状态要求重启，按日志处理。

旧的 `before_tool_call` 来源保护仍保留：对已登记的监听专用会话执行发送控制，对来源缺失或疑似监听但无法核实的会话保守拒绝；匹配的命令为 `dws chat message send` 与 `dws chat +messages-send`。旧兼容执行路径明确指定 `lane: dws-send-approval`。`assistant.enabled:false` 才回到旧方案；旧方案的两命令拦截不能覆盖任意脚本、HTTP 或其他外发工具，不能当作整个主 Agent 的数据隔离沙箱。

## 3. 管理员安装和卡片模板

| 宿主 | 配套社区插件基线 | 本地开发分支 |
| --- | --- | --- |
| OpenClaw 2026.8.1 | 上游 3.8.1，最新拉取的 main，f7422db83b3322c636e9b0ddec47d4583c05b238 | codex/dws-reply-assistant-2026.8.1 |
| OpenClaw 2026.7.1-2 | 本地兼容版 3.6.11，2387afda9f2b74a8a5d3bc02a278e5cb67be63e9 | codex/dws-reply-assistant-2026.7.1-2 |

需要同时安装对应的**改造版社区插件** 与 **dws-send-approval 0.5.1** 。不修改 OpenClaw 核心或 DWS 源码。上游 3.8.1 包仍要求新宿主，不可安装到旧宿主。

卡片模板已于 2026-09-24 在测试组织的钉钉开发平台成功导入、编译和发布，发布前诊断为 0。请使用 [钉钉开发平台卡片入口](https://open-dev.dingtalk.com/fe/card)，选择目标组织，在 **消息卡片 → 普通卡片** 下新建，关联实际机器人应用。不要进入个人 AI 卡片页面，也不要把请求体当作模板源码导入。

包内有两份模板：`templates/dws-reply-assistant-card.json` 是可维护的编辑器导入源码；`templates/dws-reply-assistant-card.platform-export.json` 是本次实际发布后从平台导出的文件。导入到本企业后编译、预览、发布，复制平台生成的完整模板 ID（包括 `.schema` 后缀）到 `assistant.cardTemplateId`。源码中的空 `widgetInfo` 由平台编译生成。

本次测试模板 ID 为 `b053717f-2e9a-4326-9e90-560371cc7506.schema`，仅作为验证记录，**不能直接作为其他企业或应用的通用配置值** 。实际目标租户仍需验证应用可用范围和客户端表现。

模板需能被机器人所属应用使用；同一应用下可统一分发同一个 ID，跨应用需配置可用范围或分别发布。卡片回调为 STREAM，复用社区插件已有卡片回调处理。与 `dingtalk_ask_user_question` 表单模板是不同的模板，不要混用。

首次部署先配置身份和模板，暂关闭插件条目；安装后启用条目，保留 `listener.enabled:false`。若使用 `plugins.allow`，追加 `dws-send-approval` 并保留现有钉钉插件 ID。

```bash
# 旧宿主安装自定义插件
openclaw plugins install /absolute/path/dws-send-approval-0.5.1.tgz --force

# 新宿主安装自定义插件
openclaw plugins install /absolute/path/dws-send-approval-0.5.1.tgz --force --accept-capabilities
```

社区改造包按对应宿主用同一安装命令安装；不要同时从原目录和新包加载同一个社区插件。源码加载方式下，修改 `plugins.load.paths` 指向对应新工作目录，并先执行 `pnpm run build:runtime`，宿主实际加载 `dist/index.js`。

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins inspect dws-send-approval --runtime --json
openclaw channels status --probe --json
```

本次真机验证临时切换了两版 Gateway 配置、插件路径并重启；两份配置、临时数据库和偏好均已按字节恢复，原 Gateway 已启动且钉钉重新连接。清理状态记录在交付包 `live-validation.json`。验证期间个人消息监听始终关闭。部署时检查两个宿主分别使用的配置目录、端口、状态卷和插件路径，避免用新 SDK 包替换旧宿主的兼容包。

## 4. 配置项从哪里来

| 字段 | 来源与含义 |
| --- | --- |
| ownerUserId / OC_OWNER_STAFF_ID | 本人给社区机器人发消息时的 senderStaffId。支持 `/whoami` 的版本可在私聊查询；不是姓名、企业工号或 DWS 开放 ID |
| profile / OC_DWS_PROFILE | 同一系统账号、同一 DWS_CONFIG_DIR 下，执行 `dws profile list --format json`。核对所属组织和本人，选实际 profile 名，不盲取第一项 |
| dwsPath | Pod 中的绝对可执行路径；由 `command -v dws` 确认。样例的 /usr/local/bin/dws 应按镜像调整 |
| APPROVAL_BOT_OPEN_DINGTALK_ID / OC_APPROVAL_BOT_OPEN_ID | 社区机器人在 DWS 个人消息事件里的 sender_open_dingtalk_id；不是 clientId、robotCode 或本人的 staffId |
| assistant.cardTemplateId / OC_DWS_ASSISTANT_CARD_TEMPLATE_ID | 本应用可使用的已发布代回复助手卡片模板 ID |
| accountId / agentId | 已配置的社区机器人账号和模型配置来源，通常 default / main |

获取机器人开放 ID：先保持本插件监听关闭，以同一 DWS profile 执行有界观察；让 A 在社区机器人私聊发一条测试消息，找到机器人的实际回复事件，核对内容和发送者后复制 sender_open_dingtalk_id。

```bash
dws --profile PROFILE_NAME event +listen-im --kind all-direct --events message --duration 2m
```

观察输出含个人消息，避免收集不必要正文或上传完整输出；观察结束后再开启插件。`ignoreSenderOpenIds` 用于排除审批/助手机器人，防止提醒被再次当来信处理；如个人事件可能包含本人的发出消息，也把已核实的本人开放 ID 加入排除列表。

### 单实例配置

下面文件是合并片段，保留原有 channels、agents、Web 权限及其他插件配置。`approvals.plugin` 用于兼容旧审批；不要覆盖其他插件现有的审批目标。

```json
{
  "commands": {
    "text": true,
    "allowFrom": {
      "dingtalk": [
        "OWNER_STAFF_ID"
      ]
    }
  },
  "approvals": {
    "plugin": {
      "enabled": true,
      "mode": "targets",
      "targets": [
        {
          "channel": "dingtalk",
          "accountId": "default",
          "to": "user:OWNER_STAFF_ID"
        }
      ]
    }
  },
  "plugins": {
    "entries": {
      "dws-send-approval": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "accountId": "default",
          "ownerUserId": "OWNER_STAFF_ID",
          "profile": "PROFILE_NAME",
          "dwsPath": "/absolute/path/to/dws",
          "mode": "approval",
          "timeoutMs": 120000,
          "listener": {
            "enabled": false,
            "ignoreSenderOpenIds": [
              "APPROVAL_BOT_OPEN_DINGTALK_ID"
            ]
          },
          "assistant": {
            "enabled": true,
            "cardTemplateId": "PUBLISHED_ASSISTANT_CARD_TEMPLATE_ID",
            "draftTtlMinutes": 1440,
            "cardTtlMinutes": 30
          }
        }
      }
    }
  }
}
```

`commands.allowFrom.dingtalk` 只允许本人使用该渠道的宿主命令，它不替代 `channels.dingtalk.dmPolicy/allowFrom`。保留原有其他渠道项，不添加全局 `*` 规则；该钉钉项不会改变 Web 渠道原有权限。所有助手命令和按钮仍独立校验本人身份及私聊来源。

`mode:block` 是平台层禁止代发送；不等于停止监听。员工开关及选项存放在独立状态文件中，已有偏好优先于初始模板。

## 5. 15000 个 Pod 的统一部署

同一镜像、同一 ConfigMap 模板，员工差异由开户平台注入环境变量：

| 变量 | 是否因人不同 |
| --- | --- |
| OC_OWNER_STAFF_ID | 是；与本 Pod 员工绑定 |
| OC_DWS_PROFILE | 是；必须是该员工已授权的 DWS profile |
| OC_APPROVAL_BOT_OPEN_ID | 按机器人绑定；同一机器人可相同 |
| OC_DWS_ASSISTANT_CARD_TEMPLATE_ID | 按应用授权范围共享或分别配置 |

直接使用包内 `config.kubernetes.example.json`，宿主支持字符串中的 `${ENV_NAME}` 替换。环境变量缺失应由部署校验发现，不能把另一个员工的默认身份补给当前实例。DWS OAuth 登录态由每个员工独立授权并保存；复制 profile 名不能复制出有效授权。

OpenClaw 状态目录和 DWS 配置目录挂载员工独立的持久卷。不要让两个运行中的 Pod 共用同一员工状态卷、profile 和监听；更新策略确保同一员工只有一个活动实例。共享 ConfigMap 只负责初始默认值，不写回员工设置。

员工的规则在 `<service stateDir>/dws-send-approval/preferences.json`；草稿、按钮令牌、自动授权、冷却和记录在 `assistant.sqlite`（含运行时 WAL）；旧来源保护在 `sources.json`。目录 0700、数据库 0600。备份/迁移应暂停服务并完整保留状态，或使用 SQLite 一致性备份；不要只复制活跃数据库而遗漏 WAL。

首次默认关闭。员工主动开启后，Pod 重建从个人持久卷恢复其选择；这与“新员工默认不开启”并不冲突。自动授权到期自动失效；卡片默认有效 **30 分钟** ，`assistant.cardTtlMinutes` 可设 1–1440 分钟；绝对到期，翻页、修改及保存都不延长。每次新发 `/dws` 会停用旧卡。草稿默认 24 小时，`draftTtlMinutes` 可设 10–10080 分钟，两者互不替代。最多 200 条待处理、1000 张卡片记录；已完成记录保留 30 天，结果未知记录保留待核实。到期卡片保留最多 7 天用于回写失效状态。服务端按绝对时间拒绝回调，不依赖前端是否及时刷新。后台每 30 秒巡检，每轮最多回写 10 张失效卡；网络失败继续重试，不能恢复其操作权限。升级前已被清理的历史记录无法回写卡面，但点击同样被拒绝。

全部私聊 + 所有群 @本人可合并为一个 DWS consume 进程；指定人员可能按唯一目标增加消费进程，最多 41 个（两个各 20 人列表并集 + 一个广泛订阅）。DWS 自身的事件总线进程、连接、认证与平台订阅配额也要纳入集群预算。群范围过滤在本地，不会为每个群额外创建一个消费进程。

升级前先 `/dws-listen off`，结束旧宿主审批，备份偏好、sources.json 和整个助手状态目录；安装两个匹配包并重启后再由员工开启。回滚 0.4.0 时恢复升级前偏好快照，因为它不认识新增的 inbox 模式；保留发送记录供核对，不把 unknown 状态批量重试。

## 6. 本次同时调整的社区能力

两个版本都把媒体加载器的默认 5 MiB 限额显式提高到 **20 MiB（20 × 1024 × 1024 字节）** ，保留本地文件根目录权限。文件上传本身原已有 20 MiB 校验，修复的是进入上传前的宿主加载限制。平台特定媒体限制仍生效，例如语音仍为 2 MiB。

`dingtalk_ask_user_question` 定向群表单可指定 **1–1000 个不重复的 staffId** ，`timeoutMinutes` 最大 **4320（72 小时）** 。无 target 的旧表单仍使用原 5 分钟行为。扩大插件上限不代表钉钉平台必然接受每个实际文件或群场景，平台权限和接口限制仍按返回结果处理。

72 小时是本次表单实例的最长等待时间；社区原有表单在 Gateway 重启时会终止，不能把它理解为跨重启继续收集 72 小时。它与助手 SQLite 中可恢复的草稿是两个独立功能。

## 7. 验证、性能与交付状态

| 验证范围 | 结果 |
| --- | --- |
| 新版社区插件（2026.8.1） | 150 个测试文件，1687 项通过；类型、lint、运行时和类型构建、格式检查通过 |
| 旧版社区插件（2026.7.1-2） | 130 个测试文件，1337 项通过；类型、lint、运行时和类型构建通过；全量格式检查有基线差异 |
| 自定义助手 | 151 项通过；覆盖越权、重放、绝对过期、旧卡停用、完整按钮/选项矩阵、目标校验、群名缓存、自动授权/限流、上下文隔离、重启恢复与异步接入 |
| 两版已安装宿主 | 真实 SDK 入口加载、6 个命令注册、默认关闭、本人鉴权；实际宿主旧审批 broker 与 lane 隔离验证通过；新增运行时预热重复注册回归通过 |
| 新增社区边界 | 20 MiB / 超限文件、语音原限制、1000 / 1001 人、4320 / 4321 分钟、回调信任边界 |

旧版基线的全量格式检查有 32 个既有文件不符合当前格式化器输出。本次已剔除 31 个无关文件的纯格式改动，媒体文件仅保留上限修复；未为通过格式检查而批量重排旧代码。两版 lint 均为零错误，仍有基线已有警告。两份 HTML 已通过结构、链接和脚本语法校验，并经授权使用仅本机可访问的 HTTP 预览完成桌面浏览器验收（1280 × 720）：封面、总览、表格、代码块及交互示意显示正常，正文未出现页面级横向溢出；单选、多选、输入及五步授权页面跳转已验证。浏览器工具的窄屏覆盖未实际生效，因此不将本次检查计作移动端视觉验收。

本地资源基准环境：**Apple M5 · macOS arm64 · Node v26.8.1** 。0.5.1 本轮复测：单进程助手，1000 条合成来信、50 个会话、1000 次模拟拟稿、200 次模拟发送，SQLite 真正写盘。测试脚本为 `scripts/bench-assistant.mjs`，原始 JSON 随技术文档提供。

| 指标 | 本次实测 |
| --- | --- |
| 空闲采样 | 10.00 秒，CPU 19.59 ms，约单核 0.20% |
| 1000 条处理总时间 | 0.739 秒，约 1354 条/秒（模拟外部调用） |
| 每条耗时 | P50 0.63 ms；P95 1.20 ms；P99 1.85 ms |
| RSS | 测前 68.95 MiB，峰值 92.22 MiB，增量 23.27 MiB |
| 堆已用 / 数据库含 WAL | 13.56 MiB / 5.13 MiB |
| 事件循环延迟 P99 | 11.23 ms |

RSS 包含本次独立 Node 测试进程及其基础模块，不是整个 Pod 的总量或生产 Gateway 增量。空闲采样仅 10 秒，不能代表长期平均。可复现命令：

```bash
node --expose-gc scripts/bench-assistant.mjs /tmp/assistant-benchmark.json
```


这些数据不能直接乘以 15000 推算集群容量：基准没有运行完整 Gateway、卡片过期批量回写、通讯录/群名校验、DWS consume/bus 进程、真实模型或钉钉网络，也不覆盖大文件并发上传和 1000 人真实填表。实际容量需按员工启用比例、订阅目标数、来信峰值、模型配额与磁盘类型测量。默认不开监听有助于避免无意启动 15000 组消费进程。

本次已完成开发平台模板发布及两版宿主的桌面真机卡片交互；详细覆盖范围见下一节。未执行手机端、真实个人消息接收/拟稿/发送完整链路、20 MiB 实际上传、1000 人真实填表或 Kubernetes 15000 实例压测。

真机测试只在本人和测试机器人私聊中操作，没有替本人向联系人或群发送个人 IM 消息。没有提交或发布远端 Git 代码；发布的是测试组织内新建的专用卡片模板。原有问卷卡片模板未修改。


## 8. 卡片协议、组件与发布验收

模板只是可复用的展示结构，业务状态保存在插件中。首页、范围设置、草稿、批处理和历史使用同一个模板，以变量切换标题、说明、动态表单及最多六个按钮；不是把所有页面塞进一张卡片。

| 模板部分 | 数据/协议 | 服务端职责 |
| --- | --- | --- |
| CardHeaderV2 / BaseText | title、description | 展示对象和完整草稿正文 |
| Form | form.fields（输入、多行输入、单选、多选） | 验证字段与允许的操作 |
| 六个 SingleButton | button1…6、action1…6 | 保存一次性令牌与按钮索引绑定 |
| 可见性表达式 | card_status、show_button_1…6 | 隐藏空按钮，过期后禁用 |
| Stream request 事件 | cardPrivateData.actionIds、params.form | 从顶层 userId/outTrackId 校验真实操作者 |

钉钉官方提供[模板导入示例](https://github.com/open-dingtalk/dingtalk-card-examples)、[事件链能力](https://open.dingtalk.com/document/dingstart/using-event-chains-for-card-interaction)与[卡片回调示例](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/)。这些文档证明能力存在，不能替代本模板在目标租户的实际验收。

模板发布流程：新建专用模板 → 导入 JSON → 编译/预览 → 发布 → 取得模板 ID → 确认机器人可使用 → 配置并构建插件 → 重启 Gateway → 确认 Stream 已连接 → 本人私聊 `/dws` → 操作按钮并检查真实回调。不要覆盖既有问卷模板。

### 真实平台验证记录

环境：2026-09-24，macOS 钉钉桌面客户端，OpenClaw Test 测试组织。同一个专用模板先后接入 OpenClaw **2026.8.1** 和 **2026.7.1-2** ，每次都构建 runtime、确认实际工作树路径与 Stream 连接；两个宿主没有同时占用机器人连接。

| 场景 | 验证方式与结果 |
| --- | --- |
| 模板导入、编译、发布；首页、按钮、回复正文保存 | 前一轮已在两个宿主桌面真机通过 |
| 绝对到期、旧卡停用、清除过期卡控件 | 新版以 3 分钟测试 TTL 真机验证；到期后保存没有改变偏好。正常配置默认 30 分钟 |
| 人员 UserId 文本输入、逗号和换行、去重、保存 | 新版真实 DWS 解析、回调和落盘验证通过 |
| 完整群名校验、指定群保存；单选选中态 | 新版真实 DWS 查询与保存通过，修复原下拉默认值协议差异 |
| 重点联系人与 30 分钟提醒间隔 | 新版真实表单保存通过 |
| 范围总览、独立私聊/群/额外发送者页 | 旧版实际渲染、私聊与指定群保存通过 |
| 回复方式、人员/群对象校验、规则编辑 | 旧版通过；修复并复验跨页同名字段串值 |
| 自动答复向导、回退修改、完整摘要、创建与撤销授权 | 旧版通过，监听关闭且发送处于 block 模式 |
| 提醒子页、暂停与恢复、待处理、草稿、修改、重新生成表单、历史 | 旧版逐页打开；提醒保存、暂停与恢复通过。未执行模型重新生成或个人消息发送 |
| 最后拆出的期限、发送频率、提醒方式、汇总间隔四页 | 两版桌面真机均通过；标题、选项、到期时间、操作按钮完整显示，无裁切 |
| 文字命令分段、标题、列表、群名称 + ID | 新版格式、旧版完整群名及 ID 显示通过 |
| 每个页面导航、全部枚举选项、批处理、保存/取消、错误回退 | 151 项自动化测试覆盖，外部发送使用模拟器 |
| 手机端、真实个人消息代发送 | 未测；不能把自动化回调测试等同于全部真机操作 |

最终补验在 1311 × 768 的 macOS 钉钉窗口完成。新版选取 24 小时授权、60 分钟间隔，旧版选取 7 天授权、一天间隔；前进、返回后选中态保留，最终摘要与输入一致。新版实际保存再撤销测试授权，旧版取消后没有新增授权。提醒方式和汇总间隔分别保存，不覆盖其他字段；旧版重新打开仍选中已保存值，修改后仅点返回不会保存。两版均回读数据库核对结果，个人消息监听全程关闭、发送处于 block 模式，未向联系人或群发送个人消息。结束后恢复两份配置、数据库和偏好快照，原 Gateway 运行且钉钉重新连接。

**组件改造：** 全部人员/群目标改用多行文本框。普通枚举改为直接可见的 `CHECKBOX_GROUP` 单选，批处理使用 `MULTI_CHECKBOX_GROUP` 多选，不再依赖下拉菜单。监听范围拆为总览 + 三个独立设置页；回复方式拆为总览、对象校验和规则编辑；自动答复拆为范围、正文、期限、频率及最终摘要五步；提醒拆为四个独立子页。待处理和历史每页最多 3 条，授权与暂停列表每页最多 5 项，无前后页时不显示相应按钮。多数设置页只有 1–2 个字段，免打扰页保留开始、结束、时区三项。

文本输入支持英文逗号、中文逗号及换行，去重后最多 20 项。人员必须是钉钉 UserId，可能与企业工号不同；精确查询匹配 UserId 后才采用返回的 openDingTalkId。群名要求完整匹配，扫描分页确认唯一；重名时明确报错并要求 `完整群名#完整会话ID`，不自动取第一个结果。查询失败或无权限时不保存半套设置，并保留已填文本。

卡片成功校验的名称保存在员工本地目录。`/dws-listen at groups <ID>` 和 `status` 会用 `chat conversation-info --group <ID>` 获取名称，仅接受返回 ID 一致的群详情。显示为“群名称 · ID”；无名称显示“名称待核实”。名称只用于展示，过滤与发送始终使用绑定的稳定 ID。每次查询最多 4 个并发、总预算 5 秒，成功缓存 1 小时、失败至少间隔 1 分钟；网络问题不撤销已经保存的监听设置。仍可能看到缓存期间的旧群名，以 ID 为准。

本轮无需重新发布模板，动态 `form.fields` 即可承载新的字段和布局。此前发布验收修复的预览数据、空事件链和旧宿主预热重复注册问题保持不变。原有问卷模板未修改。每次页面渲染还会给表单字段分配唯一前缀，只接收当前卡片字段，防止钉钉保留同名字段的上一页值。向导最终确认使用服务器保存的范围和完整正文，忽略提交表单中的篡改值。

新内联单选的默认值是字符串、多选为数组；旧下拉使用的 `{index,value}` 结构不能混用，已添加协议回归并在客户端确认选中态。

可核对的记录：仓库 `docs/assets/dws-assistant-live-validation.json`，交付包 `live-validation.json`。记录包含实际模板 ID、场景、修复和排除项，不包含凭据或聊天正文。两份原配置与临时数据已恢复，原 Gateway 探测 `running=true`、`connected=true`。保留发布的专用测试模板用于复验；误入个人 AI 卡片入口产生的两个未发布草稿未删除，也未用于测试投递。

### 故障定位与回滚

1. 模板导入失败：确认 JSON 是搭建器导出格式，不是 createAndDeliver 请求体；保存平台原始错误及版本。
2. 投递失败：核对模板已发布、应用授权、真实 staffId、机器人账号；不要把 clientId 当模板 ID。
3. 卡片可见但点击无效：检查 STREAM 回调、outTrackId 与一次性 actionId；不得降级为信任表单中的 userId。
4. 页面过期或正文改变：重新 `/dws` 获取新卡，按新版本确认；不要关闭版本校验。
5. 临时真机调试结束：恢复原配置路径并重新启动 Gateway，验证频道重新连接。新增测试模板保留用于复验；不把测试模板 ID 写入通用配置。

## 9. 开发、打包与交付

自定义插件源码在 `examples/dws-send-approval/`，社区适配层在 `src/card/reply-assistant-bridge.ts`。修改公共业务逻辑后同步两版，适配层保留各自 SDK 路径。

```bash
node examples/dws-send-approval/scripts/check.mjs
node --test examples/dws-send-approval/tests/*.test.mjs
npm run type-check
npm run lint
npm test
npm run build:runtime
npm run build:types
npm run pack:check
node examples/dws-send-approval/scripts/package.mjs
```

运行时构建后再构建类型文件，避免 dist 清理导致声明丢失。交付包分别包含 `DEVELOPER.html` / `DEVELOPER.md` 与 `USER-MANUAL.html` / `USER-MANUAL.md`；`GUIDE.html` 仅作入口，不再合并两类文档。所有配置中的示例 ID 都必须由部署系统或管理员绑定。

---

基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，https://github.com/soimy/openclaw-channel-dingtalk 。MIT；模板与改造代码随包保留 LICENSE。DWS 命令核对自 https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli 的 1.0.58 代码。OpenClaw 兼容验证使用本机两版已安装宿主。
