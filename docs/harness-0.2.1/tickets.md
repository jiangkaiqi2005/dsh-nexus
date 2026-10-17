# 适配 Harness 0.2.1-rc.2 tickets

依据：[适配 Spec](spec.md)。本批票从 01 起独立编号。

| 编号 | 标题 | 直接阻塞项 | 交付行为 | 当前状态 |
| --- | --- | --- | --- | --- |
| [01](tickets/01-version-range-and-fixtures.md) | 版本区间、测试夹具与过时补丁 | 无 | 新版能安装与启动；测试只剩 R6/R8/R9 失败 | 实施完成，第 1 轮修复后双轴复审放行（0c000d6）；[验证记录](verification/01-version-range-and-fixtures.md) |
| [02](tickets/02-hangup-redial-busy.md) | 挂断后立即重拨不再误报占线 | 01 | 挂断即释放通话占用 | 待实施 |
| [03](tickets/03-startup-session-ready.md) | 启动自动接通等待会话列表就绪 | 01 | 冷启动多窗口自动接通不再 UNAVAILABLE | 待实施 |
| [04](tickets/04-realtime-model-label.md) | Realtime 模式输入框显示真实模型名 | 01 | 不再显示「请选择模型」 | 待实施 |

## 为什么这样拆

- 01 先让版本门放行、测试夹具对齐新版，之后每个插件代码问题都能用干净的测试单独观察。
- 02 改 Host（`src/voice.ts`），03、04 改 `client.js`；03、04 共享 `client.js`，所以全部串行。

## 执行 frontier

01 已完成 → 02 → 03 → 04。
