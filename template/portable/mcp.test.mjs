import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bootstrapPortableMcp, initializePortableHost, portableMcpConfig, readPortableState, registerPortableCodex, resolveCodexCommand } from './mcp.mjs';
import { connectPortable } from '../bridge/portable-connect.mjs';

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-portable-mcp-test-')));
  const root = path.join(parent, '便携包 with spaces');
  await Promise.all(['portable', 'runtime/node', 'bridge', 'logs', 'data/runtime'].map(part => mkdir(path.join(root, part), { recursive: true })));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(path.join(root, 'logs', 'launch.log'), 'fixture log');
  await writeFile(path.join(root, 'runtime', 'node', 'node.exe'), 'fixture executable');
  await writeFile(path.join(root, 'portable', 'mcp.mjs'), 'fixture entry');
  const state = { version: 1, packageRoot: root, pid: process.pid, port: 39999, baseUrl: 'http://127.0.0.1:39999', launchLog: path.join(root, 'logs', 'launch.log') };
  await writeFile(path.join(root, 'data', 'runtime', 'state.json'), JSON.stringify(state));
  return { root, parent, state };
}

test('manual config uses bundled Node and contains no credential or global path', async t => {
  const { root } = await fixture(t);
  const config = portableMcpConfig(root);
  assert.equal(config.command, path.join(root, 'runtime', 'node', 'node.exe'));
  assert.deepEqual(config.args, [path.join(root, 'portable', 'mcp.mjs')]);
  assert.deepEqual(Object.keys(config), ['command', 'args']);
});

test('state from a moved package is rejected', async t => {
  const { root, state } = await fixture(t);
  state.packageRoot = `${root}-other`;
  await writeFile(path.join(root, 'data', 'runtime', 'state.json'), JSON.stringify(state));
  await assert.rejects(readPortableState(root), /另一位置/);
});

test('logs outside the package and remote hosts are rejected', async t => {
  const { root, state, parent } = await fixture(t);
  state.launchLog = path.join(parent, 'private.log');
  await writeFile(path.join(root, 'data', 'runtime', 'state.json'), JSON.stringify(state));
  await assert.rejects(readPortableState(root), /包内启动日志/);
  state.launchLog = path.join(root, 'logs', 'launch.log');
  state.baseUrl = 'http://192.0.2.1:3080';
  await writeFile(path.join(root, 'data', 'runtime', 'state.json'), JSON.stringify(state));
  await assert.rejects(readPortableState(root), /回环/);
});

test('bootstrap exposes server before pairing and drops launcher output', async t => {
  const { root, state } = await fixture(t);
  const env = {};
  const calls = [];
  const messages = [];
  const connection = {
    async connection() { if (!calls.includes('pair')) throw new Error('not paired'); return { baseUrl: state.baseUrl, cookie: 'fixture' }; },
    async pairFromLog(log) { assert.equal(log, state.launchLog); calls.push('pair'); return {}; },
  };
  await bootstrapPortableMcp(root, {
    env,
    runner: async (command, args, options) => {
      assert.equal(command, portableMcpConfig(root).command);
      assert.deepEqual(args, [path.join(root, 'portable', 'launcher.mjs'), 'start', '--no-open']);
      assert.equal(options.cwd, root);
      return { code: 0, stdout: 'fixture-launch-token', stderr: 'fixture-private-output' };
    },
    importer: async url => {
      if (url.endsWith('/connection.mjs')) return connection;
      assert.ok(!calls.includes('pair'));
      assert.equal(env.DSH_CODEX_STATE_DIR, path.join(root, 'data', 'bridge'));
      return { async startPortableServer({ ready }) { calls.push('server'); await ready; calls.push('ready'); } };
    },
    log: message => messages.push(message),
  });
  assert.equal(env.DSH_CODEX_STATE_DIR, path.join(root, 'data', 'bridge'));
  assert.equal(env.DSH_PORTABLE_LAUNCH_LOG, state.launchLog);
  assert.equal(env.DSH_PORTABLE_BASE_URL, state.baseUrl);
  assert.deepEqual(calls, ['server', 'pair', 'ready']);
  assert.ok(!messages.join('\n').includes('fixture-launch-token'));
  assert.ok(!messages.join('\n').includes('fixture-private-output'));
});

test('portable dsh_connect defaults to the current package log and accepts its exact origin', async t => {
  const { state } = await fixture(t);
  const env = { DSH_PORTABLE_LAUNCH_LOG: state.launchLog, DSH_PORTABLE_BASE_URL: state.baseUrl };
  const calls = [];
  const pair = async log => { calls.push(log); return { connected: true, baseUrl: state.baseUrl }; };
  assert.deepEqual(await connectPortable({}, { env, pair }), { connected: true, baseUrl: state.baseUrl });
  await connectPortable({ baseUrl: `${state.baseUrl}/`, launchLog: state.launchLog }, { env, pair });
  assert.deepEqual(calls, [state.launchLog, state.launchLog]);
});

test('portable dsh_connect rejects another desktop instance or log without invoking pair', async t => {
  const { state, parent } = await fixture(t);
  const otherLog = path.join(parent, 'other-instance.log');
  await writeFile(otherLog, 'fixture other instance');
  const env = { DSH_PORTABLE_LAUNCH_LOG: state.launchLog, DSH_PORTABLE_BASE_URL: state.baseUrl };
  let paired = false;
  const pair = async () => { paired = true; };
  await assert.rejects(connectPortable({ baseUrl: 'http://127.0.0.1:19387' }, { env, pair }), /其他 DSH/);
  await assert.rejects(connectPortable({ launchLog: otherLog }, { env, pair }), /其他实例日志/);
  await assert.rejects(connectPortable({ baseUrl: `${state.baseUrl}/?token=fixture` }, { env, pair }), /其他 DSH/);
  await assert.rejects(connectPortable({}, { env: {}, pair }), /缺少便携包/);
  assert.equal(paired, false);
});

test('host initialization never imports bridge when launcher fails', async t => {
  const { root } = await fixture(t);
  let imported = false;
  await assert.rejects(initializePortableHost(root, {
    env: {}, runner: async () => ({ code: 1, stderr: 'secret' }),
    importer: async () => { imported = true; }, log() {},
  }), /启动失败/);
  assert.equal(imported, false);
});

test('background startup failure is handled while MCP remains discoverable', async t => {
  const { root } = await fixture(t);
  const messages = [];
  let ready;
  await bootstrapPortableMcp(root, {
    env: {}, runner: async () => ({ code: 1, stderr: 'fixture-secret' }),
    importer: async () => ({ startPortableServer(options) { ready = options.ready; return { connected: true }; } }),
    log: message => messages.push(message),
  });
  await assert.rejects(ready, /启动失败/);
  assert.ok(messages.some(message => message.includes('初始化失败')));
  assert.ok(!messages.join('\n').includes('fixture-secret'));
});

test('explicit registration keeps dsh, backs up config, and adds a separate name', async t => {
  const { root, parent } = await fixture(t);
  const codexHome = path.join(parent, 'codex-home');
  await mkdir(codexHome);
  const original = '[mcp_servers.dsh]\ncommand = "existing-user-bridge"\n';
  await writeFile(path.join(codexHome, 'config.toml'), original);
  const calls = [];
  const result = await registerPortableCodex(root, {
    env: { CODEX_HOME: codexHome },
    resolver: async () => ({ command: 'fake-codex.exe', prefix: [] }),
    runner: async (command, args) => {
      calls.push(args);
      return { code: 0, stdout: args[1] === 'list' ? JSON.stringify([{ name: 'dsh' }]) : '' };
    },
    now: () => new Date('2026-10-13T00:00:00Z'),
  });
  assert.deepEqual(calls[0], ['mcp', 'list', '--json']);
  assert.deepEqual(calls[1], ['mcp', 'add', 'dsh-portable', '--', portableMcpConfig(root).command, ...portableMcpConfig(root).args]);
  assert.equal(await readFile(result.backupFile, 'utf8'), original);
  assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), original);
  assert.ok(result.backupFile.startsWith(path.join(codexHome, 'backups')));
  const record = JSON.parse(await readFile(result.recordFile, 'utf8'));
  assert.equal(record.status, 'registered');
  assert.equal(record.packageRoot, root);
  assert.ok(!JSON.stringify(record).includes('existing-user-bridge'));
});

test('registration refuses an existing portable MCP without creating a backup', async t => {
  const { root, parent } = await fixture(t);
  const codexHome = path.join(parent, 'isolated-codex');
  const calls = [];
  await assert.rejects(registerPortableCodex(root, {
    env: { CODEX_HOME: codexHome },
    resolver: async () => ({ command: 'fake-codex.exe', prefix: [] }),
    runner: async (_, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify([{ name: 'dsh-portable' }]) }; },
  }), /已有 dsh-portable/);
  assert.equal(calls.length, 1);
  await assert.rejects(readFile(path.join(root, 'data', 'mcp-registration', 'registration.json')), { code: 'ENOENT' });
});

test('unrecognized Codex output fails closed before mutation', async t => {
  const { root, parent } = await fixture(t);
  let calls = 0;
  await assert.rejects(registerPortableCodex(root, {
    env: { CODEX_HOME: path.join(parent, 'isolated-codex') },
    resolver: async () => ({ command: 'fake-codex.exe', prefix: [] }),
    runner: async () => { calls++; return { code: 0, stdout: 'this is not JSON' }; },
  }), /格式不可识别/);
  assert.equal(calls, 1);
});

test('standard npm shim is resolved to JS using bundled Node without shell or npm', async t => {
  const { root, parent } = await fixture(t);
  const cliDirectory = path.join(parent, 'npm-bin');
  const entry = path.join(cliDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, '// fixture');
  await writeFile(path.join(cliDirectory, 'codex.cmd'), '@echo off');
  const cli = await resolveCodexCommand(root, { executable: path.join(cliDirectory, 'codex.cmd') });
  assert.deepEqual(cli, { command: portableMcpConfig(root).command, prefix: [entry] });
});

test('initialize and tools/list respond during slow DSH startup; tools wait and stdout stays MCP', { timeout: 25000 }, async t => {
  const { root, state } = await fixture(t);
  const requests = [];
  const host = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/?token=fixture-token') {
      response.writeHead(303, { location: '/', 'set-cookie': 'fixture-auth=fake-session; HttpOnly' });
    } else response.writeHead(request.headers.cookie === 'fixture-auth=fake-session' ? 200 : 401);
    response.end();
  });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  t.after(() => new Promise(resolve => host.close(resolve)));
  state.port = host.address().port;
  state.baseUrl = `http://127.0.0.1:${state.port}`;
  await writeFile(state.launchLog, `${state.baseUrl}/?token=fixture-token\n`);
  await writeFile(path.join(root, 'data', 'runtime', 'state.json'), JSON.stringify(state));
  await rm(portableMcpConfig(root).command);
  try { await link(process.execPath, portableMcpConfig(root).command); }
  catch { await copyFile(process.execPath, portableMcpConfig(root).command); }
  await copyFile(fileURLToPath(new URL('./mcp.mjs', import.meta.url)), path.join(root, 'portable', 'mcp.mjs'));
  await copyFile(fileURLToPath(new URL('../../bridge-source/connection.mjs', import.meta.url)), path.join(root, 'bridge', 'connection.mjs'));
  for (const name of ['core.mjs', 'server.mjs', 'portable-connect.mjs']) {
    await copyFile(fileURLToPath(new URL(`../bridge/${name}`, import.meta.url)), path.join(root, 'bridge', name));
  }
  const bridgeDependencies = process.env.DSH_BRIDGE_DEPENDENCIES
    ? path.resolve(process.env.DSH_BRIDGE_DEPENDENCIES)
    : fileURLToPath(new URL('../../bridge-source/node_modules', import.meta.url));
  await symlink(bridgeDependencies, path.join(root, 'bridge', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, 'portable', 'launcher.mjs'), `
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    process.stdout.write('fixture-token launcher stdout\\n');
    process.stderr.write('fixture-token launcher stderr\\n');
    while (!existsSync(join(process.cwd(), 'data', 'runtime', 'release-startup'))) await new Promise(resolve => setTimeout(resolve, 20));
  `);
  const child = spawn(process.execPath, [path.join(root, 'portable', 'mcp.mjs')], { windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_CODEX_STATE_DIR: 'must-be-overridden' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const protocolLines = createInterface({ input: child.stdout });
  const responses = new Map(), pending = new Map(), malformed = [];
  protocolLines.on('line', line => {
    try {
      const reply = JSON.parse(line);
      responses.set(reply.id, reply);
      if (pending.has(reply.id)) pending.get(reply.id)(reply);
    } catch { malformed.push(line); }
  });
  function request(id, method, params) {
    const promise = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }
  const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'portable-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'dsh');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const catalog = await request(2, 'tools/list', {});
  assert.ok(catalog.result.tools.some(tool => tool.name === 'dsh_connect'));
  assert.ok(catalog.result.tools.some(tool => tool.name === 'dsh_start'));
  assert.deepEqual(requests, []);
  const connecting = request(3, 'tools/call', { name: 'dsh_connect', arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(responses.has(3), false);
  assert.deepEqual(requests, []);
  await writeFile(path.join(root, 'data', 'runtime', 'release-startup'), 'ready');
  const connected = await connecting;
  assert.equal(JSON.parse(connected.result.content[0].text).connected, true);
  child.stdin.end();
  const [code] = await closed;
  const text = Buffer.concat(stdout).toString('utf8');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(malformed.length, 0);
  assert.equal(text.trim().split('\n').length, 3);
  assert.ok(!Buffer.concat(stderr).toString('utf8').includes('fixture-token'));
  assert.deepEqual(requests, ['/?token=fixture-token', '/?token=fixture-token']);
  const paired = JSON.parse(await readFile(path.join(root, 'data', 'bridge', 'connection.json'), 'utf8'));
  assert.equal(paired.baseUrl, state.baseUrl);
});
