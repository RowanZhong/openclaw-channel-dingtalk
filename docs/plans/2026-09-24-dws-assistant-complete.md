# DWS reply assistant — complete delivery

Approved scope: a single release with owner-only DingTalk cards for opt-in setup,
listener scopes, reply preferences, preauthorized exact answers, persistent drafts,
edit/regenerate/send/ignore/pause, selected-item batch actions, notifications,
history, and short fallback commands. Tool-free completions draft messages;
only the deterministic sender may deliver them. Preserve the old source guard.

Baselines:
- OpenClaw 2026.8.1: fresh upstream main f7422db83b3322c636e9b0ddec47d4583c05b238,
  branch codex/dws-reply-assistant-2026.8.1, sibling worktree
  openclaw-channel-dingtalk-dws-assistant-2026.8.1 (upstream package 3.8.1).
- OpenClaw 2026.7.1-2: existing 3.6.11 worktree at
  2387afda9f2b74a8a5d3bc02a278e5cb67be63e9, new branch
  codex/dws-reply-assistant-2026.7.1-2; preserve its existing forms work.
- Copied dws-send-approval 0.4.0 to both before implementation.

Implementation boundaries: custom plugin owns durable business state, policy,
model calls, directory reads, notifications and DWS sender. Community channel
owns card transport and trusted Stream callback identity, exposed through a
versioned in-process bridge (no additional Stream client, HTTP port or service).
Cards bind owner/account/outTrackId/action/version/expiry; arbitrary callback
fields cannot supply recipients or authorization. Exact-answer automation has
explicit scope, expiry and cooldown. Failed/unknown deliveries are never blindly
retried. New messages invalidate old draft versions. Pausing prevents new sends.

Verify both source trees with build/type/lint/tests and real host contract/load
checks. Add security/concurrency/restart and resource benchmarks, plus HTML usage
and deployment documentation. Keep real DingTalk/template publication and client
rendering checks distinct from simulated transport and measured local load.

Do not modify the original unrelated forms branch or publish packages/PRs.


## 0.5.1 卡片与范围 UX 修复

- [x] 卡片绝对到期（默认 30 分钟）、新卡停用历史卡、服务端拒绝与后台回写失效。
- [x] 人员 UserId / 完整群名文本输入、精确校验、多项分隔、重名拒绝、错误保留输入。
- [x] 移除下拉菜单，使用可见单选/多选并修正平台默认值协议。
- [x] 范围总览 + 私聊/群 @/额外发送者三个独立页面，仅保存当前组。
- [x] Markdown 设置结果、已校验群名 + ID、有界只读群详情查询与缓存。
- [x] 两版自定义回归 151 项；无外发模拟器覆盖全部按钮/枚举。
- [x] 旧版逐页导航、保存、群名排版及字段隔离复验；新版过期、目标校验与格式验证。
- [x] 到期时间精确到分钟、不显示时区；两份独立 HTML 视觉设计与离线预览更新。
- [x] 最后四个拆分页已在两版宿主桌面真机复验：显示、选择、前进/返回、最终摘要、保存/取消和持久化均通过，见 live-validation.json。
- [x] 独立 HTML 去除 VitePress 空复制按钮/语言标签，修复粗体与单选布局；补齐技术原理和员工功能总览；通过授权本机 HTTP 完成桌面浏览器验收（窄屏覆盖未生效，未计为移动端通过）。
