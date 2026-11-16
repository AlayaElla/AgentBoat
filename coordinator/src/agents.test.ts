import { assert, test } from 'orca/testing'
import { readAgents } from './agents'
import { fresh, projectKey } from './store'
import { refs } from './fixtures'

test('live ps supplies needs/work/done, dispatch only names the task, old/foreign/archived rows are excluded', async () => {
  const p = fresh({ ...refs[0], id: projectKey('local', refs[0].repoId) }); p.runId = 'run_one'
  p.tasks = [{ id: 't1', title: 'matched task', executions: [{ dispatchId: 'd1' }] }] as any
  const now = Date.now(), calls: string[][] = []
  const rows = ['waiting', 'blocked', 'working', 'done', 'idle'].map((state, i) => ({ paneKey: `structured-agent-session-s${i}:pane`, state, stateStartedAt: now - 1000, agentType: 'codex', subagentObservation: i === 2 ? 'unverifiable' : 'live', lastAssistantMessage: 'x'.repeat(500) }))
  const read = async (args: string[]) => {
    calls.push(args)
    if (args[1] === 'worker-list') return { workers: [{ dispatchId: 'd1', resource: { endpointIncarnation: 'structured:s2' } }] }
    if (args[1] === 'run-show') return { run: { coordinator_handle: 'orca_session_id:s0' } }
    return { worktrees: [{ repoId: refs[0].repoId, address: { environment: 'local' }, agents: [...rows, { ...rows[3], paneKey: 'old', stateStartedAt: now - 86400001 }] }, { repoId: 'foreign', address: { environment: 'remote' }, agents: rows }, { repoId: 'archived', address: { environment: 'local' }, isArchived: true, agents: rows }] }
  }
  const s = await readAgents(read, [p])
  assert.equal(s.ok, true); assert.equal(s.agents.length, 5)
  assert.deepEqual(s.agents.map(a => a.state), ['need', 'need', 'work', 'done', 'work'])
  assert.equal(s.agents[0].role, 'lead'); assert.equal(s.agents[2].taskId, 't1'); assert.equal(s.agents[2].title, 'matched task'); assert.equal(s.agents[2].verified, false)
  assert.equal(s.agents[0].last.length, 200); assert.ok(calls[0].includes('--agent-wait'))
  assert.equal((await readAgents(async () => ({ truncated: true }), [p])).ok, false)
  assert.equal((await readAgents(async () => { throw Error('unavailable') }, [p])).agents.length, 0)
})
