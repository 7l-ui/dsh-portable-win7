import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const launcher = await import(pathToFileURL(join(root, 'portable/launcher.mjs')).href);
assert.equal((await launcher.statusPackage(root)).status, 'stopped');
const { Client } = await import(pathToFileURL(join(root, 'bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(root, 'bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
const transport = new StdioClientTransport({
  command: join(root, 'runtime/node/node.exe'), args: [join(root, 'portable/mcp.mjs')], stderr: 'pipe',
});
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'portable-verification', version: '1.0.0' });
let instance;
try {
  const began = Date.now();
  await client.connect(transport);
  const initializedMs = Date.now() - began;
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'dsh_health'));
  assert.ok(catalog.tools.some(tool => tool.name === 'dsh_start'));
  const result = await client.callTool({ name: 'dsh_health', arguments: {} });
  assert.notEqual(result.isError, true);
  const health = JSON.parse(result.content[0].text);
  assert.equal(health.connected, true);
  const state = await launcher.statusPackage(root);
  assert.equal(state.status, 'running');
  instance = state.instanceId;
  assert.equal(new URL(health.baseUrl).origin, new URL(state.baseUrl).origin);
  const paired = await client.callTool({ name: 'dsh_connect', arguments: {} });
  assert.notEqual(paired.isError, true);
  assert.equal(JSON.parse(paired.content[0].text).connected, true);
  await client.close();
  assert.equal((await launcher.statusPackage(root)).status, 'running');
  const report = { passed: true, actualSdk: true, initializedMs, toolCount: catalog.tools.length,
    currentPackageHealth: true, reconnectCurrentPackage: true, mcpCloseKeepsDshRunning: true,
    modelRequestsMade: false, checkedAt: new Date().toISOString() };
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(root, 'logs/mcp-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await client.close().catch(() => {});
  const state = await launcher.statusPackage(root);
  if (state.status === 'running' && (!instance || instance === state.instanceId)) await launcher.stopPackage(root);
}
