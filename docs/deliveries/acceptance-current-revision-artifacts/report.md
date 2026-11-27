# 验收卡只关联本轮需核对的成果

## 原提交

在本机只读核对 Parking_Loop `9fe1ecb41de1ea4ffbb05e97` 的 `parking-loop-background-ui-reskin` 任务。`verify-parking-loop-ui-approved-supplement` 第 6 版在 2026-11-27 07:41:36 UTC 通过，第 7 版在 07:50:38 UTC 通过。

原提交文件 `%TEMP%/parking-ui-supplement-v7-stock-halo-ready.json` 使用同名 `requestId`，项目 `revision` 为 `1750`。按照 CLI 补入 `operation` 和原主会话 `caller` 后，请求指纹与本机插件记录的回执一致。原验收字段算出的指纹也与第 7 版已保存的验收指纹一致。

| 原请求字段 | 成果编号，按请求顺序 |
| --- | --- |
| `task.artifacts` 登记的本轮成果 | `parking-ui-v7-stock-halo-movie`、`parking-ui-v7-stock-halo-pose`、`parking-ui-v7-stock-halo-source-proof` |
| `task.acceptance[].artifactIds` | 先列出上述三项，再列 `parking-profile-v6-owner-candidate`、`parking-profile-v6-wordless-board`、`parking-profile-v6-board-proof` |

旧三项已在 `parking-ui-home-v10-profile-v6-combo-v3-ready` 登记。第 7 版请求明确把它们也列进了关联。客户端和桥接层原样传递此字段，Worker 按条目保存完整数组，「等你处理」从任务成果中显示当前数组引用的条目。任务详情的「成果」列出已登记的成果入口，「记录」按验收版本保留反馈。 [客户端](../../../coordinator/scripts/client.mjs) · [桥接](../../../coordinator/scripts/cli-bridge.mjs) · [提交](../../../coordinator/src/store.ts) · [面板](../../../coordinator/src/panel-page.ts)

## 修订与验证

项目协作指引和桥接示例现在要求沿用验收编号，并逐项重填本轮需要用户打开核对的完整 `artifactIds`。本轮确需复核的既有成果可明确列入。其他旧成果在任务详情查找。 [项目协作](../../../coordinator/skill/orca-project-coordinator/SKILL.md) · [提交示例](../../../coordinator/skill/orca-project-coordinator/references/bridge.md)

同一隔离样例复用 Worker 假宿主与 Edge 无头面板。从第 6 版已通过的状态，用原验收编号提交第 7 版，仅关联表中的三项本轮成果。Worker 读回第 7 版待验收，完整任务仍含此前成果，第 6 版的通过记录逐字段一致。打开「等你处理」实际验收卡，三个成果入口分别为「第 13 关队首柔光、原发车和补位」「第 13 关柔光、待发尾姿与接地影同屏」「生图源、阻挡状态和引导验证」。点「任务详情 → 成果」可见原来的三项档案成果，点第一项核对其打开请求仍指向原成果编号。「任务详情 → 记录」可见「第 6 版 · 已通过」。页面错误和外部请求均为零。 [Worker 测试宿主](../../../coordinator/src/test-runtime.ts) · [无头面板](../../../coordinator/scripts/panel-browser.mjs)

本次验收使用假宿主和无头面板，打开旧文件的检查覆盖路由及成果编号。真实 Orca 窗口和 Parking_Loop 文件未参与重放，原有通过结论来自只读项目记录。
