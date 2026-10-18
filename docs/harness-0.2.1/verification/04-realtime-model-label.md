# 04：Realtime 模式输入框显示真实模型名（需人工关注）

实施基点：`fd4b460`。本票按裁定 8 停在「需人工关注」：0.2.1-rc.2 的公开 API 做不到「只让 Nexus 认得 Realtime 模型、别的会话看不到」，所以没有改代码。本记录只写调研结论和候选方案，不代表评审或用户验收通过。

## 现象复现

在干净 worktree（`git worktree add E:/Agent/nexus-wt-04 fd4b460`，`npm ci --ignore-scripts`、`npm run build`）里跑 `node --test --test-concurrency=1 tests/ui.test.mjs`，退出码 1。输入框模型按钮的无障碍名和文字都是「请选择模型」，断言 `/qwen3\.8-omni-flash-realtime/` 失败（`.scratch/harness-0.2.1/04/ui-red.log`）。跑完已删除 worktree。按钮没有禁用：Realtime 模式下用户仍可点开它，选目录里的模型。

## 显示名依赖什么

- Nexus 在 Realtime 模式下给主会话写入 `model/selection` `{ provider: 'dashscope-realtime', model: 'qwen3.8-omni-flash-realtime' }`（`src/supervisor.ts:87` 的 `options`、`src/index.ts:74`）。Nexus 没有往 `ctx.llm` 注册 `dashscope-realtime`，所以这个 provider 不在模型目录里。
- 旧版 `@deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2`（`npm pack` 到 scratch 空目录只读对照）`lib/client.js:812`：当前选择不在目录时显示 `` `${state.current.provider}/${state.current.model}` ``。
- 新版 0.2.1-rc.2 `lib/client.js:1202` 只在目录里查找当前选择（`currentChoice`），`:1458` 查不到就显示 `t("trigger.fallback")`，即「请选择模型」；`:1460` 无障碍名同理。`conversation.input.model.label` 插槽（`:1464-1473`，仅在 `:1517` 的 `currentChoice !== undefined` 分支调用）只用于目录里已有的模型，查不到时不会渲染。
- 目录只有一份，所有会话共用：`ModelCatalogDirectory`（`lib/client.js:713`，注释为 "One Host-generation model catalog shared by every Session selector"）调用 `remote.session.modelCatalog()`（`:752`）。每个会话的 `ModelDirectory.syncInputs()`（`:946-980`）把这份目录的 `groups` 原样放进自己的 store，没有按会话过滤。
- Host 侧 `@deepseek-ai/dsh-api-session-controller/lib/index.js:563` 的 `buildModelCatalog(ctx)` 遍历 `ctx.llm.listProviders()` 和每个 provider 的 `listModels(provider.id)`，只去掉空分组（`:604`），不接收会话参数。`@deepseek-ai/dsh-llm` 的 `listProviders()` / `listModels(provider)`（`lib/types/index.d.ts:281`、`:367`）和 `LlmModelInfo`（`lib/types/types.d.ts:321`）也没有隐藏、仅限某会话或不可选之类的字段。

## 逐项排查的公开注册方式

| 途径 | 公开 API | 结论 |
| --- | --- | --- |
| Host 注册 LLM provider/模型（`ctx.llm.registerAdapter`，`listModels` 返回 Realtime 模型） | 是 | 目录不区分会话，模型会出现在所有会话的输入框模型菜单和 `/model` 弹窗里，而且能选中；普通会话选中后，原生 Agent 会把请求发给一个只为 Nexus 语音设计的 provider。违反裁定 8。 |
| 覆盖 `conversation.input.model` 插槽 | 是（目录里标注 `replaceRisk: "shadows-shipped-ui"`） | 这是 `kind: 'single'` 插槽，不能按会话注册（`registerOptions: []`）。渲染器对每个会话都只取 `host.entriesOfSlot(slotKey)[0]` 这一个胜者（`dsh-client-ui-renderer/lib/client.js:1174`），所以 Nexus 的条目会替换掉**所有**会话的原生选择器。原生 `ModelSelect` 没有导出（包只导出 `ModelDirectory`、`ModelDirectoryResolver`、`apply`、`inject`，`lib/client.js:1927-1930`），非 Nexus 会话无法把渲染交还给原生组件，除非 Nexus 重写整个选择器。 |
| `conversation.input.model.label` 插槽 | 是 | 只在当前选择已在目录里时才渲染，不能给目录外的模型提供名字。 |
| 改写 `modelDirectories.directoryFor('nexus-supervisor').store` 或改 `model` 命名空间的 `trigger.fallback` 文案 | store 和 locale 本身都能访问，但这是在改别的插件的内部状态或全局文案 | store 会被 `syncInputs()` 覆盖回去；文案会改到所有会话。都属于 hack，不做。 |
| 在 Nexus 自己的 list 插槽（如 `conversation.input.left/right`）里按 `sessionId` 只给主会话显示模型名 | 是 | 不会泄露到别的会话，但原生按钮仍然显示「请选择模型」。这样做达不到「模型按钮显示真实模型名」，ui 用例的期望也要改。 |

## 候选方案（交协调者/用户裁定）

1. **向上游提需求，目前接受原生行为**：请 Harness 恢复「当前选择不在目录时显示 `provider/model`」，或者提供按会话贡献的目录项/标签（例如当前选择不可路由时也渲染 `conversation.input.model.label`）。上游发版前，Nexus Realtime 输入框显示「请选择模型」，ui 用例改成断言原生回退，并另加一条断言证明 Realtime 模型不在普通会话的目录里。用户可见：误导文案暂时保留，其他会话不受影响。
2. **Nexus 自带一个只给主会话用的标签**（上表最后一行）：在 Realtime 模式的主会话输入框里，由 Nexus 自己显示 `qwen3.8-omni-flash-realtime`，原生按钮不动。用户可见：同一行里有「请选择模型」按钮和 Nexus 标签两样东西；其他会话不变。这会改输入框的视觉，和 Spec「UI 视觉一律不变（R8 只改模型名显示）」有冲突，需要裁定。
3. **Host 注册 `dashscope-realtime` provider**：最贴近旧版的显示效果，但 Realtime 模型会进所有会话的模型列表，还能被选中。直接违反裁定 8，除非放宽裁定。
4. **整体覆盖 `conversation.input.model`**：Nexus 重写整个模型选择器，给所有会话用。工作量大，会替换官方 UI（`shadows-shipped-ui`），以后原生更新也跟不上。不推荐。

## 实际命令与结果

| 命令 | 实际结果 |
| --- | --- |
| `git worktree add E:/Agent/nexus-wt-04 fd4b460`；`npm ci --ignore-scripts`；`npm run build` | 成功 |
| `node --test --test-concurrency=1 tests/ui.test.mjs`（worktree） | 1 项失败，`'请选择模型'` 不匹配 `/qwen3\.8-omni-flash-realtime/`（`.scratch/harness-0.2.1/04/ui-red.log`） |
| `npm pack @deepseek-ai/dsh-client-ui-model-selection@0.2.0-rc.2`（scratch 空目录，只读） | 确认旧版 `lib/client.js:812` 的 `provider/model` 回退 |
| `git worktree remove --force` | 报 "Filename too long"，改用 `rm -rf` 加 `git worktree prune` 清理 |

因为没有改代码，没有跑 typecheck、全套 `npm test` 和 `NEXUS_DESKTOP_SMOKE=1` 冒烟；之前的基线见票 03 验证记录（全套只剩本 R8 和偶发的 profile 失败）。全程没有读写用户的 `~/.dsh`，也没有往用户的 `desktop` profile 安装。
