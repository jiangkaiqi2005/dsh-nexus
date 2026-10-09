# 票 04：全局工作结果回流验证

验证日期：2026-10-09。实施基线：`ebe2efc51d9ac809203a98321fe499727834db2f`（其后先有测试隔离修复提交 `8d50953`）。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 `~/.agents`、`~/.claude`。

## 实现与原生边界

`src/results.ts` 的 `ResultRelay` 在 Nexus 插件的上下文中订阅原生 `session/event` 提交后事件流（持久化、索引等官方插件使用的同一入口），覆盖所有进入原生 Session 存储的会话：Nexus 创建的、用户自己创建的普通会话、其它 subagent 会话都一视同仁，不要求直属或 Nexus 创建。每个 `turn/end` 是一个终态，来源可以是成功、失败（`error`）、中断（`aborted`/`interrupted`）或其它原生终态；终态原因原样进入结果。

- **内容**：消息包含会话身份（含是否 subagent 及其 parent、工作区）、轮次号与终态事件 seq、终态与失败代码/消息、该轮最后一条有文字的 assistant 消息的消息身份和文字。会话读取只扫描该轮自己的事件，不复制历史；超长文字保留头 2500 与尾 3500 字符并标明省略，提示用 `nexus_read_session` 读取记录。没有 assistant 文字时如实写明。
- **来源**：新的原生消息来源 `nexus-work-result`（`form: 'notice'`，带 `summary`、`sessionId`、`turn`、`terminal`、`terminalSeq`），区别于 `user` 与 `nexus-dispatch`；角色是 user 但来源不是用户，不伪造用户或 parent-agent。模型侧沿用现有“非用户来源附带 `[Context source: …]`”的投影，系统指令增加对该来源的说明：自动报告不是用户指令，由模型据用户目标决定汇报、读详情、追加、审查或停止；纯文字连接必须回应，无话可说时简短回应（空回复在 `TextConnection` 中本来就是错误，没有放宽）。
- **投递**：用原生 waking `steer` 入主管 inbox（`next-step`），与原生 subagent-settled 通知同一契约。主管闲时开启新 turn 并 claim；主管忙时留在 inbox，在当前请求结束后的下一个 step 边界（或下一轮）进入模型，用户输入走原有 `next-turn` 队列，两者互不覆盖。连接层没有写死任何动作顺序、迭代次数、必须汇报或必须追加。
- **身份与去重**：键为 `(sessionId, turn)`，同键只投递一次。重启时从主管原生日志里曾经入队的 `agent/inbox/spliced` 消息重建，所以重启后重复的终态不再投递；投递失败（主管不可用）会释放该键以便重试。主管自身会话不回流；以主管为 parent 的 subagent 会话不由本中继处理（原生 settled 通知已负责），避免双重投递。
- **接收与处理分开**：中继观察到终态是一回事；`agent/inbox/spliced` 入队是第二回事；请求时追加 `user/message` 并发送到模型传输层是“接收”；其后第一条 `assistant/message`（及其内容）才是“已处理”。验证对三者分别断言。
- **生命周期**：中继在主管可接收 inbox 后启动，teardown 时先于 `agent.stop()` 释放，不会在主管停止后继续投递。配置项 `deliverResults`（默认开启；仅 `false` 关闭）仅用于隔离不关心回流的早期票机制测试（票 01–03 的 Host 测试里，普通 worker 的终态会唤醒主管，改变这些测试专门断言的主管事件序列），不是产品需求；票 04 的所有检查均在默认开启下运行。

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
| 模型决定后续 | 脚本模型读到 `review-target` 的 FOLLOWUP 结果后调用 `nexus_send_session` 要求二次处理；worker 恰好两轮，第二个结果再次回流并被处理；其后没有再追加。迭代由模型决定。 |

### 受控（relay 层，真实原生 Session 事件）

`tests/results.test.mjs`，7 项，直接对 `ResultRelay` 输入由真实 `Session` 追加出的原生事件：终态字段与最终内容、仅引用结束的那一轮；重复 feed、整段快照回放、回放与实时结束交错、回放中新出现的轮次仅投一次；主管自身及其原生子会话排除、其它 subagent 保留且标注 parent；超长内容有界且保留头尾；重启后按主管日志重建身份；主管不可用时不消耗键、可重试；`start()` 订阅 `session/event` 且投递错误被约束。变异检查：去掉去重、去掉主管自排除后，对应用例确实失败。

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
- 所有 subagent 会话（Nexus 子会话除外）都会回流，包括 worker 内部辅助 subagent 的轮次；模型可据来源里的 parent 信息判断，但这可能增加主管请求量。未设计按类型过滤，因为 Spec 要求全局覆盖且由模型决定。
- 纯文字连接要求主管每次回应至少给出简短文字；“完全沉默”需要放宽 `TextConnection` 空回复错误，本票没有做。
- 用户指令优先、来自工作会话的用户引导同步（用户故事 24）、指令仲裁属于票 05；本票只保证用户输入与结果同时到达时都不丢。
- 票 03 的深层冷 subagent parent 直接派活（P2 cannot_fix）不受本票影响，仍需人工关注。
