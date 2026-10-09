# Nexus

Nexus 是 DeepSeek Harness 的实时语音管家插件，项目与包名为 `dsh-nexus`。

一个 Realtime 主 agent 与用户交流、观察全部工作会话并自主调度。挂断后继续工作，在同一个主会话输出文字。具体执行交给 Harness 工作会话。

当前提供票 01–04 的本地插件实现：固定侧栏入口、唯一 `qwen3.8-omni-flash-realtime` 主管的文字交流、原生记录与重启恢复、工作会话调度，以及工作结果自动回流。语音由后续 tickets 实施。

点击侧栏底部 Nexus 即可在主管的原生会话输入文字；重复点击返回同一个主管。主管会话使用当前目录对应的原生工作区，已有工作区沿用其名称。

按用户最新指示，当前适配现有 Desktop `0.2.0-rc.2`，不修改或升级 Desktop 程序；原先研究的 alpha.1 适配后置。票 01 已通过受控 Host 验证、真实模型文字轮次和原生落盘验证，以及用户 Desktop 的入口、文字界面和插件 metadata 实机验收。详见[票 01 验证记录](docs/verification/01-supervisor-text-session.md)。

构建：`npm ci --ignore-scripts`，`npm run build`，`npm test`，`npm pack`。测试使用 Windows 已安装的 Edge 无头模式；其他环境可通过 `NEXUS_TEST_BROWSER` 选择已安装的 Playwright 浏览器 channel。只安装打包后的 `.tgz`。Desktop 先正常退出，再通过其自带 `resources/runtime/cli/bin/dsh.cmd plugin --profile desktop add <tgz绝对路径>` 安装并重新打开；npm 版 CLI 不管理保留的 desktop profile。

Host 配置使用凭据引用 `credentialRef`，默认 `DASHSCOPE_API_KEY`；`endpoint` 默认 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，专属地域或 Workspace 接入应配置完整地址。密钥由 Harness 原生 credentials 服务读取，浏览器不接收明文密钥。若首次未配置或建连失败，主会话保留用户输入并记录失败，不生成假回复。

重新启动 Host 后，插件恢复同一主管的原生记录，下一轮继续使用既有交流上下文。恢复保持闲置，未闭轮次和工具调用按 Harness 原生中断语义收束，不自动重跑。普通工作会话仍沿用原生工厂。票 02 已在后台隔离官方 Host 的真实退出、新进程启动和准确型号续答中验证；新版尚未安装到用户 Desktop，其当前非空会话未修改。详见[票 02 验证记录](docs/verification/02-native-supervisor-restore.md)。

主管可读取全局工作会话，向已有会话派活，或在明确工作区创建会话；运行中的会话收到原生引导，闲置会话被唤醒。派活来源标记为 Nexus，投递成功与工作完成分别记录。票 03 已在后台隔离官方 Host 中验证准确型号工具调用、已有和新建 worker 的实际执行、失败续答；当前新版尚未安装到用户 Desktop。冷子会话与宿主适配边界详见[票 03 验证记录](docs/verification/03-dispatch-work-sessions.md)。

任何工作会话（含用户自己创建的普通会话）每结束一轮，成功、失败或中断，终态都会自动以 `nexus-work-result` 来源的原生消息回到主管，带会话与轮次身份、终态和该轮最后的实际文字（过长则截取头尾，细节用读会话工具获取）。主管闲时被唤醒，忙时结果留在原生 inbox，在后续 step 或下一轮进入模型，用户输入与结果互不丢失；同一会话轮次只投递一次，主管自身输出不回流。是否汇报、追加、审查或停止由模型决定，Host 不预设流程。票 04 已在后台隔离官方 Host 以受控事件和准确型号完成空闲与忙时回流验证，worker 为受控 native adapter；新版尚未安装到用户 Desktop。详见[票 04 验证记录](docs/verification/04-global-result-delivery.md)。

- [首版 Spec](docs/spec.md)
- [tickets 拆分草案与依赖顺序](docs/tickets.md)
- [设计与首版验收场景](docs/design.md)
- [实现路径与可行性验证](docs/implementation.md)
- [领域词汇](CONTEXT.md)
- [现有插件调研](docs/research/existing-plugins.md)
- [结果回流与主管唤醒调研](docs/research/agent-result-delivery.md)
- [用户指令优先](docs/user-instruction-priority.md)
- [架构决定](docs/adr/)
