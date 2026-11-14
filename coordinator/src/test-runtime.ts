import { createCoordinator } from './worker'
import type { CoordinatorRuntime } from './runtime'
const unavailable = async (): Promise<never> => { throw Error('Test runtime operation not configured') }
export function testCoordinator(api: Parameters<typeof createCoordinator>[0], runtime: Partial<CoordinatorRuntime>, ...rest: [Parameters<typeof createCoordinator>[2]?, string?]) {
  return createCoordinator(api, { projects: async () => [], verifyRun: async () => {}, send: async () => ({}), mainAgent: async () => undefined, targets: async () => ({ sessions: [], workspaces: [] }), identify: unavailable, requestTakeover: unavailable, launchMain: unavailable, openOverview: unavailable, removeProject: unavailable, openCanvas: unavailable, hermesApprovalMode: async () => '', ...runtime }, ...rest)
}
