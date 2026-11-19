import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cliBridge, installedRequest } from './cli-bridge.mjs';
import { pluginDataPath, pluginKey } from './orca-cli.mjs';

test('local CLI shares panel handlers and rejects unauthenticated callers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentboat-bridge-'));
  const original = process.env.ORCA_USER_DATA_PATH;
  process.env.ORCA_USER_DATA_PATH = root;
  const bridge = cliBridge({ panels: { handle: () => ({ dispose() {} }) } });
  let calls = 0;
  bridge.api.panels.handle('test.echo', input => { calls++; return input; });
  try {
    await bridge.start();
    const { port } = JSON.parse(await readFile(path.join(pluginDataPath(), 'cli-endpoint.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/request`, {
      method: 'POST', body: JSON.stringify({ name: 'test.echo', input: { value: 1 } }),
    });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
    const input = { value: 2 };
    assert.deepEqual(await installedRequest('test.echo', input), { ok: true, result: { pluginKey, name: 'test.echo', result: input } });
    assert.equal(calls, 1);
    assert.equal((await installedRequest('missing', null)).ok, false);
  } finally {
    bridge.stop();
    if (original === undefined) delete process.env.ORCA_USER_DATA_PATH;
    else process.env.ORCA_USER_DATA_PATH = original;
    await rm(root, { recursive: true, force: true });
  }
});
