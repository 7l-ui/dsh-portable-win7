'use strict';

// This file must also be preloaded in DSH runner/worker Node processes.
// Node 20.19.2 already provides getBuiltinModule, loadEnvFile and dispose symbols.
const util = require('node:util');
// Production execa uses the standard Set composition methods. Use the upstream
// polyfill instead of silently omitting the plugin-manager on Node 20.
if (typeof Set.prototype.union !== 'function') require('core-js/actual/set');

if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers() {
      let resolve;
      let reject;
      const promise = new this((resolveArgument, rejectArgument) => {
        if (resolve !== undefined || reject !== undefined) {
          throw new TypeError('Promise capability executor was called more than once');
        }
        resolve = resolveArgument;
        reject = rejectArgument;
      });
      if (typeof resolve !== 'function' || typeof reject !== 'function') {
        throw new TypeError('Promise constructor did not provide callable resolve and reject functions');
      }
      return { promise, resolve, reject };
    },
  });
}

function getSystemErrorMessage(err) {
  // Reuse Node's own validation, including ERR_INVALID_ARG_TYPE and
  // ERR_OUT_OF_RANGE. On Windows errno values are libuv negative error codes.
  util.getSystemErrorName(err);
  return util.getSystemErrorMap().get(err)?.[1] ?? `Unknown system error ${err}`;
}

if (typeof util.getSystemErrorMessage !== 'function') {
  Object.defineProperty(util, 'getSystemErrorMessage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: getSystemErrorMessage,
  });
}

// ESM named imports are fixed by Node's builtin export list. Adding a property
// and calling syncBuiltinESMExports() cannot add a new named builtin export.
// Production imports of the missing name must target ./util-compat.mjs.
module.exports = { getSystemErrorMessage: util.getSystemErrorMessage };
