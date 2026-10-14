# 票 01：原生归档工作会话验证

验证日期：2026-10-14。实施基线：`13a45c1a6dc5347700d8870a4a971d8cf87cd826`。使用已安装的官方 Harness `0.2.0-rc.2`、Cordis `4.0.4` 与本地 Nexus 插件。只增加归档工具及共享主管提示中的两条说明，没有修改票据状态，也没有部署、推送或删除会话数据。

## 实现与原生边界

`nexus_archive_session` 接收工作会话 ID，复用现有工作会话目标检查：拒绝 Nexus 主会话与由 parent agent 管理的 subagent 会话；缺失会话按原生 inspect 的失败返回。检查通过后调用正式公开入口 `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`，返回 `{ sessionId, archived: true }`。不恢复或激活工作 agent，不增加权限、工具限制或清理循环。

官方归档先持久化归档集合，再经 `workspace/session-stop` 交给原生 turn、subagent、job、schedule providers 请求停止。原生入口不等待活动结算；provider 停止失败只记原生日志且不撤销归档。Nexus 沿用该语义，工具说明明确“停止已请求，不等待结算”，返回值不把停止请求说成活动已经全部结束。重复归档沿用原生幂等行为。恢复使用 Harness 原生撤销归档，没有增加额外工具。

文字与语音主管共享的提示说明：清理工作会话使用 `nexus_archive_session`，不要要求工作会话删除自己或其他会话的数据；用户要求删除时说明原生只支持可撤销归档。派活、结果回流、压缩以及既有停止工具的行为保持原有实现。

## 受控 Host 检查

测试以独立 `.scratch/cascade-voice/archive-*` 的 `DSH_HOME`、profile 和工作目录启动官方 dsh CLI（base + web composition，`--no-open`）。使用已有 `startHost` 进程树清理边界，Host 与受控长期子进程均隐藏启动。主会话输入走 `sessionController.prompt`，受控 Realtime WS 端点选择工具，再从原生 `sessionController.inspect`、工作区归档集合、jobs、schedule 观察结果，没有直接执行 Nexus 工具实现。

夹具显式加载官方 `@deepseek-ai/dsh-schedule`，因为默认 base profile 没有此 Host 服务；这只是测试装配，没有增加产品依赖。工作 agent 使用受控原生 LLM adapter 等待取消；后台 job 注册真实 Node 长期子进程，原生 job cancellation 实际终止进程；原生 schedule 设置一小时后提醒。

| 操作 | 已观察的外部行为 |
| --- | --- |
| 归档运行中的既有普通会话 | 归档前 agent 与 job 均 running，有一个待执行提醒；归档后原生集合包含其 ID，原 turn aborted，agent idle，job killed，长期进程已退出，待执行提醒列表为空。 |
| 再次归档 | 原生幂等成功，仍只有一个归档项。 |
| 归档主会话 | 原生工具结果 `isError: true`，包含主会话拒绝说明；主会话没有进入归档集合。 |
| 归档不存在的会话 | 原生工具结果 `isError: true`，包含 `missing-session`，没有新归档项。 |
| 原生撤销归档并续聊 | 归档集合移除工作会话；原来的用户输入与停止记录仍可读取，新轮 completed，产生真实 worker 回复。 |
| 文字与语音能力 | 实际 text-only 与 audio `session.update` 都含归档工具，主管提示都有清理和删除两条说明。 |

后台 job 结束会产生原生完成通知；归档 gate 拒绝因此触发的新轮（`blocked`），原来运行中的轮仍以 `aborted` 结束。测试检查原轮结果，不把最后一个 `blocked` 误作取消失败。

## 红绿与命令证据

所有命令均在 `E:/Agent/dsh-nexus` 执行；日志在忽略目录 `.scratch/cascade-voice/`。

- 夹具早期失败：`01-red.txt`，90 秒无探针报告，原生日志明确 `waiting for service: schedule`。另一次 45 秒超时也是同一装配问题；这些不算产品红测试。
- 有效红测试：`node --test tests/archive.test.mjs`，`01-red-ready.txt`，1 failed / 0 passed，原因是尚未有工具、运行中的工作会话没有被归档；`wire.json` 实际包含 `unknown tool "nexus_archive_session"` 的失败工具结果，schema 没有此工具。证据目录：`archive-1791978694373`。
- 首次实施后实际归档和所有活动停止均成功，但旧断言错误要求最后一个原生轮一定 aborted；`archive-1791978726122/result.json` 明确原轮 aborted、完成通知的新轮 blocked。修正测试以检查原轮，不改产品规避原生 gate。
- `npm run typecheck`：exit 0，`01-typecheck.txt`。
- `npm run build`：exit 0，`01-build.txt`。
- `node --test tests/archive.test.mjs`：exit 0，1 passed / 0 failed，`01-green.txt`；证据目录 `archive-1791978774637`，含 `result.json`、`wire.json`、脱敏 `host.log`。

- 完整 `npm test`：exit 0，104 项，92 passed / 0 failed / 12 skipped（真实模型和已安装 Desktop 的 opt-in 检查），耗时约 376 秒；`01-npm-test.txt`。现有派活、结果回流、压缩和 Realtime 回归均保持通过。
- `git diff --check`：exit 0，未发现空白错误；日志 `01-diff-check.txt`。

```powershell
npm run typecheck
npm run build
node --test tests/archive.test.mjs
npm test
git diff --check
```

## 证据范围

这是官方 Harness Host 与受控模型端点的功能验收，覆盖原生归档状态和真实后台进程停止；没有付费真实模型判断用户“删除”的语义、Desktop 点击归档/撤销界面或物理语音实机验收。原生撤销通过同一公开工作区服务实际执行，不把模拟端点结论称作实机通过。
