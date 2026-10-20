import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function selectedModel(root, keyConfig) {
  const config = JSON.parse(await readFile(join(root, 'portable/providers.json'), 'utf8'));
  const slot = keyConfig.slots.find(item => item.id === keyConfig.active);
  const provider = slot.provider ?? 'deepseek-official';
  const defaultModel = config.defaultModels?.[provider];
  if (config.version !== 1 || !defaultModel || defaultModel.provider !== provider || !defaultModel.model) {
    throw new Error('包内提供方配置无效。');
  }
  return { active: keyConfig.active, provider, defaultModel };
}

/** 生成只含路由元数据的运行配置；密钥仅通过对应服务的环境变量传递。 */
export async function prepareProviders(root, keyConfig) {
  const config = JSON.parse(await readFile(join(root, 'portable/providers.json'), 'utf8'));
  const selected = await selectedModel(root, keyConfig);
  const go = config.opencodeGo;
  const url = new URL(go.baseURL);
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || url.username || url.password || url.search || url.hash
    || go.apiKeyEnv !== 'OPENCODE_GO_API_KEY' || go.api !== undefined || !Array.isArray(go.models) || !go.models.length) {
    throw new Error('OpenCode Go 路由配置无效，拒绝向其他服务发送凭据。');
  }
  const patch = [{ id: 'llm-pi-ai', config: { providers: { 'opencode-go': go } } }];
  const target = join(root, 'data/runtime/providers.patch.yml');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(root, 'data/runtime'), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return { ...selected, patch: target };
}
