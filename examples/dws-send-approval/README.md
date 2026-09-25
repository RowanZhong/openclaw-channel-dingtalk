# DWS Reply Assistant 0.6.0

个人钉钉代回复助手：本人卡片设置、默认关闭监听、持久化待回复、发送/修改/重新拟稿/忽略/暂停、批量选择、固定正文预授权、默认即时审批提醒、群消息引用回复和处理记录。

支持 OpenClaw 2026.7.1-2 / 2026.8.1，DWS 1.0.58，Linux/macOS。需要配套改造的社区钉钉插件；不修改宿主和 DWS 核心。两个适配分支分别使用社区 3.6.11 / 3.8.1 基线。

- 自动身份：后台读取并校验当前 DWS profile，按社区 clientId 自动找到机器人开放 ID；未登录不阻塞 Gateway 启动。本人私聊 `/dws identity` 自检，`/dws identity refresh` 后台刷新。
- 员工入口：本人机器人私聊 `/dws`。卡片失败可用 `/dws list`、`/dws show 23` 和机器人返回的 `/ok 23-2`。
- 首次 `listener.enabled:false`；员工选择范围后主动开启。已有个人偏好从员工 PVC 恢复。
- 发布 `templates/dws-reply-assistant-card.json` 后把真实 ID 写入 `assistant.cardTemplateId`。同一应用可统一模板；跨应用核对模板权限。
- 使用 `config.example.json` 或 `config.kubernetes.example.json` 合并到原配置，保留其他插件和 Web 权限。
- 新助手使用无工具 completion 拟稿；用户确认的正文和预授权固定正文通过确定性发送器发送。旧的两命令来源保护保留。
- 原始状态、目录、profile 均按员工隔离。不要将两个活动 Pod 指向同一状态卷。

文档按读者拆分：

- **DEVELOPER.html / DEVELOPER.md**：开发技术方案与安装配置，含模板发布、自动身份发现、启动失败隔离、Kubernetes、测试及性能。
- **USER-MANUAL.html / USER-MANUAL.md**：员工使用手册，含卡片操作、监听组合、自动答复与文字备用命令。

GUIDE.html 仅为文档入口。仓库源文件分别在 `docs/contributor/dws-reply-assistant-deployment.md` 与 `docs/user/dws-reply-assistant-manual.md`。

```bash
node scripts/check.mjs
node --test tests/*.test.mjs
node --expose-gc scripts/bench-assistant.mjs /tmp/assistant-benchmark.json
```

本地 221 项回归和两版真实宿主 SDK/审批兼容测试通过；专用模板已在钉钉开发平台发布，两版均已验证桌面卡片显示、按钮回调和多行输入保存。本轮已改为文本目标校验、可见单选/多选和分组设置页，并增加绝对过期及历史卡停用；两版已完成真实群 @接收、即时审批卡、批准后原文引用回复、话题关联、名称自动补全及原操作卡继续可用的桌面真机验收；手机端及 15000 Pod 压测尚未完成，详见开发文档的验证记录。安装不自动开启监听，也不替代主 Agent 全局权限管理。

基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，https://github.com/soimy/openclaw-channel-dingtalk 。MIT，见 LICENSE。
