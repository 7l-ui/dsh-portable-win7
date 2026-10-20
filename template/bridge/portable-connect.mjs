import { realpath } from 'node:fs/promises';
import path from 'node:path';

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function connectPortable(input = {}, {
  env = process.env,
  pair = async log => (await import('./connection.mjs')).pairFromLog(log),
} = {}) {
  const expectedLog = env.DSH_PORTABLE_LAUNCH_LOG;
  const expectedBase = env.DSH_PORTABLE_BASE_URL;
  if (!expectedLog || !path.isAbsolute(expectedLog) || !expectedBase) {
    throw new Error('缺少便携包启动信息。请通过 portable/mcp.mjs 启动 MCP。');
  }
  const expectedUrl = new URL(expectedBase);
  if (expectedUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(expectedUrl.hostname)
    || expectedUrl.username || expectedUrl.password) {
    throw new Error('本便携包没有有效的回环服务地址。');
  }
  if (input.baseUrl !== undefined) {
    let provided;
    try { provided = new URL(input.baseUrl); } catch { throw new Error('服务地址无效。'); }
    if (provided.origin !== expectedUrl.origin || provided.username || provided.password
      || provided.pathname !== '/' || provided.search || provided.hash) {
      throw new Error('只允许连接当前便携包，不能改接其他 DSH 实例。');
    }
  }
  if (input.launchLog !== undefined) {
    if (!path.isAbsolute(input.launchLog)) throw new Error('只能使用当前便携包的启动日志绝对路径。');
    let expected, supplied;
    try { [expected, supplied] = await Promise.all([realpath(expectedLog), realpath(input.launchLog)]); }
    catch { throw new Error('当前便携包的启动日志不可用。'); }
    if (!samePath(expected, supplied)) throw new Error('只允许当前便携包启动日志，不能读取其他实例日志。');
  }
  return pair(expectedLog);
}
