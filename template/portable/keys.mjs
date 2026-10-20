/**
 * 包内 API key 配置。按服务分别注入密钥，当前槽位决定默认模型服务。
 * 同服务优先使用当前非空槽位，否则使用该服务首个非空槽位；不支持请求失败后自动切换。
 * loadKeyConfig / resolveSelectedKey 的返回值含机密，仅供启动器在内存中使用。
 * CLI 与配置操作的返回值只报告是否已配置，不显示密钥及其任何片段。
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLOT_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'primary', label: '主用', provider: 'deepseek-official' }),
  Object.freeze({ id: 'backup1', label: '备用一', provider: 'opencode-go' }),
  Object.freeze({ id: 'backup2', label: '备用二', provider: 'deepseek-official' }),
]);
const PROVIDER_ENVIRONMENTS = Object.freeze({
  'deepseek-official': 'DEEPSEEK_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY',
});

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidConfig() {
  return safeError('INVALID_KEY_CONFIG', '密钥配置格式无效，请检查版本、槽位和当前选择。');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields) {
  return isRecord(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function validKey(value) {
  return typeof value === 'string' && (value === '' || /^[\x21-\x7e]+$/.test(value));
}

function validateConfig(value) {
  if (!exactFields(value, ['version', 'active', 'slots']) || ![1, 2].includes(value.version)
    || typeof value.active !== 'string' || !Array.isArray(value.slots)
    || value.slots.length !== SLOT_DEFINITIONS.length) throw invalidConfig();
  const byId = new Map();
  for (const slot of value.slots) {
    const fields = value.version === 1 ? ['id', 'label', 'key'] : ['id', 'label', 'provider', 'key'];
    if (!exactFields(slot, fields) || typeof slot.id !== 'string'
      || byId.has(slot.id) || !validKey(slot.key)) throw invalidConfig();
    const definition = SLOT_DEFINITIONS.find(item => item.id === slot.id);
    if (definition === undefined || slot.label !== definition.label) throw invalidConfig();
    // Version 1 only supported DeepSeek. Never infer an old key's provider from a new slot default.
    const provider = value.version === 1 ? 'deepseek-official' : slot.provider;
    if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_ENVIRONMENTS, provider)) throw invalidConfig();
    byId.set(slot.id, { ...definition, provider, key: slot.key });
  }
  if (!byId.has(value.active)) throw invalidConfig();
  return { version: 2, active: value.active, slots: SLOT_DEFINITIONS.map(slot => byId.get(slot.id)) };
}

function slotId(value) {
  const definition = SLOT_DEFINITIONS.find(slot => slot.id === value || slot.label === value);
  if (definition === undefined) {
    throw safeError('INVALID_KEY_SLOT', '请选择 primary、backup1 或 backup2 槽位。');
  }
  return definition.id;
}

function summary(config) {
  return {
    version: config.version,
    active: config.active,
    slots: config.slots.map(({ id, label, provider, key }) => ({ id, label, provider, configured: key !== '' })),
  };
}

async function packagePaths(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw safeError('KEY_CONFIG_IO', '无法访问包内密钥配置目录。');
  }
  const directory = join(resolve(root), 'portable');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid directory');
  } catch {
    throw safeError('KEY_CONFIG_IO', '无法访问包内密钥配置目录。');
  }
  return { directory, config: join(directory, 'keys.json'), example: join(directory, 'keys.example.json') };
}

async function readConfig(filename) {
  let content;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw safeError('KEY_CONFIG_IO', '密钥配置必须是包内普通文件。');
    }
    content = await readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'KEY_CONFIG_IO') throw error;
    throw safeError('KEY_CONFIG_IO', '无法读取包内密钥配置文件。');
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // JSON parser diagnostics can quote the input, which may contain a secret.
    throw invalidConfig();
  }
  return { config: validateConfig(parsed), migrated: parsed.version === 1 };
}

async function writeConfig(paths, config) {
  const temporary = join(paths.directory, `.keys-write-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, paths.config);
    await chmod(paths.config, 0o600);
  } catch {
    throw safeError('KEY_CONFIG_IO', '无法保存包内密钥配置文件。');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** 读取配置；首次克隆空模板，v1 以全部 DeepSeek 服务迁移为 v2。返回值含机密。 */
export async function loadKeyConfig(root) {
  const paths = await packagePaths(root);
  const existing = await readConfig(paths.config);
  if (existing !== null) {
    if (existing.migrated) await writeConfig(paths, existing.config);
    return existing.config;
  }
  const example = await readConfig(paths.example);
  if (example === null) {
    throw safeError('KEY_CONFIG_IO', '包内缺少 keys.example.json 模板。');
  }
  // A shipped template may never provision secrets; only the runtime file may hold them.
  if (example.config.slots.some(slot => slot.key !== '')) {
    throw safeError('INVALID_KEY_CONFIG', '密钥模板必须保留三个空槽位。');
  }
  await writeConfig(paths, example.config);
  return example.config;
}

/** 返回当前槽位及其服务的副本；当前槽位为空时返回 null。不会跨服务选择其他槽位。 */
export function resolveSelectedKey(config) {
  const validated = validateConfig(config);
  const selected = validated.slots.find(slot => slot.id === validated.active);
  return selected.key === '' ? null : { ...selected };
}

/** 每服务注入一个已配置密钥；当前槽位在其服务内优先。不要打印或记录返回值。 */
export function keyLaunchEnvironment(config) {
  const validated = validateConfig(config);
  const selected = validated.slots.find(slot => slot.id === validated.active);
  const environment = {};
  for (const [provider, variable] of Object.entries(PROVIDER_ENVIRONMENTS)) {
    const preferred = selected.provider === provider && selected.key !== '' ? selected
      : validated.slots.find(slot => slot.provider === provider && slot.key !== '');
    if (preferred !== undefined) environment[variable] = preferred.key;
  }
  return environment;
}

/** 保存指定槽位；空值清除密钥。返回仅包含 configured 布尔的概要。 */
export async function configureKey(root, slot, value) {
  const id = slotId(slot);
  if (typeof value !== 'string') {
    throw safeError('INVALID_KEY_VALUE', '密钥必须是文本，留空可清除。');
  }
  const key = value.trim();
  if (!validKey(key)) {
    throw safeError('INVALID_KEY_VALUE', '密钥不能包含空白或非 ASCII 字符。');
  }
  const config = await loadKeyConfig(root);
  config.slots.find(item => item.id === id).key = key;
  await writeConfig(await packagePaths(root), config);
  return summary(config);
}

/** 关联密钥服务；更换服务时清空原密钥，避免向另一个服务发送旧密钥。 */
export async function configureProvider(root, slot, provider) {
  const id = slotId(slot);
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_ENVIRONMENTS, provider)) {
    throw safeError('INVALID_KEY_PROVIDER', '服务必须是 deepseek-official 或 opencode-go。');
  }
  const config = await loadKeyConfig(root);
  const selected = config.slots.find(item => item.id === id);
  if (selected.provider !== provider) {
    selected.provider = provider;
    selected.key = '';
    await writeConfig(await packagePaths(root), config);
  }
  return summary(config);
}

/** 手动选择默认模型服务的槽位；允许选择空槽位，密钥环境仍按各服务分别解析。 */
export async function selectKey(root, slot) {
  const id = slotId(slot);
  const config = await loadKeyConfig(root);
  config.active = id;
  await writeConfig(await packagePaths(root), config);
  return summary(config);
}

async function readStdin() {
  let text = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    throw safeError('KEY_CONFIG_IO', '无法读取密钥输入。');
  }
  return text;
}

async function cli(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, slot] = args;
  let result;
  if (command === 'status' && args.length === 1) result = summary(await loadKeyConfig(root));
  else if (command === 'select' && args.length === 2) result = await selectKey(root, slot);
  else if (command === 'set' && args.length === 2) result = await configureKey(root, slot, await readStdin());
  else if (command === 'provider' && args.length === 3) result = await configureProvider(root, slot, args[2]);
  else {
    throw safeError('KEY_CLI_USAGE', '用法：keys.mjs status | select <槽位> | provider <槽位> <服务> | set <槽位>（密钥仅从标准输入读取）。');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch(error => {
    const message = ['INVALID_KEY_CONFIG', 'INVALID_KEY_SLOT', 'INVALID_KEY_VALUE', 'INVALID_KEY_PROVIDER', 'KEY_CONFIG_IO', 'KEY_CLI_USAGE'].includes(error?.code)
      ? error.message : '密钥配置操作失败。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
