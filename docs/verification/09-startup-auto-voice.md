# 票 09：原生设置与每次启动的一次自动语音验证

2026-10-10，按本次明确授权实施票 09；票据原来的 draft / 本轮不执行文字由本次授权取代。实施基点为 `e6bea8112141653a3e77ce610d45b204b9896430`，前置票 08 已由用户验收。本票不扩展票 10 / 11。

## 行为与边界

原生设置面板新增 Nexus 页，提供默认关闭的“启动 Harness 后自动进入 Nexus 语音”开关。通过 Harness 的 Config / volatile 字段与 configForms 写入当前 profile，复用原生持久化、校验、修订和写失败反馈。没有独立偏好文件、浏览器持久化或操作系统自启动配置。设置页明确说明更改在下一次 Harness 启动生效：本次启动的选择固定后，本进程内开启不追溯采集，关闭不强制结束用户当前通话。

Host 进程保留本次启动的选择与是否已尝试；插件重新激活也沿用该周期。客户端注册后向 Host 认领，Host 等待原生主管、工作区与会话就绪，再原子消费一次机会。获得机会的客户端自动打开原生 Nexus 主会话，并复用既有手动接通的采集、播放和模型握手。页面刷新、切会话、再次挂载、重复客户端或首次失败均不能再认领；新 Host 进程才开始新周期。用户仍可用同一个手动接通入口恢复。等待 Host 就绪时已取消的客户端不消费机会。

最高验证边界为官方 `dsh --profile nexus-startup --port 0 --no-open` 加载实际插件，隔离 DSH_HOME / DSH_AGENTS_HOME、真实原生设置面板、非持久化 headless Edge 客户端及原生会话落盘。Host 使用已有所有权清理工具；没有操作用户 Desktop 或现用 profile。设置保存后有序卸载主管、关闭实际 Host，再以同一个 profile 启动不同 PID；不是重新挂载插件冒充重启。

模型端点为本地可控 Realtime WebSocket，成功案例使用 Chromium 假媒体设备及真实 Web Audio；测试允许 autoplay，以稳定覆盖成功路径，另有独立播放阻断案例。拒绝权限、无设备与播放阻断通过浏览器媒体边界注入，模型失败则实际关闭 WebSocket。这些证据不等于物理麦克风、扬声器、Desktop 系统许可或真实 DashScope 型号通过。本票没有新的付费真实型号请求；票 08 的准确型号证据属于历史关联，不能转记为本票重测。

证据位于忽略目录 `.scratch/nexus-v1/`，不随提交发布。每个 `startup-*` 目录保存每轮 `cycle-N/ready.json`、`finished.json` 和已脱敏 `host.txt`；生命周期案例另有 `evidence.json`（PID 和协议），失败案例另有 `failure.json`。音频内容与请求头不记录，Host URL token 已脱敏。

## 逐项验收

| 要求 | 实际验证 | 限制 |
| --- | --- | --- |
| 新安装默认关闭，原生入口开关及跨重启保存 | 空 profile 的设置页开关为 false，媒体请求为 0；点击开启并等待原生表单接受，本进程仍为 0；同 profile 新 Host 自动接通。关闭后的下一 Host 设置仍为 false、媒体请求为 0。 | 使用隔离 profile，未覆盖用户现用 Desktop 配置。 |
| Host 与客户端就绪再尝试，自动进入 Nexus | Host 就绪但尚无客户端时模型连接为 0；客户端从正常 Harness URL 进入，没有点击 Nexus 或拨号，自动打开主会话并达到 live。 | 可控模型握手；“live”沿用既有媒体检查与真实握手确认。 |
| 每进程一次，挂断后刷新/切会话/重复挂载不重开 | 自动采集恰好 1 次；主动挂断后 track ended；新建普通会话、回 Nexus 仍 idle、请求数不增加；reload 后新页面请求为 0；第二客户端也为 0。 | 观察实际 getUserMedia 调用、track 和界面状态，不用页面挂载计数当 Host 周期。 |
| 真正重启更新周期，多个客户端只一方认领 | `startup-1791636733297`：同 profile 的 4 个实际 PID 为 151296、141244、154876、147376（关闭 → 开启 → 仍开启 → 关闭）。第三轮两个客户端并发进入，请求计数排序为 `[0, 1]`，唯一采集方达到 live。 | PID 与 `finished.json` 为实际进程证据；不是 VM / 机器重启。 |
| 手动接通可用 | 第二轮自动挂断及 reload 后手动接通 live，再挂断；三个成功语音连接的 wire.session.update 均为 text+audio，有实际 PCM 上行。 | 没有要求可控端点生成语音回答；通话输出协议沿用票 08。 |
| 权限/设备/播放/模型失败真实显示，不自动重试 | 四例分别 mic-denied、no-device、playback-blocked、failed；只创建 1 个播放尝试，播放阻断为 0 次麦克风请求，其余为 1 次；模型关闭后的 track ended。等待后次数不增，修复外部条件后手动接通 live。reload 后仍为 0 次新自动尝试。 | 前三类为媒体 API 边界注入，不冒称真实系统拒绝或物理故障。模型失败是真实本地 socket close。 |

## 检查与复跑

- 红测试 `ticket09-red-settings.txt`：旧代码的真实原生设置面板没有 Nexus 页，等待失败。首次 `ticket09-red.txt` 被原生 onboarding 遮罩拦截，属于观察失败，不作为产品红证据。
- 初版 unary Remote 结果把 `{ ok: true, value: false }` 当成真值，出现本进程不应有的采集；`ticket09-media-diagnosis.txt` 保存实际 Call.start 与连接证据。按原生返回契约处理后修复，没有放宽“本进程开启不采集”的断言。其他早期绿检查中的 onboarding 遮罩与异步 checkbox 更新属于 fixture 观察错误，已等待原生接受并正常关闭 onboarding；失败日志保留。
- `npm run typecheck`、`npm run build` 通过，日志 `ticket09-typecheck.txt` / `ticket09-build.txt`。
- `npm install --package-lock-only --ignore-scripts --offline` 通过，日志 `ticket09-lock-check.txt`；本票仅新增准确版本 `@deepseek-ai/schemastery@3.18.4` peerDependency 及根锁文件对应元数据。用户已有版本 0.2.0 改动保持未提交。
- `node --test tests/startup.test.mjs`：`ticket09-startup-final-2.txt`，5 passed / 0 failed，69.4 s。生命周期与四类失败均通过；`startup-1791636733297` 是这一轮的四 PID / 并发客户端证据。
- `node --test --test-name-pattern='voice call races|hangup idle playback|hangup during a native tool' tests/voice.test.mjs`：`ticket09-voice-regression.txt`，3 passed / 0 failed，33.6 s。已有快速重接通、在途工具与播放通知回归通过。
- `npm test`：`ticket09-npm-test.txt`，73 项，62 passed / 0 failed / 11 skipped，282.9 s，进程 exit 0。本票 5 项在全量再次通过，既有文字、恢复、派活、来源引导、语音打断及挂断播放账本回归全部通过；真实型号 opt-in 与 Desktop 检查按约定跳过。启动单文件之后的最后客户端改动只保留导航中的启动机会，并在显式操作或客户端销毁时取消；全量验证包含该版本。
- `git diff --check` 与 `git diff --cached --check` 通过。最终暂存 package 两文件只有新增 peerDependency 及根锁元数据；未暂存内容仅用户原有 0.1.2 → 0.2.0 版本改动。

```powershell
npm run typecheck
npm run build
node --test tests/startup.test.mjs
node --test --test-name-pattern='voice call races|hangup idle playback|hangup during a native tool' tests/voice.test.mjs
npm test
git diff --check
```

仍需用户物理 Desktop / 麦克风 / 扬声器验收。票 10 的网络恢复、客户端关闭后主管续行与票 11 的完整干净安装验收不在本票范围；不把本地隔离 Host 的通过升级为它们已完成。
