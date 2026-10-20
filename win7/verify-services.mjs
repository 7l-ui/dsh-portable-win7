/** Keyless service and configuration-reload check, restricted to validation copies. */
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
assert.ok(root.split(path.sep).includes('validation'), 'Only validation copies may be tested.');
const reportFile = path.resolve(process.argv[3]);
const report = { passed: false, checkedAt: new Date().toISOString(), hostOnly: true, win7VmVerified: false };
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(name)));
environment.PATH = path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32');
environment.HOME = environment.USERPROFILE = path.join(root, 'data/service-test-user');
environment.APPDATA = path.join(environment.HOME, 'AppData/Roaming');
environment.LOCALAPPDATA = path.join(environment.HOME, 'AppData/Local');
environment.DSH_CODEX_STATE_DIR = path.join(root, 'data/service-test-bridge');
process.env = environment;

const localImport = local => import(pathToFileURL(path.join(root, local)).href);
const launcher = await localImport('portable/launcher.mjs');
// --patch is a startup input; the user's persistent Cordis patch is watched live.
const patchFile = path.join(root, 'data/dsh-home/cordis.patch.yml');
const originalPatch = await readFile(patchFile, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const yaml = createRequire(path.join(root, 'app/package.json'))('yaml');
const originalEntries = yaml.parse(originalPatch ?? '[]') ?? [];
assert.ok(Array.isArray(originalEntries));
async function restorePatch() {
  if (originalPatch === null) await unlink(patchFile);
  else await writeFile(patchFile, originalPatch);
}
const keys = JSON.parse(await readFile(path.join(root, 'portable/keys.json'), 'utf8'));
assert.ok(keys.version === 2 && keys.slots.every(slot => slot.key === ''), 'Service test requires empty credential slots.');
let instance;
let rpc;
let changed = false;
let stage = 'startup';
const pause = () => new Promise(resolve => setTimeout(resolve, 200));
async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  throw new Error(description);
}
try {
  assert.notEqual((await launcher.statusPackage(root)).status, 'running', 'Validation service is already running.');
  instance = await launcher.startPackage(root, { noOpen: true });
  assert.ok(Number.isSafeInteger(instance.serverPid) && instance.serverPid > 0);
  const connection = await localImport('bridge/connection.mjs');
  await connection.pairFromLog(instance.launchLog);
  rpc = connection.rpc;
  const health = await (await localImport('bridge/core.mjs')).health();
  assert.equal(health.connected, true);
  assert.ok(health.activePluginCount > 10);
  report.bridgeHealth = true;
  const plugins = await rpc('pluginManager/listPlugins');
  const active = name => plugins.some(plugin => plugin.moduleName === name && plugin.fiberPhase === 'active');
  assert.ok(active('@deepseek-ai/dsh-plugin-manager'));
  assert.ok(active('@deepseek-ai/dsh-hmr'));
  report.pluginManager = true;
  report.hmrActive = true;
  stage = 'configuration_reload';
  const probeId = 'portable-win7-hmr-probe';
  const probeExists = plugin => plugin.patchId === probeId || plugin.entryId === probeId;
  assert.ok(!plugins.some(probeExists));
  await writeFile(patchFile, yaml.stringify([...originalEntries, { insert: [{ id: probeId,
    name: '@deepseek-ai/cordis-plugin-group', config: [] }] }]));
  changed = true;
  await until(async () => (await rpc('pluginManager/listPlugins')).some(plugin => probeExists(plugin) && plugin.fiberPhase === 'active'), 'Inserted test plugin did not activate through HMR.');
  await restorePatch();
  changed = false;
  await until(async () => !(await rpc('pluginManager/listPlugins')).some(probeExists), 'Removed test plugin remained after HMR.');
  const current = await launcher.statusPackage(root);
  assert.equal(current.instanceId, instance.instanceId);
  assert.equal(current.serverPid, instance.serverPid);
  report.configReloadInsertedAndRemoved = true;
  report.serverRestarted = false;
  report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.diagnostic = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);
} finally {
  let cleanupPassed = true;
  try { if (changed) await restorePatch(); } catch { cleanupPassed = false; }
  try {
    if (instance) {
      assert.equal((await launcher.statusPackage(root)).instanceId, instance.instanceId);
      await launcher.stopPackage(root);
    }
  } catch { cleanupPassed = false; }
  report.cleanupPassed = cleanupPassed;
  report.passed &&= cleanupPassed;
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
