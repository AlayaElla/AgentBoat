import path from 'node:path';
import os from 'node:os';
export const executable = process.env.ORCA_CLI_COMMAND || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : 'orca');
