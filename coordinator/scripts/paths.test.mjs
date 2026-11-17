import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { clientPath, userDataPath } from './paths.mjs';

test('Orca paths honor profiles and platform defaults; takeover script exists', () => {
  assert.equal(userDataPath('darwin', {}, '/Users/test'), path.join('/Users/test', 'Library', 'Application Support', 'orca'));
  assert.equal(userDataPath('win32', { APPDATA: 'roaming' }, 'home'), path.join('roaming', 'orca'));
  assert.equal(userDataPath('linux', { XDG_CONFIG_HOME: 'config' }, 'home'), path.join('config', 'orca'));
  for (const platform of ['darwin', 'win32', 'linux']) assert.equal(userDataPath(platform, { ORCA_USER_DATA_PATH: 'custom-profile' }), 'custom-profile');
  assert.ok(path.isAbsolute(clientPath)); assert.ok(existsSync(clientPath));
});
