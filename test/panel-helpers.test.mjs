import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscriptInternals } from '../test-support/userscript-internals.mjs';

const ORIGIN = 'https://main.v2.test.nocobase.com';

function urlsFor(prefix, count) {
  return Array.from({ length: count }, (_, index) => `https://${prefix}-${index}.example.com/nocobase/admin`);
}

test('target history is origin scoped, capped, pinnable, and removable', async () => {
  const internals = await loadUserscriptInternals();
  let history = {};

  urlsFor('target', 10).forEach((url) => {
    history = internals.upsertTargetHistory(history, ORIGIN, url);
  });

  assert.equal(history[ORIGIN].recent.length, 8);
  assert.equal(history[ORIGIN].recent[0], 'https://target-9.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].recent.at(-1), 'https://target-2.example.com/nocobase/admin');

  history = internals.pinTargetHistory(history, ORIGIN, 'https://pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].pinned, 'https://pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].recent.includes(history[ORIGIN].pinned), false);

  urlsFor('next', 10).forEach((url) => {
    history = internals.upsertTargetHistory(history, ORIGIN, url);
  });
  assert.equal(history[ORIGIN].pinned, 'https://pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].recent.length, 8);
  assert.equal(history[ORIGIN].recent.includes(history[ORIGIN].pinned), false);

  history = internals.pinTargetHistory(history, ORIGIN, 'https://new-pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].pinned, 'https://new-pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].recent[0], 'https://pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].recent.includes(history[ORIGIN].pinned), false);
  assert.equal(history[ORIGIN].recent.length, 8);

  history = internals.upsertTargetHistory(history, 'https://other.example.com', 'https://other-target.example.com/admin');
  history = internals.removeTargetHistory(history, ORIGIN, 'https://new-pinned.example.com/nocobase/admin');
  assert.equal(history[ORIGIN].pinned, '');
  assert.deepEqual([...history['https://other.example.com'].recent], ['https://other-target.example.com/admin']);
});

test('debug view-model filters use derived status, semantic text, overrides, diagnostics, and resource mode', async () => {
  const internals = await loadUserscriptInternals();
  const logs = [
    {
      id: 'ok',
      method: 'GET',
      endpoint: 'users:list',
      url: `${ORIGIN}/api/users:list?filter=${encodeURIComponent(JSON.stringify({ name: { $includes: 'Ada' } }))}`,
      status: 200,
      ok: false,
      responseText: 'alpha response',
    },
    {
      id: 'redirect',
      method: 'GET',
      endpoint: 'users:get',
      url: `${ORIGIN}/api/users:get`,
      status: 304,
      responseText: 'cached',
    },
    {
      id: 'http-error',
      method: 'DELETE',
      endpoint: 'users:destroy',
      url: `${ORIGIN}/api/users:destroy`,
      status: 500,
      ok: true,
      error: 'server exploded',
      responseText: 'failure response',
      diagnostics: [{ level: 'error', message: 'plugin asset mismatch', url: `${ORIGIN}/static/plugin.js` }],
    },
    {
      id: 'timeout',
      method: 'GET',
      endpoint: 'roles:list',
      url: `${ORIGIN}/api/roles:list`,
      status: 0,
      error: 'timeout exceeded',
      ok: true,
    },
    {
      id: 'override-hit',
      method: 'POST',
      endpoint: 'users:create',
      url: `${ORIGIN}/api/users:create`,
      status: 201,
      overridden: true,
      responseText: '{"id":1}',
    },
    {
      id: 'rule-only',
      method: 'POST',
      endpoint: 'users:update',
      url: `${ORIGIN}/api/users:update`,
      status: 200,
      responseText: '{"id":2}',
    },
  ];

  const models = internals.buildDebugLogViewModels(logs, {
    debugRules: {
      'POST users:update': {
        enabled: true,
        responseText: '{"id":3}',
      },
    },
  });

  assert.equal(models.find((item) => item.id === 'ok').isSuccessfulResponse, true);
  assert.equal(models.find((item) => item.id === 'redirect').isSuccessfulResponse, true);
  assert.equal(models.find((item) => item.id === 'http-error').isHttpError, true);
  assert.equal(models.find((item) => item.id === 'http-error').isSuccessfulResponse, false);
  assert.equal(models.find((item) => item.id === 'timeout').isTransportError, true);

  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { keyword: 'ada' }).items.map((item) => item.id),
    ['ok'],
  );
  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { keyword: 'failure response' }).items.map((item) => item.id),
    ['http-error'],
  );
  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { diagnosticsOnly: true }).items.map((item) => item.id),
    ['http-error'],
  );
  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { statusFilter: 'failure' }).items.map((item) => item.id),
    ['http-error', 'timeout'],
  );
  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { method: 'POST', overrideFilter: 'overridden' }).items.map(
      (item) => item.id,
    ),
    ['override-hit'],
  );
  assert.deepEqual(
    internals.filterDebugLogViewModels(models, { method: 'POST', overrideFilter: 'normal' }).items.map(
      (item) => item.id,
    ),
    ['rule-only'],
  );

  const resourceOnly = internals.filterDebugLogViewModels(models, { resourceOnly: true });
  assert.deepEqual([...resourceOnly.items], []);
  assert.deepEqual({ ...resourceOnly.counts }, { requestHits: 0, requestTotal: logs.length });

  assert.deepEqual({ ...internals.resolveVisibleDebugSelection('ok', models.slice(2), false) }, {
    selectedDebugLogId: '',
    selectedLog: null,
    shouldClearEditor: true,
  });
  assert.equal(internals.resolveVisibleDebugSelection('ok', models, true).shouldClearEditor, true);
});

test('resource issue filtering has independent counts and keyword matching', async () => {
  const internals = await loadUserscriptInternals();
  const result = internals.filterResourceIssues(
    [
      { id: 'asset', level: 'error', kind: 'script', message: 'chunk load failed', url: `${ORIGIN}/umi.js` },
      { id: 'style', level: 'warn', kind: 'style', message: 'stylesheet missing', detail: 'theme.css' },
    ],
    { keyword: 'theme' },
  );

  assert.deepEqual(result.items.map((item) => item.id), ['style']);
  assert.deepEqual({ ...result.counts }, { resourceHits: 1, resourceTotal: 2 });
});

test('debug copy payload keeps endpoint, semantic, diagnostics, and response sources distinct', async () => {
  const internals = await loadUserscriptInternals();
  const summarizedBody = internals.summarizeDebugBodyMeta({
    kind: 'custom',
    value: 'x'.repeat(2010),
  });
  assert.equal(summarizedBody.meta.truncated, true);
  assert.equal(summarizedBody.meta.omittedChars, 10);
  assert.equal(summarizedBody.meta.length, 2010);

  const log = {
    id: 'copy',
    method: 'POST',
    endpoint: 'users:create',
    url: `${ORIGIN}/api/users:create`,
    status: 201,
    statusText: 'Created',
    durationMs: 34,
    requestBodySummary: '{"name":"Ada"}',
    requestBodyMeta: {
      kind: 'text',
      truncated: true,
      omittedChars: 12,
    },
    responseText: '{"id":1}',
    responseMeta: {
      kind: 'text',
      truncated: true,
      omittedChars: 44,
    },
    diagnostics: [{ level: 'warn', message: 'version mismatch', url: `${ORIGIN}/plugin.js` }],
  };

  assert.equal(internals.buildDebugCopyPayload(log, 'endpoint'), 'POST users:create');
  assert.match(internals.buildDebugCopyPayload(log, 'semantic'), /collection: users/);
  assert.match(internals.buildDebugCopyPayload(log, 'diagnostics'), /version mismatch/);

  const fullPackage = internals.buildDebugCopyPayload(log, 'package', {
    editorValue: '{"id":99}',
    overrideRule: {
      responseText: '{"id":2}',
    },
  });

  assert.match(fullPackage, /requestBody =\n  kind: text\n  truncated: true\n  omittedChars: 12/);
  assert.match(fullPackage, /capturedResponse =\n  source: captured\n  kind: captured\n  truncated: true\n  omittedChars: 44/);
  assert.match(fullPackage, /overrideResponse =\n  source: overrideRule\n  kind: override/);
  assert.match(fullPackage, /editedResponse =\n  source: editor\n  kind: edited/);
  assert.match(fullPackage, /\{"id":1\}/);
  assert.match(fullPackage, /\{"id":2\}/);
  assert.match(fullPackage, /\{"id":99\}/);

  const noDuplicateEdited = internals.buildDebugCopyPayload(log, 'package', {
    editorValue: '{"id":2}',
    overrideRule: {
      responseText: '{"id":2}',
    },
  });
  assert.doesNotMatch(noDuplicateEdited, /editedResponse =/);
});

test('panel status summary reports mapping, debug state, counts, and non-NocoBase status', async () => {
  const internals = await loadUserscriptInternals();
  const enabled = internals.buildPanelStatusSummary(
    {
      enabled: true,
      targetEntryUrl: 'https://target.example.com/apps/sandbox/admin',
      targetAppName: 'sandbox',
    },
    {
      debugEnabled: true,
      isLikelyNocoBasePage: true,
    },
    {
      requestHits: 3,
      requestTotal: 8,
      resourceHits: 1,
      resourceTotal: 2,
    },
  );

  assert.match(enabled.main, /A main\.v2\.test\.nocobase\.com/);
  assert.match(enabled.main, /B target\.example\.com\/apps\/sandbox\/admin/);
  assert.match(enabled.secondary, /Debug On · Request 3\/8 · Resource 1\/2/);
  assert.deepEqual([...enabled.badgeItems.map((item) => item.text)], ['A->B', 'Debug']);

  const disabled = internals.buildPanelStatusSummary(
    null,
    {
      debugEnabled: false,
      isLikelyNocoBasePage: false,
    },
    {},
  );
  assert.deepEqual([...disabled.badgeItems.map((item) => item.text)], ['No rule', 'No debug', 'Non-NB']);
});
