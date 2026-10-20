import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadKeyConfig } from './keys.mjs';
import { selectedModel } from './providers.mjs';

async function invoke(baseUrl, cookie, method, args = {}) {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', origin: baseUrl, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`便携初始化请求失败：${method} HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.rpcId !== rpcId || !envelope.result?.ok) {
    throw new Error(`便携初始化失败：${method} ${envelope.result?.error?.code ?? 'RPC_ERROR'}`);
  }
  return envelope.result.value;
}

/** 初始化包内工作区与首次设置，保留用户已有模型选择。 */
export async function bootstrapPortable(root, { baseUrl, authenticatedUrl, launchLog }) {
  await mkdir(join(root, 'workspace'), { recursive: true });
  const login = await fetch(authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie || ![200, 302, 303].includes(login.status)) throw new Error('便携实例登录交换失败。');
  const created = await invoke(baseUrl, cookie, 'workspace/create', { request: { path: join(root, 'workspace') } });
  const configuration = JSON.parse(await readFile(join(root, 'portable', 'config.json'), 'utf8'));
  const selection = await selectedModel(root, await loadKeyConfig(root));
  let lastSelection;
  try { lastSelection = JSON.parse(await readFile(join(root, 'data/runtime/provider-selection.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = await invoke(baseUrl, cookie, 'settings/describe');
  const prior = settings.namespaces.find(item => item.ns === 'agent-default-model');
  const hasUserModel = prior?.user && Object.keys(prior.user).length > 0;
  const providerChanged = lastSelection
    ? lastSelection.provider !== selection.provider
    : prior?.value?.provider !== selection.provider;
  if (prior && (!hasUserModel || providerChanged)) {
    await invoke(baseUrl, cookie, 'settings/replace', { ns: 'agent-default-model', section: selection.defaultModel ?? configuration.defaultModel });
  }
  await writeFile(join(root, 'data/runtime/provider-selection.json'), `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
  const notice = settings.namespaces.find(item => item.ns === 'ui-settings-general');
  if (notice?.value?.welcomeNoticeVersion !== '2026-09-28.1') {
    await invoke(baseUrl, cookie, 'settings/update', {
      ns: 'ui-settings-general', patch: { welcomeNoticeVersion: '2026-09-28.1' },
    });
  }
  const state = {
    version: 1, packageRoot: root, workspaceId: created.workspace.workspaceId,
    workspace: join(root, 'workspace'), preparedAt: new Date().toISOString(),
  };
  const target = join(root, 'data', 'runtime', 'workspace.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return { workspaceId: state.workspaceId, workspace: state.workspace };
}
