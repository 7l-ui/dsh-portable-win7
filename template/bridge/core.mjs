import { randomUUID, createHash } from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';
import { open, unlink, stat, readdir } from 'node:fs/promises';
import { connection, rpc, readJson, saveJson, stateDirectory } from './connection.mjs';

const runsDirectory = join(stateDirectory, 'runs');
const digest = value => createHash('sha256').update(value).digest('hex');
const runFile = id => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效 runId。请使用 dsh_start 或 dsh_reply 返回的 runId。');
  return join(runsDirectory, `${id}.json`);
};
async function loadRun(id) {
  const run = await readJson(runFile(id), null);
  if (!run) throw new Error('找不到这个委派任务。');
  const current = await connection();
  if (current.baseUrl !== run.baseUrl) throw new Error('此任务属于另一 DSH 实例，请先连接原实例。');
  return run;
}

// Different MCP processes share identities. Serialize only task admission and
// cancellation, never a model's entire run. A crashed owner's lock is recoverable.
async function locked(action) {
  await saveJson(join(stateDirectory, 'bridge-version.json'), { version: '0.1.0' });
  const path = join(stateDirectory, 'admission.lock');
  let file;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { file = await open(path, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path, null).catch(() => null);
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); }
        catch (check) { if (check.code === 'ESRCH') { await unlink(path).catch(() => {}); continue; } }
      }
      await new Promise(done => setTimeout(done, 100));
    }
  }
  if (!file) throw new Error('另一 Codex 正在提交 DSH 任务，请稍后用相同 idempotencyKey 重试。');
  await file.writeFile(JSON.stringify({ pid: process.pid }));
  try { return await action(); }
  finally { await file.close(); await unlink(path).catch(() => {}); }
}

export async function health() {
  const saved = await connection();
  const [plugins, catalog] = await Promise.all([
    rpc('pluginManager/listPlugins'), rpc('permissionPresets/catalog'),
  ]);
  return { connected: true, bridgeVersion: '0.1.0', baseUrl: saved.baseUrl,
    activePluginCount: plugins.filter(item => item.fiberPhase === 'active').length,
    permissions: catalog.options.map(item => item.value),
    modelPolicy: '继承 DSH 当前默认模型；不修改模型默认设置',
    workflow: 'dsh_start -> 重复 dsh_wait 直至终态 -> 读取 assistantText -> 按需 dsh_reply',
  };
}

export async function capabilities() {
  const catalog = await rpc('session/modelCatalog');
  return { defaultModel: catalog.default, routableProviders: catalog.routableProviders,
    providers: catalog.groups, permissionPresets: (await rpc('permissionPresets/catalog')).options };
}

async function setPermission(sessionId, preset) {
  const result = await rpc('commands/execute', { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] });
  if (result?.result?.kind !== 'success') throw new Error(`DSH 拒绝权限 ${preset}，未提交任务。`);
  const projections = await rpc('session/projections', { request: { sessionId } });
  if (projections?.values?.permissions?.currentValue !== preset) throw new Error('权限确认失败，未提交任务。');
}

export async function start(input) {
  if (!isAbsolute(input.workspace)) throw new Error('workspace 必须是当前任务授权的绝对目录。');
  const workspace = resolve(input.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作区必须是已存在的目录。');
  if (!input.idempotencyKey?.trim()) throw new Error('请提供稳定的 idempotencyKey，重试时沿用原值。');
  const saved = await connection();
  const runId = digest(`${saved.baseUrl}\n${workspace.toLowerCase()}\n${input.idempotencyKey}`);
  const permission = input.permission || 'read-only';
  return locked(async () => {
    let run = await readJson(runFile(runId), null);
    const taskHash = digest(`${input.task}\n${permission}`);
    if (run && run.taskHash !== taskHash) throw new Error('相同 idempotencyKey 已用于不同任务，请换一个新键。');
    if (!run) {
      run = { runId, baseUrl: saved.baseUrl, workspace, requestId: randomUUID(), sessionId: `session-${randomUUID()}`,
        taskHash, permission, title: input.title || 'Codex 委派', createdAt: new Date().toISOString(), baselineSeq: -1,
        admission: 'prepared', cancelRequested: false };
      await saveJson(runFile(runId), run);
    }
    if (run.admission === 'accepted') return status(runId);
    const created = await rpc('workspace/create', { request: { path: workspace } });
    await rpc('session/create', { request: { workspaceId: created.workspace.workspaceId, sessionId: run.sessionId } });
    await rpc('session/rename', { request: { sessionId: run.sessionId, title: run.title } });
    await setPermission(run.sessionId, permission);
    if (run.admission === 'prepared') {
      const projection = await rpc('session/projections', { request: { sessionId: run.sessionId } });
      run.baselineSeq = projection?.asOfSeq ?? -1;
      run.admission = 'submitting';
      await saveJson(runFile(runId), run);
    }
    // DSH deduplicates this persisted requestId in both inbox and history.
    await rpc('session/prompt', { request: { requestId: run.requestId, sessionId: run.sessionId, mode: 'queue',
      content: [{ type: 'text', text: input.task }], clientTimeZone: 'Asia/Shanghai' } });
    run.admission = 'accepted';
    await saveJson(runFile(runId), run);
    return status(runId);
  });
}

function rpcId(event) { return event.type === 'user/message' ? event.data?.source?.rpcId : undefined; }
function contentOf(event) { return event.data?.message?.content ?? event.data?.content ?? []; }

// Request preparation may fail before user/message is committed. The durable
// inbox receipt still identifies the queued input, but only the queue head can
// own the next turn; an insertion during an older turn does not own that turn.
function queuedTurnStart(run, events) {
  const pending = [];
  let openTurn;
  let candidate;
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn') {
      const { start, removedCount = 0, inserted = [], outcome } = event.data;
      if (!Number.isSafeInteger(start) || start < 0 || !Array.isArray(inserted)) return;
      // A reply's baseline may omit already-pending inputs. Preserve their
      // unknown identities instead of treating our appended input as first.
      while (pending.length < start) pending.push(undefined);
      const removed = pending.splice(start, removedCount, ...inserted);
      if (openTurn && start === 0 && removed.length === 1 && inserted.length === 0 && outcome !== 'canceled'
        && removed[0]?.source?.kind === 'user' && removed[0].source.rpcId === run.requestId) return openTurn;
      // A turn/start listener can replace or cancel the head before claim.
      // Older Hosts omit claim splices, so accept their boundary only while
      // no intervening queue edit contradicts ownership.
      if (candidate && pending[0]?.source?.rpcId !== run.requestId) candidate = undefined;
    } else if (event.type === 'turn/start') {
      if (candidate) return candidate;
      openTurn = event;
      if (pending[0]?.source?.kind === 'user' && pending[0].source.rpcId === run.requestId) candidate = event;
    } else if (candidate && (event.type === 'step/start' || event.type === 'turn/end')
      && event.data?.turn === candidate.data?.turn) {
      return candidate;
    } else if (event.type === 'turn/end' && event.data?.turn === openTurn?.data?.turn) {
      openTurn = undefined;
    }
  }
  return candidate;
}

export function projectRun(run, events, projections, running) {
  events = events.filter(event => event.seq > run.baselineSeq);
  const prompt = events.find(event => rpcId(event) === run.requestId) || queuedTurnStart(run, events);
  const turn = prompt && (prompt.type === 'turn/start' ? prompt : events.findLast(event =>
    event.seq < prompt.seq && event.type === 'turn/start'))?.data?.turn;
  let owned = [];
  let foreign;
  if (prompt) {
    foreign = events.find(event => event.seq > prompt.seq && rpcId(event) && rpcId(event) !== run.requestId);
    const nextTurn = events.find(event => event.seq > prompt.seq && event.type === 'turn/start');
    owned = events.filter(event => event.seq > prompt.seq && (!foreign || event.seq < foreign.seq)
      && (!nextTurn || event.seq < nextTurn.seq));
  }
  const end = owned.find(event => event.type === 'turn/end' && (turn === undefined || event.data?.turn === turn));
  const settled = owned.filter(event => !end || event.seq <= end.seq);
  const messages = settled.filter(event => event.type === 'assistant/message');
  const text = messages.flatMap(event => {
    const content = contentOf(event);
    if (typeof content === 'string') return [content];
    const blocks = content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text);
    return blocks.length ? [blocks.join('\n')] : [];
  }).join('\n\n');
  const reasoningOnly = messages.some(event => Array.isArray(contentOf(event)) && contentOf(event).some(item => item.type === 'reasoning')) && !text;
  const reason = end?.data?.reason;
  let state = prompt ? 'running' : 'queued';
  let error = null;
  if (end) {
    if (reason?.kind === 'completed') state = text ? 'succeeded' : 'completed_without_final_text';
    else if (reason?.kind === 'max-tokens') state = 'incomplete';
    else if (reason?.kind === 'aborted') state = run.cancelRequested || reason.reason?.kind === 'user' ? 'cancelled' : 'failed';
    else state = 'failed';
    if (state === 'failed') error = reason?.error?.message || `DSH turn ended: ${reason?.kind || 'unknown'}`;
    if (messages.at(-1)?.data?.interrupted && state === 'succeeded') state = 'incomplete';
  } else if (run.cancelRequested && !running && !prompt) state = 'cancelled';
  const questions = projections?.values?.userQuestions?.active || [];
  if (!end && foreign) state = 'needs_attention';
  if (!end && (questions.length || Date.now() - Date.parse(run.createdAt) > 300000 && !running)) state = 'needs_attention';
  const bytes = Buffer.from(text, 'utf8');
  let from = Math.max(0, bytes.length - 64000);
  while (from < bytes.length && bytes[from] >>> 6 === 2) from++;
  const url = new URL('/', run.baseUrl); url.searchParams.set('sessionId', run.sessionId);
  return { runId: run.runId, sessionId: run.sessionId, workspace: run.workspace, title: run.title,
    status: state, terminal: !!end || state === 'cancelled', webUrl: url.href, permission: run.permission,
    assistantText: bytes.subarray(from).toString('utf8'), textTruncated: from > 0, reasoningOnly,
    pendingQuestions: questions, foreignInput: !!foreign, error, lastEventSeq: events.at(-1)?.seq ?? run.baselineSeq,
    hint: state === 'completed_without_final_text' ? 'DSH 已结束但没有正文。不要把思考当作答案；检查所选模型/上游兼容性。'
      : !end ? '任务仍未完成；继续 dsh_wait。需要人工批准或答复时在 DSH 处理。' : null };
}

export async function status(runId) {
  const run = await loadRun(runId);
  const [projection, listed] = await Promise.all([
    rpc('session/projections', { request: { sessionId: run.sessionId } }),
    rpc('session/list', { _request: {} }),
  ]);
  const session = listed.items.find(item => item.sessionId === run.sessionId);
  if (!session) throw new Error('DSH 不再列出该会话，请在桌面版检查。');
  const throughSeq = projection?.asOfSeq ?? session.projections?.asOfSeq;
  if (typeof throughSeq !== 'number') throw new Error('会话游标暂不可用，请重试 dsh_status。');
  const events = [];
  let beforeSeq;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: run.sessionId },
      throughSeq, maxMessages: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
    const items = page.records.map(record => record.event).filter(Boolean);
    events.push(...items.filter(event => event.seq > run.baselineSeq));
    const oldest = Math.min(...items.map(event => event.seq));
    if (!page.hasMore || !Number.isFinite(oldest) || oldest <= run.baselineSeq) break;
    if (beforeSeq !== undefined && oldest >= beforeSeq) throw new Error('DSH 历史分页未推进。');
    beforeSeq = oldest;
    if (pageNumber === 19) throw new Error('当前任务历史超过读取上限。结果未被当作成功，请在 DSH 查看完整记录。');
  }
  const sorted = [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
  return projectRun(run, sorted, projection, session.running);
}

export async function wait(runId, timeoutMs = 25000) {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (true) {
    const current = await status(runId);
    if (current.terminal || current.status === 'needs_attention' || Date.now() >= deadline) return current;
    await new Promise(done => setTimeout(done, Math.min(2000, Math.max(1, deadline - Date.now()))));
  }
}

export async function reply(input) {
  return locked(async () => {
    const parent = await loadRun(input.runId);
    const current = await status(input.runId);
    if (!current.terminal) throw new Error('该任务尚未结束，请等待结果；dsh_reply 用于结束后的追问。');
    const runId = digest(`${parent.runId}\n${input.idempotencyKey}`);
    let run = await readJson(runFile(runId), null);
    const taskHash = digest(input.task);
    if (run && run.taskHash !== taskHash) throw new Error('此追问的幂等键已用于另一条消息。');
    if (!run) {
      const listed = await rpc('session/list', { _request: {} });
      if (listed.items.find(item => item.sessionId === parent.sessionId)?.running) throw new Error('会话已在 DSH 中继续运行，请等其结束。');
      const projection = await rpc('session/projections', { request: { sessionId: parent.sessionId } });
      run = { ...parent, runId, requestId: randomUUID(), baselineSeq: projection.asOfSeq, taskHash,
        createdAt: new Date().toISOString(), cancelRequested: false, admission: 'submitting' };
      await saveJson(runFile(runId), run);
    }
    if (run.admission !== 'accepted') {
      await setPermission(run.sessionId, run.permission);
      await rpc('session/prompt', { request: { requestId: run.requestId, sessionId: run.sessionId, mode: 'queue',
        content: [{ type: 'text', text: input.task }], clientTimeZone: 'Asia/Shanghai' } });
      run.admission = 'accepted'; await saveJson(runFile(runId), run);
    }
    return status(runId);
  });
}

export async function cancel(runId) {
  return locked(async () => {
    const run = await loadRun(runId);
    const current = await status(runId);
    if (current.terminal) return current;
    if (current.foreignInput) throw new Error('此会话已收到其它输入，请在 DSH 处理，避免取消其它任务。');
    if (current.status === 'queued') {
      const projection = await rpc('session/projections', { request: { sessionId: run.sessionId } });
      const inbox = projection.values.inbox;
      const queued = [...(inbox?.['next-turn'] || []), ...(inbox?.['next-step'] || [])].find(item => item.source?.rpcId === run.requestId);
      if (!queued) throw new Error('任务正在进入运行阶段，请稍后重新调用 dsh_cancel。');
      await rpc('session/updateQueue', { request: { sessionId: run.sessionId, itemId: queued.id, action: { kind: 'remove' } } });
      run.cancelRequested = true; await saveJson(runFile(runId), run);
      return { ...current, status: 'cancelled', terminal: true, hint: '已移除本任务的排队消息。' };
    }
    run.cancelRequested = true; await saveJson(runFile(runId), run);
    await rpc('session/cancel', { request: { sessionId: run.sessionId } });
    return status(runId);
  });
}

export async function listRuns() {
  const saved = await connection();
  const names = await readdir(runsDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const runs = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readJson(join(runsDirectory, name), null)));
  return runs.filter(run => run?.baseUrl === saved.baseUrl).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50).map(({ runId, sessionId, title, workspace, createdAt }) => ({ runId, sessionId, title, workspace, createdAt }));
}
