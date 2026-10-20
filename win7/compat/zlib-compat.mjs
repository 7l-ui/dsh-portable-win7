// Node 20 keeps its native gzip/deflate/Brotli APIs; only Zstandard uses the
// bundled CLI. No temporary files, shell, inherited environment, or open window.
import * as nativeZlib from 'node:zlib';
import { constants as bufferConstants } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

export * from 'node:zlib';
// Verified against Node 24.13.1. Explicit exports override export-star names.
export const constants = Object.freeze({
  ...nativeZlib.constants,
  ZSTD_c_checksumFlag: 201,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_e_continue: 0,
  ZSTD_c_compressionLevel: 100,
});

function executable() {
  return process.env.DSH_WIN7_ZSTD_PATH ||
    fileURLToPath(new URL('../../../../runtime/zstd/zstd.exe', import.meta.url));
}

function failure(message, code = 'ERR_ZSTD_COMPAT') {
  return Object.assign(new Error(message), { code });
}

function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Zstandard options must be an object');
  }
  if (options.dictionary !== undefined || options.info === true) {
    throw failure('Zstandard dictionary/info options are not supported by the portable CLI adapter');
  }
  const finishFlush = options.finishFlush ?? constants.ZSTD_e_end;
  if (![constants.ZSTD_e_end, constants.ZSTD_e_flush].includes(finishFlush)) {
    throw failure('Unsupported Zstandard finishFlush value');
  }
  if (options.flush !== undefined && options.flush !== constants.ZSTD_e_continue) {
    throw failure('Incremental Zstandard flush operations are not supported by the CLI adapter');
  }
  const chunkSize = options.chunkSize ?? 16 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64) {
    throw new RangeError('Zstandard chunkSize must be an integer of at least 64');
  }
  const maxOutputLength = options.maxOutputLength ?? bufferConstants.MAX_LENGTH;
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1 ||
      maxOutputLength > bufferConstants.MAX_LENGTH) {
    throw new RangeError('Invalid Zstandard maxOutputLength');
  }
  const params = options.params ?? {};
  if (params === null || typeof params !== 'object') throw new TypeError('Zstandard params must be an object');
  for (const key of Object.keys(params)) {
    if (![String(constants.ZSTD_c_checksumFlag), String(constants.ZSTD_c_compressionLevel)].includes(key)) {
      throw failure(`Unsupported Zstandard parameter: ${key}`);
    }
  }
  const level = params[constants.ZSTD_c_compressionLevel] ?? 3;
  if (!Number.isSafeInteger(level) || level < -131072 || level > 22) {
    throw new RangeError('Unsupported Zstandard compression level');
  }
  return { finishFlush, chunkSize, maxOutputLength, level };
}

function argumentsFor(mode, options) {
  const args = [mode === 'compress' ? '-z' : '-d', '--stdout', '--quiet', '--no-progress'];
  // Session durability requires every emitted frame to carry its checksum.
  if (mode === 'compress') {
    args.push('--check');
    if (options.level < 0) args.push(`--fast=${-options.level}`);
    else if (options.level > 19) args.push('--ultra', `-${options.level}`);
    else args.push(`-${options.level || 3}`);
  }
  return args;
}

function processError(mode, status, signal, stderr) {
  const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit ${status}`);
  return Object.assign(failure(`Zstandard ${mode} failed: ${detail}`,
    mode === 'decompress' ? 'ERR_ZSTD_DECOMPRESSION_FAILED' : 'ERR_ZSTD_COMPRESSION_FAILED'),
  { exitCode: status, signal, stderr });
}

function permittedPrefix(mode, options, status, signal, stderr) {
  // A failed checksum, invalid magic/block, missing executable, or signal must
  // never become a successful decode. Only the caller's explicit torn-tail
  // recovery mode may accept the CLI's narrowly identified EOF diagnostics.
  return mode === 'decompress' && options.finishFlush === constants.ZSTD_e_flush &&
    status === 1 && signal === null &&
    /(?:premature end|unexpected end of (?:file|input))/i.test(stderr) &&
    !/(?:checksum|corrupt|unsupported|unknown frame|invalid)/i.test(stderr);
}

function inputBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Zstandard input must be a string, Buffer, TypedArray, DataView, or ArrayBuffer');
}

class CliZstdTransform extends Transform {
  constructor(mode, options) {
    super({ readableHighWaterMark: options.chunkSize, writableHighWaterMark: options.chunkSize });
    this.mode = mode;
    this.options = options;
    this.child = undefined;
    this.result = undefined;
    this.flushCallback = undefined;
    this.stdinError = undefined;
    this.bytesWritten = 0;
  }

  start() {
    if (this.child) return;
    const child = this.child = spawn(executable(), argumentsFor(this.mode, this.options), {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8').slice(0, 64 * 1024 - stderr.length);
    });
    child.stdin.on('error', (error) => { this.stdinError ??= error; });
    child.stdout.on('error', (error) => this.destroy(error));
    child.stdout.on('data', (chunk) => {
      if (!this.destroyed && !this.push(chunk)) child.stdout.pause();
    });
    child.on('error', (error) => this.destroy(error));
    child.on('close', (status, signal) => {
      if (this.destroyed) return;
      const accepted = status === 0 || permittedPrefix(this.mode, this.options, status, signal, stderr);
      this.result = { error: accepted ? this.stdinError : processError(this.mode, status, signal, stderr) };
      if (this.result.error) this.destroy(this.result.error);
      else this.complete();
    });
  }

  _transform(chunk, encoding, callback) {
    this.start();
    this.bytesWritten += chunk.length;
    // EPIPE commonly follows a useful decoder diagnostic; wait for its exit
    // status instead of replacing that diagnostic with a broken-pipe error.
    if (this.child.stdin.destroyed) return callback();
    this.child.stdin.write(chunk, encoding, (error) => {
      this.stdinError ??= error;
      callback();
    });
  }

  _read(size) {
    this.child?.stdout.resume();
    super._read(size);
  }

  _flush(callback) {
    this.flushCallback = callback;
    this.start();
    this.child.stdin.end();
    this.complete();
  }

  complete() {
    if (!this.result || !this.flushCallback) return;
    const callback = this.flushCallback;
    this.flushCallback = undefined;
    callback(this.result.error);
  }

  _destroy(error, callback) {
    if (this.child) {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    }
    callback(error);
  }

  close(callback) {
    if (typeof callback === 'function') {
      if (this.closed) queueMicrotask(callback);
      else this.once('close', callback);
    }
    this.destroy();
    return this;
  }
}

export function createZstdCompress(options) {
  return new CliZstdTransform('compress', normalizeOptions(options));
}

export function createZstdDecompress(options) {
  return new CliZstdTransform('decompress', normalizeOptions(options));
}

function oneShot(mode, input, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  if (typeof callback !== 'function') throw new TypeError('Zstandard callback must be a function');
  const bytes = inputBuffer(input);
  const normalized = normalizeOptions(options);
  const stream = new CliZstdTransform(mode, normalized);
  const chunks = [];
  let size = 0;
  let called = false;
  const finish = (error, value) => {
    if (called) return;
    called = true;
    callback(error, value);
  };
  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size > normalized.maxOutputLength) {
      stream.destroy(failure('Zstandard output exceeds maxOutputLength', 'ERR_BUFFER_TOO_LARGE'));
    } else chunks.push(chunk);
  });
  stream.once('error', (error) => finish(error));
  stream.once('end', () => finish(null, Buffer.concat(chunks, size)));
  stream.end(bytes);
}

export function zstdCompress(input, options, callback) {
  return oneShot('compress', input, options, callback);
}

export function zstdDecompress(input, options, callback) {
  return oneShot('decompress', input, options, callback);
}

export function zstdDecompressSync(input, options) {
  const normalized = normalizeOptions(options);
  const result = spawnSync(executable(), argumentsFor('decompress', normalized), {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {},
    input: inputBuffer(input),
    maxBuffer: normalized.maxOutputLength,
  });
  if (result.error) throw result.error;
  const stderr = result.stderr?.toString('utf8') ?? '';
  if (result.status !== 0 && !permittedPrefix('decompress', normalized, result.status, result.signal, stderr)) {
    throw processError('decompress', result.status, result.signal, stderr);
  }
  return result.stdout;
}
