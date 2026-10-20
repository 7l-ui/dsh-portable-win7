/** Refresh public code provenance after candidate-only compatibility repairs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = path.dirname(here);
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: refresh-transform-records.mjs output [--base dir] [--tools dir]');
const output = path.resolve(args[0]);
let base = path.join(builder, 'artifacts/DSH-Portable-Windows-x64');
let tools = path.join(here, 'tools/node_modules');
for (let index = 1; index < args.length; index++) {
  if (args[index] === '--base' && args[index + 1]) base = path.resolve(args[++index]);
  else if (args[index] === '--tools' && args[index + 1]) tools = path.resolve(args[++index]);
  else throw new Error('Unknown or incomplete provenance option.');
}
assert.notEqual(output.toLowerCase(), base.toLowerCase(), 'Output cannot be the source distribution.');
const originalManifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
assert.equal(originalManifest.edition, 'win7-sp1-x64-candidate', 'Only unfinished candidate provenance can be refreshed.');
const hash = value => createHash('sha256').update(value).digest('hex');
const addedDependencies = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'typescript', 'undici', 'core-js'];
const records = [];
let examinedJavaScriptFiles = 0;

async function record(filename, sourceFile) {
  const actual = await readFile(filename);
  const source = await readFile(sourceFile);
  if (!actual.equals(source)) records.push({ path: path.relative(output, filename),
    sourceSha256: hash(source), transformedSha256: hash(actual) });
}
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !['test', 'tests', 'fixtures', 'example', 'examples'].includes(entry.name)) await visit(filename);
      continue;
    }
    if (!/\.(c|m)?js$/.test(entry.name)) continue;
    examinedJavaScriptFiles++;
    const appRelative = path.relative(path.join(output, 'app/node_modules'), filename);
    const segments = appRelative.split(path.sep);
    let sourceFile;
    if (segments[0] === '@dsh-portable' && segments[1] === 'compat') sourceFile = path.join(here, 'compat', ...segments.slice(2));
    else if (addedDependencies.includes(segments[0])) sourceFile = path.join(tools, appRelative);
    else sourceFile = path.join(base, 'app/node_modules', appRelative);
    await record(filename, sourceFile);
  }
}
await visit(path.join(output, 'app/node_modules'));
for (const file of ['launcher.mjs', 'mcp.mjs']) await record(path.join(output, 'portable', file), path.join(builder, 'template/portable', file));
await record(path.join(output, '配置密钥.cmd'), path.join(builder, 'template/配置密钥.cmd'));
records.sort((first, second) => first.path.localeCompare(second.path, 'en'));
await writeFile(path.join(output, 'licenses/win7-transformations.json'), `${JSON.stringify(records, null, 2)}\n`);
const dependencyVersions = {};
for (const dependency of addedDependencies) dependencyVersions[dependency] = JSON.parse(await readFile(path.join(output, 'app/node_modules', dependency, 'package.json'), 'utf8')).version;
const manifestFile = path.join(output, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
Object.assign(manifest, { transformedJavaScriptFiles: records.length, examinedJavaScriptFiles,
  compatibilityDependencyVersions: dependencyVersions, transformationRecordsRefreshedAt: new Date().toISOString() });
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, examinedJavaScriptFiles, transformationRecordCount: records.length, dependencyVersions }));
