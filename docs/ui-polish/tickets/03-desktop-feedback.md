# 03：实机反馈——横条对齐、胶囊可点中与可拖动

**要构建的行为：** 用户 2026-10-16 在 Windows Desktop 实机验收票 01、02 后提出三点：横条左右边缘没有和输入框卡片对齐；胶囊里的按钮鼠标放上去也点不中；希望胶囊可以拖动。本票修复前两点，并实现胶囊拖动。

**阻塞于：** 01、02（同一个 `client.js`）。

**状态：** 实施及自验完成，待评审 / 实机；[验证记录](../verification/03-desktop-feedback.md)。Electron 拖动区中胶囊能否点中、拖动，只能由用户在 Windows Desktop 实机确认。

**范围与约束：** 依据 Spec「通话横条」「通话胶囊」两节中标注「见票 03」的补充条目。

- 只改 `client.js` 的渲染层和样式表；`Call` 类、帧校验、设置页、`src/` 下的 Host 代码、协议、状态码都不改。
- 横条和胶囊的其余视觉（原型 A 的结构、类名、尺寸、文案、图标）不变；新增的样式仍用 `nx-` 前缀和 `--dsw-*` / 宿主 `--dsh-composer-*` 变量。
- 协调者已核实的原因（实施时请自行复核）：
  - 对齐：`.nx-a-bar` 写死了 `max-width: 724px`；宿主输入框卡片宽度来自 `--dsh-composer-card-max-width`（`calc(var(--dsh-chat-content-width) + 32px)`，聊天宽度在 680–920px 间随窗口变化，也可由用户拖宽），Desktop 默认宽度下约 950px，所以横条比输入框窄。宿主自己的 dock 项样式见 `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 中 `_7yHdaG_dock` 一类规则。
  - 点不中：宿主在 Windows 标题栏（`[data-windows-titlebar] .pI_x6G_frame:before`，高度 `--dsh-windows-titlebar-height`）铺了 `-webkit-app-region: drag`；胶囊 `top: 12px` 落在这条区域内且没有 `no-drag`，Electron 把点击当成拖窗口。Playwright 测不到 Electron 的拖动区，只能断言样式。

- [x] 横条左右边缘与输入框卡片左右边缘对齐（误差 ≤ 1px），在至少三种聊天宽度下成立：默认 1360×860、更宽的窗口（例如 1920×1080）、以及设置宿主 `--dsh-chat-user-width` 后的用户自定义宽度；用真实 Host 中两者的 `getBoundingClientRect()` 断言。
- [x] 胶囊（及其所有子元素）的计算样式 `-webkit-app-region` 为 `no-drag`；横条同样标记，避免将来落入拖动区。
- [x] 胶囊可拖动：按住胶囊拖动超过阈值后跟随指针，松开后留在新位置；拖动不触发「回到 Nexus」点击，也不触发录音、挂断；不超过阈值的点按行为不变。
- [x] 胶囊位置限制在窗口可见范围内；窗口缩小后自动收回可见范围；刷新或切换页面后恢复上次位置；`localStorage` 不可用时退回顶部正中，不报错。
- [x] 任何时刻最多一个 `[data-nexus-voice]` 的不变量不变；票 01 原有的横条、胶囊测试仍然通过。
- [x] 截图：深浅主题下 Desktop 默认宽度与宽窗口的横条对齐截图，以及拖动后的胶囊截图，存入验证记录并与票 01 基线并排；与基线的差异只应是横条宽度和胶囊位置，逐条登记。
- [x] 完整测试套件通过，包括 Desktop 冒烟和独立安装测试。

**Spec 对照：** 「通话横条」「通话胶囊」中标注「见票 03」的条目；用户故事 9。
