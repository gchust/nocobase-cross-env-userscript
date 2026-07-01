import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadUserscriptWithDom } from '../test-support/userscript-internals.mjs';

const RULES_KEY = 'nbce.rules.v1';
const TARGET_HISTORY_KEY = 'nbce.targetHistory.v1';
const ORIGIN = 'https://main.v2.test.nocobase.com';

function ruleFor(origin) {
  return {
    sourceOrigin: origin,
    targetEntryUrl: 'https://target.example.com/apps/sandbox/admin',
    targetOrigin: 'https://target.example.com',
    targetPublicPath: '/',
    targetRootPublicPath: '/',
    targetAppName: 'sandbox',
    apiBaseUrl: 'https://target.example.com/api/',
    wsPath: '/ws',
    storagePrefix: 'NBCE_TEST_',
    enabled: true,
  };
}

function panelRoot(dom) {
  return dom.document.getElementById('nbce-panel-root');
}

function shadowRoot(dom) {
  const root = panelRoot(dom);
  assert.ok(root?.shadowRoot, 'expected panel shadow root');
  return root.shadowRoot;
}

function change(element) {
  element.dispatchEvent(new element.ownerDocument.defaultView.Event('change', { bubbles: true }));
}

function input(element) {
  element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('panel mount gating preserves NocoBase, enabled-rule, and manual-open behavior', async () => {
  const nb = await loadUserscriptWithDom({
    locationHref: `${ORIGIN}/nocobase/admin`,
    scripts: ['window.__nocobase_api_base_url__ = "/api/";'],
  });
  assert.equal(panelRoot(nb.dom), null);
  nb.dom.fireDOMContentLoaded();
  assert.ok(panelRoot(nb.dom), 'NocoBase runtime page should auto-mount panel');

  const enabledOrigin = 'https://plain.example.com';
  const enabled = await loadUserscriptWithDom({
    locationHref: `${enabledOrigin}/docs`,
    GM_values: {
      [RULES_KEY]: {
        [enabledOrigin]: ruleFor(enabledOrigin),
      },
    },
  });
  enabled.dom.fireDOMContentLoaded();
  assert.ok(panelRoot(enabled.dom), 'enabled origin should auto-mount panel outside NocoBase paths');

  const plain = await loadUserscriptWithDom({
    locationHref: 'https://plain-no-rule.example.com/docs',
  });
  plain.dom.fireDOMContentLoaded();
  assert.equal(panelRoot(plain.dom), null, 'plain page without a rule should not auto-mount');
  plain.dom.menuCommands[0].callback();
  const shadow = shadowRoot(plain.dom);
  assert.match(shadow.querySelector('.nbce-statusbar-badges').textContent, /No rule/);
  assert.match(shadow.querySelector('.nbce-statusbar-badges').textContent, /Non-NB/);
});

test('shadow panel supports target history, resource-only mode, copy fallback, and viewport scrolling', async () => {
  const { dom, internals } = await loadUserscriptWithDom({
    locationHref: `${ORIGIN}/plain`,
    GM_values: {
      [TARGET_HISTORY_KEY]: {
        [ORIGIN]: {
          pinned: 'https://pinned.example.com/nocobase/admin',
          recent: ['https://recent.example.com/nocobase/admin'],
        },
      },
    },
  });

  dom.menuCommands[0].callback();
  let shadow = shadowRoot(dom);
  const styleText = shadow.querySelector('style').textContent;
  assert.match(styleText, /\.nbce-card\s*\{[\s\S]*max-height:\s*calc\(100vh - 24px\)/);
  assert.match(styleText, /\.nbce-card\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.equal(shadow.querySelector('.nbce-toggle-badges'), null);
  const targetInput = shadow.querySelector('.nbce-input');
  const recentChip = shadow.querySelector('[data-target-url="https://recent.example.com/nocobase/admin"]');
  assert.ok(recentChip, 'expected recent target chip');

  recentChip.click();
  assert.equal(targetInput.value, 'https://recent.example.com/nocobase/admin');
  assert.equal(
    dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN].pinned,
    'https://pinned.example.com/nocobase/admin',
    'clicking a history chip should only fill the input',
  );

  shadow.querySelector('[data-action="pin-target"]').click();
  await flush();
  assert.equal(dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN].pinned, 'https://recent.example.com/nocobase/admin');

  shadow = shadowRoot(dom);
  shadow.querySelector('[data-action="remove-target-history"][data-target-url="https://recent.example.com/nocobase/admin"]').click();
  await flush();
  assert.equal(dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN].pinned, '');
  assert.deepEqual([...dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN].recent], [
    'https://pinned.example.com/nocobase/admin',
  ]);

  targetInput.value = 'https://temporary.example.com/nocobase/admin';
  input(targetInput);
  shadow.querySelector('[data-action="pin-target"]').click();
  await flush();
  assert.equal(dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN].pinned, 'https://temporary.example.com/nocobase/admin');

  shadow = shadowRoot(dom);
  shadow.querySelector('[data-action="clear-target-history"]').click();
  await flush();
  assert.equal(dom.gmValues.get(TARGET_HISTORY_KEY)[ORIGIN], undefined);

  shadow = shadowRoot(dom);
  shadow.querySelector('[data-view="debug"]').click();
  assert.equal(shadow.querySelector('.nbce-debug-item.active'), null);

  internals.addDebugLog({
    id: 'req_1',
    method: 'GET',
    endpoint: 'users:list',
    url: `${ORIGIN}/api/users:list`,
    status: 200,
    statusText: 'OK',
    durationMs: 12,
    responseText: '{"ok":true}',
    responseMeta: {
      kind: 'text',
      truncated: false,
      omittedChars: 0,
    },
  });
  internals.addResourceDiagnostic({
    id: 'resource_1',
    level: 'error',
    kind: 'script',
    message: 'chunk load failed',
    url: `${ORIGIN}/umi.js`,
  });

  shadow = shadowRoot(dom);
  assert.match(shadow.querySelector('.nbce-debug-item.active').textContent, /users:list/);
  assert.equal(shadow.querySelector('.nbce-debug-selected').hidden, false);
  assert.match(shadow.querySelector('.nbce-debug-summary').textContent, /请求 1\/1 · 资源问题 1\/1/);
  const selectedDetail = shadow.querySelector('.nbce-debug-selected');
  const responseLabel = [...selectedDetail.children].find((element) => element.textContent === '响应 JSON');
  assert.ok(responseLabel, 'response JSON label should be visible in the selected request detail');
  assert.equal(
    [...selectedDetail.children].indexOf(responseLabel) < [...selectedDetail.children].indexOf(shadow.querySelector('.nbce-debug-meta')),
    true,
    'response JSON should appear before metadata so long diagnostics cannot push it below the fold',
  );
  assert.equal(shadow.querySelector('.nbce-debug-textarea').value, '{\n  "ok": true\n}');

  const resourceOnly = shadow.querySelector('[data-filter="resourceOnly"]');
  resourceOnly.checked = true;
  change(resourceOnly);
  assert.equal(shadow.querySelector('.nbce-debug-list').hidden, true);
  assert.equal(shadow.querySelector('.nbce-debug-grid').classList.contains('resource-only'), true);
  assert.equal(shadow.querySelector('.nbce-debug-selected').hidden, true);
  assert.equal(shadow.querySelector('.nbce-debug-resource').hidden, false);
  assert.match(shadow.querySelector('.nbce-debug-resource').textContent, /chunk load failed/);

  resourceOnly.checked = false;
  change(resourceOnly);
  assert.equal(shadow.querySelector('.nbce-debug-list').hidden, false);
  assert.equal(shadow.querySelector('.nbce-debug-grid').classList.contains('resource-only'), false);
  assert.match(shadow.querySelector('.nbce-debug-item.active').textContent, /users:list/);
  assert.equal(shadow.querySelector('.nbce-debug-selected').hidden, false);

  shadow.querySelector('[data-action="debug-copy-package"]').click();
  await flush();
  assert.match(dom.document._clipboardText, /capturedResponse =/);
  assert.match(dom.document._clipboardText, /\{"ok":true\}/);

  shadow.querySelector('#nbce-panel-toggle').click();
  assert.equal(shadow.querySelector('.nbce-toggle-badges'), null);
});

test('page bootstrap bridges client v2 /v/ API paths to the root target API path', async () => {
  let bootstrapSource = '';
  const gmRequests = [];
  const { context } = await loadUserscriptWithDom({
    locationHref: `${ORIGIN}/nocobase/v/admin`,
    GM_values: {
      [RULES_KEY]: {
        [ORIGIN]: {
          ...ruleFor(ORIGIN),
          targetEntryUrl: 'https://target.example.com/nocobase/v/apps/jhb20/admin',
          targetAppName: 'jhb20',
          targetPublicPath: '/nocobase/v/',
          targetRootPublicPath: '/nocobase/',
          apiBaseUrl: 'https://target.example.com/nocobase/api/',
          storagePath: '/nocobase/storage/uploads/',
        },
      },
    },
    onScriptAppended(node) {
      if ((node.textContent || '').includes('nbce-page-bootstrap.js')) {
        bootstrapSource = node.textContent;
      }
    },
    GM_xmlhttpRequest(request) {
      gmRequests.push(request);
      queueMicrotask(() => {
        request.onload?.({
          status: 200,
          statusText: 'OK',
          responseHeaders: 'content-type: application/json\r\n',
          responseText: '{"ok":true}',
          finalUrl: request.url,
        });
      });
      return {
        abort() {},
      };
    },
  });

  assert.ok(bootstrapSource, 'expected userscript to inject the page bootstrap for an enabled rule');
  Object.assign(context, {
    Request,
    Response,
    Headers,
    AbortController,
  });
  context.window.fetch = () => Promise.reject(new Error('request should have been bridged'));
  vm.runInNewContext(bootstrapSource, context, {
    filename: 'nbce-page-bootstrap.js',
  });

  const response = await context.window.fetch(`${ORIGIN}/nocobase/v/api/users:list?keyword=ada`);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(gmRequests.length, 1);
  assert.equal(gmRequests[0].url, 'https://target.example.com/nocobase/api/users:list?keyword=ada');
  assert.equal(gmRequests[0].headers['X-App'], 'jhb20');
});
