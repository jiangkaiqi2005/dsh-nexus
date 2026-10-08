# 票 01 实施与验证记录

验证日期：2026-10-08。当前状态：已实现可评审文字切片，完成首轮评审修复，受控验证和准确型号真实文字轮次通过；0.1.0 已经官方 CLI 安装到用户 Desktop，修复包更新及界面验收未完成，票 01 尚未完成。

## 当前兼容基线

用户在实施过程中明确选择开发插件、直接使用现有 Desktop，并要求保持当前 Desktop 版本、后续再适配其他版本。当前生产与测试依赖因此统一固定为 Harness `0.2.0-rc.2` 和 Cordis `4.0.4`；这覆盖 Spec 中历史 alpha.1 技术基线。本次未修改 Desktop 程序、资源、宿主核心或 Qiyu。

实际 Desktop 为 `D:\DeepSeekHarness\DeepSeek Harness.exe`，版本 `0.2.0-rc.2`。只读内嵌包 metadata 核对：dsh、agent、session、session-persistence、credentials 均为 `0.2.0-rc.2`，Cordis 为 `4.0.4`。安装使用该 Desktop 自带 CLI，不能用 npm CLI 管理保留的 desktop profile。

曾以研究基线 alpha.1 运行最早受控探针；其结果仅保留在忽略的 `.scratch/nexus-v1`，不作为当前 Desktop 或 rc.2 验收依据。切到 rc.2 后重新安装完整精确依赖并核对发布包声明；公开 Agent/Inbox、Session prepare/enter/announce、写句柄与 credentials 契约仍可承载此切片。

## 已实现行为

- ESM bundle、Host 入口、客户端固定侧栏按钮、中英文插件 metadata 与原创 SVG 图标。
- 主管的 Agent 与 Session 同为 `nexus-supervisor`；直接消费 Realtime 文字响应，不转交第二主管，不替换默认工作 factory。
- Host 每轮通过原生 credentials 解析引用。text-only 会话握手成功后重放原生已记录历史并请求回复；音频事件或失败终态不会变成成功消息。
- 原生 inbox splice 与消息来源、turn/step、request/header、system/user/assistant 消息、实时 assistant stream 与失败 attempt；持有原生独占写句柄，卸载按停止驱动、关闭写句柄、注销身份及 scope 的顺序释放。
- 未配置凭据、连接关闭、超时、响应失败均记录真实 `turn/end` error；失败不产生假 assistant/message。

连接在文字请求间可重建，每次从当前原生记录恢复请求上下文。此处没有新增会话数据库，也没有重启后的自动续跑。恢复已有主管记录属于票 02；本切片遇到已有同身份持久记录明确拒绝创建，避免误用默认 worker 恢复主管。

## 当前证据

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| rc.2 类型检查与编译 | 通过 | TypeScript 5.9.3，Node 24.15.0 |
| 官方 dsh profile 加载本地 bundle | 通过 | 独立 `.scratch/nexus-v1` profile，默认 base + web-app，实际 Host，受控 WS endpoint |
| 主管身份与原生文字轮次 | 通过 | SessionController.prompt 经原生 admission/inbox；用户与主管文字落盘，seq 连续，重复 request 不新增轮次 |
| 默认 worker factory 保持原生执行 | 通过 | 默认 AgentLoop 创建普通 agent，独立受控 LLM adapter 产生普通回复；无真实 worker 模型调用 |
| 重复身份与写所有权 | 通过 | 重复 registry identity、并行 write open 拒绝；Nexus 卸载后身份注销、重新取得独占写权、读取关闭后的完整记录 |
| 失败行为 | 通过 | CREDENTIAL_MISSING、CONNECTION_CLOSED、TIMEOUT、RESPONSE_FAILED；后者保留失败 attempt，不登记假完成 |
| 准确型号真实端点调用 | 通过 | 用户明确提供的本地 provider.json 配置，经临时 Host credentials 引用调用；实际回复“Nexus 已接入”，卸载后重新开写句柄读取原生日志 |
| 用户 Desktop 安装 | 首包通过 | 0.1.0 打包文件经 Desktop 自带 CLI 安装，exit 0；实际 Desktop 重开生成固定主管的原生 header。0.1.1 修复包尚待更新 |
| 用户 Desktop 原生界面与文字轮次 | 未验证 | 侧栏按钮、消息投影、插件 metadata 与 SVG 的实际呈现仍需实机查看；原生 managed credentials 已配置默认引用，不能以独立 profile 的真实调用代替实机验收 |

受控端点仅替代外部模型，Host、默认 worker factory、SessionController、projection 和压缩 JSONL persistence 均使用 rc.2 产品 composition。测试没有用临时拼装 Context 代替官方 profile。模拟响应和原生实际落盘是不同层次的证据，不能将前者称为真实模型通过。

真实调用证据：首包 `.scratch/nexus-v1/real-1791458748463/result.json`，修复后 `.scratch/nexus-v1/real-1791460173067/result.json`。所用型号为 `qwen3.8-omni-flash-realtime`，端点为 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，仅输出文字。用户提供的 `C:\Users\25330\.qiyu\provider.json` 只读；密钥仅传入验证进程的临时环境，再由 Host credentials 读取，不写入插件、profile、日志或此文档。

## 首轮评审修复

- S1 与规格取消边界：在 claim 前检查 abort，取消清除本轮已有 wake 请求；保留 queued/steering 时不把它们写成已消费用户消息。空取消轮次仍记录原生 turn/start 与 aborted turn/end，取消后的新输入在新 signal 与下一 turn 执行。
- S2：每次文字回复后先检查 abort，等待 turn-stopping 后再次检查 abort 与 steering；停止监听器新增 steering 在当前 turn 的下一 step 执行。
- S3：取得 native writer 后立即挂保底关闭 disposer，在正常关闭 disposer 注册后转交所有权；正常卸载维持 stop/idle → writer close → registry/session/scope。插件 apply 等待异步 effect setup，使启动失败可由官方生命周期观察。

新增六个公开边界回归：提前 cancel 保留两种队列、取消后替代输入、提前 stop、turn-stopping steering、turn-stopping cancel、prepare/create/enter 之间竞争身份导致启动失败。测试仍通过真实官方 profile 和原生存储执行；竞争身份通过公开 Cordis 生命周期与 Session prepare/enter 发布，没有替换 persistence 服务。旧实现六项均复现失败；其中 writer 泄漏先表现为重新 open write 的 SessionAlreadyOwnedError，最终回归在同身份 create 时表现为 SessionAlreadyExistsError（旧 pending owner 未释放）。修复后重新 create、flush、close、open write、read 均通过，竞争 Session 未被覆盖。

首轮修复只覆盖票 01，不接入票 02 的重启恢复。协调者只读检查当前 Desktop journal，仅含 header、无事件行。修复包实机首次创建验收需要先正常退出 Desktop，完整备份并隔离该空测试 session 目录，保留原件与检查证据；任何用户/assistant/tool/pending 记录非空时不得用此重置。此操作尚未执行，且不能算恢复验收。

初期两个环境候选均返回 HTTP 401，日志如实记录失败。有效配置首次握手成功但产生 `COMMON_ERROR`：参考 Qiyu 已实际验证的协议，补齐该端点在纯文字模式也要求的 `voice=Tina`、`input_audio_format=pcm16`、`output_audio_format=pcm24`、`input_audio_transcription.model=gummy-realtime-v1`，使用裸 `response.create`，真实轮次随后通过。输出模态仍严格为 `['text']`；收到音频输出会判为失败。这是当前实际端点的验证结论，不承诺其他地域端点 schema 相同。[官方客户端事件](https://help.aliyun.com/en/model-studio/client-events)的 text-only 支持与上述旧端点必要字段差异仍需按实际配置核对。

## 复现命令

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm pack
```

受控完整套件结果：11 passed，真实调用用例默认 1 skipped。真实调用修复后单独执行，1 passed。测试保留每次独立 profile 与原生 read-handle 输出在 `.scratch/nexus-v1/<scenario>-<timestamp>/result.json`。打包文件清单包含 dist 全部运行模块、client.js、patch、locale 和 icon；不包含源码测试、验证 profile 或凭据。

仅在已确认可用的 Host 配置下运行真实用例，变量只传凭据引用与非密钥端点：

```powershell
$env:NEXUS_REAL_TEST = '1'
$env:NEXUS_REAL_CREDENTIAL_REF = '<原生凭据引用名>'
$env:NEXUS_REAL_ENDPOINT = '<适用地域或 Workspace 的完整 WS 地址>'
node --test --test-name-pattern='real DashScope' tests/profile.test.mjs
```

当前仍需通过 Desktop 自带 CLI 更新 0.1.1 修复包，在用户 Desktop 查看固定侧栏入口、实际文字输入与原生消息显示、中英文 metadata 和 SVG 图标。协调者已通过 rc.2 原生 LocalCredentialProvider.set 配置默认 `DASHSCOPE_API_KEY` 引用：安全 descriptor 为 configured=true/source=file/writable=true，原有 refs 与 records 保持一致。值只进入 Host 的 native managed store，没有输出，也没有写插件、前端、repo/scratch；Nexus 不依赖 Qiyu 文件路径。此步骤之前不勾选票 01 的完整实机完成条件。
