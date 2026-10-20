/** Read-only input inventory. Does not download, extract, install, or read credentials. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(source));
const versions = { 'better-sqlite3': '11.10.0', bindings: '1.5.0', 'file-uri-to-path': '1.0.0',
  typescript: '5.9.3', undici: '6.21.2', 'core-js': '3.41.0', esbuild: '0.25.11', pnpm: '9.15.9' };
const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function resolveBuildInputs(inputsFile, overrides = {}) {
  const filename = path.resolve(inputsFile ?? path.join(repo, 'dependencies.example.json'));
  let config;
  try { config = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Cannot read input configuration; use dependencies.example.json (no credentials).'); }
  if (config.schemaVersion !== 1 || !config.paths) throw new Error('Unsupported input configuration schema.');
  const baseDirectory = path.dirname(filename);
  const inputs = {};
  for (const key of ['base', 'research', 'tools', 'gcc', 'sqliteAddon', 'pythonSitePackages']) {
    const value = overrides[key] ?? config.paths[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing input path: ${key}`);
    // A plain executable name is looked up on PATH, never evaluated by a shell.
    inputs[key] = key === 'gcc' && !/[\\/]/.test(value) ? value : path.resolve(baseDirectory, value);
  }
  return { inputs, config };
}

export async function checkBuildInputs(inputs, { archives = [] } = {}) {
  const issues = [];
  const needed = [
    ['base/app/package.json', path.join(inputs.base, 'app/package.json')],
    ['base DSH package', path.join(inputs.base, 'app/node_modules/@deepseek-ai/dsh/package.json')],
    ['base bridge', path.join(inputs.base, 'bridge/package.json')],
    ['base bridge dependencies', path.join(inputs.base, 'bridge/node_modules')],
    ['base licenses', path.join(inputs.base, 'licenses')],
    ['base runtime metadata', path.join(inputs.base, 'runtime/primary-runtime/runtime.json')],
    ['Node 20.19.2', path.join(inputs.research, 'node/node20-runtime/node-v20.19.2-win-x64/node.exe')],
    ['PythonVista', path.join(inputs.research, 'deps/python31215/python.exe')],
    ['PortableGit', path.join(inputs.research, 'deps/git2462/cmd/git.exe')],
    ['PowerShell', path.join(inputs.research, 'deps/powershell7224/pwsh.exe')],
    ['Supermium', path.join(inputs.research, 'deps/supermium150/Supermium/chrome.exe')],
    ['ripgrep', path.join(inputs.research, 'deps/ripgrep13/ripgrep-13.0.0-x86_64-pc-windows-msvc/rg.exe')],
    ['Zstandard', path.join(inputs.research, 'deps/zstd/zstd-v1.5.7-win64/zstd.exe')],
    ['SQLite native addon', inputs.sqliteAddon], ['Python site-packages', inputs.pythonSitePackages],
  ];
  for (const [label, filename] of needed) if (!existsSync(filename)) issues.push(`Missing ${label}: ${filename}`);
  const dshPackage = path.join(inputs.base, 'app/node_modules/@deepseek-ai/dsh/package.json');
  if (existsSync(dshPackage)) {
    const metadata = JSON.parse(await readFile(dshPackage, 'utf8'));
    if (metadata.version !== '0.2.0-rc.2') issues.push('Base DSH must be exactly 0.2.0-rc.2; patches are hash constrained.');
  }
  for (const [name, version] of Object.entries(versions)) {
    const filename = path.join(inputs.tools, name, 'package.json');
    if (!existsSync(filename)) issues.push(`Missing build dependency ${name}@${version}`);
    else if (JSON.parse(await readFile(filename, 'utf8')).version !== version) issues.push(`Unexpected build dependency version: ${name}`);
  }
  for (const [filename, expected, label] of [
    [path.join(inputs.research, 'node/node20-runtime/node-v20.19.2-win-x64/node.exe'),
      'fc4185dbe44461fd9d96a75a62fd7a76ee94b3a5b3a87ba2dd40412d3d02babd', 'Node binary'],
    [inputs.sqliteAddon, '1eeaea9a4acb37a35d5057ab76b9ca923b6684df019b1316717f1ea6d9eff1a1', 'SQLite addon'],
  ]) {
    if (existsSync(filename) && sha256(await readFile(filename)) !== expected) issues.push(`SHA256 mismatch: ${label}`);
  }
  for (const archive of archives) {
    if (!archive.file || !/^[a-f0-9]{64}$/.test(archive.sha256 ?? '')) throw new Error('Malformed public archive inventory.');
    const filename = path.resolve(inputs.research, archive.file);
    if (!existsSync(filename)) issues.push(`Missing archive ${archive.id}: ${filename}`);
    else if (sha256(await readFile(filename)) !== archive.sha256) issues.push(`SHA256 mismatch: archive ${archive.id}`);
  }
  const compiler = spawnSync(inputs.gcc, ['--version'], { windowsHide: true, stdio: 'ignore' });
  if (compiler.error || compiler.status !== 0) issues.push('Missing usable x64 MinGW GCC; set paths.gcc or --gcc.');
  return { ready: issues.length === 0, checks: needed.length + Object.keys(versions).length + 3 + archives.length, issues };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node win7/prepare-inputs.mjs [--inputs config.json] [--check] [--archives]\nRead-only checks. Archive URLs and manual extraction layout: BUILDING.zh-CN.md.');
    return;
  }
  let inputsFile, archives = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--inputs' && args[index + 1]) inputsFile = args[++index];
    else if (args[index] === '--archives') archives = true;
    else if (args[index] !== '--check') throw new Error('Unknown option; use --help.');
  }
  const resolved = await resolveBuildInputs(inputsFile);
  const report = await checkBuildInputs(resolved.inputs, { archives: archives ? resolved.config.downloads : [] });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  main().catch(() => { console.error('Input check failed. Check configuration and dependency metadata; no files were changed.'); process.exitCode = 1; });
}
