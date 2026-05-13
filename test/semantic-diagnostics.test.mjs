import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscriptInternals } from '../test-support/userscript-internals.mjs';

test('splits NocoBase collection action endpoint using production helper', async () => {
  const internals = await loadUserscriptInternals();
  const result = internals.splitNocoBaseEndpoint('t1_user:list');

  assert.equal(result.collection, 't1_user');
  assert.equal(result.action, 'list');
});

test('formats common NocoBase filter operators semantically using production helper', async () => {
  const internals = await loadUserscriptInternals();
  const filter = {
    $and: [
      {
        address: {
          $includes: 'dd',
        },
      },
      {
        enabled: {
          $isTruly: true,
        },
      },
    ],
  };

  const result = internals.formatSemanticFilterNode(filter);

  assert.match(result, /AND/);
  assert.match(result, /address includes "dd"/);
  assert.match(result, /enabled is true/);
  assert.doesNotMatch(result, /enabled is true true/);
});

test('extracts failed chunk URL from webpack error messages', async () => {
  const internals = await loadUserscriptInternals();

  assert.equal(
    internals.extractUrlFromChunkErrorMessage(
      'Loading chunk 47 failed. (error: https://cdn.nocobase.com/2.0.49/static/plugins/@nocobase/plugin-ai/dist/client/47.2fb813a37bb70c75.js)',
    ),
    'https://cdn.nocobase.com/2.0.49/static/plugins/@nocobase/plugin-ai/dist/client/47.2fb813a37bb70c75.js',
  );
  assert.equal(
    internals.extractUrlFromChunkErrorMessage(
      'ChunkLoadError: Loading chunk plugin-ai failed.\n(missing: https://target.example.com/nocobase/static/plugins/@nocobase/plugin-ai/dist/client/47.js)',
    ),
    'https://target.example.com/nocobase/static/plugins/@nocobase/plugin-ai/dist/client/47.js',
  );
  assert.equal(
    internals.extractUrlFromChunkErrorMessage(
      'TypeError: Failed to fetch dynamically imported module: https://target.example.com/nocobase/assets/module.js',
    ),
    'https://target.example.com/nocobase/assets/module.js',
  );
});

test('resource diagnostics are gated to enabled or likely NocoBase pages', async () => {
  const internals = await loadUserscriptInternals();

  assert.equal(internals.shouldRunResourceDiagnosticsForState(false, false), false);
  assert.equal(internals.shouldRunResourceDiagnosticsForState(true, false), true);
  assert.equal(internals.shouldRunResourceDiagnosticsForState(false, true), true);
});

test('bridge response diagnostics inspect raw pm:listEnabled response before URL rewrite', async () => {
  const internals = await loadUserscriptInternals();
  const rule = {
    targetAppName: 'jhb20',
    sourceWebpackPublicPath: 'https://main.v2.test.nocobase.com/nocobase/2.0.50/',
  };
  const rawResponseText = JSON.stringify({
    data: [
      {
        packageName: '@nocobase/plugin-ai',
        url: 'https://cdn.nocobase.com/2.0.49/static/plugins/@nocobase/plugin-ai/dist/client/index.js',
      },
    ],
  });

  const result = internals.prepareBridgeResponseText(rule, 'pm:listEnabled', '/api/pm:listEnabled', rawResponseText);

  assert.match(result.bodyText, /main\.v2\.test\.nocobase\.com/);
  assert.doesNotMatch(result.bodyText, /cdn\.nocobase\.com/);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.message.includes('NocoBase CDN')),
    'expected raw CDN plugin URL to produce a diagnostic before rewrite',
  );
});

test('pm:listEnabled diagnostics resolve relative plugin URLs against response origin', async () => {
  const internals = await loadUserscriptInternals();
  const rule = {
    targetAppName: 'jhb20',
    sourceWebpackPublicPath: 'https://main.v2.test.nocobase.com/nocobase/2.0.50/',
  };
  const rawResponseText = JSON.stringify({
    data: [
      {
        packageName: '@nocobase/plugin-ai',
        url: '/nocobase/2.0.49/static/plugins/@nocobase/plugin-ai/dist/client/index.js',
      },
    ],
  });

  const result = internals.prepareBridgeResponseText(
    rule,
    'pm:listEnabled',
    'https://target.example.com/nocobase/api/pm:listEnabled',
    rawResponseText,
  );

  assert.ok(result.diagnostics.length, 'expected a relative plugin URL mismatch diagnostic');
  assert.ok(
    result.diagnostics.every((diagnostic) => diagnostic.url.startsWith('https://target.example.com/')),
    'expected relative diagnostic URL to use the target response origin',
  );
});

test('resource diagnostics report asset version mismatches explicitly', async () => {
  const internals = await loadUserscriptInternals();

  const result = internals.diagnoseResourceUrl(
    'https://target.example.com/nocobase/2.0.49/static/plugins/@nocobase/plugin-ai/dist/client/index.js',
    {
      sourceWebpackPublicPath: 'https://main.v2.test.nocobase.com/nocobase/2.0.50/',
    },
    {
      kind: 'plugin',
      baseUrl: 'https://target.example.com',
    },
  );

  assert.ok(
    result.some((diagnostic) => diagnostic.message.includes('资源版本号和当前前端资源版本不一致')),
    'expected a dedicated version mismatch diagnostic',
  );
});

test('recent resource issues exclude diagnostics from selected request', async () => {
  const internals = await loadUserscriptInternals();
  const issues = [
    { requestId: 'req_1', message: 'current request issue' },
    { requestId: 'req_2', message: 'other request issue' },
    { message: 'global chunk issue' },
  ];

  const result = internals.selectRecentResourceIssues(issues, { id: 'req_1' });

  assert.deepEqual(
    result.map((issue) => issue.message),
    ['other request issue', 'global chunk issue'],
  );
});

test('clearing debug records also clears recent resource issues', async () => {
  const internals = await loadUserscriptInternals();
  const debugLogs = [{ id: 'req_1' }];
  const resourceIssues = [{ id: 'resource_1' }];

  internals.clearDebugRecords(debugLogs, resourceIssues);

  assert.deepEqual(debugLogs, []);
  assert.deepEqual(resourceIssues, []);
});

test('same-origin resource load failures record a generic diagnostic when no mismatch is found', async () => {
  const internals = await loadUserscriptInternals();

  const result = internals.diagnoseResourceLoadFailure(
    'https://main.v2.test.nocobase.com/nocobase/2.0.50/static/js/umi.js',
    {
      sourceWebpackPublicPath: 'https://main.v2.test.nocobase.com/nocobase/2.0.50/',
    },
    'script',
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].level, 'error');
  assert.match(result[0].message, /资源加载失败/);
});

test('NBCE_DEBUG enables debug logs as an initial local switch', async () => {
  const internals = await loadUserscriptInternals({
    NBCE_DEBUG: true,
    GM_debugEnabled: false,
  });

  assert.equal(internals.nbceDebugEnabled, true);
});
