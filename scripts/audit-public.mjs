/** Conservative publication scan. Findings contain relative names and rule IDs only. */
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const textTypes = new Set(['.mjs', '.cjs', '.js', '.json', '.yaml', '.yml', '.ps1', '.cmd', '.c', '.h', '.def', '.md', '.txt', '.toml', '.html', '.css', '.svg']);
const specialNames = new Set(['LICENSE', 'NOTICE', 'CREDITS', '.gitignore', '.gitattributes', '.editorconfig']);
const forbiddenParts = new Set(['artifacts', 'downloads', 'node_modules', 'native-build', 'proposals', 'generated', 'win7-vm', 'machines', 'private-config', '.credentials', '.pnpm-store', 'validation', 'qa', 'logs', 'sessions', 'reports']);
const patterns = [
  ['api-token', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['google-token', /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['embedded-url-credential', /https?:\/\/[^\s/:@]+:[^\s/@]+@/g],
  ['personal-profile-path', /[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/'"<>]+/gi],
  ['unix-personal-path', /\/(?:home|Users)\/[^\s/'"<>]+/g],
  ['workstation-compiler-path', /[A-Za-z]:[\\/]+huanjin[\\/]+/gi],
  ['vm-test-credential', /DshVm(?:Only-\d{4}!|\d!!)/g],
  ['vm-account-id', /S-1-5-21-(?:\d+-){3}\d+/g],
];

function add(findings, file, rule, count = 1) {
  if (count > 0) findings.push({ file, rule, count });
}

/** Does not return rejected text, tokens, lengths, digests, or parser errors. */
export function scanText(text, file) {
  const findings = [];
  for (const [rule, expression] of patterns) {
    expression.lastIndex = 0;
    let inspected = text;
    // A parser rejection test deliberately uses conventional, inert user/pass on loopback.
    // This narrow exception does not allow URL credentials in production or configuration.
    if (rule === 'embedded-url-credential' && file === 'template/portable/launcher.test.mjs') {
      inspected = text.replace(/assert\.equal\(parseReadyUrl\((['"])[^'"\r\n]*\1\), null\);/g, source => source.replace(/https?:\/\/[^'"\s]+/g, address => {
        try {
          const value = new URL(address);
          return ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
            && ['user', 'u', 'test', 'fixture'].includes(value.username)
            && ['pass', 'p', 'password', 'test', 'fixture'].includes(value.password) ? '[inert parser rejection fixture]' : address;
        } catch { return address; }
      }));
    }
    let count = 0;
    while (expression.exec(inspected)) count++;
    add(findings, file, rule, count);
  }
  if (/\.(?:json|ya?ml)$/i.test(file) && !/(?:package(?:-lock)?\.json|pnpm-lock\.yaml)$/.test(file)) {
    // Any committed key/token/password value requires an explicit empty placeholder.
    // Environment-variable names and runtime code are not credential values.
    const sensitiveField = /["']?(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*:\s*(["'])([^\r\n]*?)\1/gi;
    let match;
    let count = 0;
    while ((match = sensitiveField.exec(text))) {
      if (match[2] !== '' && !/^\$\{[A-Z0-9_]+\}$/.test(match[2])) count++;
    }
    add(findings, file, 'nonempty-credential-field', count);
  }
  if (/(?:^|\/)keys\.example\.json$/i.test(file)) {
    try {
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      const ids = ['primary', 'backup1', 'backup2'];
      const valid = value.version === 2 && value.active === 'primary' && Array.isArray(value.slots)
        && value.slots.length === 3 && value.slots.every((slot, index) => slot.id === ids[index]
          && typeof slot.label === 'string' && slot.key === ''
          && ['deepseek-official', 'opencode-go'].includes(slot.provider));
      if (!valid) add(findings, file, 'unsafe-example-config');
    } catch { add(findings, file, 'invalid-example-config'); }
  }
  return findings;
}

function forbiddenFile(relative) {
  const segments = relative.split('/');
  if (segments.some(part => forbiddenParts.has(part.toLowerCase()))) return true;
  if (segments.includes('data') && !relative.startsWith('docs/')) return true;
  if (segments.includes('workspace') && relative !== 'template/workspace' && !relative.startsWith('template/workspace/')) return true;
  if (/(?:^|\/)(?:keys\.json|\.env(?:\..+)?|credentials(?:\..+)?|state\.json|[^/]*\.log|[^/]*\.flp|[^/]*\.vmdk|[^/]*\.vmx)$/i.test(relative)) return true;
  if (/(?:^|\/)(?:package-private|verify-private-release|verify-prepared-private|probe-go-status|inspect-live-session|probe-providers|verify-live-providers)\./i.test(relative)) return true;
  return false;
}

export async function auditTree(root) {
  root = path.resolve(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Audit root must be a regular directory.');
  const actualRoot = await realpath(root);
  const findings = [];
  let filesChecked = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      // Git internals are audited by git's own object/index mechanisms, not published as source files.
      if (relative === '.git') continue;
      const info = await lstat(full);
      if (info.isSymbolicLink()) { add(findings, relative, 'link-or-reparse-point'); continue; }
      if (forbiddenFile(relative)) { add(findings, relative, 'excluded-private-or-generated-path'); continue; }
      const resolved = await realpath(full);
      if (resolved !== actualRoot && !resolved.startsWith(actualRoot + path.sep)) { add(findings, relative, 'escaped-root'); continue; }
      if (info.isDirectory()) { await visit(full); continue; }
      if (!info.isFile()) { add(findings, relative, 'nonregular-file'); continue; }
      filesChecked++;
      if (!textTypes.has(path.extname(entry.name).toLowerCase()) && !specialNames.has(entry.name) && relative !== 'template/portable/gitconfig') { add(findings, relative, 'unreviewed-file-type'); continue; }
      const data = await readFile(full);
      if (data.includes(0)) { add(findings, relative, 'binary-content'); continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { add(findings, relative, 'non-utf8-content'); continue; }
      findings.push(...scanText(text, relative));
    }
  }
  await visit(root);
  return { auditVersion: 1, passed: findings.length === 0, filesChecked, findingCount: findings.length, findings };
}

export function selfTest() {
  let assertions = 0;
  for (const [text, rule] of [
    ['s' + 'k-' + 'A'.repeat(32), 'api-token'],
    ['gh' + 'p_' + 'a'.repeat(36), 'github-token'],
    ['C:' + '\\Users\\' + 'fixture-user\\test', 'personal-profile-path'],
    ['Dsh' + 'VmOnly-' + '2000!', 'vm-test-credential'],
    ['{"key":"inert-fixture"}', 'nonempty-credential-field'],
    ['-----BEGIN ' + 'PRIVATE KEY-----', 'private-key'],
  ]) { assert.ok(scanText(text, 'fixture.json').some(item => item.rule === rule)); assertions++; }
  assert.equal(scanText('{"key":""}', 'safe.json').length, 0); assertions++;
  assert.equal(scanText('process.env.DEEPSEEK_API_KEY', 'source.mjs').length, 0); assertions++;
  for (const relative of ['artifacts/a.json', 'template/portable/keys.json', 'logs/a.txt', 'win7/proposals/x.mjs', 'win7/tools/node_modules/x.mjs', 'machine.vmdk']) {
    assert.ok(forbiddenFile(relative)); assertions++;
  }
  assert.equal(forbiddenFile('template/workspace/AGENTS.md'), false); assertions++;
  const negativeFixture = "assert.equal(parseReadyUrl('dsh web: " + 'http://' + "user:pass@127.0.0.1:9000'), null);";
  assert.equal(scanText(negativeFixture, 'template/portable/launcher.test.mjs').length, 0); assertions++;
  assert.ok(scanText(negativeFixture, 'production.mjs').some(item => item.rule === 'embedded-url-credential')); assertions++;
  assert.ok(scanText(negativeFixture.replace('user:pass', 'user:opaque-credential'), 'template/portable/launcher.test.mjs').some(item => item.rule === 'embedded-url-credential')); assertions++;
  return { passed: true, assertions };
}

async function filesystemSelfTest() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-public-audit-fixture-'));
  const scanRoot = path.join(temporary, 'source');
  let assertions = 0;
  try {
    await mkdir(scanRoot);
    await writeFile(path.join(scanRoot, 'README.md'), 'Synthetic audit fixture. No runtime data.\n');
    assert.equal((await auditTree(scanRoot)).passed, true); assertions++;
    await writeFile(path.join(scanRoot, 'keys.json'), '{"key":"inert-fixture"}');
    assert.ok((await auditTree(scanRoot)).findings.some(item => item.rule === 'excluded-private-or-generated-path')); assertions++;
    await rm(path.join(scanRoot, 'keys.json'));
    await writeFile(path.join(scanRoot, 'config.json'), '{"apiKey":"inert-fixture"}');
    assert.ok((await auditTree(scanRoot)).findings.some(item => item.rule === 'nonempty-credential-field')); assertions++;
    await rm(path.join(scanRoot, 'config.json'));
    await writeFile(path.join(scanRoot, 'bad.md'), Buffer.from([0xff, 0xfe, 0x61]));
    assert.ok((await auditTree(scanRoot)).findings.some(item => item.rule === 'non-utf8-content')); assertions++;
    await rm(path.join(scanRoot, 'bad.md'));
    await writeFile(path.join(scanRoot, 'bad.zip'), 'fixture');
    assert.ok((await auditTree(scanRoot)).findings.some(item => item.rule === 'unreviewed-file-type')); assertions++;
    await rm(path.join(scanRoot, 'bad.zip'));
    const outside = path.join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'content.md'), 'Synthetic external file.');
    await symlink(outside, path.join(scanRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.ok((await auditTree(scanRoot)).findings.some(item => item.rule === 'link-or-reparse-point')); assertions++;
    return { passed: true, assertions };
  } finally {
    // Only remove the unique directory created by this test; never remove a caller-supplied path.
    if (path.dirname(temporary) === path.resolve(tmpdir()) && path.basename(temporary).startsWith('dsh-public-audit-fixture-')) await rm(temporary, { recursive: true, force: true });
  }
}

const main = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (main) {
  try {
    if (process.argv.includes('--self-test')) {
      const pure = selfTest();
      const filesystem = await filesystemSelfTest();
      console.log(JSON.stringify({ passed: true, assertions: pure.assertions + filesystem.assertions, pureAssertions: pure.assertions, filesystemAssertions: filesystem.assertions }));
    }
    else {
      const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const result = await auditTree(root);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.passed ? 0 : 1;
    }
  } catch {
    console.error('Public source audit could not complete. No rejected content is printed.');
    process.exitCode = 1;
  }
}
