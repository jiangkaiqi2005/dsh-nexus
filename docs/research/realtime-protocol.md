# 首版 Realtime 型号与协议依据

核查日期：2026-10-08。准确型号为 `qwen3.8-omni-flash-realtime`，来自 Qiyu 当前模型预设和网关。用户已选择 Nexus 沿用此型号。此次只读核查，没有重新调用真实端点，没有改动 Qiyu。

## 已核实

准确型号官方页面列出文字与语音、Function Calling 和 MCP 能力。客户端事件定义允许 `session.modalities=["text"]`，文字输出使用 `response.text.delta` / `response.text.done`。[型号说明](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime)、[客户端事件](https://help.aliyun.com/en/model-studio/client-events)、[实时调用](https://help.aliyun.com/en/model-studio/realtime)

工具声明通过 `session.update` 提交。收到 `response.function_call_arguments.done` 后执行工具，用 `conversation.item.create` 写入 `function_call_output` 并携带原 `call_id`，随后 `response.create` 续答。官方 SDK 说明 Qwen3.8 工具调用轮只返回调用参数、不生成音频，且 `tools` 与 `enable_search` 互斥。[工具调用](https://help.aliyun.com/en/model-studio/qwen-function-calling)、[SDK 参数](https://help.aliyun.com/en/model-studio/omni-realtime-python-sdk)

现有适配文件：`E:\Agent\Qiyu\packages\qiyu_local_host\lib\src\qwen_omni_realtime_gateway.dart`；模型预设：`E:\Agent\Qiyu\apps\qiyu_flutter\lib\features\settings\provider_catalog.dart`。适配采用 DashScope Realtime WebSocket，模型放 query，Key 放 Bearer header；包含就绪握手、音频与文字事件、工具回填续答、response 终态和超时处理，可参考其已验证的协议经验。

## 文档与旧适配差异

旧适配使用 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` 和扁平音频、工具字段；代码记录它们在 2026-10-02 真实端点测试可用。当前准确型号官方接入文档使用带 WorkspaceId 的地域端点，示例配置为嵌套 `session.audio.input/output` 与 `tools[].function`。[当前接入文档](https://help.aliyun.com/en/model-studio/realtime)

此差异不证明旧适配失效，也不能据此保证直接复制旧适配可用于新插件。Nexus 在实现前需以实际可用配置做探针，确认建连、文字输入、text-only 与工具续答组合，并确认正在生成语音时挂断能停止音频生成及播放。

长连接期限、断线后的服务端会话恢复、忙时注入工作结果与用户新一轮输入后的工具回填，同样不能只凭输出模态文档作承诺。

## 票 07 实测（2026-10-10）

准确型号真实端点探针（扁平配置、server_vad），证据 `.scratch/nexus-v1/protocol-07/probe-1.json`、`truncate-1.json`：

- 用户开口时，生成中的回复以 `response.done{status:'cancelled', status_details.reason:'turn_detected'}` 结束，与 `speech_started` 同毫秒且先于它；之后无迟到增量。
- 生成约为实时的 3.4 倍，回复常已生成完而仍在播放，停播与“听到多少”须由客户端和 Host 处理；真实 `speech_started` 比开口晚约 0.8 s。
- `conversation.item.truncate` 静默忽略：无确认、无 error，模型仍能复述全文。
- 无活动回复时 `response.cancel` 返回 `error{type:'invalid_request_error', message:'Conversation has none active response'}`，无 code；属单次请求错误，非连接失败。
- 工具调用后插入用户语音轮，再回填 `function_call_output` + `response.create` 可正常续答。
- 有活动回复时 `response.create` 排队；用户说话期间的 `response.create` 被吞并，commit 后只产生一个自动回复。
