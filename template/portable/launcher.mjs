import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function packageLayout(root = ROOT) {
  root = path.resolve(root);
  const windows = process.platform === 'win32';
  return {
    root,
    launcher: path.join(root, 'portable', 'launcher.mjs'),
    keys: path.join(root, 'portable', 'keys.mjs'),
    config: path.join(root, 'portable', 'config.json'),
    bootstrap: path.join(root, 'portable', 'bootstrap.mjs'),
    patch: path.join(root, 'portable', 'profile.patch.yml'),
    node: path.join(root, 'runtime', 'node', windows ? 'node.exe' : 'bin/node'),
    python: path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'python', windows ? 'python.exe' : 'bin/python3'),
    pnpm: path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    git: path.join(root, 'runtime', 'git', windows ? 'cmd/git.exe' : 'bin/git'),
    dsh: path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    home: path.join(root, 'data', 'dsh-home'),
    runtime: path.join(root, 'data', 'runtime'),
    state: path.join(root, 'data', 'runtime', 'state.json'),
    lock: path.join(root, 'data', 'runtime', 'start.lock'),
    workspace: path.join(root, 'workspace'),
    logs: path.join(root, 'logs'),
  };
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function privateJson(file, data) {
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function settings(layout) {
  const config = await readJson(layout.config) ?? {};
  const startupTimeoutMs = config.startupTimeoutMs ?? 90_000;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;
  for (const [name, value] of Object.entries({ startupTimeoutMs, shutdownTimeoutMs })) {
    if (!Number.isInteger(value) || value < 500 || value > 300_000) throw new Error(`${name} 必须是 500 至 300000 之间的整数。`);
  }
  return { startupTimeoutMs, shutdownTimeoutMs };
}

export function buildLaunchEnvironment(layout, source = process.env, keyEnvironment = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (/^(DSH_|GIT_CONFIG_)/i.test(name)
      || /^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|OPENCODE_GO_API_KEY|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|PATH|PYTHONHOME|PYTHONPATH)$/i.test(name)) continue;
    environment[name] = value;
  }
  const bins = [path.dirname(layout.node), path.dirname(layout.python), path.dirname(layout.git)];
  const oldPath = Object.entries(source).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  environment.PATH = [...bins, oldPath].filter(Boolean).join(path.delimiter);
  environment.DSH_HOME = layout.home;
  environment.DSH_AGENTS_HOME = path.join(layout.root, 'data', 'agents-home');
  environment.DSH_PORTABLE_ROOT = layout.root;
  environment.DSH_TELEMETRY_DISABLED = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = path.join(layout.root, 'portable', 'gitconfig');
  for (const [name, value] of Object.entries(keyEnvironment)) {
    if (!['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENCODE_GO_API_KEY'].includes(name)) throw new Error('密钥模块返回了不支持的环境变量。');
    if (typeof value !== 'string') throw new Error('密钥环境变量必须是字符串。');
    if (value) environment[name] = value;
  }
  return environment;
}

export function redactDiagnostic(message, secrets = []) {
  let result = String(message);
  for (const secret of secrets.filter(value => typeof value === 'string' && value)) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/([?&]token=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .slice(0, 8000);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function validState(layout, state) {
  return state?.version === 1 && samePath(state.packageRoot, layout.root)
    && Number.isInteger(state.pid) && state.pid > 0
    && typeof state.instanceId === 'string' && /^[a-f0-9]{48}$/.test(state.instanceId)
    && typeof state.startedAt === 'string' && Number.isFinite(Date.parse(state.startedAt))
    && Number.isInteger(state.controlPort) && state.controlPort > 0 && state.controlPort < 65536
    && typeof state.controlToken === 'string' && /^[a-f0-9]{64}$/.test(state.controlToken)
    && typeof state.launchLog === 'string' && within(layout.logs, state.launchLog);
}

export function sameInstance(state, reply, root) {
  return samePath(state.packageRoot, root) && samePath(reply?.packageRoot, root)
    && reply.pid === state.pid && reply.instanceId === state.instanceId && reply.startedAt === state.startedAt;
}

function publicStatus(layout, state, status = state.status) {
  let baseUrl = null;
  try {
    const url = new URL(state.baseUrl);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password) {
      url.search = '';
      url.hash = '';
      baseUrl = url.href;
    }
  } catch { /* Starting and stopped records may not have a service address. */ }
  const result = {
    status,
    ready: status === 'running',
    packageRoot: layout.root,
    pid: state.pid,
    serverPid: state.serverPid,
    instanceId: state.instanceId,
    startedAt: state.startedAt,
    port: state.port,
    baseUrl,
    url: baseUrl,
    launchLog: state.launchLog,
  };
  if (state.error) result.error = '本包服务启动失败或已经退出；请检查启动日志。';
  return result;
}

async function control(state, action) {
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${state.controlToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('便携服务身份验证失败。');
  return response.json();
}

export async function statusPackage(root = ROOT) {
  const layout = packageLayout(root);
  let state;
  try { state = await readJson(layout.state); }
  catch { return { status: 'unverified', ready: false, packageRoot: layout.root, reason: 'invalid-state' }; }
  if (state === null) return { status: 'stopped', ready: false, packageRoot: layout.root, reason: 'no-state' };
  // A copied state must never contact the service or stop the PID at the old location.
  if (!samePath(state.packageRoot, layout.root)) return { status: 'stopped', ready: false, packageRoot: layout.root, reason: 'moved' };
  if (!validState(layout, state)) return { status: 'unverified', ready: false, packageRoot: layout.root, reason: 'invalid-state' };
  if (state.status === 'stopped' || state.status === 'failed') return publicStatus(layout, state);
  if (!alive(state.pid)) return { ...publicStatus(layout, state, 'stopped'), ready: false, reason: 'process-exited' };
  try {
    const reply = await control(state, 'status');
    if (!sameInstance(state, reply, layout.root) || !['starting', 'running', 'stopping', 'failed', 'stopped'].includes(reply.status)
      || reply.launchLog !== state.launchLog) throw new Error('服务启动身份不匹配。');
    return publicStatus(layout, reply);
  } catch {
    return { status: 'unverified', ready: false, packageRoot: layout.root, reason: 'ownership-not-verified' };
  }
}

async function acquireStartLock(layout, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const handle = await open(layout.lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ packageRoot: layout.root, pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await rm(layout.lock, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(layout.lock);
      if (owner && (!samePath(owner.packageRoot, layout.root) || !alive(owner.pid))) {
        await rm(layout.lock, { force: true });
        continue;
      }
      await pause(150);
    }
  }
  throw new Error('另一个启动操作尚未完成；请稍后重试或运行 doctor。');
}

export function parseReadyUrl(text) {
  const match = text.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || !url.port || !url.searchParams.get('token')) return null;
    return url.href;
  } catch { return null; }
}

async function authenticatedReady(authenticatedUrl) {
  const url = new URL(authenticatedUrl);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
  await response.body?.cancel();
  if (response.status !== 303 || cookies.length === 0) throw new Error('DSH 认证入口尚未就绪。');
  url.search = '';
  const clean = await fetch(url, {
    headers: { cookie: cookies.map(cookie => cookie.split(';', 1)[0]).join('; ') },
    redirect: 'error', signal: AbortSignal.timeout(2500),
  });
  await clean.body?.cancel();
  if (clean.status !== 200) throw new Error('DSH 工作区页面尚未就绪。');
}

function constantEqual(actual, expected) {
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function runSupervisor(root, instanceId) {
  const layout = packageLayout(root);
  const config = await settings(layout);
  await Promise.all([layout.home, layout.runtime, layout.workspace, layout.logs].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  const logFile = path.join(layout.logs, `dsh-${instanceId}.log`);
  const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  const state = {
    version: 1, packageRoot: layout.root, pid: process.pid, instanceId,
    startedAt: new Date().toISOString(), status: 'starting', serverPid: null,
    port: null, baseUrl: null, serviceUrl: null, launchLog: logFile,
    controlPort: null, controlToken: randomBytes(32).toString('hex'),
  };
  let child;
  let stopping = false;
  let ended = false;
  let readyUrl;
  const knownSecrets = [state.controlToken];
  let tail = '';
  let writeQueue = Promise.resolve();
  const persist = () => {
    const snapshot = { ...state };
    writeQueue = writeQueue.then(() => privateJson(layout.state, snapshot));
    return writeQueue;
  };
  let completeLifetime;
  const lifetime = new Promise(resolve => { completeLifetime = resolve; });
  const server = createServer(async (request, response) => {
    const authorized = constantEqual(String(request.headers.authorization ?? ''), `Bearer ${state.controlToken}`);
    if (!authorized || request.headers.host !== `127.0.0.1:${state.controlPort}`) {
      response.writeHead(401); response.end(); return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(publicStatus(layout, state)));
    } else if (request.method === 'POST' && request.url === '/stop') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(publicStatus(layout, state, 'stopping')));
      void shutdown().catch(() => { process.exitCode = 1; });
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  state.controlPort = server.address().port;
  await persist();

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    state.status = 'stopping';
    await persist();
    if (child && !ended) {
      // Use the ChildProcess handle owned by this supervisor, never a PID from disk.
      child.kill('SIGTERM');
      const deadline = Date.now() + config.shutdownTimeoutMs;
      while (!ended && Date.now() < deadline) await pause(50);
      if (!ended) child.kill('SIGKILL');
      const finalDeadline = Date.now() + 3000;
      while (!ended && Date.now() < finalDeadline) await pause(50);
      if (!ended) throw new Error('本包 DSH 进程尚未退出。');
    }
    state.status = 'stopped';
    await persist();
    await new Promise(resolve => server.close(resolve));
    log.end();
    completeLifetime();
  }

  try {
    const keyModule = await import(pathToFileURL(layout.keys).href);
    const keyConfig = await keyModule.loadKeyConfig(layout.root);
    const keyEnvironment = keyModule.keyLaunchEnvironment(keyConfig);
    knownSecrets.push(...Object.values(keyEnvironment));
    const environment = buildLaunchEnvironment(layout, process.env, keyEnvironment);
    const providerPath = path.join(root, 'portable/providers.mjs');
    const providerPatches = existsSync(providerPath)
      ? ['--patch', (await (await import(pathToFileURL(providerPath).href)).prepareProviders(root, keyConfig)).patch] : [];
    child = spawn(layout.node, [layout.dsh, '--profile', 'web', '--patch', layout.patch, ...providerPatches,
      '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: layout.workspace, env: environment, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.serverPid = child.pid ?? null;
    child.stdout.on('data', chunk => {
      log.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-32768);
      readyUrl ??= parseReadyUrl(tail);
    });
    child.stderr.on('data', chunk => log.write(chunk));
    child.once('error', () => { ended = true; });
    child.once('close', code => {
      ended = true;
      if (!stopping && state.status === 'running') {
        state.status = 'failed';
        state.error = `DSH 服务已退出（退出码 ${code ?? 'unknown'}）；详情见本包启动日志。`;
        void persist().then(() => shutdown());
      }
    });
    await persist();
    const deadline = Date.now() + config.startupTimeoutMs;
    let verified = false;
    while (Date.now() < deadline && !stopping) {
      if (ended) throw new Error('DSH 启动进程提前退出；详情见本包启动日志。');
      if (readyUrl) {
        try { await authenticatedReady(readyUrl); verified = true; break; }
        catch { /* The announcement may precede the first successful HTTP request. */ }
      }
      await pause(100);
    }
    if (stopping) return await lifetime;
    if (!verified) throw new Error('DSH 启动超时；详情见本包启动日志。');
    const url = new URL(readyUrl);
    state.serviceUrl = url.href;
    state.port = Number(url.port);
    url.search = '';
    state.baseUrl = url.href;
    if (existsSync(layout.bootstrap)) {
      const bootstrap = await import(pathToFileURL(layout.bootstrap).href);
      await bootstrap.bootstrapPortable(layout.root, {
        baseUrl: state.baseUrl, authenticatedUrl: state.serviceUrl,
        launchLog: state.launchLog, port: state.port, serverPid: state.serverPid,
      });
    }
    if (!stopping) {
      if (ended) throw new Error('DSH 在工作区准备期间退出。');
      state.status = 'running';
      await persist();
    }
  } catch (error) {
    state.status = 'failed';
    // The launch log is private. Public diagnostics must never echo third-party errors containing keys or URLs.
    state.error = 'DSH 启动失败；请运行 doctor 并检查本包启动日志。';
    if (readyUrl) knownSecrets.push(new URL(readyUrl).searchParams.get('token'));
    log.write(`\n[portable] startup failure (${error.code ?? error.name ?? 'Error'}): ${redactDiagnostic(error.message ?? error, knownSecrets)}\n`);
    await persist();
    if (child && !ended) child.kill('SIGTERM');
    await pause(500);
    if (child && !ended) child.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    log.end();
    process.exitCode = 1;
    completeLifetime();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await lifetime;
}

async function browserOpen(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const opener = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { opener.once('spawn', resolve); opener.once('error', reject); });
  opener.unref();
}

export async function startPackage(root = ROOT, options = {}) {
  const layout = packageLayout(root);
  const config = await settings(layout);
  await mkdir(layout.runtime, { recursive: true, mode: 0o700 });
  const release = await acquireStartLock(layout, config.startupTimeoutMs + 5000);
  try {
    let summary = await statusPackage(root);
    if (summary.status === 'unverified') throw new Error('已有状态的服务归属无法验证；拒绝启动或停止其他进程，请运行 doctor。');
    if (summary.status !== 'running' && summary.status !== 'starting') {
      for (const file of [layout.node, layout.dsh, layout.keys]) {
        if (!existsSync(file)) throw new Error(`便携包缺少必需文件：${path.relative(layout.root, file)}`);
      }
      const instanceId = randomBytes(24).toString('hex');
      const child = spawn(layout.node, [layout.launcher, '_serve', instanceId], {
        cwd: layout.root, detached: true, windowsHide: true, stdio: 'ignore',
        env: buildLaunchEnvironment(layout),
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      const deadline = Date.now() + config.startupTimeoutMs + 5000;
      while (Date.now() < deadline) {
        summary = await statusPackage(root);
        if (summary.instanceId === instanceId && summary.status === 'running') break;
        if (summary.instanceId === instanceId && summary.status === 'failed') throw new Error(summary.error);
        if (!alive(child.pid)) throw new Error('便携后台管理进程提前退出；请运行 doctor。');
        await pause(150);
      }
      if (summary.instanceId !== instanceId || summary.status !== 'running') throw new Error('等待便携服务启动超时；请运行 doctor。');
    } else if (summary.status === 'starting') {
      const deadline = Date.now() + config.startupTimeoutMs;
      while (summary.status === 'starting' && Date.now() < deadline) { await pause(150); summary = await statusPackage(root); }
      if (summary.status !== 'running') throw new Error('已有便携服务未能完成启动；请运行 doctor。');
    }
    if (!options.noOpen) {
      const state = await readJson(layout.state);
      if (!validState(layout, state) || !sameInstance(state, summary, root)) throw new Error('浏览器打开前服务身份发生变化。');
      try { await (options.openBrowser ?? browserOpen)(state.serviceUrl); }
      catch { summary = { ...summary, warning: '服务已启动，但浏览器未能自动打开。' }; }
    }
    return summary;
  } finally { await release(); }
}

export async function stopPackage(root = ROOT) {
  const layout = packageLayout(root);
  const current = await statusPackage(root);
  if (current.status === 'stopped' || current.status === 'failed') return current;
  if (!['starting', 'running', 'stopping'].includes(current.status)) throw new Error('服务归属无法验证；拒绝根据旧 PID 停止进程。');
  const state = await readJson(layout.state);
  if (!validState(layout, state) || !sameInstance(state, current, root)) throw new Error('停止前服务身份发生变化；未结束任何进程。');
  const reply = await control(state, 'stop');
  if (!sameInstance(state, reply, root)) throw new Error('停止响应的服务身份不匹配。');
  const config = await settings(layout);
  const deadline = Date.now() + config.shutdownTimeoutMs + 5000;
  while (Date.now() < deadline) {
    const status = await statusPackage(root);
    if (status.status === 'stopped') return status;
    await pause(100);
  }
  throw new Error('本包服务尚未完成停止，请运行 status；未尝试停止其他进程。');
}

export async function doctorPackage(root = ROOT) {
  const layout = packageLayout(root);
  return {
    ...await statusPackage(root),
    files: Object.fromEntries(['node', 'python', 'pnpm', 'git', 'dsh', 'keys', 'patch'].map(name => [name, {
      path: path.relative(layout.root, layout[name]), present: existsSync(layout[name]),
    }])),
    dataDirectory: layout.home,
    workspace: layout.workspace,
  };
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === '_serve') {
    if (args.length !== 1 || !/^[a-f0-9]{48}$/.test(args[0])) throw new Error('无效的后台启动身份。');
    return runSupervisor(ROOT, args[0]);
  }
  if (args.some(arg => arg !== '--no-open') || (command !== 'start' && args.length)) throw new Error('用法：launcher.mjs start [--no-open] | status | stop | doctor');
  const operations = {
    start: () => startPackage(ROOT, { noOpen: args.includes('--no-open') }),
    status: () => statusPackage(ROOT), stop: () => stopPackage(ROOT), doctor: () => doctorPackage(ROOT),
  };
  if (!operations[command]) throw new Error('未知命令；可用命令：start、status、stop、doctor。');
  process.stdout.write(`${JSON.stringify(await operations[command]())}\n`);
}

if (process.argv[1] && samePath(process.argv[1], HERE)) {
  main().catch(() => {
    process.stderr.write('便携启动操作失败；请运行 doctor 并查看本包 logs。\n');
    process.exitCode = 1;
  });
}
