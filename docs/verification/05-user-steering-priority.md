# 票 05：用户途中修改要求验证

验证日期：2026-10-09。实施基线：`b01375b`（票 03/04 收尾提交；其父提交 `ad82e1a` 为票 05 unitBase）。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码、Qiyu 或用户 `~/.agents`、`~/.claude`。

范围：按 2026-10-09 用户裁定，Nexus 只管理、调度**对话会话**（普通会话，含用户 fork 出的会话）的 agent；会话 agent 产生的 subagent 会话（`header.origin === 'subagent'`）不在 Nexus 管理范围内，既不回流结果，也不同步其中的输入（提交 `c704f46`，见文末修复轮 1）。

## 实现与原生边界

用户改变要求有两条入口，都依靠来源、上下文与原生 steer，不加指令版本仲裁、意图分类或自动取消。

- **用户在主会话改要求**：没有新的 Host 机制。主管系统指令（`src/realtime.ts` 的 `INSTRUCTIONS`）说明：用户在工作进行中改变要求时，由主管判断受影响的工作会话，并用 `nexus_send_session` 转告（说明是用户改变的要求）；运行中的会话以原生 steer 在下一个 step 边界收到，它不撤销已完成动作，也不立即中断正在执行的工具；只有用户目标需要时才停止会话。`nexus_send_session` 对运行中目标走原生 `steer`、对闲置目标走 `followup`（票 03 已有），消息来源仍是 `nexus-dispatch`。
- **用户直接在工作会话输入**：`src/results.ts` 的中继在已有的原生 `session/event` 订阅上，增加观察其它对话会话的 `agent/inbox/spliced` 插入。被同步的是 `kind: 'user'` 的消息——在对话会话中，这就是用户自己的输入，无论经哪个 Host 入口（浏览器输入框背后的提示 RPC 带 `rpcId`；SDK、ACP、headless 入口不带）。Nexus 派活（`nexus-dispatch`）、agent 间消息（`agent-message`）、结果通知（`nexus-work-result`、`subagent-settled`）各有自己的来源，不同步；subagent 会话整体不观察；主管自己的会话不同步，因此不会回环。
  - 同步消息使用新的原生来源 `nexus-user-input`（`form: 'notice'`，带 `summary`、`sessionId`、`messageId`（工作会话中用户消息的原 id）、`target`（`next-step` 为运行中引导，`next-turn` 为排队）与内容摘要 `digest`）。角色是 user，但来源既不是 `user`（不冒充用户在主会话说话），也不是 `nexus-dispatch` 或 `nexus-work-result`。正文写明“用户在该工作会话里直接输入，不是在主会话里说的，也不是你的派活或自动结果”、会话身份与工作区、进入方式、用户消息 id 与内容（过长截取头尾）；说明该输入已在该会话队列中、不需重发，用户在工作 agent 读到前仍可编辑或删除排队输入；并提示主管把它当作该会话当前的用户要求，据此更新后续安排（派活、审查、汇报），而不只是复述。
  - 时点选在**入队（admission）**而非工作 agent 领取：用户在运行中会话排队一条新要求时，主管先于该会话旧轮次的结果得知变化。工作 agent 实际何时读到，看其自身日志中该消息所在的 step。
  - 去重键为 `(sessionId, messageId, digest)`：排队消息被移为 steer（同一消息再插入）不重复；用户编辑排队消息（同 id、新内容）会再次同步并注明是编辑；重启时从主管日志中曾入队的 `nexus-user-input` 重建，不重复；主管不可接收时不消耗键。只同步插入，不同步用户删除排队消息。
  - 投递沿用票 04：原生 waking `steer` 入主管 inbox。主管闲时开启新 turn；忙时留在 inbox，在当前请求结束后的下一个 step 进入模型，与用户主会话输入、工作结果互不覆盖。
- 主管系统指令同时说明：`nexus-user-input` 是用户对该会话的明确指令，优先于主管早先的派活，主管据此更新后续安排；要求改变前已运行轮次的结果是早先工作的报告，不是新指令。

工作 agent 侧没有改动：原生 AgentLoop 在下一个 step 领取 next-step 输入；Nexus 不改写其行为。

## 验证

所有 Host 子进程使用独立 `.scratch/nexus-v1/steering-*` 的 DSH_HOME/DSH_AGENTS_HOME/profile、`--no-open`、`windowsHide: true`，经官方 dsh CLI、base + web composition、真实原生会话、默认 AgentLoop 和压缩 journal。

工作会话是**受控 native WorkerAdapter**（`tests/steering-probe.js`）：每轮第 1 步是一个“长”模型步（等待到该会话出现 next-step 输入，或被探针放行），以原生 `read` 工具调用结束；工具返回后的下一步读取该会话全部 user 角色输入，按最新一条点名主题的输入取主题（同一条里新出现的标记优先，例如“改用 AMBER，不要 BLUE”取 AMBER），写入工作区产物 `<session>.txt` 并回复 `Built <session> with <主题> (the build step began with <第 1 步时的主题>)`。所以 worker 的后续行为确实取决于它在后续 step 读到的内容，但“理解”是固定规则，不是付费 DeepSeek worker 的理解。

### 受控（脚本化主管模型，原生 worker 与原生事件）

`tests/steering.test.mjs` 受控检查，修复轮 1 最终证据 `.scratch/nexus-v1/steering-controlled-1791547130817/result.json`（PID 81384，含主管原生日志、各 worker 日志、产物、`wire.json`；修复前为 `steering-controlled-1791535457874`）。脚本模型只执行场景点名的派活，其余回复它看到的标记。

| 场景 | 断言 |
| --- | --- |
| A：主管闲、用户在主会话改要求 | 用户说改用 THEME-AMBER 后，主管调用 `nexus_send_session(alpha)`，工具结果 `delivery: steer`；alpha 日志中该 `nexus-dispatch` 消息位于 turn 1 step 2（运行中轮次的下一个 step），step 1 的原生 `read` 先正常完成（steer 没有中断工具）；alpha 最终回复与产物为 THEME-AMBER，起始为 THEME-BLUE；结果回流含 AMBER。派活没有产生任何 `nexus-user-input`。 |
| B：主管闲、用户直接 steer 运行中 worker | `sessionController.prompt(beta, mode: steer)`：beta 日志中用户消息（`kind: user`）位于 turn 1 step 2；主管日志中 `nexus-user-input` 的 `messageId` 等于该消息 id、`target: next-step`，在主管无 turn 时入队并使其开启新 turn，模型回应含 THEME-CRIMSON；beta 最终为 CRIMSON；该同步先于 beta 结果入队。 |
| C：主管忙时交错（旧结果 + 新要求） | 主管正处理用户输入 HOLD-BUSY（脚本持有 2.5 秒）；用户向运行中的 gamma 排队“Then rebuild it with THEME-JADE”，随后 gamma 旧轮次结束。`nexus-user-input`（`next-turn`）与 gamma turn 1 旧结果（THEME-BLUE）都在忙 turn 内入队、顺序为同步在前；HOLD-BUSY 的回复先完成，二者在同一 turn 的后续 step 进入模型，没有挤掉用户请求；旧结果正文标明“不是用户指令”；gamma turn 2 在 step 1 领取 JADE 输入，结果为 THEME-JADE，再次回流并被处理；产物为 JADE。 |
| 来源与排除 | 全程恰好两条 `nexus-user-input`（beta、gamma），每条都有对应的模型可见 `user/message` 与其后的回应；四次 Nexus 派活与主管自身输入均未同步。全部主管 turn completed。 |

### 受控（relay 层，真实原生 Session 事件）

`tests/results.test.mjs` 共 12 项，其中票 05 的 5 项：steer 与排队两种入队方式的来源字段与正文；只同步对话会话中 `kind: user` 的输入——浏览器提示 RPC（带 rpcId）与 SDK 等入口（无 rpcId）的输入都同步，排除主管自身、`nexus-dispatch`、`agent-message`、subagent 会话（含其中的用户 composer 输入与委派任务）、领取 splice 与 `user/message` 副本；排队移为 steer 只同步一次、编辑再同步并注明、重启后不重复也不遗忘编辑身份；新要求与旧结果按入队顺序且来源不同；主管不可接收时不消耗。

变异检查（改写编译产物 `dist/*.js` 后跑对应测试，再恢复并重新 build），修复轮 1 记录于 `.scratch/nexus-v1/mutation-check-05-r1.txt`（修复前为 `mutation-check-05.txt`）：

| 变异 | 结果 |
| --- | --- |
| A 关闭同步 | results 7 passed、5 failed |
| B1 仍要求 rpcId（修复前规则，SDK 入口输入漏同步） | results 11 passed、1 failed |
| B2 去掉 kind 判断（任何插入都同步） | results 11 passed、1 failed |
| C 去掉按版本去重 | results 11 passed、1 failed |
| D 去掉主管自排除 | results 10 passed、2 failed |
| E 中继不排除 subagent 会话 | results 10 passed、2 failed |
| F 会话工具不拒绝 subagent 目标 | dispatch 受控检查 failed |
| G 会话列表不过滤 subagent | dispatch 受控检查 failed |

恢复后 `npm run build` 重建，`dist/results.js` 中 `isDirectUserInput` 为 `message.source.kind === 'user'`，results 12 passed、0 failed。

### 真实模型（准确型号 `qwen3.8-omni-flash-realtime`，受控 native worker）

opt-in：`NEXUS_REAL_STEERING=1` 与临时 `NEXUS_STEERING_KEY`（可选 `NEXUS_REAL_ENDPOINT`）。凭据由临时包装脚本只读授权的 `C:\Users\25330\.qiyu\provider.json` top-level `apiKey`，仅放入子进程环境和隔离 Host 原生 credentials 服务，不进入命令参数、profile、日志、文档或源码；运行后扫描证据目录与输出，未出现该密钥。

```powershell
node --test --test-name-pattern='accurate Realtime' tests/steering.test.mjs   # 带上述环境
```

**修复轮 1 最终运行**（自然语言场景）：1 passed、0 failed，`.scratch/nexus-v1/steering-real-1791547189152/result.json`（PID 99084）。主管 5 个 turn 均 completed，全部 assistant 消息为该准确型号。

1. 用户在两个已有普通会话里直接布置任务：site-worker“搭建公司官网首页，配色用蓝色主题 THEME-BLUE”，doc-worker“编写后端 API 参考文档”（两条都经 Host 提示入口，主管各收到一条 `next-turn` 的 `nexus-user-input`）。两个 worker 停在第 1 步。
2. **主会话自然语言改要求**：用户对主管说“官网首页的配色我改主意了，换成琥珀色吧（主题标记 THEME-AMBER）。做完告诉我结果。”——没有点名会话、工具或要转告的话。模型先 `nexus_read_session(site-worker)`，再自行判断受影响的是 site-worker，调用 `nexus_send_session(site-worker, "用户刚改需求：官网首页配色从蓝色 THEME-BLUE 改为琥珀色 THEME-AMBER……")`。**doc-worker 没有收到任何 Nexus 派活**。site-worker 日志中该 `nexus-dispatch` 位于 turn 1 step 2，原生 `read` 先成功；最终 `Built site-worker with THEME-AMBER (the build step began with THEME-BLUE)`，产物 AMBER。结果回流后模型汇报“官网首页已按最新需求完成，配色采用琥珀色主题 THEME-AMBER……”。
3. **工作会话直接引导**：探针以 Host 提示入口（`mode: steer`、`requestId: real-direct-steer`）向运行中 doc-worker 输入“文档里的代码示例改用 THEME-CRIMSON 配色。”主管闲置时收到 `nexus-user-input`（`target: next-step`，`messageId` 与 doc-worker 日志中的用户消息一致）并开启新 turn。随后用户在主会话问“doc-worker 现在的要求是什么？是谁提出的？”，此时 doc-worker 仍被扣住、结果未到，模型回答“doc-worker 当前要求是文档里的代码示例改用 THEME-CRIMSON 配色，由用户提出。”——用户没有在主会话重复。
4. 放行后 doc-worker 在 turn 1 step 2 读到该引导，最终以 `Built doc-worker with THEME-CRIMSON` 开头，产物 CRIMSON；结果回流后模型回答“doc-worker 当前要求是编写后端 API 参考文档，且文档中的代码示例使用 THEME-CRIMSON 配色；这是由用户提出的。”

如实记录的模型表现：本次运行中，模型对 doc-worker 直接引导同步的**即时回应**仍只是重复了上一条 site-worker 结论（与修复前两次运行相同），没有专门复述 doc-worker 的变化；变化保留在上下文中，并在其后的提问回答与结果汇报中正确使用。对步骤 1 的两条任务同步，模型的即时回应是读取 site-worker 状态与确认 doc-worker 任务。真实检查只证明准确型号主管对来源、受影响会话与变化的处理；worker 仍是受控 native adapter。

修复前（rpcId 规则、主会话指令点名会话）的两次运行 `steering-real-1791535388726`（PID 77556）、`steering-real-1791535511068`（PID 84780）均 1 passed，作为历史记录保留；那两次用户直接说“site-worker 改用 THEME-AMBER……立刻转告它”，不能证明模型自行判断受影响会话，因此修复轮 1 改为上面的自然语言场景。

### 回归调整

对话会话中的 `kind: user` 输入都会同步给主管，旧检查中凡以用户来源给 worker 发过消息的都会多一次主管唤醒：

- `tests/restore.test.mjs` / `restore-probe.js`（票 05 实施时）：恢复探针的 worker 每阶段经 `sessionController.prompt` 收到一条输入。受控 worker 改为在主管处理完该同步后才回复，因此同步与结果各占一个确定的主管 turn；脚本模型把“只含自动结果或同步通知”的请求当作非场景请求。断言按场景精确更新：第二阶段 turn 为 `[1..6]`（interrupt/active-exit `[1..7]`），结果 `(worker turn, supervisor turn)` 为 `[[1,2],[2,5]]`（或 `[2,6]`），同步恰好两条、分别在 turn 1 与 4（或 5），重启不重复第一条；`requests` 数不变。
- `tests/dispatch.test.mjs`（修复轮 1）：已有会话中无 rpcId 的用户任务现在也同步；脚本模型把只含自动结果或同步通知的请求视为非场景请求，不推进派活计划。
- `tests/delivery-probe.js`（修复轮 1）：忙场景 worker 的用户任务会同步给主管；受控与真实分支在开始忙场景前等主管处理完该同步，忙场景本身的断言不变。
- profile、ui 检查无需改动，在默认配置下通过。

### 命令与结果（修复轮 1 最终代码）

```powershell
npm run typecheck
npm run build
npm test
git diff --check
node --test --test-name-pattern='accurate Realtime' tests/steering.test.mjs   # NEXUS_REAL_STEERING=1 与临时 NEXUS_STEERING_KEY
node --test --test-name-pattern='accurate Realtime' tests/delivery.test.mjs   # NEXUS_REAL_DELIVERY=1 与临时 NEXUS_DELIVERY_KEY
node --test --test-name-pattern='accurate Realtime' tests/dispatch.test.mjs   # NEXUS_REAL_DISPATCH=1 与临时 NEXUS_DISPATCH_KEY
```

- typecheck、build 通过；`git diff --check` 无问题。
- 默认 `npm test`：37 项，32 passed、0 failed、5 skipped（真实文字、真实跨进程恢复、真实调度、真实回流、真实引导五项 opt-in；票 03 深层冷红测已按裁定删除）。受控证据：`steering-controlled-1791547130817`（PID 81384）、`delivery-controlled-1791547130763`（PID 77360）、`dispatch-controlled-1791547130773`（PID 90696）。
- 真实引导 1 passed（`steering-real-1791547189152`，PID 99084）；真实回流 1 passed（`delivery-real-1791547238877`，PID 100152）；真实调度 1 passed（`dispatch-real-1791547257687`，PID 77328）。三次运行后扫描证据目录与输出，未出现密钥。

## 验收对照

| 票 05 验收项 | 状态 | 依据 |
| --- | --- | --- |
| 主会话改变要求时，主管理解并向相关工作会话投递原生 steer 或按上下文安排 | 满足（真实 + 受控） | 真实第 2 步：用户未点名会话，准确型号自行判断只转告 site-worker，doc-worker 无派活，worker 下一 step 领取；受控 A。 |
| 工作会话中的直接引导同步给主管，保留真实用户来源，与 Nexus 调度和自动结果区分 | 满足 | `nexus-user-input` 指向工作会话原用户消息（`kind: user`，任何 Host 入口）；受控 B/C、relay 层 SDK 入口用例、真实第 1、3 步；派活不同步。 |
| 运行中工作 agent 在后续模型步骤读取新要求，后续行为反映新要求；主管结果与安排也反映 | 部分满足 | 读取时点满足：各 worker 日志 step 2 领取，主管回答与汇报使用新要求（真实）。“后续行为反映新要求”只由受控 adapter 的固定规则体现，未用真实 worker 模型验证。 |
| 主管忙时和闲时均能处理直接引导，用户不必重复输入 | 满足 | 受控 B（闲，开启新 turn）、C（忙，同 turn 后续 step）；真实第 3 步无需在主会话重复。 |
| 旧结果与新要求交错时都保留，不把旧结果当新命令 | 顺序与来源满足；模型判断未验证 | 受控 C：两者都入模型、按入队顺序、来源可辨、旧结果标明非用户指令。脚本模型不能证明模型判断，真实检查未制造旧结果与新要求的交错。 |
| 不引入自动取消或版本规则；停止由 agent 选择原生能力，不保证立即中断工具 | 满足 | 没有新增取消、仲裁或分类逻辑；steer 不中断正在执行的 `read`（受控 A、真实第 2 步）；停止仍是票 03 的 `nexus_stop_session` 由模型选择。 |
| 真实演示一次执行中改要求及最终结果；可控输入覆盖忙时交错，验收观察行为 | 满足（worker 为受控 adapter） | 真实自然语言场景通过；受控断言 worker 实际产物、日志 step 位置与主管模型可见消息，而非只看队列。 |

## 未验证与边界

- 用户 Desktop 中的新版安装与实机引导未做；全程没有 Computer Use，没有控制用户窗口或浏览器，没有给用户 profile 安装包。真实浏览器输入框的人工输入没有直接驱动；探针调用的是同一 Host 提示 RPC 入口（`sessionController.prompt`），浏览器输入框经该 RPC 到达。
- worker 是受控 native adapter，不是付费 DeepSeek worker；“按新要求调整”由固定规则体现。
- 同步覆盖 Nexus 运行期间入队的输入，不回溯启动前；用户删除排队消息不另行同步（之后的实际结果与 `nexus_read_session` 可见）。
- 以 `kind: 'user'` 判定对话会话中的用户输入：其它插件若以 user 来源向对话会话注入消息，也会被同步（Host 来源模型本身不区分程序调用，见 `docs/user-instruction-priority.md`）；Nexus 自己的投递用 `nexus-dispatch`，不同步。
- 每条用户直接输入都会唤醒主管一次（包括与 Nexus 无关的对话会话），增加主管请求量；按 Spec 全局观察、由模型判断，没有设计过滤。
- 真实运行中模型对直接引导同步的即时回应质量一般（见上文），之后的回答与汇报正确。
- subagent 会话（会话 agent 产生的子会话、主管原生 fork/workflow 子会话）按 2026-10-09 用户裁定不在 Nexus 范围内（不适用）：其中的输入与结果不同步、不回流；票 03 两项原 P2（深层冷 subagent parent、原生 fork/workflow 子会话）同样为不适用。

## 修复轮 1

评审基线 `61fc45d`（两轴 changes_requested），unitBase `ad82e1a`。按 2026-10-09 用户裁定（Nexus 只管理对话会话的 agent，会话 agent 产生的 subagent 会话不管）处理。

| 项 | 处置 | 提交 |
| --- | --- | --- |
| A1 中继范围 | 以 `header.origin === 'subagent'` 排除 subagent 会话的回流与输入同步；用户 fork（只有 parentSession、无 origin）仍是对话会话，照常回流。results 测试反转为 subagent 0 条、fork 按轮投递；delivery 的主管子会话只剩原生 settled；README、票 04 文档按裁定更新并保留历史。 | `c704f46` |
| A2 会话工具范围 | list 过滤 subagent 会话；read、send、stop 对 subagent 目标返回明确失败；删除子会话 Host adapter、`dsh-subagent/internal` 引用与 peer 依赖；CONTEXT 定义“工作会话”为对话会话；dispatch 的冷子会话改为断言被拒且无投递，删除深层冷红测。 | `c704f46` |
| A3 文档口径 | 票 03/04/05 文档中深层冷 P2 与 fork/workflow 子会话改为“按 2026-10-09 用户裁定不在范围（不适用）”；删除“主管缺 subagent 工具待核实”；INSTRUCTIONS 与 README 去掉缺陷口吻，改为通过 nexus 会话工具委派对话会话。 | `c704f46`、本轮（票 05 文档） |
| B4 直接输入判定 | 改为 `kind === 'user'`，不再依赖 rpcId；新增 SDK 入口（无 rpcId）用例；变异 B1/B2 各失败 1 项；dispatch、delivery 检查按新增同步调整。 | 本轮 |
| B5 真实自然语言检查 | 两个 worker（相关/无关），主会话改要求不点名会话、工具或转告内容；准确型号只转告 site-worker，doc-worker 无派活；1 passed。即时回应质量如实记录。 | 本轮 |
| B6 通知措辞 | 改为“已在该会话队列中、不需重发；用户在读到前仍可编辑或删除”，并提示主管更新后续安排（派活、审查、汇报）而不只是复述。 | 本轮 |
| B7 验收对照 | “后续行为反映新要求”改为部分满足；“不把旧结果当新命令”改为顺序与来源满足、模型判断未验证。 | 本轮 |
