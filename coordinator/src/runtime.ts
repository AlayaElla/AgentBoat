import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import type { Delivery, ProjectRef } from './model'
import { fail, projectKey } from './store'

const execute = promisify(execFile)
export interface CoordinatorRuntime {
  projects(): Promise<ProjectRef[]>
  verifyRun(id: string): Promise<void>
  send(runId: string, delivery: Delivery): Promise<{ requestId?: string }>
}
export class OrcaRuntime implements CoordinatorRuntime {
  constructor(private executable: () => Promise<string>) {}
  private async call(args: string[]): Promise<any> {
    let stdout: string
    try {
      ({ stdout } = await execute(await this.executable(), [...args, '--environment', 'local', '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], {
        timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, ORCA_ENVIRONMENT: 'local', ...(process.platform === 'win32' ? {
          APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        } : {}) }
      }))
    } catch (e) {
      const output = (e as {stdout?: string}).stdout
      if (!output) throw e
      try { const reply = JSON.parse(output); throw new Error(reply.error?.message ?? 'Orca 请求未成功') }
      catch (parseError) { if (parseError instanceof SyntaxError) throw e; throw parseError }
    }
    const reply = JSON.parse(stdout)
    if (!reply.ok) throw new Error(reply.error?.message ?? 'Orca 请求未成功')
    return reply.result
  }
  async projects(): Promise<ProjectRef[]> {
    const result = await this.call(['worktree', 'ps'])
    if (result.truncated) fail('Orca 项目列表未完整返回，请先缩小工作区范围')
    const projects = new Map<string, ProjectRef>()
    for (const w of result.worktrees ?? []) {
      if (!w.repoId || !w.path || !w.address?.worktree || w.address.environment !== 'local') continue
      const hostId = w.hostId ?? 'local'
      if (hostId !== 'local') continue
      const id = projectKey(hostId, w.repoId)
      if (!projects.has(id) || w.isMainWorktree) projects.set(id, {
        id, repoId: w.repoId, hostId, name: w.repo || w.displayName || path.basename(w.path),
        path: w.path, workspace: w.address.worktree
      })
    }
    return [...projects.values()]
  }
  async verifyRun(id: string): Promise<void> {
    if (!/^run_[\w-]+$/.test(id)) fail('Run 编号格式不正确')
    const result = await this.call(['orchestration', 'run-show', '--id', id])
    if (result.run?.id !== id) fail('Orca 未返回对应 Run')
  }
  async send(runId: string, delivery: Delivery): Promise<{ requestId?: string }> {
    const result = await this.call(['orchestration', 'send', '--from', 'plugin:local.project-coordinator', '--to', `run:${runId}`, '--type', 'status',
      '--subject', delivery.subject, '--body', delivery.body])
    return { requestId: result.mutation?.requestId }
  }
}
export function defaultExecutable(): string {
  return process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : 'orca')
}
