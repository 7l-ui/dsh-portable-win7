/**
 * 用法：node scripts/verify-portable.mjs <全新验证副本的绝对路径> [--with-pwsh]
 * 仅使用包内可执行文件和 127.0.0.1 Messages mock；不需要真实 API key。
 * 会临时修改验证副本的空密钥配置与 profile patch，结束后恢复。
 * 不打印启动日志、认证 URL、Cookie、控制令牌或密钥。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MOCK_KEY = 'portable-test-key';
const RESULT = 'DSH_PORTABLE_SMOKE_OK';
const ARTIFACT = 'smoke-agent.txt';
const PWSH_RESULT = 'DSH_PORTABLE_PWSH_TOOL_OK';
const PWSH_MAJOR = 'DSH_PORTABLE_PWSH_VERSION_MAJOR=7';
const rootArgument = process.argv[2];
const withPwsh = process.argv[3] === '--with-pwsh';
let stage = '参数检查';

function progress(text) {
  stage = text;
  process.stdout.write(`[便携验证] ${text}\n`);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function samePath(first, second) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return typeof first === 'string' && typeof second === 'string' && normalize(first) === normalize(second);
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function optionalText(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('验证文件读取失败。'); }
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value, fields) {
  return plainRecord(value) && Object.keys(value).every(key => fields.includes(key));
}

/** A prior test launch may persist local browser authentication; reject model/account secrets. */
async function inspectTestCredentials(root, home) {
  const filename = path.join(home, '.credentials.yaml');
  if (!(await exists(filename))) return { present: false, localBrowserAuthPresent: false, deviceIdentityPresent: false };
  assert.ok(inside(root, await realpath(filename)), '验证凭据文件必须位于当前副本内。');
  const require = createRequire(path.join(root, 'app', 'package.json'));
  const yamlEntry = require.resolve('yaml');
  assert.ok(inside(root, await realpath(yamlEntry)));
  const document = require(yamlEntry).parseDocument(await readFile(filename, 'utf8'));
  assert.equal(document.errors.length, 0, '测试凭据结构无效。');
  const value = document.toJS();
  assert.ok(hasOnlyFields(value, ['version', 'refs', 'records']) && value.version === 1);
  const refs = value.refs ?? {};
  const records = value.records ?? {};
  assert.ok(plainRecord(refs) && Object.entries(refs).every(([name, secret]) => name === 'DEEPSEEK_API_KEY' && secret === MOCK_KEY));
  assert.ok(plainRecord(records));
  for (const [name, record] of Object.entries(records)) {
    assert.ok(hasOnlyFields(record, ['kind', 'payload']) && record.kind === 'grant');
    if (name === 'deepseek-account-platform/device') {
      assert.ok(hasOnlyFields(record.payload, ['id']) && typeof record.payload.id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.payload.id));
    } else if (name === 'client-connection/browser-session') {
      assert.ok(hasOnlyFields(record.payload, ['version', 'secret']) && record.payload.version === 1
        && typeof record.payload.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.payload.secret));
      const decoded = Buffer.from(record.payload.secret, 'base64url');
      assert.ok(decoded.length === 32 && decoded.toString('base64url') === record.payload.secret);
    } else {
      throw new Error('验证副本不得包含模型或账号授权记录。');
    }
  }
  // Discard all values and return only safe presence facts.
  return { present: true, localBrowserAuthPresent: Object.hasOwn(records, 'client-connection/browser-session'),
    deviceIdentityPresent: Object.hasOwn(records, 'deepseek-account-platform/device') };
}

function isolatedEnvironment(root, layout) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(name)) environment[name] = value;
  }
  const windowsRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR || 'C:\\Windows';
  const bins = [path.dirname(layout.node), path.dirname(layout.python), path.dirname(layout.git)];
  environment.PATH = [...bins, ...(process.platform === 'win32' ? [path.join(windowsRoot, 'System32')] : [])].join(path.delimiter);
  const user = path.join(root, 'data', 'verify-user');
  environment.HOME = user;
  environment.USERPROFILE = user;
  environment.APPDATA = path.join(user, 'AppData', 'Roaming');
  environment.LOCALAPPDATA = path.join(user, 'AppData', 'Local');
  environment.DSH_CODEX_STATE_DIR = path.join(root, 'data', 'verify-bridge');
  environment.DSH_TELEMETRY_DISABLED = '1';
  return environment;
}

function run(command, args, { cwd, env, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let bytes = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('验证辅助进程超时。')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { child.kill(); finish(new Error('验证辅助进程输出过多。')); }
      else stdout += chunk;
    });
    // Discard stderr instead of forwarding diagnostics that may contain tokens.
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('无法启动包内验证进程。')));
    child.once('close', code => finish(null, { code, stdout }));
  });
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Keep only a bounded, redacted failure diagnostic; never retain successful shell output. */
function safeShellToolError(text) {
  const redacted = text.split(MOCK_KEY).join('[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|access_token|auth_token|api[_-]?key|key|secret|auth|credential|code)=)[^&#\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/(\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization|cookie|credential)\b["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[REDACTED]');
  const bytes = Buffer.from(redacted, 'utf8');
  const bounded = bytes.subarray(0, 1024).toString('utf8').replace(/\uFFFD$/u, '');
  const code = bounded.match(/\b(?:ERR_[A-Z0-9_]{1,72}|EACCES|EPERM|ENOENT|ENOSYS|EUNKNOWN)\b/);
  return { category: code?.[0] ?? 'tool_result_error', text: bounded, truncated: bytes.length > 1024 };
}

/** Minimal wire fixture following DSH's official llm-mock-server event sequence. */
async function startMock(expectedPython, withPwsh = false) {
  const facts = { requests: 0, writeAdvertised: false, writeRequested: false, toolResultReceived: false, toolResultError: false,
    runtimeAdvertised: false, runtimeRequested: false, runtimeToolResultReceived: false, runtimeToolResultError: false, runtimePythonPathVerified: false,
    shellAdvertised: false, shellRequested: false, shellToolResultReceived: false, shellToolResultError: false,
    shellPowerShell7Verified: false, shellMarkerVerified: false, authenticated: true };
  const diagnostics = { shellToolError: null };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !new URL(request.url, 'http://127.0.0.1').pathname.endsWith('/v1/messages')) {
      response.writeHead(404); response.end(); return;
    }
    if (request.headers['x-api-key'] !== MOCK_KEY) {
      facts.authenticated = false;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'mock authentication failed' } }));
      return;
    }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('request too large');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400); response.end(); return;
    }
    facts.requests++;
    const results = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result');
    const writeResults = results.filter(block => block.tool_use_id === 'portable-smoke-write');
    if (writeResults.length) {
      facts.toolResultReceived = true;
      facts.toolResultError = writeResults.some(result => result.is_error === true);
    }
    const runtimeResults = results.filter(block => block.tool_use_id === 'portable-smoke-runtime');
    if (runtimeResults.length) {
      facts.runtimeToolResultReceived = true;
      facts.runtimeToolResultError = runtimeResults.some(result => result.is_error === true);
      for (const result of runtimeResults) {
        const text = typeof result.content === 'string' ? result.content
          : (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
        try {
          facts.runtimePythonPathVerified ||= samePath(JSON.parse(text).python, expectedPython);
        } catch {
          // Only retain a Boolean; never print or persist the raw tool result.
        }
      }
    }
    if (withPwsh) {
      const shellResults = results.filter(block => block.tool_use_id === 'portable-smoke-pwsh');
      if (shellResults.length) {
        facts.shellToolResultReceived = true;
        facts.shellToolResultError ||= shellResults.some(result => result.is_error === true);
        for (const result of shellResults) {
          const text = typeof result.content === 'string' ? result.content
            : (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (result.is_error === true && diagnostics.shellToolError === null) diagnostics.shellToolError = safeShellToolError(text);
          // Exact stdout also rejects failed/promoted command annotations; retain only Booleans.
          const verified = result.is_error !== true && text.replace(/\r\n/g, '\n').trim() === `${PWSH_MAJOR}\n${PWSH_RESULT}`;
          facts.shellPowerShell7Verified ||= verified;
          facts.shellMarkerVerified ||= verified;
        }
      }
    }
    const useTool = !facts.writeRequested && !facts.toolResultReceived;
    facts.writeAdvertised ||= (body.tools || []).some(tool => tool.name === 'write');
    facts.runtimeAdvertised ||= (body.tools || []).some(tool => tool.name === 'load_workspace_dependencies');
    if (withPwsh) facts.shellAdvertised ||= (body.tools || []).some(tool => tool.name === 'pwsh');
    const allToolsSucceeded = facts.toolResultReceived && !facts.toolResultError
      && facts.runtimeToolResultReceived && !facts.runtimeToolResultError && facts.runtimePythonPathVerified
      && (!withPwsh || (facts.shellAdvertised && facts.shellRequested && facts.shellToolResultReceived
        && !facts.shellToolResultError && facts.shellPowerShell7Verified && facts.shellMarkerVerified));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(response, { type: 'message_start', message: { id: `portable-smoke-${facts.requests}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } });
    if (useTool) {
      facts.writeRequested = true;
      facts.runtimeRequested = true;
      const calls = [
        { id: 'portable-smoke-runtime', name: 'load_workspace_dependencies', args: {} },
        { id: 'portable-smoke-write', name: 'write', args: { file_path: ARTIFACT, content: `${RESULT}\n` } },
      ];
      if (withPwsh) {
        facts.shellRequested = true;
        calls.push({ id: 'portable-smoke-pwsh', name: 'pwsh', args: {
          command: `$ErrorActionPreference = 'Stop'; $dshPortablePsMajor = $PSVersionTable.PSVersion.Major; if ($dshPortablePsMajor -ne 7) { throw 'Portable verification requires PowerShell 7.' }; Write-Output ('DSH_PORTABLE_PWSH_VERSION_MAJOR=' + $dshPortablePsMajor); Write-Output '${PWSH_RESULT}'`,
          description: 'Verify bundled PowerShell executes through DSH tools', timeoutMs: 30000,
        } });
      }
      for (const [index, call] of calls.entries()) {
        sse(response, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        sse(response, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } });
        sse(response, { type: 'content_block_stop', index });
      }
    } else {
      sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: allToolsSucceeded ? RESULT : 'PORTABLE_SMOKE_TOOL_FAILED' } });
      sse(response, { type: 'content_block_stop', index: 0 });
    }
    sse(response, { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    sse(response, { type: 'message_stop' });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    facts,
    diagnostics,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function safeState(root, layout) {
  const state = JSON.parse(await readFile(path.join(root, 'data', 'runtime', 'state.json'), 'utf8'));
  assert.ok(samePath(state.packageRoot, root));
  assert.equal(state.status, 'running');
  assert.ok(typeof state.instanceId === 'string' && /^[a-f0-9]{48}$/.test(state.instanceId));
  const base = new URL(state.baseUrl);
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.protocol, 'http:');
  assert.equal(base.search, '');
  assert.ok(inside(await realpath(layout.logs), await realpath(state.launchLog)));
  return { instanceId: state.instanceId, baseUrl: base.origin, launchLog: state.launchLog };
}

async function verify(root) {
  const launcher = await import(pathToFileURL(path.join(root, 'portable', 'launcher.mjs')).href);
  const layout = launcher.packageLayout(root);
  const keyFile = path.join(root, 'portable', 'keys.json');
  const originalPatch = await readFile(layout.patch, 'utf8');
  const originalKeys = await optionalText(keyFile);
  const report = { version: 1, packageRoot: root, startedAt: new Date().toISOString(), passed: false, runtimes: {}, keylessTask: null };
  let mock;
  let instance;
  let prepared = false;
  const env = isolatedEnvironment(root, layout);
  try {
    progress('确认验证副本未运行且没有个人凭据');
    const prior = await launcher.statusPackage(root);
    assert.ok(['stopped', 'failed'].includes(prior.status));
    report.testCredentialMetadata = await inspectTestCredentials(root, layout.home);
    for (const filename of [path.join(layout.home, '.env'), path.join(layout.workspace, '.env')]) {
      assert.ok(!(await exists(filename)), '验证副本不得包含个人凭据文件。');
    }
    assert.ok(!(await exists(path.join(layout.workspace, ARTIFACT))), '验证产物已存在，请使用全新副本。');
    const keys = await import(pathToFileURL(path.join(root, 'portable', 'keys.mjs')).href);
    const config = await keys.loadKeyConfig(root);
    assert.ok(config.slots.every(slot => slot.key === ''), '仅验证三个空槽位的新副本。');
    prepared = true;
    await mkdir(env.HOME, { recursive: true });
    for (const [name, executable] of [['node', layout.node], ['python', layout.python], ['git', layout.git]]) {
      assert.ok(inside(root, await realpath(executable)), '可执行文件必须位于验证包内。');
      progress(`验证包内 ${name}`);
      let result;
      if (name === 'node') {
        result = await run(executable, ['--eval', 'process.stdout.write(JSON.stringify({executable:process.execPath,version:process.version}))'], { cwd: root, env });
        assert.equal(result.code, 0);
        const actual = JSON.parse(result.stdout);
        assert.ok(samePath(await realpath(actual.executable), await realpath(executable)));
        report.runtimes.node = { bundled: true, version: actual.version };
      } else if (name === 'python') {
        result = await run(executable, ['-I', '-c', 'import sys,json,pandas,openpyxl,docx,pptx;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"officeImports":True}))'], { cwd: root, env });
        assert.equal(result.code, 0);
        const actual = JSON.parse(result.stdout);
        assert.ok(samePath(await realpath(actual.executable), await realpath(executable)));
        report.runtimes.python = { bundled: true, version: actual.version, officeImports: actual.officeImports };
      } else {
        result = await run(executable, ['--version'], { cwd: root, env });
        assert.equal(result.code, 0);
        assert.match(result.stdout.trim(), /^git version [\d.]+/);
        const execPath = await run(executable, ['--exec-path'], { cwd: root, env });
        assert.equal(execPath.code, 0);
        assert.ok(inside(root, await realpath(execPath.stdout.trim())));
        report.runtimes.git = { bundled: true, version: result.stdout.trim() };
      }
    }
    progress('准备仅本机回环的无密钥模型测试');
    mock = await startMock(layout.python, withPwsh);
    await keys.configureKey(root, 'primary', MOCK_KEY);
    await keys.selectKey(root, 'primary');
    await writeFile(layout.patch, `${originalPatch.trimEnd()}\n\n# Verification copy only; restored after smoke.\n- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(mock.baseURL)}\n    apiKeyEnv: DEEPSEEK_API_KEY\n    thinking: disabled\n    maxTokens: 4096\n    retryPolicy:\n      mode: normal\n      maxRetries: 0\n- id: session-title-llm\n  disabled: true\n`);
    progress('从包内 Node 启动当前验证副本');
    const launched = await run(layout.node, [layout.launcher, 'start', '--no-open'], { cwd: root, env });
    // Never forward launcher output; state and launch logs can hold credentials.
    assert.equal(launched.code, 0, '便携服务启动失败。');
    instance = await safeState(root, layout);
    progress('通过当前副本启动日志配对并提交写文件任务');
    process.env.DSH_CODEX_STATE_DIR = env.DSH_CODEX_STATE_DIR;
    const connection = await import(pathToFileURL(path.join(root, 'bridge', 'connection.mjs')).href);
    await connection.pairFromLog(instance.launchLog);
    assert.equal((await connection.connection()).baseUrl, instance.baseUrl);
    const bridge = await import(pathToFileURL(path.join(root, 'bridge', 'core.mjs')).href);
    let task = await bridge.start({ workspace: layout.workspace, permission: 'workspace-write', title: '便携包无密钥验证',
      idempotencyKey: `portable-smoke-${instance.instanceId}`, task: `先查询包内运行环境，再创建 ${ARTIFACT}，内容为 ${RESULT}，${withPwsh ? '再通过 pwsh 工具核验 PowerShell 7 并输出固定测试标记，' : ''}然后回复 ${RESULT}。` });
    const deadline = Date.now() + 120000;
    while (!task.terminal && Date.now() < deadline) {
      task = await bridge.wait(task.runId, 10000);
      if (task.status === 'needs_attention') throw new Error('验证任务需要人工介入。');
      if (!task.terminal) progress('等待验证任务完成');
    }
    progress(`核验${withPwsh ? '三个' : '两个'}真实工具、当前包内 Python 路径和任务终态`);
    assert.equal(task.terminal, true);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.assistantText.trim(), RESULT);
    assert.equal(await readFile(path.join(layout.workspace, ARTIFACT), 'utf8'), `${RESULT}\n`);
    assert.ok(mock.facts.requests >= 2);
    assert.ok(mock.facts.authenticated && mock.facts.writeAdvertised && mock.facts.writeRequested && mock.facts.toolResultReceived && !mock.facts.toolResultError);
    assert.ok(mock.facts.runtimeAdvertised && mock.facts.runtimeRequested && mock.facts.runtimeToolResultReceived
      && !mock.facts.runtimeToolResultError && mock.facts.runtimePythonPathVerified);
    if (withPwsh) assert.ok(mock.facts.shellAdvertised && mock.facts.shellRequested && mock.facts.shellToolResultReceived
      && !mock.facts.shellToolResultError && mock.facts.shellPowerShell7Verified && mock.facts.shellMarkerVerified);
    report.keylessTask = { localMock: true, providerHost: '127.0.0.1', requests: mock.facts.requests, tool: 'write', runtimeToolExecuted: true,
      runtimePythonPathVerified: true, shellTool: withPwsh, shellPowerShell7Verified: mock.facts.shellPowerShell7Verified,
      shellMarkerVerified: mock.facts.shellMarkerVerified,
      terminal: true, status: 'succeeded', artifact: path.join('workspace', ARTIFACT), finalTextVerified: true };
    report.passed = true;
  } catch (error) {
    report.failureStage = stage;
    throw error;
  } finally {
    progress('停止本脚本启动的副本并恢复测试配置');
    let cleanupFailed = false;
    try {
      if (instance !== undefined) {
        const current = await launcher.statusPackage(root);
        assert.equal(current.instanceId, instance.instanceId, '验证实例身份发生变化，拒绝停止。');
        await launcher.stopPackage(root);
      }
    } catch {
      cleanupFailed = true;
    }
    try { await mock?.close(); } catch { cleanupFailed = true; }
    try {
      if (prepared) {
        await writeFile(layout.patch, originalPatch);
        if (originalKeys === null) await unlink(keyFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else await writeFile(keyFile, originalKeys, { mode: 0o600 });
      }
    } catch {
      cleanupFailed = true;
    }
    report.cleanupPassed = !cleanupFailed;
    if (cleanupFailed) { report.passed = false; report.failureStage ||= stage; }
    if (mock) report.mockFacts = { ...mock.facts };
    if (withPwsh && mock?.diagnostics.shellToolError) report.shellToolError = mock.diagnostics.shellToolError;
    report.finishedAt = new Date().toISOString();
    await mkdir(layout.logs, { recursive: true });
    await writeFile(path.join(layout.logs, 'portable-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (report.failureStage) stage = report.failureStage;
    if (cleanupFailed) throw new Error('验证清理失败，请检查本包状态。');
  }
  assert.equal(report.passed, true);
  progress(`通过：包内 Node、Python、Git 与 DSH 写文件${withPwsh ? '、pwsh 工具' : ''}及终态均已验证`);
}

try {
  assert.ok(rootArgument && path.isAbsolute(rootArgument) && (process.argv.length === 3 || (process.argv.length === 4 && withPwsh)),
    '请传入验证副本绝对路径，可追加 --with-pwsh。');
  await verify(await realpath(rootArgument));
} catch {
  // Only the stage is shown: caught diagnostics may contain HTTP cookies or secrets.
  process.stderr.write(`便携验证失败，阶段：${stage}。请查看验证副本 logs 下的安全报告。\n`);
  process.exitCode = 1;
}
