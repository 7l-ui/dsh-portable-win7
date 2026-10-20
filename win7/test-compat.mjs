/** Keep development dependency lookup outside the shipped compatibility package. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const environment = { ...process.env, NODE_PATH: process.env.DSH_BUILD_TOOLS
  ? path.resolve(process.env.DSH_BUILD_TOOLS) : path.join(here, 'tools/node_modules') };
const result = spawnSync(process.execPath, ['--test',
  path.join(here, 'compat/compat.test.mjs'), path.join(here, 'compat/zlib-compat.test.mjs')], {
  env: environment, windowsHide: true, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
