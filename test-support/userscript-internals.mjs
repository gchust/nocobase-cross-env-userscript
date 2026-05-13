import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

export async function loadUserscriptInternals(options = {}) {
  const source = await readFile(new URL('../nocobase-cross-env.user.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const locationUrl = new URL(options.locationHref || 'https://main.v2.test.nocobase.com/nocobase/admin');

  class TestElement {}

  const document = {
    scripts: [],
    head: null,
    body: null,
    documentElement: {},
    addEventListener(type, listener) {
      listeners.set(`document:${type}`, listener);
    },
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        style: {},
        appendChild() {},
        remove() {},
      };
    },
    getElementById() {
      return null;
    },
  };

  const context = {
    __NBCE_EXPOSE_INTERNALS_FOR_TEST__: true,
    NBCE_DEBUG: options.NBCE_DEBUG,
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Element: TestElement,
    location: {
      href: locationUrl.href,
      origin: locationUrl.origin,
      pathname: locationUrl.pathname,
      search: locationUrl.search,
      hash: locationUrl.hash,
      replace() {},
      reload() {},
    },
    document,
    window: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      postMessage() {},
      setTimeout,
      clearTimeout,
      location: locationUrl,
      NBCE_DEBUG: options.windowNBCE_DEBUG,
    },
    GM_getValue(_key, fallback) {
      return options.GM_debugEnabled ?? fallback;
    },
    GM_setValue() {},
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest() {},
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, {
    filename: 'nocobase-cross-env.user.js',
  });

  assert.ok(context.__NBCE_TEST_INTERNALS__, 'userscript test internals were not exposed');
  return context.__NBCE_TEST_INTERNALS__;
}
