import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test the shipped projector with a connection module that cannot read private
// state or make network calls. The portable template receives its real module
// only when a distribution is built.
const directory = await mkdtemp(join(tmpdir(), 'dsh-project-run-test-'));
after(() => rm(directory, { recursive: true, force: true }));
await copyFile(new URL('./core.mjs', import.meta.url), join(directory, 'core.mjs'));
await writeFile(join(directory, 'connection.mjs'), `
  export const stateDirectory = 'unused-in-projection-tests';
  const denied = () => { throw new Error('Projection tests must not perform I/O'); };
  export const connection = denied, rpc = denied, readJson = denied, saveJson = denied;
`);
const { projectRun } = await import(pathToFileURL(join(directory, 'core.mjs')).href);

const run = {
  runId: 'a'.repeat(64), requestId: 'request-current', sessionId: 'session-fixture',
  baseUrl: 'http://127.0.0.1:19387', workspace: 'C:\\fixture', title: 'fixture',
  permission: 'read-only', createdAt: new Date().toISOString(), baselineSeq: -1,
  cancelRequested: false,
};
const event = (seq, type, data = {}) => ({ seq, type, data });
const message = requestId => ({ id: `message-${requestId}`, content: [{ type: 'text', text: requestId }],
  source: { kind: 'user', rpcId: requestId } });
const inbox = (seq, requestId, start = 0) => event(seq, 'agent/inbox/spliced', {
  target: 'next-turn', start, inserted: [message(requestId)],
});
const turnStart = (seq, turn = 1) => event(seq, 'turn/start', { turn });
const turnEnd = (seq, turn = 1, kind = 'completed') => event(seq, 'turn/end', {
  turn, reason: kind === 'error' ? { kind, error: { code: 'INVALID_ARGUMENT',
    message: 'Unsupported reasoningEffort: fixture-only' } } : { kind },
});
const assistant = (seq, text, turn = 1) => event(seq, 'assistant/message', {
  turn, step: 1, message: { content: [{ type: 'text', text }] },
});
const project = (events, overrides = {}, running = false) => projectRun({ ...run, ...overrides }, events, {}, running);

test('preparation rejection before user/message is a terminal failure', () => {
  const result = project([
    inbox(0, run.requestId), turnStart(1), event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'step/end', { turn: 1, step: 1 }), turnEnd(4, 1, 'error'),
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.terminal, true);
  assert.equal(result.error, 'Unsupported reasoningEffort: fixture-only');
  assert.equal(result.assistantText, '');
});

test('inbox admission alone stays queued until this input starts a turn', () => {
  const result = project([inbox(0, run.requestId)], {}, true);
  assert.equal(result.status, 'queued');
  assert.equal(result.terminal, false);
});

test('ordinary user/message completion keeps its final text', () => {
  const result = project([
    inbox(0, run.requestId), turnStart(1), event(2, 'user/message', message(run.requestId)),
    assistant(3, 'fixture answer'), turnEnd(4),
  ]);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.terminal, true);
  assert.equal(result.assistantText, 'fixture answer');
});

test('a foreign receipt and failed turn cannot settle this request', () => {
  const result = project([inbox(0, 'foreign'), turnStart(1), turnEnd(2, 1, 'error')]);
  assert.equal(result.status, 'queued');
  assert.equal(result.terminal, false);
  assert.equal(result.error, null);
});

test('queuing during an older turn does not adopt its ending or output', () => {
  const result = project([
    turnStart(0, 1), inbox(1, run.requestId), assistant(2, 'older answer', 1), turnEnd(3, 1),
    turnStart(4, 2), turnEnd(5, 2, 'error'),
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.terminal, true);
  assert.equal(result.assistantText, '');
});

test('a foreign queue head must be claimed before this request owns a turn', () => {
  const result = project([
    inbox(0, 'foreign'), inbox(1, run.requestId, 1), turnStart(2, 1),
    event(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    assistant(4, 'foreign answer', 1), turnEnd(5, 1), turnStart(6, 2), turnEnd(7, 2, 'error'),
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.terminal, true);
  assert.equal(result.assistantText, '');
});

test('replacing the queue head after turn/start cannot adopt the foreign failure', () => {
  const result = project([
    inbox(0, run.requestId), turnStart(1),
    event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1,
      inserted: [message('foreign')], outcome: 'canceled' }),
    event(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    event(4, 'step/start', { turn: 1, step: 1 }), turnEnd(5, 1, 'error'),
  ]);
  assert.equal(result.status, 'queued');
  assert.equal(result.terminal, false);
  assert.equal(result.error, null);
});

test('an unknown queue head from before the baseline is not this request', () => {
  const result = project([inbox(21, run.requestId, 1), turnStart(22, 4), turnEnd(23, 4, 'error')],
    { baselineSeq: 20 });
  assert.equal(result.status, 'queued');
  assert.equal(result.terminal, false);
});

test('a foreign user message bounds output and prevents adopting its ending', () => {
  const result = project([
    inbox(0, run.requestId), turnStart(1), event(2, 'user/message', message('foreign')),
    assistant(3, 'foreign answer'), turnEnd(4, 1, 'error'),
  ]);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.terminal, false);
  assert.equal(result.foreignInput, true);
  assert.equal(result.assistantText, '');
});

test('a different turn number cannot terminate the owned turn', () => {
  const result = project([inbox(0, run.requestId), turnStart(1, 2), turnEnd(2, 1, 'error')]);
  assert.equal(result.status, 'running');
  assert.equal(result.terminal, false);
});

test('a later turn cannot provide output or an ending for an unclosed turn', () => {
  const result = project([
    inbox(0, run.requestId), turnStart(1, 1), turnStart(2, 2),
    assistant(3, 'foreign answer', 2), turnEnd(4, 2, 'error'),
  ]);
  assert.equal(result.terminal, false);
  assert.equal(result.assistantText, '');
  assert.equal(result.error, null);
});

test('reply baseline excludes the previous request and previous early error', () => {
  const result = project([
    inbox(0, 'request-parent'), turnStart(1, 1), turnEnd(2, 1, 'error'),
    inbox(10, run.requestId), turnStart(11, 2), turnEnd(12, 2, 'error'),
  ], { baselineSeq: 9 });
  assert.equal(result.status, 'failed');
  assert.equal(result.terminal, true);
  assert.equal(result.foreignInput, false);
  assert.equal(result.lastEventSeq, 12);
});

test('a previous reply completion alone cannot settle a new reply', () => {
  const result = project([
    inbox(0, 'request-parent'), turnStart(1, 1),
    event(2, 'user/message', message('request-parent')), assistant(3, 'previous answer'), turnEnd(4),
    inbox(10, run.requestId),
  ], { baselineSeq: 9 });
  assert.equal(result.status, 'queued');
  assert.equal(result.terminal, false);
  assert.equal(result.assistantText, '');
});
