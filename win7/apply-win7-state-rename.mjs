/** Retry only Win7 state-file atomic replacement; never retry service startup or write the target in place. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const win7StateRenameSource = String.raw`async function renamePrivateJson(temporary, file) {
  if (process.platform !== 'win32' || !/^6\.1(?:\.|$)/u.test(release())) return rename(temporary, file);
  // A short-lived sharing lock must not turn a complete JSON snapshot into a failed launch.
  // Keep the same temporary file and atomic rename operation for every attempt.
  const backoff = [10, 20, 40, 80, 160, 240, 320, 400];
  const deadline = performance.now() + 1500;
  let retries = 0;
  for (;;) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || retries >= backoff.length) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await pause(Math.min(backoff[retries++], remaining));
      if (performance.now() >= deadline) throw error;
    }
  }
}`;

export const win7StateRenameFile = {
  path: 'portable/launcher.mjs',
  before: '80f945f7dc081a2ee766d66fb78a41e7056a39c0fab25de627d0f1fec06ab991',
  after: 'adf7ed4716396975aa104cd98bde6e81ca1276e6b4e8800afab1faf2e7039f86',
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
function replaceOne(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Win7 state rename source shape changed.');
  return source.replace(before, after);
}

export async function applyWin7StateRename(targetRoot) {
  const root = await realpath(targetRoot);
  const filename = path.join(root, win7StateRenameFile.path);
  const resolved = await realpath(filename);
  const relative = path.relative(root, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Win7 state target escaped stage.');
  const original = await readFile(filename);
  const current = sha256(original);
  if (win7StateRenameFile.after && current === win7StateRenameFile.after) return { path: win7StateRenameFile.path,
    beforeSha256: win7StateRenameFile.before, afterSha256: current, bytes: original.length, alreadyApplied: true };
  assert.equal(current, win7StateRenameFile.before, 'Unknown Win7 portable launcher source.');
  let source = original.toString('utf8').replace(/\r\n/g, '\n');
  source = replaceOne(source, "import path from 'node:path';", "import path from 'node:path';\nimport { release } from 'node:os';\nimport { performance } from 'node:perf_hooks';");
  source = replaceOne(source, '    await rename(temporary, file);', '    await renamePrivateJson(temporary, file);');
  source = replaceOne(source, 'async function privateJson(file, data) {', `${win7StateRenameSource}\n\nasync function privateJson(file, data) {`);
  const patched = Buffer.from(original.includes(Buffer.from('\r\n')) ? source.replace(/\n/g, '\r\n') : source);
  const afterSha256 = sha256(patched);
  if (win7StateRenameFile.after) assert.equal(afterSha256, win7StateRenameFile.after, 'Win7 state rename transform changed.');
  await writeFile(filename, patched);
  return { path: win7StateRenameFile.path, beforeSha256: win7StateRenameFile.before, afterSha256, bytes: patched.length, alreadyApplied: false };
}
