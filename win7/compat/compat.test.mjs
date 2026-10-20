import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import util, { getSystemErrorMessage, getSystemErrorName, inspect } from './util-compat.mjs';

const require = createRequire(import.meta.url);
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));

test('Set composition preserves ordering, inputs, and set-like operand validation', () => {
  const first = new Set(['utf8', 'ascii']);
  const second = new Set(['ascii', 'base64']);
  assert.deepEqual([...first.union(second)], ['utf8', 'ascii', 'base64']);
  assert.deepEqual([...first.intersection(second)], ['ascii']);
  assert.deepEqual([...first.difference(second)], ['utf8']);
  assert.deepEqual([...first.symmetricDifference(second)], ['utf8', 'base64']);
  assert.equal(first.isSubsetOf(first.union(second)), true);
  assert.equal(first.isSupersetOf(new Set(['utf8'])), true);
  assert.equal(first.isDisjointFrom(new Set(['hex'])), true);
  assert.deepEqual([...first], ['utf8', 'ascii']);
  assert.throws(() => first.union(['utf16le']), TypeError);
  assert.equal(Object.getOwnPropertyDescriptor(Set.prototype, 'union').enumerable, false);
});

test('withResolvers resolves, rejects, and preserves constructor semantics', async () => {
  const fulfilled = Promise.withResolvers();
  assert.deepEqual(Object.keys(fulfilled), ['promise', 'resolve', 'reject']);
  fulfilled.resolve('offline result');
  fulfilled.reject(new Error('ignored after resolution'));
  assert.equal(await fulfilled.promise, 'offline result');
  const rejected = Promise.withResolvers();
  const rejection = assert.rejects(rejected.promise, /offline rejection/);
  rejected.reject(new Error('offline rejection'));
  await rejection;
  class ChildPromise extends Promise {}
  const child = ChildPromise.withResolvers();
  assert.ok(child.promise instanceof ChildPromise);
  child.resolve(7);
  assert.equal(await child.promise, 7);
  assert.throws(() => Promise.withResolvers.call({}), TypeError);
  assert.throws(() => Promise.withResolvers.call(function InvalidConstructor() {}), TypeError);
  const descriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.configurable, true);
  assert.equal(Promise.withResolvers.length, 0);
  assert.equal(Promise.withResolvers.name, 'withResolvers');
});

test('util compatibility preserves ordinary exports and error messages', () => {
  assert.equal(util, require('node:util'));
  assert.equal(inspect, util.inspect);
  assert.equal(getSystemErrorName, util.getSystemErrorName);
  for (const [code, [, message]] of util.getSystemErrorMap()) {
    assert.equal(getSystemErrorMessage(code), message);
  }
  assert.equal(getSystemErrorMessage(-99999), 'Unknown system error -99999');
  for (const input of [0, 1, -1.5, NaN, Infinity]) {
    assert.throws(() => getSystemErrorMessage(input), { code: 'ERR_OUT_OF_RANGE' });
  }
  for (const input of ['-2', null, {}, undefined]) {
    assert.throws(() => getSystemErrorMessage(input), { code: 'ERR_INVALID_ARG_TYPE' });
  }
});

test('preload works in a fresh runner subprocess without any network or key', () => {
  const child = spawnSync(process.execPath, ['--require', preloadPath, '-e', `
    const assert = require('node:assert/strict');
    const u = require('node:util');
    assert.equal(typeof Promise.withResolvers, 'function');
    assert.equal(typeof u.getSystemErrorMessage, 'function');
    assert.deepEqual([...new Set(['utf8']).union(new Set(['hex']))], ['utf8', 'hex']);
    assert.equal(process.env.DEEPSEEK_API_KEY, 'test-only-fake-key-never-used');
    Promise.withResolvers().resolve('no network');
  `], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-only-fake-key-never-used' },
  });
  assert.equal(child.status, 0, child.stderr);
});

test('Node 20 new ESM named exports require the compatibility import rewrite', async () => {
  if (Number(process.versions.node.split('.')[0]) !== 20) return;
  syncBuiltinESMExports();
  assert.equal((await import('node:util')).getSystemErrorMessage, undefined);
  assert.equal(typeof getSystemErrorMessage, 'function');
  const child = spawnSync(process.execPath, ['--require', preloadPath, '--input-type=module', '-e',
    'import { getSystemErrorMessage } from "node:util"; console.log(getSystemErrorMessage(-99999));'],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /does not provide an export named 'getSystemErrorMessage'/);
});
