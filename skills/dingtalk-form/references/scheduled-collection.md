# 基于 OpenClaw 内置 cron 的定时收集

用户说“每天/每周/到点自动收集”“定时发交互表单”，使用本流程。创建计划需要当前可信钉钉会话、`dingtalk_form_schedule` 和宿主原生 cron 工具；执行阶段不需要新入站消息，不调用模型或引导卡。

## 首次配置

一次确定收集内容、投放位置、固定填写名单、每张有效期、执行时间和时区。结果固定回到本次发起会话：私聊发起回私聊，群聊发起回原群。用户给出完整要求并明确要建立计划时直接配置；缺少业务设置才用引导补齐，预览须注明“创建定时任务，当前不发送正式表单”。不要把普通一次性收集默认为周期任务。

例：“每个工作日 17 点，在项目群让小林和小陈填写今日进展、当前阻碍、明日计划，30 分钟截止，结果回这里。”

- 使用既有 DWS 解析脚本，在配置时核实群及全部成员。`current` 也要加 `independent:true`，生成明确 target。
- 只支持固定成员快照。用户说“所有人”时说明计划固定当前核实的名单；要求每轮动态包含新成员则明确当前不支持，不擅自改成固定名单。
- 用 `fields` 构造模板，显式 `target` 和 `timeoutMinutes`（整数 1–1440）。未指定有效期时明确告知采用 5 分钟；不把“每天”误当成每张持续 24 小时。
- `schedule` 支持 `{kind:"cron",expr:"0 17 * * 1-5",tz:"Asia/Shanghai"}`、`{kind:"every",everyMs:3600000}`（至少 1 分钟）、`{kind:"at",at:"带时区的未来 ISO 时间"}`。日期需基于可信当前时间，时区不明确时先确认；原生 cron 负责表达式最终校验。
- 名字只作展示，可将已核实的 staffId→姓名放入 `respondentNames`。不得将名称用作提交身份。模板保存必要名单和标签，不保存 token、webhook、目录原始响应或聊天历史。

## 创建：严格绑定真实任务

1. 调用 `dingtalk_form_schedule`：
   ```json
   {
     "action":"prepare",
     "name":"工作日项目进展",
     "schedule":{"kind":"cron","expr":"0 17 * * 1-5","tz":"Asia/Shanghai"},
     "form":{
       "title":"项目进展收集",
       "fields":[
         {"name":"progress","label":"今日进展","type":"TEXT_AREA","required":true},
         {"name":"blockers","label":"当前阻碍","type":"TEXT_AREA"},
         {"name":"next","label":"明日计划","type":"TEXT_AREA","required":true}
       ],
       "target":{"type":"group","id":"解析得到的真实群ID","respondentUserIds":["解析得到的staffId"]},
       "timeoutMinutes":30
     }
   }
   ```
   例子中的占位 ID 不可执行。只取本次解析脚本返回值。prepare 不发卡、不启用 cron。
2. 将工具返回的 `cronJob` **完整原样**交给 OpenClaw 原生 cron 的 `add`。保持 `enabled:false`、`sessionTarget:isolated`、script、toolsAllow、delivery:none；不改写脚本，不改成 agentTurn 或 shell 命令，不手写自己的定时器。
3. 取得原生 cron 返回的真实 jobId；调用 `dingtalk_form_schedule` 的 `bind`，传入 scheduleId/jobId。绑定失败则删除刚创建的禁用 cron 任务，停止。
4. 绑定成功后，调用原生 cron `update` 启用该 jobId。最后用原生 cron `get` 核实启用状态和下次运行时间，再告知用户成功。只 prepare 或 bind 不等于定时任务已经生效。
5. 若 prepare 返回 `bound`，先查询已有 jobId，不重复创建。任一步失败如实说明，保留任务禁用；调用结果不确定时先查询，不盲目重建。

管理、创建使用宿主原生 cron 工具，不读写其数据库，不使用 Codex 桌面自动化调度，不调用仅官方插件可用的内部 Gateway 接口。宿主拒绝权限、cron 或 script 被关闭时说明实际错误，不扩大授权或修改全局安全配置。

## 到点自动执行

原生 cron 执行固定 script，仅能调用 `dingtalk_form_schedule`，无模型、无交互引导、无每轮确认。不要从聊天手动调用 `run`；它只接受绑定任务的可信 cron 会话。填写人、题目或时间缺失属于配置错误，不要临时猜测或弹设计卡。

- 每轮新建一张定向卡，收齐提前结束，否则超时回传。
- 同一轮重试不重复发卡；上一轮仍在收集则跳过本轮，不覆盖它。
- 投递结果不确定会阻止重发并报告失败。先查看任务记录和客户端，按下方异常恢复流程由发起人明确确认；不要自动换 ID、重新绑定或重置 cron state 绕开保护。
- cron 的“执行成功”表示本轮发卡或跳过成功，不表示成员已经填完。结果稍后由插件直接发送到原会话；查看 template 的 lastRun 可核对结果投递是否失败。
- 模板和 cron 跨重启保留，未来轮次继续；重启时尚未完成的表单终止，不恢复旧答案。

## 查看、暂停、删除和修改

- 在原发起会话调用 `dingtalk_form_schedule {action:"list"}` 找到自己的 scheduleId/jobId，再用原生 cron 查看运行记录。templateEnabled 只是模板开关，任务是否启用以原生 cron 为准。
- 暂停：用原生 cron 禁用任务。恢复前核对内容和目标，再启用同一任务，不重置 script state。
- 删除：先调用 schedule 的 `disable` 撤销未来发卡，再用原生 cron 删除任务。即使宿主删除失败，模板也不会再发卡。
- 改时间：用户确认后通过原生 cron 修改 schedule，保留原脚本、会话、Agent、状态和 jobId。list 中模板 schedule 是创建时配置，当前时间以原生 cron 为准。
- 改题目、对象或有效期：重新确认，先禁用旧任务，再走 prepare→add→bind→enable 新任务，旧模板 disable；不要原地改 JSON 文件。
- “停止以后的收集”不取消已经发送的表单；要结束当前一轮，用 `dingtalk_ask_user_question list/cancel`。区分暂停计划、取消本轮和成员取消填写。

## 异常发卡恢复与结果补发

在原发起会话先 `list`，按真实 `scheduleId`、轮次 `sequence` 和状态定位；重名或多个异常轮次先消歧。只有原发起人、原账号、原 Agent 与原会话可管理；收集答案不能授权恢复或补发。

- **发卡状态 uncertain**：说明该轮可能已经发卡，恢复会放弃该轮，不重发它，也不恢复答案。取得发起人对此的明确确认后调用 `recover`，传 list 返回的 scheduleId/sequence 和 `acknowledgeUncertainDelivery:true`。不要仅因为用户说“查看”“继续”就默认确认。正在发送或收集的轮次不能恢复。恢复保留原 cron 绑定与序号；下一次触发可能仅对齐已放弃轮次，随后轮次正常执行。它不会启用被暂停的任务；需要恢复暂停计划时再按用户意图操作原生 cron，不立即手动触发来猜测对齐状态。
- **汇总未送完**：list 的 `resultDeliveries` 提供轮次、状态、已确认分片数及总数，不提供答案正文。用户要求补发时调用 `retry_result`，传精确的 scheduleId/sequence；只回原发起会话，不接受替换内容或目标。`pending` 表示下一片尚未发送，可以直接补发；`sending` 表示仍在执行，等待而非并发重试。
- **汇总状态 uncertain**：当前片段可能已经到达，先说明“补发可能重复当前这一条，之前已确认送达的内容不会重发”。取得发起人明确确认后，传 `acknowledgeUncertainDelivery:true` 以及 list 返回的当前 `attemptId`。新一次失败会产生新 attemptId，旧确认不能自动循环重试；状态有变化时重新核实。
- 完成的结果会跨重启保留待发送内容和进度，后续轮次不能覆盖；完整送达后清除本功能保存的答案正文，仅保留最近 20 轮已完成投递标记，未完成投递不会静默清除。该机制不恢复重启前尚未收齐的答案，也无法补回旧版本没有保存的失败汇总。

`recover` 和 `retry_result` 都不会创建新表单，也不更换 cron jobId。权限或存储错误时如实停止，不扩大权限或修改状态文件。
