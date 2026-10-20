/** Fixed DSH 0.2.0-rc.2 Win7 single-Job adaptation. Call only on a new Win7 stage. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prefix = 'app/node_modules/@deepseek-ai/';
const roleKey = 'DSH_WIN7_ACL_SHARED_JOB';
const roleValue = 'outer-kill-on-close-v1';

function replaceOne(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Win7 Job patch source shape changed.');
  return source.replace(before, after);
}

function patchWin32(source) {
  source = replaceOne(source, 'import { createLazyRequire }', 'import { release } from "node:os";\nimport { createLazyRequire }');
  source = replaceOne(source, '    assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),',
    '    getCurrentProcess: bind(kernel32, "GetCurrentProcess", PVOID, []),\n' +
    '    isProcessInJob: bind(kernel32, "IsProcessInJob", "int", [PVOID, PVOID, koffi.pointer("uint32")]),\n' +
    '    assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),');
  source = replaceOne(source, 'function createKillOnCloseJob(api) {', `// Win7 shares the verified outer Job; never enable either breakaway flag.
function belongsToJob(api, processHandle) {
  const result = allocUint32();
  try {
    if (api.isProcessInJob(processHandle, null, result) === 0) throwLastError(api, "IsProcessInJob");
    return decodeUint32(result) !== 0;
  } finally {
    freeNative(result);
  }
}
function assertWin7SharedJob(api) {
  if (process.platform !== "win32" || !/^6\\.1(?:\\.|$)/u.test(release())) throw new Error("Win7 shared Job requested on another platform");
  if (!belongsToJob(api, api.getCurrentProcess())) throw new Error("Win7 ACL runner has no containing Job");
  const information = Buffer.alloc(144);
  if (api.queryInformationJobObject(null, 9, information, information.length, null) === 0) throwLastError(api, "QueryInformationJobObject", "Win7 shared Job limits");
  const flags = information.readUInt32LE(16);
  if ((flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) === 0 || (flags & 6144) !== 0) throw new Error("Win7 ACL shared Job must kill on close and forbid breakaways");
}
function createKillOnCloseJob(api) {`);
  source = replaceOne(source, 'function spawnJobProcess(api, options, resolveStdio, createName, create) {\n  const job = createKillOnCloseJob(api);',
    'function spawnJobProcess(api, options, resolveStdio, createName, create) {\n' +
    '  const sharedJob = options.win7SharedJob === true;\n' +
    '  if (sharedJob) assertWin7SharedJob(api);\n' +
    '  const job = sharedJob ? null : createKillOnCloseJob(api);');
  const begin = source.indexOf('function spawnJobProcess(');
  const end = source.indexOf('\nfunction spawnInheritedJobProcess(', begin);
  assert.ok(begin >= 0 && end > begin);
  let spawnBody = source.slice(begin, end);
  spawnBody = spawnBody.replaceAll('api.closeHandle(job);', 'closeBestEffort(api, job);');
  const pidDetail = '`pid ${info.dwProcessId}`';
  spawnBody = replaceOne(spawnBody, `  if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
    const win32Code = api.getLastError();
    api.terminateProcess(info.hProcess, 1);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    closeBestEffort(api, job);
    throwWin32(api, "AssignProcessToJobObject", win32Code, ${pidDetail});
  }`, `  try {
    if (sharedJob) {
      if (!belongsToJob(api, info.hProcess)) throw new Error("Win7 restricted child did not inherit the outer Job");
    } else if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
      throwWin32(api, "AssignProcessToJobObject", api.getLastError(), ${pidDetail});
    }
  } catch (error) {
    api.terminateProcess(info.hProcess, 1);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    closeBestEffort(api, job);
    throw error;
  }`);
  // A shared child stays in the outer Job even if ResumeThread fails; terminate it explicitly.
  spawnBody = replaceOne(spawnBody, '  if (api.resumeThread(info.hThread) === 4294967295) {\n    const win32Code = api.getLastError();',
    '  if (api.resumeThread(info.hThread) === 4294967295) {\n    const win32Code = api.getLastError();\n    api.terminateProcess(info.hProcess, 1);');
  return source.slice(0, begin) + spawnBody + source.slice(end);
}

function patchOuterRunner(source) {
  source = replaceOne(source, 'import { closeSync } from "node:fs";',
    'import { closeSync, realpathSync } from "node:fs";\nimport { release } from "node:os";\nimport { fileURLToPath } from "node:url";');
  source = replaceOne(source, 'const defaultInternals = {', `const WIN7_ACL_JOB_ROLE = ${JSON.stringify(roleKey)};
const WIN7_ACL_JOB_VALUE = ${JSON.stringify(roleValue)};
function win7AclEnvironment(applicationName, args, targetEnv) {
  const env = { ...targetEnv };
  // Strip caller-supplied/case-variant markers for every target, including unrelated programs.
  for (const key of Object.keys(env)) if (key.toUpperCase() === WIN7_ACL_JOB_ROLE) delete env[key];
  let sharedAclRoot = false;
  if (process.platform === "win32" && /^6\\.1(?:\\.|$)/u.test(release()) && args.length > 0) {
    try {
      const sameFile = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
      sharedAclRoot = sameFile(applicationName, process.execPath)
        && sameFile(args[0], fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner")));
    } catch {
      sharedAclRoot = false;
    }
  }
  if (sharedAclRoot) env[WIN7_ACL_JOB_ROLE] = WIN7_ACL_JOB_VALUE;
  return { env, sharedAclRoot };
}
const defaultInternals = {`);
  source = replaceOne(source, '  jobHandle;\n  pollTimer;', '  jobHandle;\n  sharedAclRoot = false;\n  pollTimer;');
  source = replaceOne(source, '      this.api = this.internals.loadWin32ProcessBindings();\n      const spawned =',
    '      const launch = win7AclEnvironment(applicationName, args, request.env);\n' +
    '      this.sharedAclRoot = launch.sharedAclRoot;\n' +
    '      this.api = this.internals.loadWin32ProcessBindings();\n      const spawned =');
  source = replaceOne(source, '        env: request.env,\n        stdio:', '        env: launch.env,\n        stdio:');
  source = replaceOne(source, '        if (exitCode !== void 0) {\n          this.internals.closeHandleChecked',
    '        if (exitCode !== void 0) {\n' +
    '          // This trusted ACL root shares one Job with its restricted descendants on Win7.\n' +
    '          if (this.sharedAclRoot) this.terminateOwnedJob();\n' +
    '          this.internals.closeHandleChecked');
  return source;
}

function patchAclRunner(source) {
  source = replaceOne(source, 'import { join } from "node:path";', 'import { join } from "node:path";\nimport { release } from "node:os";');
  source = replaceOne(source, 'async function main() {\n  const parsed =', `function consumeWin7SharedJobRole() {
  let matched = false;
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() !== ${JSON.stringify(roleKey)}) continue;
    matched ||= process.env[key] === ${JSON.stringify(roleValue)};
    // CreateProcessAsUserW inherits this environment: remove the role before spawning PowerShell.
    delete process.env[key];
  }
  return matched && process.platform === "win32" && /^6\\.1(?:\\.|$)/u.test(release());
}
async function main() {
  const win7SharedJob = consumeWin7SharedJobRole();
  const parsed =`);
  source = replaceOne(source, '      stdio: "inherit",\n', '      stdio: "inherit",\n      ...(win7SharedJob ? { win7SharedJob: true } : {}),\n');
  return source;
}

function patchAclTypes(source) {
  source = replaceOne(source, '        cwd,\n        ...options.controlFileDescriptor',
    '        cwd,\n        ...(options.win7SharedJob === true ? { win7SharedJob: true } : {}),\n        ...options.controlFileDescriptor');
  source = replaceOne(source, '          if (api.closeHandle(native2.job) === 0)', '          if (native2.job !== null && api.closeHandle(native2.job) === 0)');
  return source;
}

export const win7JobFiles = [
  { path: prefix + 'dsh-win32-process/lib/index.js', before: '253d514157fd14f361312b0630f76486e7e11146b7b0ddbe339d16ffbbe30fe1', after: '13a02d001450e2f870f3243e5bcb59509124da7fa7195d17c0e44680249f9ab1', transform: patchWin32 },
  { path: prefix + 'dsh-subprocess-local/lib/runner.js', before: '73d2d20a6d64cebda4ef8e79bdc702ef3529d5dd044adc85f998aec748e0c07f', after: '59b5c072741bf40e2a7f0fb266c8e67789c01a5946e48fa9d94f1ea513e9c09f', transform: patchOuterRunner },
  { path: prefix + 'dsh-sandbox-windows-acl/lib/runner.js', before: 'db4dfa3d3650cc7f40ffde7e313c15aaa69e6e452125a36e12bf81bf62a0871b', after: 'c29cb30334be64d39aa5de1a23ee71dfdfdbc59b081b7cb78213881438ae2277', transform: patchAclRunner },
  { path: prefix + 'dsh-sandbox-windows-acl/lib/types-Cl_DXjhk.js', before: 'a3c91e1df2c8d9c1d2db9e514baec04763848ada5d510bf37acde08198391747', after: '8cf78a18d6fc1a6e3928a7732326f68a4d207710b7d8494375bd15f056f368c3', transform: patchAclTypes },
];
const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function applyWin7Jobs(targetRoot) {
  const root = await realpath(targetRoot);
  const prepared = [];
  // Validate every input before writing any file. Reject unknown source or already-patched contents.
  for (const entry of win7JobFiles) {
    const filename = path.join(root, entry.path);
    const resolved = await realpath(filename);
    const relative = path.relative(root, resolved);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Win7 Job target escaped stage.');
    const before = await readFile(filename);
    const currentHash = sha256(before);
    if (entry.after && currentHash === entry.after) {
      prepared.push({ filename, path: entry.path, beforeSha256: entry.before, afterSha256: entry.after, bytes: before.length, alreadyApplied: true });
      continue;
    }
    assert.equal(currentHash, entry.before, `Unknown Win7 Job source: ${entry.path}`);
    const original = before.toString('utf8');
    const normalized = original.replace(/\r\n/g, '\n');
    const patched = entry.transform(normalized);
    const result = Buffer.from(original.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched, 'utf8');
    const afterSha256 = sha256(result);
    if (entry.after) assert.equal(afterSha256, entry.after, `Win7 Job transform changed: ${entry.path}`);
    prepared.push({ filename, path: entry.path, beforeSha256: entry.before, afterSha256, bytes: result.length, alreadyApplied: false, result });
  }
  for (const item of prepared) if (!item.alreadyApplied) await writeFile(item.filename, item.result);
  return prepared.map(({ filename, result, ...record }) => record);
}
