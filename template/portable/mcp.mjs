import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SERVER_NAME = 'dsh-portable';
const here = fileURLToPath(import.meta.url);
export const packageRoot = path.resolve(path.dirname(here), '..');

export function portableMcpConfig(root = packageRoot) {
  return {
    command: path.join(root, 'runtime', 'node', 'node.exe'),
    args: [path.join(root, 'portable', 'mcp.mjs')],
  };
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export async function readPortableState(root) {
  let state;
  try {
    state = JSON.parse(await readFile(path.join(root, 'data', 'runtime', 'state.json'), 'utf8'));
  } catch {
    throw new Error('便携服务状态不可用。请查看本包 logs 目录后重新启动。');
  }
  if (typeof state.packageRoot !== 'string' || !samePath(state.packageRoot, root)) {
    throw new Error('服务状态属于另一位置的便携包，拒绝连接。请重新启动当前便携包。');
  }
  if (typeof state.launchLog !== 'string' || !path.isAbsolute(state.launchLog)
    || !inside(path.join(root, 'logs'), state.launchLog)) {
    throw new Error('服务状态没有有效的包内启动日志，拒绝配对。');
  }
  // Reject a junction/symlink to an unrelated log before the bridge reads it.
  const [logsRoot, launchLog] = await Promise.all([
    realpath(path.join(root, 'logs')),
    realpath(state.launchLog),
  ]);
  if (!inside(logsRoot, launchLog)) throw new Error('启动日志位于便携包之外，拒绝配对。');
  let baseUrl;
  try {
    baseUrl = new URL(state.baseUrl || state.serviceUrl || `http://127.0.0.1:${state.port}`);
  } catch {
    throw new Error('服务状态没有有效的本机地址。');
  }
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)
    || baseUrl.username || baseUrl.password) {
    throw new Error('便携 MCP 仅连接本包的本机回环服务。');
  }
  return { ...state, launchLog, baseUrl: baseUrl.origin };
}

export function runHidden(command, args, { cwd, env = process.env, timeoutMs = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('辅助命令超时。'));
    }, timeoutMs);
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          child.kill();
          finish(new Error('辅助命令输出过多。'));
        } else chunks[name].push(chunk);
      });
    }
    child.once('error', () => finish(new Error('无法运行辅助命令，请检查包内 Node 或 Codex CLI。')));
    child.once('close', code => finish(null, {
      code,
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
    }));
  });
}

export async function initializePortableHost(root = packageRoot, {
  env = process.env,
  runner = runHidden,
  importer = url => import(url),
  log = text => process.stderr.write(`[DSH Portable] ${text}\n`),
} = {}) {
  const config = portableMcpConfig(root);
  env.DSH_CODEX_STATE_DIR = path.join(root, 'data', 'bridge');
  await mkdir(env.DSH_CODEX_STATE_DIR, { recursive: true, mode: 0o700 });
  log('正在检查本包 DSH 服务。');
  const launched = await runner(config.command, [path.join(root, 'portable', 'launcher.mjs'), 'start', '--no-open'], {
    cwd: root,
    env,
  });
  // Do not forward launcher output: logs can contain a launch token.
  if (launched.code !== 0) throw new Error('本包 DSH 启动失败，请查看 logs 目录。');
  const state = await readPortableState(root);
  env.DSH_PORTABLE_LAUNCH_LOG = state.launchLog;
  env.DSH_PORTABLE_BASE_URL = state.baseUrl;
  const connection = await importer(pathToFileURL(path.join(root, 'bridge', 'connection.mjs')).href);
  let paired = false;
  try {
    const saved = await connection.connection();
    if (saved.baseUrl === state.baseUrl) {
      const response = await fetch(state.baseUrl, {
        headers: { cookie: saved.cookie }, redirect: 'manual', signal: AbortSignal.timeout(10000),
      });
      paired = response.status === 200;
    }
  } catch {
    // Missing/expired cookies are paired using only the current package's log.
  }
  if (!paired) {
    try {
      await connection.pairFromLog(state.launchLog);
    } catch {
      throw new Error('本包 DSH 配对失败，请检查 logs 或重新启动本便携包。');
    }
    const saved = await connection.connection();
    if (saved.baseUrl !== state.baseUrl) throw new Error('登录地址与当前便携服务不一致，拒绝连接。');
  }
  log('本包 DSH 已连接，工具现在可以执行任务。');
  return state;
}

export async function bootstrapPortableMcp(root = packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const importer = options.importer ?? (url => import(url));
  const log = options.log ?? (text => process.stderr.write(`[DSH Portable] ${text}\n`));
  // Set this before importing the bridge, whose state paths are module constants.
  env.DSH_CODEX_STATE_DIR = path.join(root, 'data', 'bridge');
  const ready = initializePortableHost(root, { ...options, env, importer, log });
  // Handle background failures immediately; individual tool calls still receive
  // the same rejection. MCP initialize and tools/list do not wait for DSH.
  ready.catch(() => log('本包 DSH 初始化失败；工具调用将返回诊断，请检查 logs 并重新加载 MCP。'));
  const server = await importer(pathToFileURL(path.join(root, 'bridge', 'server.mjs')).href);
  if (typeof server.startPortableServer !== 'function') throw new Error('本包 MCP 服务入口无效，请重新构建便携包。');
  return server.startPortableServer({ ready });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function resolveCodexCommand(root, { executable, env = process.env } = {}) {
  const candidates = [];
  if (executable) candidates.push(path.resolve(executable));
  else {
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['', '.js'];
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) candidates.push(path.join(directory.replace(/^"|"$/g, ''), `codex${extension}`));
    }
  }
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const extension = path.extname(candidate).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      // Run the npm CLI's JS entry with the bundled Node, without a shell or npm.
      const entry = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (await exists(entry)) return { command: portableMcpConfig(root).command, prefix: [entry] };
      continue;
    }
    if (extension === '.js' || extension === '.mjs') {
      return { command: portableMcpConfig(root).command, prefix: [candidate] };
    }
    return { command: candidate, prefix: [] };
  }
  throw new Error('未找到可用 Codex CLI。可用 --codex 指定 Codex.exe 或官方 codex.js 的绝对路径；也可使用 --config 手动配置。');
}

function serverEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.servers)) return parsed.servers;
    return Object.entries(parsed).map(([name, value]) => ({ name, ...value }));
  }
  throw new Error('Codex MCP 列表格式不可识别，未修改注册。');
}

export async function registerPortableCodex(root = packageRoot, {
  env = process.env,
  executable,
  runner = runHidden,
  resolver = resolveCodexCommand,
  now = () => new Date(),
} = {}) {
  const config = portableMcpConfig(root);
  await access(config.command);
  await access(config.args[0]);
  const cli = await resolver(root, { executable, env });
  const command = args => runner(cli.command, [...cli.prefix, ...args], { cwd: root, env });
  const listed = await command(['mcp', 'list', '--json']);
  if (listed.code !== 0) throw new Error('Codex MCP 列表读取失败，未修改任何注册。');
  let entries;
  try { entries = serverEntries(JSON.parse(listed.stdout)); }
  catch { throw new Error('Codex MCP 列表格式不可识别，未修改注册。'); }
  if (entries.some(entry => entry.name === SERVER_NAME)) {
    throw new Error('已有 dsh-portable 注册，已停止以避免覆盖。请检查现有注册；原 dsh 工具不会被修改。');
  }
  const codexHome = path.resolve(env.CODEX_HOME || path.join(homedir(), '.codex'));
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const backupDirectory = path.join(codexHome, 'backups', 'dsh-portable', `${timestamp}-${process.pid}`);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const configFile = path.join(codexHome, 'config.toml');
  let backupFile = null;
  if (await exists(configFile)) {
    backupFile = path.join(backupDirectory, 'config.toml');
    await copyFile(configFile, backupFile);
  }
  const record = {
    version: 1,
    serverName: SERVER_NAME,
    packageRoot: root,
    command: config.command,
    args: config.args,
    codexHome,
    backupFile,
    createdAt: now().toISOString(),
    status: 'prepared',
  };
  const recordDirectory = path.join(root, 'data', 'mcp-registration');
  await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
  const recordFile = path.join(recordDirectory, 'registration.json');
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const added = await command(['mcp', 'add', SERVER_NAME, '--', config.command, ...config.args]);
  record.status = added.code === 0 ? 'registered' : 'failed';
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (added.code !== 0) throw new Error('Codex MCP 注册失败；备份位置已记录在 data/mcp-registration/registration.json。');
  return { ...record, recordFile };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0) return bootstrapPortableMcp();
  if (args.length === 1 && ['--config', '--print-config'].includes(args[0])) {
    const config = portableMcpConfig();
    process.stdout.write(`${JSON.stringify({ mcpServers: { [SERVER_NAME]: config } }, null, 2)}\n`);
    return;
  }
  if (args[0] === '--register' && (args.length === 1 || (args.length === 3 && args[1] === '--codex'))) {
    const result = await registerPortableCodex(packageRoot, { executable: args[2] });
    process.stdout.write(`已注册独立 MCP：${SERVER_NAME}\n注册位置：${result.codexHome}\n备份：${result.backupFile || '此前没有 config.toml'}\n请重新打开 Codex 并新建任务以加载工具。便携包移动后需重新配置入口路径。\n`);
    return;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('便携 DSH 的可选 MCP 接入\n无参数：启动 stdio MCP，仅连接本包 DSH。\n--config：显示手动 MCP 配置，不修改 Codex。\n--register [--codex 绝对路径]：注册独立 dsh-portable，保留原 dsh。\n注册后重新打开 Codex 并新建任务；MCP 退出不会停止 DSH。\n');
    return;
  }
  throw new Error('参数不可识别；使用 --help 查看接入方式。');
}

if (process.argv[1] && samePath(process.argv[1], here)) {
  main().catch(error => {
    process.stderr.write(`[DSH Portable] ${error.message || 'MCP 启动失败。'}\n`);
    process.exitCode = 1;
  });
}
