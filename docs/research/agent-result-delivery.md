# Agent 结果回流、主管唤醒与用户通知调研

核查日期：2026-10-08。只读官方文档与官方仓库当前源码，未实机运行；移动分支可能变化，用户本地 Harness 版本未知。程序事件、模型上下文投递、主管开启新 turn、用户通知、实时语音播报分别判断，不将其中一项当成其余项已实现。

用户决策：Q12 的继续修复、审查或结束由 Nexus 自行判断，不写死阶段流程；Q14 恢复遵循 Harness 原生行为，不扩展自己的恢复系统。本报告只提供事实，不加入权限/revision 或强制语音插话设计。

需求更正：用户后续明确，自启动指“启动 Harness 后自动进入 Nexus 语音”，不是操作系统登录后启动 Harness。下文 OS 自启动调查保留为历史事实，不属于当前需求。

## Codex

### 子 agent 返回主会话

官方产品指南说明 subagent 返回摘要，由主线程收集并汇总；多个 agent 工作时，Codex 等全部所需结果到齐后给统一回复。客户端展示活动和完成列表。文档没有规定每个子 agent 完成都立即打断当前回复。[官方 Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### 独立任务返回语音会话

官方 ChatGPT Voice 产品页确认可启动独立长任务、检查已有任务、发送后续指令，将进度、阻塞和结果带回语音会话；用户可在工作期间继续聊，也可切换到另一 Codex 任务讲话再返回。页面没有公开后台结果到达后何时注入、是否唤醒空闲主管、是否等用户说完及播报优先级。该产品体验可作为 Nexus 先例，不能由页面推断内部实现。[官方 ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice)

### 客户端事件与用户通知

App Server 推送 turn/completed、item/completed 等事件，包含终态和最终工作项；collabToolCall 记录协调线程和 agent 状态。事件发给客户端，不等于自动写入任意另一个主管会话，更不等于自动语音播报。turn/steer 面向正在运行的 turn；turn/start 可启动后续工作，但协议不能直接证明桌面内部通知如何安排。[官方 App Server](https://learn.chatgpt.com/docs/app-server)

桌面用户完成通知有永不、仅后台和总是等选项，与需要输入的提醒分别设置；Remote 完成通知可直接打开对应 chat。这是面向人的系统提醒，与模型收到工作结果分开。[官方 Notifications](https://learn.chatgpt.com/docs/notifications)、[Remote 工作说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)

Agents API 与 Responses Multi-agent 官方指南也描述创建、消息、等待、打断与结果汇总。这些是另外的 API 面，不能当 Codex 桌面语音插话的实现细则。[Agents API Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)

## 非 OpenAI：DeepSeek Harness

### 原生 continuable 子会话

continuable child 是持久 Session 加可选的进程内 Activation；一轮结束不必等于 Activation 结束，尚有 pending inbox 或存活后代时继续驻留。子 Activation 真正 settle 时，runtime 自动给 **durable direct parent** 发结束原因及最后 assistant 的非空文字，来源为 `subagent-settled`；没有结语也发送说明。通知在释放子 ownership 前发生。[官方 Subagent：生命周期和通知](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md#continuable-children-and-activations)。

通知使用 waking Agent delivery：父忙时在最近的 step boundary 消费，父闲时开始新 turn；自己的 turn 已结束而 Agent 仍在，不阻碍 wake。continuation 管理的父在持有未完成 child ownership 时不能 settle。父 lineage 正在 teardown 时是例外：收到上下文但不 wake。顶层父 Agent 不在此 waiting ownership graph，由它自己的 Host owner 保活；不能把保活规则扩展到任意顶层会话。[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md#continuable-children-and-activations)。

公开 Agent API 另外区分 `steer`（最近一步并 wake）、`followup`（下一 FIFO turn 并 wake）和 `inject`（放上下文但不 wake）；后者空闲时一直 pending，直到其他 waking 输入。已执行的模型请求不会因为新通知自动把文字插进正在生成的 token 流。[官方 Agent handle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#the-agent-handle)。

### 一次性子任务和普通顶层会话

one-shot 的 `SubagentRun.result` 是调用者 await 的单次结果，消费者负责 dispose；它没有 steer/resume。其与 continuable 的自动 settled notice 属于两种机制。[官方 one-shot contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md#a-one-shot-run-subagentrun)。

普通会话可由程序使用 `session.follow` 订阅日志和 assistant-stream、`session.control` 订阅控制状态；这些返回事件给订阅者，**不等于**把结果自动变成另一个主管的模型输入。已核官方原生结果回流是直属 continuable 父子关系；未找到任意顶层 Session 完成就自动唤醒其他主管的契约。[官方 Session follow/control](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md#ctxsessioncontroller--sessioncontroller)。

### 恢复、重启与 OS 自启动

持久日志 survive teardown，进程内 Activations 不 survive。对冷 child 发送消息，manager 调用 `ctx.agents.resume`，然后投递新工作；这是请求触发的恢复，不能称“进程重启就自动重放所有工作”。[官方 continuable cold resume](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md#continuable-children-and-activations)。

crash 中断的 turn 在 resume 时补缺失 tool errors、step/end 和 `turn/end:interrupted`，保留崩溃前完整日志，而非回到中途继续执行那个 turn。[官方持久化 crash recovery](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md#crash-recovery-preserves-an-interrupted-turn)。AgentLoop 配置可声明固定 `sessionId`（首次 create、之后 restore）或 `resumeSessionId`；当前基础构造将 Agent 初始化为 idle，发布/恢复本身没有发出一个“继续完成原任务”的 prompt。插件的创建监听器仍可能自行 wake，不能泛称所有配置都只空闲。[配置与 resume 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/index.ts#L270)、[基础初始化与 wake 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts#L113)。

Desktop 关主窗口是隐藏，Host 和任务继续；真正 Quit/OS shutdown 会停止运行。已读官方 CLI 启动说明与 Desktop README 未找到“登录 OS 后自动启动 Harness”的现成设置/API；这项尚未确认存在，不能把关闭窗口后台保活或配置恢复 Agent 当作 OS 自启动。[Desktop 窗口与退出](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#background-close-and-quit-confirmation)、[CLI 启动](https://github.com/deepseek-ai/deepseek-harness#run)。

上述 settled notice 是文本上下文加模型 wake；这些契约不保证系统弹窗，也没有实时语音插话时机的承诺。[Subagent 通知契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md#continuable-children-and-activations)。

## 非 OpenAI：Claude Code

### Background subagents

前台 subagent 阻塞主会话，后台并行；后台结果以 **completion notification 在后续 turn 到达 Claude**，自动事件明确区别于用户消息。文档给了任务面板/完成短提示，但未在本轮所读页给出主会话忙、闲、turn 已结束三种状态的精确调度时点；不能仅凭“completion notification”承诺任意情况下立刻新开主管 turn。子会话可由 Claude 后续 message/resume，不必重建上下文。[官方 subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)、[结果来源标记](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)。

### Agent Teams

teammates 是独立 Claude 会话，共享 task list 并用 mailbox 通信。消息自动送达，无需 lead 轮询；teammate idle/结束会自动通知 lead，带 final answer，API 错误则带错误。文档未严格定义 lead 正在请求中和刚退出 turn 时哪一毫秒消费。idle teammate 隐藏后仍运行可收消息；不能把 UI 隐藏视为已销毁。实验功能的 in-process teammates 不被 `/resume`、`/rewind` 恢复，文档说需重新 spawn。[官方 Teams 通信与限制](https://code.claude.com/docs/en/agent-teams#context-and-communication)。

### 独立后台会话与面向用户的通知

Agent View 是第三种形态，由 supervisor 运行独立后台会话；关 shell 不结束它们。Agent View 打开时，本地会话完成/失败/需输入会走 `preferredNotifChannel`，触发 `Notification` 的 `agent_completed`/`agent_needs_input`；这描述用户通知，不证明结果进入任意另一个主管会话。关机仍停任务，文档单独说明恢复。[官方 Agent View](https://code.claude.com/docs/en/agent-view#monitor-sessions)。

`Notification` hook 的用途是提醒副作用，不能修改通知，也不能用 systemMessage/continue 把它变成模型输入。它和子任务的 completion context 不是同一渠道。以上页面没有保证自然实时语音播报。[官方 Notification hooks](https://code.claude.com/docs/en/hooks#notification)。

## 非 OpenAI：OpenCode

官方 agents 文档确认 subagent 有 child sessions 及父子导航，但本轮该页面没有后台生命周期说明。官方 **dev 分支源码**已存在实验 `background:true`，要求 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`；不能据此声称用户安装版已发布/默认可用。[官方 agents 文档](https://opencode.ai/docs/agents/#usage)、[TaskTool 参数及实验闸门](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts#L21)。

完成后 `notifyBackgroundResult` 等待 BackgroundJob，调用父 Session 的 `prompt`，写入 `synthetic:true` 的 `task_result`/`task_error`（子 session ID、状态、标题及文字结果）；不是只有 UI 事件。`prompt` 没有 noReply 就调用 loop，说明闲父可以启动模型处理；loop 通过 `state.ensureRunning` 统一进入运行。[后台结果注入](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts#L210)、[prompt 与 loop](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts#L1001)。

当前 runLoop 每个迭代从 Session 重读消息，结果到忙父可以进入其后续迭代；本轮未深入 ensureRunning 的边界竞争、进程重启恢复或客户端 OS 通知，不承诺绝对时点与不丢结果。源码的注入是异步 fork，错误路径使用 Effect.ignore，也不能把“有投递机制”当成 exactly-once 交付保证。未发现这些文件实现语音播报。[loop 消费](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts#L1027)、[结果 fork](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts#L210)。

## 可带回 Nexus 讨论的事实

这几种系统都提供了“工作结果成为主管上下文”的路径，但返回范围和 wake 契约不同。DSH continuable 原生已明确忙时最近 step、闲时开启 turn；普通顶层 Session 的事件订阅需另有投递桥，不能自动享有直属子会话契约。Claude 区分子任务 completion、Teams mailbox 和面向用户的 terminal 通知；OpenCode dev 实验实现将后台结果变成父 prompt。以上证据均不足以替 Nexus 决定是否播报、播报多少及是否打断当前通话。[DSH](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#the-agent-handle)、[Claude](https://code.claude.com/docs/en/agent-teams#context-and-communication)、[OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts#L210)。

若 Q14 采用“恢复遵循 Harness 原生”，应明确接受原生持久日志/冷恢复/中断标记的边界。启用 Harness OS 自启动和恢复未完任务是两个独立能力，本轮只确认前者尚未找到现成原生设置，后者不能凭自启动推导。[持久化恢复](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md#crash-recovery-preserves-an-interrupted-turn)、[Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。
