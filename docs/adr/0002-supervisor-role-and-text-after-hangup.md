# Nexus 负责调度，挂断后在主会话继续文字工作

Nexus 默认负责理解、拆解、调度和检查结果，具体工作交给 DeepSeek Harness 工作会话。完整权限不变；这是默认分工，不是能力限制。选择这一分工是为了让主管保持可交流，并将耗时执行留在工作会话。

挂断电话后，Nexus 继续监督、调度和处理任务结果，在同一个主会话输出文字，不生成或播放语音。通话与挂断后的后台文字调度均由同一个 Realtime 模型承担，不切换为另一个文本模型。挂断结束语音交流，不结束主管或已派出的工作。主管生命周期与语音通话生命周期因此分开；何时完成目标并进入空闲、重接通如何恢复，以及所选 Realtime Provider 的纯文字输出和长会话恢复能力仍待验证。

准确型号官方资料确认文字、语音与 Function Calling 能力，客户端事件支持 modalities 为 text-only。这为同型号后台文字调度提供文档依据，但纯文字与工具调用的联合链路尚未在 Nexus 实测，长连接期限和断线原服务端会话恢复不作未验证承诺。[型号能力](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime)、[客户端事件](https://help.aliyun.com/en/model-studio/client-events)、[协议核查](../research/realtime-protocol.md)

首版沿用 Qiyu 已有适配的型号 `qwen3.8-omni-flash-realtime`，传输为 DashScope Realtime WebSocket。已有适配源文件为 `E:\Agent\Qiyu\packages\qiyu_local_host\lib\src\qwen_omni_realtime_gateway.dart`。当前官方接入配置与旧适配存在差异，不能未经探针就直接复制端点和 schema。

会话持久化、恢复和 Harness 重启后的行为沿用 Harness 原生机制，不另外实现重启后自动续跑策略。Nexus 提供一个默认关闭的“启动 Harness 后自动进入 Nexus 语音”设置，开启后每次 Harness 进程启动自动尝试接通一次。主动挂断后保持文字模式，刷新或切换会话不重新开麦，用户可以手动再次接通。该设置不涉及操作系统登录自启动 Harness，也不改变原生任务恢复语义；客户端就绪、系统许可和实际播放仍须验证。

> 部分被 [ADR 0005](0005-cascade-voice-mode.md) 取代：主管模型不再限定为 Realtime 模型。
