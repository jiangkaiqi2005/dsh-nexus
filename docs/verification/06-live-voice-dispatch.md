# 票 06：实时通话期间持续调度工作会话验证

验证日期：2026-10-09。unitBase：`0d3ba0d`（票 05 评审头）。步骤 0 提交 `1cacbd4`：清理 `src/results.ts` 中不可达的 subagent 描述分支，并在 Spec、票 03 与验证 03 中记录 2026-10-09 用户裁定（Nexus 只管理对话会话）。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 profile。

平台：Windows 11（10.0.26200），Node `v24.15.0`，Playwright `1.64.0` 驱动已安装的 Microsoft Edge 无头模式（非持久化、独立临时 profile）。Edge 版本 `154.0.4258.62` 取自 Playwright 无头启动后的 `browser.version()`。

**偏离记录（违反总纲约束 3）**：实施初轮查版本时，曾直接运行一次 `msedge.exe --version`。该调用被转交到用户正在运行的 Edge 会话（输出提示“在现有浏览器会话中打开”）。此后没有再直接调用 `msedge.exe`，也没有以其它方式触达用户浏览器；所有浏览器操作都只经 Playwright 非持久化无头启动。

## 实现与原生边界

一次通话 = 一条 Typert Remote 流。客户端只采集和播放音频；模型连接、工具执行和原生记录都在 Host。

- **客户端**（`client.js`）：主管会话（`nexus-supervisor`）输入区上方的原生 `conversation.input.dock` 槽位显示通话条，有“接通语音/挂断”按钮和实际状态文字。点击后的顺序如下：
  1. 在点击中创建 24 kHz 播放 AudioContext。未进入 running 就显示“音频播放未就绪”。
  2. 请求麦克风。拒绝显示“麦克风权限被拒绝”，无设备显示“没有可用的麦克风”，其它错误显示“麦克风不可用”。
  3. 以上都就绪后才发起 `remote.nexusVoice.call()`，显示“正在接通…”。
  4. 只有 Host 送回 `live` 帧（模型已确认语音会话）才显示“已接通 Nexus”，并开始上送麦克风 PCM16 16 kHz（`ScriptProcessorNode`）。
  5. Host 送回的模型音频（PCM16 24 kHz）按序排入播放队列。

  每次接通是一次独立尝试，只释放它自己获得的资源：
  - 挂断（含请求麦克风期间的挂断）立即回到 `idle`，并释放该次已获得的播放、麦克风轨道与流；
  - 每个 await 之后检查自己是否仍是当前通话，已结束的尝试不再改变状态或资源；
  - 旧通话的流收尾不会影响新通话。

  通话条上有 `data-state`、`data-played-samples` 两个属性，供测试读取。客户端描述符（strict codec）由 `ctx.remote.$mount` 挂载；Host 端描述符在包导出 `./typert`（`typert.js`），由 Host typert-loader 注册，因此 Gateway 严格校验上行数据，不走 SRC 回退。两端的解析器校验完全相同：上行为 `{type:'audio', audio}`；下行为三种状态帧或音频帧；base64 音频以 1 MiB 为上限。
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
  - 服务端 VAD 每提交一段用户语音，就成为主管的一个原生 turn。主管等该段输入的转写（回复结束后再宽限 3 秒），把它作为 `kind: 'user'` 的 `user/message` 写入原生主会话，再把服务端已开始的回复记为 `assistant/message`。没有转写时分两种情况：
    - 模型已回答：记为 `nexus-voice` 来源的通知，写明“用户说了话但端点未返回转写”，不冒充用户原话；
    - 既无转写也无回答（例如挂断时）：不写记录、不开 turn。
  - 语音 turn 的原生 `system/message` 记录的是该语音连接在服务端实际持有的指令（通话指令加系统提示），不会先写一份文字指令。
  - 回复中的工具调用按原生工具执行，`function_call_output` 回到同一连接继续。
  - 通话期间，工作结果、用户输入同步、工具续答等 Host 发起的请求都走同一语音连接；这些请求等当前回复结束后再发，由模型决定是否开口（指令写明可以暂不告诉用户）。
  - 语音模式下单个回复失败只让该回复失败；连接失败结束通话并把失败码送到客户端。
  - Host 请求的期限从该请求真正发出时起算，不含等前一回复的时间。服务端已在生成的回复超时，只让该请求失败，回复仍挂在连接上，迟到事件按顺序消费；服务端始终没有开始响应，则视为连接不再应答，整通失败。
  - 挂断时，正在语音连接上等待回答的同一 step（工作结果、续答或已转写的语句）改在新的文字连接上继续，不丢弃已认领的结果。被打断的语音尝试留作原生 `assistant/attempt`。
  - Host 停止（插件停用）时，通话以 `UNAVAILABLE` 失败帧结束，客户端释放麦克风。
  - 静默回复（模型选择不说话）记为 abandoned 的流帧，不生成空 assistant 消息。
  - 文字连接的指令文本与票 05 逐字节相同。

### 为后续票留下的接缝（未提前实现）

- 07（复杂打断），已知风险：
  - 客户端顺序排播，打断时不清空播放队列；服务端 VAD 的 `speech_started` 目前被忽略。
  - Host 发出的 `response.create`（结果、续答）与服务端 VAD 自动发起的回复可能争用：Host 只在没有进行中的回复时才发请求，但两者几乎同时发生时，`current()` 按“有待确认的 Host 请求则先归它”归属回复，可能把用户语句的回复误归给 Host 请求。
  - 端点的 `error` 事件（`realtime.ts` 的 `RESPONSE_ERROR`）会让整通失败，没有按单个回复处理。
- 08（挂断）：
  - 已做的最小处理：挂断时语音连接上待答的 step 改在文字连接继续；未转写且未回答的语句不写记录；之后的新轮次走文字连接（受控用例验证）。
  - 仍留给 08：被打断的语音回答在文字里重答的措辞与去重；挂断时客户端尚未播完的音频直接丢弃；挂断后的文字续行策略。
- 09（自动接通）：只能手动接通。
- 10（断线、多客户端）：第二个客户端同时接通会得到 `CALL_BUSY`（单客户端限制属票 10 范围提前出现，评审认为可接受）；没有重连。

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
| 播放未就绪 | 修复轮 1 起为**浏览器真实判定**：`--autoplay-policy=document-user-activation-required`。先从已打开 Nexus 的 context 取出存储状态，在一个从未点击过的新 context 中打开；再由页面计时器按下接通按钮，按下时 `userActivation.hasBeenActive` 为 false（Playwright 的 evaluate 会带手势，因此在此之前不调用它）。Edge 的自动播放策略让 AudioContext 停在 suspended。初轮为页内模拟。 | “音频播放未就绪 (suspended)” |
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

- 初轮：typecheck、build 通过，`git diff --check` 无问题；默认 `npm test` 共 40 项，34 passed、0 failed、6 skipped；真实语音 1 passed；真实调度回归 1 passed。
- 修复轮 1 最终代码：typecheck、build 通过，`git diff --check` 无问题；默认 `npm test` 共 44 项，37 passed、0 failed、7 skipped（7 项真实 opt-in）；两项真实语音各 1 passed；真实调度回归 1 passed。详见文末修复轮 1。

## 验收对照

| 票 06 验收项 | 状态 | 依据 |
| --- | --- | --- |
| 原生主会话可手动接通；客户端采集与播放，Host 持有连接和工具执行，状态反映实际接通 | 满足（无头 Edge + 合成音频） | 主管会话通话条手动接通；模型密钥、连接与工具都只在 Host；`live` 只在模型确认后显示（受控未确认用例）。Desktop 外壳内未验证。 |
| 同一个准确型号直接理解语音、输出语音并调用调度工具，没有额外文字主管或意图分类器 | 满足（真实） | 真实运行中该型号直接转写、回答并调用 `nexus_send_session`；只有一个模型连接，没有 STT/TTS 链。 |
| 语音请求能启动既有或新建工作会话；执行期间用户仍可继续交流 | 满足（真实 + 受控） | 既有：真实与受控都在 docs 执行中完成第二轮交流。新建（修复轮 1）：受控用例中语音 → `nexus_create_session` 在指定工作区新建会话并执行完成；真实用例中模型听到合成语音后，自行先列会话、再在 docs 的工作区调用 `nexus_create_session`，新会话执行完成。真实模型在既有会话用例中有 2/5 次未调用派活工具却声称已派活，见修复轮 1。 |
| 结果在通话期间回流并被模型接收；是否开口由主管判断 | 满足（真实 + 受控） | 结果作为原生 `nexus-work-result` 进入同一语音连接，真实模型自行开口；受控用例中模型选择静默（空回复），主管只结束流帧为 abandoned，不写 assistant 消息，客户端不播放任何音频。Host 不固定播报。 |
| 用户转写、主管文字和工具事实进入既有原生主会话，保持消息与轮次关联 | 满足 | 每段语音一个原生 turn，依次为转写 → tool/call → tool/result → 回复；转写晚到仍归入正确 turn（受控）。 |
| 首次系统麦克风许可、无设备、播放未就绪显示实际状态，不把请求已发出当作成功 | 部分满足 | 拒绝与播放未就绪（修复轮 1 起）为浏览器真实判定；无设备仍为页内模拟（无头浏览器不用假设备就会落到物理麦克风，不允许）；“已发出未确认”保持“正在接通”（受控）。请求麦克风期间挂断不会接通（修复轮 1）。操作系统首次许可弹窗与真实无设备环境未验证。 |
| 在实际客户端、麦克风和模型端点演示语音派活与执行期间继续交流 | 部分满足 | 真实模型端点 + 真实客户端代码（无头 Edge）已演示；输入为合成音频经假设备。按“完成证据”不以模拟音频替代实机结论：物理麦克风、扬声器与 Desktop 外壳的实机通话**未做**，需要用户在真实设备上验证。 |

## 未验证与边界

- 物理麦克风、扬声器、操作系统麦克风许可弹窗与 Desktop 外壳均未验证。全程没有 Computer Use，没有向用户 profile 安装，也没有打开物理麦克风。
- 扬声器外放时模型自身的声音可能被麦克风收入：采集请求了 `echoCancellation`，但实机效果未验证，打断语义属于票 07。
- 采集用 `ScriptProcessorNode`（已不推荐但各浏览器仍支持），没有 AudioWorklet。
- 工作会话是受控 native adapter。
- 真实运行中，turn 1 有两条无文字的 assistant 消息，分别对应两次工具调用的模型步。
- 挂断后的完整续行策略、通话中断线、多客户端、自动接通与打断，留给票 07–10（已知风险见“接缝”）。

## 修复轮 1

评审基线 `18e43cb`（两轴 changes_requested），unitBase `0d3ba0d`。

先写能复现的失败测试，再修复。实际红灯：
- 挂断竞态的第一半：请求麦克风期间挂断，旧代码仍变为 `live`；
- 语音 turn 先写文字指令；
- 挂断时未转写、未回答的语句产生错误 turn；
- Host 停止时客户端最后记录的状态仍为 `live`（对照旧 supervisor 运行）；
- 状态文字的嵌套 locale 键（初轮已修）。

### 处置

| 项 | 处置 | 依据 |
| --- | --- | --- |
| P2 挂断竞态 | fixed | `client.js` 改为每次接通一个尝试令牌：每个 await 后检查；挂断释放该次已获得的轨道、流与上下文；旧循环只释放自己的资源，并且只在仍是当前通话时改状态。用例“voice call races”：延迟首个 `getUserMedia` 1.5 秒期间挂断 → 3 秒后仍 `idle`、模型连接 0、该轨道 `ended`（旧代码红）；挂断后一个任务内再接通 → 新通话保持 `live`，持续上送音频，状态序列中没有旧通话残留的 `failed`，最终各轨道 `ended`。“旧循环关掉新通话”这一半，用界面点击（含同页一任务内连点）在旧代码上**无法复现红灯**：旧流在挂断后的微任务内就已收尾。修复从构造上消除了这种依赖，用例作为回归保护保留。顺带删除了只在重渲染时才刷新、因而会过时的 `data-sent-samples` 属性；上送量改由受控端点按连接计数。 |
| P2 证据诚实 | fixed | 文首补记 `msedge.exe --version` 偏离；版本号改取 Playwright `browser.version()`。 |
| P2 语音新建会话 | fixed | 受控用例“voice call creates a new work session…”：语音 → `nexus_create_session(cwd=隔离工作区)` → 新会话收到 `nexus-dispatch` 的 NEW-TASK 并 completed。真实用例：模型自行 `nexus_list_sessions` → `nexus_create_session(cwd=docs 的工作区)`，新会话执行完成，结果回流后模型汇报；最终运行 1 passed。 |
| P3 规格3 静默结果 | fixed（补测） | 同一受控用例：结果到达后脚本模型回空响应；结果 turn 中没有 assistant 消息，turn completed，客户端排播样本数不变。该路径初轮已存在，此为新增覆盖，不是红灯。 |
| P3 规格4 播放未就绪真实判定 | fixed | 见上文“实际状态”表：Edge 自动播放策略加无手势计时器启动。 |
| P3 规格5 指令记录 | fixed | 语音 turn 的首个 `system/message` 用通话指令；服务端已开始的语音回复记录连接实际持有的指令（`RealtimeConnection.instructions` 为最后一次 `session.update` 的内容）。受控断言：语音 turn 内所有 `system/message` 都是通话指令，最后一条等于该连接 `session.update` 的 instructions（旧代码红）。 |
| P3 规格6 挂断后文字轮次与 08 风险 | fixed（最小）+ 记录 | 挂断时，仍在语音连接上等待回答的 step 改在新文字连接上继续：受控用例中结果请求被挂起时挂断，同一 turn 内留下语音 `assistant/attempt`，再由文字连接（`modalities ['text']`）答出 RESULT-HEARD，turn completed。未转写且未回答的语句不写记录、不开 turn（旧代码红：留下 1 个错误 turn）。挂断后键入的文字由新的纯文字连接回答。其余风险见“接缝 08”。 |
| P3 规格7 07 风险 | 记录 | 见“接缝 07”：`response.create` 与服务端 VAD 争用；端点 `error` 使整通失败。 |
| P3 标准3 解析器一致 | fixed | `client.js` 与 `typert.js` 使用相同的上行、下行解析器与 1 MiB 上限。 |
| P3 标准4 语音超时 | fixed | 期限在等待前一回复之后才开始。服务端已在生成的回复超时只让该请求失败；服务端从未开始响应才判整通失败（与 `done()` 的“单个回复失败不断通话”一致）。没有实际超时用例：受控端点无法廉价制造服务端生成中途卡住，按代码审读处置。 |
| P3 标准5 Host 停止 | fixed | `stop()` 经通话自身的 `end('UNAVAILABLE')` 结束，把失败码送到客户端。主管会话随之不可用，通话条卸载，所以用例用页内状态记录与轨道观察：状态最终为 `failed:UNAVAILABLE`，麦克风轨道 `ended`。临时把 supervisor 换回旧版对照，最后记录的状态为 `live`。 |
| P3 标准6 判断题 | 部分采纳 | 无转写占位不再以 `kind:'user'` 写入（见规格6），改为 `nexus-voice` 通知或不写；通话记录的重复对象字面量合并为 `Call` 接口；HEAD/TAIL 加注释说明是两种指令共用的两半，未改名；`receive(event: any)` 保留：事件是外部协议 JSON，各字段在使用处逐一校验。 |
| P3 规格8 CALL_BUSY | 记录 | 见“接缝 10”。 |

### 验证（修复轮 1 最终代码）

受控用例（均为真实 Host + 无头 Edge + 假采集设备；证据取自最终 `npm test`）：

- 通话主流程：`.scratch/nexus-v1/voice-controlled-1791553191970`。
- 实际状态：`voice-states-1791553215753`，其中拒绝与播放未就绪为浏览器真实判定，无设备为页内模拟。
- 挂断竞态：“voice call races”。用页内包装延迟首个 `getUserMedia`，属受控注入。
- 语音新建、静默结果、挂断后文字：`voice-create-1791553249270`。
- 挂断不留无声语句、待答结果转文字、Host 停止：`voice-hangup-1791553261838`。

真实模型（准确型号，合成音频经假设备，受控 worker）。本轮全部运行如下：

| 用例 | 运行 | 结果 |
| --- | --- | --- |
| 既有会话派活 + 继续交流 + 结果回流 | `voice-real-1791552374213` | failed：模型列出会话后**未调用** `nexus_send_session`，却回答“docs 会话已经启动”（截图为证；原生记录因 Host 被终止未落盘） |
| 同上 | `voice-real-1791552656479`（PID 87356） | failed：同样未调用派活工具却声称已启动（原生记录 `output/failure-events.json`） |
| 同上 | `voice-real-1791552778831`（PID 96640） | passed |
| 同上（最终代码） | `voice-real-1791553298181`（PID 41656） | passed。第一句转写缺了开头（“会话开始，编写接口文档。”），模型仍正确派活 docs；第二句“1+1”在 docs 运行中作答；结果回流后模型开口；排播 193920 样本。 |
| 语音新建会话 | `voice-real-create-1791552469948` | failed：测试等待条件写错（要求结果单独成一个 turn）。原生记录未落盘；此前“新会话运行中”的状态检查已通过，说明新会话已创建并在执行。 |
| 同上 | `voice-real-create-1791552816351`（PID 104416） | failed：同一等待条件问题。原生记录显示模型行为正确：先列会话，再在 docs 工作区 `nexus_create_session`；新会话执行完成；结果在同一 turn 内被吸收并汇报。随后修正等待条件，行为断言未改。 |
| 同上 | `voice-real-create-1791552984447`（PID 60592） | passed |
| 同上（最终代码） | `voice-real-create-1791553335061`（PID 102328） | passed |

真实调度回归（文字路径）：`dispatch-real-1791553364687`（PID 99416）passed。扫描本轮全部真实证据目录、运行输出与仓库文件（229 个文件），未出现密钥。

### 未决

- **真实模型虚报派活**：既有会话用例中，准确型号在 5 次真实运行里有 2 次没有调用 `nexus_send_session`，却对用户说已经启动。Host 记录如实：没有 tool/call，docs 没有执行。本轮没有改指令或断言去迁就；是否通过指令约束（例如“未调用工具不得声称已派活”）需要另行决定。
- 挂断竞态“旧循环关掉新通话”一半无法在旧代码上复现红灯，见处置表。
- 标准4 的超时语义没有运行时用例。
- 物理麦克风、扬声器、操作系统许可弹窗与 Desktop 外壳仍未验证。
