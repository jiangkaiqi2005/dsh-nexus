# 01：版本区间、测试夹具与过时补丁

**要构建的行为：** Nexus 声明兼容 0.2.1-rc.2 起的 0.2.x Harness，Desktop 自带 CLI 能安装、启动时不再被兼容门禁用；测试夹具与探针对齐新版界面和 API；删除已成空操作的标题预算补丁。

**阻塞于：** 无。

**状态：** 实施完成，待评审；[验证记录](../verification/01-version-range-and-fixtures.md)。全套验收项未勾选：干净 worktree 中除 R6/R8/R9 外另有 1 项 profile 用例失败一次且单独重跑 2/2 未复现；仓库目录中因未跟踪的 `promo/`、`.claude/` 拖慢原生整树快照，另有 10 项时序失败，详见验证记录。

**范围与约束：** 依据 Spec「诊断结论」R1a、R1b、R2、R3、R4、R5、R7 与「裁定」1–5、9、10。

- `package.json`：peer 区间、`engines.dsh`、devDependencies、插件版本 0.2.1；重新生成 `package-lock.json`。
- 测试：共用 helper 打开设置（账号菜单 → 设置）；测试 profile patch 关闭 `credentialOnboarding`（及预览版说明）；探针改用 `startActivation({ ..., delivery: 'parent' })` / `drainChildren`；作业 id 正则；压缩测试预算与历史长度；恢复测试期望 `aborted(disposed)`；archive 测试去掉重复的 `dsh-schedule`。
- 删除 `src/work-session-titles.ts` 及其在 `src/index.ts` 等处的接线、`tests/title-budget.test.mjs` 与 `titles.test.mjs` 里只验证该补丁的断言（其余标题断言保留）。
- README（中英）、`docs/installation-and-use.md` 的版本要求与安装示例（tgz 文件名 0.2.1）。
- 不改 `src/voice.ts`、`client.js` 的行为（属于 02–04）。

- [x] 用 0.2.1-rc.2 自带 CLI `dsh plugin add` 打包产物不再被拒；`evaluatePluginCompatibility` 对新 manifest 返回 undefined。
- [x] `npm run typecheck` 通过。
- [ ] `npm test` 全套中失败只剩 R6、R8、R9 对应的用例（`cascade-tap` 挂断重拨、`ui` Realtime 模型名、`startup` 新 Host 周期），其余通过或为原有 opt-in 跳过。
- [x] `NEXUS_DESKTOP_SMOKE=1` 下 `desktop.test.mjs` 通过。
- [x] 每处测试改动都能对应到 Spec 的根因，断言的行为不降低。

**Spec 对照：** 诊断结论 R1a–R5、R7；裁定 1–5、9、10；测试决定。
