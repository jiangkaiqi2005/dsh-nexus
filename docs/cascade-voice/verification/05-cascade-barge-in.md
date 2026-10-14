# 票 05 验证记录

本票基线：`e03c44f0ec6edeb5e4e11925650e708c51454e14`。范围是级联通话中点按插话、句子粒度播放反馈、录音期间暂缓播放；完整安装与生命周期验收留给票 06。

## 实现

客户端点“开始录音”时同步停止播放节点，随控制帧回报每条回复累计实际播放的 PCM samples，不等待 Host 往返。播放完成节点与仍在播放的部分节点都计入账目。Host 保留已经完成合成但仍排队播放的回复，按回报取消被插话回复的合成、清理其尾音，不取消主管模型或已经发出的工具。

供应商的 `result-generated/sentence-end`、`payload.output.original_text`（与 `sentence` 同级）与真实累计 PCM 边界用于匹配 Nexus 交付的完整句。供应商进一步拆句、多个 binary 帧不被当成多个完整 Nexus 句子；只计真实全部播完的整句，不按时长均分或字符长度猜测。一次插话即使涉及多个排队回复，也只产生一条 `nexus-voice/form=notice` 原生记录，按播放顺序列出已听整句。它不是用户的新要求，不单独唤醒一轮；主管的下一次原生请求会看到记录，ASR 新发言仍沿票 04 的原生 user/steer 交付。字段位置依据 [阿里云官方服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-server-events) 的 sentence-end 示例，初版错误与修复证据见下文。

录音门由 Host 的录音生命周期控制。录音期间的新 PCM 在 Host 排队，结束录音、空录音、识别失败或 60 秒自动结束都会释放播放门；按原次序下发，合成失败仍只清理该回复。挂断和断线丢弃全部缓冲。每次插话只取消客户端已经见到的回复；客户端本地开始与 Host 收到控制帧之间到达的未知新回复 PCM 暂存，在结束录音后先于 Host 后续缓存播放，避免传输延迟让新回复永久消失。结束按钮立即停采集，但独立的客户端播放门继续保持到 Host 确认识别/未听清状态，防止后包先于早先缓存播放。旧回复 ID 的晚 PCM 被丢弃，不恢复被打断尾音。

新增字段仅用于级联播放账目，Host/客户端 Typert 严格同步接受 `start-recording.playback`、`played.replyId` 和 `hangup.playback`。Realtime 不带 ID 的协议、播放样本口径、VAD 与主管轮次行为保留。

## 验收边界与证据

`tests/cascade-barge.test.mjs` 使用隔离官方 Harness Host、原生主会话与真实 Edge；默认模型、HTTP ASR 和 WS TTS 是外部受控端点，没有替换主管、录音或播放内部实现。九项通过条件为：

- 将 start 控制帧留在传输中，浏览器所有待播节点已经停止；只报告实际完整播完的第一句，供应商拆出的半句不计入。合成已结束的待播音频也能截断；重新注入旧 PCM 晚包不会播放。
- 主管已经执行原生工具时插话，TTS 收到取消，但真实工具仍返回成功且结果进入下一步原生消息；ASR 的 `STEER-NEW` 按 user 来源进入同一回合，主管下一步输出 `STEER-APPLIED`。
- 多个已经合成完成的回复仍在客户端积压，一次插话只写一条 notice，排队但没听到的回复不冒充已听句子。
- 模型仍在流式生成时插话，合成尾音停止，原生 assistant 仍完整保留后续文字，回合正常完成。
- 录音期间工具完成、主管生成新的两句：客户端下行没有新 PCM，结束录音后两句 marker 按 `2001, 2002` 原序播放，合计恰为 12,000 samples；下一次空录音不重播。
- 空 ASR 仍释放上述缓冲，不增加原生用户回合。
- 挂断与客户端刷新均丢弃上述缓存，不再向旧通话下发。
- 浏览器公开 `AudioContext.suspend()` 停止采集后仍不点结束：Host 在 59–65 秒内自动结束录音，空 ASR 后释放同样的两句缓冲，证明墙钟上限有效。
- 延迟 Host 的 start 控制帧，让新回复先经过实际下行传输：客户端录音时不播放，Host 不将这个未知新回复取消，结束后完整恢复 12,000 samples。

各隔离目录保留脱敏 Host 日志、官方原生持久化报告与截图。已目视 `05-barge-1791998379403/barge-empty-asr.png`：主会话保留完整回复文字，浮动通话条显示“已接通 Nexus · 没听清”、开始录音与挂断。测试框架也检查 Host 测试凭据没有出现在客户端下行。

## 红绿与检查

证据均在本地 `.scratch/cascade-voice/`，未提交本地日志、索引或隔离 profile。

- `05-red-local.log`、早期 `05-green-local.log` 的失败是等待 Host URL 公告、空 stdout，并非有效行为红例。已读 diagnosing-bugs，单变量核对 launcher：`node --version` 与官方 CLI `--version` 正常，直接 Host 已 Listen 且写出 ui-ready，但 URL 公告仍等待 loader settled。没有足够证据定位原因，不将其等同于旧 Windows 原生退出，也不声称修复。
- `05-diagnostic-tap.log`：既有票 04 首例原样通过，12.144 秒；`05-diagnostic-spoken.log`：既有票 03 首句用例原样通过，5.747 秒。后续完整串行集合继续保留原样 spoken 验收。
- `05-red-baseline.log`：通过 `git show e03c44f:client.js` 构建隔离基线 bundle，保留当前工作区；同一官方 Host/浏览器边界在“All pending playback stops without Host roundtrip”行为断言红，6.411 秒。这是有效旧行为反例，而非初稿前第一次运行已经命中行为红例的声明。
- `05-green-local.log`：新实现同一用例通过，6.589 秒。
- `05-green-barge.log`：工具/steer、缓存、空 ASR、真实 Host 60 秒、挂断与断线共六项通过，103.306 秒。
- `05-green-boundaries.log`：跨回复单 notice、仍生成的模型不取消共两项通过，12.851 秒。
- `05-green-final-short.log`：冻结前最终本地立即停止/晚包、跨回复、模型流、在途新回复四项通过，24.828 秒；在途例 5.854 秒，没有通过等待 TTS 超时释放队列来满足条件。
- `05-red-end-transport.log`：只读检查提出结束按钮与 Host 结束确认之间可能乱序的可证伪假设。先停止旧快照完整集合，再保持产品未修改，用传输控制帧和下行帧闸门验证：结束控制帧仍未到 Host，后到 PCM 已使 scheduled 从 84,000 增至 90,000，行为断言红，5.825 秒。修复是客户端的独立播放门持续到 Host 结束确认，未修改录音上限、服务超时或断言。
- `05-green-end-transport.log`：同一结束在途反例修复后通过，6.125 秒；最终完整集合还核对跨开始/结束边界延迟的 PCM markers 仍为 `2001, 2002`。

源码和测试重新冻结后，`npm run typecheck`、`npm run build`、`node --check client.js`、`node --check typert.js`、`node --check tests/cascade-barge.test.mjs` 与 `git diff --check` 通过。保持已有 `npm test` 精确串行入口：`node --test --test-concurrency=1 tests/*.test.mjs`。

旧快照的 `05-full-suite.log` 已通过本票九项、旧票 02–04、归档与部分既有压缩回归，但为验证新发现的结束在途竞态主动终止，只是 partial，不能作为最终全集通过。终止后检查没有本票拥有的 Host 残留，未终止无关 MCP/用户进程，也没有并行运行两个 Host 测试。

上述修复完成并再次冻结后运行 `npm test`，`05-final-full-suite.log` 实际为 135 项、120 通过、14 默认跳过、1 失败，1084.121 秒。本票九项、票 01–04 和其他 Realtime 行为通过；唯一失败是既有 `tests/voice.test.mjs:862` 快速挂断重接用例的 `timeout waiting for second live call`，68.033 秒。旧控件 `previousControlConnected=false`；fixture 当时不保存失败 DOM，现存官方 status 只有主管/工作会话 idle、零输入/零回合，不能据此猜测 CALL_BUSY 或归因于旧并发异常。该次完整集合没有通过，必须保留这个结论。

串行原样隔离 `node --test --test-name-pattern='voice call races' tests/voice.test.mjs` 通过，11.143 秒，日志 `05-races-isolated.log`。随后仅在 ignored scratch 的诊断副本增加原有 public 界面的账目/DOM/截图捕获，保留同一用例的全部原断言和超时，再次通过，11.376 秒，日志 `05-races-diagnostic.log`。`05-races-diagnostic-native.json` 保存第二次 live 的精确状态历史、媒体 tracks 为 ended/ended/live、受控端点两次连接/一次关闭、新连接持续音频上行；DOM/截图可复核。Remote listener 附加较晚，trace 是空的，不是 owner 释放或传输先后已确认的证据。两个成功样本不能证明首次全量失败的原因，未据此修改产品、旧断言或超时，也不拿单例通过替代完整门槛。

基于这两次新增隔离证据，对同一冻结产品/测试再次执行一次完整精确 `npm test`，`05-final-full-recheck.log` 实际为 135 项、120 通过、14 默认跳过、1 失败，1108.894 秒。原快速重接 races 此次原样通过，11.168 秒；唯一失败是 `several-flushes-pending` 在 `tests/voice.test.mjs:1724` 等待 `supervisor idle && audible > 0` 的“first batch playing”，66.516 秒，尚未走到挂断或重接。没有第三次对无变化版本做全量重复，也没有把 `model.responses=[]` 误读为没有连接。

### 原回归的瞬态窗口诊断与最小测试修复

实际失败目录 `voice-hangup-several-flushes-pending-1792001269902/output/failure.png` 显示已接通、INPUT-1、BATCH-1 与正常完成用时 2 秒；`failure-events.json` 的 native turn/start 为 1792001275844，assistant/message 为 1792001275854，turn/end 为 1792001278103，即该回合耗时 2.259 秒，提供方 PCM 只有 1 秒。问题假设是音频自然结束早于主管 idle，从而测试永远等不到两个条件同时为真。

仅在 ignored scratch 的外部 Harness 插件公开 `agent/turn-stopping` listener 加 2 秒延迟、外部 WebSocket 音频传输加 250 毫秒延迟，保持原测试断言及超时，建立可证伪复现。`05-window-natural.log` 在相同 first batch playing 断言 red，65.132 秒。实际公开音频节点账目 `05-window-public.json` 中 scheduledAt=1792001811461、native endedAt=1792001812462，duration=1，未调用 stop；`05-window-observations.json` 依次记录 running/audible=1、running/audible=0、idle/audible=0，从未出现 idle/audible=1。通话保持 live。这个受控复现证明 1 秒节点已自然结束，不能归因于插话、owner 释放、重接或播放丢包。

修复只在原 `tests/voice.test.mjs` 账户用例：先确认实际音频开始，立即用公开 `AudioContext.suspend()` 真正暂停硬件时钟，确认真时钟未到节点尾；再保留原 0.2 秒账目边界，等待主管 idle **且本批次 ends>=1**，确认 native node 没有 onended。不是只移动 getter，让已经结束的节点看起来仍在播放；也不是将初始 idle 误当成本批结束。原来的 notice 数量、0.2/0/0 或 0.2/0.3 账目、逐批一次重放、挂断/重接及全部超时完整保留。Nexus 的 Realtime runtime 没有改变。

同 2 秒 native 停止 listener 与 250 毫秒外部音频延迟下，`05-window-green.log` 同例 green，14.943 秒。原样四个账户与已有 races 的集中检查 `05-accounts-green.log` 共五项通过，38.239 秒。同时只为已有实际失败的 races catch 补 public DOM/状态/媒体 tracks/受控连接账目诊断与截图，成功路径、原断言及超时未变；首次 races 原因仍未知，不将账户窗口修复说成 races 根因修复。

修复完成后再次通过 typecheck/build、client/typert/两份测试的语法检查及 diff-check，重新冻结产品和测试。修复后的真实完整 `npm test` 日志 `05-final-fixed-full.log`：**135 项、121 通过、14 显式默认跳过、0 失败，1036.076 秒，exit 0**。本票九项、原 races（11.489 秒）、修复后的四个账户和其余完整 native/Realtime 集合均通过；several-flushes-pending 为 6.804 秒。没有减少集合、放宽超时或省略原 notice/重放断言。最终全量开始后没有再改变产品、测试行为或断言，结束后只填验证记录，并按 staged diff 检查去掉新测试文件末尾的一行空白；最终 staged/unstaged diff-check 均通过，不重复已经通过的行为门槛。

Graph 在本轮已经两次返回 `Transport closed`，按已确认工具故障 fallback 阅读已定位源码，未通过反复重试假定索引已更新。本票未调用真实付费语音端点、读取真实 key、修改生产 profile、推送、创建 PR 或发布。受控端点与真实浏览器证据不代表物理麦克风、真实模型或最终安装验收。票 04 已记录的默认并发 Windows Host 退出/重接异常根因仍未知。

## 双轴评审

固定 unitBase：`e03c44f0ec6edeb5e4e11925650e708c51454e14`；初评 reviewHead：`811ea3430b158c7091e7c2e81ec2ed5c44fd92fe`。协调者在冻结提交上启动 standards_05 / spec_05 恰好两个独立只读评审。

| 初评轴 | 结果 | 处置 |
| --- | --- | --- |
| 仓库标准 | approve，issues: [] | 确认协议有效/无效帧边界、测试窗口修复没有削弱原验收，并保留历史 races 未知原因限制。 |
| 票据与 Spec | changes_requested，1 项 P1 | 官方 sentence-end 的 original_text 字段位置错误，影响实际已听整句；第 1 轮修复，尚待同两轴复审。 |

### 第 1 轮：官方 sentence-end 字段位置

原问题：初版读取 `payload.output.sentence.original_text`，barge/spoken 受控元信息夹具也把文本放在相同错误位置，初版验证记录跟随这个错误。真实官方 shape 是 `payload.output.original_text`，与包含 index/words 的 sentence 同级。Spec 评审用真实 loopback WS 对照发现：两句各 1000 samples、played=1000 时，官方字段得到 heard=[]，错误嵌套夹具却能得到第一句。这是已确认的 P1，而非可以豁免的真实端点验收限制；之前 135 项全绿只证明错误夹具下的实现，不证明实际官方协议的已听句子识别正确。

处置：**fixed**。先仅纠正外部受控 TTS 事件的官方位置，补齐 sentence.index/words、句首原文、句末 usage，并保证每次 sentence-synthesis 后紧接一帧 binary；保留供应商进一步拆句、多 binary、已经完成合成但仍排队、跨 reply 单 notice 和所有原断言。没有先改 parser，也没有增加错误格式 fallback。

- `05-r1-red-official-metadata.log`：在原产品 parser 上运行已有官方 Host/真实浏览器首用例，7.016 秒有效 red。实际 notice 为 `Complete sentences heard: (none)`，原“第一句。”完整 heard 断言失败；本地即停与运输控制已经经过真实流程。
- 随后 runtime 仅一行改为读取 `payload.output.original_text`；不推断旧字段、不改任何播放/录音时间门槛。
- `05-r1-focused-official-metadata.log`：修复后完整 barge + spoken 两文件串行检查，14 项、13 通过、1 真实端点默认跳过、0 失败，150.904 秒；供应商再拆句、多 binary、跨 reply、完整已听第一句及既有失败隔离均保留并通过。

typecheck/build、两份 fixture 语法和 diff-check 通过；修复后重新冻结并实际运行完整 `npm test`，`05-r1-full.log`：**135 项、121 通过、14 默认跳过、0 失败，1036.068 秒，exit 0**。所有原断言保留，races 为 11.132 秒，several-flushes-pending 为 6.675 秒。最终全集开始后没有再改 runtime/fixture、断言或超时，结束后只补真实统计与源提交记录。

第 1 轮修复代码 SHA：`0798595f01e8c1dea957201885796ea4751d63cc`（基于初评 `811ea3430b158c7091e7c2e81ec2ed5c44fd92fe`，仅 source 字段与两份相关 TTS fixture）。这个 P1 的 fixed 判断依据是官方字段核查、未改 parser 的有效红及最小修复后的官方形状 green/完整集合，尚待原 standards_05 / spec_05 对修复后的固定 reviewHead 复审；实施代理自验不是复审批准。真实付费端点/物理实机、历史 races 原因和 Windows 并发原生退出限制继续保留，未修改生产配置、读取真实 key 或提前开始票 06。
