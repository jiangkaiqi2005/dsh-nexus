# Nexus

Nexus 是 DeepSeek Harness 的实时语音管家插件，项目与包名为 `dsh-nexus`。

一个 Realtime 主 agent 与用户交流、观察全部工作会话并自主调度。挂断后继续工作，在同一个主会话输出文字。具体执行交给 Harness 工作会话。

当前提供票 01 的本地插件实现：固定侧栏入口、唯一 `qwen3.8-omni-flash-realtime` 主管的文字交流、原生会话事件与持久化，以及真实失败状态。语音、重启恢复和会话调度由后续 tickets 实施。

点击侧栏底部 Nexus 即可在主管的原生会话输入文字；重复点击返回同一个主管。主管会话使用当前目录对应的原生工作区，已有工作区沿用其名称。

按用户最新指示，当前适配现有 Desktop `0.2.0-rc.2`，不修改或升级 Desktop 程序；原先研究的 alpha.1 适配后置。受控 Host 验证与准确型号的真实文字轮次、原生落盘已通过；Desktop 入口与界面尚未实机验收。详见[票 01 验证记录](docs/verification/01-supervisor-text-session.md)。

构建：`npm ci --ignore-scripts`，`npm run build`，`npm test`，`npm pack`。测试使用 Windows 已安装的 Edge 无头模式；其他环境可通过 `NEXUS_TEST_BROWSER` 选择已安装的 Playwright 浏览器 channel。只安装打包后的 `.tgz`。Desktop 先正常退出，再通过其自带 `resources/runtime/cli/bin/dsh.cmd plugin --profile desktop add <tgz绝对路径>` 安装并重新打开；npm 版 CLI 不管理保留的 desktop profile。

Host 配置使用凭据引用 `credentialRef`，默认 `DASHSCOPE_API_KEY`；`endpoint` 默认 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，专属地域或 Workspace 接入应配置完整地址。密钥由 Harness 原生 credentials 服务读取，浏览器不接收明文密钥。若首次未配置或建连失败，主会话保留用户输入并记录失败，不生成假回复。

本切片只创建当前进程中的固定主会话；已有同身份持久记录时明确拒绝重新创建，不恢复成默认工作 agent。票 02 将接入原生恢复，因此在其完成前不要把本切片当作可日常重启使用的完整首版。

- [首版 Spec](docs/spec.md)
- [tickets 拆分草案与依赖顺序](docs/tickets.md)
- [设计与首版验收场景](docs/design.md)
- [实现路径与可行性验证](docs/implementation.md)
- [领域词汇](CONTEXT.md)
- [现有插件调研](docs/research/existing-plugins.md)
- [结果回流与主管唤醒调研](docs/research/agent-result-delivery.md)
- [用户指令优先](docs/user-instruction-priority.md)
- [架构决定](docs/adr/)
