import { readdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(import.meta.url);
const WORKSPACE_TEMPLATE = resolve(dirname(SOURCE), '../template/workspace/AGENTS.md');
const PROVIDERS = ['deepseek-official', 'opencode-go'];
const SLOT_DEFINITIONS = [
  { id: 'primary', label: '主用' },
  { id: 'backup1', label: '备用一' },
  { id: 'backup2', label: '备用二' },
];
const ROOT_FILES = new Set(['LICENSE', 'manifest.json', '检查环境.cmd', '连接 Codex.cmd', '配置密钥.cmd', '启动 DSH.cmd', '停止 DSH.cmd', '先看这里.md']);
const ROOT_DIRECTORIES = new Set(['app', 'runtime', 'bridge', 'portable', 'licenses', 'workspace', 'data', 'logs']);
const PORTABLE_FILES = new Set([
  'bootstrap.mjs', 'config.json', 'Configure-Keys.ps1', 'gitconfig', 'keys.example.json', 'keys.json',
  'keys.mjs', 'launcher.mjs', 'mcp.mjs', 'profile.patch.yml', 'providers.json', 'providers.mjs',
]);
const BRIDGE_FILES = new Set(['connection.mjs', 'core.mjs', 'server.mjs', 'portable-connect.mjs', 'package.json', 'package-lock.json', 'LICENSE']);

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function keyError() {
  // Never include a rejected value, parser source text, key length or digest.
  return new Error('密钥槽位格式无效或不符合当前分发模式，停止打包。');
}

function validateKeyConfig(value, { includeKeys = false, example = false } = {}) {
  if (!exactFields(value, ['version', 'active', 'slots']) || ![1, 2].includes(value.version)
    || !SLOT_DEFINITIONS.some(slot => slot.id === value.active) || !Array.isArray(value.slots)
    || value.slots.length !== SLOT_DEFINITIONS.length || (includeKeys && !example && value.version !== 2)) throw keyError();
  const found = new Set();
  const configured = new Map(PROVIDERS.map(provider => [provider, 0]));
  const values = [];
  for (const slot of value.slots) {
    const fields = value.version === 2 ? ['id', 'label', 'provider', 'key'] : ['id', 'label', 'key'];
    if (!exactFields(slot, fields)) throw keyError();
    const definition = SLOT_DEFINITIONS.find(item => item.id === slot.id);
    const provider = value.version === 2 ? slot.provider : 'deepseek-official';
    if (!definition || slot.label !== definition.label || found.has(slot.id) || !PROVIDERS.includes(provider)
      || typeof slot.key !== 'string' || (slot.key !== '' && !/^[\x21-\x7e]+$/.test(slot.key))
      || ((!includeKeys || example) && slot.key !== '')) throw keyError();
    found.add(slot.id);
    if (slot.key !== '') {
      configured.set(provider, configured.get(provider) + 1);
      values.push(slot.key);
    }
  }
  // Internal only. Public validation and manifests return provider counts,
  // never these values; they are used solely to detect accidental duplicates.
  return { version: value.version, configuredSlots: values.length, values,
    providers: PROVIDERS.map(provider => ({ provider, configuredSlots: configured.get(provider) })) };
}

async function readKeyConfig(filename, options, { optional = false } = {}) {
  let text;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw keyError(); }
  let value;
  try { value = JSON.parse(text); } catch { throw keyError(); }
  return validateKeyConfig(value, options);
}

function slash(value) { return value.split('\\').join('/'); }

function firstPartyFileAllowed(local) {
  if (!local.includes('/')) return ROOT_FILES.has(local);
  if (local.startsWith('portable/')) return PORTABLE_FILES.has(local.slice('portable/'.length));
  if (local.startsWith('bridge/') && !local.startsWith('bridge/node_modules/')) return BRIDGE_FILES.has(local.slice('bridge/'.length));
  if (local.startsWith('workspace/')) return local === 'workspace/AGENTS.md';
  return true;
}

function forbiddenRuntimeFile(local) {
  const name = local.slice(local.lastIndexOf('/') + 1).toLowerCase();
  return /\.(?:log|jsonl|sqlite|sqlite3|db|db-wal|db-shm)$/i.test(name)
    || ['.credentials.yaml', '.credentials.yml', 'connection.json', 'state.json', 'history.json', 'sessions.json', 'relay-token', 'cookies'].includes(name)
    || name === '.env' || (name.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(name));
}

export async function validateDistribution(directory, { includeKeys = false, workspaceTemplate = WORKSPACE_TEMPLATE } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') throw new Error('请指定待分发目录。');
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('分发根目录必须是真实目录，不能是链接。');
  let count = 0, bytes = 0;
  const ownedTextFiles = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = join(current, entry.name);
      const local = slash(relative(root, filename));
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error('分发目录不能包含链接。');
      if (!local.includes('/')) {
        if (info.isDirectory() ? !ROOT_DIRECTORIES.has(local) : !ROOT_FILES.has(local)) {
          throw new Error('分发根目录含非发行文件或目录，停止打包。');
        }
      }
      if (info.isDirectory()) {
        if (local.startsWith('portable/') || (local.startsWith('bridge/') && local !== 'bridge/node_modules' && !local.startsWith('bridge/node_modules/'))
          || local.startsWith('workspace/')) throw new Error('第一方分发目录含未授权子目录，停止打包。');
        await walk(filename);
        continue;
      }
      if (!info.isFile()) throw new Error('分发目录包含不支持的文件类型。');
      if (local.startsWith('logs/') || local.startsWith('data/')) throw new Error('分发包不能包含运行记录、用户历史或个人 profile 数据。');
      if (!firstPartyFileAllowed(local) || forbiddenRuntimeFile(local)) throw new Error('分发包含非发行文件或敏感运行产物，停止打包。');
      if (local === 'manifest.json') continue;
      count++;
      bytes += info.size;
      if ((!local.includes('/') || local.startsWith('portable/') || (local.startsWith('bridge/') && !local.startsWith('bridge/node_modules/')))
        && local !== 'portable/keys.json') ownedTextFiles.push(filename);
    }
  }
  await walk(root);
  const workspaceEntries = await readdir(join(root, 'workspace'));
  if (workspaceEntries.length !== 1 || workspaceEntries[0] !== 'AGENTS.md') throw new Error('分发工作区只能包含模板 AGENTS.md。');
  const [workspace, template] = await Promise.all([readFile(join(root, 'workspace', 'AGENTS.md')), readFile(workspaceTemplate)]);
  if (!workspace.equals(template)) throw new Error('分发工作区 AGENTS.md 已偏离模板，停止打包。');
  const example = await readKeyConfig(join(root, 'portable', 'keys.example.json'), { includeKeys: false, example: true });
  const keys = await readKeyConfig(join(root, 'portable', 'keys.json'), { includeKeys }, { optional: !includeKeys });
  if (includeKeys && (!keys || keys.configuredSlots === 0)) throw new Error('私用版至少需要一个已配置槽位；空密钥包请使用默认 no-key 模式。');
  const summary = keys ?? example;
  if (includeKeys) {
    for (const filename of ownedTextFiles) {
      const contents = await readFile(filename);
      if (summary.values.some(value => contents.includes(Buffer.from(value, 'utf8')))) {
        throw new Error('私用密钥出现在专用 keys.json 之外，停止打包。');
      }
    }
  }
  const packageVersion = includeKeys || example.version === 2 || summary.version === 2 ? '0.2.0' : '0.1.0';
  return {
    root, packageVersion,
    edition: includeKeys ? 'windows-x64-private' : 'windows-x64-no-key',
    credentialSlots: SLOT_DEFINITIONS.length, credentialValuesIncluded: includeKeys,
    credentialProviders: summary.providers, configuredCredentialSlots: summary.configuredSlots,
    filesExcludingManifest: count, uncompressedBytesExcludingManifest: bytes,
  };
}

export async function writeManifest(directory, options = {}) {
  const validation = await validateDistribution(directory, options);
  const { root } = validation;
  const dsh = JSON.parse(await readFile(join(root, 'app/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(root, 'runtime/primary-runtime/runtime.json'), 'utf8'));
  const sha256 = async filename => createHash('sha256').update(await readFile(join(root, filename))).digest('hex');
  const { root: _root, ...safeValidation } = validation;
  const manifest = {
    ...safeValidation,
    dshVersion: dsh.version,
    nodeVersion: runtime.node, pythonVersion: runtime.python, pnpmVersion: runtime.pnpm,
    gitVersion: '2.50.1.windows.1', pythonPackages: runtime.pythonPackages,
    builtAt: new Date().toISOString(),
    upstream: {
      repository: 'https://github.com/sqs404/dsh-portable', release: 'v0.2.0-rc.2',
      archiveSha256: 'd9b6abeadea953a1974f90ce59de61d47ef366a3b8f60a21c6fc256c9aaf1923',
      runtimeSource: '官方 DeepSeek Harness 0.2.0-rc.2 Windows 安装包内 primary-runtime',
    },
    entryHashes: {
      node: await sha256('runtime/node/node.exe'),
      python: await sha256('runtime/primary-runtime/dependencies/python/python.exe'),
      git: await sha256('runtime/git/cmd/git.exe'),
    },
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(args = process.argv.slice(2)) {
  const includeKeys = args.includes('--include-keys');
  const positional = args.filter(value => value !== '--include-keys');
  if (positional.length !== 1 || positional[0].startsWith('--') || args.filter(value => value === '--include-keys').length > 1) {
    throw new Error('用法：node manifest.mjs <分发目录> [--include-keys]');
  }
  const manifest = await writeManifest(positional[0], { includeKeys });
  process.stdout.write(`${JSON.stringify({
    verified: true, files: manifest.filesExcludingManifest, bytes: manifest.uncompressedBytesExcludingManifest,
    packageVersion: manifest.packageVersion, edition: manifest.edition, dshVersion: manifest.dshVersion,
    credentialValuesIncluded: manifest.credentialValuesIncluded,
    credentialProviders: manifest.credentialProviders, configuredCredentialSlots: manifest.configuredCredentialSlots,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SOURCE) {
  main().catch(error => {
    // A JSON parser error can quote a private document; never print it.
    const message = error instanceof Error && !error.code && !(error instanceof SyntaxError)
      ? error.message : '分发清单检查失败，请检查目录完整性与分发模式。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
