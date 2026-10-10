# 票 12：主会话上下文压缩验证

2026-10-10，按本次明确授权实施票 12；票据原先的“待 10 完成后执行”已由票 10 关闭满足。实施基点为 `240de93`（版本号提交），票 10 已由用户验收关闭。本票不扩展票 13，没有推送、PR、打包安装或发布，没有读取真实凭据或调用付费模型，也没有操作用户现用 Desktop / profile（`~/.dsh`）。

## 行为与边界

主会话复用 Harness 原生压缩引擎：Nexus 只决定“何时、压哪段”和“谁写摘要”，压缩括号（`compaction/start` → `compaction/summary` → 检查点 → `compaction/end`）、检查点替换、原始记录保留与落盘全部由原生引擎完成，没有另建摘要机制或状态表。引擎取自主管自身绑定的原生预设（`agentPresets.serviceFor(agent, 'compaction')`），没有改写共享引擎：Nexus 调用时使用一个只覆盖 `summarize` 的派生对象，把摘要目标换成设置中的摘要模型，其余步骤仍是原生实现；改动与落盘始终作用于真实主管会话。原生 `summarize` 按自身 config 的摘要字段（顶层或针对目标模型的 `modelPolicies`）优先于路由目标，所以派生调用时清空这两个字段，Nexus 设置始终决定摘要模型，其余策略字段（如 `maxTokens`）照常生效。

**依赖的非公共接口与升级风险：** `@deepseek-ai/dsh-compaction-basic` 0.2.0-rc.2 的 `BasicCompactionEngine.summarize`（原生注释称其为唯一子类定制钩子，所有压缩路径经它调用）及其 `config` 的摘要字段形状；cordis 4.0.4 服务代理的接收者语义（经代理读取的 `ctx` 是读取者的上下文，派生摘要器因此使用引擎自身 `ctx` 属性值，否则无法取得引擎注入的 `llm`）。区间选择 `compactableRange` 是同版本原生选择规则（未导出）的等价重写，`MANUAL_FAILURES` 复制同版本 `@deepseek-ai/dsh-command-compact` 文案，代码注释均标明来源版本。缺少上述引擎形状时 Nexus 明确报错，不静默退回原生摘要路由。升级 Harness 时须重跑 `tests/compaction.test.mjs` 复核。本票未接原生免模型的 `compaction/prune`（工具结果裁剪），只做摘要压缩。

- **预算与摘要模型：** Nexus 原生设置新增 `compactionBudget`（默认 128000）与 `summaryModel`（`provider/model`，空值沿用普通会话的默认模型 `agentDefaultModel`）。两者均为 volatile，修改后在同一进程内立即按新值生效，并由原生设置文档跨重启保存。不再以 Realtime 模型约 1M 的上下文窗口为触发依据。
- **自动压缩：** 每个主管轮次的最后一步结束后（`step/end` 之后、`turn/end` 之前；此时没有正在生成的回复，也没有执行中的工具），用原生 token meter 估算下一次请求的总量，超过预算才压缩。压缩区间按原生选择规则：跳过首个系统消息，保留不少于预算 20% 的近期原文，且不在工具调用与结果之间切开（`toolPairingBalancedBefore`）。原生引擎要求开着的轮次才能 `compactRegion`，所以括号落在该轮内、所有步骤之后，语义上仍是轮次之间。失败时记录警告，原生括号带 `error` 结束，不产生检查点，完整上下文继续使用。与原生自动压缩相同：压缩期间该轮保持 running，摘要调用的时长会推迟下一轮（新输入照常进入 inbox）；失败没有退避，之后每个仍超预算的轮次都会再调用一次摘要模型，摘要模型持续不可用时每轮多一次失败调用的费用与延迟。
- **手动 `/compact`：** 主管在自身作用域注册同一原生定义身份（`@deepseek-ai/dsh-command-compact`）的 `/compact`，遮蔽预设中的同名命令；因此主会话一打开、预设尚未延迟绑定时命令列表已有它，客户端也按原生身份本地化显示。执行走原生 `compactNow`（独立括号、`turn: null`、`sourceCommandId`、维护期排他与 flush），只换摘要模型；结果与失败文案沿用原生命令。按错误 `name` 判别 `ManualCompactionError`，不用 `instanceof`。
- **重放：** 主管按 surface 顺序（不是 seq 顺序）重放，检查点位于被替换区间原位置；Realtime 文本连接每轮全量重放，语音新连接打开时重放，都只含摘要与近期原文。运行时快照的去重改为只看 surface，压缩掉旧快照后会重新附上当前快照。
- **通话中压缩：** 压缩后在轮次边界检查通话连接；连接空闲（无回复、无请求、无用户说话、无待转写、无排队语音轮次）时在后台打开新连接并重放压缩后的主会话，旧连接期间照常收音、回答。新连接就绪后，仅当旧连接期间没有新的语音提交或回复、没有排队语音轮次、主会话 surface 未变时才替换：旧连接尚未结算的播放量交给新连接继续核算，不发 flush、不打断正在播放的声音；否则关闭新连接、保留旧连接并重试：期间有轮次的，该轮结束的边界再试；主管已空闲（无轮次、无维护，例如期间执行了 `/compact`）的，丢弃后立即再试一次。新连接打开失败同样保留旧连接与通话，只记警告，不立即重试（避免端点持续拒绝时反复建连），等下一个边界。打开期间新旧两条 Realtime 连接短暂并存（同一凭据），DashScope 是否允许这种并发未核实。替换在同一时刻关闭旧连接、改由新连接收音；若用户恰在此刻开口，已发给旧连接、尚未触发其 VAD 的极短开头音频随旧连接丢弃，新连接只收到其后的部分。通话自始至终可用，所以客户端状态保持 `live`，不显示 `connecting`（显示正在接通会误报通话不可用）。延后期间旧连接的后续请求不把检查点作为新条目补发（旧服务端会话仍有被替换的原文），避免摘要与原文重复。手动 `/compact` 结束维护时同样检查。
- **用量：** Realtime `response.done.usage` 映射为原生 `TokenUsage`（端点 `input_tokens` 包含 `cached_tokens`，原生口径互斥，故 `inputTokens = input_tokens − cached_tokens`、`cacheReadTokens = cached_tokens`），写入 assistant 消息流的 `usage` 块与 `assistant/message.usage`。两类完成却不留消息的回复——语音中模型选择沉默、只重复已完成工具调用——若端点报告用量，按原生无内容结算记为 `assistant/attempt`（流中带 usage 块），不进入模型上下文；端点未报告用量时与此前一样不留记录。以下仍丢失端点报告的那次用量：文字模式完成但无文字、无工具调用的回复（既有设计按 `EMPTY_RESPONSE` 失败处理，见 `src/realtime.ts` 对文字连接的说明）与 `RESPONSE_FAILED`，失败的 attempt 不带 usage；语音中“没听清被放弃”的提交不留任何记录，服务端为它产生的那次用量也随之丢失。
- **上下文压力口径：** 主管按原生惯例写 `request/context`，以 Nexus 预算作为 `contextWindow`，原生压力显示即“占压缩预算的比例”，而非模型约 1M 的窗口。压力的分子是端点报告的输入（含缓存），语音通话中包含音频 token；压缩触发看的是原生 token meter 对文本 surface 的估算，所以压力显示可能超过 100% 而不触发压缩，也可能低于 100% 时已按估算压缩。
- **不处理：** 文字模式每轮重建连接、全量重放的费用（只记录用量）；在途工作专门验收（用户裁定由摘要负责）。

最高验证边界是隔离的官方 `dsh --profile nexus-compaction --port 0 --no-open` 加载实际插件、原生预设与 `/compact`、原生会话落盘，以及真实 headless Edge 客户端（命令列表与设置）。Realtime 模型为本地受控 WebSocket，使用 fixture 凭据；摘要模型与工作会话模型是测试插件登记的受控原生 LLM 适配器（`nexus-test-summary` 的 `broken` 模型固定失败）。未调用真实 DashScope 或 DeepSeek。受控端点通过不等于准确型号与真实摘要模型的一次真实压缩，也不等于 Desktop 实机。

证据保存在忽略目录 `.scratch/nexus-v1/`：每个 `compaction-*` 目录保留 `report.json`（落盘后的主管原生事件、命令结果、摘要调用、用量与压力投影）、`requests.json`（每次请求与每条连接实际收到的条目）及原生 sessions；浏览器场景另有 `browser/` 截图。Host URL token 已脱敏，不随提交发布。

## 逐项验证

| 要求 | 实际观察与断言 | 限制 |
| --- | --- | --- |
| 超预算后在轮次间隙自动压缩，原生记录完整、原记录可查 | 预算 12000、7 条长输入后自动压缩：`compaction/start < summary < 检查点 < end`，`end` 无 error，括号前一事件是 `step/end`、在同轮 `turn/end`（completed）之前；`shadowedSeqs` 含 LONG-1，落盘日志中 LONG-1 原文仍在。 | 预算按原生 token meter 估算，非端点计费数。 |
| 一打开即有 `/compact`，执行成功并使用设置中的摘要模型 | Host：首轮前 `commands.list` 已含 compact；浏览器：未发任何消息即在主会话输入 `/comp`，候选出现原生本地化的“压缩 compact”。执行：首轮前返回 No compactable history yet.；三轮后成功，独立括号 `turn: null`，`sourceCommandId` 与检查点均等于该命令 id，`sourceEventSeq` 指向摘要；带参数返回原生 Usage 错误。自动、手动、设置三种场景分别由 configured-sum / default-sum / ui-sum 写摘要；自动与手动场景在首轮后把预设引擎 config 的顶层及对应 `modelPolicies` 摘要字段设为 `broken`，摘要仍由 Nexus 设置的模型写出。 | Desktop 中可见与执行待实机。 |
| 设置可改、跨重启保存、按新值生效 | 浏览器 Nexus 设置初始为 128000 与空值（“默认模型”），摘要模型候选来自原生 model catalog；改为 12000 与 `nexus-test-summary/ui-sum` 后，同一 Host 进程随后的长对话按 12000 压缩、由 ui-sum 写摘要；关闭并启动新 Host 进程后，插件配置与设置页均仍为新值。 | Desktop 设置页未实机。 |
| 压缩后文字续答与新接通语音只重放摘要与近期原文，仍能理解结果并派活 | 压缩后首个请求按 surface 顺序：检查点（带 compact-checkpoint 来源前缀与 SUMMARY）在前，其后是全部保留的近期原文与当前运行时快照，不含 LONG-1；随后工作会话完成，主管收到自动工作结果并实际调用 `nexus_send_session` 成功，worker 收到 FOLLOW-UP-AFTER-COMPACTION。通话重建后的新连接与之后新接通的通话同样以检查点开头、不含被压缩原文。 | 派活由受控端点按规则触发，不代表真实模型的理解质量。 |
| 通话中压缩不打断播放或工具，重建状态如实 | 通话中的自动压缩发生在轮次的所有步骤之后；新连接重放完成后才替换，客户端状态全程不变（无 connecting / failed），重建前 flush 次数为 0；新连接上用户说话时，旧连接已播放的声音被正确 flush，并以 nexus-voice 记录“ack c0 … about 0.5 s of its 1.0 s”，证明播放核算跨连接延续。新连接两次打开失败（端点在配置时关闭）：通话不结束，后续请求仍在原连接回答且原连接从未收到检查点条目，下一个边界的第三条新连接以检查点开头替换成功。新连接打开期间（端点延迟确认 1.5 s）用户开口：该语音在原连接提交并被回答，新连接未被使用即关闭，该轮结束后的新连接重放含该语音与检查点。新连接打开期间主管空闲时执行 `/compact`：新连接因 surface 变化被丢弃，未等下一轮，立即重试的第三条连接以最新检查点（最后一次摘要）开头，下一条输入在它上面回答。所有轮次 completed。 | 声音为受控 PCM；物理扬声器 / 麦克风未实机。两条连接并存与替换瞬间的开头丢失未经真实端点验证。 |
| 每轮回复记录实际用量，原生用量与上下文压力为真实数据 | 每条主管 assistant 消息有 `usage {inputTokens: 234, outputTokens: 5, totalTokens: 1239, cacheReadTokens: 1000}`（端点报 input 1234 / cached 1000），流中有 usage 块；`tokenUsage` 输出总量 = 5 × 回复数；`contextPressure.pressureTokens = 1234`、`contextWindow = 12000`。语音中沉默回答的用量记为 `assistant/attempt` 的 usage 块，`tokenUsage` 输出总量 = 5 ×（消息 + 无内容结算）数。 | DashScope 实际 `usage` 字段形状按 OpenAI Realtime 约定处理，未用真实端点核对；客户端用量 / 压力显示仅经投影数据验证，未截图核对。 |
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

首轮全量 `ticket12-npm-test.txt`：87 项，76 passed / 0 failed / 11 skipped，376.5 s，正常 exit 0；较票 10 最终全量（82 / 71 / 11）多出本票 5 项。11 项 skipped 是套件既有的 10 项真实端点与 1 项 Desktop 显式启用验证，没有计作通过。全量运行中的本票证据目录为 `compaction-manual-1791650409788`、`compaction-call-1791650425364` 等同名新目录。`git diff --check` 无输出。

### 首轮评审处置（快照 `240de93...219316a`）

| 意见 | 处置 | 依据 |
| --- | --- | --- |
| S1 沉默 / 放弃回复丢 usage | fixed | 端点报告用量的无消息回复按原生无内容结算记 `assistant/attempt`（原生 token meter 与客户端均从其流的 usage 块累计）；新增通话语音用例断言其 usage 与总量。 |
| S2 原生 config 摘要字段使 Nexus 设置失效 | fixed | 核实 `BasicCompactionEngine.summarize` 经 `resolveTargetPolicy(this.config, target)` 取摘要字段且优先；派生摘要器清空顶层与 `modelPolicies` 的两字段。自动 / 手动用例首轮后注入 `broken` 字段，修复前红（摘要失败），修复后仍由设置模型写摘要。 |
| S3 先退役再打开、打开失败挂断通话 | fixed | 改为新连接重放完成后再替换，期间旧连接继续收音回答；替换前复核旧连接未有新交换、无排队语音、surface 未变，否则丢弃新连接；打开失败保留通话。新增“打开失败”与“打开期间开口”两例，修复前均红（CONNECTION_CLOSED 挂断；新连接被提前使用）。 |
| S4 压力分母为预算 | 保留，已写明 | 见“上下文压力口径”。 |
| S5 失败无退避、压缩期间 running | 保留，已写明 | 与原生自动压缩同等；费用与延迟见“自动压缩”。 |
| S6 / T3 未接 prune、等价重写与复制文案 | 保留并标注；do-while 补花括号 | 代码注释标明来源包与 0.2.0-rc.2；见“依赖的非公共接口”。 |
| S7 延后重建时检查点作为新条目插入旧连接 | fixed | 非首次提交跳过检查点（旧服务端会话仍有原文）；“打开失败”用例断言原连接从未收到检查点，去掉该跳过的变异下该断言失败。 |
| S8 锁文件 dev 标记 | 无需处理 | — |
| T1 依赖非公共 `summarize` seam | 保留，已写明 | 见“依赖的非公共接口与升级风险”；本轮另增对引擎 `config` 形状与 cordis 接收者语义的依赖，一并写明。 |
| T2 引擎形状不符时静默退回原生 | fixed | 改为抛错；自动压缩捕获并记警告，`/compact` 返回错误。 |
| T4 contextWindow 语义 | 同 S4 | — |
| T5 README 未更新 | fixed | README 补充票 12 行为、设置项与验证链接。 |

本轮红测试 `ticket12-r2-red.txt`（新测试对已提交实现）：5 项全部失败，原因分别为摘要被 `broken` 字段改写（自动、手动）、旧实现的 `connecting/live` 状态、打开失败挂断（CONNECTION_CLOSED）、新连接被提前使用。首个修复版本整文件首跑 7 项全失败：派生摘要器以自身为 `this` 时，经 cordis 服务代理读到的 `ctx` 是读取者上下文，`ctx.llm` 报 cannot get property "llm" without inject（该次日志被随后同名重跑覆盖，未保留；失败落盘证据为 `compaction-auto-1791651470256/report.json`，其 4 个 `compaction/end.error` 均为该消息）。改用引擎自身 `ctx` 属性值后自动用例通过，随后整文件重跑 `ticket12-r2-green.txt` 7 passed / 0 failed（证据 `compaction-auto-1791651996768`、`compaction-manual-1791652006320`、`compaction-failure-1791652012234`、`compaction-call-1791652021070`、`compaction-ui-1791652031271`、`compaction-call-rejected-1791652051039`、`compaction-call-speech-1791652061676`）。S7 变异 `ticket12-r2-s7-mutation.txt`：去掉检查点跳过后“打开失败”用例在“原连接从未收到检查点”断言处失败，源码随即恢复并重建。

本轮检查 `ticket12-r2-typecheck.txt`、`ticket12-r2-build.txt` 均 exit 0。本轮全量 `ticket12-r2-npm-test.txt`：89 项，78 passed / 0 failed / 11 skipped，384.1 s，正常 exit 0；比首轮多出的 2 项是本轮新增的两例，11 项 skipped 与首轮相同（10 项真实端点与 1 项 Desktop 显式启用）。全量中本票证据目录：`compaction-auto-1791652114239`、`compaction-manual-1791652126514`、`compaction-failure-1791652133366`、`compaction-call-1791652142945`、`compaction-ui-1791652154318`、`compaction-call-rejected-1791652176126`、`compaction-call-speech-1791652187473`。

### 复审收尾（第 2 轮）

| 意见 | 处置 | 依据 |
| --- | --- | --- |
| 标准#1 取不到引擎自身 `ctx` 未明确报错 | fixed | `withSummaryModel` 先取引擎自身 `ctx`，与 `summarize`、`config` 一起做形状检查，缺任一即抛错。 |
| 标准#2 顶层 `''` 与 `modelPolicies` `undefined` 的差异 | fixed（注释） | 原生 `resolveTargetPolicy` 中策略字段以 `??` 回落到顶层；顶层是已解析配置，空字符串对表示“用路由目标”（原生按 `.length` 判断，`undefined` 不合法）。 |
| 规格#1 丢弃新连接后迟迟不重建 | fixed | 核实：丢弃前进入的轮次请求会等待重建结束，其轮次结束时再次检查，已能重试；缺口是丢弃时主管已空闲（如期间执行 `/compact`）。现在丢弃且主管空闲时立即再试；打开失败不立即重试。新增用例修复前红（下一条输入落在原连接），修复后绿。剩余缺口（旧连接正在收音且该语音被放弃）写入“未验证与待用户验收”。 |
| 规格#2 两条连接短暂并存 | 已写明 | 列入“未验证与待用户验收”。 |
| 规格#3 替换瞬间丢失开头 | 已写明 | 见“通话中压缩”与“未验证与待用户验收”。 |
| 规格#4 S1 覆盖范围与限制 | 已写明，更正前提 | S1 的两条路径是语音沉默与“只重复已完成工具调用”，文字模式空回复不在其中：本轮按建议补的文字空回复用例实际得到 `turn/end` error `EMPTY_RESPONSE`、失败 attempt 无 usage（`compaction-failure-1791659865578`），这是 `src/realtime.ts` 的既有设计，因此删去该用例，把它与 `RESPONSE_FAILED`、被放弃的语音提交一起写为仍丢失用量的限制。 |

本轮红测试 `ticket12-r3-red.txt`：新用例 `call-discarded` 失败于“下一条输入在第三条连接回答”（actual 0 / expected 2，有界等待 15 s 后仍未重建）；同次运行的文字空回复用例即上表规格#4 所述，已删去。修复后 `ticket12-r3-typecheck.txt`、`ticket12-r3-build.txt` 均 exit 0，整文件 `ticket12-r3-green.txt` 8 passed / 0 failed（证据 `compaction-auto-1791659949224`、`compaction-manual-1791659959000`、`compaction-failure-1791659964779`、`compaction-call-1791659973630`、`compaction-ui-1791659984011`、`compaction-call-rejected-1791660003626`、`compaction-call-speech-1791660014438`、`compaction-call-discarded-1791660025465`）。探针的 `until: 'rebuilt'` 改为最多等待 15 s，失败时不再挂到用例超时。

本轮第一次全量 `ticket12-r3-npm-test.txt`：90 项，78 passed / 1 failed / 11 skipped，exit 1。失败的是既有用例 `hangup playback accounting: played-in-transit`（`tests/voice.test.mjs`），在“first batch playing”处 66 s 超时；本票 8 例全部通过。该用例不触发压缩（默认预算 128000），新增重试只在已有检查点的重建被丢弃后执行，与本轮改动无关。单独重跑 `ticket12-r3-voice-hangup-rerun.txt`：4 项 hangup 用例全部通过，每项约 7–8 s。判断为满载下的浏览器时序抖动，未改动。第二次全量 `ticket12-r3-npm-test-2.txt`：90 项，79 passed / 0 failed / 11 skipped，379.8 s，exit 0（本票证据 `compaction-auto-1791660528337` … `compaction-call-discarded-1791660610912`）。

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
- 重建期间新旧两条 Realtime 连接并存：DashScope 对同一凭据并发连接是否允许、是否计费或限流，未核实。
- 替换瞬间用户开口时开头极短音频的丢失程度（受 DashScope VAD 起始延迟影响），未实机。
- 重试时旧连接仍在收音、而这段语音最终没有提交（被放弃）时，没有边界再触发重建，直到下一个轮次或维护结束；此路径需要端点模拟一段跨越复核时刻、随后未提交的语音，本轮未做自动化验证。
