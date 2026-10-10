# Nexus

Nexus 是 DeepSeek Harness 的实时语音管家插件，项目与包名为 `dsh-nexus`。

一个 Realtime 主 agent 与用户交流、观察全部工作会话并自主调度。挂断后继续工作，在同一个主会话输出文字。具体执行交给 Harness 工作会话。

当前提供票 01–06 的本地插件实现：固定侧栏入口、唯一 `qwen3.8-omni-flash-realtime` 主管的文字交流、原生记录与重启恢复、工作会话调度、工作结果自动回流、用户途中修改要求，以及手动接通的实时语音通话。复杂打断、挂断后续行、自动接通与断线/多客户端由后续 tickets 实施。

点击侧栏底部 Nexus 即可在主管的原生会话输入文字；重复点击返回同一个主管。主管会话使用当前目录对应的原生工作区，已有工作区沿用其名称。

按用户最新指示，当前适配现有 Desktop `0.2.0-rc.2`，不修改或升级 Desktop 程序；原先研究的 alpha.1 适配后置。票 01 已通过受控 Host 验证、真实模型文字轮次和原生落盘验证，以及用户 Desktop 的入口、文字界面和插件 metadata 实机验收。详见[票 01 验证记录](docs/verification/01-supervisor-text-session.md)。

构建：`npm ci --ignore-scripts`，`npm run build`，`npm test`，`npm pack`。测试使用 Windows 已安装的 Edge 无头模式；其他环境可通过 `NEXUS_TEST_BROWSER` 选择已安装的 Playwright 浏览器 channel。只安装打包后的 `.tgz`。Desktop 先正常退出，再通过其自带 `resources/runtime/cli/bin/dsh.cmd plugin --profile desktop add <tgz绝对路径>` 安装并重新打开；npm 版 CLI 不管理保留的 desktop profile。

本机打包安装冒烟可在构建后运行（PowerShell）：`$env:NEXUS_DESKTOP_SMOKE='1'; node --test tests/desktop.test.mjs`。它使用 `D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd`，在隔离目录由官方插件管理器初始化 profile 并安装当前 tgz，以无头浏览器验证原生文字输入、原生记录与重启恢复；模型为本地受控端点，不需要凭据或付费调用。未安装该 Desktop 时明确跳过。详见[本机冒烟与测试清理验证](docs/verification/desktop-activation-test-cleanup.md)。

Host 配置使用凭据引用 `credentialRef`，默认 `DASHSCOPE_API_KEY`；`endpoint` 默认 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，专属地域或 Workspace 接入应配置完整地址。密钥由 Harness 原生 credentials 服务读取，浏览器不接收明文密钥。若首次未配置或建连失败，主会话保留用户输入并记录失败，不生成假回复。

重新启动 Host 后，插件恢复同一主管的原生记录，下一轮继续使用既有交流上下文。恢复保持闲置，未闭轮次和工具调用按 Harness 原生中断语义收束，不自动重跑。普通工作会话仍沿用原生工厂。票 02 已在后台隔离官方 Host 的真实退出、新进程启动和准确型号续答中验证；新版尚未安装到用户 Desktop，其当前非空会话未修改。详见[票 02 验证记录](docs/verification/02-native-supervisor-restore.md)。

按 2026-10-09 用户裁定，Nexus 只管理和调度对话会话（普通会话）的 agent；会话 agent 产生的 subagent 会话由其 parent agent 管理，Nexus 不列出、不读取、不派活也不停止，对其调用会返回明确失败。主管可读取全部对话会话，向已有会话派活，或在明确工作区创建会话；运行中的会话收到原生引导，闲置会话被唤醒。派活来源标记为 Nexus，投递成功与工作完成分别记录。票 03 已在后台隔离官方 Host 中验证准确型号工具调用、已有和新建 worker 的实际执行、失败续答；当前新版尚未安装到用户 Desktop。详见[票 03 验证记录](docs/verification/03-dispatch-work-sessions.md)。

可以说“在侧栏已有的 dsh-nexus 项目新建一个会话，执行这项任务”。文字和语音主管会先查询 Harness 已登记项目的名称与绝对路径，再在目标项目创建普通会话；已登记的空白项目也可找到。查询只读，不受主管当前目录影响；项目重名或找不到时先确认，明确给出的绝对目录仍可使用。这条工具链已通过隔离官方 Host 和 Desktop 打包冒烟，真实模型按自然语言选项目、用户 Desktop 中的实际文字与语音操作仍待验收。详见[项目发现修复验证](docs/verification/workspace-discovery.md)。

Nexus 运行期间，除主管自身外的任何对话会话（含用户自己创建或 fork 的普通会话；subagent 会话不在范围）每结束一轮，成功、失败或中断，终态都会自动以 `nexus-work-result` 来源的原生消息回到主管，带会话与轮次身份、终态（含失败代码与消息）和该轮最后的实际文字（过长则截取头尾，细节用读会话工具获取）。subagent 会话的结束仍由原生机制通知其 parent agent（例如主管自己的子会话只有原生 `subagent-settled` 结算通知）。主管闲时被唤醒，忙时结果留在原生 inbox，在后续 step 或下一轮进入模型，用户输入与结果互不丢失；同一会话轮次只投递一次，主管自身输出不回流。是否汇报、追加、审查或停止由模型决定，Host 不预设流程。票 04 已在后台隔离官方 Host 以受控事件和准确型号完成空闲与忙时回流验证，worker 为受控 native adapter；新版尚未安装到用户 Desktop。详见[票 04 验证记录](docs/verification/04-global-result-delivery.md)。

用户途中改变要求时，可以直接告诉主管，由主管判断受影响的工作会话并用原生引导转告（运行中的会话在下一步读到，不撤销已完成动作，也不立即中断正在执行的工具）；也可以直接在对话会话里输入。后者（任何 Host 入口进入的用户来源输入）会以 `nexus-user-input` 来源同步给主管，指向该会话中用户的原消息，与用户在主会话说的话、Nexus 派活和自动结果区分，用户不必在两处重复输入。主管闲时被唤醒，忙时在后续 step 处理；排队消息移为引导不重复同步，编辑后再同步。没有自动取消、指令版本仲裁或意图分类。票 05 已在后台隔离官方 Host 以受控事件覆盖主管忙闲与旧结果交错，并以准确型号演示自然语言改要求（主管自行判断受影响的会话，不引导无关会话）与工作会话直接引导，worker 为受控 native adapter；新版尚未安装到用户 Desktop。Nexus 通过 nexus 会话工具委派对话会话，不使用原生 `subagent_fork`/`workflow` 子会话。详见[票 05 验证记录](docs/verification/05-user-steering-priority.md)。

在主管会话输入区上方点击“接通语音”即可与主管通话。浏览器只负责采集麦克风和播放声音，模型连接、密钥与工具执行都在 Host。同一个准确型号直接听语音、说话并调用调度工具，没有语音转写再转文字主管的拼接。每段语音成为主会话的一个原生轮次：用户转写、主管文字与工具事实都写入原生记录。工作会话执行时可以继续交谈；结果在通话中回到主管，是否开口由主管判断。状态显示的是实际情况：麦克风被拒、无设备、播放未就绪都会如实显示，模型确认语音会话之前只显示“正在接通”。同一时间只允许一个客户端通话。挂断时仍在等待回答的工作结果改用文字继续处理；Host 停止时通话以失败结束并释放麦克风。票 06 已在后台隔离官方 Host 中，以真实客户端代码（无头 Edge）、准确型号和离线合成的语音（经浏览器假采集设备）演示语音派活（既有会话与新建会话）、执行期间继续交流与结果回流，worker 为受控 native adapter；真实模型偶有未调用派活工具却声称已派活的情况（见验证记录）。物理麦克风、扬声器与 Desktop 中的实机通话尚未验证，新版也尚未安装到用户 Desktop。详见[票 06 验证记录](docs/verification/06-live-voice-dispatch.md)。

- [首版 Spec](docs/spec.md)
- [tickets 拆分草案与依赖顺序](docs/tickets.md)
- [设计与首版验收场景](docs/design.md)
- [实现路径与可行性验证](docs/implementation.md)
- [领域词汇](CONTEXT.md)
- [现有插件调研](docs/research/existing-plugins.md)
- [结果回流与主管唤醒调研](docs/research/agent-result-delivery.md)
- [用户指令优先](docs/user-instruction-priority.md)
- [架构决定](docs/adr/)
