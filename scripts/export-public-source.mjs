/** One-time, allowlist-only export from the private working builder. No runtime inputs are read. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanText } from './audit-public.mjs';

// Deliberately enumerate files. Never recurse the source workspace or copy histories/reports.
export const SOURCE_FILES = Object.freeze([
  'build.ps1', 'package.ps1',
  'scripts/manifest.mjs', 'scripts/manifest.test.mjs', 'scripts/verify-portable.mjs', 'scripts/verify-mcp.mjs',
  'template/LICENSE',
  'template/检查环境.cmd', 'template/连接 Codex.cmd', 'template/配置密钥.cmd', 'template/启动 DSH.cmd', 'template/停止 DSH.cmd',
  'template/bridge/core.mjs', 'template/bridge/core.test.mjs', 'template/bridge/portable-connect.mjs', 'template/bridge/server.mjs',
  'template/portable/bootstrap.mjs', 'template/portable/bootstrap.test.mjs', 'template/portable/config.json',
  'template/portable/Configure-Keys.ps1', 'template/portable/gitconfig', 'template/portable/keys.example.json',
  'template/portable/keys.mjs', 'template/portable/keys.test.mjs', 'template/portable/launcher.mjs', 'template/portable/launcher.test.mjs',
  'template/portable/mcp.mjs', 'template/portable/mcp.test.mjs', 'template/portable/profile.patch.yml',
  'template/portable/providers.json', 'template/portable/providers.mjs', 'template/portable/providers.test.mjs', 'template/workspace/AGENTS.md',
  'win7/build-win7.mjs', 'win7/apply-win7-jobs.mjs', 'win7/apply-win7-state-rename.mjs', 'win7/refresh-transform-records.mjs',
  'win7/test-compat.mjs', 'win7/verify-host.mjs', 'win7/verify-services.mjs', 'win7/verify-sandbox.mjs',
  'win7/compat/package.json', 'win7/compat/preload.cjs', 'win7/compat/sqlite.mjs', 'win7/compat/util-compat.mjs',
  'win7/compat/module-compat.mjs', 'win7/compat/zlib-compat.mjs', 'win7/compat/zlib-compat.test.mjs', 'win7/compat/compat.test.mjs',
  'win7/compat/native/dshapi32.c', 'win7/compat/native/dshapi32.def',
  'win7/tools/package.json', 'win7/tools/pnpm-lock.yaml',
]);
export const BRIDGE_FILES = Object.freeze(['connection.mjs', 'package.json', 'package-lock.json', 'LICENSE']);

function portableSource(relative, text) {
  if (relative === 'win7/build-win7.mjs') {
    // Replace the only known developer-local compiler location without publishing it.
    const compiler = /spawnSync\('[A-Za-z]:\\\\huanjin\\\\mingw64\\\\bin\\\\gcc\.exe',/g;
    let matches = 0;
    text = text.replace(compiler, () => { matches++; return "spawnSync(process.env.DSH_MINGW_GCC || 'gcc.exe',"; });
    if (matches !== 1) throw new Error('Expected compiler portability transform did not match exactly once.');
  }
  if (relative === 'template/portable/profile.patch.yml') {
    const start = text.indexOf('    - id: portable-office-skills');
    const end = text.indexOf('\n- id: workspace-controller', start);
    if (start < 0 || end < 0) throw new Error('Expected optional office-skills registration did not match.');
    text = text.slice(0, start) + text.slice(end + 1);
  }
  return text;
}

async function regularSourceFile(root, relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('A source allowlist path contains a link.');
  }
  const info = await lstat(current);
  if (!info.isFile()) throw new Error('A source allowlist entry is not a file.');
  const actual = await realpath(current);
  const actualRoot = await realpath(root);
  if (!actual.startsWith(actualRoot + path.sep)) throw new Error('A source allowlist entry escaped its root.');
  return current;
}

export async function exportSource(sourceRoot, targetRoot) {
  sourceRoot = path.resolve(sourceRoot);
  targetRoot = path.resolve(targetRoot);
  if (targetRoot === sourceRoot || targetRoot.startsWith(sourceRoot + path.sep)) throw new Error('Export target must be outside the source builder.');
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Source must be a regular directory.');
  const prepared = [];
  const findings = [];
  for (const relative of SOURCE_FILES) {
    const full = await regularSourceFile(sourceRoot, relative);
    const bytes = await readFile(full);
    if (bytes.includes(0)) { findings.push({ file: relative, rule: 'binary-source', count: 1 }); continue; }
    const text = portableSource(relative, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    findings.push(...scanText(text, relative));
    prepared.push({ relative, text });
  }
  if (findings.length) return { passed: false, findingCount: findings.length, findings, copiedFiles: 0 };
  // Existing docs/scripts are permitted in the prepared new repository; no destination file is overwritten.
  await mkdir(targetRoot, { recursive: true });
  const targetInfo = await lstat(targetRoot);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('Export target must be a regular directory.');
  for (const item of prepared) {
    const destination = path.join(targetRoot, item.relative);
    try { await lstat(destination); throw new Error('An export destination already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of prepared) {
    const destination = path.join(targetRoot, item.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    // Check every parent again before writing, so a pre-existing junction cannot redirect publication.
    const actualParent = await realpath(path.dirname(destination));
    const actualTarget = await realpath(targetRoot);
    if (actualParent !== actualTarget && !actualParent.startsWith(actualTarget + path.sep)) throw new Error('Export destination parent escaped its root.');
    await writeFile(destination, item.text, { flag: 'wx' });
  }
  return { exportVersion: 1, passed: true, copiedFiles: prepared.length, compilerPathMadePortable: true, apiKeysIncluded: false,
    copied: prepared.map(item => item.relative) };
}

export async function exportBridge(sourceRoot, targetRoot) {
  sourceRoot = path.resolve(sourceRoot);
  targetRoot = path.resolve(targetRoot);
  if (sourceRoot === targetRoot || targetRoot.startsWith(sourceRoot + path.sep)) throw new Error('Bridge export target must be separate.');
  const rootInfo = await lstat(sourceRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Bridge source must be a regular directory.');
  const prepared = [];
  const findings = [];
  for (const relative of BRIDGE_FILES) {
    const file = await regularSourceFile(sourceRoot, relative);
    const bytes = await readFile(file);
    if (bytes.includes(0)) { findings.push({ file: `bridge-source/${relative}`, rule: 'binary-source', count: 1 }); continue; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    findings.push(...scanText(text, `bridge-source/${relative}`));
    prepared.push({ relative, text });
  }
  if (findings.length) return { passed: false, copiedFiles: 0, findings };
  await mkdir(targetRoot, { recursive: true });
  const actualTarget = await realpath(targetRoot);
  const targetInfo = await lstat(targetRoot);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('Bridge export target must be a regular directory.');
  const destinationRoot = path.join(targetRoot, 'bridge-source');
  await mkdir(destinationRoot, { recursive: true });
  if ((await lstat(destinationRoot)).isSymbolicLink() || !(await realpath(destinationRoot)).startsWith(actualTarget + path.sep)) throw new Error('Bridge destination escaped its root.');
  for (const item of prepared) {
    try { await lstat(path.join(destinationRoot, item.relative)); throw new Error('Bridge export destination already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of prepared) await writeFile(path.join(destinationRoot, item.relative), item.text, { flag: 'wx' });
  return { exportVersion: 1, passed: true, copiedFiles: prepared.length, apiKeysIncluded: false, copied: prepared.map(item => `bridge-source/${item.relative}`) };
}

const main = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (main) {
  try {
    const bridgeOnly = process.argv[2] === '--bridge-only';
    const args = process.argv.slice(bridgeOnly ? 3 : 2);
    if (!args[0] || !args[1]) throw new Error('Usage: node scripts/export-public-source.mjs [--bridge-only] <source> <new-source-repository>');
    const result = bridgeOnly ? await exportBridge(args[0], args[1]) : await exportSource(args[0], args[1]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    console.error('Public source export refused an input or existing destination. No private content is printed.');
    process.exitCode = 1;
  }
}
