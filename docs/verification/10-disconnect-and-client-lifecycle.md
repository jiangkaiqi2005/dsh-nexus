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
