# 票 10：断线与客户端生命周期验证

2026-10-10，按本次明确授权实施票 10；票据原先的 draft / 本轮不执行文字由本次授权取代。实施基点为 `77be008a6564c93eb5ea177560a809afaa43068d`，前置票 08 / 09 已由用户验收。本票不扩展票 11，没有推送、PR、打包安装或发布，也没有操作用户现用 Desktop / profile。

## 行为与边界

主管从原生输入、工具结果与工作结果重建同一个准确型号的连接。一次请求遇到断线或超时，先保留失败的 assistant attempt 与中断通知，再进行一次有界重建；仍失败则原生轮次以 error 结束，保留输入和未执行的调用事实。没有将连接失败记为 completed，也没有另一个文字主管或重启后自动续跑。

模型尚未完成的 response 所携带的工具调用不执行；迟到的旧 response 身份不能复活它。已完成的工具继续运行，连接重建不取消它；同 call_id 再次出现时复用原生结果，不重复执行，也不制造第二个悬空的原生调用。模型确认过的语音输入保留已收到的转写；没有转写的已提交音频只记“文字不可得”的事实，不编造用户原话。

仍在通话的模型传输失败会显示正在接通并尝试一次恢复，沿用当前媒体端，不重新申请麦克风；恢复失败或超时如实显示失败并释放媒体。恢复期间主动挂断、页面刷新或关闭取消这份通话所有权，迟到的握手不能改回 live。客户端关闭后 Host 继续在原主会话完成文字工作。连接失去最终播放报告时记录播放量未知，不假定整段声音已经听到。

Host 在客户端打开采集或播放前预留唯一媒体所有权；第二客户端直接收到 CALL_BUSY，不创建第二条采集或播放链路。媒体准备失败、取消和实际客户端断开释放预留，旧客户端关闭后另一页面可以手动接通。隐藏页面不触发挂断；退出 Harness 则沿用既有停止、原生持久化与中断恢复。

最高验证边界是隔离的官方 `dsh --profile nexus-voice --port 0 --no-open` 加载实际插件、真实 headless Edge 客户端及原生会话落盘。模型为本地受控 Realtime WebSocket，使用 fixture 凭据；媒体是 Chromium 假设备、离线合成语音及真实 Web Audio。未读取真实凭据或调用付费模型。可控端点通过不等于真实 DashScope 断线、物理麦克风 / 扬声器或 Desktop 隐藏窗口实机验收。

证据保存在忽略目录 `.scratch/nexus-v1/`，每个 `voice-disconnect-*` 目录保留 `wire.json`、`result.json`、原生 sessions 及失败截图。音频只记录字节量，Host URL token 已脱敏；不随提交发布。Host / 浏览器 / 模型端点均由测试拥有并清理。

## 逐项验证

| 要求 | 实际观察与断言 | 限制 |
| --- | --- | --- |
| 已收到文字与未结束工具事实保留 | 端点先收 TEXT-BEFORE-DISCONNECT，再发部分回答及 unfinished-call 并关闭 socket；重建上下文含原文字和 not executed 通知，原生只记一份原输入，保存失败 attempt 和实际续答，没有执行该工具。 | 受控实际 socket close。 |
| 迟到事件不复活调用 | 新连接注入旧 broken-text 身份的文字、工具参数及 completed；没有 LATE-NOT-A-REPLY 主管消息或工具执行。 | 验证按旧 response 身份丢弃；已关闭 WS 本身不能再传输报文。 |
| 失败不冒充完成 | 重建请求也断开时只尝试两条连接，原生 error 终态，两个 unexecuted 身份均保留，没有 assistant/message 或 tool/call。 | 不承诺永久在线或无限重试。 |
| 工具在途断线与完成去重 | fixture_slow_lookup 在第一条语音连接执行时实际断线；客户端 connecting → live，麦克风只申请一份。工具放行后模型重复 stable-lookup，收到旧结果；原生只有一份 call 与 result，随后实际文字/语音续答并成功落盘。 | 工具为可控 native capability，不冒称实际外部业务执行。 |
| 语音输入不可得的事实 | 已 committed、尚未收到完整回答的语音断线；有转写时以 user 来源保留，没有转写时以 nexus-voice 记录 words are unavailable，重建模型收到相应内容。无 ASR / response 的 committed 超时也进入失败收束、释放媒体并文字续行，保留已接收输入事实。 | 原始音频未重传，不承诺恢复服务端遗失的 ASR。 |
| 恢复期间挂断与刷新 | 第二条模型握手延迟 2 s，实际客户端先进入 connecting，再挂断或 reload；迟到握手之后仍 idle、无播放、无新采集，后续输入实际完成 text-only 续答。 | 页面刷新相当于释放该媒体客户端，不自动恢复麦克风。 |
| 关闭页面后后台文字与重新进入 | 语音实际派活 docs，第二页面拨号得到 CALL_BUSY 且采集数为 0；关闭旧浏览器 context 后放行工作，Host 自动形成 RESULT-HEARD 和一份工作结果原生记录。第二页面手动接通重放 DOC-READY-42。 | worker 为受控 native adapter；没有操作用户的 Desktop。 |
| 焦点离开与真正退出 | 第二页面置前时原页面仍 live；既有 Host 停止与新进程原生恢复测试检查释放媒体、interrupted 记录和重启闲置。 | 前台切换证明焦点离开没有触发挂断，未断言页面实际 visibilityState 为 hidden；物理 Desktop 的隐藏、托盘及操作系统退出仍未验证。 |

## 检查与证据

红测试 `ticket10-red-text.txt` 在旧实现下等待 same turn recovered 超时，确实复现原轮错误终结。初次红/绿进程在断言完成后没有退出，原因是新增测试误用 WebSocketServer 不存在的 listening 属性而未关闭监听器；修正该测试清理并只清理自有测试进程后，`ticket10-green-text-final.txt` 正常 exit 0。未将进程残留当作产品缺陷。

`ticket10-disconnect-first.txt` 的 5 项为 3 passed / 2 failed：一个是真实的原生记录缺口（重复 assistant 工具调用虽跳过执行，但 step/end 悬空，不能落盘恢复），另一个是 helper 没有传 browser 的观察错误。前者修正为只复用完成结果、不再追加重复调用；后者修正测试参数。失败证据保留，没有改记通过。测试失败时也会放行其拥有的 worker / tool，再执行持久化和所有权清理。

`ticket10-disconnect-second.txt`：5 passed / 0 failed，43.4 s，正常 exit 0；相应证据包括 `voice-disconnect-text-1791638772588`、`voice-disconnect-tool-1791638778558`、`voice-disconnect-hangup-1791638785907`、`voice-disconnect-reload-1791638794176`、`voice-disconnect-client-close-1791638802642`。随后补强了迟到身份、带文字的重复工具调用、连续失败与语音输入中断的断言，最终检查见后续记录。

语音单文件初轮 `ticket10-voice-final.txt`：27 项，17 passed / 5 failed / 5 skipped，323.3 s。五项失败都来自新增“播放量未知”通知在显式挂断后的 Remote 最终清理里重复记录，影响票 08 的通知数量断言。修正为只有仍持有当前通话所有权才进行最终挂断与断线通知；没有放宽原断言。修复后相关最高边界 `ticket10-focused-final.txt`：13 passed / 0 failed，106.0 s，正常 exit 0；包括全部 8 项本票行为与这 5 项原有回归。该轮原生工具去重证据是 `voice-disconnect-tool-1791639342988`，连续失败证据是 `voice-disconnect-unavailable-1791639350119`，有/无转写证据是 `voice-disconnect-speech-{true-1791639373242,false-1791639382628}`。

`npm run typecheck` 与 `npm run build` 通过，日志为 `ticket10-typecheck.txt` / `ticket10-build.txt`。最后的 test helper 清理变更去掉错误的 server.listening 判定；即使 Host 就绪失败，也会关闭本测试拥有的模型监听器。完整套件使用该最终版本。

全量中的既有 `official Host new-process restore` 五例 normal / reload / race / interrupt / active-exit 均实际通过，检查原生中断收束、工具中断修复不重复和新进程闲置，不把页面重新挂载冒充 Host 重启。`test Host cleanup` 五例 close / readiness-failure / root-exit / root-exit-success / root-exit-inherited-pipes 也通过，检查仅回收测试进程树，包括就绪失败和继承管道。

全量初轮 `ticket10-npm-test.txt`：81 项，70 passed / 0 failed / 11 skipped，351.1 s，正常 exit 0。提交前补查独立的 committed 超时路径：`ticket10-red-commit-timeout.txt` 确实复现“已收音频提交、但没有 ASR / response”后只移除等待项，主管没有输入记录也不续答。它不是 socket close，前面的语音断线测试没有覆盖；没有把旧全量通过直接转记为修复后的版本通过。最小修复将这一计时器统一进入连接失败收束，保留不可转写输入的事实，既有主动挂断未听输入仍不产生记录。

补充修复后 `npm run typecheck` / `npm run build` 通过（`ticket10-typecheck-final.txt` / `ticket10-build-final.txt`）。`ticket10-commit-timeout-final.txt`：5 passed / 0 failed，69.6 s，正常 exit 0；包括三种语音输入中断、主动挂断不留未听输入和 stalled response。新增超时证据为 `voice-disconnect-speech-timeout-1791639991198`；客户端实际显示 failed / TIMEOUT、全部采集 tracks ended，主管在第二条 text-only 连接收到不可转写事实并完成同轮续答。

最终版本全量 `ticket10-npm-test-final.txt`：82 项，71 passed / 0 failed / 11 skipped，364.6 s，正常 exit 0；包含本票全部 9 项新增行为回归、票 08 / 09 的既有行为、原生进程恢复及测试进程清理。11 项 skipped 是套件既有的 10 项真实端点与 1 项 Desktop 显式启用验证，没有将它们计作通过。最终断线工具证据为 `voice-disconnect-tool-1791640071068`，无 ASR 超时证据为 `voice-disconnect-speech-timeout-1791640123128`，客户端关闭证据为 `voice-disconnect-client-close-1791640135186`。

```powershell
npm run typecheck
npm run build
node --test tests/voice.test.mjs
node --test --test-name-pattern='disconnect recovery|disconnect lifecycle|disconnect failure|hangup playback accounting|hangup idle playback' tests/voice.test.mjs
node --test --test-name-pattern='committed speech|whose response stalls|keeps no unheard utterance' tests/voice.test.mjs
npm test
git diff --check
```

本票不把可控端点或浏览器假设备升级为真实型号、物理设备、Desktop 或干净安装通过。真实端点重连、物理 Desktop 隐藏 / 退出和媒体实机验收仍需后续执行；票 11 的完整首版安装验收不在本票范围。用户既有 package 两文件的版本改动保留且不提交。

## 修复轮 1：评审处置与 Desktop 待验收

原实施提交为 `dc60f3326cca230bc75ca49c28264e4da934f1e3`；原 unitBase 不变。

| 评审意见 | 独立核实与处置 | 状态 |
| --- | --- | --- |
| 标准轴 P3：client.js 新增行比同级代码多缩进两空格，违反匹配既有风格 | 确认 ready 解码、媒体预留与帧遍历的新增行多缩进；只删除这些行多出的空格。忽略空白的差分为空，未改变行为。 | fixed，待原评审者复审。 |
| 规格轴 P2：Desktop 实际隐藏 / 退出尚无实机证据 | 确认票据第 16 行要求该边界。焦点切换与 bundled CLI 的测试均不能替代 Electron 窗口隐藏，本轮未运行实际 shell，没有新增实机通过证据。以下记录环境与待用户步骤。 | 未决，需用户实机验收；票 10 的该验收项仍未完成，不能据此记整体规格 approve。 |

隔离能力调查：本机已安装 `D:/DeepSeekHarness/DeepSeek Harness.exe`，安装包 metadata 为 `0.2.0-rc.2`。按 computer-use 技能初始化 `@oai/sky` 并只读取应用清单，返回 `com.deepseek.dsh`、isRunning=false、windows=[]；没有可复用的隔离窗口。现有 `tests/desktop.test.mjs` 使用隔离 DSH_HOME / DSH_AGENTS_HOME、Desktop 自带 `dsh.cmd` 与 headless Edge，其边界是官方 CLI 和 Web 原生输入，不启动 Electron shell。

读取安装包 `resources/app.asar/lib/main.js` 的实际文件，不依赖仓库旧源码推断安装行为：`resolveDesktopPaths` 由 DSH_HOME 决定 profiles/desktop，但 shell 的快捷键和 background-close-confirmed 使用 `app.getPath("userData")`，packaged 启动还调用 `app.setAsDefaultProtocolClient("dsh")`。本应用代码没有发现显式覆盖 userData 或禁用这项协议注册的隔离验证入口。DSH_HOME 本身不足以证明整个 shell 状态隔离；本轮也没有验证通用 Electron 命令行开关能同时覆盖这些行为。因此停止在只读调查，不猜参数启动窗口，不访问用户 profile / 会话 / 凭据，不修改协议、现用 Desktop 或系统设置。安装 shell 文件的只读副本与调查摘要留在忽略目录 `ticket10-desktop-shell-inspection.js` / `ticket10-desktop-isolation.txt`。这表示安全隔离启动条件尚未证实，不表示 Windows UI 控制不可用或产品存在已证明的代码错误。

待用户实机验收的最短步骤（在用户自行选择的 Desktop 环境执行，记录状态与任务标记即可，不提交凭据）：

1. 确认加载包含本票的 Nexus，关闭自动语音选项以独立观察重启行为；手动接通并派发一个足以观察的工作，记下主会话与任务标记。
2. 用 Desktop 窗口关闭按钮隐藏到托盘，确认进程仍运行；由托盘重新显示，核对仍是同一主管、通话与任务，工作结果进入该主会话，隐藏没有被当成退出 Harness。记录实际采集 / 播放状态。
3. 在 Host 仍运行时关闭单独的 Web 语音页面，核对该页面采集 / 播放结束而工作继续，重新进入能看到同一任务结果，只有手动操作才再接通；这一项已有受控官方 Host 证据，实机记录便于与 Desktop 隐藏比较。
4. 新派发一个在途任务，通过 Harness 的真正“退出”操作结束进程；重新启动并进入原主会话，核对原生记录和中断状态，主管保持闲置，没有重跑该任务。与步骤 2 的隐藏区别分别记录。

本轮仅缩进与证据文档修改：`node --check client.js`、`git diff --exit-code -w -- client.js`、`git diff --check` 均通过；未重跑不受行为变更影响的全量，前述 82 项全量仍是原实施提交的实际结果。

## 最终工作流归档

票 10 实施已提交，自验通过；本轮工作流为通过 0、需人工关注 1，修复轮数 1。未启动票 11。

- unitBase：`77be008a6564c93eb5ea177560a809afaa43068d`。
- 原实施提交：`dc60f3326cca230bc75ca49c28264e4da934f1e3`。
- 双轴复审产品快照：`80909c7df92d6b9f39f4d854f81ebace5d808bb4`。

| 复审轴 | 最终结论 | 未关闭项与后续 |
| --- | --- | --- |
| 标准轴 | approve，0 项未关闭 | 原 P3 缩进 fixed 已获复审认可。 |
| 规格轴 | changes_requested | 原 P2 Desktop 真实隐藏 / 真正退出的实机证据仍未决；无新增代码问题，其余规格保持通过。待补实机证据后复审该项。 |

独立复审确认修复轮 1 的调查事实、有限判断和四步用户验收准确；当前无需进一步产品修复。该实机验收仍未完成，不能将实施自验通过或标准轴 approve 转记为整体规格通过。准入条件与环境限制见上节处置表。

协调与复审没有重跑全量，采用实施阶段实际最终结果：`npm test` 82 项、71 passed / 0 failed / 11 skipped，`npm run typecheck` 和 `npm run build` 通过。修复轮仅执行客户端语法、忽略空白差分及差异检查，没有行为变更。本次仅归档复审结果，不是新修复轮，不改变上述复审产品快照；用户 package 两文件的版本改动继续保留且不提交。

## 用户实机验收后的 Web 语音派活诊断（仍未解决）

用户在安装后明确反馈“Desktop 测试全部通过”，旧 Desktop 隐藏 / 真正退出实机 P2 可据用户本轮验收关闭，待双轴复审认可。来源为用户实际操作反馈，不是本代理新增的 Desktop UI 证据。随后用户反馈 Web 的语音派活失败，并授权读取 `C:/Users/25330/Desktop/dsh-session-nexus-supervisor/session.v4.jsonl`；又说明 Desktop 当时秒发，询问 Web 是否等待不足。新的 Web 问题未解决，不能将前面的历史归档结论或 Desktop 通过升级为本轮整体通过；没有启动票 11。

按 diagnosing-bugs 先建立捕获记录断言。只提取该日志近轮次的必要事实，没有复制完整历史或读取凭据：turn 35 用户要求派一个三十秒任务，主管说“这就派”；turn 36 承认尚未派并说去建会话；turn 37 再说“这就去派，稍等”。三个 turn/end 都是 completed，三个轮次合计 tool/call 为 0，故“已有实际派活”的断言失败。较早 turn 34 是 Desktop 的两分钟任务，确有 nexus_create_session 及 accepted=true / completed=false 的原生收据，只用于邻近对照，不当作 Web 失败轮通过证据。

这里的 completed 是模型轮次结束，不是任务完成或派活收据。无工具的语音响应结束后，主管仅会因原生 next-step 输入、后续用户语音或真实工作结果继续，没有为该空承诺另设后台延迟派活或定时重试入口。等待更久不会为已终结的这三个轮次自动生成未发生的派活；本轮没有用固定等待时间作修复。

在改动前列出并逐项探测的假设：

| 假设与可证伪预测 | 实际证据与结论 |
| --- | --- |
| 模型只口头承诺，没有选择派活工具；应能观察到工具齐备却无收据 | 授权日志的失败 header 有 nexus_create_session / nexus_send_session 等工具，保留的 voice 指令已含先调用再报告的约束；原生日志确无调用。失败轮没有原始 WS 捕获，因此不能据 native 日志单独断言服务端从未发任何函数事件。 |
| 通话实际配置与当前 header 不同；应能看到工具或指令缺失 | 当前原生 system/message 保留的是 live voice 指令且含派活约束；隔离受控通话的 session.update 含派活工具。用户失败连接的原始 session.update 没有捕获，精确连接差异仍未证实。 |
| 插件漏处理语音函数事件；应在 raw WS 有函数而 native 无调用 | 受控最高边界语音派活通过；下述真实探测的 raw function_call_arguments.done 与 native tool/call 身份一致，通用解析遗漏未复现。不能把它升级为原失败轮的原始 WS 证据。 |
| 已派出的 worker 因配置或凭据失败；应先有该任务的真实派活收据 | 35–37 没有 create/send 的调用或收据，不能把未调用工具归因到 worker。没有猜测、修改 Web worker 凭据或 preset。 |
| Web 安装包不同；应有关键文件 hash 差异 | 当前 Web 安装的 dist/index.js、client.js、typert.js 与本地构建 hash 均相同；顺序试改撤回并重建后再核对仍相同。 |

代码图优先查询 dsh-nexus 与 E-Agent-dsh-nexus 的 src dispatch 符号均无结果，记录覆盖不足后才读本地源码。宿主接口使用当前 node_modules 的精确 rc.2，未将历史 nexus-harness-reference 当作安装版本事实。

受控回归 `node --test --test-name-pattern='voice call: client audio reaches the Host-held model' tests/voice.test.mjs`：1 passed / 0 failed，24.1 s，exit 0；日志 `ticket10-web-dispatch-controlled-check.txt`，证据 `voice-controlled-1791644661086`。它证明标准函数事件确实能在官方 Host 派活、执行、接收结果，不能单独修复真实模型不派活。

真实诊断使用隔离官方 Host、实际 Edge 客户端、离线合成中文语音及受控 native worker。仅让 rc.2 credentials-local 的受支持 path 配置引用既有 managed store，watch=false；Host 内 describe(DASHSCOPE_API_KEY) 只报告 configured=true，Nexus 仍在内部 resolve。没有输出、保存或复制 key，没有把 key 放入环境文件 / 脚本 / WS 请求记录；relay 只记录必要协议形状、工具身份和文字，不记录鉴权头或音频。没有向用户正在使用的会话发诊断任务，也没有停止、换包或修改其运行中的 Host。诊断装置和记录明确放在忽略目录 `.scratch/nexus-v1/ticket10-web-dispatch-*`，自有 Host、浏览器、relay 由原生测试清理回收。

| 真实对照 / 装置检查 | 结果与范围 |
| --- | --- |
| 三十秒请求加“只等待、不改文件” | `ticket10-web-dispatch-live-first.txt`：1 failed，21.3 s，exit 1。模型选择 pwsh，raw 与 native 调用身份一致，但没有会话派活收据；原生错误为 SetNamedSecurityInfoW / Win32 5。这是近邻失败，不是用户 0-tool 空承诺的精确复现，未据此修改权限或产品。 |
| 用户原话“你派一个持续三十秒的任务。” | `ticket10-web-dispatch-live-exact.txt`：1 failed，16.9 s，exit 1。仍实际调用 pwsh，0 会话派活收据，随后报告上述权限失败；原话的目标断言红，但与原日志的函数缺失形态不同。 |
| 只重放授权的两段近轮次空承诺，再正常恢复 | 重载版本等待 live 超时；改为激活前使用原生 writer 后，先遇到 fixture 漏声明 sessions 注入，再因 fixture 未 ready 超时。`ticket10-web-dispatch-live-replayed*.txt` 为装置失败，未作为模型或产品失败证明；恢复历史与空承诺的因果没有证实，停止该方向。 |
| 只交换通用 native prompt 与 Nexus 职责的顺序 | 原顺序在 Nexus 之后追加约 5.9 KB coding-agent 指令，构成有限的路由假设。仅两行交换顺序、保留所有指令和能力后，`ticket10-web-dispatch-order-first.txt` 仍 1 failed，46.0 s，exit 1：job_list → pwsh，0 会话派活收据。顺序假设未获改善证据，立即撤回两行并重建，未留作修复。 |
| 只加强共享主管默认分工 | 通用 native prompt 把主管称为 coding agent，并说明自己管理后台 job；以此为依据，只在共享职责补充普通任务（含等待任务）默认交给会话、获得投递收据后再结束回复，缺目标先查询或询问，保留用户明确要求亲自执行的优先权与全部工具。没有移除通用 prompt。`ticket10-web-dispatch-role-first.txt`：1 failed / 0 passed，49.9 s，exit 1；实际选择 subagent 两次后 pwsh，raw 与 native 身份一致，仍 0 会话投递收据，文字中还出现“已派发”。未获改善，按限定候选试验撤回这一行；首轮没有绿色收据，不再运行第二轮。 |

两次产品候选均已全部撤回，源码没有保留行为修改；顺序候选撤回后核对安装产物 hash 相同，职责候选撤回后再构建与核对。`npm run build` 在候选构建及撤回后均 exit 0（`ticket10-web-dispatch-order-build.txt` / `ticket10-web-dispatch-order-reverted-build.txt` / `ticket10-web-dispatch-role-build.txt` / `ticket10-web-dispatch-role-reverted-build.txt`）。本轮没有已验证的产品修复，也没有修改提示词后宣称派活恢复，没有引入 Host 意图分类、按承诺强制派活、删除工具、独立存储或多主管。没有重跑与无行为改动无关的完整 suite，原 82 项通过记录仍是原实施时点事实。

诊断停止时的结论：Web 真实语音未实际派出任务的问题仍未解决；受控执行通路可用，真实模型采样会选择其他工具，而用户的“0 工具、空承诺”在隔离恢复装置中尚未稳定复现。有限对照只证明改变指令顺序和增补默认分工这两个候选没有得到改善，不能推出所有角色提示改动均不可行，也未证明通用角色一定是根因。后续诊断原需原 Web 连接的有界原始 WS 形状证据（不含鉴权、音频或无关私聊），或在可控的实际请求上下文中验证模型行为改善；停止时保留未决，没有宣称等待、worker 凭据或提示顺序已解决问题。用户 package 两文件版本改动继续保留，不提交。最终用户裁定和关闭状态见下节。

## 最终用户验收与关闭（2026-10-10）

用户后续判定此前 Web 不派活属于模型自身行为，提供实际派活后的页面截图，并继续进行多页面验收。该判定来自用户反馈，不是本轮已证明根因或代码修复的结论；没有保留或安装前述失败候选。

多页面操作中，用户曾观察到旧页面 Nexus 入口暂时消失，刷新后恢复；第二页尝试接通显示“通话失败（CALL_BUSY）”。该错误码表示已有页面占用通话。用户最后确认“第一页挂断第二页接通了”，通话占用释放和手动接通通过。任务在语音断开后继续执行，也符合 Host 保持文字工作的边界。页面入口暂时消失这一观察保留为验收过程事实，本轮没有证明其原因或实施修复；用户随后明确接受本票，不继续调查。

最终授权原话：“第一页挂断第二页接通了，现在全部通过了，10票收掉了，网络那个我不测”。据此记录票 10 已完成并由用户验收关闭，原 Desktop 实机验收未决项由用户先前“桌面的测试全部通过了”及本次最终确认收束。这是用户验收结论，没有新的独立双轴复审或代理 Desktop UI 测试。

真实网络断线及恢复的实机测试按用户决定未执行，不记录为通过；保留原实施的受控断线、迟到事件、工具去重与恢复测试结果。关闭时没有新产品变更，因此未重跑既有全量。本次只更新验收记录与票据状态，没有启动票 11、12 或 13。

## 接手诊断：用原会话上下文复现 Web 空承诺（2026-10-10，Claude）

**结论：现象是真的，但不是 Web 端或票 10 代码缺陷。** 根因是 `qwen3.8-omni-flash-realtime` 的语音回复会随机只说“这就派”、不发出函数调用；Host 如实记录了模型的输出。Desktop 配置同样会失败，用户看到的“Desktop 秒发、Web 不发”与概率差异相符，不能证明 Web 特有缺陷。

**方法。** 前次隔离试验用的是空白会话，模型改用 pwsh，与原日志不是同一种失败。本轮直接复现原失败上下文：读取授权日志的原生 surface（user/assistant/tool result，截至 seq 463 即 turn 34 结束，共 129 项），连同 turn 35 的真实 `request/header` 工具和 turn 35 实际 system message（即该通话连接所持指令），用当前构建（与安装版 hash 相同）的 `dist/realtime.js` 中 `RealtimeConnection.open()` 原样重放到真实 DashScope 语音连接，然后发送离线合成的“你派一个持续三十秒的任务。”音频，由服务端 VAD 自动开口。key 由脚本在内存中从既有凭据文件读取，不输出不落盘。装置及证据：`.scratch/nexus-v1/ticket10-web-dispatch-replay/`（`replay.mjs`、各批次 txt/json）。

| 上下文 / 配置 | 派活（create/send 调用）| 失败形态 |
| --- | --- | --- |
| turn 35 上下文 + Web 工具与指令（seq 467） | 12/17 | 4 次“行，我这就派个三十秒的任务过去”类空承诺，1 次答非所问；全部 0 函数调用 |
| 同一上下文 + Desktop 工具与指令（seq 453，多 `load_workspace_dependencies`、GUI 端口不同） | 17/18 | 1 次“好嘞，这就给你派个30秒的任务。稍等片刻，马上搞定！”，0 函数调用 |
| turn 37 上下文（历史已含两次空承诺）+ Web 配置，“你怎么不动啊 你去派呀” | 5/10 | 5 次“我这就去派，别急”类空承诺 |

失败轮的 raw WS 中，`response.done.output` 只有 `message`，没有 `function_call` item，也没有 `function_call_arguments` 事件，所以不是 Host 漏解析或丢失调用。Web 与 Desktop 两次 header 对比：工具 schema 只差 `load_workspace_dependencies`，指令只差 Web GUI 端口，其余逐字相同。Web 5/17 对 Desktop 1/18 的差异不显著（Fisher 单侧约 0.09）。

**已排除的修复方向。**

- 历史中的工具调用改为真实 `function_call` / `function_call_output` item 回放：DashScope 对每个输出返回 `Unknown function call id`，不接受客户端补建的调用 item，现有文本回放是协议约束。
- 只改提示词：在语音指令末尾增加“同一回复内先调用，不得预告派活”（`cand-a.txt`）后，首问达到 19/20，但两次空承诺后的上下文仍为 5/10，并出现虚假的“派了，已经发出去了”。另一种措辞（`cand-d.txt`，还声明先前空承诺无效）反而降到 2/10。去掉通用 coding-agent prompt、只留 cand-a 为 8/10，样本太小无法定论，而且会改变原生能力上下文。提示词调整波动大，不能保证效果。
- 注：`replay-482-478-full-1791647211*.json` 两份是装置失误：合成音频在问号处停顿，VAD 切成两句，结果无效，已用无停顿音频重跑。

**需要用户裁定的方向。** 票 10 代码里没有能修复此现象的缺陷。可靠的缓解要么是需要评测回归的提示词调整（概率性改善，无法保证），要么是超出当前 spec 的结构性机制，例如 Host 识别“承诺却无调用”后追加文字步骤、改由文字连接决策派活、或使用 tool_choice。交接已列明这些需先获规格确认，因此本轮没有进入实施，也没有修改代码或安装。

**用户裁定（2026-10-10）：** 用户接受这是模型自身的限制，作为已知问题记录。不调整提示词，不增加 Host 补派机制，票 10 不因此保留未决项。更换或更新模型后，可以用上述重放装置重新测量。
