import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const userscriptPath = resolve(rootDir, 'nocobase-cross-env.user.js');
const devStubPath = resolve(rootDir, 'dev/nocobase-cross-env.dev.user.js');
const userscript = await readFile(userscriptPath, 'utf8');
const devStub = await readFile(devStubPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[check] ${message}`);
    process.exitCode = 1;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run(process.execPath, ['--check', userscriptPath]);

assert(userscript.includes('// ==UserScript=='), 'production userscript metadata header is missing');
assert(userscript.includes('@updateURL     https://gchust.github.io/nocobase-cross-env-userscript/nocobase-cross-env.user.js'), 'production updateURL changed unexpectedly');
assert(userscript.includes('//# sourceURL=nbce-userscript.js'), 'production userscript sourceURL is missing');
assert(userscript.includes('sourceURL=nbce-page-bootstrap.js'), 'page bootstrap sourceURL is missing');
assert(userscript.includes('debug-toggle-logs'), 'NBCE debug toggle UI is missing');
assert(userscript.includes('bridge request'), 'bridge debug log is missing');
assert(devStub.includes('@name         NocoBase Cross Env DEV'), 'dev userscript name is missing');
assert(devStub.includes('@updateURL     none'), 'dev userscript must not auto-update');
assert(devStub.includes('@require      http://127.0.0.1:5173/nocobase-cross-env.dev.js'), 'dev userscript localhost require is missing');

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('[check] ok');
