# 自定义卡片扩展接口

独立 OpenClaw 插件可以通过 `@soimy/dingtalk/card-extensions`，向指定用户投递机器人私聊卡片、更新卡片变量并接收按钮或表单回调。接口复用 Channel 的账号、SecretInput 解析、token 缓存和 Stream 连接，不创建额外连接、HTTP 服务或模型工具。

首版仅支持机器人私聊卡片。群卡片、模板设计、业务存储与业务审批不属于本接口。

## 安装与导入

运行环境需要 OpenClaw ≥ 2026.8.1，并启用包含本接口的 DingTalk Channel 版本。请在[开发者后台的卡片平台](https://open-dev.dingtalk.com/fe/card)选择当前企业及机器人所属应用，使用该应用可访问的已发布互动卡片模板；机器人需具备原有卡片 API 权限。平台的个人卡片入口与企业开发者入口不同，不能仅凭“已发布”判断模板可由当前机器人投递。

`variables` 的键名必须与所选模板一致，对象或表单配置须先 `JSON.stringify`。本接口不会替消费者选择模板、补充模板默认值或修改模板。API 成功仅表示请求成功，还应在钉钉客户端确认内容渲染、表单提交和更新结果。

```ts
import {
  registerDingTalkCardExtension,
  type DingTalkCardExtension,
} from '@soimy/dingtalk/card-extensions';
```

OpenClaw 独立安装的插件通常不共享 `node_modules`。不要假设启用 Channel 后，这个包就能从消费者目录解析：

- 将提供本接口的 `@soimy/dingtalk` 版本声明为消费者的开发依赖，在构建时把 **`/card-extensions` 子入口**打入消费者 bundle；不要把该子入口列为 external。这是推荐方式。
- 或者在消费者自己的依赖目录安装该包，在运行时导入子入口。不要再次把这份依赖注册成一个 Channel。

子入口不导入 Channel、OpenClaw SDK、HTTP 客户端或 Stream SDK。不同安装副本和独立 bundle 通过有版本校验的进程内注册表通信；不兼容版本报 `version-mismatch`。这是同一 Gateway 进程内的接口，跨进程使用不受支持。

## 生命周期与最小示例

在消费者插件的 manifest 中声明 `"activation": { "onStartup": true }`（支持按需激活的宿主需要此声明，才能启动该后台服务）。在服务 `start` 中注册，在 `stop` 中注销。注册本身不访问网络，可早于 Channel 连接完成；发送前检查 `getStatus()`，未就绪时由消费者提示用户稍后重试，不需要轮询或启动时自动发送。

下面演示“本人修改一条设置并保存”。`ownerUserId`、`templateId` 和 `accountId` 来自消费者自己的配置。模板应有 `title`、`status` 字符串变量、名为 `note` 的文本表单项，以及动作 ID 为 `save` 的提交按钮。

```ts
let cards: DingTalkCardExtension | undefined;
const pending = new Map<string, { owner: string; expiresAt: number; saving: boolean }>();

api.registerService({
  id: 'settings-card-example',
  start() {
    cards = registerDingTalkCardExtension({
      accountId: config.accountId,
      namespace: 'settings-example',
      async onAction(action) {
        const state = pending.get(action.cardId);
        if (!state || state.saving || Date.now() > state.expiresAt) return;
        if (action.userId !== state.owner || !action.actionIds.includes('save')) return;
        const note = action.form.note;
        if (typeof note !== 'string' || note.length > 200) return;

        state.saving = true; // 在异步操作前占位，避免并发提交。
        try {
          // 示例只更新显示，不写业务数据。实际业务应以 cardId 做持久化幂等。
          await cards!.updateCard({
            cardId: action.cardId,
            variables: { title: '设置已保存', status: 'saved' },
          });
          pending.delete(action.cardId);
        } catch (error) {
          state.saving = false;
          throw error;
        }
      },
    });
  },
  stop() {
    cards?.dispose();
    cards = undefined;
    pending.clear();
  },
});

// 在消费者自己的已鉴权命令或业务入口中调用；先验证发起人权限。
async function showSettings(cardId: string) {
  if (cards?.getStatus() !== 'ready') throw new Error('钉钉连接尚未就绪，请稍后重试');
  pending.set(cardId, { owner: config.ownerUserId, expiresAt: Date.now() + 600_000, saving: false });
  return cards.sendCard({
    cardId,
    userId: config.ownerUserId,
    templateId: config.templateId,
    variables: { title: '编辑设置', status: 'pending' },
  });
}
```

此示例只使用内存状态，重启后旧卡片不再执行操作。需要重启后继续处理的业务，应自行持久化、恢复卡片 ID、所有者、到期时间和处理状态。

## 接口约定

| 方法或字段 | 说明 |
| --- | --- |
| `registerDingTalkCardExtension({ accountId, namespace, onAction })` | 显式绑定账号与命名空间。同账号同命名空间重复注册报错；不同账号互不影响。 |
| `getStatus()` | 本地同步检查，返回 `ready`、`unavailable`、`account-unconfigured`、`account-disabled`、`not-connected` 或 `disposed`。无 HTTP 请求。 |
| `sendCard({ cardId, templateId, userId, variables })` | 创建并投递给企业内 `userId`（staffId），不是 unionId/openDingTalkId。固定使用 STREAM 回调，禁止转发。返回 `{ outTrackId }`。 |
| `updateCard({ cardId, variables })` | 按相同账号、命名空间及业务 ID 更新变量。只更新提供的键；失败不创建替代卡片。返回 `{ outTrackId }`。 |
| `dispose()` | 幂等注销，停止后续回调；不会撤销已发出的卡片、取消正在执行的回调或 HTTP 请求。旧句柄不能注销新注册。 |
| `variables` | `Record<string, string>`；对象、数组由消费者先 `JSON.stringify`。1–256 个键，键长 ≤128，序列化后 ≤262144 字符。钉钉自身还有模板/API 限制。 |

账号 ID 允许字母、数字、下划线、短横线，长度 1–64；命名空间为小写字母开头、后续小写字母/数字/短横线，长度 1–32；`cardId` 允许字母、数字、下划线、短横线，长度 1–64。最终 `outTrackId` 为 `ocx1.<accountId>.<namespace>.<cardId>`，总长不超过 128。把该格式视为路由协议，不要手工构造其他扩展的 ID。

`templateId` 和用户 ID 必须是平台提供的真实标识。不会默认回退到其他账号，也不接受自定义 API URL 或 token。

## 回调与信任边界

`onAction` 收到：

- `accountId`：接收该事件的 Channel 连接账号。
- `namespace`、`cardId`、`outTrackId`：从 Stream 外层卡片 ID 解析，并与接收账号核对。
- `userId`：仅取 Stream 外层用户 ID；缺少或格式错误时不执行回调。
- `callbackId`：可选的 Stream 消息 ID，便于诊断或去重，不承诺 exactly-once。
- `actionIds`、`form`：不可信的模板与用户输入；对表单项的 `{ value: ... }` 包装解包，其他值保持原样。

模板回调应把动作和表单放在 `content`（或 `value`）的 `cardPrivateData.actionIds`、`cardPrivateData.params.form` 中。`content`/`value` 可以是 JSON 字符串或对象。表单和嵌套字段中的身份声明不能改变路由、账号或操作人。

消费者必须自己核验 **操作人、卡片所有者、动作、输入、到期时间、当前业务状态和幂等性**。可信用户 ID 不等于该用户获得所有业务操作权限。禁止把表单原文直接作为可执行指令。

只接管外层 ID 使用保留前缀 `ocx1.` 的卡片。即使动作名与内置 `btn_stop`、反馈或问卷动作相同，也不会进入内置处理器；扩展已注销、路由错误或回调失败时仍消费该扩展事件，不交给 Agent。内置卡片继续使用原流程。

Stream ACK 仍由 Channel 管理；消费者抛错不会引起跨处理器回退。回调应尽快完成，耗时业务可先持久化入队后返回。接口不提供业务队列或事务，也不保证回调仅到达一次。

这是受信任插件之间的进程内扩展点，不是针对恶意已安装插件的沙箱。

## 失败处理与运行成本

异常的 `code` 是稳定契约。独立打包时可能有多个错误类副本，推荐检查 `error.code`，不要依赖 `instanceof`。

| 错误 | 处理建议 |
| --- | --- |
| `unavailable` | 确认 Channel 已启用并支持接口。 |
| `account-unconfigured` / `account-disabled` | 核对显式账号 ID、凭据配置和启用状态。 |
| `not-connected` | 等待现有 Channel 建连/重连后重试。 |
| `namespace-conflict` | 一个账号内同一扩展只注册一次；停止时注销。 |
| `disposed` | 创建新的注册句柄。 |
| `version-mismatch` | 升级 Channel 与消费者使用的接口版本，使协议一致。 |
| `invalid-argument` | 修正 ID、模板 ID、用户 ID或变量格式。 |
| `request-failed` | 核对卡片 API 权限、模板发布和网络；异常仅含有限状态信息，不附带凭据或卡片正文。 |

创建和更新不增加自动重试；token 获取仍沿用现有缓存与有限重试。发送超时可能是结果不确定，不应换一个 ID 盲目重发。消费者应保存稳定业务 ID，按业务规则核对结果和幂等处理；更新不暗中降级为创建。

每次回调只做前缀判断、账号/命名空间查表和字段归一化，没有模型调用、子进程或额外 Stream。未使用接口时不增加驻留进程。注册表仅保存扩展句柄与活动账号传输，不保存业务卡片内容或历史。创建/更新才发生原有钉钉 API 请求，耗时取决于网络和平台。

新增日志仅记录路由、处理状态等元数据，不打印表单、卡片变量或异常原文。详见 [架构说明](./architecture.zh-CN.md) 与 [测试规范](./testing.md)。
