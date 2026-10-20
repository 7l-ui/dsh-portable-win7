import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootstrapPortable } from './bootstrap.mjs';

const defaults = {
  'deepseek-official': { provider: 'deepseek-official', model: 'deepseek-flash' },
  'opencode-go': { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
};
const dsPro = { provider: 'deepseek-official', model: 'deepseek-pro' };
const goKimi = { provider: 'opencode-go', model: 'kimi-k2.7-code' };

async function initializeFixture({ active = 'primary', user, value = dsPro, lastSelection }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-test-'));
  const originalFetch = globalThis.fetch;
  const modelWrites = [];
  let effectiveModel = { ...value };
  try {
    await mkdir(join(root, 'portable'));
    await mkdir(join(root, 'data/runtime'), { recursive: true });
    await writeFile(join(root, 'portable/keys.json'), JSON.stringify({
      version: 2, active,
      slots: [
        { id: 'primary', label: '主用', provider: 'deepseek-official', key: '' },
        { id: 'backup1', label: '备用一', provider: 'opencode-go', key: '' },
        { id: 'backup2', label: '备用二', provider: 'deepseek-official', key: '' },
      ],
    }));
    await writeFile(join(root, 'portable/providers.json'), JSON.stringify({ version: 1, defaultModels: defaults }));
    await writeFile(join(root, 'portable/config.json'), JSON.stringify({ defaultModel: defaults['deepseek-official'] }));
    if (lastSelection !== undefined) {
      await writeFile(join(root, 'data/runtime/provider-selection.json'), JSON.stringify(lastSelection));
    }
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:1337');
      if (new URL(url).searchParams.has('token')) {
        return new Response('', { status: 303, headers: { 'set-cookie': 'bootstrap-test=fixture; HttpOnly' } });
      }
      const request = JSON.parse(options.body);
      assert.equal(options.headers.cookie, 'bootstrap-test=fixture');
      let result;
      if (request.method === 'workspace/create') {
        assert.equal(request.payload.args.request.path, join(root, 'workspace'));
        result = { workspace: { workspaceId: 'fixture-workspace' } };
      } else if (request.method === 'settings/describe') {
        result = { namespaces: [
          { ns: 'agent-default-model', user, value: effectiveModel },
          { ns: 'ui-settings-general', value: { welcomeNoticeVersion: '2026-09-28.1' } },
        ] };
      } else if (request.method === 'settings/replace') {
        assert.equal(request.payload.args.ns, 'agent-default-model');
        assert.equal(Object.hasOwn(request.payload.args, 'patch'), false);
        effectiveModel = { ...request.payload.args.section };
        modelWrites.push(request.payload.args.section);
        result = {};
      } else throw new Error('unexpected fixture RPC method');
      return new Response(JSON.stringify({ rpcId: request.rpcId, result: { ok: true, value: result } }), { status: 200 });
    };
    const result = await bootstrapPortable(root, {
      baseUrl: 'http://127.0.0.1:1337/', authenticatedUrl: 'http://127.0.0.1:1337/?token=inert-test-token',
      launchLog: join(root, 'logs/fixture.log'),
    });
    assert.equal(result.workspaceId, 'fixture-workspace');
    const selection = JSON.parse(await readFile(join(root, 'data/runtime/provider-selection.json'), 'utf8'));
    return { modelWrites, selection, effectiveModel };
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-bootstrap-test-')));
    await rm(root, { recursive: true, force: true });
  }
}

test('没有已存用户模型时，首次启动初始化当前服务的默认模型', async () => {
  for (const user of [undefined, {}]) {
    const result = await initializeFixture({ active: 'backup1', user, value: dsPro });
    assert.deepEqual(result.modelWrites, [defaults['opencode-go']]);
    assert.equal(result.selection.provider, 'opencode-go');
  }
});

test('已有选择记录时，同服务换密钥槽或保留UI手动服务选择都不覆盖模型', async () => {
  const lastSelection = { active: 'primary', provider: 'deepseek-official' };
  const sameServiceKeyChange = await initializeFixture({ active: 'backup2', user: dsPro, value: dsPro, lastSelection });
  assert.deepEqual(sameServiceKeyChange.modelWrites, []);
  assert.equal(sameServiceKeyChange.selection.active, 'backup2');
  const manualUiSelection = await initializeFixture({ active: 'primary', user: goKimi, value: goKimi, lastSelection });
  assert.deepEqual(manualUiSelection.modelWrites, []);
});

test('已有选择记录时，跨服务切换分别设置新服务的默认模型', async () => {
  const toGo = await initializeFixture({ active: 'backup1', user: dsPro, value: dsPro,
    lastSelection: { active: 'primary', provider: 'deepseek-official' } });
  assert.deepEqual(toGo.modelWrites, [defaults['opencode-go']]);
  const toDs = await initializeFixture({ active: 'primary', user: goKimi, value: goKimi,
    lastSelection: { active: 'backup1', provider: 'opencode-go' } });
  assert.deepEqual(toDs.modelWrites, [defaults['deepseek-official']]);
});

test('跨服务切换替换完整模型设置，不把 DeepSeek 的 off 推理参数保留给 Go', async () => {
  const oldModel = { ...dsPro, reasoningEffort: 'off' };
  const result = await initializeFixture({ active: 'backup1', user: oldModel, value: oldModel,
    lastSelection: { active: 'primary', provider: 'deepseek-official' } });
  assert.deepEqual(result.modelWrites, [defaults['opencode-go']]);
  assert.deepEqual(result.effectiveModel, defaults['opencode-go']);
  assert.equal(Object.hasOwn(result.effectiveModel, 'reasoningEffort'), false);
  const unchanged = await initializeFixture({ active: 'backup2', user: oldModel, value: oldModel,
    lastSelection: { active: 'primary', provider: 'deepseek-official' } });
  assert.deepEqual(unchanged.modelWrites, []);
  assert.deepEqual(unchanged.effectiveModel, oldModel);
});

test('没有选择记录的旧配置保留同服务模型，仅在有效服务不同时重设', async () => {
  const sameProvider = await initializeFixture({ active: 'primary', user: { model: 'deepseek-pro' }, value: dsPro });
  assert.deepEqual(sameProvider.modelWrites, []);
  const newGoProvider = await initializeFixture({ active: 'backup1', user: { model: 'deepseek-pro' }, value: dsPro });
  assert.deepEqual(newGoProvider.modelWrites, [defaults['opencode-go']]);
});
