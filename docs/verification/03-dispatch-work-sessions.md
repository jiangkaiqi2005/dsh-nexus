# 票 03：工作会话调度验证

验证日期：2026-10-08。实施基线：`ff3718691c1a2ecd9004f25792e6641287dd83a0`。使用已发布的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件，没有修改 Desktop、宿主源码或 Qiyu。

## 实现与原生边界

主管通过原生 agent preset、ToolRuntime、SystemPrompt 和 `assembleContextFor` 取得用户选择的完整能力。请求保存实际工具 schema、原生权限与运行时上下文；调度工具追加到这套能力，没有 Nexus 白名单、额外审批或全局 worker factory 替换。工具执行走原生 `agents.withInitiator` 与 ToolRuntime 的策略、执行和结果处理。受控检查实际调用非 Nexus 的原生 `read`，并验证原生策略拒绝工具时仍返回真实失败。

`nexus_list_sessions` 和 `nexus_read_session` 使用全局 SessionController；读历史使用原生有界分页，可继续读取较早记录，不激活目标。已有普通会话不要求成为 Nexus 子会话。新建要求明确工作区目录，走原生工作区、会话创建和普通 worker 工厂。投递创建带 `nexus-dispatch` 来源的原生消息，记录主管身份与工具 callId，直接走目标 agent 的 followup 或 steer，不调用普通用户 prompt 入口。停止使用原生 cancel/interrupt；模型依据目标选择会话、工作区、派活、引导和停止。

原生投递收据明确返回 `accepted: true, completed: false`。工作完成另看目标的实际工作产物、assistant 记录和原生 completed terminal，不能用收据推断完成。本票没有自动结果回流。

continuable 子会话采用已发布且有类型的 `@deepseek-ai/dsh-subagent/internal` Host adapter：`queueHostSubagentPrompt`、`steerHostSubagentPrompt`。它保留真实 parent authority、原生 manager residency/Activation 与 Nexus 来源，不读取私有 Symbol，也不将 Nexus 冒充 parent 或人类用户。相关 peer 依赖精确固定 `0.2.0-rc.2`；该 `@internal` 子路径是当前版本适配边界，后续宿主版本需重新核验契约。

本次证明了普通 parent 与 continuable child 同时冷却后，原生恢复同一 parent/child、保留 ownership 并实际执行。更深层的冷 parent 若自身也是 subagent，rc.2 通用 `resolveAgent` 拒绝独立恢复子会话，而现有 Host adapter 要求真实 parent agent；插件如实回填原生失败。没有构造空唤醒、隐式祖先任务或转交 ownership。模型可按真实目标先向可达祖先派有意义的工作，再在其存活时调度后代；本次没有验证这一多层场景，也不将它计为全部冷树可直接投递的证明。

## Realtime 工具闭环

准确模型为 `qwen3.8-omni-flash-realtime`，session 明确 `modalities: ['text']`。接收原始函数参数，原生 assistant、tool/call、tool/result 与各自 turn/step/attempt 关联。每次模型 response 单独提交 native stream，不将多个 response 混成一个已完成 stream。执行结果以原 `call_id` 的字符串 `function_call_output` 回填同一 WebSocket，再 `response.create` 取得文字续答。

每个原生 turn 持有一条连接。新 turn 或重启时，既有工具事实从原生日志以带身份的文字上下文重建；不重发旧云端函数调用，也不重新执行旧工具。本次实际端点接受 flat tools schema，保留端点已验证的 text-only 配置；没有未经验证改成新 SDK 文档的嵌套 schema。

早期尝试在新连接重放云端 callId 得到实际 `invalid_request_error`、`param=call_id`；已改为同连接回填并用真实模型通过。早期一次真实检查虽完成派活，但模型没有选择预期失败工具，检查按缺少失败事实报错；新增独立的真实用户失败目标检查，最终证据中存在失败工具结果及其文字续答。没有把这两次失败算作成功。

## 验证与证据

全部 Host 使用独立 `.scratch/nexus-v1/dispatch-*` 的 DSH_HOME/profile、`--no-open`、`windowsHide: true`，走官方 dsh CLI、base + web composition、真实原生会话、默认 AgentLoop 和压缩 journal。测试原生 worker 使用受控 WorkerAdapter，实际写工作区文件并产生原生完成记录；这是实际 native worker 执行证据，不是付费 DeepSeek worker 的真实项目交付验收。主管的真实模型检查使用实际 DashScope 服务。

| 检查 | 结果与范围 |
| --- | --- |
| 全局列读、已有普通会话 | 保留真实用户 `ANCHOR-19` 上下文，Nexus 不成为其 parent；来源为 Nexus 的目标实际执行并 completed。 |
| 新建 worker | 使用显式工作区与正常 factory，任务实际写产物且 completed；收据保持 completed false。 |
| 引导与停止 | busy worker 下一原生 step 消费 steer；模型选择 stop 后目标 aborted，保留原生队列语义。 |
| 完整能力与失败 | 非 Nexus 原生 read 实际成功；缺失会话、无效 JSON 参数和原生策略拒绝分别产生真实失败结果。 |
| 冷 continuable child | 证明 parent/child 原先均不存活，派活后同身份恢复并执行，durable parent 仍为原 parent，消息保持 Nexus 来源。 |
| 工具协议 | 13 次受控函数调用共用原始连接，全部匹配 callId 与原生 turn/step；实际准确型号完成已有/新建派活、失败结果和文字续答。 |
| 既有回归 | 票 01 取消先于 claim、keepInbox、turn stopping steer、初始化失败 writer 清理，票 02 恢复/竞争/中断/真实进程边界，以及 Edge headless 原生 UI 仍通过。 |

最终受控证据：`.scratch/nexus-v1/dispatch-controlled-1791466892880/result.json` 与同目录 `wire.json`。13 次调用的三个预期错误为缺失目标、无效 JSON 和原生策略拒绝；其余调用成功。结果含主管与目标原生事件，工作区含 worker 真实产物。

最终真实证据：`.scratch/nexus-v1/dispatch-real-1791466931812/result.json`，PID 89960，主管两轮均 completed 并释放资源。第一轮实际列读 `user-existing`、派发 `run-existing-real`、在指定工作区创建新会话派发 `run-new-real`，还实际尝试 `missing-target` 并收到失败；第二轮独立失败目标也收到同 callId 的 isError 结果和准确型号文字续答。原有 worker 两轮 completed，新 worker 一轮 completed，产物与 Nexus 消息来源分别断言。

```powershell
npm run typecheck
npm run build
npm test
node --test --test-name-pattern='accurate Realtime' tests/dispatch.test.mjs
git diff --check
```

最终 typecheck、build 和文档收束后的 `git diff --check` 通过；默认完整 suite 共 21 项：18 passed、0 failed、3 skipped（真实文字、真实跨进程恢复、真实调度默认跳过）。真实调度检查另行 1 passed、0 failed。运行真实检查需要临时 `NEXUS_DISPATCH_KEY`、`NEXUS_REAL_DISPATCH=1`，可选 `NEXUS_REAL_ENDPOINT`。此次只读已授权的 `C:\Users\25330\.qiyu\provider.json` top-level 凭据，密钥只进入临时进程环境和隔离 Host 原生 credentials 服务，不进入命令参数、profile、日志或源码。

用户已禁止 Computer Use。本票没有控制用户窗口、浏览器或工作中的 Desktop，没有给用户 profile 安装新包，没有读写其非空主管 journal。用户 Desktop 中的新版实际安装、冷恢复和调度尚未验收。语音、自动结果回流和多层冷 subagent parent 的直接投递不属于本次已通过的实证范围。

## 首轮评审与修复轮 1：未解决的深层冷投递

首轮 Standards 为 approve；Spec 为 changes_requested，唯一必修 P2 指向 `src/work-sessions.ts` 的 direct parent resolve。票 03 要求全部工作会话、不依赖直属关系，并要求指定已有会话时实际收到任务。上一节的单层双冷实证不能覆盖 direct parent 自身是冷 subagent 的情况；该发现成立，本轮处置为 **cannot_fix**，不是 rejected，也没有将票 03 宣告完整通过。

定向回归由官方 Host 创建普通 `deep-root` → continuable `deep-parent` → continuable `deep-grandchild`。两层 child 均先完成初始化，再通过原生 manager drain 冷却；root 仍存活。主管依次全局列读、读取孙会话、直接调用 `nexus_send_session(sessionId=deep-grandchild, text=run-deep-grandchild)`，没有额外向祖先投递任务。

最终证据为 `.scratch/nexus-v1/dispatch-deep-cold-1791467833523/result.json` 和同目录 `wire.json`，输出保存在 `.scratch/nexus-v1/deep-cold-red-final.txt`。目标验收断言要求 `isError: false`，实际是 `isError: true`，原生错误为 `session "deep-parent" is owned by subagent routing`，**1 failed、0 passed，进程退出码 1**。parent/grandchild 均 inactive，durable parent 仍分别为 deep-root/deep-parent，两者的 Nexus 调度消息均为 0；原来初始化 completed 不被算成这次任务执行。主管收到第 3 次调用的真实失败结果并完成文字失败续答，释放身份/writer，没有隐式唤醒 parent。

复现这条仍为红色的规格验收：

```powershell
$env:NEXUS_DEEP_COLD = '1'
try { node --test --test-name-pattern='deep cold' tests/dispatch.test.mjs }
finally { Remove-Item Env:NEXUS_DEEP_COLD }
```

该测试明确 opt-in，仅避免已知未满足的验收阻断其他场景；gating 不代表通过。修改探针后的相关文件检查 `node --test tests/dispatch.test.mjs` 为 1 passed、2 skipped（真实模型、深层冷验收）。上一节完整 21 项/18 passed/3 skipped 的证据来自实现提交 `f82f79e52333d4d4d57f8fc4807c3b1976fa36d1`；本轮没有重跑完整 suite 或付费模型，也没有声称新增红测后的完整 suite 已绿。

当前发布 rc.2 的精确接口证据：

| 入口 | 发布源码/类型位置与限制 |
| --- | --- |
| SessionController.resolveAgent | `dsh-api-session-controller/lib/types/index.d.ts:66` 明确 ordinary Session。`agent.js:107` 对 origin=subagent 判定路由所有权，`:120` 返回 session/agent-busy；`:435` 的 resumeObserved 同样拒绝该身份。inspect/list/page/follow 仅观察，没有 activate 方法。 |
| 官方 Host queue/steer adapter | `dsh-subagent/lib/types/internal.d.ts:46`、`:57` 都要求 exact live direct parent；internal 子路径仅提供投递，没有不驱动 parent 的物化入口。 |
| 远程 subagent.prompt | `dsh-subagent/lib/types/index.js:282` 要求 parent 已 live；`:286` 创建 kind=user 来源，不能用于 Nexus 来源适配，也不能恢复冷 parent。 |
| manager cold resume | `dsh-subagent/lib/types/continuation.d.ts:37` activations 与 `:111` coldResume 均 private；`continuation.js:338` 的 coldResume 后必经 `:382` submitMaterialized，物化与消息投递绑定。Runtime 的 continuations 自身也 private（index.d.ts:119）。 |
| AgentRegistry.resume | `dsh-agent/lib/types/index.d.ts:112` 支持 parentAgent，但 `:133` 起明确 handle 归调用方持有。manager 的实际恢复另外通过自己的 ownerCtx（continuation-activation.js:451），建立 inbox/ancestry/pool/observer 并登记 resident（:482）。没有已发布 Runtime adoption/materialize API 将外部 handle 纳入同一 manager。仅调用 registry.resume 再把 parent 当作 manager-owned，会改变 native lifecycle ownership。 |

源码对应 node_modules 中精确 `0.2.0-rc.2` 发布包；图索引不覆盖这些符号后才回退读取发布源码。没有使用 private fields、另建 continuation manager、虚构 Symbol、空消息唤醒、parent 来源冒充或修改 Host 来绕过约束。

最小后续适配范围建议：保留当前普通全局会话、live 子会话和普通冷 parent→冷 child 的已验证能力，将更深层冷 parent 的直接派活延后到宿主提供保持原 manager ownership 且不驱动 parent 的 typed Host activation/delivery 适配入口时完成。此方案会缩小原票 03 的全部会话要求，不能据此宣告原票验收通过；目前没有改 Spec/ticket，P2 必修仍未解决。本轮按用户要求在票 03 流程结束后停止，不开始票 04。
