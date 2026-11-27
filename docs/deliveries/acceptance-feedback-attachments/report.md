# 验收反馈附件交付

派工 `task_8f8e62c26b4b`，项目 `93c839403e97c950673b9923`。独立分支 `AlayaElla/acceptance-feedback-attachments`，开始时工作树干净，HEAD 为派工基线 `40e0b81263690c062a3fd2e2e1a9a8f361fe389a`。

## 面板与宿主接口

在「等你处理」选择验收结论后，原留言可继续输入文字，也可用「添加附件」多选文件、粘贴截图或把文件拖到留言区。已选文件按名称显示，每项可用键盘移除。同一版切换结论时保留附件，草稿重开后可继续编辑。当前验收换版时，旧草稿会标出所属版本。

已通过本机 `orca --version` 和 `orca plugin types coordinator` 核对 Orca 1.4.278。HTML 面板的 `OrcaFrameApi.files` 只有 `saveAs`，面板桥提供 `orca.plugin.request`。生成的面板类型没有原生会话输入框、文件选择、附件上传或宿主拖放事件，AgentBoat 面板原来也没有文件拖放处理。三个入口均使用 frame 的 `File` 字节，经同一个 `panel.feedbackFile` 请求分块写入，历史预览复用原成果预览和 `orca.files.saveAs`。`orca orchestration send --help` 将带 `--file` 的原生附件入口限定在 bot 消息，现有项目 Run 通知继续使用其原入口。

## 保存与可见性

- 反馈、附件引用和使用原项目版本的回执一同写入。项目、任务、验收编号和验收版本由历史位置确定，其中附件只记 ID、文件名、大小和 SHA-256。文件保存在 AgentBoat 自有插件数据目录，现有更新备份会复制该目录。移除、撤销或清空草稿后回收对应暂存文件。
- 附件提交使用当前验收版本及内容指纹，重试复用原请求编号。文件不全、范围不对或版本陈旧时拒绝提交。异常中断可能留下未引用的私有文件，文件读取始终以已提交的历史为准。
- 「任务详情 → 记录」可按原验收版本预览或保存附件。项目主会话收到原反馈通知和附件编号，并能用稳定 CLI 查询经校验的持久文件位置。查询核对当前绑定的主会话、Run 和原验收范围。图片、PDF 和文本走现有预览，其他格式可保存到本机。
- 本机每项最多 10 个附件，每个最多 25 MiB，同一项目一批最多 100 MiB。跨工作间使用原已认证的委托反馈同步和写入凭证，只有开放了该项目的对端且对端已声明附件能力时才发送。附件总计最多 96 KiB，并受现有 180,000 字节同步包约束。旧对端、未开放范围和超限均有明确提示。附件请求使用独立字段，旧对端即使拿到请求也不会把其中的文字当作旧版反馈提交。

项目主会话可用通知给出的原验收信息调用以下入口。

```powershell
node 'C:/Users/Alaya/AppData/Roaming/orca/agentboat-current/coordinator/scripts/client.mjs' feedback-file <项目编号> <任务编号> <验收编号> <验收版本> <附件编号>
```

## 验证结果

- Edge 无头面板夹具在 360px 宽度提交文字、synthetic paste 的 PNG 和键盘唤起选择器选取的 TXT。第三个文件经拖放加入，按 Enter 移除。关闭重开后草稿保留，提交请求含 `p1 / t1 / a1 / 第 1 版` 和两份文件。重新打开任务历史可预览 PNG、读出 TXT 并走 `files.saveAs`。断言无页面错误、无外部网络请求。[面板夹具](../../../coordinator/scripts/panel-browser.mjs) · [360px 草稿截图](acceptance-attachments-draft-360.png)
- Orca 测试运行时挂载真实 Worker 请求处理和文件存储。夹具第 2 版保存两份对应字节，回读保留第 1 版文字。删除第三份、附件不全、陈旧版本及相同请求编号变更内容均被验证。并发重放后历史只写一次，原项目 Run `run_project` 只收到一次通知。重新挂载 Worker 后，授权主会话可定位两份文件并核对原字节，其他会话、项目和版本的读取被拒绝。[Worker 用例](../../../coordinator/src/coordinator.test.ts)
- 两个隔离的回环工作间验证委托附件写入、超限、范围外项目、旧端能力标记和回执丢失后的重放。接收工作间读出原字节，发送工作间的本地历史无该附件。线上传输夹具只绑定 `127.0.0.1`。[委托用例](../../../coordinator/src/links.test.ts)
- 隔离 CLI 用例确认 `feedback-file` 将原验收版本与当前会话的 Run 传到查询接口。前述 Worker 相关用例共 4 项通过，CLI 1 项通过，面板专项 1 项通过。`npm run typecheck`、`npm run build` 和 `orca plugin validate plugin --json` 均通过。[CLI 用例](../../../coordinator/scripts/client.test.mjs)

## 正式验收边界

真实 Orca HTML frame 的系统文件选择器、真实截图粘贴和项目主会话实际送达由协调者在整包安装后核对。本次执行使用无头夹具、假宿主及本机回环，正式插件与项目数据保持原状态。

真实验收可用一条原待验收事项。写留言、粘贴一张截图、添加文本文件和一份随后移除的测试文件，再提交。重开任务详情，从原验收版本打开两份文件，并在原项目主会话核对同一通知及其中的 `feedback-file` 入口。
