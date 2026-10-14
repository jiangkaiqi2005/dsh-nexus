# 票 02 验证记录

本票基线：`24ceec685e326c9c9f08693a3cf31d2dc89703bd`。按 Spec 先保留 Realtime 行为完成主管模型请求预重构，再添加级联实现。

## 预重构阶段

主管请求接缝在 `src/model-request.ts`：输入保持原生会话面、组装后的工具与提示、取消信号、逐段文字监听；Realtime 返回现有回复结构。主管仍负责轮次、原生记录、派活、结果回流、引导、压缩及连接恢复，没有复制轮次循环。

实际运行：

- `npm run typecheck`：通过，日志 `.scratch/cascade-voice/02-pre-refactor-typecheck.log`。
- `npm run build`：通过，日志 `.scratch/cascade-voice/02-pre-refactor-build.log`。
- `node --test tests/voice.test.mjs`：32 项，27 通过、5 跳过、0 失败；374.309 秒。日志 `.scratch/cascade-voice/02-pre-refactor-voice.log`。
- `npm test`：104 项，92 通过、12 跳过、0 失败；381.752 秒。日志 `.scratch/cascade-voice/02-pre-refactor-full.log`。此门槛通过后才开始添加级联实现。

首个级联验收按受控官方 Host 注册外部 LLM 提供方，从主会话入口驱动，未替换主管内部组件。`node --test tests/cascade.test.mjs` 首次运行失败，日志 `.scratch/cascade-voice/02-red-default.log`。最初检查 loader 原始配置中的 `voiceMode`；随后确认原始配置不包含 schema 的有效默认值，改以真实模型请求和设置界面验证默认模式。

进入级联后首轮请求仍失败：原生会话拒绝空 `adapterDefaults` 的请求头，外部提供方没有收到请求。改用原生 `canonicalHeader` 形成请求头后首个用例通过，日志 `.scratch/cascade-voice/02-green-default-3.log`。临时诊断输出已移除。

## 级联阶段

实现共用现有主管轮次循环、结果回流、运行中引导及压缩恢复。每一步读取 Harness 当前默认模型，再由原生 `prepareCall` 固定实际路由、推理强度及适配器默认值；请求头和回复记录使用同一份已固定配置。原生 `deriveMessages` 提供结构化历史，原生 LLM 服务负责工具 schema 与结果消息的提供方转换，原生 `BlockAssembler` 保留思考、回放信息和缓存用量。文字 delta 在请求结束前进入现有 assistant-stream 监听。

设置中的语音模式默认为级联；修改后在下一次接通尝试时采样。正在进行的 Realtime 通话及挂断后的文字继续使用已生效模式。级联接通明确显示“级联语音暂不支持，可以继续文字交流。”，不假接通；语音识别与合成属于后续票。摘要设置不变，未新增主管模型设置。

已运行的专项验证：

- `.scratch/cascade-voice/02-cascade-all-1.log`：8 项通过、0 失败，37.018 秒；覆盖默认模型及推理切换、实际记录归属、缓存用量、原生工具读取和派活、同轮工具下一步切默认模型、真实工作结果唤醒、运行中引导、四种诚实失败和原生压缩。
- `.scratch/cascade-voice/02-cascade-restore.log`：恢复用例通过，5.629 秒；在隔离官方 Host 中停用并重新启用插件，恢复同一持久化会话，随后原生请求保留旧历史及回放信息，并使用当前默认模型。此项不是操作系统重启验收。
- `.scratch/cascade-voice/02-ui-mode-8.log`：真实浏览器模式用例通过，8.399 秒；默认级联与准确暂不支持提示、配置保存、Realtime 通话中改设置不切换、挂断后文字仍用 Realtime、下一次接通尝试切级联、两模式共用历史。截图和 DOM：`.scratch/cascade-voice/02-ui-1791981210658/settings-default.png`、`cascade-after-switch.png`、`ui.yml`，已目视检查。

浏览器验证此前有真实失败，保留在 `02-ui-mode-1.log` 到 `02-ui-mode-7.log`：欢迎引导和设置模态先阻塞点击，分别用现有官方测试相同的欢迎版本配置和正常 Escape 关闭模态；随后主会话请求比夹具的默认模型保存早到（1.37 秒，夹具在 1.5 秒准备），误打到无凭据的初始 DeepSeek 路由。补齐提供方 catalog 后仍失败，排除该假设；浏览器等待保存默认模型后的 `ui-ready` 公开标记后才操作，原生用例通过。未使用强制点击，未修改产品路由掩盖夹具时序。

最后检查：

- `npm run typecheck` 与 `npm run build`：通过；日志 `.scratch/cascade-voice/02-final-typecheck.log`、`02-final-build.log`。
- `npm test`：114 项，102 通过、12 跳过、0 失败；377.345 秒。日志 `.scratch/cascade-voice/02-final-full.log`。新增 10 个级联用例全部通过；原有 Realtime 夹具只新增显式 `voiceMode: realtime`，保留原协议和所有既有断言。

以上为隔离 Host、受控提供方/WS 和真实浏览器证据，未调用真实模型端点、读取真实凭据或修改生产 profile；未宣称实机语音通过。
