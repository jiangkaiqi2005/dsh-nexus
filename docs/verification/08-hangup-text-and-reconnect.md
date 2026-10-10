# 票 08：挂断、文字续行与手动再接通验证

2026-10-10，按本次明确实施授权执行票 08；票据中原先的 draft / 本轮不执行描述由本次授权取代。固定实施起点为 `b5cd8acfcb85f5a17798b17ec6f2c18b90db1769`。交接指定的票 07 P3 整理先独立提交为 `7915574`，证据与协议探针复跑方式见票 07 验证记录末尾。

## 实现与验证边界

挂断先停止客户端采集和全部播放节点，清空队列，并上报最后实际播放的样本数。Remote 流保持到 Host 消费这一报告后再结束，避免先 dispose 丢失剪切通知；客户端已经退出的旧流不再调度任何音频节点。Host 取消在途模型回复、关闭旧语音连接，把该步骤及后续工作结果继续交给原主管的文字连接。session.update 与每次 response.create 均明确指定 `['text']`。工作会话和已执行中的工具继续，不因挂断重跑。

尚未写入原生 turn 的播放通知保留在主管队列中，立即手动再接通也会补入新连接；下一原生 turn 将其记入正常记录。已写入旧服务端上下文的通知仍在这份待记队列中，重接通不依赖旧服务端连接。再接通重放原生交流、工具与任务结果。切换会话和组件卸载会挂断，重新挂载、刷新和回到主管不会自动采集。

最高验证边界是后台隔离的官方 DSH Host、实际插件与原生记录，加非持久化 headless Playwright 客户端。音频输入为 Windows SAPI 合成语音，经假采集设备与真实 Web Audio 队列；没有操作用户 Desktop、浏览器或持久化 profile。Host 使用 `--no-open`、隔离 DSH_HOME / DSH_AGENTS_HOME 与已有所有权清理。真实端点为 DashScope Realtime，唯一型号始终为 `qwen3.8-omni-flash-realtime`。假媒体通过不等于物理麦克风、扬声器、回声或 Desktop 实机通过。

以下证据位于本地忽略目录 `.scratch/nexus-v1/`，不随仓库提交。每个 Host 目录保留 `wire.json`、`result.json`、原生 sessions 及输出；真实输入的音频内容不写入协议日志，请求头和凭据不记录。

## 逐项验收

| 验收项 | 自动化证据与结论 | 覆盖限制 |
| --- | --- | --- |
| 正常通话、生成中及播放中挂断，立即停采集、播放并清队列 | `voice-hangup-generating-1791630762935` 与 `voice-hangup-playing-1791630778691`：所有采集 tracks ended、audible nodes 为 0、等待旧迟到包后节点数不增加、上行字节数不再增长；生成中 wire 有 response.cancel。前者通知约听到 0.4 / 1.2 s，后者约 0.1 / 16.0 s。正常回应的真实挂断见下文第 6 次。 | 生成中/已生成完的精确时机以可控端点覆盖；真实第 6 次未声称覆盖长语音生成中的所有取消时机。 |
| 挂断后只生成文字，旧音频不能播放 | 上述两例的所有文字连接 session 和 response.created modalities 均为 `['text']`，没有 response.audio.*，不是只静音；旧连接的延迟音频不增播放节点。真实第 6 次挂断后的 conn 3 / 4 同样满足。 | 端点默认 session.created 仍可声明 text+audio；验收从 session.update 及 acknowledgement 后的实际回复判定，默认声明不算新音频生成。 |
| worker 继续、结果回主管并实际执行文字工具和续答 | 两受控例在挂断后放行 docs，得到 RESULT-HEARD，随后 fixture_slow_lookup 真正执行并返回 TOOL-CONTINUED；docs 原生 turn completed。真实 conn 3 因工作结果执行 nexus_read_session 并按同 call_id 回填，再文字报告 DOC-READY-42；conn 4 处理用户后续文字查阅。 | worker 是可控的官方 Host 测试 agent，主管则用真实型号。没有将模型口头“已派活”作为工具成功证据。 |
| 同原主会话、同准确型号，无第二文字主管 | 原生 result.events 中的语音输入、剪切通知、工作结果、tool/call、tool/result 与文字回复均属同一个主管会话，assistant source.model 均为准确型号，最终 turn/end 均 completed。 | 本票仅普通工作会话；不扩展 subagent 范围。 |
| 手动再接通保留目标、必要交流与任务事实 | 两受控例新连接 replay 包含 UTT-ONE、DOC-READY-42、TOOL-RESULT-77 与没听到后半段的通知。真实 conn 5 replay 包含接口文档目标、DOC-READY-42 及剪切通知。 | 真实再接通证明必要事实确实发给模型；不要求模型使用固定措辞复述，亦不以合成媒体替代物理对话验收。 |
| 挂断、切会话、刷新、重新挂载不自动采集 | 两受控例挂断后新建会话、回 Nexus、reload 后仍 idle，没有新 voice connection，也没有新采集 track，只有再次点击接通才重新采集。`voice-call-races` 既有测试覆盖申请麦克风期间挂断与快速重启。 | 本票不实现票 09 自动接通。 |
| 重复挂断、工具在途、未送达通知及快速重接通不丢事实 | `voice-hangup-tool-1791630793237`：慢工具在途时挂断立即手动接通，结果到新连接，原生只有 1 个 call 和 1 个成功 result，不重执行。`voice-hangup-idle-notice-1791630804120`：已完成原生回复但 16 s 播放队列未播完，挂断后立即重接通先看到尚未归属新 turn 的通知；再次挂断后文字 turn 只记 1 条通知。 | 票 10 已知 TIMEOUT 后认领结果恢复问题不在本票修复范围；这里验证主动挂断的成功路径。 |

## 真实端点记录

共执行 6 次本票真实检查。前五次保留失败与诊断，不把观察错误或模型虚报改写为完整通过。

1. `voice-real-hangup-1791629493422`，`ticket08-real-hangup-1-failed.txt`：较长合成派活语句被 VAD 拆成两段；第一段被合并、第二段触发读取未开始的 docs，等待实际派活超时。没有证明完整挂断链路。
2. `voice-real-hangup-1791629705248`，`ticket08-real-hangup-2-observation.txt`：短语句实际派活，挂断后的文字工作结果与报告已有原生证据；relay item 文本截断在 400 字符，观察层等待 DOC 标记失败，未到后续工具与重接通检查。修正观察字段至 4000 字符，没有改变产品断言。
3. `voice-real-hangup-1791629894490`，`ticket08-real-hangup-3-summary.txt`：核心链路已有证据，包含挂断后文字读取工具、成功原 call_id 回填、文字续答、无输出音频与手动重放。完整测试仍失败：host.finish 卸载了 CallBar，测试随后读取已卸载元素超时。把最终客户端状态读取放到 finish 前；该次记为核心事实有证据、完整测试观察失败。
4. `voice-real-hangup-1791630093820`，`ticket08-real-hangup-4-false-dispatch.txt`：准确 ASR 下模型只 list，没有 send，却口头声称派活；等待 worker running 超时。这是票 07 已记录的模型虚报局限。
5. `voice-real-hangup-1791630321002`，`ticket08-real-hangup-5-false-dispatch.txt`：明确工具指令的合成语音仍有转写误差，模型识别 docs 后同样 list、口头声称派活却没有 send，等待超时。没有继续循环语音输入追求全绿，也没有放宽实际工具断言。
6. `voice-real-hangup-1791630674442`，`ticket08-real-hangup.txt`：1 passed / 0 failed，44.5 s。聚焦票 08，将前置派活改为原主会话同型号的文字请求，等工具实际成功、worker running 与主管 idle 后再手动接通。用既有短合成问题“另外，一加一等于几？”验证正常语音回应，再挂断、放行结果、文字工具闭环、手动再接通。本次名称明确为 text-dispatched work；不声称此次通过了语音派活。

第 6 次连接与协议边界如下：

| 连接 | 用途与实际协议 |
| --- | --- |
| 1 | 前置文字派活；session / response text-only，实际 nexus_send_session 成功，docs 保持运行。summary 中前 3 个 read 属于这里，不能算挂断后工具验证。 |
| 2 | 手动语音接通；text+audio，合成问题原生转写正确，回应“一加一等于二。”有输出音频。挂断后 client idle、tracks ended、audible 为 0。 |
| 3 | 挂断后自动接收工作结果；session.update 及 acknowledgement 为 text-only，3 次 response.created 均 text-only，0 条 response.audio.*。DOC-READY-42 入上下文后模型实际调用 nexus_read_session，call_id=`call_9b6cbadc25b4450fbf6dc45a`，wire 与原生均有成功回填，再文字报告最终标记。 |
| 4 | 用户挂断后的后续文字查阅；session / 两次 response text-only，0 条 response.audio.*。实际 nexus_read_session，call_id=`call_1efa484bb9004f99a85db239`，同 call_id 成功回填与文字续答。 |
| 5 | 仅因再次手动点击而接通；text+audio，replay 含目标、既有工具及 DOC-READY-42，再主动挂断。没有请求新语音问题，故不声称测到重接通后的新回答。 |

原生主管 3 个 turn/end 都 completed。`output/summary.json` 保留完整结果；最初 summary 包含前置读工具与重复的 session.update 连接编号，归因以 wire / native call_id 为准。最终 fixture 已将挂断后的工具与同 call_id 断言限于首次语音连接之后的文字连接，并要求工作结果自动触发实际读工具。`ticket08-real-evidence.txt` 对此次已保存的真实 wire/result 再校验 conn 3 / 4、两条读工具各自的原生成功结果与对应 wire function_call_output；通过，没有为观察层归因再次请求模型。

## TDD 与最终检查

- 红：`ticket08-red-generating.txt`，旧代码在新最高边界测试中仍有 3 个播放节点，预期 0；没有仅对实现内部写镜像单测。
- 绿：`ticket08-green-generating.txt`；随后生成中/播放中/快速重接通补充通过。idle-notice 的早期失败是 fixture 在 React 更新前同一任务对旧按钮处理器双击，两次实际都是挂断；改为等待可见“接通语音”按钮，产品不添加推测性的重连串行状态。
- `npm run typecheck`、`npm run build` 通过，日志 `ticket08-typecheck.txt` / `ticket08-build.txt`；构建 dist 被忽略，不提交。
- 全量初轮 `ticket08-npm-test-observation.txt`：64 项、49 passed / 4 failed / 11 skipped。3 项是新 fixture 的观察错误（新建按钮匹配两处及立即重接通）；另 1 项原生 stream 同毫秒被严格小于误判。修正定位并允许原生同毫秒相等，协议 response 索引的严格先后断言保留。
- 全量最终 `ticket08-npm-test-final.txt`：64 项、53 passed / 0 failed / 11 skipped，263.6 s。真实 opt-in 与物理 Desktop 检查按约定跳过。
- `tests/voice.test.mjs` 最终单文件 `ticket08-voice-final.txt`：18 项、13 passed / 0 failed / 5 skipped，277.6 s；覆盖全部受控语音、打断与挂断用例。全量启动后的改动只涉及 fixture 的前置文字派活、观察归因与同毫秒比较，产品代码不再修改。最后补强真实连接归因的 opt-in 断言后，语法检查及保存的真实证据检查通过；这些断言不在默认单文件的真实跳过项中执行。
- `git diff --check` 通过；密钥扫描检查当前仓库文件、本轮证据与输出的原始 key / base64 形式，`ticket08-secret-scan.txt` 为 2004 个文件、0 命中。历史无关证据未扫描。

复跑命令（PowerShell 中环境变量须用 `$env:` 设置；凭据由安全子进程包装临时注入，不写脚本或日志）：

```powershell
npm run typecheck
npm run build
node --test tests/voice.test.mjs
npm test
git diff --check
# 设置 NEXUS_REAL_VOICE=1、NEXUS_VOICE_KEY 后：
node --test --test-name-pattern='accurate Realtime hangup' tests/voice.test.mjs
```

每个真实测试有 420 s 总 timeout，并复用 Host 所有权清理。未运行无关票据的真实全套。凭据只从 provider.json 顶层读入子进程环境；不修改宿主设置。物理设备、回声与 Desktop 实机验收仍待用户完成，且不能把票 07 的用户实测直接转记为票 08 通过。
