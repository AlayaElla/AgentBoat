import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { after } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { LinkFiles } from './link-files'
import { createCoordinator } from './worker'
import type { CoordinatorRuntime } from './runtime'
const unavailable = async (): Promise<never> => { throw Error('Test runtime operation not configured') }
const root = mkdtempSync(path.join(os.tmpdir(), 'agentboat-links-'))
after(() => rmSync(root, { recursive: true, force: true }))
export const testFiles = () => new LinkFiles(path.join(root, randomUUID()))
export function testCoordinator(api: Parameters<typeof createCoordinator>[0], runtime: Partial<CoordinatorRuntime>, transport?: Parameters<typeof createCoordinator>[2], exportDirectory?: string, files = testFiles(), roleFile?: string) {
  return createCoordinator(api, { projects: async () => [], runBinding: async () => ({ owner: null, generation: 1 }), syncContacts: async () => ({}), installedAgents: async () => ['antigravity', 'claude', 'codex'].map(id => ({ id, name: id, default: id === 'codex' })), verifyRun: async () => {}, send: async () => ({}), targets: async () => ({ sessions: [], workspaces: [] }), identify: unavailable, requestTakeover: unavailable, launchMain: unavailable, openOverview: unavailable, removeProject: unavailable, revealArtifact: unavailable, agents: async () => ({ ok: true, at: Date.now(), agents: [] }), mail: async () => ({ questions: [], reports: [] }), hermesApprovalMode: async () => '', ...runtime }, transport, exportDirectory, files, roleFile)
}
