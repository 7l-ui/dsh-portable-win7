import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchEnvironment, doctorPackage, packageLayout, parseReadyUrl, redactDiagnostic,
  sameInstance, startPackage, statusPackage, stopPackage,
} from './launcher.mjs';

const source = fileURLToPath(new URL('./launcher.mjs', import.meta.url));
const fixtureKey = 'fixture-selected-key';
const fixtureToken = 'fixture-private-launch-token';

async function fixture(mode = 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-portable-launcher-test-'));
  const layout = packageLayout(root);
  await Promise.all([path.dirname(layout.node), path.dirname(layout.dsh), path.dirname(layout.launcher)].map(directory => mkdir(directory, { recursive: true })));
  try { await link(process.execPath, layout.node); }
  catch { await copyFile(process.execPath, layout.node); }
  await copyFile(source, layout.launcher);
  await writeFile(layout.config, JSON.stringify({ startupTimeoutMs: 4500, shutdownTimeoutMs: 700 }));
  await writeFile(layout.patch, 'entries: []\n');
  await writeFile(layout.keys, `
    export async function loadKeyConfig() { return {}; }
    export function keyLaunchEnvironment() { return { DEEPSEEK_API_KEY: '${fixtureKey}' }; }
  `);
  await writeFile(layout.dsh, mode === 'fail' ? 'process.exit(19);' : `
    const http = require('node:http');
    const fs = require('node:fs');
    fs.writeFileSync('fixture-environment.json', JSON.stringify({key:process.env.DEEPSEEK_API_KEY,home:process.env.DSH_HOME,cwd:process.cwd()}));
    const server = http.createServer((req,res) => {
      if (req.url === '/?token=${fixtureToken}') { res.writeHead(303, {'location':'./','set-cookie':'fixture=authenticated; HttpOnly'}); res.end(); }
      else if (req.headers.cookie === 'fixture=authenticated') {res.writeHead(200,{'content-type':'text/html'});res.end('<html>fixture</html>');}
      else {res.writeHead(401);res.end();}
    });
    server.listen(0,'127.0.0.1',() => console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=${fixtureToken}'));
  `);
  return layout;
}

async function clean(layout) {
  await stopPackage(layout.root).catch(() => {});
  // Wait for the supervisor to finish its log and state writes before removing this test's temporary directory.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(layout.root.startsWith(path.join(os.tmpdir(), 'dsh-portable-launcher-test-')));
  await rm(layout.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('子进程环境隔离外来密钥与 Node 注入，并只采用选中的预设', () => {
  const layout = packageLayout(path.join(os.tmpdir(), 'portable-environment-unit'));
  const source = { Path: 'original-path', DEEPSEEK_API_KEY: 'foreign-key', deepseek_base_url: 'https://foreign.invalid',
    OPENCODE_GO_API_KEY: 'foreign-go-key',
    NODE_OPTIONS: '--require malicious.js', NODE_PATH: '/foreign', ELECTRON_RUN_AS_NODE: '1', SOME_PROXY: 'proxy',
    DSH_AGENTS_HOME: '/foreign-agents', DSH_SOME_DEPLOYMENT_SETTING: 'foreign', PYTHONHOME: '/foreign-python',
    PYTHONPATH: '/foreign-libraries', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url', GIT_CONFIG_VALUE_0: 'foreign' };
  const env = buildLaunchEnvironment(layout, source, { DEEPSEEK_API_KEY: fixtureKey });
  assert.equal(env.DEEPSEEK_API_KEY, fixtureKey);
  assert.equal(env.DEEPSEEK_BASE_URL, undefined);
  assert.equal(env.deepseek_base_url, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.Path, undefined);
  assert.equal(env.DSH_HOME, layout.home);
  assert.equal(env.DSH_AGENTS_HOME, path.join(layout.root, 'data', 'agents-home'));
  assert.equal(env.DSH_SOME_DEPLOYMENT_SETTING, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(layout.root, 'portable', 'gitconfig'));
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.ok(env.PATH.startsWith(path.dirname(layout.node) + path.delimiter));
  assert.ok(env.PATH.endsWith('original-path'));
  assert.equal(source.DEEPSEEK_API_KEY, 'foreign-key');
  assert.equal(env.SOME_PROXY, 'proxy');
  assert.equal(buildLaunchEnvironment(layout, source).DEEPSEEK_API_KEY, undefined);
  assert.equal(buildLaunchEnvironment(layout, source).OPENCODE_GO_API_KEY, undefined);
  assert.equal(buildLaunchEnvironment(layout, source, { OPENCODE_GO_API_KEY: 'own-go-key' }).OPENCODE_GO_API_KEY, 'own-go-key');
});

test('私有诊断保留失败原因并删除已知密钥与认证 token', () => {
  const result = redactDiagnostic(`connect ECONNREFUSED; selected=${fixtureKey}; url=http://127.0.0.1:3012/?token=unknown-token; Authorization: Bearer another-secret`, [fixtureKey]);
  assert.match(result, /ECONNREFUSED/);
  assert.equal(result.includes(fixtureKey), false);
  assert.equal(result.includes('unknown-token'), false);
  assert.equal(result.includes('another-secret'), false);
});

test('就绪地址必须是带启动 token 的 IPv4 loopback 根地址', () => {
  assert.equal(parseReadyUrl(`prefix\ndsh web: http://127.0.0.1:33451/?token=${fixtureToken}\n`), `http://127.0.0.1:33451/?token=${fixtureToken}`);
  assert.equal(parseReadyUrl('dsh web: http://example.com:33451/?token=value'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:33451/'), null);
  assert.equal(parseReadyUrl('dsh web: http://user:pass@127.0.0.1:33451/?token=value'), null);
});

test('启动身份同时核对路径、PID、随机身份和启动时间', () => {
  const root = path.resolve('identity-root');
  const state = { packageRoot: root, pid: 42, instanceId: 'abc', startedAt: '2026-10-13T00:00:00Z' };
  assert.equal(sameInstance(state, { ...state }, root), true);
  for (const patch of [{ pid: 43 }, { instanceId: 'other' }, { startedAt: 'old' }, { packageRoot: path.resolve('other-root') }]) {
    assert.equal(sameInstance(state, { ...state, ...patch }, root), false);
  }
});

test('实际启动、并发重复启动、复制路径与伪造 PID 不会误停服务', { timeout: 25_000 }, async () => {
  const layout = await fixture();
  const moved = await fixture();
  let originalState;
  try {
    const [started, repeated] = await Promise.all([
      startPackage(layout.root, { noOpen: true }), startPackage(layout.root, { noOpen: true }),
    ]);
    assert.equal(started.status, 'running');
    assert.equal(started.pid, repeated.pid);
    assert.equal(started.instanceId, repeated.instanceId);
    const output = JSON.stringify(started);
    assert.equal(output.includes(fixtureToken), false);
    assert.equal(output.includes(fixtureKey), false);
    assert.ok(started.port > 0);
    assert.equal(new URL(started.baseUrl).search, '');
    const actualEnv = JSON.parse(await readFile(path.join(layout.workspace, 'fixture-environment.json'), 'utf8'));
    assert.equal(actualEnv.key, fixtureKey);
    assert.equal(actualEnv.home, layout.home);
    assert.equal(actualEnv.cwd, layout.workspace);

    originalState = JSON.parse(await readFile(layout.state, 'utf8'));
    await mkdir(moved.runtime, { recursive: true });
    await writeFile(moved.state, JSON.stringify(originalState));
    assert.equal((await statusPackage(moved.root)).reason, 'moved');
    assert.equal((await stopPackage(moved.root)).status, 'stopped');
    assert.equal((await statusPackage(layout.root)).status, 'running');
    const movedStart = await startPackage(moved.root, { noOpen: true });
    assert.notEqual(movedStart.instanceId, started.instanceId);
    assert.notEqual(movedStart.pid, started.pid);
    assert.equal((await stopPackage(moved.root)).status, 'stopped');
    assert.equal((await statusPackage(layout.root)).status, 'running');

    await writeFile(layout.state, JSON.stringify({ ...originalState, pid: process.pid }));
    assert.equal((await statusPackage(layout.root)).status, 'unverified');
    await assert.rejects(stopPackage(layout.root), /拒绝/);
    await writeFile(layout.state, JSON.stringify(originalState));
    assert.equal((await statusPackage(layout.root)).status, 'running');
    assert.equal((await doctorPackage(layout.root)).files.node.present, true);
    assert.equal((await stopPackage(layout.root)).status, 'stopped');
    assert.equal((await statusPackage(layout.root)).status, 'stopped');
    await writeFile(layout.state, JSON.stringify({ ...originalState, status: 'failed',
      baseUrl: `http://127.0.0.1:${started.port}/?token=${fixtureToken}`, error: fixtureKey }));
    const sanitized = JSON.stringify(await statusPackage(layout.root));
    assert.equal(sanitized.includes(fixtureToken), false);
    assert.equal(sanitized.includes(fixtureKey), false);
  } finally {
    if (originalState) await writeFile(layout.state, JSON.stringify(originalState));
    await clean(layout);
    await clean(moved);
  }
});

test('DSH 子进程提前失败能够及时返回，留下本包私有诊断记录', { timeout: 15_000 }, async () => {
  const layout = await fixture('fail');
  try {
    await assert.rejects(startPackage(layout.root, { noOpen: true }), /启动失败/);
    const result = await statusPackage(layout.root);
    assert.equal(result.status, 'failed');
    assert.ok(result.launchLog.startsWith(layout.logs + path.sep));
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
    const log = await readFile(result.launchLog, 'utf8');
    assert.match(log, /startup failure/);
  } finally { await clean(layout); }
});
