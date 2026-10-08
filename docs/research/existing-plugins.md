# DeepSeek Harness 语音主管插件先例调研

调研日期：2026-10-08。范围是用户的插件设想；未修改 Qiyu 业务代码，未安装候选插件，未进行真实麦克风、模型付费连接或多会话实机验收。

## 已确认范围

- Q1：个人 Agent 助手场景，做 DeepSeek Harness 插件，不在栖语上改。
- Q2：A 架构。插件提供独立语音主会话，Realtime 模型负责听、说、决策和调度，是面向用户的唯一主管。
- Q3：首版只管理 DeepSeek Harness 的会话；Codex、Claude Code 等跨工具管理是后期目标。
- Harness 身份已确认：[DeepSeek 官网](https://www.deepseek.com/harness/)对应[官方开源仓库](https://github.com/deepseek-ai/deepseek-harness)。用户本地安装版本尚未知。
- 公开仓库 `martinbear1/dsh-realtime-voice` 与用户现有实现是否同一项目，待用户确认；本报告不将它直接称为他人竞品。

## 结论

本次没有核实到一个可直接安装、完整满足“独立 Realtime 主管 + 自然双工通话/打断 + 管理多个持久 DSH 会话”的成品。这是限定搜索和静态核对的结果，不能推导为不存在。

但构成想法的几部分已有公开实现。`dsh-realtime-voice` 最接近实时通话与执行闭环；`deepseek-harness-voice-mode` 最接近语音控制多个 DSH 会话；`dsh-agent-teams` 提供持续工作成员和依赖调度；`big-3-super-agent` 展示 Realtime 模型担任唯一主管的跨 Agent 架构。它们分别存在关键缺口，不能因为名称出现 realtime、orchestrator 或 Jarvis 就认为已经满足。[实时语音插件](https://github.com/martinbear1/dsh-realtime-voice)、[多线程语音模式](https://github.com/yankihue/deepseek-harness-voice-mode)、[AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams)、[Big Three](https://github.com/disler/big-3-super-agent)。

## 判断口径

以下严格区分四类证据：**文档声明**是维护者描述；**源码支持**是本次读到调用和状态处理；**项目自述测试**是项目公布的验证，不是本次验收；**我们未实机验证**适用于所有候选。开源许可证和维护日期来自对应仓库 LICENSE、GitHub API 仓库元数据与最新 commit；日期仅描述公开提交，不能证明可用性或未来维护承诺。

## 候选对比

| 项目 | 语音形态 | 会话/Agent 能力 | 与设想的主要缺口 |
| --- | --- | --- | --- |
| [martinbear1/dsh-realtime-voice](https://github.com/martinbear1/dsh-realtime-voice) | Qwen 原生音频 Realtime，双工与打断实现 | 启动/追加/纠正/取消一个绑定 DSH 会话，进度、终态、审批、追问回灌 | 通话一对一绑定拨号时的 session；没有多会话目录和选择/创建工具 |
| [yankihue/deepseek-harness-voice-mode](https://github.com/yankihue/deepseek-harness-voice-mode) | ElevenLabs 流式 STT + TTS，有取消播报的实现 | 创建、发消息、中断、摘要、监视多个真实 DSH threads | 主管是确定性路由与短 LLM 意图分类；没有独立 Realtime 推理主管 |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 无语音能力声明 | 当前会话成为 Captain，持久 continuable 成员、依赖 DAG、直接消息、调度、Web 活动面板 | 是团队调度组件，不能独立提供通话，也不等于任意已有顶层会话的统一管家 |
| [disler/big-3-super-agent](https://github.com/disler/big-3-super-agent) | OpenAI 原生 Realtime 音频 | Realtime 主管工具管理 Claude Code/Gemini；Claude registry + SDK resume + 后台执行 | 独立 Python 实验；非 DSH 插件；播报时暂停输入，双工打断没有核实 |
| [alldone/Jarvis](https://github.com/alldone/Jarvis) | Apple STT → 执行 → macOS say；按住说话/静音分轮 | Codex/Claude/OpenCode 选择、续聊、review/debate、排队补充 | 仅 macOS 语音，同一时刻一个任务；文档明确尚无全双工和增量语音 |
| DSH 输入/草稿类插件，见下文 | 流式听写或单轮原生音频 | 将识别结果放入输入框/草稿 | 不能承担多会话主管 |

### 1. dsh-realtime-voice

**文档声明**：`0.1.0-alpha.9` 面向 DSH `0.1.0-rc.7`。原生 WebUI 浮窗、VAD 和本地打断、实时 PCM、审批/追问闭环。文档明确“一通电话与拨号瞬间的 DSH sessionId 一对一绑定”，普通通话和 DSH 执行保留各自上下文。[README](https://github.com/martinbear1/dsh-realtime-voice#上下文模型)。

**源码支持**：`DshFunctionBridge.dispatch` 只有 handoff、cancel、approval、question 四种函数；handoff 没有可选择的 target_session_id 参数。`DshVoiceCoordinator` 构造时持有一个 sessionId，随后只对它调用 `sessions.prompt`（queue/steer）和 cancel。Backend bridge 订阅全局事件后严格过滤这一 sessionId。因此这是单会话语音执行闭环，不是已实现全局多会话调度。[函数桥](https://github.com/martinbear1/dsh-realtime-voice/blob/7a56377168f35262d544b9cc052995979091f53f/src/host/dsh-function-bridge.ts#L149)、[协调器](https://github.com/martinbear1/dsh-realtime-voice/blob/7a56377168f35262d544b9cc052995979091f53f/src/host/dsh-coordinator.ts#L84)、[事件过滤](https://github.com/martinbear1/dsh-realtime-voice/blob/7a56377168f35262d544b9cc052995979091f53f/src/host/dsh-backend-bridge.ts#L65)。

**项目自述测试**：真实 Qwen 建连、Function Calling→DSH→播报闭环和自动化协议测试；仍留真实麦克风听感人工验收。**可复用**：媒体协议、播放打断、生命周期、凭据解析和权威终态回灌。我们未实机验证，也未核实它与用户代码的关系。[验证声明](https://github.com/martinbear1/dsh-realtime-voice#已验证)。

### 2. deepseek-harness-voice-mode

**文档声明**：beta.1，手工 patch/symlink 安装，单用户、单浏览器连接。ElevenLabs Scribe realtime STT 和 stream-input TTS；确定性生命周期命令先路由，含混请求才调用一次低推理 LLM。声明具备建线程、发送、中断、摘要和监视；100 个离线测试及 live helper 验证属于项目自述。[README](https://github.com/yankihue/deepseek-harness-voice-mode)。

**源码支持**：`ThreadManager` 按 sessionId 管理 registry/handles，`agents.create(options)` 创建真实会话；现存 live agent 通过 send 继续工作、cancel 中断；`sessionQuery.listSessions/readSession` 读取目录与摘要。代码默认选最近活跃线程，创建目录可取最近真实会话 cwd；message 对非 live 会话直接失败，没有读到完整冷恢复链。插件层用 user authority 中断的处理也不能自动当作模型主管已获跨会话权限。**可复用**：会话目录、message 与返回消息的关联、播报队列的抢占/合并。移植时须重新确定目标选择、工作区归属、授权和当前 Harness API 兼容性。[Host 源码](https://github.com/yankihue/deepseek-harness-voice-mode/blob/07f5d45652d5f9ca84c06c79833ae529785208df/packages/orchestrator/host.js#L326)。

### 3. dsh-agent-teams

**文档声明**：现行 `0.1.22` 推荐 Harness `0.2.0-rc.2`，提供 Captain、持久成员、14 个协调工具、任务依赖、自动复用成员、消息与可视面板。已有规划审批流程。**源码支持**：本次读取 members/scheduler 模块，确认有成员和任务调度代码；未完整审计各项算法，也未运行测试。**可复用**：如果首版接受“主会话创建并管理自己的工作成员”，它是调度和持久状态的直接先例；若只需轻量发消息/追踪，不必整体搬入其团队协议。[说明与兼容矩阵](https://github.com/NanmiCoder/dsh-agent-teams#releases)、[成员源码](https://github.com/NanmiCoder/dsh-agent-teams/blob/98aac03f46fc0aa19522c6f23a2b5bd08f9b1abd/src/members.ts)、[调度源码](https://github.com/NanmiCoder/dsh-agent-teams/blob/98aac03f46fc0aa19522c6f23a2b5bd08f9b1abd/src/scheduler.ts)。

### 4. big-3-super-agent

**文档声明**：OpenAI Realtime 主管调度 Claude Code 编程和 Gemini 浏览器 Agent，属于实验。**源码支持**：主管工具 list/create/command/check/delete；Claude session_id 写 registry.json，SDK 用 resume 恢复；command 开后台线程，结果读取 operator 文件。它确实超出普通单 Agent 工具调用。但源码在播报期间设置 `auto_paused_for_response`，未找到 speech_started/response.cancel；不能据 Realtime API 名称称其支持自然双工打断。亦未核实健壮取消/冷启动恢复和运行中改指令。[源码](https://github.com/disler/big-3-super-agent/blob/d5d2c1007f8085c30ef5094470cc93027f625e82/apps/realtime-poc/big_three_realtime_agents.py#L906)。

**可复用**：独立实时主管、持久执行成员和后台任务回执的架构。仓库未发现许可证声明，不能当已获授权可复制的开源组件；本报告仅将它作为公开源码先例。[仓库](https://github.com/disler/big-3-super-agent)。

### 5. Jarvis 与输入类插件

Jarvis 的 README 明确语音目前是 macOS Apple Speech + say，live 为静音分轮，录制在 Agent 工作/播报时暂停；一个 JARVIS task 同时运行。源码有独立 STT/TTS 接口和 Orchestrator.busy。它可供跨 CLI 适配边界参考，不是用户要求的全双工主管。许可证是 PolyForm Small Business，属于 source-available，不应称宽松开源。[语音限制](https://github.com/alldone/Jarvis#current-limitations)、[许可证](https://github.com/alldone/Jarvis#license)、[编排实现](https://github.com/alldone/Jarvis/blob/90ed9db578fe6f3d4eba559a0a0ca98c01df7f29/src/core/orchestrator.ts)。

[GooDAnDReaDY/dsh-voice](https://github.com/GooDAnDReaDY/dsh-voice) 是多 Provider 听写/语音输入；即使使用 OpenAI Realtime 接收音频，返回仍为 text deltas，目标是 composer，不能等同双工语音主管。[Jstn-1g/dsh-live-voice](https://github.com/Jstn-1g/dsh-live-voice) 提供 exact-session 单轮原生音频和显式 draft handoff；README 把 credential-backed Qwen、真实麦克风/扬声器及 Desktop 留作未证明门槛。这两项不是多会话主管成品。

## 维护快照

以 GitHub API 返回的最新默认分支 commit 为准；日期为 UTC。所有仓库当前 archived=false，不能由此推导持续维护或兼容性。

| 项目 | 最新 commit 日期 | revision | 许可证/成熟度证据 |
| --- | --- | --- | --- |
| dsh-realtime-voice | 2026-08-24 | `7a56377168f35262d544b9cc052995979091f53f` | MIT；alpha.9；目标老 RC |
| deepseek-harness-voice-mode | 2026-08-25 | `07f5d45652d5f9ca84c06c79833ae529785208df` | MIT；beta.1；手工安装 |
| dsh-agent-teams | 2026-10-05 | `98aac03f46fc0aa19522c6f23a2b5bd08f9b1abd` | MIT；明确当前 RC 兼容矩阵 |
| big-3-super-agent | 2025-10-10 | `d5d2c1007f8085c30ef5094470cc93027f625e82` | 未发现 LICENSE；实验 |
| Jarvis | 2026-09-27 | `90ed9db578fe6f3d4eba559a0a0ca98c01df7f29` | PolyForm Small Business；早期实现 |
| dsh-voice | 2026-10-06 | `861b3e5ddd61d10bf1538bc19f61a9ec4b159aae` | MIT；输入组件 |
| dsh-live-voice | 2026-08-31 | `3b4a17a2aa25a40c73e11291b6d8ff196bcaa477` | MIT；preview.5；真实媒体验收未证明 |

API 查证入口举例：[仓库元数据](https://api.github.com/repos/martinbear1/dsh-realtime-voice)、[最新提交](https://api.github.com/repos/martinbear1/dsh-realtime-voice/commits?per_page=1)；其他行按各自 owner/repo 查得。pushed_at 与 commit_time 不一定相同，本表不混用。

## Harness 原生扩展能力与设计影响

官方架构已有 `ctx.agents`、`ctx.sessions`、`ctx.tools` 和 Agent/会话事件，自定义 UI 可消费这些能力；会话为持久事件日志。官方 subagent 机制提供 `startContinuable`（接受提示后立即返回 childId/messageId）、`sendMessage`（steer/wake/cold resume）、`interrupt`（停当前执行且保留 inbox），子成员 settle 后通知直接父 Agent。因此“自己创建并持续管理工作会话”已有基础。[架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[会话](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)、[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)。

关键边界：官方 subagent 的模型自主 sendMessage 仅允许直接父子，不能任意发给兄弟或其他顶层会话；普通 fork 等非后代不出现在后代 catalog。它不能自然等同“接管所有已有会话”。插件 Host 可实现更大控制面，但必须明确授予权限、会话归属和恢复语义。官方仍处 developer preview，接口会变；本报告未在用户版本上做兼容验证。[原生权限边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)。

## 下一轮值得问清的两个分歧

1. “管理所有 Agent”是否意味着首版就接管任意已有顶层会话，还是只管理主管自己创建的工作会话？前者需要额外会话控制和权限设计，后者可贴合 continuable subagent 原生生命周期。
2. 用户现有 realtime 适配在哪里？若就是上面的 dsh-realtime-voice，下一步应研究从单绑定会话改为独立主管与多目标工具，不需另建语音媒体链路。

当前可以合理做的是先确定这两点，再决定复用哪一层；不能把 STT/TTS 会话控制、原生实时媒体和持久 Agent 调度简单拼装后就称成品。

## 补查：Nexus 与用户指令的来源、入队和拦截

2026-10-08 补查官方 `master` 的窄范围源码，未克隆或运行 Harness。用户新增方向是 Nexus 默认负责调度、工作交给会话；明确用户指令优先；挂断后主会话继续运行并仅输出文字。以下仅核查接口事实，不是已实现的仲裁方案，也未验证用户本地版本。

### 来源标记的真实边界

- `MessageSourceMap` 可 declaration merging，`UserMessage.source` 由消息 producer 提供；`role:'user'` 不等于消息来自人。当前 master 没有通用 `kind:'plugin'`，Nexus 可贡献自己的 source kind。`createUserMessage` 深拷贝并冻结值，但没有证明其来源/身份的能力。[message.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/message.ts#L96)。
- 常见 UI 使用的 Session prompt 请求没有 source 参数；Host 在 `SessionCommandController.prompt` 固定构造 `{kind:'user',rpcId:requestId,clientTimeZone?}`，因此不能由正文“我是用户/我是 Nexus”改变来源。可是程序也能调用这个 prompt 入口，Nexus 若借用它同样被标成 user；这个字段是 Host 构造的来源分类，并非真实人身份凭证。要保留两种来源，需 Nexus 专用 Host 投递路径，避免复用 human prompt 时丢失分类。[请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/types.ts#L306)、[Host 固定来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L301)。

### 接收和执行的时序

`ReactLoopAgent.send` 同步执行 `inbox.splice(...)`，然后才 `wakeDriver`。`ReactLoopInbox.mutate` 先 `session.append('agent/inbox/spliced', ...)`，投影已提交后，才同步 `emit('agent/inbox/inserted')`。所以 inserted 是接收入队时触发，不等到模型执行；但它是 **post-commit 通知**，不是可返回 reject 的 pre-admission waterfall。[send](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts#L143)、[inbox commit 与通知](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/inbox.ts#L181)。

`agent/inbox/claimed` 在从 pending 中取出消息时触发；`agent/pre-step` 接收已 claim 的 messages，可拒绝整个 proposed step 或替换进入消息。它比模型调用早，但不是消息接收时的控制钩子。若因用户新指令而使 Nexus 旧计划失效，等 pre-step 才更新控制 revision 会错过消息在队列中等待的时间；inserted 可及时观察已入队的人类消息，pre-step 可作为消费前第二次检查。[公开 runtime 事件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts#L260)。

### 取消和清理能力

公开 `agent.inbox` 有 nextTurn/nextStep 只读列表及 append/prepend/replace/remove/splice/clear。`remove(messageId)` 仅当消息仍 pending 才成功，claim 后不能用它撤回已经进入本轮的输入。`agent.cancel(cause,{keepInbox:true})` 中断活动而保留 pending；未传 keepInbox 会清掉两列全部 pending。当前普通 Session Remote 的 cancel 主动选 keepInbox=true；updateQueue 可 edit/remove/steer 一个 pending item。这些操作不回滚已执行的工具副作用。[Inbox 与 cancel](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts#L33)、[Remote cancel](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L492)、[Remote pending mutation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L419)。

### Nexus 命令入队前核对 revision 的位置

在所核的 send/inbox/runtime 接口中，没有找到通用“所有消息入队前”的可拒绝扩展事件。普通 Session prompt 包含 resolveAgent 和 attachments 的 await；若在调用该 async endpoint 之前核 revision，检查与实际 enqueue 之间仍可能插入新的人类消息。其最终 `createUserMessage`→活 Agent 校验→steer/followup 是同步段。Nexus 自有 Host 桥应完成异步准备后，在最后投递点做自己的 revision 核对，并紧接同步 send；这只是可利用的实现位置，不是原生版本控制特性，也不是跨进程事务保证。[Host prompt admission](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L319)。

执行侧另有 `tools/pre-execute`（allow/deny/cancel/ask）和 `ctx.tools.guard(...)`（只可降低权限的最终同步 guard）。它们适合核实工具 dispatch 时 Nexus 计划是否仍有效；异步审批等待期间用户可能改指令，最终 guard 比最初检查更接近副作用起点。它们不是通用消息入队钩子，也不能让已经开始的工具副作用消失。[工具管线与 guard](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md#the-execution-pipeline)。

由这些接口可以设计来源优先、过时 revision 拦截、pending 清理与 best-effort 中断；但 Harness 当前没有替 Nexus 做这套仲裁。revision 只能证明“计划基于哪个控制版本”，不能证明一条自然语言命令语义一定遵守用户目标。

## 补查：同一个 Qwen Realtime 模型在挂断后只生成文字

2026-10-08，用户 Q9 选择同一个 Realtime 模型负责通话和挂断后的文字调度，挂断后不得生成或播放语音。模型核查依据为公开 dsh-realtime-voice 所用的 Qwen Audio 3.0 Realtime Plus/Flash；尚不能断言这就是用户本地适配及版本，未做真实 API 验收。

- **官方明确支持文字输出而不生成语音。** Qwen Audio Realtime 使用指南的“输出模态”列出 `session.update` 设置 `modalities:["text"]`，明确只生成文本；`response.create.response.modalities` 可覆盖单轮。官方客户端事件没有给 modalities 加“仅首次配置”限制，和只可首次设置的 voice、发送音频前设置的 turn_detection 不同。因此同一模型可以按通话状态切输出模态。[官方使用指南](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)、[客户端事件](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)。
- **文字输入与工具闭环已有协议字段。** `conversation.item.create` 支持 user/input_text，以及 function_call_output；`response.create` 触发后续推理。`session.update` 同时定义 modalities 和 tools，只明文禁止 tools 与 enable_search 同时启用；FC 支持名单包含 qwen-audio-3.0-realtime-plus、3.0-realtime-flash、3.1-realtime-plus。这支持“同一 Realtime 型号以 text-only 配置执行工具调度”的设计；官方 FC 示例使用音文双模态，text-only + FC 联合端到端仍需实际验收。[客户端事件](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)、[Function Calling 支持模型](https://help.aliyun.com/zh/model-studio/qwen-function-calling)。
- **公开插件目前没有实施这一切换。** DashScopeRealtime.connect 初始化硬编码 `modalities:['text','audio']`，同时配置 tools；commitAudio 和后续 requestResponse 未带 text-only 覆盖。要满足挂断后不生成语音，需要改模型输出配置和正在进行的响应处理，不能只静音播放器。[公开适配源码](https://github.com/martinbear1/dsh-realtime-voice/blob/main/src/host/dashscope-realtime.ts#L78)。
- **同一个模型不等于永久保留同一个云端 session。** 官方指南要求客户端为网络抖动/server_error 实现重连，并说明空闲过久可能被服务端断开。此次窄查未找到明确连接时长上限或可凭 session ID 恢复原服务端 session 的保证；历史注入 API 是重建上下文的能力，不证明服务端原会话恢复。50 个历史音频轮次/300 秒音频保留属于上下文容量，不是长连接时长。Nexus 本地持续运行仍需保存任务与会话状态，允许重新连接相同模型并补入必要历史。[官方生命周期与容错说明](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)。

本轮只确认文档与公开源码，不声称用户适配已完成模态切换、text-only 工具闭环、长期挂机或断线恢复验收。
