# 票 02：主管原生恢复验证

验证日期：2026-10-08。实施基线：`77493e170d43daad64c5f855d098258cccfd80b0`。使用官方 Harness `0.2.0-rc.2` profile、Cordis `4.0.4` 与本地插件源码；没有修改 Desktop、宿主程序或 Qiyu。

## 行为与边界

Host 启动先尝试取得固定 `nexus-supervisor` 的原生独占 write handle。仅 `SessionPersistenceNotFoundError` 才进入新建路径；所有权、损坏和其他错误不降级为新建或覆盖。恢复使用该 handle 的 header、完整事件、inheritedEventCount 与 eventState，调用原生 `interruptedTurnClosers`，再由 `sessions.prepare` 重放 projection，登记 Nexus 自己的 Supervisor。保留原工作区目录及身份，既有日志只追加新后缀。

历史 `turn/start` 最大值决定下一 turn 编号；新流 attempt 使用恢复后的 durable seq 为 revision 起点。重建的模型连接从原生日志重放既有 user/assistant 文字，仍使用 `qwen3.8-omni-flash-realtime`。启动和进入页面均不唤醒恢复的 inbox；下一条用户输入才开始处理，未完成工具不自动执行。

原生 `sessions.prepare` 的 restore 路径会追加 `session/end-seed` 标记。这是 rc.2 的恢复记录；检查要求原历史 prefix 完整且逐项相等，没有重复消息、调用或中断修补，不将该原生 marker 当作重复工作。

插件要求官方 `agentPresets` 服务。固定 journal 使用专用 `nexus` preset，该名称没有登记普通 worker composition。rc.2 SessionController 的通用冷 activation 先 resolve persisted preset，遇到 `Unknown agent preset: nexus` 时在默认 factory 之前停止；Nexus 完成自定义恢复并发布后，同一 SessionController 入口取得原主管。没有替换全局 factory、代理 SessionController 或修改宿主恢复路径。隔离竞争测试同时覆盖初始化前的冷入口拒绝、初始化期间的并行 resolve，以及初始化后的同身份进入；早期拒绝被如实保留，不声称已经完成接入。

## 验证

所有 Host 子进程使用独立 `.scratch/nexus-v1/restore-*` 的 DSH_HOME/profile、`--no-open` 与 `windowsHide: true`。先确认前一个 Host 进程退出，再启动新 PID。测试走官方 dsh CLI、base + web-app composition、SessionController、默认 Worker AgentLoop 和真实压缩 JSONL persistence；受控 WS 仅替代模型。

| 检查 | 结果与证据范围 |
| --- | --- |
| 正常退出与新进程继续 | 同 Agent/Session 身份、原历史 prefix 保留、准确型号、turn 1→2；新的模型 request 接收既有 user 和 assistant。官方 SIGTERM shutdown handler 退出码 0。 |
| 卸载与重载 | 停止 driver、释放 Session/Agent 与 writer；重新取得 write handle 后可关闭，再启用插件恢复闲置 driver。日志仅增加原生恢复 marker，不自动请求模型。 |
| 初始化与入口竞争 | 专用 preset 拒绝早期通用 worker activation；并行初始化不产生普通主管；初始化后 resolve 返回同一 Nexus。 |
| 可控工具中断与再重启 | 第一 Host 持久化 open turn/step、一个已开始和一个未开始的工具调用，再由父进程终止。第二 Host 原生收束生成 `TOOL_OUTCOME_UNKNOWN`、`TOOL_NOT_STARTED`、step/end 和 interrupted turn/end；没有重新执行。第三 PID 不重复工具结果或 repair。 |
| 活动文字请求中退出 | 第一 Host 的实际受控 WS request 等待响应时走官方 SIGTERM exit 0；新进程对盘上 open tail 追加原生 interrupted closers，保持闲置；新用户输入后才执行 turn 3。 |
| 普通工作会话 | 第一 Host 经原默认 factory 创建并执行普通 worker；第二 Host 经相同默认 factory 恢复和执行该 worker。主管不成为该工厂产品。 |
| 真实模型跨进程续答 | 第一 Host 告知随机暗号并完成真实轮次，释放 writer/身份并退出码 0；第二 PID 从原生日志恢复，用户只问暗号、不重复提供值，模型准确回忆；两次均为同一准确型号。 |

活动 SIGTERM 的整 Host teardown 会同时关闭原生服务，本次观察的 durable tail 没有该活跃 driver 的 aborted terminal。下一进程按官方 `interruptedTurnClosers` 补成 interrupted；这是实际原生恢复事实。单独 Nexus 卸载按插件 teardown 顺序 drain→close→unregister。没有通过改宿主或全局退出机制将活动退出伪装成已完成轮次。

真实成功证据：`.scratch/nexus-v1/restore-real-1791464689535/result.json`。第一 PID 64520 回复 `已记住` 并 completed，15 条原生事件；第二 PID 92172 的 `before` 16 条、继续后 24 条，模型回复 `晨星118862` 并 completed，与第一进程独有随机输入完全相同。测试显式断言首轮 completed 和准确型号 assistant、第二进程保留原始 user/assistant prefix、两次资源释放，以及新回应精确匹配暗号。

早一次 `.scratch/nexus-v1/restore-real-1791464451084/result.json` 的首轮为 `CONNECTION_FAILED`，第二轮虽准确回忆已保存用户输入，但不是正常完成交流的恢复验收。原探针遗漏首轮成功断言，已补齐并用上述两轮 completed 的新证据验证；旧失败没有删除或算作成功。测试只读用户授权的 `C:\Users\25330\.qiyu\provider.json` top-level apiKey/baseUrl；密钥仅存在于临时进程环境，由 Host 原生 credentials 读取，不进入命令参数、profile、日志、源码或文档。

## 复现

```powershell
npm run typecheck
npm run build
node --test tests/restore.test.mjs
npm test
```

`restore.test.mjs` 默认运行五个受控真实 Host 边界，跳过一次真实模型检查。明确配置临时 `NEXUS_RESTORE_KEY`、可选 `NEXUS_REAL_ENDPOINT` 并设置 `NEXUS_REAL_TEST=1` 后，运行 `node --test --test-name-pattern='real DashScope' tests/restore.test.mjs`。完整默认 suite 的真实模型用例保持 skipped，不能将受控检查当作真实模型证据。

最终 `typecheck`、`build`、`git diff --check` 通过。完整默认 suite：17 passed、2 skipped（11 既有 Host 回归、1 Edge headless 原生 UI、5 新进程恢复场景；两项真实模型默认跳过）。真实恢复用例补齐首轮断言后单独 1 passed。受控最终证据分别为 `.scratch/nexus-v1/restore-normal-1791464527751`、`restore-reload-1791464535739`、`restore-race-1791464543027`、`restore-interrupt-1791464550324`、`restore-active-exit-1791464560504`。独立原生只读 handle 冷查 normal 场景的 `restore-worker`：turns [1, 2]、两条 `ordinary-model` 的 `Ordinary worker reply`、两次 completed，证明默认工作会话恢复仍正常。

用户已禁止 Computer Use。本票没有控制任何用户窗口、安装新包到用户 profile、退出/重启用户 Desktop，或修改其非空 `nexus-supervisor` journal。用户 Desktop 仍运行票 01 的 0.1.2；这里的恢复结论来自后台隔离官方 Host 的实际进程边界，用户 Desktop 升级后冷启动尚未实机验证。
