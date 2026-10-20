/** Verifies the Win7 candidate on the current host; this does NOT replace a Win7 VM test. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { release } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
assert.ok(root.split(path.sep).includes('validation'), 'Only validation copies may be tested.');
const report = { passed: false, checkedAt: new Date().toISOString(), hostOnly: true, hostKernel: release(), win7VmVerified: false };
const localImport = local => import(pathToFileURL(path.join(root, local)).href);
const reportFile = path.resolve(process.argv[3]);
let stage = 'runtime';
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(name)));
environment.PATH = path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32');
environment.HOME = environment.USERPROFILE = path.join(root, 'data/host-test-user');
environment.APPDATA = path.join(environment.HOME, 'AppData/Roaming');
environment.LOCALAPPDATA = path.join(environment.HOME, 'AppData/Local');
function run(executable, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('owned test subprocess timed out')); }, timeout);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr }); });
  });
}
try {
  await mkdir(path.join(root, 'data/host-probes'), { recursive: true });
  const node = path.join(root, 'runtime/node/node.exe');
  const version = await run(node, ['--version']);
  assert.equal(version.code, 0); assert.equal(version.stdout.trim(), 'v20.19.2');
  report.node = version.stdout.trim();
  stage = 'sqlite';
  const { DatabaseSync } = await localImport('app/node_modules/@dsh-portable/compat/sqlite.mjs');
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE probe (value TEXT) STRICT; CREATE VIRTUAL TABLE documents USING fts5(text);');
  database.prepare('INSERT INTO probe VALUES (?)').run('中文');
  assert.equal(database.prepare('SELECT value FROM probe').get().value, '中文');
  database.prepare('INSERT INTO documents VALUES (?)').run('portable sqlite');
  assert.equal(database.prepare('SELECT count(*) AS n FROM documents WHERE text MATCH ?').get('portable').n, 1);
  database.close(); report.sqlite = true;
  stage = 'zstd';
  const zstd = await localImport('app/node_modules/@dsh-portable/compat/zlib-compat.mjs');
  const source = Buffer.from('中文 JSONL\n'.repeat(500));
  const compressed = await promisify(zstd.zstdCompress)(source, { params: { [zstd.constants.ZSTD_c_checksumFlag]: 1 } });
  assert.deepEqual(zstd.zstdDecompressSync(compressed), source); report.zstd = true;
  stage = 'ptc';
  const { stripTypeScriptTypes } = await localImport('app/node_modules/@dsh-portable/compat/module-compat.mjs');
  const stripped = stripTypeScriptTypes('async function __dsh_program__() {\nconst value: number = 7; return value + 2;\n}');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.equal(await new AsyncFunction(stripped.slice(35, -2))(), 9); report.typedProgram = true;
  stage = 'powershell';
  const shell = await run(path.join(root, 'runtime/powershell/pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Write-Output "WIN7_PWSH_中文_OK"']);
  assert.equal(shell.code, 0); assert.ok(shell.stdout.includes('WIN7_PWSH_中文_OK')); report.powershell = true;
  stage = 'ripgrep';
  const searchFile = path.join(root, 'data/host-probes/中文搜索.txt');
  await writeFile(searchFile, 'first\nWIN7_SEARCH_OK\n');
  const rg = await run(path.join(root, 'app/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'), ['--json', 'WIN7_SEARCH_OK', searchFile]);
  assert.equal(rg.code, 0); assert.ok(rg.stdout.includes('"line_number":2')); report.ripgrep = true;
  stage = 'local_mock_task';
  console.log('[Win7 host test] runtime, SQLite, Zstd, typed program, PowerShell and search passed; testing DSH');
  const mock = await run(node, [path.resolve(import.meta.dirname, '../scripts/verify-portable.mjs'), root], 240000);
  if (mock.code !== 0) {
    // Fixed stage-only output from the existing verifier contains no model credentials.
    report.mockDiagnostic = mock.stdout.slice(-2000) + mock.stderr.slice(-500);
    throw new Error('DSH local mock verification failed');
  }
  const smoke = JSON.parse(await readFile(path.join(root, 'logs/portable-smoke-report.json'), 'utf8'));
  assert.equal(smoke.passed, true); assert.equal(smoke.cleanupPassed, true);
  report.python = smoke.runtimes.python; report.git = smoke.runtimes.git;
  report.localMockTask = smoke.keylessTask; report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.diagnostic = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);
} finally {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
