import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectPortable } from './portable-connect.mjs';
import * as bridge from './core.mjs';

export async function startPortableServer({ ready = Promise.resolve() } = {}) {
const server = new McpServer({ name: 'dsh', version: '0.1.0' }, {
  instructions: '通过这些工具把子任务委派给当前便携包内的 DeepSeek Harness。MCP 自动启动并配对本包；不会连接其它桌面实例。先 dsh_health；dsh_start 创建独立可见会话，返回 runId；反复 dsh_wait 直到 terminal=true，读取 assistantText 并核验；dsh_reply 继续同一会话；dsh_cancel 停止。默认只读，修改文件需任务授权并使用 workspace-write。每条任务使用稳定的 idempotencyKey。不要把 queued/running 或等待超时当作完成；completed_without_final_text 表示模型没有输出正文，不得把思考当答案。可用 dsh_list 恢复委派任务。工具不关闭、不重启 DSH，也不修改它的默认模型。',
});

const runId = z.string().regex(/^[a-f0-9]{64}$/).describe('dsh_start 或 dsh_reply 返回的 runId');
const task = z.string().trim().min(1).max(100000).describe('明确的子任务、授权范围、文件路径和验收条件。让 DSH 自行读取工作区文件，避免复制整份代码和对话。');
const idempotencyKey = z.string().trim().min(1).max(128).describe('该任务的唯一稳定键；同一请求重试沿用原键，新任务换键。');
const readOnly = { readOnlyHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
function register(name, description, inputSchema, fn, annotations = readOnly) {
  server.registerTool(name, { description, inputSchema, annotations }, async input => {
    try {
      await ready;
      const result = await fn(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message || 'DSH 工具调用失败' }] };
    }
  });
}

register('dsh_health', '检查本便携包 DSH 连接和权限。不会运行模型或读 API 密钥。连接失效时重新加载本便携 MCP，或调用 dsh_connect 重配本包。', {}, bridge.health);
register('dsh_connect', '重新配对当前便携包 DSH，默认使用本包启动日志。拒绝其他实例地址或日志；凭据只存本包 data/bridge，不返回密钥。', {
  baseUrl: z.string().url().optional().describe('可省略；若提供，只允许当前便携包的本机服务地址'),
  launchLog: z.string().optional().describe('可省略；若提供，必须是当前便携包启动日志的绝对路径'),
}, connectPortable, mutation);
register('dsh_capabilities', '查询 DSH 已配置的模型与权限。新任务继承 defaultModel；在 DSH 中选择模型后再开始委派。', {}, bridge.capabilities);
register('dsh_start', '后台把子任务交给 DSH，创建属于指定工作区的新会话。返回 runId 后必须调用 dsh_wait 获取结果。无需打开浏览器。默认 read-only；授权改文件时选 workspace-write。', {
  workspace: z.string().min(1).describe('当前任务授权的已存在工作区绝对路径'), task, idempotencyKey,
  title: z.string().trim().min(1).max(100).optional().describe('桌面版中显示的会话标题，例如 Codex 委派 · 检查登录功能'),
  permission: z.enum(['read-only', 'workspace-write']).default('read-only'),
}, bridge.start, mutation);
register('dsh_status', '查看一个委派任务的进度与结果。assistantText 仅含正文；不会混入模型思考。terminal 才代表已结束。', { runId }, input => bridge.status(input.runId));
register('dsh_wait', '等待 DSH 最多 30 秒。返回 queued/running 时应继续调用；结束后消费 assistantText 并核验结果。needs_attention 时去 DSH 处理提问/审批。', {
  runId, timeoutMs: z.number().int().min(0).max(30000).default(25000),
}, input => bridge.wait(input.runId, input.timeoutMs));
register('dsh_reply', '任务结束后，在同一 DSH 会话中追问或继续任务。返回新的 runId，继续 dsh_wait。继承原权限；更换授权范围时应新建任务。', {
  runId, task, idempotencyKey,
}, bridge.reply, mutation);
register('dsh_cancel', '取消这个委派任务当前的运行，或删除它尚未运行的排队消息。仅作用于桥接创建的会话；不关闭 DSH。', { runId }, input => bridge.cancel(input.runId), { ...mutation, destructiveHint: true });
register('dsh_list', '列出最近 50 条通过本工具委派的任务，恢复 runId。不会列出用户其它私人会话。', {}, bridge.listRuns);

await server.connect(new StdioServerTransport());
return server;
}
