# Nexus 首版实现设计

状态：用户已确认设计。本次仅做前置调研与 Spec；下述技术验证留待后续实现阶段。已确认的产品决定以 [设计讨论](design.md) 为准。本文件区分要实现的行为与仍须验证的 Harness 接入点。

## 结构与职责

| 部分 | 职责 |
| --- | --- |
| Host 中的 Nexus 主管 | 运行唯一 Realtime 模型，处理用户输入和会话结果，执行模型发起的调度工具调用；挂断后继续处理文字和工具 |
| Harness 会话桥接 | 列出、读取、创建和控制全部工作会话，订阅结果与用户引导，将消息送入正确会话并保留来源 |
| 原生 Nexus 主会话 | 展示用户与主管交流、工具活动和汇报，使用 Harness 的会话记录与恢复机制 |
| 客户端语音界面 | 在原生侧栏提供固定入口，采集和播放音频，接通、挂断及显示实际连接状态 |

Realtime 主管是决策者。会话桥接负责执行工具与投递事实，不再调用另一个模型解释意图、决定派活或编排固定修复流程。工作会话继续使用自己的原生 agent 与上下文。

## 会话调度与结果回流

工具覆盖列出会话、读取上下文与状态、创建工作会话、发送任务或引导，以及原生停止操作。这些是主管的常用调度入口，不构成权限白名单；Nexus 不设额外审批与会话归属限制。

已有普通会话也必须可操作。官方 continuable 通信只覆盖直属父子，不能作为全局调度的唯一入口。会话桥接对照安装版本接入原生控制面：运行中引导使用 steer，闲置会话可被新消息唤醒，恢复与任务终态遵循 Harness 原生行为。[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)、[Core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)

全局观察允许主管读取全部工作会话，但不把每个 token、工具日志和所有历史无限复制进主管上下文。自动投递工作轮次的结果、失败或中断等终态，带会话身份、相关消息身份、最终内容与终态信息；需要细节时主管读取该会话。连接层按事件身份避免重复投递，并排除主管自己的输出回流到自己。

主管忙时，结果进入待处理消息，在下一次处理机会交给同一个主管；闲时触发主管处理。Harness 状态事件只表示连接层已获知变化，不能当成模型已经接收。Realtime 如何接收忙时异步结果、如何在用户新一轮输入后继续工具响应，须在探针中验证。是否汇报、何时说话以及是否继续派活仍由 Nexus 决定。

用户直接在工作会话中发出的引导也要让 Nexus 获知。消息区分用户输入、Nexus 调度与自动结果；原生普通 prompt 把调用标为 user 的入口不能原样冒充真实用户。用户明确指令优先依靠来源与上下文表达，运行中的 agent 在原生步骤边界自行调整，不加入版本仲裁或自动强制取消。[输入源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/src/commands.ts#L301)

## 主管接入与持久化

首版必须只有一个主管：不能让 Qwen 仅负责语音，再交给另一个原生模型主管解释和调度。

目前核查到的候选路线是插件构造 Realtime Agent 并通过 `ctx.agents.register(agent)` 注册到 Harness agent registry，将主管绑定到一个原生主会话；工作会话保留默认 AgentLoop。单请求 LLM adapter 尚不能证明能承载持续 WebSocket、主动语音输入及后台结果；全局 agent factory 也不能直接被第二个插件无冲突替换。因此此处是基于公开契约推断的接入路线，不是现成配置。[Agent registry](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#ctxagents--agentregistry)、[LLM 接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md#llmstream--waterfall)

原生 Session 的内存 append 不等于落盘。验证时必须对接原生持久化、恢复和有序关闭，并正确记录 turn、step、用户消息、工具消息和主管文字输出。不能只把 Realtime 文本画在界面上，就宣称拥有原生主会话。重启后保留原生记录及中断状态，不增加自动续跑任务策略。[SessionStore](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md#ctxsessions--sessionstore)、[持久化](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)

现有公开语音插件的事件桥可参考，但其协调器固定围绕一个工作会话，将任务 handoff 给原生 Agent；它不满足 Realtime 模型自身成为唯一主管的要求。[事件桥](https://github.com/martinbear1/dsh-realtime-voice/blob/main/src/host/dsh-backend-bridge.ts)、[协调器](https://github.com/martinbear1/dsh-realtime-voice/blob/main/src/host/dsh-coordinator.ts)

如果当前插件接口不足，先记录缺少的具体 seam 和最小改动，再向用户说明与“独立插件”边界的冲突；不能默默改成双主管或另造会话存储。

固定基线补查发现：保留默认 factory 时，通用 `ctx.agents.resume` 会使用默认 ReactLoopAgent；主管不能直接沿用该入口并假定身份保留。Nexus 要识别主会话，用原生持久化恢复记录，再登记自己的 Realtime driver。此处仍须验证插件初始化、原生入口路由与有序退出，详见 [Harness 前置核查](research/harness-spike.md)。

## Realtime 与通话生命周期

沿用型号 `qwen3.8-omni-flash-realtime`，参考现有 Qiyu 适配已经核实的建连握手、音频事件、文字输入、工具回填与终态处理。Nexus 的提示词和工具按主管职责重新定义。准确型号已由官方资料确认支持 text-only 与 Function Calling，但联合链路及新接入配置需要实测，详见 [协议依据](research/realtime-protocol.md)。

接通时，客户端负责麦克风与播放，Host 负责模型连接和工具执行。挂断时停止采集和播放，并让模型只输出文字；主管和工作会话继续运行。在途音频不能在挂断后继续播放，也不能只静音客户端却让后台继续生成语音。切换输出模态与在途 response 的处理必须验证。

模型连接可能重建，不能把同一型号等同于永不失效的服务端会话。重连需要从已持久化的主管记录恢复必要上下文；具体协议和未结束工具调用的恢复方式需实测。关闭 Web 页面后，Host 仍应能处理文字工作；退出 Harness 则沿用原生停止与恢复行为。

自动语音选项默认关闭。开启后，每次 Harness 进程启动只尝试一次，在 Host 和语音客户端就绪后发起。启动周期状态放在 Host，防止刷新、切换会话或重复挂载重新开麦。手动挂断后用户可手动再接通。系统首次麦克风许可、设备与播放状态仍需正常处理；同一主管同一时刻只连接一个音频客户端。[自动接通依据](research/automatic-voice-start.md)

## 第一阶段可行性验证

先锁定用于验证的 Harness 版本或提交，完成以下四条真实链路，再展开完整插件：

1. **单一主管**：Realtime Agent 接入原生主会话，文字与工具记录正确落盘，关闭重启可按原生方式恢复；没有额外模型主管。
2. **已有会话**：主管向一个既有普通会话派活或引导，收到其终态结果；空闲时被结果唤醒，忙时能在后续处理中获知结果。
3. **挂断继续工作**：同一型号切换纯文字输出，完成工具调用与续答；无音频生成或播放。重新接通能延续已有主管上下文。
4. **用户途中改要求**：真实用户消息与 Nexus 调度来源可区分，运行中会话在后续步骤按新要求调整；主管也能更新后续安排。

若某条不成立，明确阻塞在哪个接口、型号协议或持久化阶段。仅有 mock、文档支持或界面截图不足以宣称这四条链路成立。

## 首版验收

在设计讨论中的完整修复与审查场景基础上，再验证：

- 全局会话可列出与读取，包括非 Nexus 创建的已有会话；结果不会重复回流或形成主管自回流。
- 工作期间正常语音交流与用户打断；异步结果不导致已经开始的新用户轮次丢失。
- 主动挂断后主管继续纯文字调度；刷新与切换会话不重开麦，手动接通正常。
- 开启自动语音后重启 Harness 只自动尝试一次；首次系统许可、麦克风不可用与播放未就绪都显示真实状态。
- Host 保持运行时关闭语音客户端，文字任务仍可完成；退出与重启遵循原生中断及恢复语义。

工作区选择、并发修改协调、追加修复与审查由 Nexus 根据用户目标决定；验收关注其行为结果，不要求预设调度流程。
