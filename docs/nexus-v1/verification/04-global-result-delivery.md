# 票 04：全局工作结果回流验证

验证日期：2026-10-09。实施基线：`ebe2efc51d9ac809203a98321fe499727834db2f`（其后先有测试隔离修复提交 `8d50953`）。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 `~/.agents`、`~/.claude`。

## 实现与原生边界

`src/results.ts` 的 `ResultRelay` 在 Nexus 插件的上下文中订阅原生 `session/event` 提交后事件流（持久化、索引等官方插件使用的同一入口），覆盖所有进入原生 Session 存储的会话：Nexus 创建的、用户自己创建的普通会话、其它 subagent 会话都一视同仁，不要求直属或 Nexus 创建。每个 `turn/end` 是一个终态，来源可以是成功、失败（`error`）、中断（`aborted`/`interrupted`）或其它原生终态；终态原因原样进入结果。

- **内容**：消息包含会话身份（含是否 subagent 及其 parent、工作区）、轮次号与终态事件 seq、终态与失败代码/消息、该轮最后一条有文字的 assistant 消息的消息身份和文字。会话读取只扫描该轮自己的事件，不复制历史；超长文字保留头 2500 与尾 3500 字符并标明省略，提示用 `nexus_read_session` 读取记录。没有 assistant 文字时如实写明。
- **来源**：新的原生消息来源 `nexus-work-result`（`form: 'notice'`，带 `summary`、`sessionId`、`turn`、`terminal`、`terminalSeq`），区别于 `user` 与 `nexus-dispatch`；角色是 user 但来源不是用户，不伪造用户或 parent-agent。模型侧沿用现有“非用户来源附带 `[Context source: …]`”的投影，系统指令增加对该来源的说明：自动报告不是用户指令，由模型据用户目标决定汇报、读详情、追加、审查或停止；纯文字连接必须回应，无话可说时简短回应（空回复在 `TextConnection` 中本来就是错误，没有放宽）。
- **投递**：用原生 waking `steer` 入主管 inbox（`next-step`），与原生 subagent-settled 通知同一契约。主管闲时开启新 turn 并 claim；主管忙时留在 inbox，在当前请求结束后的下一个 step 边界（或下一轮）进入模型，用户输入走原有 `next-turn` 队列，两者互不覆盖。连接层没有写死任何动作顺序、迭代次数、必须汇报或必须追加。
- **身份与去重**：键为 `(sessionId, turn)`，同键只投递一次。重启时从主管原生日志里曾经入队的 `agent/inbox/spliced` 消息重建，所以重启后重复的终态不再投递；投递失败（主管不可用）会释放该键以便重试。只有主管自身会话不回流。以主管为 parent 的 subagent 会话同样按 `(sessionId, turn)` 由本中继投递（修复轮 2 起；此前曾排除，见修复轮 2 第 1 条）。rc.2 另有原生 `subagent-settled` 通知，它按 Activation 结算，只带子会话 id、一行摘要与收尾文字，不带轮次/消息身份或失败代码，且同一 Activation 中多轮只结算一次；两者身份不同，不是同一事件的重复投递：`nexus-work-result` 是每一轮的终态报告，`subagent-settled` 是该 Activation 的原生结算。主管因此对自己的子会话会多收到一条结算通知。
- **接收与处理分开**：中继观察到终态是一回事；`agent/inbox/spliced` 入队是第二回事；请求时追加 `user/message` 并发送到模型传输层是“接收”；其后第一条 `assistant/message`（及其内容）才是“已处理”。验证对三者分别断言。
- **生命周期**：中继在主管可接收 inbox 后启动，teardown 时先于 `agent.stop()` 释放，不会在主管停止后继续投递。没有配置开关：回流始终开启（修复轮 1 删除了最初为隔离旧测试加的 `deliverResults`）。

重启语义沿用票 02：恢复的 inbox 不自动唤醒，停机期间无法运行 worker；重启前已入队而未被处理的结果保留在原生 inbox 中，在下一次用户输入或其它唤醒时进入模型。用户 UI 的 stop 走 `keepInbox: true`，不会丢弃排队的结果。

## 验证

所有 Host 子进程使用独立 `.scratch/nexus-v1/delivery-*` 的 DSH_HOME/DSH_AGENTS_HOME/profile、`--no-open`、`windowsHide: true`，经官方 dsh CLI、base + web composition、真实原生会话、默认 AgentLoop 和压缩 journal。其中的 worker 是受控 native WorkerAdapter（按任务文本选择成功/失败/等待/中断），实际写入原生日志并产生原生终态；这是真实原生 worker 执行和真实终态事件，不是付费 DeepSeek worker 的项目交付。受控检查的主管模型是本地 WebSocket 脚本；真实检查的主管模型是准确型号 `qwen3.8-omni-flash-realtime`。

### 受控（脚本化主管模型，原生 worker 与原生事件）

`tests/delivery.test.mjs` 的官方 Host 检查，证据 `.scratch/nexus-v1/delivery-controlled-1791531951418/result.json`（含主管原生日志、各 worker 日志、`wire.json`）：

| 项 | 断言 |
| --- | --- |
| 全覆盖、无遗漏无重复 | 每个其它会话的每个 `turn/end` 恰好一条结果；总数等于全部 worker 终态数；主管自己的会话没有结果。 |
| 闲时唤醒、非 Nexus 创建的已有会话 | `user-existing` 由探针以用户来源直接发任务（会话日志里没有任何 `nexus-dispatch`）；其终态使闲置主管开启新 turn；结果来源非 user、角色 user。 |
| 失败、中断 | 失败轮 `Outcome: failed - TEST_WORKER_FAILURE: …worker exploded`，无 assistant 文字时如实标明；经原生 `sessionController.cancel` 中断的轮次为 `interrupted`，`terminal: aborted`。 |
| 不同会话、同轮次号 | `mixed-a`、`mixed-b` 同时结束的第 1 轮分别投递，消息身份不同。 |
| 忙时 | 主管正在处理“HOLD-BUSY”用户输入（脚本模型持有 2.5 秒）时 worker 结束：结果在该 turn 打开期间入队；该次请求结束后，结果在同一 turn 的下一个 step 被追加并送往模型；其后排队的“SECOND-USER”在下一 turn 处理。用户输入、结果均有对应的模型回应。 |
| 接收与处理 | 每条结果在主管日志中恰有一条同 id 的 `user/message`（接收）、有随后的 `assistant/message`（处理，内容回显结果里的任务标记）、且同 id 的条目出现在 WebSocket 传输的 `conversation.item.create`（实际发往模型）。 |
| 主管自己的子会话 | 探针以主管为 parent 用原生 `startContinuable` 起 continuable 子会话 `nexus-child`（受控 native adapter）：中继恰好一条 `nexus-work-result`（`Session: nexus-child (subagent of nexus-supervisor)`、Turn 1、completed、`Report ok-native: finished`），原生 `subagent-settled` 恰好一条，二者各有模型回应（修复轮 2 起；证据 `.scratch/nexus-v1/delivery-controlled-1791533773245/result.json`）。 |
| 模型决定后续 | 脚本模型读到 `review-target` 的 FOLLOWUP 结果后调用 `nexus_send_session` 要求二次处理；worker 恰好两轮，第二个结果再次回流并被处理；其后没有再追加。迭代由模型决定。 |

### 受控（relay 层，真实原生 Session 事件）

`tests/results.test.mjs`，7 项，直接对 `ResultRelay` 输入由真实 `Session` 追加出的原生事件：终态字段与最终内容、仅引用结束的那一轮；重复 feed、整段快照回放、回放与实时结束交错、回放中新出现的轮次仅投一次；主管自身排除，主管自己的子会话（含 `NO_ADAPTER` 失败轮）与其它 subagent 按轮投递且标注 parent（修复轮 2 起，此前为“主管及其原生子会话排除”）；超长内容有界且保留头尾；重启后按主管日志重建身份；主管不可用时不消耗键、可重试；`start()` 订阅 `session/event` 且投递错误被约束。变异检查：临时改写编译产物 `dist/results.js` 去掉去重或去掉主管自排除，对应用例确实失败；命令、输出见修复轮 1 第 3 条。

重复事件与快照回放没有注入真实 Host 总线：向全局 `session/event` 重发会同时被持久化、索引、不变量校验等官方监听器消费而破坏日志，因此该类边界只在 relay 层验证，Host 层证明的是真实实时事件接线。

### 真实模型（准确型号 `qwen3.8-omni-flash-realtime`，受控 native worker）

opt-in：`NEXUS_REAL_DELIVERY=1` 与临时 `NEXUS_DELIVERY_KEY`（可选 `NEXUS_REAL_ENDPOINT`）。凭据只读授权的 `C:\Users\25330\.qiyu\provider.json` top-level `apiKey`，仅进入子进程环境和隔离 Host 原生 credentials 服务，不进入命令参数、profile、日志或源码。

```powershell
node --test --test-name-pattern='accurate Realtime' tests/delivery.test.mjs   # 带上述环境
```

两次运行均 1 passed、0 failed：`.scratch/nexus-v1/delivery-real-1791531904351/result.json`（PID 60956）与最终 `.scratch/nexus-v1/delivery-real-1791532007436/result.json`（PID 79304）。主管 3 个 turn 均 completed，所有 assistant 消息均为该准确型号。

- **空闲回流唤醒**：用户先告知“`user-existing` 是我自己在用的普通会话，不是你创建的；结果到达后报告编号和结论，有失败就用 `nexus_send_session` 让它重跑”，主管回答“收到”后闲置。探针以用户来源让该既有会话跑出报告。结果（来源 `nexus-work-result`，非 Nexus 派活）唤醒主管，真实模型回应包含报告编号 `REPORT-RI-7731` 与失败结论，并调用 `nexus_send_session(user-existing, report-rerun)`；重跑结果（第二个 turn）再次自动回流，模型据 `REPORT-RR-8842` 报告全部通过。最终运行的措辞不同（先给出编号与结论，随后发出重跑指令，再报告重跑通过），行为相同。
- **忙时回流**：用户提问“9 乘以 7 等于多少？若期间有新工作结果到达请带上报告编号”，同一 turn 打开期间已有会话 `user-busy` 结束。模型第一条回应给出 63（并如实说明此刻还没有看到结果），结果在下一个 step 进入模型后，第二条回应给出 `REPORT-RB-5524`；用户问题与结果都没丢，且结果在请求结束后才进入模型，没有伪称在回答时已看到。
- 断言：所有结果恰好一次、接收与处理分别成立；idle 回应有依据（含编号或相应工具动作）；若重跑则第二结果自动回流并被处理；busy 结果在 supervisor turn 打开期间入队，回应含 63 与 5524。

### 命令与结果

```powershell
npm run typecheck
npm run build
npm test
git diff --check
```

最终：`typecheck`、`build` 通过，`git diff --check` 无问题；默认 `npm test`：31 项，26 passed、0 failed、5 skipped（真实文字、真实跨进程恢复、真实调度、真实回流四项 opt-in，以及深层冷 P2 红测 opt-in）。真实回流检查另行 1 passed（两次）。票 03 的深层冷 P2 红测（`NEXUS_DEEP_COLD=1 node --test --test-name-pattern='deep cold' tests/dispatch.test.mjs`）仍为 1 failed，原因同前，`session "deep-parent" is owned by subagent routing`，证据 `.scratch/nexus-v1/dispatch-deep-cold-1791532025110/result.json`；本票未尝试绕过。

## 未验证与边界

- 用户 Desktop 中的新版安装与实机回流未做；全程没有 Computer Use，没有控制用户窗口或浏览器，没有给用户 profile 安装包。
- worker 是受控 native adapter，不是付费 DeepSeek worker 对项目的真实修复；主管真实模型检查为文字模式，语音通话中的结果播报、打断和挂断属于后续票。
- 回流只覆盖 Nexus 运行期间发生的终态；不回溯启动前已经结束的轮次，也不在重启时自动唤醒。已入队但在重启前未被处理的结果留在原生 inbox，待下一次唤醒进入模型。
- （票 05 修复轮 1 起已改变，见文末“用户裁定”）原为：所有 subagent 会话（修复轮 2 起包括主管自己的子会话）都会回流，包括 worker 内部辅助 subagent 的轮次；模型可据来源里的 parent 信息判断，但这可能增加主管请求量。未设计按类型过滤，因为 Spec 要求全局覆盖且由模型决定。
- 主管以 one-shot 方式起的子会话，其结果已作为该工具调用的工具结果返回给主管；中继仍会为该子会话轮次再投一条 `nexus-work-result`，因此多一次主管唤醒与模型请求。这是当时行为的如实记录（票 05 第 0 步补记）；票 05 修复轮 1 起 subagent 会话不再回流，此项随之消失。
- 纯文字连接要求主管每次回应至少给出简短文字；“完全沉默”需要放宽 `TextConnection` 空回复错误，本票没有做。（系统指令里的 “always answer in text” 即由此而来，`src/realtime.ts` 已加注释；语音票需要重新评估。）
- 用户指令优先、来自工作会话的用户引导同步（用户故事 24）、指令仲裁属于票 05；本票只保证用户输入与结果同时到达时都不丢。
- 票 03 的深层冷 subagent parent 直接派活：原 P2 cannot_fix，按 2026-10-09 用户裁定不在范围（不适用）。
- 原未决（票 03 范围，修复轮 2 核实；按 2026-10-09 用户裁定不在范围，不适用）：主管工具集中的原生 `subagent_fork`/`workflow` 建出的子会话继承主管的 `dashscope-realtime` 路由，第一步即 `NO_ADAPTER` 失败，主管用这些原生工具建子会话实际不可用；失败会如实回流。根因与未修理由见修复轮 2 第 6 条与票 03 验证文档。

## 修复轮 1

评审两轴均 approve，无 P1/P2；以下为 P3 处置。基线 reviewHead `2217fbf`。

| # | 原问题 | 状态 | 理由 | 证据 | 检查 |
| --- | --- | --- | --- | --- | --- |
| 1 | `deliverResults` 为测试加的产品开关，导致票 01–03 的 Host 测试在非默认配置运行 | fixed | 开关与配置校验已删除（`src/index.ts`、`src/supervisor.ts`），回流始终开启，旧测试 patch 不再设置。旧测试改为在默认配置下容忍回流：profile/restore 探针在 worker 轮次后先让主管消化其结果再开始场景（restore 的“恢复后不自动运行”检查移到 worker 恢复之前），profile 以记录的基线切分事件与 wire 并按基线偏移 turn 编号；restore 的 turn 编号改为断言连续无缺口，脚本模型的 `requests` 只计场景自己的提示；dispatch 的脚本模型对“仅含自动结果”的请求只回文字、不推进派活计划，工具结果仍须落在同一连接，探针收敛等待改为全体空闲且日志不再增长。 | 默认配置下 profile 11 项、restore 5 项、dispatch 1 项通过；另在默认配置下重跑真实模型：调度 `.scratch/nexus-v1/dispatch-real-1791532952800/result.json` 1 passed，恢复 `.scratch/nexus-v1/restore-real-1791532978924` 1 passed。 | 见下方命令 |
| 2 | 排除主管自己的 subagent 依赖未证实的原生 settled 通知 | fixed（实测，保留排除）——**结论已被修复轮 2 第 1 条推翻**：原生通知确实送达，但它不带轮次/消息身份与失败代码，不满足票 04 验收 1，排除已删除 | 受控 Host 检查新增：探针以主管为 parent 用原生 `startContinuable` 起 continuable 子会话（受控 native adapter）。结果：主管收到恰好一条 `subagent-settled` 来源消息（含收尾文字 `ok-native`），其后有模型回应；中继对该子会话 0 条，不重复。子会话先前因继承 Realtime 型号而失败时，原生通知也如实送达（“failed before it finished”，存档于 `.scratch/nexus-v1/delivery-controlled-1791532817388/result.json`）。粒度差异：原生通知按 Activation，只给子会话 id、摘要和收尾文字，没有轮次/消息身份；中继的 `nexus-work-result` 带轮次与终态事件 seq。 | `.scratch/nexus-v1/delivery-controlled-1791532848603/result.json`（及最终套件中的受控运行） | `tests/delivery.test.mjs` 受控用例 |
| 3 | “变异检查”无命令与证据 | fixed | 重新执行并存档。命令：对 `dist/results.js` 分别用 `sed` 把 `if (this.delivered.has(id))` 改为 `if (false)`、把 `session.id === this.target.id` 改为 `false`，各跑 `node --test tests/results.test.mjs`，再恢复原文件重跑。结果：去重变异 5 passed、2 failed（重复/回放交错、重启重建）；自排除变异 6 passed、1 failed（主管自排除）；恢复后 7 passed、0 failed。 | `.scratch/nexus-v1/mutation-check-04.txt` | 同左 |
| 4 | “always answer in text” 来源未注明 | fixed | 由 `TextConnection` 把空回复当作 EMPTY_RESPONSE 错误所致（票 01 既有约束），行为不变；`src/realtime.ts` 的 `INSTRUCTIONS` 上方加注释，文档“未验证与边界”同步注明，语音票需重评。 | `src/realtime.ts` | typecheck |
| 5 | ui 测试与其它 patch 不一致；`DSH_AGENTS_HOME` 同一行重复 4 处 | 前半随 1 消失；后半 rejected | 开关删除后四个测试的 patch 重新一致。四处 spawn 各自独立构造 env，抽公共辅助会改动无关结构，且是步骤 0 的最小修复，故不处理。 | — | — |

修复轮 1 的检查（均在最终工作树上）：

```powershell
npm run typecheck
npm run build
npm test
git diff --check
```

结果：typecheck、build 通过；`npm test` 31 项，26 passed、0 failed、5 skipped（4 项真实模型 opt-in，1 项深层冷 opt-in）；`git diff --check` 无问题。受控 delivery 检查在最终套件中通过。回流逻辑本身未改，所以真实回流检查（`delivery-real-1791532007436`）未重跑。

## 修复轮 2

基线 reviewHead `50f94cc`。复审两轴均 changes_requested。

| # | 原问题 | 状态 | 理由 | 证据 | 检查 |
| --- | --- | --- | --- | --- | --- |
| 1 | 规格 P2：`src/results.ts` 排除以主管为 parent 的子会话，只靠原生 `subagent-settled`；该通知按 Activation 结算（`dsh-subagent/lib/index.js` 结算与运行中后续消息并入同一 Activation），不带轮次/消息身份，丢失错误码与消息，多轮只报最后一轮；README 的“任何工作会话……带会话与轮次身份”因此过度 | fixed | 核实属实：`.scratch/nexus-v1/delivery-controlled-1791532817388/result.json` 中子会话 `turn/end` 为 `error NO_ADAPTER`，原生通知只说 “failed before it finished … no closing message”。删除排除，中继对主管的子会话与其它会话一样按 `(sessionId, turn)` 投递；原生 settled 保留为 Activation 级结算，两层身份不同，不算重复。修复轮 1 第 2 条结论更正为被推翻。README 改为准确表述两层消息。 | 受控 Host：`.scratch/nexus-v1/delivery-controlled-1791533773245/result.json`（seq 110 中继 `nexus-work-result` Turn 1，seq 117 原生 settled，均被处理）；变异：把排除加回 `dist/results.js` 后 `tests/results.test.mjs` 6 passed、1 failed（新子会话用例），恢复后 7 passed，记录于 `.scratch/nexus-v1/mutation-check-04-r2.txt`。真实回流重跑 `.scratch/nexus-v1/delivery-real-1791533987483/result.json`（PID 89572）1 passed | delivery 受控期望改为 relay 1 + settled 1；results 用例改为子会话按轮投递（含 `NO_ADAPTER` 失败轮） |
| 2 | 标准 P2：`tests/restore.test.mjs` turn 断言放宽为“连续且 >= n”，处置表未说明 | fixed | 改为按场景精确断言：每个阶段的 worker 轮次各回流一次、各唤醒一次，normal/reload/race 的第二阶段 turn 精确为 `[1,2,3,4]`，interrupt/active-exit 为 `[1,2,3,4,5]`；另断言第二阶段主管日志中恰好两条 `nexus-work-result`，其 `(worker turn, supervisor turn)` 精确为 `[[1,1],[2,3]]` 或 `[[1,1],[2,4]]`。修复轮 1 的放宽没有在处置表说明，属遗漏，此处补记。 | 默认 `npm test` 中 restore 5 项通过（`restore-*-17915340*`） | 同左 |
| 3 | 标准 P3：restore 脚本模型只看“最后一条是否自动结果”，吞掉与结果同批的恢复用户输入 | fixed | 判定对齐 dispatch：本次请求的新条目（上次回答或最后一条 assistant 之后、去掉 runtime context）全部是自动结果时才只回文字并不计入 `requests`。结果：interrupt 第二阶段 turn 4（恢复出的 “Pending clarification” + 结果）按场景请求处理并计数，并断言该请求含该输入；active-exit 第二阶段 turn 4 新连接重放未获回答的 “Interrupted active request”，同样计数。因此 `requests` 精确期望：interrupt 4、active-exit 4、其余 2。 | `.scratch/nexus-v1/restore-interrupt-1791533897409`、`restore-active-exit-1791533907353` | 同左 |
| 4 | P3：`tests/profile.test.mjs` 硬编码 `connection !== 1` 切分 wire | fixed | 主管每个有请求的 turn 开一条连接、turn 结束关闭（`src/supervisor.ts`），所以按基线前 `step/start`（step 1）数得到基线前连接数，wire 按 `connection > opened` 切分；对服务端实际有往来的场景（missing/closed/timeout/real 之外）断言基线前连接确实承载 work-result 条目。 | profile 11 项通过 | 同左 |
| 5 | 标准 P3：`tests/restore-probe.js` if 块缩进不一致 | fixed | 仅缩进。 | — | — |
| 6 | 规格 P3 待核实（票 03 范围）：主管工具集含 `subagent_fork`，子会话继承 Realtime 型号后 `NO_ADAPTER` | 核实属实；**未决**（无最小合规修复） | 根因：rc.2 `dsh-subagent/lib/index.js` `parentAgentOptionsForDelegation`/`resolveChildAgentOptions`（约 :414-452）让子会话继承 parent 最新请求头的 provider/model，主管请求头如实为 `dashscope-realtime/qwen3.8-omni-flash-realtime`；该 provider 只是 Nexus 自己的 Realtime driver，没有注册 LlmAdapter，子会话 AgentLoop 第一步即 `NO_ADAPTER`。主管实际工具集（受控 `wire.json` 的 `session.update`）含 `subagent_fork` 与 `workflow`（均为 base preset 的 fork/spawn provider，`dsh-base/cordis.patch.yml` 约 :370-392），fork 按设计固定继承 parent 路由，base 的这两行未开启 `modelSelectionSettings`，模型无法改选路由。可选修复均不合规或超范围：改写主管请求头型号会伪造记录；为 `dashscope-realtime` 注册 LlmAdapter 等于把 Realtime 主管伪装成普通 worker 模型；改 preset 的 tool-subagent 配置属于用户/宿主配置；从主管工具集中删掉这些工具改变“使用用户配置全部能力”的票 01/03 能力面，属产品决策。本轮不扩大范围，记录于票 03 验证文档未决项。回流层面：这类失败现在会以 `Outcome: failed - NO_ADAPTER: …` 如实回到主管。 | `.scratch/nexus-v1/delivery-controlled-1791532817388/result.json`（子会话 descriptor `agentProvider: dashscope-realtime`，turn/end `NO_ADAPTER`） | 源码核查；无新增测试 |

修复轮 2 的检查（均在最终工作树上）：

```powershell
npm run typecheck
npm run build
npm test
git diff --check
node --test --test-name-pattern='official Host relays' tests/delivery.test.mjs
node --test --test-name-pattern='accurate Realtime' tests/delivery.test.mjs   # NEXUS_REAL_DELIVERY=1 与临时 NEXUS_DELIVERY_KEY 由包装脚本只读 provider.json 后放入子进程环境
```

结果：typecheck、build 通过；`npm test` 31 项，26 passed、0 failed、5 skipped（4 项真实模型 opt-in，1 项深层冷 opt-in），受控回流证据 `.scratch/nexus-v1/delivery-controlled-1791534012790/result.json`；`git diff --check` 无问题；受控 delivery 单独运行 1 passed（`delivery-controlled-1791533773245`）；真实回流 1 passed（`delivery-real-1791533987483`，准确型号：闲时结果唤醒后报告 `REPORT-RI-7731` 并调用 `nexus_send_session(user-existing, report-rerun)`，重跑结果回流后报告 `REPORT-RR-8842`；忙时先答 63，结果进入后补充 `REPORT-RB-5524`）。受控与真实证据如前分开：真实检查只证明准确型号的主管处理，worker 仍为受控 native adapter。

## 用户裁定（2026-10-09，票 05 修复轮 1 应用）

用户裁定 Nexus 只管理对话会话（普通会话）的 agent，会话 agent 产生的 subagent 会话 Nexus 不管。回流随之改变：`ResultRelay.observe` 对 `session.header.origin === 'subagent'` 的会话既不回流终态，也不同步用户输入（用户 fork 的普通会话有 `parentSession` 无 `origin`，仍回流）。这**改变了修复轮 2 第 1 条的结论**：主管自己的子会话不再由中继按轮投递，只剩原生 `subagent-settled` 结算通知送达其 parent（主管）；上文“主管自己的子会话”行与修复轮 2 第 1 条为当时的历史记录，未删除。受控 delivery 检查相应改为：`nexus-child` 中继 0 条、原生 settled 1 条且被处理；“每个终态恰好一条”只针对对话会话。relay 层 `tests/results.test.mjs` 对应用例改为 subagent 会话 0 条、用户 fork 会话按轮投递。证据与重跑结果见 `docs/nexus-v1/verification/05-user-steering-priority.md` 的修复轮 1。
