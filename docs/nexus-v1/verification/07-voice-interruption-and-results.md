# 票 07：语音打断时保留新输入与异步工作结果验证

验证日期：2026-10-10。unitBase：`3fb7956`。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 profile，没有向用户 profile 安装。平台、Node、Playwright 与无头 Edge 同票 06。全程没有 Computer Use，没有打开物理麦克风或扬声器，也没有触达用户的 Desktop 或浏览器。

## 协议实测（准确型号，探针为研究证据，不是测试）

实现之前，先用准确型号 `qwen3.8-omni-flash-realtime` 的真实端点（与票 06 相同的扁平配置，server_vad）做了探针，证据在 `.scratch/nexus-v1/protocol-07/probe-1.json` 和 `truncate-1.json`。结论如下，摘要也补进了 [协议研究](../../research/realtime-protocol.md)：

- **生成中被打断**：server_vad 默认会打断回复。用户开口时，正在生成的回复以 `response.done{status:'cancelled', status_details.reason:'turn_detected'}` 结束，输出 item 为 incomplete。这个事件与 `input_audio_buffer.speech_started` 在同一毫秒到达，而且排在它前面；之后没有迟到的增量。
- **已生成完、仍在播放**：生成速度约为实时的 3.4 倍，回复常常已经全部生成，客户端还在播放。此时服务端没有可取消的回复，停止播放和记录听到多少只能由客户端和 Host 完成。真实的 `speech_started` 比开口晚约 0.8 秒。
- **`conversation.item.truncate` 被静默忽略**：既没有确认，也没有 error，模型之后仍能复述全文，所以不用它。
- **`response.cancel` 没有活动回复时**：端点返回 `error{type:'invalid_request_error', message:'Conversation has none active response'}`，没有 code 字段。这类单次请求错误不代表连接失败。
- **工具调用之后插入用户语音轮**：再发 `function_call_output` 加 `response.create`，模型能正常续答。
- **`response.create` 的时机**：有活动回复时发出会排队，在当前回复之后执行；用户说话期间发出会被吞并，commit 后只产生一个自动回复，Host 的请求永远得不到单独回复。

## 实现与原生边界

- **打断即停播**（`src/realtime.ts`、`src/voice.ts`、`client.js`、`typert.js`）：
  - 收到 `speech_started` 时，如果有已经送往客户端的模型音频，Host 下发 `{type:'flush'}`。
  - 客户端立即 `stop()` 所有已排程和正在播放的音频节点，丢弃队列，然后按 AudioContext 时钟回报 `{type:'played', samples}`。
  - Host 用一份按回复记账的送出账本，把回报的样本数对应到各个回复。没播完的回复会得到一条剪切记录：文字、听到的秒数和总秒数。
  - 两端解析器同步扩展，仍为严格校验：上行增加 `played`（非负安全整数，恰好两个键），下行增加 `flush`（恰好一个键）。
  - 通话条增加 `data-flushes` 和 `data-discarded-samples` 两个属性，供测试读取。
- **按 response_id 归属**：
  - 删除了票 06 的 `current()` 猜测。每个 `response.created` 按顺序归属：先给最早的未分配语句，其次给已发出请求、还没有 id 的 Host 请求；两者都没有时，是没人请求的孤儿，不播放也不记录。
  - 增量和 `response.done` 都按 response_id 查找对应回复。未知或已结束的 id 直接忽略，所以迟到的音频、文字和 done 不会进入新轮次。
  - 文字连接与语音连接同一条规则：先有 `response.created`（真实端点总是发送），事件按 id 或当前回复归属。初轮曾为不发 `response.created` 的受控文字端点保留兼容分支，修复轮 1 已删除，改为受控端点按真实协议发送。
  - 用户开口后，当前回复标记为 silenced，它之后的音频不再播放；文字和工具调用照常累积。
  - 用户再次开口时，已提交、但服务端还没开始回答的语句不再等回复。按探针，服务端会把它并入新语句一起回答，所以它结束时没有自己的回复，下一个回复也不会错记到它名下（修复轮 1）。
- **原生记录与实际听到的一致**：
  - 服务端取消的回复（`cancelled`）按原生处理被取消流的方式记录：只保留已交付的前缀，`assistant/message` 带 `interrupted: true`，finish 原因是 `aborted / INTERRUPTED`，未派发的工具调用不保留。
  - 服务端完成的回复，即使用户在它结束前开口，也是完整的：文字和工具调用都保留，工具照常执行并回填（修复轮 1；初轮会把它标为 interrupted 并丢掉开口之后到达的工具调用）。
  - 没播完的回复，assistant 消息保持完整，表示模型说了什么。客户端回报播放量后，Host 立即用 `conversation.item.create` 把一条 `nexus-voice` 来源的通知（summary 为 `interrupted playback`，写明大约播放了多少秒、总长多少秒、其余部分没有被听到）送进服务端会话，这时用户通常还在说话，所以通知先于该语句的自动回复进入模型上下文。原生记录把通知记在打断语句所在 turn 的用户原话之后，与服务端会话的顺序一致（服务端在开口时就建立了用户语音 item）。没有形成语句时（误触发、挂断），通知记在下一个 turn 的输入之前，不丢失。通话指令里加了一句说明。通知不冒充用户原话。
  - **更正**：初轮的通知要等下一次 Host 请求才发出；语音轮只等服务端自动回复，所以受控与真实打断中模型都没收到通知，初轮文档“随下一轮输入发给模型”不实。修复轮 1 改为立即送出，见下。
- **请求被吞并后重发**：
  - Host 的 `response.create` 如果发在用户说话期间（已发出、尚未 created 时检测到 `speech_started`），视为被吞并。等该语句的自动回复结束、连接空闲后，Host 再重发一次。
  - Host 请求的等待条件包括用户正在说话和还有未分配的语句，所以不会和自动回复争抢同一个 response。
  - 工具续答（`function_call_output`）和工作结果都不会因此丢失或被静默忽略。
- **error 分级**：
  - 下列 error 仍让整通通话失败：连接配置尚未完成时的 error，以及文字连接上的 error。
  - 已发出、尚未 created 的 Host 请求碰到 error 时，只让这一次请求失败，连接保持。
  - 其它单次 error，例如取消时没有活动回复，不影响通话，写入 Host 日志（info 级，`nexus voice: endpoint error left the call up: …`；修复轮 1 前完全静默）。端点的 error 不带对应客户端事件的标识（探针中只有服务端 event_id），所以无法精确归属，只归给尚未开始的 Host 请求。
- **不取消工作会话**：打断只作用于模型轮次和播放。工作会话照常执行，结果照常回流，是否调整由主管根据用户新输入判断。
- **没有提前实现票 08–10**：挂断、Host 停止、自动接通和断线路径保持票 06 的行为，相关回归用例全部通过。

## TDD 接缝与红绿

接缝是 Spec「测试决定」中的最高边界：真实官方 Host（后台隔离、`--no-open`、`windowsHide`）+ 讲 DashScope 协议的受控端点 + 无头 Edge 真实客户端 + 合成音频（`tests/voice.test.mjs`）。受控端点按探针实测复现打断语义：开口即取消生成中的回复，cancelled done 先于 `speech_started`；说话期间的 `response.create` 被吞并，有活动回复时的 create 排队。它还可以按计划注入以下情况：慢速或突发音频、被取消回复的迟到包，以及取消时没有活动回复的 error。

| 用例 | 红（旧代码） | 绿 |
| --- | --- | --- |
| 打断（5 句） | `.scratch/nexus-v1/ticket07-red-barge.txt`：打断后播放不停，“playback stopped” 超时 | `ticket07-green-barge.txt` |
| 打断 + 无关 error（只把 error 处理改回抛出） | `ticket07-red-error.txt`：整通失败，“fourth onset” 超时 | 同上 |
| 交错（工具与结果） | `ticket07-red-interleave.txt`：结果请求被吞并（absorbed=1），结果永远没有被回答；强化后的用例在 HEAD 版本 src/client/typert 下仍失败（`ticket07-red-interleave-r2.txt`，“supervisor idle” 超时） | `ticket07-green-interleave.txt` |

## 验证

### 受控端点（真实 Host、真实客户端、合成音频；打断语义为受控注入）

**打断**：第 5 项，证据 `.scratch/nexus-v1/voice-barge-1791624470218`（`result.json` 原生日志，`wire.json` 线上事件）。

- 语句 1 的 LONG-ONE 一边生成一边播放，每 150 ms 一个增量。语句 2 开口时，端点取消该回复（`cancelled: resp-1-1`）。客户端在 1.5 s 内没有可闻节点，并且有提前停止的节点。
- 语句 2 的回复中，端点注入了被取消回复的迟到音频、`LATE-TEXT` 和迟到 done，还在 `speech_started` 后注入了一条无关 error。结果：迟到包没有排程，排程样本等于 9600 × 有效增量数；记录中没有 LATE-TEXT；通话保持 live。
- 原生记录：**初轮历史记录，通知位置已被修复轮 1 取代：** turn 1 的 LONG-ONE 带 `interrupted: true`。turn 2 先是通知“about 2.7 s of its 7.2 s”，再是用户原话，再是完整的 VOICE-TWO。
- 语句 3 的 LONG-THREE 突发生成完（服务端已结束），播放中被语句 4 打断。初轮 turn 4 开头通知（修复轮 1 改为用户原话之后）“about 3.3 s of its 8.0 s”。
- 语句 5 正常往返，共 2 条通知，5 个 turn 全部 completed，挂断前通话仍为 live。

**交错**：第 6 项，证据 `.scratch/nexus-v1/voice-interleave-1791624505762`。端点的 `speech_started` 在开口后 2 s 才发出。

- turn 1：语句 1 调用 `fixture_slow_lookup`（受控工具，等测试放行）。语句 2 开口时测试放行工具，`function_call_output` 加 `response.create` 在用户说话期间发出。
  - 这次 create 被吞并后，Host 等语句 2 的自动回复 VOICE-WHILE-TOOL 结束，再重发；续答 TOOL-CONTINUED 晚于该回复生成。
  - 原生 turn 1 依次为 call、TOOL-RESULT-77、TOOL-CONTINUED，三者同一个 call id。VOICE-WHILE-TOOL 在 turn 2。
- turn 3：语句 3 用 `nexus_send_session` 派活给 docs（受控 worker）。语句 4 开口时测试放行 docs，结果请求同样被吞并。
  - Host 等语句 4 的回复 VOICE-FOUR 结束后重发，RESULT-HEARD 在结果自己的 turn（turn 4）中回答。
  - 端点记录 `absorbed: 2`，两次被吞并的请求都得到了回答。docs 正常 completed，没有被取消。全部 turn completed。
- **记录顺序**：原生 turn 按输入身份排列，一个输入一个 turn，一个 turn 完成后才开始下一个。所以实际说出的顺序和原生 turn 顺序可能不同：
  - turn 1 的续答实际晚于 turn 2 的回复；
  - turn 4 的 RESULT-HEARD 实际晚于 turn 5 的 VOICE-FOUR。
  - 初轮中，缓冲后补记的语音回复，流块时间戳是补记时刻。修复轮 1 起，原生 `assistant/message` 的 stream 块时间是模型实际产生这些文字的时刻（文字块随首个增量开始，结束块用服务端完成时刻），所以从原生记录即可还原实际生成与播放次序，见修复轮 1 的交错断言。
  - 身份与归属没有错配；turn 序仍按输入身份，不按播放时间。

**回归**：同一文件其余受控用例全部通过，包括票 06 的派活、实际状态、新建会话、挂断和停滞用例。整文件 10 项：8 passed、0 failed、2 skipped（真实 opt-in），日志在 `ticket07-voice-file.txt`。

### 真实模型（准确型号，真实客户端，合成音频）

opt-in 方式为 `NEXUS_REAL_VOICE=1` 加临时 `NEXUS_VOICE_KEY`。凭据由临时包装脚本只读取 `%USERPROFILE%/.qiyu/provider.json` 的 top-level `apiKey`，只进入子进程环境和隔离 Host 原生 credentials 服务，输出中的密钥已擦除。

**真实打断**：passed，日志 `.scratch/nexus-v1/ticket07-real-barge-1.txt`，证据 `.scratch/nexus-v1/voice-real-barge-1791624593357`（`output/summary.json`、`voice-call.png`）。合成音频依次为：静音 5 s、“请详细讲一讲长城的历史，多讲一些细节。”、静音 7 s、“先停一下，一加一等于几？”、静音 20 s、“好的，谢谢你。”。

- 三句转写都正确。
- 长回复在服务端已生成完（没有 cancelled），客户端播放到约 6.7 s 时被第二句打断。客户端 flush 后丢弃 895744 个样本（约 37 s），118 个节点提前停止。
- **初轮历史记录，位置描述已被修复轮 1 取代：** turn 2 开头的通知写明“about 6.7 s of its 44.0 s of audio were played”，排在长回复之后、问题之前。
- 模型回答“一加一等于二。”。第三句得到“不客气，随时可以聊。”，没有被打断，之前也没有剪切通知。客户端共 flush 2 次：第二次时回复已经播完，所以不产生通知。
- 3 个 turn 全部 completed，全部回复来自准确型号。

**票 06 真实回归**（日志 `ticket07-real-06-regression.txt`）：

- 既有会话语音派活：passed，`voice-real-1791624665385`。
- 语音新建会话：
  - 第 1 次 **failed**，`voice-real-create-1791624703624`。模型按 `3fb7956` 新增的项目发现指引，先调用 `nexus_list_workspaces`，然后在列出的唯一已登记项目（仓库根，标题“Nexus”）中新建会话，没有用 docs 会话的工作区；新会话已执行完成。失败在“目标工作区”断言，与打断改动无关。本票对指令的唯一改动是通话指令末尾加了一句打断说明。
  - 重跑 1 次 passed，`voice-real-create-1791624848509`（日志 `ticket07-real-create-rerun.txt`）：模型先 `nexus_list_sessions`，再在 docs 的工作区新建会话。
  - 初轮结论已被修复轮 1 的项目名与会话工作区指引修复取代（bc2def0）；没有改目标工作区断言。

### 命令与结果

```powershell
npm run typecheck
npm run build
npm test
git diff --check
node --test --test-name-pattern='speaks over a long spoken reply' tests/voice.test.mjs        # NEXUS_REAL_VOICE=1 与临时 NEXUS_VOICE_KEY
node --test --test-name-pattern='accurate Realtime voice call: real model' tests/voice.test.mjs  # 票 06 两项真实回归
```

- typecheck 和 build 通过（`ticket07-typecheck.txt`、`ticket07-build.txt`），`git diff --check` 无问题。
- 全量 `npm test` 第一次运行（`ticket07-npm-test-red-text.txt`）：57 项，33 passed、14 failed、1 cancelled、9 skipped。
  - 失败都在文字路径（profile、dispatch、delivery、restore、steering、ui、workspace）。原因是这些用例的受控文字端点不发 `response.created`，也不带 response id；改为按 id 归属后，文字请求收不到回复，最终 TIMEOUT。
  - 修复：文字连接中，没有 id 的事件归给它唯一的请求（见“按 response_id 归属”）；语音路径不变。修复后 `tests/profile.test.mjs` 13 passed。
- 修复后全量 `npm test`（`ticket07-npm-test.txt`）：57 项，48 passed、0 failed、0 cancelled、9 skipped（真实 opt-in），约 184 s，没有挂起。
- 真实检查都在这次修复之前运行。修复只改变文字连接，语音分支的代码路径未变。
- 真实打断 1 passed。票 06 真实回归：既有会话 1 passed；新建会话 1 failed 后重跑 1 passed。

## 验收对照（修复轮 1 后）

| 票 07 验收项 | 状态 | 依据 |
| --- | --- | --- |
| 生成或播放时开口，按原生轮次机制停止回复，清理待播音频，接收新输入 | 满足（受控 + 合成音频真实） | 受控：生成中取消与播放中剪切。真实：初轮为已生成完、播放中打断；修复轮 1 两次真实运行均为生成中被端点取消（`cancelled`），立即停播并丢弃队列。 |
| 新轮次正常回应；记录与实际听到的一致，不把未交付片段当完整回复 | 满足（受控 + 真实） | 生成中取消：只记前缀并带 `interrupted`。没播完：完整 assistant 消息加“听到约 X/Y 秒”的通知；修复轮 1 起通知在打断语音期间送入模型上下文，先于该语句的回复（受控线上断言；真实经记录中继，通知在 speech_started 后 12–19 ms 送出，其间没有回复开始）。初轮通知未送达模型，此项初轮实为未满足。 |
| 新输入、工作终态与工具完成交错时，身份与顺序可追踪，不丢不错填 | 满足（受控） | 归属按 response_id，同一 call id 的续答在原 turn，结果在自己的 turn，被吞并的请求重发后都得到回答；被并入下一句的语句不再错领下一个回复（修复轮 1）。原生 turn 按输入身份排列；实际生成次序由原生 stream 块时间保留（修复轮 1），受控断言其与端点生成时刻一致。turn 序不等于播放序这一点属原生 turn 结构，需用户裁定是否接受。 |
| 被打断轮次的工具响应按实际协议处理，不静默忽略成功结果 | 满足（受控；协议真实探针） | 被取消的工具调用没有派发，不保留（同原生）。端点在用户开口后才完成的回复保留其工具调用并执行回填（修复轮 1）。已执行的工具输出照常回填，续答被吞并后重发并完成。探针证实打断后续答可行。 |
| 打断不由 Host 强制取消工作会话 | 满足（受控） | docs 在打断与交错过程中正常完成。 |
| 延迟音频、旧响应不在新轮次播放；连续交流可恢复 | 满足（受控注入 + 真实） | 迟到包、迟到 done 与无关 error 都不影响新轮次（受控注入）。真实与受控都覆盖了连续打断后的正常往返。 |
| 实际通话演示打断，并用可控延迟验证关键交错；标明真实与模拟 | 部分满足 | 真实端点、真实客户端代码加合成音频已演示打断；交错为受控。物理扬声器外放、回声与 Desktop 实机通话未做，**待用户实机验证**。 |

## 未验证与边界

- 物理麦克风、扬声器外放与回声消除未验证。外放时模型自己的声音可能触发 server_vad 误打断；采集请求了 `echoCancellation`，实机效果未知。Desktop 外壳内未验证。
- 真实端到端：初轮为播放中打断（回复已生成完），修复轮 1 两次均为生成中被取消；修复轮 1 代码下“已生成完、播放中打断”的路径只有受控证据（LONG-THREE）。
- 迟到包、吞并竞态和无关 error 都是受控注入，按探针观察到的协议行为构造。
- 剪切用通知记录，不用 `conversation.item.truncate`，因为端点静默忽略它。模型上下文里仍有完整回复文字，由通知说明实际听到多少。
- 剪切时长按客户端 AudioContext 时钟计算，是播放进度，不是用户实际感知；输出设备延迟未计入。
- 原生记录按 turn 身份排序，与实际播放顺序可能不同；实际次序靠 stream 块时间还原（见“交错”与修复轮 1）。
- 通知送达依赖客户端在提交前回报播放量（本机往返为毫秒级）；若回报晚于该语句的自动回复，模型在那次回复中看不到通知，记录仍完整。用户开口时排队中的 Host 请求、或在服务端开始前被并入下一句的语句，按探针处理；更细的竞态（如并入后服务端仍为旧语句开回复）没有协议依据可区分。
- 工作会话为受控 native adapter。挂断续行、断线、多客户端与自动接通仍属票 08–10。

## 修复轮 1

评审基线为 reviewHead `9fd231f`，unitBase `3fb7956`。标准轴：approve（全 P3）；规格轴：changes_requested（3 个 P2）。另有协调者指派一项，单独提交为 `bc2def0`。

### 处置

| 意见 | 处置 | 依据 |
| --- | --- | --- |
| 规格 P2-1 模型看不到剪切通知 | fixed | 客户端回报播放量后，Host 立即把通知 `conversation.item.create` 进服务端会话并标记为已在会话中（`RealtimeConnection.insert`）；原生记录把它放在打断语句的用户原话之后，与服务端顺序一致。受控断言：两条通知在线上都早于对应语句的自动回复。真实断言：经记录中继，通知在 `speech_started` 后 12–19 ms 送出，其间没有回复开始，约 3.5 s 后才开始回答。初轮文档、验收表、README 的不实表述已更正。没有形成语句时（误触发、挂断），通知记在下一个 turn 的输入前，不丢失。原生记录只能在 turn 内写 user/message，这是最早的位置。 |
| 规格 P2-2 交错实际顺序不可追溯 | fixed（turn 序部分需用户裁定） | 原生 stream 块时间改为模型实际产生该文字的时刻，补记的回复也一样；文字块随首个增量开始，结束块用服务端完成时刻。交错用例断言 VOICE-WHILE-TOOL 早于 TOOL-CONTINUED、VOICE-FOUR 早于 RESULT-HEARD，且与端点生成时刻相差不到 1 s。turn 序仍按输入身份，这是原生 turn 结构（一个 turn 完成才开始下一个）；是否接受由用户裁定。 |
| 规格 P2-3 / 标准 P3-1 文字路径 | fixed | 8 个受控文字端点（delivery、desktop、dispatch、profile、restore、steering、ui、workspace）按真实协议先发带 id 的 `response.created`；删除 `unidentified()`，文字与语音同一归属规则。最终代码上真实文字检查 5/5 passed（见下）。 |
| 规格 P3 真实生成中被取消 | fixed | 真实打断用例改为两种间隔（7 s、2 s）。修复轮 1 两次运行，端点都在生成中取消了长回复，记录带 `interrupted: true`。 |
| 规格 P3 已标 cut 但 completed 的回复丢工具调用 | fixed（属实） | 红：受控 edge 用例中，开口后才完成的回复被标 interrupted，工具调用丢失、未回填。改为只有 cancelled 才算 interrupted；silenced 只停音频，文字和调用照常累积。绿：调用执行、回填、续答都在 turn 1，开口后的音频未播放。 |
| 规格 P3 无关 error 完全静默 | fixed | 写 Host 日志（info 级；cordis 默认导出级别会过滤 warn）。受控断言日志缓冲含该行。 |
| 标准 P3 命名 | fixed | 删除 `unidentified`；`Reply.cut` 改为 `silenced`；主管 `cuts` 改为 `notices`；client.js 的 `settle` 改为 `retire`。`cut` 只保留“播放被剪切”这一个含义（`Cut`、`hooks.cut`、`cutNotice`）。 |
| 标准 P3 Host 请求状态分散 | fixed | 新增命名谓词 `unstarted`，用于 started、speech、idle 与 error；重新计时抽成 `arm()`。没有改成显式状态机：`asked` 与 `next` 的含义不同，合并后改动面更大。 |
| 标准 P3 error 能否按 event_id 归属 | rejected | 探针中端点 error 只带服务端自己的 event_id，不引用客户端事件，无从对应。文档已写明。 |
| 标准 P3 排队的 create 遇开口是否多回复一次 | rejected（已核实） | 新探针 `protocol-07/queued-1.json`：排队请求不会被丢弃，会在用户说话时开始并完成。Nexus 只在连接空闲时发 create，request 会等活动回复、说话与未分配语句都结束，所以不会制造排队请求，也就不会重发。 |
| 标准 P3 voice/said 数据团块 | fixed | request 改为接收一个 `{ server, said }`。 |
| 标准 P3 真实打断用例复用启动/清理 | fixed | 真实用例改用 `controlledCall`（新增 `key` 选项），端点换成记录中继 `relay()`：双向原样转发，只记事件形状，不记音频和请求头。 |
| 协调者：项目名与会话工作区 | fixed（`bc2def0`） | 指引区分两者：要在某会话的工作区新建会话时，读 `nexus_list_sessions` 的 cwd。真实新建会话 3/3 passed，记录在 workspace-discovery。 |

新探针还发现一个未列入评审的竞态，一并修复：服务端 VAD 把一句话切成两段时，第一段在服务端开始回答前用户又开口，第一段不会单独得到回复。旧代码会把第二段的回复错记到第一段名下，第二段则一直等到超时。现在开口时，尚未开始回答的已提交语句直接结束、不带回复。受控 edge 用例覆盖：红时整通卡住，绿时 `folded: [3]`、VOICE-FOUR 记在 UTT-FOUR 名下。

### TDD 红绿

- 红（`.scratch/nexus-v1/fix07-red-voice.txt`，修复前代码 + 新断言，3 failed）：
  - 打断：线上找不到通知（P2-1）。
  - 交错：“reply 2 was generated before the tool continuation” 不成立（P2-2）。
  - edge：turn 1 被标 interrupted、工具调用丢失，随后整通卡住，“fourth reply” 超时。
  - 文字路径的红是初轮全量 `ticket07-npm-test-red-text.txt`（受控端点不发 created 时 14 failed）。
- 绿：
  - `fix07-green-voice.txt`：交错、edge passed，证据 `voice-interleave-1791626561892`、`voice-edge-1791626595086`。
  - `fix07-green-barge.txt`：打断 passed，证据 `voice-barge-1791626751461`；听到 2.7/7.2 s 与 3.3/8.0 s，日志行存在。

### 检查（最终代码）

```powershell
npm run typecheck; npm run build; git diff --check; npm test
# 真实（凭据只经临时包装进入子进程环境）
NEXUS_REAL_VOICE=1      node --test --test-name-pattern='accurate Realtime voice call' tests/voice.test.mjs
NEXUS_REAL_TEST=1       node --test --test-name-pattern='real DashScope text-only' tests/profile.test.mjs
NEXUS_REAL_TEST=1       node --test --test-name-pattern='real DashScope recalls' tests/restore.test.mjs
NEXUS_REAL_DELIVERY=1   node --test --test-name-pattern='accurate Realtime' tests/delivery.test.mjs
NEXUS_REAL_DISPATCH=1   node --test --test-name-pattern='accurate Realtime' tests/dispatch.test.mjs
NEXUS_REAL_STEERING=1   node --test --test-name-pattern='accurate Realtime' tests/steering.test.mjs
```

- typecheck、build 通过，`git diff --check` 无问题。
- 全量 `npm test`（`fix07-npm-test.txt`）：59 项，49 passed、0 failed、10 skipped（真实 opt-in 与 Desktop 冒烟），约 210 s，没有挂起。
- 真实语音（`fix07-real-voice.txt`）：4 passed。
  - 既有会话派活：`voice-real-1791626801728`。
  - 新建会话：`voice-real-create-1791626840054`。
  - 打断，间隔 7 s：`voice-real-barge-1791626867039`。长回复在生成中被取消，记录带 interrupted；通知“about 6.7 s of its 26.9 s”在 turn 2；问题答“一加一等于二。”。
  - 打断，间隔 2 s：`voice-real-barge-generating-1791626925099`。同样被取消；通知“about 1.7 s of its 6.1 s”；问题答“1加1等于2。”。
  - 两次打断都是 3 个 turn completed；通知在 `speech_started` 后 19 / 12 ms 送出，下一个回复约 3.5 s 后才开始。
- 真实文字（`fix07-real-text-*.txt`）：5/5 passed。
  - profile：`real-1791626796157`。
  - restore：`restore-real-1791626809458`。
  - delivery：`delivery-real-1791626834413`。
  - dispatch：`dispatch-real-1791626854457`。
  - steering：`steering-real-1791626878899`。
- 协调者指派（`bc2def0` 上）：真实新建会话 3/3 passed（`fix07-guidance-create-{1,2,3}.txt`）。
- 密钥扫描：本轮证据、输出与仓库共 303 个文件，0 命中（含 base64 形式）。

### 未决

- 原生 turn 序按输入身份，交错时与播放序不同。实际次序由 stream 块时间保留；是否接受这种 turn 结构，需用户裁定。
- 修复轮 1 代码下，“已生成完、播放中打断”的真实路径没有再出现（两次都在生成中被取消），只有受控证据。
- 物理扬声器外放、回声与 Desktop 实机通话，仍待用户实机验证。

## 票 08 前置整理

交接指定的 P3 已整理：交错回复先后改用受控响应序号，不以可能相同的毫秒戳判定；真实打断 7 秒间隔名称不再声称必然已生成完。Response.settledAt 标明结算时刻，消息映射使用原生消息类型。

拒绝项依据的原始协议探针现保存在 `tests/probes/voice-protocol.mjs`。凭据仅经临时子进程环境 `NEXUS_PROBE_KEY` 注入后，从仓库根执行 `node tests/probes/voice-protocol.mjs .scratch/nexus-v1/protocol-07/queued-rerun.json queuedBarge`；不打印凭据、不向文件写凭据。其它模式见脚本末尾。探针只记录协议事件与音频字节数，不记录音频或请求头。

按 2026-10-10 最新交接，用户已完成票 07 Desktop 实测，并接受原生 turn 按输入身份排列；以上历史未决保留为当时记录，不代替票 08 实机验证。
