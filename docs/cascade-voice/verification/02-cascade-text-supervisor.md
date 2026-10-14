# 票 02 验证记录

本票基线：`24ceec685e326c9c9f08693a3cf31d2dc89703bd`。按 Spec 先保留 Realtime 行为完成主管模型请求预重构，再添加级联实现。

## 预重构阶段

主管请求接缝在 `src/model-request.ts`：输入保持原生会话面、组装后的工具与提示、取消信号、逐段文字监听；Realtime 返回现有回复结构。主管仍负责轮次、原生记录、派活、结果回流、引导、压缩及连接恢复，没有复制轮次循环。

实际运行：

- `npm run typecheck`：通过，日志 `.scratch/cascade-voice/02-pre-refactor-typecheck.log`。
- `npm run build`：通过，日志 `.scratch/cascade-voice/02-pre-refactor-build.log`。
- `node --test tests/voice.test.mjs`：32 项，27 通过、5 跳过、0 失败；374.309 秒。日志 `.scratch/cascade-voice/02-pre-refactor-voice.log`。
- `npm test`：104 项，92 通过、12 跳过、0 失败；381.752 秒。日志 `.scratch/cascade-voice/02-pre-refactor-full.log`。此门槛通过后才开始添加级联实现。

首个级联验收已按受控官方 Host 注册外部 LLM 提供方，从主会话入口驱动，未替换主管内部组件。`node --test tests/cascade.test.mjs` 首次运行真实失败：新配置不存在 `voiceMode`，实际 `undefined`，期望 `cascade`。日志 `.scratch/cascade-voice/02-red-default.log`。

## 级联阶段

尚未实施；语音识别与合成属于后续票。
