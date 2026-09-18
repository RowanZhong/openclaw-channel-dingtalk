# 请求契约与六种场景

只读脚本用于解析 target；questions/fields 由 agent 结合用户内容和实际工具 Schema 构造。用户要求表单、输入栏或独立标题/说明时使用 fields；questions 模式忽略顶层 title/description，不能用于这种要求。
以下姓名与 ID 为示例，运行时替换为真实查询/可信上下文值，不可原样发送。

## 输入

```json
{
  "origin": {"type": "direct"},
  "audience": {
    "type": "group",
    "groupName": "项目群",
    "respondents": [{"name": "成员甲"}, {"name": "成员乙"}]
  },
  "timeoutMinutes": 10
}
```

| 字段 | 规则 |
| --- | --- |
| origin.type | direct 或 group，从本次可信钉钉入站上下文取得 |
| origin.senderStaffId | 仅本人定向或名单含 self 时需要；不得用 DWS 登录人冒充 |
| origin.conversationId | 使用当前群时需要；真实原始群 ID，区分大小写 |
| audience.type | current、user、group |
| user 的 name / staffId | 二选一；staffId 仅用于可信 ID 或用户已选中的查询候选 |
| group 的 groupName / conversationId / currentGroup:true | 三选一；显式 ID 来自可信上下文或用户选中的候选 |
| group 的 respondents / allMembers:true | 二选一；respondents 每项为 {name}、{staffId} 或 {self:true} |
| timeoutMinutes | 可省略；1–4320 整数，最长 3 天；显式 null 无效，提供合法值时使用定向收集 |
| independent | 可省略；true 表示本人也使用独立定向收集 |
| corpId | 本地已绑定时不传；未绑定时来自可信组织上下文或管理员明确确认 |

当前用户默认提问不会调用 DWS，也不需要技术 ID。仅当本人要求定向生命周期时才需要可信 senderStaffId。
脚本不读取 OpenClaw 配置、凭据、会话数据库或聊天记录来推断身份。

## 组织绑定（部署一次）

管理员先执行 `dws profile list --format json`，确认机器人所在组织及该组织唯一 `isOrgCurrent=true` 的账号。在**安装后的 skill 目录**创建 `organization.json`：

```json
{"corpId": "管理员已确认的机器人组织corpId"}
```

不保存 token、clientSecret、用户 ID 或整份 profile 列表。不要把部署用 organization.json 加入 Git。脚本每次根据绑定组织选择唯一默认 profile，并为所有后续查询固定 `--profile`，不持久切换账号。绑定不一致、缺默认账号或授权失败均停止；换组织需要管理员明确修改绑定。

## 六种场景

1. 私聊“先问我是否参加，再继续”：
   `origin:{type:"direct"}`，`audience:{type:"current"}`。输出不含 target，使用 questions 的参加/不参加选项。若明确要求表单或指定标题，改用 fields 的 SELECT。
2. 私聊“私发给成员甲，填期望日期和备注”：
   `origin:{type:"direct"}`，`audience:{type:"user",name:"成员甲"}`。输出 target=user，DATE + TEXT_AREA；结果回原私聊。
3. 私聊“在项目群向成员甲、成员乙征集午餐，10 分钟截止”：
   使用上方完整请求。输出 target=group，respondentUserIds 是两人的 staffId，timeoutMinutes=10；结果回原私聊。
4. 群聊“就在这里用表单问我是否参加”：
   `origin:{type:"group"}`，`audience:{type:"current"}`。输出不含 target；卡片在原群，仅发起人可填，结果也在原群。
5. 群聊“私发给成员甲填写日期，结果在这里汇总”：
   `origin:{type:"group"}`，`audience:{type:"user",name:"成员甲"}`。输出 target=user，结果回原群。
6. 群聊“本群让成员甲、成员乙填写出游建议”：
   `origin:{type:"group",conversationId:"可信当前群ID"}`，`audience:{type:"group",currentGroup:true,respondents:[{name:"成员甲"},{name:"成员乙"}]}`。卡片和结果都在原群。明确其他群名时用 groupName 替代 currentGroup。

群内成员校验通过完整成员列表的 openDingtalkId 与人员搜索返回的 openDingTalkId 关联，最终只传 staffId；不把相同显示名当作身份关系。

## 常用变体

本人在群里填写，30 分钟且聊天不使其失效：

```json
{
  "origin": {"type":"group", "senderStaffId":"可信发起人staffId", "conversationId":"可信当前群ID"},
  "audience": {"type":"current"},
  "timeoutMinutes": 30
}
```

输出 target=group，名单只有发起人；不会变成私聊投放。

指定群所有真人：

```json
{"origin":{"type":"direct"},"audience":{"type":"group","groupName":"项目群","allMembers":true}}
```

名单以本次完整读取为准。超过 1000 人、存在无法映射的外部成员或权限不足时整体停止。不得将同名的内部员工代替未匹配的外部成员。

## 输出与失败处理

成功输出 status=ready、toolArguments、投放类型和回传位置；定向查询还包括已解析人员及 ID 来源。仅将 toolArguments 合并进表单调用，其他字段不要传入工具。

失败返回 status=blocked 且退出码 2，**不包含可发送的部分 target**。常见代码：

- choose_candidate：列出候选，请用户选；再次解析时使用被选择的真实 staffId/conversationId。
- invalid_timeout：最长 3 天，仅接受 1–4320 的整数分钟数；保留其他草稿设置，让用户只修改时长，不默认或截断。
- members_unresolved：按 issues 列出未解决成员，明确整张暂未发送；已解析人员不需要用户重输。
- incomplete_result：查询不完整，不能声称“全体成员”。
- organization_required / profile_required：管理员补充组织绑定或明确默认账号。
- dws_query_failed / query_timeout：说明查询或授权失败；不升级权限、不改用另一个账号、不猜 ID。

若用户在查询失败后明确同意只发给已确认的一部分人，应以新的明确名单重新解析。

## 验证

仓库中执行以下命令，覆盖目标解析、引导选群/选人、自定义时长校验（文件名含连字符，需逐个运行，不能用 unittest discover）：

```sh
for test_file in tests/unit/dingtalk-form-*.test.py; do
  python3 -B "$test_file" || exit 1
done
```
离线测试用匿名 DWS 响应覆盖六场景、ID 映射、重名、不完整分页、组织不匹配和部分人员失败。
真实 DWS 解析是只读验证；真实发卡仍需在已授权测试会话中调用插件工具，逐一确认投放位置、允许填写人及回传位置。不能将离线解析或 status=ready 当成卡片已发送。
