import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDevSourceHints } from '../scripts/dev-server.mjs';

test('dev stub loads the localhost bundle without auto-update URLs', async () => {
  const stub = await readFile(new URL('../dev/nocobase-cross-env.dev.user.js', import.meta.url), 'utf8');

  assert.match(stub, /@name\s+NocoBase Cross Env DEV/);
  assert.match(stub, /@updateURL\s+none/);
  assert.match(stub, /@downloadURL\s+none/);
  assert.match(stub, /@require\s+http:\/\/127\.0\.0\.1:5173\/nocobase-cross-env\.dev\.js/);
});

test('production script exposes debug source labels and toggle hooks', async () => {
  const source = await readFile(new URL('../nocobase-cross-env.user.js', import.meta.url), 'utf8');

  assert.match(source, /sourceURL=nbce-userscript\.js/);
  assert.match(source, /sourceURL=nbce-page-bootstrap\.js/);
  assert.match(source, /debug-toggle-logs/);
  assert.match(source, /NBCE_DEBUG/);
  assert.match(source, /bridge request/);
});

test('dev bundle source hint replaces production userscript sourceURL', async () => {
  const source = await readFile(new URL('../nocobase-cross-env.user.js', import.meta.url), 'utf8');
  const devSource = withDevSourceHints(source);

  assert.doesNotMatch(devSource, /sourceURL=nbce-userscript\.js/);
  assert.match(devSource, /sourceURL=nbce-userscript-dev\.js/);
});

test('README documents the active dev source labels', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const debugLine = readme.split('\n').find((line) => line.includes('Open the page DevTools')) || '';

  assert.match(debugLine, /nbce-userscript-dev\.js/);
  assert.match(debugLine, /nbce-page-bootstrap\.js/);
  assert.doesNotMatch(debugLine, /nbce-userscript\.js`/);
});
