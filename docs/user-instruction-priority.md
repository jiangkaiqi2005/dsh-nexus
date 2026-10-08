# 用户指令优先与原生运行中引导

状态：设计原则已确认，尚未实现。此前提出的指令版本、过期命令拦截、意图分类和自动强制取消方案未被采用。

用户的新指令通过 Harness 原生 steer 进入运行中的工作会话，由 agent 理解要求，在后续执行中自行停止、改变方向或补充工作。用户明确指令高于 Nexus 调度指令；Nexus 也需要获知用户直接在工作会话中的引导，更新其后续计划。

消息保留可辨识的来源，避免将 Nexus 调度与用户直接输入混为一谈。首版不额外分类停止、补充和查询，不按新用户消息自动调用 cancel，不加入版本仲裁或人工授权。

官方 steer 在最近后续模型步骤边界接收消息，不保证中断一个已经开始的工具操作。用户选择的是基于新上下文的模型引导，而非瞬时停止或撤销已完成操作。[官方 Core 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)

当前官方普通 prompt 入口会将程序调用也标为 user。Nexus 实现会话投递时仍需正确表达自己的来源，具体桥接方式须对照用户安装版本确认。[官方输入入口源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L301)
