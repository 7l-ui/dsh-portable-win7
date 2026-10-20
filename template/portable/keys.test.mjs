import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { configureKey, configureProvider, keyLaunchEnvironment, loadKeyConfig, resolveSelectedKey, selectKey } from './keys.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const TEST_KEY_A = 'inert-test-placeholder-A';
const TEST_KEY_B = 'inert-test-placeholder-B';
const TEST_KEY_C = 'inert-test-placeholder-C';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-keys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'portable'));
  await copyFile(join(source, 'keys.example.json'), join(root, 'portable', 'keys.example.json'));
  await copyFile(join(source, 'keys.mjs'), join(root, 'portable', 'keys.mjs'));
  return root;
}

function configPath(root) {
  return join(root, 'portable', 'keys.json');
}

function assertSafeSummary(value) {
  assert.deepEqual(Object.keys(value).sort(), ['active', 'slots', 'version']);
  for (const slot of value.slots) {
    assert.deepEqual(Object.keys(slot).sort(), ['configured', 'id', 'label', 'provider']);
    assert.equal(typeof slot.configured, 'boolean');
    assert.ok(['deepseek-official', 'opencode-go'].includes(slot.provider));
  }
  assert.ok(!JSON.stringify(value).includes(TEST_KEY_A));
  assert.ok(!JSON.stringify(value).includes(TEST_KEY_B));
  assert.ok(!JSON.stringify(value).includes(TEST_KEY_C));
}

function runCli(root, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'portable', 'keys.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('首次创建三个空槽位，配置独立持久化在包内', async t => {
  const root = await fixture(t);
  const config = await loadKeyConfig(root);
  assert.equal(config.version, 2);
  assert.equal(config.active, 'primary');
  assert.deepEqual(config.slots.map(({ id, label }) => ({ id, label })), [
    { id: 'primary', label: '主用' }, { id: 'backup1', label: '备用一' }, { id: 'backup2', label: '备用二' },
  ]);
  assert.ok(config.slots.every(slot => slot.key === ''));
  assert.deepEqual(config.slots.map(slot => slot.provider), ['deepseek-official', 'opencode-go', 'deepseek-official']);
  assert.equal(resolveSelectedKey(config), null);
  assert.deepEqual(keyLaunchEnvironment(config), {});
  config.slots[0].key = TEST_KEY_A;
  assert.equal((await loadKeyConfig(root)).slots[0].key, '');
  assert.deepEqual((await readdir(join(root, 'portable'))).sort(), ['keys.example.json', 'keys.json', 'keys.mjs']);
  if (process.platform !== 'win32') assert.equal((await stat(configPath(root))).mode & 0o777, 0o600);
});

test('不同服务同时启用，手动默认选择不会把 Go 密钥发给 DeepSeek', async t => {
  const root = await fixture(t);
  const configured = await configureKey(root, 'primary', TEST_KEY_A);
  assertSafeSummary(configured);
  assert.equal(configured.slots[0].configured, true);
  await configureKey(root, '备用一', TEST_KEY_B);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_A, OPENCODE_GO_API_KEY: TEST_KEY_B });
  const selected = await selectKey(root, 'backup1');
  assertSafeSummary(selected);
  const config = await loadKeyConfig(root);
  assert.deepEqual(resolveSelectedKey(config), { id: 'backup1', label: '备用一', provider: 'opencode-go', key: TEST_KEY_B });
  assert.deepEqual(keyLaunchEnvironment(config), { DEEPSEEK_API_KEY: TEST_KEY_A, OPENCODE_GO_API_KEY: TEST_KEY_B });
  const copy = resolveSelectedKey(config);
  copy.key = 'changed';
  assert.equal(config.slots[1].key, TEST_KEY_B);
});

test('空槽位不选择其他服务，同服务密钥按当前优先并可清除', async t => {
  const root = await fixture(t);
  await configureKey(root, 'backup1', TEST_KEY_B);
  assert.equal(resolveSelectedKey(await loadKeyConfig(root)), null);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { OPENCODE_GO_API_KEY: TEST_KEY_B });
  await configureKey(root, 'backup2', TEST_KEY_C);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_C, OPENCODE_GO_API_KEY: TEST_KEY_B });
  await configureKey(root, 'primary', TEST_KEY_A);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_A, OPENCODE_GO_API_KEY: TEST_KEY_B });
  await selectKey(root, 'backup2');
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_C, OPENCODE_GO_API_KEY: TEST_KEY_B });
  await selectKey(root, 'backup1');
  const cleared = await configureKey(root, 'backup1', '  \r\n');
  assertSafeSummary(cleared);
  assert.equal(cleared.slots[1].configured, false);
  assert.equal(resolveSelectedKey(await loadKeyConfig(root)), null);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_A });
});

test('更换服务会清除旧密钥，同服务重设保留密钥', async t => {
  const root = await fixture(t);
  await configureKey(root, 'primary', TEST_KEY_A);
  const unchanged = await configureProvider(root, 'primary', 'deepseek-official');
  assertSafeSummary(unchanged);
  assert.equal(unchanged.slots[0].configured, true);
  const changed = await configureProvider(root, '主用', 'opencode-go');
  assertSafeSummary(changed);
  assert.equal(changed.slots[0].configured, false);
  assert.equal(changed.slots[0].provider, 'opencode-go');
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), {});
  await configureKey(root, 'primary', TEST_KEY_B);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { OPENCODE_GO_API_KEY: TEST_KEY_B });
});

test('v1 有密钥配置迁移为 v2，所有旧槽位仍属于 DeepSeek', async t => {
  const root = await fixture(t);
  const old = { version: 1, active: 'backup1', slots: [
    { id: 'primary', label: '主用', key: TEST_KEY_A },
    { id: 'backup1', label: '备用一', key: TEST_KEY_B },
    { id: 'backup2', label: '备用二', key: '' },
  ] };
  await writeFile(configPath(root), JSON.stringify(old));
  const migrated = await loadKeyConfig(root);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.active, 'backup1');
  assert.ok(migrated.slots.every(slot => slot.provider === 'deepseek-official'));
  assert.equal(migrated.slots[0].key, TEST_KEY_A);
  assert.equal(migrated.slots[1].key, TEST_KEY_B);
  assert.deepEqual(keyLaunchEnvironment(migrated), { DEEPSEEK_API_KEY: TEST_KEY_B });
  assert.equal(JSON.parse(await readFile(configPath(root), 'utf8')).version, 2);
  assert.deepEqual(await loadKeyConfig(root), migrated);
  const relinked = await configureProvider(root, 'backup1', 'opencode-go');
  assertSafeSummary(relinked);
  assert.equal(relinked.slots[1].configured, false);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_A });
});

test('无效配置和输入报错不会包含密钥，也不会覆盖有效配置', async t => {
  const root = await fixture(t);
  await configureKey(root, 'primary', TEST_KEY_A);
  const before = await readFile(configPath(root), 'utf8');
  await assert.rejects(configureKey(root, TEST_KEY_B, TEST_KEY_A), error => error.code === 'INVALID_KEY_SLOT' && !error.message.includes(TEST_KEY_B));
  await assert.rejects(configureKey(root, 'primary', `${TEST_KEY_B} wrong`), error => error.code === 'INVALID_KEY_VALUE' && !error.message.includes(TEST_KEY_B));
  await assert.rejects(configureProvider(root, 'primary', TEST_KEY_B), error => error.code === 'INVALID_KEY_PROVIDER' && !error.message.includes(TEST_KEY_B));
  assert.equal(await readFile(configPath(root), 'utf8'), before);
  const valid = JSON.parse(before);
  for (const change of [
    value => { value.version = 3; },
    value => { value.active = TEST_KEY_B; },
    value => { value.slots[1].id = 'primary'; },
    value => { value.slots[1].label = TEST_KEY_B; },
    value => { value.slots.push({ id: 'extra', label: TEST_KEY_B, key: TEST_KEY_B }); },
    value => { value.slots[0].key = { secret: TEST_KEY_B }; },
    value => { value.slots[1].provider = TEST_KEY_B; },
    value => { delete value.slots[1].provider; },
    value => { value.slots[1].provider = { secret: TEST_KEY_B }; },
  ]) {
    const invalid = structuredClone(valid);
    change(invalid);
    await writeFile(configPath(root), JSON.stringify(invalid));
    await assert.rejects(loadKeyConfig(root), error => error.code === 'INVALID_KEY_CONFIG' && !error.message.includes(TEST_KEY_A) && !error.message.includes(TEST_KEY_B));
  }
  await writeFile(configPath(root), `{ "secret": "${TEST_KEY_B}`);
  await assert.rejects(loadKeyConfig(root), error => error.code === 'INVALID_KEY_CONFIG' && !error.message.includes(TEST_KEY_B));
});

test('出厂模板拒绝非空密钥', async t => {
  const root = await fixture(t);
  const example = JSON.parse(await readFile(join(root, 'portable', 'keys.example.json'), 'utf8'));
  example.slots[0].key = TEST_KEY_A;
  await writeFile(join(root, 'portable', 'keys.example.json'), JSON.stringify(example));
  await assert.rejects(loadKeyConfig(root), error => error.code === 'INVALID_KEY_CONFIG' && !error.message.includes(TEST_KEY_A));
  await assert.rejects(stat(configPath(root)), { code: 'ENOENT' });
});

test('CLI 只通过标准输入设置密钥，状态和错误仅包含安全概要', async t => {
  const root = await fixture(t);
  const forbidden = await runCli(root, ['set', 'primary', TEST_KEY_A]);
  assert.equal(forbidden.code, 1);
  assert.ok(!`${forbidden.stdout}${forbidden.stderr}`.includes(TEST_KEY_A));
  await assert.rejects(stat(configPath(root)), { code: 'ENOENT' });
  const saved = await runCli(root, ['set', 'primary'], `${TEST_KEY_A}\r\n`);
  assert.equal(saved.code, 0, saved.stderr);
  assertSafeSummary(JSON.parse(saved.stdout));
  const selected = await runCli(root, ['select', '备用二']);
  assert.equal(selected.code, 0, selected.stderr);
  assertSafeSummary(JSON.parse(selected.stdout));
  const provider = await runCli(root, ['provider', 'backup1', 'deepseek-official']);
  assert.equal(provider.code, 0, provider.stderr);
  assertSafeSummary(JSON.parse(provider.stdout));
  assert.equal(JSON.parse(provider.stdout).slots[1].provider, 'deepseek-official');
  const status = await runCli(root, ['status']);
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assertSafeSummary(parsed);
  assert.equal(parsed.active, 'backup2');
  assert.equal(parsed.slots[0].configured, true);
  assert.deepEqual(keyLaunchEnvironment(await loadKeyConfig(root)), { DEEPSEEK_API_KEY: TEST_KEY_A });
});
