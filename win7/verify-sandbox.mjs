/** Keyless real-process sandbox checks, restricted to disposable validation copies. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? '');
assert.equal(process.platform, 'win32');
assert.ok(root.split(path.sep).some(part => part.toLowerCase() === 'validation'), 'Only validation copies may be tested.');
const reportFile = path.resolve(process.argv[3] ?? '');
assert.ok(process.argv[2] && process.argv[3], 'Validation root and output report are required.');
for (let cursor = root; ; cursor = path.dirname(cursor)) {
  assert.ok(!lstatSync(cursor).isSymbolicLink(), 'Validation ancestors must not be reparse points.');
  if (path.dirname(cursor) === cursor) break;
}
assert.equal(path.resolve(realpathSync.native(root)).toLowerCase(), root.toLowerCase());
const startedAt = new Date().toISOString();
const hostKernel = release();
const report = { version: 1, passed: false, startedAt, hostKernel,
  hostOnly: !/^6\.1\.7601(?:\.|$)/.test(hostKernel), win7VmVerified: false, checks: {} };
const workspace = path.join(root, 'workspace');
const prefix = `sandbox-probe-${randomUUID()}`;
const ownedFiles = new Set();
const file = suffix => { const target = path.join(workspace, `${prefix}-${suffix}`); ownedFiles.add(target); return target; };
const outside = path.join(root, 'data', `${prefix}-outside.txt`);
const node = path.join(root, 'runtime/node/node.exe');
const pwsh = path.join(root, 'runtime/powershell/pwsh.exe');
const preload = path.join(root, 'app/node_modules/@dsh-portable/compat/preload.cjs');
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(name)));
environment.PATH = [path.dirname(pwsh), path.dirname(node), path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
environment.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
process.env = environment;
const localImport = name => import(pathToFileURL(path.join(root, `app/node_modules/@deepseek-ai/${name}/lib/index.js`)).href);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
async function bounded(promise, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned sandbox check exceeded its bound.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, milliseconds = 12000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await pause(100); }
  throw new Error('Expected owned process evidence did not appear.');
}
let runtime;
let sandbox;
let stage = 'initialization';
const active = new Set();
try {
  assert.ok(!lstatSync(workspace).isSymbolicLink());
  assert.ok(!lstatSync(path.join(root, 'data')).isSymbolicLink());
  assert.equal(existsSync(outside), false);
  report.candidateManifestSha256 = createHash('sha256').update(await readFile(path.join(root, 'manifest.json'))).digest('hex');
  const [{ Context }, { LocalSubprocessRuntime }, { LocalSandboxProvider }] = await Promise.all([
    localImport('cordis'), localImport('dsh-subprocess-local'), localImport('dsh-sandbox-local')]);
  const context = new Context();
  runtime = new LocalSubprocessRuntime(context);
  assert.equal(runtime.selectContainmentMode('ordinary'), 'windows-job', 'This check requires actual Windows Job containment.');
  report.jobBackend = 'windows-job';
  sandbox = new LocalSandboxProvider(context, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });
  const policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: prefix };
  const start = async (command, signal) => {
    const confined = await sandbox.confine([pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], policy, signal);
    assert.equal(confined.enforcement, 'partial');
    const handle = runtime.spawn({ argv: confined.argv, cwd: workspace, graceMs: 500,
      signal, env: environment, stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } } });
    active.add(handle);
    return handle;
  };
  const finish = async handle => {
    const outcome = await bounded(handle.done);
    await bounded(handle.waitForExit());
    active.delete(handle);
    return { ...outcome, stdout: handle.collected.stdout.readFrom(0).text, stderr: handle.collected.stderr.readFrom(0).text };
  };
  stage = 'powerShell7Command';
  const success = await finish(await start('if ($PSVersionTable.PSVersion.Major -ne 7) { exit 71 }; Write-Output SANDBOX_PWSH7_OK'));
  assert.equal(success.exitCode, 0); assert.match(success.stdout, /SANDBOX_PWSH7_OK/);
  report.checks.powerShell7Command = true;
  stage = 'outsideWorkspaceWriteDenied';
  const denial = await finish(await start(`try { Set-Content -LiteralPath ${psQuote(outside)} -Value FORBIDDEN -ErrorAction Stop; exit 91 } catch { if ($_.FullyQualifiedErrorId -notmatch 'UnauthorizedAccess|PermissionDenied') { throw }; Write-Output SANDBOX_BOUNDARY_DENIED }`));
  assert.equal(denial.exitCode, 0); assert.match(denial.stdout, /SANDBOX_BOUNDARY_DENIED/); assert.equal(existsSync(outside), false);
  report.checks.outsideWorkspaceWriteDenied = true;
  const treeScript = file('tree.mjs');
  await writeFile(treeScript, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
const [mode,stem]=process.argv.slice(2); fs.writeFileSync(stem+'-'+mode+'.pid',String(process.pid));
if(mode==='child')spawn(process.execPath,[process.argv[1],'grandchild',stem],{stdio:'inherit',windowsHide:true});
setInterval(()=>{},1000);
`);
  async function treeCase(kind) {
    stage = kind;
    const stem = file(kind);
    const childPidFile = `${stem}-child.pid`, grandchildPidFile = `${stem}-grandchild.pid`;
    ownedFiles.add(childPidFile); ownedFiles.add(grandchildPidFile);
    const controller = new AbortController();
    // Start-Process joins ArgumentList; preserve spaces in validation paths.
    const args = `@(${psQuote(`"${treeScript}"`)},'child',${psQuote(`"${stem}"`)})`;
    const command = kind === 'rootExitJobQuiesced'
      ? `$a=${args}; [void](Start-Process -FilePath ${psQuote(node)} -ArgumentList $a -NoNewWindow -PassThru); $d=[DateTime]::UtcNow.AddSeconds(12); while (-not (Test-Path -LiteralPath ${psQuote(grandchildPidFile)})) { if ([DateTime]::UtcNow -gt $d) { exit 72 }; Start-Sleep -Milliseconds 100 }; exit 0`
      : `& ${psQuote(node)} ${psQuote(treeScript)} child ${psQuote(stem)}`;
    const handle = await start(command, controller.signal);
    await until(() => existsSync(childPidFile) && existsSync(grandchildPidFile));
    const pids = await Promise.all([childPidFile, grandchildPidFile].map(async target => {
      const pid = Number((await readFile(target, 'utf8')).trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0); return pid;
    }));
    if (kind === 'timeoutJobQuiesced') {
      await pause(500); controller.abort(new Error('SANDBOX_TEST_DEADLINE'));
    } else if (kind === 'cancelJobQuiesced') handle.terminate();
    const result = await finish(handle);
    if (kind === 'rootExitJobQuiesced') assert.equal(result.exitCode, 0);
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    await until(() => pids.every(pid => !alive(pid)), 5000);
    report.checks[kind] = true;
    return pids.length;
  }
  report.descendantsObserved = await treeCase('timeoutJobQuiesced');
  report.descendantsObserved += await treeCase('cancelJobQuiesced');
  report.descendantsObserved += await treeCase('rootExitJobQuiesced');
  report.checks.descendantProcessesReaped = report.descendantsObserved === 6;
  stage = 'failedSpawnClosed';
  const missing = path.join(workspace, `${prefix}-missing.exe`);
  const confined = await sandbox.confine([missing], policy);
  const failed = runtime.spawn({ argv: confined.argv, cwd: workspace, graceMs: 500, env: environment,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } });
  active.add(failed);
  const failure = await finish(failed);
  assert.notEqual(failure.exitCode, 0);
  assert.match(failure.stderr, /windows-acl-run:/i);
  assert.match(failure.stderr, /CreateProcessAsUserW failed \(Win32 (?:2|3)\)/);
  report.checks.failedSpawnClosed = true;
  report.passed = Object.values(report.checks).every(value => value === true) && Object.keys(report.checks).length === 7;
} catch (error) {
  report.failedStage = stage;
  report.diagnostic = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/([?&]token=)[^\s&#]+/gi, '$1[redacted]').slice(0, 900);
} finally {
  let cleanupPassed = true;
  for (const handle of active) { try { handle.terminate(); await bounded(handle.waitForExit(), 10000); } catch { cleanupPassed = false; } }
  try { if (runtime) await bounded(runtime.disposeManagedProcesses(), 10000); } catch { cleanupPassed = false; }
  try { sandbox?.revokeAclGrants(); } catch { cleanupPassed = false; }
  for (const target of ownedFiles) { try { await unlink(target); } catch (error) { if (error.code !== 'ENOENT') cleanupPassed = false; } }
  if (existsSync(outside)) { cleanupPassed = false; await unlink(outside).catch(() => {}); }
  report.cleanupPassed = cleanupPassed;
  report.passed &&= cleanupPassed;
  report.win7VmVerified = report.passed && !report.hostOnly;
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
