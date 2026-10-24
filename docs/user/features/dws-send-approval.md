# 代回复助手已迁至独立项目

本分支维护 OpenClaw **2026.7.1-2** 对应的钉钉 Channel。个人消息监听、AI 拟稿、本人审批、固定回复、主题规则及业务卡片模板，均由 [dws-send-approval 独立项目](https://github.com/RowanZhong/dws-send-approval)维护。

## 文档与安装来源

- [独立项目与安装入口](https://github.com/RowanZhong/dws-send-approval)
- [开发人员：技术方案与安装配置](https://github.com/RowanZhong/dws-send-approval/blob/main/docs/contributor/dws-reply-assistant-deployment.md)
- [员工：使用手册](https://github.com/RowanZhong/dws-send-approval/blob/main/docs/user/dws-reply-assistant-manual.md)

旧版 Channel 应继续固定本兼容分支的源码或构建包。独立助手另外安装，选择其文档明确支持 OpenClaw 2026.7.1-2 的版本。不要把上游面向较新宿主的最新版 Channel 直接装到旧宿主。

## 从旧目录迁移

如果部署仍从本仓库的 `examples/dws-send-approval` 加载助手，请先安装独立项目，并将 `plugins.load.paths` 中该旧路径替换为独立项目路径。也应检查已有插件安装记录是否仍指向旧目录，按宿主的插件更新流程切换。不要同时加载两份同 ID 的助手。

保留独立插件条目 `plugins.entries["dws-send-approval"]` 的员工配置，以及原有状态目录、PVC、草稿和历史数据。监听开关继续由独立插件及其个人设置管理；本次仓库清理不会改写配置、打开监听或重发消息。迁移不要求重新发布已有卡片模板。

已经从独立项目加载助手的实例，无需迁移助手路径；更新此 Channel 清理提交不改变运行接口。

## 本分支保留的兼容能力

`src/card/reply-assistant-bridge.ts` 及其入口和回调接线继续保留：

- 复用 Channel 的机器人凭据、Token 和卡片传输。
- 将旧版助手卡片回调交给独立插件登记的处理器。
- 不在 Channel 中启动 DWS 监听、生成回复或执行业务审批。

桥接源码及 `tests/unit/reply-assistant-bridge.test.ts` 是旧版独立助手的兼容依赖，不应当作重复业务源码删除。本次没有回移新版通用卡片接口，也没有修改桥接协议。

## 历史版本

`aba37a7` 保留清理前的旧助手源码、业务文档和历史交付包，可从 Git 历史查看。当前维护分支不再携带这些副本；后续助手升级以独立项目为准。
