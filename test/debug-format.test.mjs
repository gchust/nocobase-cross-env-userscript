import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscriptInternals } from '../test-support/userscript-internals.mjs';

test('formats encoded NocoBase filter query as readable JSON using production helper', async () => {
  const internals = await loadUserscriptInternals();
  const url =
    'https://main.v2.test.nocobase.com/nocobase/api/t1_user:list?filter=%7B%22$and%22:[%7B%22address%22:%7B%22$includes%22:%22dd%22%7D%7D]%7D&page=1&pageSize=40';

  const result = internals.formatDebugQuery(url);

  assert.match(result, /filter =\n\{/);
  assert.match(result, /"\$includes": "dd"/);
  assert.match(result, /page = 1/);
  assert.match(result, /pageSize = 40/);
});

test('keeps non-json query values readable using production helper', async () => {
  const internals = await loadUserscriptInternals();

  const result = internals.formatDebugQuery('https://example.com/api/users:list?keyword=a%20b&sort=-createdAt');

  assert.equal(result, 'keyword = a b\n\nsort = -createdAt');
});
