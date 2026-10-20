import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

export const stateDirectory = process.env.DSH_CODEX_STATE_DIR || join(homedir(), '.dsh', 'codex-bridge');
const connectionFile = join(stateDirectory, 'connection.json');

function localUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('仅支持本机回环 HTTP 地址。');
  }
  return url;
}

export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Use the Host's official launch-token exchange; never manufacture credentials.
export async function pairFromLog(logPath) {
  const log = await readFile(logPath, 'utf8');
  const matches = [...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[A-Za-z0-9_%-]+/g)];
  if (!matches.length) throw new Error('启动日志中没有 DSH 登录地址。请使用当前运行实例的启动日志。');
  const login = localUrl(matches.at(-1)[0]);
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]);
  if (!cookies.length || ![200, 302, 303].includes(response.status)) {
    throw new Error('登录交换失败。日志可能属于已关闭的实例；需要当前实例的启动日志。');
  }
  const connection = { baseUrl: login.origin, cookie: cookies.join('; '), pairedAt: new Date().toISOString() };
  await saveJson(connectionFile, connection);
  return { connected: true, baseUrl: connection.baseUrl, credentialLocation: connectionFile };
}

// Reuse only the desktop app's existing DSH Host login cookie. No model keys,
// other cookies, or signing secrets are read. Windows desktop stores this
// local-only session cookie as plaintext in its own Electron cookie database.
export async function pairDesktop(baseUrl = 'http://127.0.0.1:19387') {
  const url = localUrl(baseUrl);
  const name = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'), { readOnly: true });
  let row;
  try {
    row = database.prepare('SELECT value FROM cookies WHERE host_key = ? AND name = ?').get(url.hostname, name);
  } finally { database.close(); }
  if (!row?.value) throw new Error('没有找到该桌面实例的登录会话。先打开 DSH 桌面版，或使用启动日志配对网页端。');
  const saved = { baseUrl: url.origin, cookie: `${name}=${row.value}`, pairedAt: new Date().toISOString() };
  const response = await fetch(url.origin, { headers: { cookie: saved.cookie }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (response.status !== 200) throw new Error('桌面登录会话已失效。先正常打开 DSH，再重新配对。');
  await saveJson(connectionFile, saved);
  return { connected: true, baseUrl: saved.baseUrl, credentialLocation: connectionFile };
}

export async function connection() {
  const saved = await readJson(connectionFile, null);
  if (!saved) throw new Error('尚未配对。调用 dsh_connect，传入当前 DSH 启动日志的绝对路径。');
  localUrl(saved.baseUrl);
  return saved;
}

export async function rpc(method, args = {}) {
  const saved = await connection();
  const rpcId = randomUUID();
  let response;
  try {
    response = await fetch(new URL(`/api/${method}`, saved.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', origin: saved.baseUrl, cookie: saved.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('无法连接 DSH：请先打开 DSH 桌面版；此工具不会关闭或自动重启 DSH。');
  }
  if (response.status === 401 || response.status === 403) throw new Error('DSH 登录凭据失效，请用当前启动日志重新运行 dsh_connect。');
  if (!response.ok) throw new Error(`DSH HTTP ${response.status}，方法 ${method}`);
  const envelope = await response.json();
  if (envelope.rpcId !== rpcId) throw new Error('DSH 响应身份不匹配。');
  if (!envelope.result?.ok) {
    const error = envelope.result?.error;
    throw new Error(`${method}: ${error?.code || 'RPC_ERROR'}: ${error?.message || '调用失败'}`);
  }
  return envelope.result.value;
}
