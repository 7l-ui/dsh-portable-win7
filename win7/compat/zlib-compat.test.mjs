import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as nativeZlib from 'node:zlib';
import {
  constants, createZstdCompress, createZstdDecompress,
  zstdCompress, zstdDecompress, zstdDecompressSync, gzipSync, gunzipSync,
} from './zlib-compat.mjs';

const exe = process.env.DSH_WIN7_ZSTD_PATH || fileURLToPath(new URL(
  '../../downloads/win7-research/deps/zstd/zstd-v1.5.7-win64/zstd.exe', import.meta.url));
process.env.DSH_WIN7_ZSTD_PATH = exe;
await access(exe);
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const text = Buffer.from('{"type":"header","标题":"中文会话"}\n{"type":"message","内容":"你好，世界 🌏"}\n');
const checksumOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const prefixOptions = { finishFlush: constants.ZSTD_e_flush };

async function transform(input, stream, split = 7) {
  const chunks = [];
  const parts = [];
  for (let offset = 0; offset < input.length; offset += split) parts.push(input.subarray(offset, offset + split));
  await pipeline(Readable.from(parts), stream, new Writable({
    write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  }));
  return Buffer.concat(chunks);
}

test('preserves Node zlib exports and Node 24 Zstandard constant values', () => {
  assert.equal(constants.ZSTD_c_checksumFlag, 201);
  assert.equal(constants.ZSTD_e_flush, 1);
  for (const [name, value] of Object.entries(nativeZlib.constants)) assert.equal(constants[name], value);
  assert.deepEqual(gunzipSync(gzipSync(text)), text);
});

test('callback/promisify/sync Chinese JSONL round trips with checksummed frames', async () => {
  const encoded = await compress(text, checksumOptions);
  assert.equal(encoded.readUInt32LE(0), 0xfd2fb528);
  assert.equal(encoded[4] & 4, 4);
  assert.deepEqual(await decompress(encoded), text);
  assert.deepEqual(zstdDecompressSync(encoded), text);
  const callbackOutput = await new Promise((resolve, reject) => {
    zstdCompress(text, (error, bytes) => error ? reject(error) : resolve(bytes));
  });
  assert.deepEqual(zstdDecompressSync(callbackOutput), text);
});

test('stream.pipeline compress/decompress supports split input and backpressure', async () => {
  const large = Buffer.from(text.toString().repeat(25000));
  const encoded = await transform(large, createZstdCompress({ ...checksumOptions, chunkSize: 1024 }), 8191);
  assert.equal(encoded[4] & 4, 4);
  assert.deepEqual(await transform(encoded, createZstdDecompress({ chunkSize: 1024 }), 13), large);
});

test('a bad checksum rejects async, sync, and stream paths, including recovery mode', async () => {
  const encoded = await compress(text);
  encoded[encoded.length - 1] ^= 0x80;
  for (const options of [undefined, prefixOptions]) {
    await assert.rejects(decompress(encoded, options), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
    assert.throws(() => zstdDecompressSync(encoded, options), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
    await assert.rejects(transform(encoded, createZstdDecompress(options)), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  }
});

test('a truncated checksum rejects normal decoding but explicit prefix recovery returns plaintext', async () => {
  const encoded = await compress(text);
  const truncated = encoded.subarray(0, encoded.length - 2);
  await assert.rejects(decompress(truncated), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  assert.throws(() => zstdDecompressSync(truncated), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  await assert.rejects(transform(truncated, createZstdDecompress()), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  assert.deepEqual(await decompress(truncated, prefixOptions), text);
  assert.deepEqual(zstdDecompressSync(truncated, prefixOptions), text);
  assert.deepEqual(await transform(truncated, createZstdDecompress(prefixOptions)), text);
});

test('concatenated frames decode on all paths and remain independently decodable', async () => {
  const first = await compress(text.subarray(0, text.indexOf(10) + 1));
  const second = await compress(text.subarray(text.indexOf(10) + 1));
  const encoded = Buffer.concat([first, second]);
  assert.deepEqual(await decompress(encoded), text);
  assert.deepEqual(zstdDecompressSync(encoded), text);
  assert.deepEqual(await transform(encoded, createZstdDecompress()), text);
  assert.deepEqual(Buffer.concat([zstdDecompressSync(first), zstdDecompressSync(second)]), text);
});

test('concatenated stream rejects a damaged final frame and recovers only a truncated tail', async () => {
  const first = await compress(text);
  const second = await compress(text);
  const truncated = Buffer.concat([first, second.subarray(0, second.length - 1)]);
  await assert.rejects(decompress(truncated), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  assert.deepEqual(await decompress(truncated, prefixOptions), Buffer.concat([text, text]));
  const corrupt = Buffer.concat([first, second]);
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(decompress(corrupt, prefixOptions), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
});

test('a truncated data block recovers only the available plaintext prefix', async () => {
  const source = Buffer.from(JSON.stringify({ 内容: '中文尾帧恢复', body: randomBytes(400 * 1024).toString('base64') }) + '\n');
  const encoded = await compress(source);
  const truncated = encoded.subarray(0, encoded.length - 1000);
  await assert.rejects(decompress(truncated), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  assert.throws(() => zstdDecompressSync(truncated), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  await assert.rejects(transform(truncated, createZstdDecompress(), 8191), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  const recovered = await decompress(truncated, prefixOptions);
  assert.ok(recovered.length > 0 && recovered.length < source.length);
  assert.deepEqual(recovered, source.subarray(0, recovered.length));
  assert.deepEqual(zstdDecompressSync(truncated, prefixOptions), recovered);
  assert.deepEqual(await transform(truncated, createZstdDecompress(prefixOptions), 8191), recovered);
});

test('frames interoperate with native Node 24 Zstandard', {
  skip: typeof nativeZlib.zstdCompressSync !== 'function',
}, async () => {
  const portable = await compress(text, checksumOptions);
  assert.deepEqual(nativeZlib.zstdDecompressSync(portable), text);
  const native = nativeZlib.zstdCompressSync(text, checksumOptions);
  assert.deepEqual(await decompress(native), text);
  assert.deepEqual(zstdDecompressSync(native), text);
  assert.deepEqual(await transform(native, createZstdDecompress()), text);
});

test('invalid magic never becomes successful prefix recovery', async () => {
  const invalid = Buffer.from('these bytes are not a zstandard frame');
  await assert.rejects(decompress(invalid, prefixOptions), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
  assert.throws(() => zstdDecompressSync(invalid, prefixOptions), { code: 'ERR_ZSTD_DECOMPRESSION_FAILED' });
});

test('convenience methods enforce maxOutputLength', async () => {
  const encoded = await compress(text);
  await assert.rejects(decompress(encoded, { maxOutputLength: 10 }), { code: 'ERR_BUFFER_TOO_LARGE' });
  assert.throws(() => zstdDecompressSync(encoded, { maxOutputLength: 10 }));
});

test('private decoder probe can close an unused stream without launching an executable', async () => {
  const previous = process.env.DSH_WIN7_ZSTD_PATH;
  process.env.DSH_WIN7_ZSTD_PATH = `${exe}.does-not-exist`;
  try {
    const stream = createZstdDecompress({ chunkSize: 1024 * 1024 });
    assert.equal(stream._handle, undefined);
    await new Promise((resolve) => stream.close(resolve));
    await assert.rejects(decompress(Buffer.from('x')), { code: 'ENOENT' });
    assert.throws(() => zstdDecompressSync(Buffer.from('x')), { code: 'ENOENT' });
  } finally {
    process.env.DSH_WIN7_ZSTD_PATH = previous;
  }
});
