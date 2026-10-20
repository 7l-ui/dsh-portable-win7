import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareProviders, selectedModel } from './providers.mjs';

const config = active => ({ version: 2, active, slots: [
  { id: 'primary', provider: 'deepseek-official', key: 'fixture-ds-key' },
  { id: 'backup1', provider: 'opencode-go', key: 'fixture-go-key' },
] });
test('不同服务选择各自默认模型，生成配置不包含密钥且保留原生Go适配器', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-unit-'));
  try {
    await mkdir(join(root, 'portable'));
    await copyFile(new URL('./providers.json', import.meta.url), join(root, 'portable/providers.json'));
    assert.equal((await selectedModel(root, config('primary'))).defaultModel.provider, 'deepseek-official');
    assert.equal((await selectedModel(root, config('backup1'))).defaultModel.provider, 'opencode-go');
    const generated = await prepareProviders(root, config('primary'));
    const text = await readFile(generated.patch, 'utf8');
    assert.equal(text.includes('fixture-ds-key'), false);
    assert.equal(text.includes('fixture-go-key'), false);
    const go = JSON.parse(text)[0].config.providers['opencode-go'];
    assert.equal(go.api, undefined);
    assert.equal(go.apiKeyEnv, 'OPENCODE_GO_API_KEY');
    assert.equal(go.baseURL, 'https://opencode.ai/zen/go/v1');
    const invalid = JSON.parse(await readFile(join(root, 'portable/providers.json'), 'utf8'));
    invalid.opencodeGo.baseURL = 'https://other.example/v1';
    await writeFile(join(root, 'portable/providers.json'), JSON.stringify(invalid));
    await assert.rejects(prepareProviders(root, config('primary')), /拒绝/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
