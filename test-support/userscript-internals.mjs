import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTestDom } from './minimal-dom.mjs';

function createStorage(initialValue = {}) {
  const storage = {
    get length() {
      return Object.keys(storage).filter((key) => !storageMethods.has(key)).length;
    },
    key(index) {
      return Object.keys(storage).filter((key) => !storageMethods.has(key))[index] || null;
    },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      storage[key] = `${value ?? ''}`;
    },
    removeItem(key) {
      delete storage[key];
    },
    clear() {
      Object.keys(storage)
        .filter((key) => !storageMethods.has(key))
        .forEach((key) => {
          delete storage[key];
        });
    },
  };
  const storageMethods = new Set(Object.keys(storage).concat('length'));
  Object.entries(initialValue || {}).forEach(([key, value]) => {
    storage[key] = `${value ?? ''}`;
  });
  return storage;
}

class TestMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}

  disconnect() {}

  takeRecords() {
    return [];
  }
}

export async function loadUserscriptInternals(options = {}) {
  if (options.dom || options.withDom) {
    const { internals } = await loadUserscriptWithDom(options);
    return internals;
  }

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
    queueMicrotask,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    FormData: globalThis.FormData,
    MutationObserver: TestMutationObserver,
    Element: TestElement,
    Event,
    MouseEvent: Event,
    navigator: {
      clipboard: options.navigatorClipboard,
    },
    localStorage: createStorage(options.localStorage),
    sessionStorage: createStorage(options.sessionStorage),
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
      queueMicrotask,
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

export async function loadUserscriptWithDom(options = {}) {
  const source = await readFile(new URL('../nocobase-cross-env.user.js', import.meta.url), 'utf8');
  const dom = options.dom || createTestDom(options);
  const context = {
    __NBCE_EXPOSE_INTERNALS_FOR_TEST__: true,
    NBCE_DEBUG: options.NBCE_DEBUG,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    FormData: globalThis.FormData,
    MutationObserver: TestMutationObserver,
    EventTarget: globalThis.EventTarget,
    Element: dom.Element,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    document: dom.document,
    window: dom.window,
    navigator: dom.window.navigator,
    location: dom.location,
    localStorage: createStorage(options.localStorage),
    sessionStorage: createStorage(options.sessionStorage),
    GM_getValue: dom.GM_getValue,
    GM_setValue: dom.GM_setValue,
    GM_registerMenuCommand: dom.GM_registerMenuCommand,
    GM_xmlhttpRequest: dom.GM_xmlhttpRequest,
  };
  context.globalThis = context;
  context.window.NBCE_DEBUG = options.windowNBCE_DEBUG;

  vm.runInNewContext(source, context, {
    filename: 'nocobase-cross-env.user.js',
  });

  assert.ok(context.__NBCE_TEST_INTERNALS__, 'userscript test internals were not exposed');
  return {
    internals: context.__NBCE_TEST_INTERNALS__,
    dom,
    context,
  };
}
