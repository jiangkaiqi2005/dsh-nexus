# 票 01 实施与验证记录

验证日期：2026-10-08。当前状态：已实现可评审文字切片，受控验证和准确型号真实文字轮次通过；用户 Desktop 安装与界面验收未完成，票 01 尚未完成。

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
| 用户 Desktop 安装和原生界面 | 未验证 | 尚未安装到用户 desktop profile；侧栏按钮、消息投影、插件 metadata 与 SVG 的实际呈现仍需实机查看 |

受控端点仅替代外部模型，Host、默认 worker factory、SessionController、projection 和压缩 JSONL persistence 均使用 rc.2 产品 composition。测试没有用临时拼装 Context 代替官方 profile。模拟响应和原生实际落盘是不同层次的证据，不能将前者称为真实模型通过。

真实调用证据：`.scratch/nexus-v1/real-1791458748463/result.json`。所用型号为 `qwen3.8-omni-flash-realtime`，端点为 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，仅输出文字。用户提供的 `C:\Users\25330\.qiyu\provider.json` 只读；密钥仅传入验证进程的临时环境，再由 Host credentials 读取，不写入插件、profile、日志或此文档。

初期两个环境候选均返回 HTTP 401，日志如实记录失败。有效配置首次握手成功但产生 `COMMON_ERROR`：参考 Qiyu 已实际验证的协议，补齐该端点在纯文字模式也要求的 `voice=Tina`、`input_audio_format=pcm16`、`output_audio_format=pcm24`、`input_audio_transcription.model=gummy-realtime-v1`，使用裸 `response.create`，真实轮次随后通过。输出模态仍严格为 `['text']`；收到音频输出会判为失败。这是当前实际端点的验证结论，不承诺其他地域端点 schema 相同。[官方客户端事件](https://help.aliyun.com/en/model-studio/client-events)的 text-only 支持与上述旧端点必要字段差异仍需按实际配置核对。

## 复现命令

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm pack
```

受控完整套件结果：5 passed，真实调用用例默认 1 skipped。测试保留每次独立 profile 与原生 read-handle 输出在 `.scratch/nexus-v1/<scenario>-<timestamp>/result.json`。打包文件清单包含 dist 全部运行模块、client.js、patch、locale 和 icon；不包含源码测试、验证 profile 或凭据。

仅在已确认可用的 Host 配置下运行真实用例，变量只传凭据引用与非密钥端点：

```powershell
$env:NEXUS_REAL_TEST = '1'
$env:NEXUS_REAL_CREDENTIAL_REF = '<原生凭据引用名>'
$env:NEXUS_REAL_ENDPOINT = '<适用地域或 Workspace 的完整 WS 地址>'
node --test --test-name-pattern='real DashScope' tests/profile.test.mjs
```

真实用例曾单独执行，结果为 1 passed。当前仍需通过 Desktop 自带 CLI 安装打包插件，将适用凭据保存为原生引用，再在用户 Desktop 查看固定侧栏入口、实际文字输入与原生消息显示、中英文 metadata 和 SVG 图标。此步骤之前不勾选票 01 的完整实机完成条件。
