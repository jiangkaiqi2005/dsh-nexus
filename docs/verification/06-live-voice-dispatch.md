# 票 06：实时通话期间持续调度工作会话验证

验证日期：2026-10-09。unitBase：`0d3ba0d`（票 05 评审头）。步骤 0 提交 `1cacbd4`：清理 `src/results.ts` 中不可达的 subagent 描述分支，并在 Spec、票 03 与验证 03 中记录 2026-10-09 用户裁定（Nexus 只管理对话会话）。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 profile。

平台：Windows 11（10.0.26200），Node `v24.15.0`，Playwright `1.64.0` 驱动已安装的 Microsoft Edge `154.0.4258.62` 无头模式（独立临时 user-data-dir）。

## 实现与原生边界

一次通话 = 一条 Typert Remote 流。客户端只采集和播放音频；模型连接、工具执行和原生记录都在 Host。

- **客户端**（`client.js`）：主管会话（`nexus-supervisor`）输入区上方的原生 `conversation.input.dock` 槽位显示通话条，有“接通语音/挂断”按钮和实际状态文字。点击后的顺序如下：
  1. 在点击中创建 24 kHz 播放 AudioContext。未进入 running 就显示“音频播放未就绪”。
  2. 请求麦克风。拒绝显示“麦克风权限被拒绝”，无设备显示“没有可用的麦克风”，其它错误显示“麦克风不可用”。
  3. 以上都就绪后才发起 `remote.nexusVoice.call()`，显示“正在接通…”。
  4. 只有 Host 送回 `live` 帧（模型已确认语音会话）才显示“已接通 Nexus”，并开始上送麦克风 PCM16 16 kHz（`ScriptProcessorNode`）。
  5. Host 送回的模型音频（PCM16 24 kHz）按序排入播放队列。

  通话条上有 `data-state`、`data-played-samples`、`data-sent-samples` 三个属性，供测试读取。客户端描述符（strict codec）由 `ctx.remote.$mount` 挂载；Host 端描述符在包导出 `./typert`（`typert.js`），由 Host typert-loader 注册，因此 Gateway 严格校验上行数据，不走 SRC 回退。
- **Host 端点**（`src/voice.ts`）：`VoiceController` 是 `TypertRemoteService`，提供 `@Remote({ mode: 'stream' }) call(signal)`。它的流程是：
  1. 先送 `connecting` 帧，再请主管 `startCall`。
  2. 模型确认后送 `live` 帧。
  3. 把上行音频转交模型，把模型音频与失败码（`state: failed` + code）作为下行帧送回。
  4. 客户端结束流（挂断、断开）时结束通话。

  控制器在主管可工作时挂接，先于主管停止而解除挂接。
- **主管**（`src/supervisor.ts`、`src/realtime.ts`）：
  - `startCall` 用同一个准确型号 `qwen3.8-omni-flash-realtime` 打开语音连接：`modalities: ['text','audio']`、`server_vad`、`pcm16` 输入、`pcm24` 输出、`input_audio_transcription`，与文字轮次相同的 nexus 工具和系统提示，再加通话指令。
  - 建连时重放既有原生上下文，但不触发回复。
  - 没有 STT/TTS 拼接、第二个文字主管或意图分类：模型直接听音频、说话、调用工具。
  - 服务端 VAD 每提交一段用户语音，就成为主管的一个原生 turn。主管等该段输入的转写（回复结束后再宽限 3 秒；无转写时写明“端点未返回转写”），把它作为 `kind: 'user'` 的 `user/message` 写入原生主会话，再把服务端已开始的回复记为 `assistant/message`。
  - 回复中的工具调用按原生工具执行，`function_call_output` 回到同一连接继续。
  - 通话期间，工作结果、用户输入同步、工具续答等 Host 发起的请求都走同一语音连接；这些请求等当前回复结束后再发，由模型决定是否开口（指令写明可以暂不告诉用户）。
  - 语音模式下单个回复失败只让该回复失败；连接失败结束通话并把失败码送到客户端。
  - 静默回复（模型选择不说话）记为 abandoned 的流帧，不生成空 assistant 消息。
  - 文字连接的指令文本与票 05 逐字节相同。

### 为后续票留下的接缝（未提前实现）

- 07（复杂打断）：客户端顺序排播，没有打断时清空播放队列的处理；服务端 VAD 的 `speech_started` 目前只是被忽略。
- 08（挂断）：挂断即结束 Remote 流；Host 关闭语音连接，后续轮次回到文字连接。挂断后的文字续行未专门验证。
- 09（自动接通）：只能手动接通。
- 10（断线、多客户端）：第二个客户端同时接通会得到 `CALL_BUSY`；没有重连。

## 验证

所有 Host 子进程都用独立的 `.scratch/nexus-v1/voice-*` 作为 DSH_HOME/DSH_AGENTS_HOME/profile，带 `--no-open`、`windowsHide: true`，经官方 dsh CLI、base + web-app composition 和真实原生会话运行。浏览器是无头 Edge 加独立临时 profile；麦克风一律用 Chromium 假采集设备（`--use-fake-device-for-media-stream`），没有打开物理麦克风。

语音输入是离线 Windows SAPI（Microsoft Huihui Desktop，16 kHz 单声道）合成的中文语句，与静音段拼成 wav（`tests/voice-audio.mjs`，缓存在 `.scratch/nexus-v1/voice-audio`），用 `--use-file-for-fake-audio-capture=<wav>%noloop` 送入真实浏览器采集链路。因此这是“真实客户端代码 + 合成音频输入”，**不是实机麦克风通话**。

工作会话 `docs` 是用户已有的普通对话会话（探针经 `sessionController.create` 创建）。它使用**受控 native WorkerAdapter**（`tests/voice-probe.js`）：第一步一直挂起，直到测试放行，然后回复 `Docs ready: DOC-READY-42`。这样可以确定地制造“工作执行期间继续交流”。

### 受控模型端点（真实 Host、真实客户端、合成音频）

`tests/voice.test.mjs` 第 1 项，证据 `.scratch/nexus-v1/voice-controlled-1791550087357`（PID 103676，含 `result.json` 原生日志、`wire.json` 模型线上事件、`output/voice-call.png`）。受控端点讲 DashScope Realtime 协议：它对 Host 实际转发的 PCM16 做能量 VAD，自行切分语句，再按真实事件序列回应（committed、输入转写、音频与转写增量、函数调用）。

| 断言 | 结果 |
| --- | --- |
| 打开 Nexus 不连接模型；点击接通后才连接 | 状态 `idle`、连接数 0 → `live`；`session.update` 为 `['text','audio']`、`server_vad`、`pcm16`，并带 `nexus_send_session` 等工具 |
| 采集音频到达模型 | 一个连接上收到约 17.9 秒的连续 16 kHz PCM16（断言下限 5 秒）；能量 VAD 从真实采集中切出恰好 2 段语句 |
| 语句 1 → 同模型调用调度工具，工作真实执行 | 原生日志同一 turn 内依次为用户转写 `UTT-ONE…`（`source.kind: user`）→ `tool/call nexus_send_session(docs)` → 成功的 `tool/result` → `DOC-DISPATCHED`；`function_call_output` 回到同一语音连接；docs 收到 `nexus-dispatch` 的 `DOC-TASK` 并进入 running |
| 工作执行期间继续交流 | docs 仍为 running、0 个 turn/end 时，语句 2 得到回复 `VOICE-SECOND`，且在独立 turn 中；该语句的转写晚于回复到达，仍正确归入本 turn |
| 客户端收到并排播模型音频 | 放行前 `data-played-samples` 至少为 2 段回复的样本数；结果回复后至少为 3 段 |
| 结果在通话中回流并被模型接收 | 放行后 `nexus-work-result`（DOC-READY-42）入主会话，并在同一语音连接上触发回复 `RESULT-HEARD`（回复内容由脚本模型决定，真实检查见下） |
| 挂断 | 状态回到 `idle`；全部主管 turn completed，所有 assistant 消息的模型为该准确型号 |

### 实际状态（受控端点，不连接模型）

`tests/voice.test.mjs` 第 2 项，证据 `.scratch/nexus-v1/voice-states-1791550111735`。

| 情况 | 方式 | 显示 |
| --- | --- | --- |
| 麦克风权限被拒 | **浏览器真实拒绝**：`--deny-permission-prompts` 加假设备，走 Chromium 自身的权限判定；不是操作系统首次许可弹窗 | “麦克风权限被拒绝 (NotAllowedError)” |
| 无设备 | **页内模拟**：init script 让 `getUserMedia` 抛 `NotFoundError` | “没有可用的麦克风 (NotFoundError)” |
| 播放未就绪 | **页内模拟**：AudioContext 一直为 suspended，`resume` 不结束 | “音频播放未就绪 (suspended)” |
| 以上三种 | — | 模型连接数 0 |
| 请求已发出但模型未确认 | 受控端点收下 `session.update`，但不回 `session.updated` | 3 秒后仍为“正在接通…”，不是“已接通”；没有上送任何采集音频；挂断回到 `idle`，模型连接随之关闭 |

这项检查还发现了一个真实界面缺陷：locale 服务不解析嵌套键，状态文字显示成 `state.xxx`。已改为扁平键（红→绿）。

### 真实模型（准确型号 `qwen3.8-omni-flash-realtime`，真实客户端，合成音频，受控 worker）

opt-in：`NEXUS_REAL_VOICE=1` 与临时 `NEXUS_VOICE_KEY`（可选 `NEXUS_REAL_ENDPOINT`）。凭据由临时包装脚本只读授权的 `C:\Users\25330\.qiyu\provider.json` top-level `apiKey`，只放入子进程环境和隔离 Host 原生 credentials 服务，不进入命令参数、profile、日志、文档或源码。运行后扫描证据目录、输出与仓库文件（75 个文件），未出现该密钥（含 base64 形式）。

运行 1 passed，证据 `.scratch/nexus-v1/voice-real-1791550015080`（PID 96808，`result.json`、`output/summary.json`、`output/voice-call.png`）。合成音频依次为：静音 5 秒、“请让现有的 docs 会话开始编写接口文档。”、静音 14 秒、“另外，一加一等于几？”、静音 90 秒。

1. 接通后状态为 `live`。模型返回的输入转写与合成语句逐字一致：“请让现有的 docs 会话开始编写接口文档。”“另外，一加一等于几？”，两条都以 `source.kind: user` 写入原生主会话。
2. turn 1：模型先 `nexus_list_sessions`，再 `nexus_send_session({"sessionId":"docs","text":"请开始编写接口文档。"})`，工具结果成功；然后说“已让 docs 会话开始编写接口文档。”docs 收到 `nexus-dispatch` 并开始执行。
3. turn 2：docs 仍为 running、尚无 turn/end 时，模型回答第二句：“1加1等于2。”此时客户端已排播 124800 个样本（约 5.2 秒）的真实模型音频。
4. 放行 docs 后，turn 3 收到 `nexus-work-result`（DOC-READY-42），模型自行选择开口：“接口文档已经准备好了，编号是 DOC-READY-42。”客户端累计排播 261120 个样本（约 10.9 秒）。
5. 挂断后为 `idle`。3 个主管 turn 全部 completed，全部 assistant 消息为该准确型号；docs 最终 turn completed。

同次改动后，真实文字路径回归 `tests/dispatch.test.mjs` 的 opt-in 真实调度：1 passed，证据 `.scratch/nexus-v1/dispatch-real-1791550153434`。

### 命令与结果

```powershell
npm run typecheck
npm run build
npm test
git diff --check
node --test --test-name-pattern='accurate Realtime voice' tests/voice.test.mjs   # NEXUS_REAL_VOICE=1 与临时 NEXUS_VOICE_KEY
node --test --test-name-pattern='accurate Realtime' tests/dispatch.test.mjs      # NEXUS_REAL_DISPATCH=1 与临时 NEXUS_DISPATCH_KEY
```

- typecheck、build 通过，`git diff --check` 无问题。
- 默认 `npm test` 共 40 项：34 passed、0 failed、6 skipped（6 项真实 opt-in，含本票新增的真实语音）。其它票的检查都未修改，均通过。
- 真实语音 1 passed；真实调度回归 1 passed。

## 验收对照

| 票 06 验收项 | 状态 | 依据 |
| --- | --- | --- |
| 原生主会话可手动接通；客户端采集与播放，Host 持有连接和工具执行，状态反映实际接通 | 满足（无头 Edge + 合成音频） | 主管会话通话条手动接通；模型密钥、连接与工具都只在 Host；`live` 只在模型确认后显示（受控未确认用例）。Desktop 外壳内未验证。 |
| 同一个准确型号直接理解语音、输出语音并调用调度工具，没有额外文字主管或意图分类器 | 满足（真实） | 真实运行中该型号直接转写、回答并调用 `nexus_send_session`；只有一个模型连接，没有 STT/TTS 链。 |
| 语音请求能启动既有或新建工作会话；执行期间用户仍可继续交流 | 满足（既有会话，真实）；新建未用语音单独验证 | 真实与受控都在 docs 执行中完成第二轮交流。语音新建会话（`nexus_create_session`）走同一工具路径，未单独演示。 |
| 结果在通话期间回流并被模型接收；是否开口由主管判断 | 满足（真实） | 结果作为原生 `nexus-work-result` 进入同一语音连接，模型自行开口；Host 不固定播报，指令允许暂不告诉用户。 |
| 用户转写、主管文字和工具事实进入既有原生主会话，保持消息与轮次关联 | 满足 | 每段语音一个原生 turn，依次为转写 → tool/call → tool/result → 回复；转写晚到仍归入正确 turn（受控）。 |
| 首次系统麦克风许可、无设备、播放未就绪显示实际状态，不把请求已发出当作成功 | 部分满足 | 拒绝为浏览器真实判定；无设备、播放未就绪为页内模拟；“已发出未确认”保持“正在接通”（受控）。操作系统首次许可弹窗与真实无设备环境未验证。 |
| 在实际客户端、麦克风和模型端点演示语音派活与执行期间继续交流 | 部分满足 | 真实模型端点 + 真实客户端代码（无头 Edge）已演示；输入为合成音频经假设备。按“完成证据”不以模拟音频替代实机结论：物理麦克风、扬声器与 Desktop 外壳的实机通话**未做**，需要用户在真实设备上验证。 |

## 未验证与边界

- 物理麦克风、扬声器、操作系统麦克风许可弹窗与 Desktop 外壳均未验证。全程没有 Computer Use，没有向用户 profile 安装，也没有打开物理麦克风。
- 扬声器外放时模型自身的声音可能被麦克风收入：采集请求了 `echoCancellation`，但实机效果未验证，打断语义属于票 07。
- 采集用 `ScriptProcessorNode`（已不推荐但各浏览器仍支持），没有 AudioWorklet。
- 工作会话是受控 native adapter。
- 真实运行中，turn 1 有两条无文字的 assistant 消息，分别对应两次工具调用的模型步。
- 挂断后转回文字续行、通话中断线、多客户端、自动接通与打断，留给票 07–10。
