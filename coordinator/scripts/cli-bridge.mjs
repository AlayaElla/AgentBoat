import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginDataPath, pluginKey } from './orca-cli.mjs';

const limit = 1024 * 1024;
const host = '127.0.0.1';
const timeout = 30_000;
const endpoint = () => path.join(pluginDataPath(), 'cli-endpoint.json');

export function cliBridge(orca) {
  const handlers = new Map();
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from('Bearer ' + token);
  const file = endpoint();
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (req.method !== 'POST' || req.url !== '/request' || req.headers.origin ||
        supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      res.writeHead(403).end();
      return;
    }
    try {
      req.setTimeout(5000, () => req.destroy());
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('请求超过 1 MiB');
        chunks.push(chunk);
      }
      req.setTimeout(0);
      const { name, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const handler = handlers.get(name);
      if (!handler) throw new Error('未知的 AgentBoat 请求');
      const result = await handler(input, {
        panel: { id: 'orca-cli', surface: 'panel', contributionId: 'project-coordinator' },
        signal: AbortSignal.timeout(timeout),
      });
      const body = JSON.stringify({ ok: true, result: { pluginKey, name, result: result ?? null } });
      if (Buffer.byteLength(body) > limit) throw new Error('回执超过 1 MiB');
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    } catch (error) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { code: error.code ?? 'plugin_request_failed', message: error.message } }));
    }
  });
  return {
    api: { ...orca, panels: { ...orca.panels, handle(name, handler) {
      const panel = orca.panels.handle(name, handler);
      handlers.set(name, handler);
      return { dispose() { handlers.delete(name); panel.dispose(); } };
    } } },
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => { server.off('error', reject); resolve(); });
      });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ port: server.address().port, token }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        server.close();
        throw error;
      } finally { await rm(temporary, { force: true }); }
    },
    stop() {
      server.close();
      server.closeAllConnections();
      // Replaced atomically by the next worker; avoid unlinking a newer worker's endpoint.
    },
  };
}

export async function installedRequest(name, input) {
  let destination;
  try { destination = JSON.parse(await readFile(endpoint(), 'utf8')); } catch {
    throw new Error('请先打开 Orca 工作间面板，确认 AgentBoat 已启用');
  }
  const { port, token } = destination;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('AgentBoat 的本机连接信息无效，请重新打开工作间面板');
  }
  const body = JSON.stringify({ name, input });
  if (Buffer.byteLength(body) > limit) throw new Error('请求超过 1 MiB');
  const response = await new Promise((resolve, reject) => {
    const outgoing = request({ host, port, path: '/request', method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeout),
    }, resolve);
    outgoing.on('error', reject);
    outgoing.end(body);
  }).catch(() => { throw new Error('AgentBoat 请求未取得回执，请确认面板已打开，核对原记录后再试'); });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error('AgentBoat 本机连接未通过验证，请重新打开工作间面板');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) throw new Error('回执超过 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
