import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateDistribution, writeManifest } from './manifest.mjs';

const FAKE_DS = 'fixture-private-deepseek-NOT-A-REAL-KEY';
const FAKE_GO = 'fixture-private-opencode-NOT-A-REAL-KEY';
const workspaceTemplate = fileURLToPath(new URL('../template/workspace/AGENTS.md', import.meta.url));
const manifestScript = fileURLToPath(new URL('./manifest.mjs', import.meta.url));
const packageScript = fileURLToPath(new URL('../package.ps1', import.meta.url));

function config(version = 2, includeValues = false) {
  return {
    version, active: 'primary',
    slots: [
      { id: 'primary', label: '主用', ...(version === 2 ? { provider: 'deepseek-official' } : {}), key: includeValues ? FAKE_DS : '' },
      { id: 'backup1', label: '备用一', ...(version === 2 ? { provider: 'opencode-go' } : {}), key: includeValues ? FAKE_GO : '' },
      { id: 'backup2', label: '备用二', ...(version === 2 ? { provider: 'deepseek-official' } : {}), key: '' },
    ],
  };
}

async function put(root, filename, value) {
  const target = path.join(root, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}

async function fixture(t, { version = 2, includeValues = false, runnable = false } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-manifest-test-'));
  const root = path.join(parent, '便携发行包 fixture');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await Promise.all(['portable', 'workspace', 'logs', 'data/runtime', 'data/bridge', 'data/agents-home', 'data/dsh-home'].map(name => mkdir(path.join(root, name), { recursive: true })));
  await copyFile(workspaceTemplate, path.join(root, 'workspace', 'AGENTS.md'));
  await put(root, 'portable/keys.example.json', config(version));
  await put(root, 'portable/keys.json', config(version, includeValues));
  await put(root, 'app/node_modules/@deepseek-ai/dsh/package.json', { version: '0.2.0-rc.2' });
  await put(root, 'runtime/primary-runtime/runtime.json', { node: 'fixture-node', python: 'fixture-python', pnpm: 'fixture-pnpm', pythonPackages: ['fixture-library'] });
  await put(root, 'runtime/node/node.exe', 'fixture-node-binary');
  await put(root, 'runtime/primary-runtime/dependencies/python/python.exe', 'fixture-python-binary');
  await put(root, 'runtime/git/cmd/git.exe', 'fixture-git-binary');
  if (runnable) {
    await rm(path.join(root, 'runtime/node/node.exe'));
    try { await link(process.execPath, path.join(root, 'runtime/node/node.exe')); }
    catch { await copyFile(process.execPath, path.join(root, 'runtime/node/node.exe')); }
  }
  return { root, parent };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({ code, output: Buffer.concat(output).toString('utf8') }));
  });
}

test('v1 empty no-key distributions retain compatible version metadata', async t => {
  const { root } = await fixture(t, { version: 1 });
  const manifest = await writeManifest(root);
  assert.equal(manifest.packageVersion, '0.1.0');
  assert.equal(manifest.edition, 'windows-x64-no-key');
  assert.equal(manifest.credentialValuesIncluded, false);
  assert.equal(manifest.configuredCredentialSlots, 0);
});

test('v2 empty distributions use new no-key version and provider count metadata', async t => {
  const { root } = await fixture(t);
  const result = await validateDistribution(root);
  assert.equal(result.packageVersion, '0.2.0');
  assert.equal(result.credentialValuesIncluded, false);
  assert.deepEqual(result.credentialProviders, [
    { provider: 'deepseek-official', configuredSlots: 0 },
    { provider: 'opencode-go', configuredSlots: 0 },
  ]);
});

test('provider configuration and loader are allowed first-party distribution files', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await put(root, 'portable/providers.json', { providers: ['deepseek-official', 'opencode-go'] });
  await put(root, 'portable/providers.mjs', '// fixture provider loader without credentials');
  const result = await validateDistribution(root, { includeKeys: true });
  assert.equal(result.credentialValuesIncluded, true);
  assert.equal(result.configuredCredentialSlots, 2);
});

test('private mode explicitly permits only v2 credentials and emits counts without values or key hashes', async t => {
  const { root } = await fixture(t, { includeValues: true });
  const manifest = await writeManifest(root, { includeKeys: true });
  assert.equal(manifest.packageVersion, '0.2.0');
  assert.equal(manifest.edition, 'windows-x64-private');
  assert.equal(manifest.credentialValuesIncluded, true);
  assert.equal(manifest.configuredCredentialSlots, 2);
  assert.deepEqual(manifest.credentialProviders, [
    { provider: 'deepseek-official', configuredSlots: 1 },
    { provider: 'opencode-go', configuredSlots: 1 },
  ]);
  const text = await readFile(path.join(root, 'manifest.json'), 'utf8');
  assert.ok(!text.includes(FAKE_DS) && !text.includes(FAKE_GO));
  assert.ok(!/keyLength|credentialHash|keyHash|keyPrefix|keySuffix|"values"/.test(text));
  assert.deepEqual(Object.keys(manifest.entryHashes).sort(), ['git', 'node', 'python']);
  assert.ok(!JSON.stringify(await validateDistribution(root, { includeKeys: true })).includes(FAKE_DS));
});

test('nonempty credentials remain forbidden without explicit include flag', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await assert.rejects(validateDistribution(root), error => !error.message.includes(FAKE_DS) && /密钥槽位/.test(error.message));
});

test('private mode rejects no credentials, missing keys, and legacy v1 keys', async t => {
  for (const variant of ['empty', 'missing', 'legacy']) {
    const { root } = await fixture(t, { version: variant === 'legacy' ? 1 : 2, includeValues: variant === 'legacy' });
    if (variant === 'missing') await rm(path.join(root, 'portable', 'keys.json'));
    await assert.rejects(validateDistribution(root, { includeKeys: true }));
  }
});

test('example template must stay empty even when include-keys is explicit', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await put(root, 'portable/keys.example.json', config(2, true));
  await assert.rejects(validateDistribution(root, { includeKeys: true }), /密钥槽位/);
});

test('unknown providers, extra endpoint fields and duplicate slots are rejected safely', async t => {
  for (const transform of [
    value => { value.slots[0].provider = 'untrusted-endpoint'; },
    value => { value.slots[0].baseUrl = 'https://example.invalid'; },
    value => { value.slots[1] = value.slots[0]; },
    value => { value.slots[0].key = 123; },
    value => { value.extra = FAKE_DS; },
  ]) {
    const { root } = await fixture(t, { includeValues: true });
    const value = config(2, true);
    transform(value);
    await put(root, 'portable/keys.json', value);
    await assert.rejects(validateDistribution(root, { includeKeys: true }), error => /密钥槽位/.test(error.message) && !error.message.includes(FAKE_DS));
  }
});

test('runtime history, logs, tests, user outputs and extra root files are refused in both modes', async t => {
  for (const includeKeys of [false, true]) {
    for (const filename of [
      'logs/boot.log', 'data/runtime/state.json', 'data/mcp-registration/registration.json', 'data/unknown/deep/history.txt',
      'workspace/output.docx', 'portable/keys.test.mjs', 'history-export.json', 'bridge/debug.json',
      'bridge/history/test.md', 'app/node_modules/extra/private-api.log', 'runtime/extra/session.sqlite',
    ]) {
      const { root } = await fixture(t, { includeValues: includeKeys });
      await put(root, filename, 'fixture-only history');
      await assert.rejects(validateDistribution(root, { includeKeys }), undefined, filename);
    }
  }
});

test('workspace AGENTS must match the template and cannot carry appended history', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await put(root, 'workspace/AGENTS.md', 'fixture user history');
  await assert.rejects(validateDistribution(root, { includeKeys: true }), /偏离模板/);
});

test('private credentials duplicated in an otherwise allowed package document are rejected', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await put(root, '先看这里.md', `fixture accidentally copied credential: ${FAKE_GO}`);
  await assert.rejects(validateDistribution(root, { includeKeys: true }), error => /之外/.test(error.message) && !error.message.includes(FAKE_GO));
});

test('distribution symlinks and junctions are rejected before their targets are read', async t => {
  const { root, parent } = await fixture(t);
  await mkdir(path.join(parent, 'outside'));
  await symlink(path.join(parent, 'outside'), path.join(root, 'app', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateDistribution(root), /链接/);
});

test('CLI errors sanitize malformed private JSON and never echo credentials', async t => {
  const { root } = await fixture(t, { includeValues: true });
  await put(root, 'portable/keys.json', `{"version":2,"secret":"${FAKE_DS}"`);
  const result = await run(process.execPath, [manifestScript, root, '--include-keys']);
  assert.equal(result.code, 1);
  assert.ok(!result.output.includes(FAKE_DS));
  assert.ok(!result.output.includes('"secret"'));
});

test('CLI private success reports only provider counts and no fake credential', async t => {
  const { root } = await fixture(t, { includeValues: true });
  const result = await run(process.execPath, [manifestScript, root, '--include-keys']);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes(FAKE_DS) && !result.output.includes(FAKE_GO));
  const summary = JSON.parse(result.output);
  assert.equal(summary.credentialValuesIncluded, true);
  assert.equal(summary.configuredCredentialSlots, 2);
});

test('package entry point protects existing archives and checksum files', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, parent } = await fixture(t, { version: 1, runnable: true });
  const archive = path.join(parent, `${path.basename(root)}-0.1.0-no-key.zip`);
  await writeFile(archive, 'fixture existing archive must survive');
  const result = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', packageScript, '-PackageDirectory', root]);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(archive, 'utf8'), 'fixture existing archive must survive');
  await rm(archive);
  await writeFile(`${archive}.sha256`, 'fixture existing checksum must survive');
  const again = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', packageScript, '-PackageDirectory', root]);
  assert.notEqual(again.code, 0);
  assert.equal(await readFile(`${archive}.sha256`, 'utf8'), 'fixture existing checksum must survive');
});

test('IncludeKeys produces a separate private ZIP and preserves an older no-key archive', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { root, parent } = await fixture(t, { includeValues: true, runnable: true });
  const basename = path.basename(root);
  const oldArchive = path.join(parent, `${basename}-0.1.0-no-key.zip`);
  await writeFile(oldArchive, 'fixture original no-key archive');
  const result = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', packageScript, '-PackageDirectory', root, '-IncludeKeys']);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes(FAKE_DS) && !result.output.includes(FAKE_GO));
  assert.equal(await readFile(oldArchive, 'utf8'), 'fixture original no-key archive');
  const privateArchive = path.join(parent, `${basename}-0.2.0-private.zip`);
  const checksum = await readFile(`${privateArchive}.sha256`, 'utf8');
  assert.match(checksum, /^[a-f0-9]{64}  /);
  const archivedManifest = await run('C:\\Program Files\\7-Zip\\7z.exe', ['e', '-so', privateArchive, `${basename}/manifest.json`]);
  assert.equal(archivedManifest.code, 0);
  const manifest = JSON.parse(archivedManifest.output);
  assert.equal(manifest.edition, 'windows-x64-private');
  assert.equal(manifest.credentialValuesIncluded, true);
  assert.equal(manifest.configuredCredentialSlots, 2);
});
