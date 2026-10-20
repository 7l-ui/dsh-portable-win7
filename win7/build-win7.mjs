/** Build an isolated Win7 candidate. Never updates the existing Win10/11 distribution. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyWin7Jobs } from './apply-win7-jobs.mjs';
import { applyWin7StateRename } from './apply-win7-state-rename.mjs';
import { resolveBuildInputs, checkBuildInputs } from './prepare-inputs.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const builder = path.dirname(here);
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node win7/build-win7.mjs [new-output-directory] [--inputs config.json] [--base dir] [--research dir] [--tools dir] [--gcc executable] [--sqlite-addon file] [--python-site-packages dir]\nBuild on Windows 10/11 with Node 24. External inputs: BUILDING.zh-CN.md.');
  process.exit(0);
}
const optionNames = { '--base': 'base', '--research': 'research', '--tools': 'tools', '--gcc': 'gcc',
  '--sqlite-addon': 'sqliteAddon', '--python-site-packages': 'pythonSitePackages' };
const overrides = {};
let outputArgument, inputsFile;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--inputs' && args[index + 1]) inputsFile = args[++index];
  else if (optionNames[args[index]] && args[index + 1]) {
    const name = optionNames[args[index]], value = args[++index];
    overrides[name] = name === 'gcc' && !/[\\/]/.test(value) ? value : path.resolve(value);
  } else if (!args[index].startsWith('--') && !outputArgument) outputArgument = args[index];
  else throw new Error('Unknown or incomplete build option; use --help. Resume is unsupported; use a fresh output.');
}
const { inputs } = await resolveBuildInputs(inputsFile, overrides);
const { base, research, tools, gcc, sqliteAddon, pythonSitePackages } = inputs;
const output = path.resolve(outputArgument ?? path.join(builder, 'artifacts/DSH-Portable-Win7-x64-Experimental'));
if (process.platform !== 'win32') throw new Error('Build on a Windows 10/11 x64 host; output targets Win7 SP1 x64.');
if (existsSync(output)) throw new Error('Output directory already exists; choose a new directory.');
for (const input of [base, research, tools, path.dirname(pythonSitePackages)]) {
  const relative = path.relative(input, output);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must not be inside a build input directory.');
  }
}
const readiness = await checkBuildInputs(inputs);
if (!readiness.ready) throw new Error('Missing or incompatible build inputs:\n' + readiness.issues.join('\n') + '\nSee BUILDING.zh-CN.md. No output was created.');
const require = createRequire(path.join(tools, '__build-loader.cjs'));
const esbuild = require('esbuild');
const nodeSource = path.join(research, 'node/node20-runtime/node-v20.19.2-win-x64');
const deps = path.join(research, 'deps');
const hash = data => createHash('sha256').update(data).digest('hex');
for (const needed of [path.join(base, 'app/package.json'), path.join(nodeSource, 'node.exe'),
  path.join(deps, 'python31215/python.exe'), path.join(deps, 'git2462/cmd/git.exe'),
  path.join(deps, 'powershell7224/pwsh.exe'), path.join(deps, 'supermium150/Supermium/chrome.exe'),
  path.join(deps, 'zstd/zstd-v1.5.7-win64/zstd.exe')]) {
  if (!existsSync(needed)) throw new Error(`Missing public build input: ${needed}`);
}
function copy(source, destination, extra = []) {
  const result = spawnSync('robocopy.exe', [source, destination, '/E', '/XJ', '/R:1', '/W:1',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP', ...extra], { windowsHide: true, stdio: 'ignore' });
  if (result.error || result.status >= 8) throw new Error('Distribution component copy failed.');
}
console.log('[Win7 candidate] copying public production dependencies');
await mkdir(output, { recursive: true });
const compat = path.join(output, 'app/node_modules/@dsh-portable/compat');
for (const component of ['app', 'bridge', 'licenses']) copy(path.join(base, component), path.join(output, component),
  component === 'app' ? ['/XD', path.join(base, 'app/node_modules/undici')] : []);
copy(path.join(builder, 'template'), output, ['/XF', '*.test.mjs']);
copy(nodeSource, path.join(output, 'runtime/node'), ['/XF', '*.msi']);
copy(path.join(deps, 'python31215'), path.join(output, 'runtime/primary-runtime/dependencies/python'));
copy(pythonSitePackages, path.join(output, 'runtime/primary-runtime/dependencies/python/Lib/site-packages'), ['/XD', '__pycache__']);
await writeFile(path.join(output, 'runtime/primary-runtime/dependencies/python/python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
copy(path.join(tools, 'pnpm'), path.join(output, 'runtime/primary-runtime/dependencies/pnpm'));
await writeFile(path.join(output, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), "import './pnpm.cjs';\n");
await mkdir(path.join(output, 'runtime/primary-runtime/dependencies/node/node_modules'), { recursive: true });
copy(nodeSource, path.join(output, 'runtime/primary-runtime/dependencies/node/bin'), ['/XF', '*.msi']);
// Keep the original community download immutable; only the new copies get an app-local ETW shim.
const shimOutput = path.join(output, 'runtime/node/DSHAPI32.dll');
const compiled = spawnSync(gcc, ['-shared', '-O2', '-nostdlib', '-fno-stack-protector',
  '-Wl,--entry,0', '-Wl,--subsystem,windows:6.1', '-o', shimOutput,
  path.join(here, 'compat/native/dshapi32.c'), path.join(here, 'compat/native/dshapi32.def')], { windowsHide: true, stdio: 'pipe' });
if (compiled.error || compiled.status !== 0) throw new Error('Cannot compile app-local ETW compatibility DLL.');
const originalNode = await readFile(path.join(nodeSource, 'node.exe'));
if (hash(originalNode) !== 'fc4185dbe44461fd9d96a75a62fd7a76ee94b3a5b3a87ba2dd40412d3d02babd') throw new Error('Unexpected Node binary.');
const importName = Buffer.from('ADVAPI32.dll\0');
const importOffset = originalNode.indexOf(importName);
if (importOffset < 0 || originalNode.indexOf(importName, importOffset + 1) !== -1) throw new Error('Cannot uniquely locate Node ADVAPI import.');
const compatibleNode = Buffer.from(originalNode);
Buffer.from('DSHAPI32.dll\0').copy(compatibleNode, importOffset);
await writeFile(path.join(output, 'runtime/node/node.exe'), compatibleNode);
await writeFile(path.join(output, 'runtime/primary-runtime/dependencies/node/bin/node.exe'), compatibleNode);
await cp(shimOutput, path.join(output, 'runtime/primary-runtime/dependencies/node/bin/DSHAPI32.dll'));
// Office skill text/assets are not part of this source publication or copied from an installed app.
copy(path.join(deps, 'git2462'), path.join(output, 'runtime/git'));
copy(path.join(deps, 'powershell7224'), path.join(output, 'runtime/powershell'));
copy(path.join(deps, 'supermium150/Supermium'), path.join(output, 'runtime/browser'));
copy(path.join(deps, 'zstd/zstd-v1.5.7-win64'), path.join(output, 'runtime/zstd'));
const runtime = JSON.parse(await readFile(path.join(base, 'runtime/primary-runtime/runtime.json'), 'utf8'));
Object.assign(runtime, { node: '20.19.2-win7-community', python: '3.12.15-win7-community', pnpm: '9.15.9',
  officeSkillsIncluded: false, compatibility: { requested: 'Windows 7 SP1 x64', win7VmVerified: false } });
await writeFile(path.join(output, 'runtime/primary-runtime/runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
copy(path.join(here, 'compat'), compat, ['/XF', '*.test.mjs']);
for (const dependency of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'typescript', 'undici', 'core-js']) copy(path.join(tools, dependency), path.join(output, 'app/node_modules', dependency));
const nativeSource = sqliteAddon;
await mkdir(path.join(output, 'app/node_modules/better-sqlite3/build/Release'), { recursive: true });
await cp(nativeSource, path.join(output, 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
const oldRg = path.join(deps, 'ripgrep13/ripgrep-13.0.0-x86_64-pc-windows-msvc/rg.exe');
await cp(oldRg, path.join(output, 'app/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'));
console.log('[Win7 candidate] transforming production JavaScript for Node 20');
let transformed = 0;
const changes = [];
async function transformTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !['test', 'tests', 'fixtures', 'example', 'examples'].includes(entry.name)) await transformTree(filename);
      continue;
    }
    if (!/\.(c|m)?js$/.test(entry.name)) continue;
    const original = await readFile(filename, 'utf8');
    let source = original;
    // The fixed community Node 20.19.2 backport exposes the v1 loader API.
    // Preserve upstream shape detection and allow only this audited older build.
    if (filename.endsWith(path.join('@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js'))) {
      source = source.replace('if (major < 22) return;', 'if (major < 22 && process.versions.node !== "20.19.2") return;');
    }
    source = source.replaceAll('import.meta.main', "(!!process.argv[1] && import.meta.url === process.getBuiltinModule('node:url').pathToFileURL(process.getBuiltinModule('node:path').resolve(process.argv[1])).href)");
    if (source.includes('node:sqlite')) source = source.replaceAll('"node:sqlite"', '"@dsh-portable/compat/sqlite"').replaceAll("'node:sqlite'", "'@dsh-portable/compat/sqlite'");
    if (source.includes('getSystemErrorMessage') && !filename.startsWith(compat)) source = source.replace(/from (["'])node:util\1/g, 'from "@dsh-portable/compat/util"');
    if (source.includes('stripTypeScriptTypes') && !filename.startsWith(compat)) source = source.replace(/from (["'])node:module\1/g, 'from "@dsh-portable/compat/module"');
    if (/import\s*\{[^}]*[zZ]std[^}]*\}\s*from\s*["']node:zlib["']/.test(source)) source = source.replace(/from (["'])node:zlib\1/g, 'from "@dsh-portable/compat/zlib"');
    const result = await esbuild.transform(source, { target: 'node20.19', sourcefile: filename, legalComments: 'inline', logLevel: 'silent' });
    if (result.code !== original) {
      await writeFile(filename, result.code);
      changes.push({ path: path.relative(output, filename), sourceSha256: hash(original), transformedSha256: hash(result.code) });
    }
    transformed++;
  }
}
await transformTree(path.join(output, 'app/node_modules'));
await applyWin7Jobs(output);
// Every program spawned by the portable launcher receives the compatibility prelude.
const launcherFile = path.join(output, 'portable/launcher.mjs');
let launcher = await readFile(launcherFile, 'utf8');
launcher = `import '../app/node_modules/@dsh-portable/compat/preload.cjs';\n${launcher}`;
launcher = launcher.replace('const bins = [path.dirname(layout.node), path.dirname(layout.python), path.dirname(layout.git)];',
  "const bins = [path.dirname(layout.node), path.dirname(layout.python), path.dirname(layout.git), path.join(layout.root, 'runtime/powershell')];");
launcher = launcher.replace('environment.DSH_TELEMETRY_DISABLED = \'1\';',
  "environment.DSH_TELEMETRY_DISABLED = '1';\n  environment.NODE_OPTIONS = '--require=\"' + path.join(layout.root, 'app/node_modules/@dsh-portable/compat/preload.cjs').replaceAll('\\\\', '/') + '\"';");
// DSH's profile/config hot reload explicitly requires the loader's internal API.
// Keep the option on the DSH server only; it is not a system-wide NODE_OPTIONS.
launcher = launcher.replace('spawn(layout.node, [layout.dsh,', "spawn(layout.node, ['--expose-internals', layout.dsh,");
const openerStart = launcher.indexOf('async function browserOpen(');
const openerEnd = launcher.indexOf('\nexport async function startPackage', openerStart);
if (openerStart < 0 || openerEnd < 0) throw new Error('Cannot locate portable browser launcher.');
launcher = launcher.slice(0, openerStart) + `async function browserOpen(url) {
  const browser = path.join(ROOT, 'runtime/browser/chrome.exe');
  const opener = spawn(browser, ['--disable-encryption', '--disable-machine-id', '--no-first-run',
    '--user-data-dir=' + path.join(ROOT, 'data/browser'), url], { detached: true, windowsHide: true, stdio: 'ignore' });
  opener.on('error', () => {}); opener.unref();
}
` + launcher.slice(openerEnd);
await writeFile(launcherFile, launcher);
await applyWin7StateRename(output);
// Win7's inbox Windows PowerShell 2 cannot run the modern configuration UI.
const configureCmdFile = path.join(output, '配置密钥.cmd');
const configureCmd = await readFile(configureCmdFile, 'utf8');
if (!configureCmd.includes('powershell.exe -NoProfile')) throw new Error('Cannot locate key configuration launcher.');
await writeFile(configureCmdFile, configureCmd.replace('powershell.exe -NoProfile', '"%~dp0runtime\\powershell\\pwsh.exe" -NoLogo -NoProfile'));
const mcpFile = path.join(output, 'portable/mcp.mjs');
await writeFile(mcpFile, `import '../app/node_modules/@dsh-portable/compat/preload.cjs';\n${await readFile(mcpFile, 'utf8')}`);
let profile = await readFile(path.join(output, 'portable/profile.patch.yml'), 'utf8');
profile += `\n- id: pwsh-sandbox\n  config:\n    pwshPath: !!js "process.getBuiltinModule('node:path').join(process.env.DSH_PORTABLE_ROOT, 'runtime/powershell/pwsh.exe')"\n`;
await writeFile(path.join(output, 'portable/profile.patch.yml'), profile);
await cp(path.join(output, 'portable/keys.example.json'), path.join(output, 'portable/keys.json'));
for (const directory of ['data/dsh-home', 'data/agents-home', 'data/runtime', 'logs']) await mkdir(path.join(output, directory), { recursive: true });
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ packageVersion: '0.1.0-experimental', edition: 'win7-sp1-x64-candidate',
  dshVersion: '0.2.0-rc.2', requestedOperatingSystem: 'Windows 7 SP1 x64', win7VmVerified: false,
  credentialValuesIncluded: false, transformedJavaScriptFiles: transformed,
  officeSkillsIncluded: false,
  runtime: JSON.parse(await readFile(path.join(output, 'runtime/primary-runtime/runtime.json'), 'utf8')),
  nodeSource: 'https://github.com/vladimir-andreevich/node.js-windows-7',
  nodeArchiveSha256: 'bf2ddbd115c3775dc997cef1776f73695bae59b266b6f3bf9b9ebce22a06a132',
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
await writeFile(path.join(output, 'licenses/win7-transformations.json'), `${JSON.stringify(changes, null, 2)}\n`);
await writeFile(path.join(output, '先看这里.md'), '# Win7 SP1 x64 兼容候选包\n\n每次重新构建都需要独立验收，不自动继承此前测试发行包的 Win7 验证结果。\n\n使用社区 Node/Python、固定旧版 Git/PowerShell 与 Supermium。仅有三个空密钥槽；需自行配置 API Key。Win7 SP1 x64 还需 KB3063858、KB2999226 或等效组件。\n\n公开源码不附办公技能素材，Python 第三方库为构建者单独合法提供的外部输入。图片附件与持久交互终端暂不保证。\n');
const provenance = spawnSync(process.execPath, [path.join(here, 'refresh-transform-records.mjs'), output, '--base', base, '--tools', tools], { windowsHide: true, stdio: 'inherit' });
if (provenance.error || provenance.status !== 0) throw new Error('Cannot refresh Win7 code provenance.');
const recordedManifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
console.log(JSON.stringify({ built: true, output, examinedJavaScriptFiles: recordedManifest.examinedJavaScriptFiles,
  transformedJavaScriptFiles: recordedManifest.transformedJavaScriptFiles, win7VmVerified: false, credentialValuesIncluded: false }));
