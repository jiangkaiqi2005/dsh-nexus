# 票 12：主会话上下文压缩验证

2026-10-10，按本次明确授权实施票 12；票据原先的“待 10 完成后执行”已由票 10 关闭满足。实施基点为 `240de93`（版本号提交），票 10 已由用户验收关闭。本票不扩展票 13，没有推送、PR、打包安装或发布，没有读取真实凭据或调用付费模型，也没有操作用户现用 Desktop / profile（`~/.dsh`）。

## 行为与边界

主会话复用 Harness 原生压缩引擎：Nexus 只决定“何时、压哪段”和“谁写摘要”，压缩括号（`compaction/start` → `compaction/summary` → 检查点 → `compaction/end`）、检查点替换、原始记录保留与落盘全部由原生引擎完成，没有另建摘要机制或状态表。引擎取自主管自身绑定的原生预设（`agentPresets.serviceFor(agent, 'compaction')`），没有改写共享引擎：Nexus 调用时使用一个只覆盖 `summarize` 的派生对象，把摘要目标换成设置中的摘要模型，其余步骤仍是原生实现；改动与落盘始终作用于真实主管会话。

- **预算与摘要模型：** Nexus 原生设置新增 `compactionBudget`（默认 128000）与 `summaryModel`（`provider/model`，空值沿用普通会话的默认模型 `agentDefaultModel`）。两者均为 volatile，修改后在同一进程内立即按新值生效，并由原生设置文档跨重启保存。不再以 Realtime 模型约 1M 的上下文窗口为触发依据。
- **自动压缩：** 每个主管轮次的最后一步结束后（`step/end` 之后、`turn/end` 之前；此时没有正在生成的回复，也没有执行中的工具），用原生 token meter 估算下一次请求的总量，超过预算才压缩。压缩区间按原生选择规则：跳过首个系统消息，保留不少于预算 20% 的近期原文，且不在工具调用与结果之间切开（`toolPairingBalancedBefore`）。原生引擎要求开着的轮次才能 `compactRegion`，所以括号落在该轮内、所有步骤之后，语义上仍是轮次之间。失败时记录警告，原生括号带 `error` 结束，不产生检查点，完整上下文继续使用。
- **手动 `/compact`：** 主管在自身作用域注册同一原生定义身份（`@deepseek-ai/dsh-command-compact`）的 `/compact`，遮蔽预设中的同名命令；因此主会话一打开、预设尚未延迟绑定时命令列表已有它，客户端也按原生身份本地化显示。执行走原生 `compactNow`（独立括号、`turn: null`、`sourceCommandId`、维护期排他与 flush），只换摘要模型；结果与失败文案沿用原生命令。按错误 `name` 判别 `ManualCompactionError`，不用 `instanceof`。
- **重放：** 主管按 surface 顺序（不是 seq 顺序）重放，检查点位于被替换区间原位置；Realtime 文本连接每轮全量重放，语音新连接打开时重放，都只含摘要与近期原文。运行时快照的去重改为只看 surface，压缩掉旧快照后会重新附上当前快照。
- **通话中压缩：** 压缩后在轮次边界检查通话连接；仅当连接空闲（无回复、无请求、无用户说话、无待转写、无排队语音轮次）时重建：客户端状态先 `connecting` 再 `live`，旧连接尚未结算的播放量交给新连接继续核算，不发 flush、不打断正在播放的声音；准备新连接期间若有新语音则放弃本次重建，等下一个边界。重建失败按实际代码结束通话。手动 `/compact` 结束维护时同样检查。
- **用量：** Realtime `response.done.usage` 映射为原生 `TokenUsage`（端点 `input_tokens` 包含 `cached_tokens`，原生口径互斥，故 `inputTokens = input_tokens − cached_tokens`、`cacheReadTokens = cached_tokens`），写入 assistant 消息流的 `usage` 块与 `assistant/message.usage`。主管还按原生惯例写 `request/context`，以 Nexus 预算作为 `contextWindow`，供原生上下文压力显示。
- **不处理：** 文字模式每轮重建连接、全量重放的费用（只记录用量）；在途工作专门验收（用户裁定由摘要负责）。

最高验证边界是隔离的官方 `dsh --profile nexus-compaction --port 0 --no-open` 加载实际插件、原生预设与 `/compact`、原生会话落盘，以及真实 headless Edge 客户端（命令列表与设置）。Realtime 模型为本地受控 WebSocket，使用 fixture 凭据；摘要模型与工作会话模型是测试插件登记的受控原生 LLM 适配器（`nexus-test-summary` 的 `broken` 模型固定失败）。未调用真实 DashScope 或 DeepSeek。受控端点通过不等于准确型号与真实摘要模型的一次真实压缩，也不等于 Desktop 实机。

证据保存在忽略目录 `.scratch/nexus-v1/`：每个 `compaction-*` 目录保留 `report.json`（落盘后的主管原生事件、命令结果、摘要调用、用量与压力投影）、`requests.json`（每次请求与每条连接实际收到的条目）及原生 sessions；浏览器场景另有 `browser/` 截图。Host URL token 已脱敏，不随提交发布。

## 逐项验证

| 要求 | 实际观察与断言 | 限制 |
| --- | --- | --- |
| 超预算后在轮次间隙自动压缩，原生记录完整、原记录可查 | 预算 12000、7 条长输入后自动压缩：`compaction/start < summary < 检查点 < end`，`end` 无 error，括号前一事件是 `step/end`、在同轮 `turn/end`（completed）之前；`shadowedSeqs` 含 LONG-1，落盘日志中 LONG-1 原文仍在。 | 预算按原生 token meter 估算，非端点计费数。 |
| 一打开即有 `/compact`，执行成功并使用设置中的摘要模型 | Host：首轮前 `commands.list` 已含 compact；浏览器：未发任何消息即在主会话输入 `/comp`，候选出现原生本地化的“压缩 compact”。执行：首轮前返回 No compactable history yet.；三轮后成功，独立括号 `turn: null`，`sourceCommandId` 与检查点均等于该命令 id，`sourceEventSeq` 指向摘要；带参数返回原生 Usage 错误。自动、手动、设置三种场景分别由 configured-sum / default-sum / ui-sum 写摘要。 | Desktop 中可见与执行待实机。 |
| 设置可改、跨重启保存、按新值生效 | 浏览器 Nexus 设置初始为 128000 与空值（“默认模型”），摘要模型候选来自原生 model catalog；改为 12000 与 `nexus-test-summary/ui-sum` 后，同一 Host 进程随后的长对话按 12000 压缩、由 ui-sum 写摘要；关闭并启动新 Host 进程后，插件配置与设置页均仍为新值。 | Desktop 设置页未实机。 |
| 压缩后文字续答与新接通语音只重放摘要与近期原文，仍能理解结果并派活 | 压缩后首个请求按 surface 顺序：检查点（带 compact-checkpoint 来源前缀与 SUMMARY）在前，其后是全部保留的近期原文与当前运行时快照，不含 LONG-1；随后工作会话完成，主管收到自动工作结果并实际调用 `nexus_send_session` 成功，worker 收到 FOLLOW-UP-AFTER-COMPACTION。通话重建后的新连接与之后新接通的通话同样以检查点开头、不含被压缩原文。 | 派活由受控端点按规则触发，不代表真实模型的理解质量。 |
| 通话中压缩不打断播放或工具，重建状态如实 | 通话中的自动压缩发生在轮次的所有步骤之后；重建时客户端状态 `connecting → live`，无 failed，重建前 flush 次数为 0；新连接上用户说话时，旧连接已播放的声音被正确 flush，并以 nexus-voice 记录“ack c0 … about 0.5 s of its 1.0 s”，证明播放核算跨连接延续。所有轮次 completed。 | 声音为受控 PCM；物理扬声器 / 麦克风未实机。 |
| 每轮回复记录实际用量，原生用量与上下文压力为真实数据 | 每条主管 assistant 消息有 `usage {inputTokens: 234, outputTokens: 5, totalTokens: 1239, cacheReadTokens: 1000}`（端点报 input 1234 / cached 1000），流中有 usage 块；`tokenUsage` 输出总量 = 5 × 回复数；`contextPressure.pressureTokens = 1234`、`contextWindow = 12000`。 | DashScope 实际 `usage` 字段形状按 OpenAI Realtime 约定处理，未用真实端点核对；客户端用量 / 压力显示仅经投影数据验证，未截图核对。 |
| 压缩失败如实记录并保持原上下文 | 摘要模型 `broken`：自动（每个超预算轮次）与手动各有括号且 `end.error` 为实际失败原因，无 `compaction/summary`、无检查点；手动返回原生“could not produce a useful summary”；所有轮次 completed，最后请求仍含 KESTREL-9 与全部 LONG 原文、无检查点。 | 失败后每个超预算轮次都会重试一次摘要调用。 |

## 已知事实复核

1. **主管不经原生压缩钩子、`dashscope-realtime` 无模型适配：** 属实。探针中 `llm.resolveModelInfo('dashscope-realtime', …)` 报 no adapter registered；未经本票改动时对主管执行原生 `/compact`，`compaction/end` 记录同一错误。因此原生 `compactIfNeeded`（需目标模型窗口）不可用，本票自行按预算触发并换摘要模型。
2. **预设延迟绑定导致 `/compact` 缺失：** 属实。首轮前主管命令仅 export / feedback / permission，首轮后才出现 compact。本票改为主管作用域注册；浏览器验证的是修复后首次打开即可见，未在浏览器中复现修复前的缓存缺失。
3. **assistant 消息无 usage、`response.done` 用量被忽略：** 属实（修复前 `contextPressure` 只有 `surfaceTokens`），已修复。
4. **检查点、来源前缀、工具调用不可切开、来源含义：** 检查点以 user 消息替换区间、重放时带 `[Context source: {"kind":"compact-checkpoint",…}]` 前缀，属实。区间选择与原生 `compactRegion` 都校验工具配对边界。原生摘要输入保留每条消息的结构化 `source`，且 `nexus-work-result`、`nexus-user-input` 的正文本身写明“自动工作结果、非用户指令”“用户直接输入”；真实摘要模型是否在摘要中保持含义需随真实压缩验收。另发现并修复：主管原按 seq 排列 surface，检查点会错位到保留原文之后（证据 `compaction-auto-1791649709134/requests.json`），现按 surface 位置重放。
5. **Realtime 会话最大轮次限制：** 未核实（不调用真实端点）。文字模式每轮新连接，不受单连接轮次累计影响；长通话单连接是否受限仍待真实端点确认。

## 检查与证据

红测试 `ticket12-red-auto.txt`：自动压缩场景在未接线的实现下失败于 an over-budget conversation compacts automatically。接线后 `ticket12-auto-1.txt` 失败于测试编号（首条长输入是 LONG-1 而非 LONG-0，测试修正）；`ticket12-auto-2.txt` 失败于派活断言：工作会话 fixture 回显了最后一条 user 消息（运行时快照）而非用户输入，同时该证据暴露检查点按 seq 错位的产品缺陷。修正 fixture、按 surface 位置重放、补上“摘要位于保留原文之前”的断言后，`ticket12-auto-3.txt` 通过。用量口径在实现中按原生 `TokenUsage` 互斥约定修正（`inputTokens` 不含缓存命中），断言同步更新。

`ticket12-manual-failure-1.txt`：手动与失败两例首轮即通过。`ticket12-call-1.txt`：通话重建通过；变异检查 `ticket12-call-red-mutation.txt` 临时去掉重建调用后，该例在等待重建处超时被终止，源码随即恢复并重新构建，未留下孤儿 Host。浏览器场景 `ticket12-ui-1.txt` 失败于首启预览版说明遮挡（补充原生欢迎提示版本配置与关闭循环），`ticket12-ui-2.txt` 失败于候选文案（客户端按原生定义身份本地化为“压缩 compact”，改为按 option 名称匹配），`ticket12-ui-3.txt` 通过。

`npm run typecheck`（`ticket12-typecheck.txt`）与 `npm run build` 通过。整个 `tests/compaction.test.mjs`（`ticket12-compaction-file.txt`）：5 passed / 0 failed；证据目录 `compaction-auto-1791650336075`、`compaction-manual-1791650345540`、`compaction-failure-1791650351237`、`compaction-call-1791650359859`、`compaction-ui-1791650370101`。

全量 `ticket12-npm-test.txt`（最终版本）：87 项，76 passed / 0 failed / 11 skipped，376.5 s，正常 exit 0；较票 10 最终全量（82 / 71 / 11）多出本票 5 项。11 项 skipped 是套件既有的 10 项真实端点与 1 项 Desktop 显式启用验证，没有计作通过。全量运行中的本票证据目录为 `compaction-manual-1791650409788`、`compaction-call-1791650425364` 等同名新目录。`git diff --check` 无输出。

```powershell
npm run typecheck
npm run build
node --test tests/compaction.test.mjs
npm test
git diff --check
```

## 未验证与待用户验收

- 准确型号 `qwen3.8-omni-flash-realtime` 与实际摘要模型的一次真实压缩（摘要质量、来源含义保持、真实 `usage` 字段形状）。
- Desktop 中主会话 `/compact` 可见与实际执行、Desktop 设置页修改与重启保存。
- 真实通话（物理音频）中的轮次边界重建体验；Realtime 单连接最大轮次限制。
