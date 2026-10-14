# Nexus

Nexus 是 DeepSeek Harness 的语音管家插件。默认用级联语音：点按录音交给千问识别，Harness 当前默认模型负责理解和派活，回复由千问逐句朗读。挂断后，主管和工作继续，在同一个主会话用文字交流。

可以说：“让已有的修复会话解决这个报错，完成后交给审查会话检查。”执行期间继续说话、改变要求，或者直接在工作会话输入；主管会获知你的直接要求。它可使用已有和新建的普通会话；会话 agent 自己产生的 subagent 由其 parent 管理。

当前兼容 **Harness / Desktop 0.2.0-rc.2**，Cordis 4.0.4。保持现有宿主版本，不自动升级 Desktop；历史 `0.2.1-alpha.1` 仅为接口研究基线。自动检查使用 Windows 的真实 Web 客户端与 Desktop 自带 CLI；物理设备、真实 DashScope 和实际默认模型的完整场景待用户验收。

安装打包后的 `dsh-nexus-0.2.0.tgz`，在 Harness 选择默认模型与思考强度，配置 Host 的 DashScope 凭据引用 `DASHSCOPE_API_KEY`，从侧栏底部 **Nexus** 进入。点击“接通语音”，再点“开始录音 / 结束录音”；一次最多 60 秒，识别文字直接发送。朗读时开始录音会立刻打断声音，已经派出的工作继续。跨会话、项目切换时右下角仍可挂断。自动语音默认关闭，开启后每次启动只尝试一次。

完整的安装命令、模型设置、故障处理及连续验收步骤见[安装与使用指南](docs/installation-and-use.md)；独立交付目录附有相同内容的 `INSTALL.md`。本 README 的文档链接用于源码仓库，tgz 不携带内部验证记录。旧 Realtime 版本需要安装本次新包才能使用级联；设置中可切回 Realtime，下一次接通生效，主会话历史保留。清理工作会话使用可撤销的原生归档，并停止该会话活动；不删除数据。

主会话支持 `/compact` 和自动上下文压缩，预算默认 128000 token。默认摘要模型为 DeepSeek 账号路由的 Flash，使用最低思考强度；需要在 Harness 登录账号，也可在 Nexus 设置另选摘要模型。预算、摘要模型与强度修改立即生效并跨重启保存。可压缩的历史不足时会跳过自动压缩，压力显示超过预算并不保证立即出现摘要；详情见[票 12 验证记录](docs/nexus-v1/verification/12-supervisor-context-compaction.md)。用户已接受票 12 收尾，剩余实机项免验，未执行的项目保留未验证状态。

语音和调度请求发送给所选模型服务，工作会话使用你在 Harness 配置的模型。密钥由 Host 的原生凭据服务读取，Nexus 客户端不接收明文。级联接通只准备麦克风和播放，不保持模型连接；识别失败显示“没听清”且不发起对话，合成失败只停该条朗读，文字保留。主管说“已派活”仍应以工作会话实际收到消息和原生工具结果为准。

开发与验证（PowerShell，Node `^22.19.0 || >=24.0.0`）：

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm pack
```

测试默认不调用真实付费模型，使用独立 profile、本地受控端点与无头 Edge。已安装当前 Desktop 时，可运行实际打包安装与受控完整场景：

```powershell
$env:NEXUS_DESKTOP_SMOKE = '1'
node --test --test-concurrency=1 tests/desktop.test.mjs tests/clean-install.test.mjs tests/cascade-install.test.mjs
Remove-Item Env:NEXUS_DESKTOP_SMOKE
```

这些检查使用 Desktop 自带 CLI 与真实 Web 客户端，音频为假设备，不能替代 Electron 外壳、物理设备与模型自主完成任务的实机结论。级联证据与用户实机边界见[票 06 验证记录](docs/cascade-voice/verification/06-cascade-lifecycle-and-install.md)，旧 Realtime 组合见[票 11 验证记录](docs/nexus-v1/verification/11-clean-install-and-full-scenario.md)。

- [首版 Spec](docs/nexus-v1/spec.md)
- [级联语音 Spec](docs/cascade-voice/spec.md)
- [设计与完整场景](docs/design.md)
- [票与依赖顺序](docs/nexus-v1/tickets.md)
- [领域词汇](CONTEXT.md)
- [架构决定](docs/adr/)
