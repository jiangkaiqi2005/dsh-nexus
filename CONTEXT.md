# Nexus

Nexus 是独立的 DeepSeek Harness 语音管家插件，项目与包名为 dsh-nexus。本词汇表记录其领域语言。

## 领域语言

**Nexus**：与用户实时通话、理解用户意图并调度 DeepSeek Harness 会话的唯一主 agent，也是插件面向用户的名称；项目与包名为 `dsh-nexus`。
_避免_：语音输入框、仅负责转写或朗读的语音前端。

**主会话**：用户与 Nexus 持续交流并接收调度结果的独立会话；接通时支持语音，挂断后承载文字交流与后台工作汇报。
_避免_：某个工作会话临时开启的语音输入。

**工作会话**：DeepSeek Harness 内承载具体 agent 工作及其上下文的会话，是 Nexus 调度的对象；包括 Nexus 创建及原先已存在的对话会话（普通会话，含用户 fork 的会话）；不含会话 agent 产生的 subagent 会话，后者由其 parent agent 管理（2026-10-09 用户裁定）。
_避免_：将会话容器与执行任务的 agent 角色混为同一个概念。
