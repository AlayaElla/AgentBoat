import { OrcaRuntime, defaultExecutable } from '../src/runtime'
const runtime = new OrcaRuntime(async () => defaultExecutable())
const runId = process.argv[2]
await runtime.verifyRun(runId)
console.log(await runtime.send(runId, { id: 'local-notification-check', subject: '项目协作插件通知自检',
  body: '本地通知链路验证。这是测试资料，无需创建任务或继续派工。', state: 'pending' }))
