// ==UserScript==
// @name         NocoBase Cross Env
// @namespace    https://nocobase.com/
// @version      0.3.5
// @description  在 NocoBase 实例 A 上，将前端请求桥接到实例 B，并支持目标子应用。
// @author       gchust
// @homepageURL   https://github.com/gchust/nocobase-cross-env-userscript
// @supportURL    https://github.com/gchust/nocobase-cross-env-userscript/issues
// @updateURL     https://gchust.github.io/nocobase-cross-env-userscript/nocobase-cross-env.user.js
// @downloadURL   https://gchust.github.io/nocobase-cross-env-userscript/nocobase-cross-env.user.js
// @match        http://*/*
// @match        https://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'nbce.rules.v1';
  const PANEL_POSITION_KEY = 'nbce.panelPosition.v1';
  const DEBUG_RULES_KEY = 'nbce.debugRules.v1';
  const PANEL_ROOT_ID = 'nbce-panel-root';
  const PANEL_TOGGLE_ID = 'nbce-panel-toggle';
  const BRIDGE_EVENT_TYPE = '__NBCE_USERSCRIPT_BRIDGE__';
  const BRIDGE_REPLY_TYPE = '__NBCE_USERSCRIPT_BRIDGE_REPLY__';
  const DEBUG_LOG_LIMIT = 80;
  const DEBUG_TEXT_LIMIT = 2000;
  const DEBUG_RESPONSE_TEXT_LIMIT = 200000;
  const pendingBridgeRequests = new Map();
  const debugLogs = [];
  const debugLogListeners = new Set();

  const rules = loadRules();
  const currentRule = normalizeRule(rules[location.origin] || null);
  const isRedirecting = currentRule?.enabled ? redirectToTargetSubAppIfNeeded(currentRule) : false;

  if (currentRule?.enabled && !isRedirecting) {
    injectPageBootstrap(currentRule);
  }

  if (isRedirecting) {
    return;
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('NocoBase Cross Env: 打开面板', () => {
      ensurePanel(true);
    });
  }

  window.addEventListener('message', handleBridgeRequest, false);
  window.addEventListener('DOMContentLoaded', () => {
    if (isProbablyNocoBasePage() || currentRule?.enabled) {
      ensurePanel(false);
    }
  });

  function loadRules() {
    try {
      const value = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, {}) : {};
      return isRecord(value) ? value : {};
    } catch (error) {
      console.warn('[nbce] failed to load rules', error);
      return {};
    }
  }

  function saveRules(nextRules) {
    if (typeof GM_setValue === 'function') {
      return Promise.resolve(GM_setValue(STORAGE_KEY, nextRules));
    }
    return Promise.resolve();
  }

  function loadPanelPositions() {
    try {
      const value = typeof GM_getValue === 'function' ? GM_getValue(PANEL_POSITION_KEY, {}) : {};
      return isRecord(value) ? value : {};
    } catch (error) {
      console.warn('[nbce] failed to load panel position', error);
      return {};
    }
  }

  function savePanelPosition(position) {
    if (typeof GM_setValue !== 'function') {
      return Promise.resolve();
    }
    const positions = loadPanelPositions();
    positions[location.origin] = position;
    return Promise.resolve(GM_setValue(PANEL_POSITION_KEY, positions));
  }

  function loadDebugRulesStore() {
    try {
      const value = typeof GM_getValue === 'function' ? GM_getValue(DEBUG_RULES_KEY, {}) : {};
      return isRecord(value) ? value : {};
    } catch (error) {
      console.warn('[nbce] failed to load debug rules', error);
      return {};
    }
  }

  function saveDebugRulesStore(nextStore) {
    if (typeof GM_setValue === 'function') {
      return Promise.resolve(GM_setValue(DEBUG_RULES_KEY, nextStore));
    }
    return Promise.resolve();
  }

  function buildDebugRuleKey(method, endpoint) {
    return `${`${method || 'GET'}`.toUpperCase()} ${`${endpoint || ''}`.trim()}`;
  }

  function normalizeDebugRule(rule) {
    if (!isRecord(rule) || rule.mode !== 'responseOverride') {
      return null;
    }
    const method = `${rule.method || 'GET'}`.toUpperCase();
    const endpoint = `${rule.endpoint || ''}`.trim();
    if (!endpoint || typeof rule.responseText !== 'string') {
      return null;
    }
    return {
      id: rule.id || buildDebugRuleKey(method, endpoint),
      key: rule.key || buildDebugRuleKey(method, endpoint),
      mode: 'responseOverride',
      enabled: rule.enabled !== false,
      method,
      endpoint,
      responseText: rule.responseText,
      status: Number(rule.status) || 200,
      statusText: rule.statusText || 'OK',
      responseHeaders: rule.responseHeaders || 'content-type: application/json\r\nx-nbce-debug: response-override\r\n',
      createdAt: rule.createdAt || new Date().toISOString(),
      updatedAt: rule.updatedAt || new Date().toISOString(),
    };
  }

  function getDebugRulesForOrigin(origin = location.origin) {
    const store = loadDebugRulesStore();
    const originRules = isRecord(store[origin]) ? store[origin] : {};
    const normalized = {};
    Object.entries(originRules).forEach(([key, rule]) => {
      const nextRule = normalizeDebugRule({ key, ...rule });
      if (nextRule) {
        normalized[nextRule.key] = nextRule;
      }
    });
    return normalized;
  }

  async function saveDebugRuleForOrigin(rule, origin = location.origin) {
    const normalizedRule = normalizeDebugRule(rule);
    if (!normalizedRule) {
      throw new Error('调试规则无效');
    }
    const store = loadDebugRulesStore();
    const originRules = isRecord(store[origin]) ? store[origin] : {};
    originRules[normalizedRule.key] = normalizedRule;
    store[origin] = originRules;
    await saveDebugRulesStore(store);
    notifyDebugLogListeners();
    return normalizedRule;
  }

  async function deleteDebugRuleForOrigin(method, endpoint, origin = location.origin) {
    const store = loadDebugRulesStore();
    const originRules = isRecord(store[origin]) ? store[origin] : {};
    const key = buildDebugRuleKey(method, endpoint);
    delete originRules[key];
    store[origin] = originRules;
    await saveDebugRulesStore(store);
    notifyDebugLogListeners();
  }

  async function clearDebugRulesForOrigin(origin = location.origin) {
    const store = loadDebugRulesStore();
    store[origin] = {};
    await saveDebugRulesStore(store);
    notifyDebugLogListeners();
  }

  function findDebugResponseOverride(method, endpoint) {
    const key = buildDebugRuleKey(method, endpoint);
    const rule = getDebugRulesForOrigin()[key];
    return rule?.enabled ? rule : null;
  }

  function subscribeDebugLogs(listener) {
    debugLogListeners.add(listener);
    return () => {
      debugLogListeners.delete(listener);
    };
  }

  function notifyDebugLogListeners() {
    debugLogListeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.warn('[nbce] failed to notify debug listener', error);
      }
    });
  }

  function truncateDebugText(value, limit = DEBUG_TEXT_LIMIT) {
    const text = `${value ?? ''}`;
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}\n... 已截断 ${text.length - limit} 个字符`;
  }

  function captureDebugResponseText(value) {
    const text = `${value ?? ''}`;
    if (text.length <= DEBUG_RESPONSE_TEXT_LIMIT) {
      return { text, truncated: false };
    }
    return {
      text: text.slice(0, DEBUG_RESPONSE_TEXT_LIMIT),
      truncated: true,
    };
  }

  function summarizeDebugBody(body) {
    if (!isRecord(body) || body.kind === 'none') {
      return '';
    }
    if (body.kind === 'text') {
      return truncateDebugText(body.value);
    }
    if (body.kind === 'formData' && typeof body.value?.forEach === 'function') {
      const entries = [];
      body.value.forEach((value, key) => {
        if (value instanceof Blob) {
          entries.push(`${key}: [Blob ${value.size} bytes]`);
          return;
        }
        entries.push(`${key}: ${truncateDebugText(value, 240)}`);
      });
      return truncateDebugText(entries.join('\n'));
    }
    if (body.kind === 'blob') {
      return `[Blob ${Number(body.value?.size) || 0} bytes]`;
    }
    if (body.kind === 'arrayBuffer') {
      return `[ArrayBuffer ${Number(body.value?.byteLength) || 0} bytes]`;
    }
    return truncateDebugText(body.value);
  }

  function extractDebugEndpoint(requestUrl, rule) {
    let url;
    try {
      url = new URL(requestUrl, location.origin);
    } catch (error) {
      return '';
    }

    const candidatePrefixes = [];
    [rule?.apiBaseUrl, rule?.sourceApiBaseUrl].forEach((value) => {
      if (!value) {
        return;
      }
      try {
        const prefixUrl = new URL(value, rule?.targetOrigin || location.origin);
        if (prefixUrl.origin === url.origin) {
          candidatePrefixes.push(normalizePath(prefixUrl.pathname || '/api/'));
        }
      } catch (error) {
        // Ignore malformed configured URLs.
      }
    });
    candidatePrefixes.push('/api/');

    for (const prefix of candidatePrefixes) {
      const normalizedPrefix = normalizePath(prefix);
      if (url.pathname === normalizedPrefix.slice(0, -1)) {
        return '';
      }
      if (url.pathname.startsWith(normalizedPrefix)) {
        return safeDecodeURIComponent(normalizeRelativePath(url.pathname.slice(normalizedPrefix.length)));
      }
    }

    const segments = splitPathSegments(url.pathname);
    const apiIndex = segments.findIndex((segment) => segment === 'api');
    if (apiIndex >= 0) {
      return safeDecodeURIComponent(normalizeRelativePath(segments.slice(apiIndex + 1).join('/')));
    }
    return safeDecodeURIComponent(normalizeRelativePath(url.pathname));
  }

  function addDebugLog(entry) {
    const nextEntry = {
      id: entry.id || `debug_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      at: entry.at || new Date().toISOString(),
      method: `${entry.method || 'GET'}`.toUpperCase(),
      endpoint: entry.endpoint || '',
      url: entry.url || '',
      originalUrl: entry.originalUrl || '',
      status: Number(entry.status) || 0,
      statusText: entry.statusText || '',
      durationMs: Number(entry.durationMs) || 0,
      requestBodySummary: entry.requestBodySummary || '',
      responseText: entry.responseText || '',
      responseTruncated: Boolean(entry.responseTruncated),
      responseHeaders: entry.responseHeaders || '',
      ok: entry.ok !== false,
      overridden: Boolean(entry.overridden),
      error: entry.error || '',
    };
    debugLogs.unshift(nextEntry);
    if (debugLogs.length > DEBUG_LOG_LIMIT) {
      debugLogs.length = DEBUG_LOG_LIMIT;
    }
    notifyDebugLogListeners();
    return nextEntry;
  }

  function getPanelPosition() {
    const position = loadPanelPositions()[location.origin];
    if (!isRecord(position)) {
      return null;
    }
    const left = Number(position.left);
    const top = Number(position.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
    const edge = ['left', 'right', 'top', 'bottom'].includes(position.edge) ? position.edge : undefined;
    return { left, top, edge };
  }

  function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function hashString(input) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  function encodePathSegment(value) {
    return encodeURIComponent(`${value || ''}`);
  }

  function trimLeadingSlashes(value) {
    return `${value || ''}`.replace(/^\/+/, '');
  }

  function trimTrailingSlashes(value) {
    return `${value || ''}`.replace(/\/+$/g, '');
  }

  function normalizePath(value, fallback = '/') {
    let pathname = `${value || fallback}`.trim();
    if (!pathname) {
      pathname = fallback;
    }
    if (!pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }
    pathname = pathname.replace(/\/{2,}/g, '/');
    if (!pathname.endsWith('/')) {
      pathname = `${pathname}/`;
    }
    return pathname;
  }

  function normalizePathname(value, fallback = '/') {
    let pathname = `${value || fallback}`.trim();
    if (!pathname) {
      pathname = fallback;
    }
    if (!pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }
    pathname = pathname.replace(/\/{2,}/g, '/');
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = trimTrailingSlashes(pathname);
    }
    return pathname || '/';
  }

  function normalizeRelativePath(value) {
    return trimLeadingSlashes(`${value || ''}`.trim()).replace(/\/{2,}/g, '/');
  }

  function normalizeWsPath(value, fallback = '/ws') {
    let pathname = `${value || fallback}`.trim();
    if (!pathname) {
      pathname = fallback;
    }
    if (!pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }
    return pathname.replace(/\/{2,}/g, '/').replace(/\/$/g, '') || '/ws';
  }

  function joinPath(basePath, relativePath) {
    const base = normalizePath(basePath);
    const child = `${relativePath || ''}`.replace(/^\/+/g, '');
    return normalizePath(`${base}${child}`);
  }

  function joinRoutePath(basePath, relativePath) {
    const base = normalizePath(basePath);
    const child = normalizeRelativePath(relativePath);
    return child ? `${base}${child}` : base.replace(/\/$/g, '') || '/';
  }

  function splitPathSegments(pathname) {
    return normalizePathname(pathname).split('/').filter(Boolean);
  }

  function segmentsToPath(segments, trailingSlash) {
    if (!segments.length) {
      return '/';
    }
    const pathname = `/${segments.join('/')}`;
    return trailingSlash ? `${pathname}/` : pathname;
  }

  function extractNocoBaseAppRoute(pathname) {
    const segments = splitPathSegments(pathname);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const marker = segments[index];
      if (marker !== 'apps' && marker !== '_app') {
        continue;
      }
      const appNameSegment = segments[index + 1];
      const usesV2 = index > 0 && segments[index - 1] === 'v2';
      const rootSegments = usesV2 ? segments.slice(0, index - 1) : segments.slice(0, index);
      const appBaseSegments = segments.slice(0, index + 2);
      const restSegments = segments.slice(index + 2);
      return {
        kind: marker,
        appName: safeDecodeURIComponent(appNameSegment),
        appNameSegment,
        usesV2,
        rootPublicPath: segmentsToPath(rootSegments, true),
        appBasePath: segmentsToPath(appBaseSegments, true),
        restPath: normalizeRelativePath(restSegments.join('/')),
      };
    }
    return null;
  }

  function toRootPublicPath(publicPath) {
    const normalized = normalizePath(publicPath || '/');
    if (normalized.endsWith('/v2/')) {
      return normalizePath(normalized.slice(0, -'/v2/'.length) || '/');
    }
    return normalized;
  }

  function inferRootPublicPathFromPathname(pathname) {
    const route = extractNocoBaseAppRoute(pathname);
    if (route) {
      return route.rootPublicPath;
    }
    const normalizedPathname = normalizePathname(pathname);
    const marker = '/v2/';
    const markerIndex = normalizedPathname.indexOf(marker);
    if (markerIndex >= 0) {
      return normalizePath(normalizedPathname.slice(0, markerIndex) || '/');
    }
    const segments = splitPathSegments(normalizedPathname);
    const entryIndex = segments.findIndex((segment) =>
      ['admin', 'signin', 'signup', 'forgot-password', 'reset-password'].includes(segment),
    );
    if (entryIndex > 0) {
      return segmentsToPath(segments.slice(0, entryIndex), true);
    }
    return '/';
  }

  function getRuntimeWindowValue(name) {
    try {
      const value = window[name];
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }

  function extractRuntimeValue(html, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`window\\[['"]${escapedName}['"]\\]\\s*=\\s*(['"])(.*?)\\1`, 's'),
      new RegExp(`${escapedName}\\s*=\\s*(['"])(.*?)\\1`, 's'),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return match[2];
      }
    }
    return '';
  }

  function extractCurrentRuntimeValue(name) {
    const fromWindow = getRuntimeWindowValue(name);
    if (fromWindow) {
      return fromWindow;
    }
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const value = extractRuntimeValue(script.textContent || '', name);
      if (value) {
        return value;
      }
    }
    return '';
  }

  function normalizeAssetBaseUrl(value) {
    const rawValue = `${value || ''}`.trim();
    if (!rawValue) {
      return '';
    }
    try {
      const url = new URL(rawValue, location.href);
      const href = url.toString();
      return href.endsWith('/') ? href : `${href}/`;
    } catch (error) {
      return rawValue.endsWith('/') ? rawValue : `${rawValue}/`;
    }
  }

  function getCurrentSourceWebpackPublicPath() {
    const fromRuntime = extractCurrentRuntimeValue('__webpack_public_path__');
    if (fromRuntime) {
      return normalizeAssetBaseUrl(fromRuntime);
    }

    const scripts = Array.from(document.scripts || []);
    const umiScript = scripts
      .map((script) => script.src || script.getAttribute('src') || '')
      .find((src) => /\/umi(?:\.[^/?#]+)?\.js(?:[?#].*)?$/i.test(src));
    if (!umiScript) {
      return '';
    }

    try {
      const url = new URL(umiScript, location.href);
      url.pathname = url.pathname.replace(/\/[^/]*$/g, '/');
      url.search = '';
      url.hash = '';
      return normalizeAssetBaseUrl(url.toString());
    } catch (error) {
      return '';
    }
  }

  function getCurrentSourcePublicPath() {
    const fromRuntime = extractCurrentRuntimeValue('__nocobase_public_path__');
    if (fromRuntime) {
      return normalizePath(fromRuntime);
    }
    const route = extractNocoBaseAppRoute(location.pathname);
    if (route?.usesV2) {
      return joinPath(route.rootPublicPath, 'v2/');
    }
    if (normalizePathname(location.pathname).includes('/v2/')) {
      return joinPath(inferRootPublicPathFromPathname(location.pathname), 'v2/');
    }
    return inferRootPublicPathFromPathname(location.pathname);
  }

  function getCurrentSourceRootPublicPath() {
    return toRootPublicPath(getCurrentSourcePublicPath());
  }

  function joinMirrorRoute(rootPublicPath, restPath, usesV2) {
    const root = normalizePath(rootPublicPath || '/');
    const prefix = `${root}${usesV2 ? 'v2/' : ''}`.replace(/\/{2,}/g, '/');
    return joinRoutePath(prefix, restPath || 'admin/');
  }

  function isPathInsidePrefix(pathname, prefix) {
    const normalizedPathname = normalizePathname(pathname);
    const normalizedPrefix = normalizePath(prefix);
    return normalizedPathname === normalizedPrefix.slice(0, -1) || normalizedPathname.startsWith(normalizedPrefix);
  }

  function stripPathPrefix(pathname, prefix) {
    const normalizedPathname = normalizePathname(pathname);
    const normalizedPrefix = normalizePath(prefix);
    if (normalizedPathname === normalizedPrefix.slice(0, -1)) {
      return '';
    }
    if (normalizedPathname.startsWith(normalizedPrefix)) {
      return normalizeRelativePath(normalizedPathname.slice(normalizedPrefix.length));
    }
    return normalizeRelativePath(normalizedPathname);
  }

  function getSourceRootPublicPathForRule(rule, pathname = location.pathname) {
    return normalizePath(rule.sourceRootPublicPath || inferRootPublicPathFromPathname(pathname) || '/');
  }

  function buildTargetAppPathForPathname(rule, pathname, options = {}) {
    if (!rule?.targetAppName) {
      return null;
    }

    const currentRoute = extractNocoBaseAppRoute(pathname);
    if (currentRoute) {
      const restPath = currentRoute.restPath || (options.useTargetEntryForRoot ? rule.targetAppEntryPath : '') || 'admin/';
      return joinMirrorRoute(getSourceRootPublicPathForRule(rule, pathname), restPath, currentRoute.usesV2);
    }

    const rootPublicPath = getSourceRootPublicPathForRule(rule, pathname);
    const normalizedPathname = normalizePathname(pathname);
    const v2PublicPath = joinPath(rootPublicPath, 'v2/');
    const usesV2 = isPathInsidePrefix(normalizedPathname, v2PublicPath);
    const basePublicPath = usesV2 ? v2PublicPath : rootPublicPath;
    let restPath = stripPathPrefix(normalizedPathname, basePublicPath);

    if (!restPath && options.useTargetEntryForRoot) {
      restPath = rule.targetAppEntryPath || 'admin/';
    }
    if (!restPath) {
      restPath = 'admin/';
    }

    return joinMirrorRoute(rootPublicPath, restPath, usesV2);
  }

  function isSigninPath(pathname) {
    const route = extractNocoBaseAppRoute(pathname);
    const restPath = route ? route.restPath : normalizeRelativePath(stripPathPrefix(pathname, inferRootPublicPathFromPathname(pathname)));
    return restPath === 'signin' || restPath.endsWith('/signin');
  }

  function buildDefaultSubAppAdminPath(rule, referencePathname = location.pathname) {
    const rootPublicPath = getSourceRootPublicPathForRule(rule, referencePathname);
    const currentRoute = extractNocoBaseAppRoute(referencePathname);
    const usesV2 = currentRoute?.usesV2 || isPathInsidePrefix(referencePathname, joinPath(rootPublicPath, 'v2/'));
    return joinMirrorRoute(rootPublicPath, 'admin/', usesV2);
  }

  function mapRedirectValueToTargetApp(value, rule) {
    if (!value || !rule?.targetAppName) {
      return value;
    }
    let url;
    try {
      url = new URL(value, location.origin);
    } catch (error) {
      return value;
    }
    if (url.origin !== location.origin) {
      return value;
    }
    const nextPathname = buildTargetAppPathForPathname(rule, url.pathname);
    if (!nextPathname) {
      return value;
    }
    return `${nextPathname}${url.search}${url.hash}`;
  }

  function rewriteRedirectSearchForTargetApp(search, rule, targetPathname) {
    if (!rule?.targetAppName) {
      return search || '';
    }
    const params = new URLSearchParams(search || '');
    let changed = false;
    const redirect = params.get('redirect');

    if (redirect) {
      const nextRedirect = mapRedirectValueToTargetApp(redirect, rule);
      if (nextRedirect !== redirect) {
        params.set('redirect', nextRedirect);
        changed = true;
      }
    } else if (isSigninPath(targetPathname)) {
      params.set('redirect', buildDefaultSubAppAdminPath(rule, targetPathname));
      changed = true;
    }

    if (!changed) {
      return search || '';
    }
    const nextSearch = params.toString();
    return nextSearch ? `?${nextSearch}` : '';
  }

  function redirectToTargetSubAppIfNeeded(rule) {
    if (!rule?.targetAppName || isSpecialSchemeUrl(location.href)) {
      return false;
    }

    const currentRoute = extractNocoBaseAppRoute(location.pathname);
    const nextPathname = currentRoute
      ? buildTargetAppPathForPathname(rule, location.pathname, { useTargetEntryForRoot: false })
      : location.pathname;
    if (!nextPathname) {
      return false;
    }

    const nextSearch = rewriteRedirectSearchForTargetApp(location.search, rule, nextPathname);
    if (nextPathname === location.pathname && nextSearch === (location.search || '')) {
      return false;
    }

    const nextUrl = new URL(location.href);
    nextUrl.pathname = nextPathname;
    nextUrl.search = nextSearch;
    location.replace(nextUrl.toString());
    return true;
  }

  function buildLocalEntryHref(rule) {
    if (!rule?.targetAppName) {
      return location.href;
    }
    const targetUrl = new URL(rule.targetEntryUrl);
    const targetRoute = extractNocoBaseAppRoute(targetUrl.pathname);
    const rootPublicPath = getSourceRootPublicPathForRule(rule);
    const nextUrl = new URL(location.href);
    nextUrl.pathname = joinMirrorRoute(
      rootPublicPath,
      targetRoute?.restPath || rule.targetAppEntryPath || 'admin/',
      Boolean(targetRoute?.usesV2),
    );
    nextUrl.search = targetUrl.search || '';
    nextUrl.hash = targetUrl.hash || '';
    nextUrl.search = rewriteRedirectSearchForTargetApp(nextUrl.search, rule, nextUrl.pathname);
    return nextUrl.toString();
  }

  function escapeHtml(value) {
    return `${value ?? ''}`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stringifyError(error) {
    if (!error) {
      return '未知错误';
    }
    if (typeof error === 'string') {
      return error;
    }
    return error.message || String(error);
  }

  function isSpecialSchemeUrl(value) {
    return /^(data:|blob:|javascript:|mailto:|tel:|about:|chrome:|edge:|moz-extension:)/i.test(`${value || ''}`);
  }

  function isAbsoluteHttpLikeUrl(value) {
    return /^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(`${value || ''}`);
  }

  function isNocoBaseEndpointShorthand(value) {
    const input = `${value || ''}`.trim();
    if (!input || input.startsWith('/') || input.startsWith('./') || input.startsWith('../') || input.startsWith('?') || input.startsWith('#')) {
      return false;
    }
    if (isSpecialSchemeUrl(input) || isAbsoluteHttpLikeUrl(input)) {
      return false;
    }
    return /^[a-z][a-z\d+\-.]*:[^/].*$/i.test(input);
  }

  function joinApiEndpoint(baseUrl, endpoint) {
    const resolvedBase = new URL(baseUrl, location.origin);
    const suffix = `${endpoint || ''}`.replace(/^\/+/g, '');
    resolvedBase.pathname = `${resolvedBase.pathname.replace(/\/?$/g, '/')}${suffix}`.replace(/\/{2,}/g, '/');
    return resolvedBase.toString();
  }

  function buildSubAppApiBaseUrl(apiBaseUrl) {
    // NocoBase 子应用不是通过 /api/__app/<name>/ 选择的。
    // 网关接受 X-App 请求头或 __appName 查询参数；拼进路径会导致 Not Found。
    return new URL(apiBaseUrl, location.origin).toString();
  }

  function getEffectiveApiBaseUrl(rule) {
    return buildSubAppApiBaseUrl(rule.apiBaseUrl, rule.targetAppName);
  }

  function appendSubAppQueryToUrl(value, appName) {
    if (!value || !appName) {
      return value || '';
    }
    try {
      const url = new URL(value, location.origin);
      if (!url.searchParams.has('__appName') && !url.searchParams.has('_app')) {
        url.searchParams.set('__appName', appName);
      }
      return url.toString();
    } catch (error) {
      return value;
    }
  }

  function getEffectiveWsUrl(rule) {
    return appendSubAppQueryToUrl(rule.wsUrl || '', rule.targetAppName) || rule.wsPath;
  }

  function rewritePluginClientUrlToSourcePublicPath(value, rule, requestOrigin) {
    const sourceWebpackPublicPath = normalizeAssetBaseUrl(
      rule?.sourceWebpackPublicPath || getCurrentSourceWebpackPublicPath(),
    );
    if (!sourceWebpackPublicPath) {
      try {
        return new URL(value, requestOrigin).toString();
      } catch (error) {
        return value;
      }
    }

    try {
      const url = new URL(value, requestOrigin);
      const match = url.pathname.match(/(?:^|\/)static\/plugins\/(.+\/dist\/client\/index\.js)$/i);
      if (!match) {
        return url.toString();
      }

      const rewritten = new URL(sourceWebpackPublicPath);
      rewritten.pathname = `${rewritten.pathname.replace(/\/?$/g, '/')}${trimLeadingSlashes(
        `static/plugins/${match[1]}`,
      )}`.replace(/\/{2,}/g, '/');
      rewritten.search = url.search;
      rewritten.hash = url.hash;
      return rewritten.toString();
    } catch (error) {
      return value;
    }
  }

  function rewritePmListEnabledResponseText(rule, requestUrl, responseText) {
    if (!requestUrl || typeof responseText !== 'string' || !responseText.trim()) {
      return responseText;
    }

    let resolvedRequestUrl;
    try {
      resolvedRequestUrl = new URL(requestUrl, location.origin);
    } catch (error) {
      return responseText;
    }

    if (!resolvedRequestUrl.pathname.endsWith('/pm:listEnabled')) {
      return responseText;
    }

    try {
      const payload = JSON.parse(responseText);
      if (!Array.isArray(payload?.data)) {
        return responseText;
      }
      payload.data = payload.data.map((item) => {
        if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !item.url) {
          return item;
        }
        try {
          return {
            ...item,
            url: rewritePluginClientUrlToSourcePublicPath(item.url, rule, resolvedRequestUrl.origin),
          };
        } catch (error) {
          return item;
        }
      });
      return JSON.stringify(payload);
    } catch (error) {
      return responseText;
    }
  }

  function isApiOrAssetPathname(pathname) {
    const normalized = normalizePathname(pathname);
    return (
      /\/api(?:\/|$)/i.test(normalized) ||
      /\/storage\/uploads(?:\/|$)/i.test(normalized) ||
      /\/plugins(?:\/|$)/i.test(normalized) ||
      /\/static(?:\/|$)/i.test(normalized) ||
      /\/assets(?:\/|$)/i.test(normalized) ||
      /\.[a-z0-9]{2,8}$/i.test(normalized)
    );
  }

  function isNavigationRewriteKey(key) {
    return /^(redirect|redirectTo|returnTo|callbackUrl|location|href|url|path|to|link|_runtimePath)$/i.test(`${key || ''}`);
  }

  function isHardRedirectKey(key) {
    return /^(redirectTo|returnTo|callbackUrl|location)$/i.test(`${key || ''}`);
  }

  function rewriteNavigationStringForRule(value, rule, key) {
    if (!rule?.targetAppName || typeof value !== 'string' || !value.trim() || isSpecialSchemeUrl(value)) {
      return value;
    }

    const trimmed = value.trim();
    const isAbsolute = isAbsoluteHttpLikeUrl(trimmed);
    const isRootRelative = trimmed.startsWith('/');
    if (!isAbsolute && !isRootRelative) {
      return value;
    }

    let url;
    try {
      url = new URL(trimmed, location.origin);
    } catch (error) {
      return value;
    }

    if (url.origin !== location.origin && url.origin !== rule.targetOrigin) {
      return value;
    }
    if (isApiOrAssetPathname(url.pathname)) {
      return value;
    }

    const route = extractNocoBaseAppRoute(url.pathname);
    const shouldRewritePath = Boolean(route) || isHardRedirectKey(key);
    if (!shouldRewritePath) {
      return value;
    }

    const nextPathname = buildTargetAppPathForPathname(rule, url.pathname);
    if (!nextPathname) {
      return value;
    }

    const redirect = url.searchParams.get('redirect');
    if (redirect) {
      const nextRedirect = mapRedirectValueToTargetApp(redirect, rule);
      if (nextRedirect !== redirect) {
        url.searchParams.set('redirect', nextRedirect);
      }
    }

    if (isAbsolute) {
      const nextUrl = new URL(location.href);
      nextUrl.pathname = nextPathname;
      nextUrl.search = url.search;
      nextUrl.hash = url.hash;
      return nextUrl.toString();
    }

    return `${nextPathname}${url.search}${url.hash}`;
  }

  function rewriteJsonNavigationValues(value, rule, key = '') {
    if (typeof value === 'string') {
      return isNavigationRewriteKey(key) ? rewriteNavigationStringForRule(value, rule, key) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => rewriteJsonNavigationValues(item, rule, key));
    }
    if (!isRecord(value)) {
      return value;
    }
    let changed = false;
    const nextValue = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      const rewritten = rewriteJsonNavigationValues(childValue, rule, childKey);
      nextValue[childKey] = rewritten;
      if (rewritten !== childValue) {
        changed = true;
      }
    });
    return changed ? nextValue : value;
  }

  function rewriteBridgeResponseText(rule, requestUrl, responseText) {
    const pluginRewrittenText = rewritePmListEnabledResponseText(rule, requestUrl, responseText);
    if (!rule?.targetAppName || typeof pluginRewrittenText !== 'string' || !pluginRewrittenText.trim()) {
      return pluginRewrittenText;
    }

    try {
      const payload = JSON.parse(pluginRewrittenText);
      const rewritten = rewriteJsonNavigationValues(payload, rule);
      return rewritten === payload ? pluginRewrittenText : JSON.stringify(rewritten);
    } catch (error) {
      return pluginRewrittenText;
    }
  }

  function buildAbsoluteUrl(value, origin, fallbackPath) {
    const fallback = new URL(fallbackPath, origin).toString();
    if (!value) {
      return fallback;
    }
    try {
      return new URL(value, origin).toString();
    } catch (error) {
      return fallback;
    }
  }

  function derivePublicPathFromUrl(targetUrl) {
    const pathname = new URL(targetUrl).pathname || '/';
    const route = extractNocoBaseAppRoute(pathname);
    if (route) {
      return route.usesV2 ? joinPath(route.rootPublicPath, 'v2/') : route.rootPublicPath;
    }
    const markerIndex = pathname.indexOf('/v2/');
    if (markerIndex >= 0) {
      return normalizePath(pathname.slice(0, markerIndex + '/v2/'.length));
    }
    const segments = splitPathSegments(pathname);
    const entryIndex = segments.findIndex((segment) =>
      ['admin', 'signin', 'signup', 'forgot-password', 'reset-password'].includes(segment),
    );
    if (entryIndex > 0) {
      return segmentsToPath(segments.slice(0, entryIndex), true);
    }
    if (!pathname || pathname === '/') {
      return '/';
    }
    return normalizePath(pathname);
  }

  function normalizeRule(rule) {
    if (!rule || !isRecord(rule)) {
      return null;
    }
    if (!rule.targetEntryUrl || !rule.apiBaseUrl) {
      return null;
    }

    let targetEntryUrl;
    try {
      targetEntryUrl = new URL(rule.targetEntryUrl).toString();
    } catch (error) {
      return null;
    }

    const targetUrl = new URL(targetEntryUrl);
    const targetRoute = extractNocoBaseAppRoute(targetUrl.pathname);
    const targetPublicPath = normalizePath(rule.targetPublicPath || derivePublicPathFromUrl(targetEntryUrl));
    const targetRootPublicPath = normalizePath(rule.targetRootPublicPath || toRootPublicPath(targetPublicPath));
    const targetAppName = `${rule.targetAppName || targetRoute?.appName || ''}`.trim();
    const sourcePublicPath = normalizePath(rule.sourcePublicPath || getCurrentSourcePublicPath());
    const sourceRootPublicPath = normalizePath(rule.sourceRootPublicPath || toRootPublicPath(sourcePublicPath));
    const storagePrefix = rule.storagePrefix || `NBCE_${hashString(targetEntryUrl)}_`;

    return {
      sourceOrigin: rule.sourceOrigin || location.origin,
      sourcePublicPath,
      sourceRootPublicPath,
      sourceWebpackPublicPath: rule.sourceWebpackPublicPath || getCurrentSourceWebpackPublicPath(),
      sourceApiBaseUrl: rule.sourceApiBaseUrl || '',
      targetEntryUrl,
      targetOrigin: rule.targetOrigin || targetUrl.origin,
      targetPublicPath,
      targetRootPublicPath,
      targetAppName,
      targetAppRouteKind: rule.targetAppRouteKind || targetRoute?.kind || 'apps',
      targetAppUsesV2: Boolean(rule.targetAppUsesV2 || targetRoute?.usesV2),
      targetAppEntryPath: normalizeRelativePath(rule.targetAppEntryPath ?? targetRoute?.restPath ?? ''),
      apiBaseUrl: buildSubAppApiBaseUrl(rule.apiBaseUrl, targetAppName),
      wsUrl: rule.wsUrl || '',
      wsPath: normalizeWsPath(rule.wsPath || joinRoutePath(targetRootPublicPath, 'ws')),
      storagePath: normalizePath(rule.storagePath || joinPath(targetRootPublicPath, 'storage/uploads/')),
      storagePrefix,
      enabled: rule.enabled !== false,
      createdAt: rule.createdAt || new Date().toISOString(),
      updatedAt: rule.updatedAt || new Date().toISOString(),
      diagnostics: Array.isArray(rule.diagnostics) ? rule.diagnostics : [],
    };
  }

  function createBridgeError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createGMRequest(options) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      throw createBridgeError('当前油猴环境不支持 GM_xmlhttpRequest', 'UNSUPPORTED');
    }

    let settled = false;
    let requestHandle = null;
    let rejectRequest = null;

    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject;
      const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : null;
      const requestOptions = {
        method: options.method || 'GET',
        url: options.url,
        headers: options.headers || {},
        data: options.data,
        responseType: options.responseType,
        onload(response) {
          if (settled) {
            return;
          }
          settled = true;
          resolve(response);
        },
        onerror(error) {
          if (settled) {
            return;
          }
          settled = true;
          reject(createBridgeError(error?.error || '请求失败', 'NETWORK_ERR'));
        },
        ontimeout() {
          if (settled) {
            return;
          }
          settled = true;
          reject(createBridgeError('请求超时', 'TIMEOUT_ERR'));
        },
        onabort() {
          if (settled) {
            return;
          }
          settled = true;
          reject(createBridgeError('请求已取消', 'ABORT_ERR'));
        },
      };
      if (timeoutMs) {
        requestOptions.timeout = timeoutMs;
      }
      requestHandle = GM_xmlhttpRequest(requestOptions);
    });

    return {
      promise,
      abort() {
        if (settled) {
          return;
        }
        settled = true;
        try {
          requestHandle?.abort?.();
        } catch (error) {
          console.warn('[nbce] failed to abort request', error);
        }
        rejectRequest?.(createBridgeError('请求已取消', 'ABORT_ERR'));
      },
    };
  }

  function requestViaGM(options) {
    return createGMRequest(options).promise;
  }

  async function parseTargetEntry(targetEntryUrl) {
    const normalizedEntryUrl = new URL(targetEntryUrl).toString();
    const response = await requestViaGM({
      method: 'GET',
      url: normalizedEntryUrl,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });
    const html = response.responseText || '';
    const targetUrl = new URL(normalizedEntryUrl);
    const targetOrigin = targetUrl.origin;
    const targetRoute = extractNocoBaseAppRoute(targetUrl.pathname);
    const publicPath = normalizePath(
      extractRuntimeValue(html, '__nocobase_public_path__') || derivePublicPathFromUrl(normalizedEntryUrl),
    );
    const rootPublicPath = toRootPublicPath(publicPath);
    const apiBaseUrl = buildAbsoluteUrl(
      extractRuntimeValue(html, '__nocobase_api_base_url__'),
      targetOrigin,
      joinPath(rootPublicPath, 'api/'),
    );
    const wsPath = normalizeWsPath(
      extractRuntimeValue(html, '__nocobase_ws_path__'),
      rootPublicPath === '/' ? '/ws' : `${rootPublicPath.replace(/\/$/g, '')}/ws`,
    );
    const explicitWsUrl = extractRuntimeValue(html, '__nocobase_ws_url__');
    const protocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = explicitWsUrl || new URL(wsPath, `${protocol}//${targetUrl.host}`).toString();
    const storagePath = joinPath(rootPublicPath, 'storage/uploads/');

    const sourceRootPublicPath = getCurrentSourceRootPublicPath();
    const sourceApiBaseUrl = buildAbsoluteUrl(
      extractCurrentRuntimeValue('__nocobase_api_base_url__'),
      location.origin,
      joinPath(sourceRootPublicPath, 'api/'),
    );

    return normalizeRule({
      sourceOrigin: location.origin,
      sourcePublicPath: getCurrentSourcePublicPath(),
      sourceRootPublicPath,
      sourceWebpackPublicPath: getCurrentSourceWebpackPublicPath(),
      sourceApiBaseUrl,
      targetEntryUrl: normalizedEntryUrl,
      targetOrigin,
      targetPublicPath: publicPath,
      targetRootPublicPath: rootPublicPath,
      targetAppName: targetRoute?.appName || '',
      targetAppRouteKind: targetRoute?.kind || 'apps',
      targetAppUsesV2: Boolean(targetRoute?.usesV2),
      targetAppEntryPath: targetRoute?.restPath || '',
      apiBaseUrl,
      wsPath,
      wsUrl,
      storagePath,
      storagePrefix: `NBCE_${hashString(normalizedEntryUrl)}_`,
      enabled: true,
      diagnostics: [
        {
          level: 'info',
          message: targetRoute?.appName
            ? `已从目标页面解析运行时配置，并识别子应用：${targetRoute.appName}`
            : '已从目标页面解析运行时配置',
          at: new Date().toISOString(),
        },
      ],
    });
  }

  function injectPageBootstrap(rule) {
    const script = document.createElement('script');
    script.textContent = `;(${pageBootstrap.toString()})(${JSON.stringify(rule)}, ${JSON.stringify({
      bridgeEventType: BRIDGE_EVENT_TYPE,
      bridgeReplyType: BRIDGE_REPLY_TYPE,
    })});`;
    const parent = document.head || document.documentElement || document.body;
    if (!parent) {
      document.addEventListener(
        'readystatechange',
        () => {
          const fallbackParent = document.head || document.documentElement || document.body;
          if (fallbackParent && !script.isConnected) {
            fallbackParent.appendChild(script);
            script.remove();
          }
        },
        { once: true },
      );
      return;
    }
    parent.appendChild(script);
    script.remove();
  }

  function pageBootstrap(rule, bridgeConfig) {
    const bridgeEventType = bridgeConfig?.bridgeEventType || '__NBCE_USERSCRIPT_BRIDGE__';
    const bridgeReplyType = bridgeConfig?.bridgeReplyType || '__NBCE_USERSCRIPT_BRIDGE_REPLY__';
    const bridgePending = new Map();
    let bridgeCounter = 0;
    const runtime = {
      rule,
      sourcePublicPath: null,
      sourceApiBaseUrl: null,
      sourceWsUrl: null,
      sourceWsPath: null,
    };

    function normalizePath(value, fallback) {
      let pathname = `${value || fallback}`.trim();
      if (!pathname) {
        pathname = fallback;
      }
      if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`;
      }
      pathname = pathname.replace(/\/{2,}/g, '/');
      if (!pathname.endsWith('/')) {
        pathname = `${pathname}/`;
      }
      return pathname;
    }

    function normalizeWsPath(value, fallback) {
      let pathname = `${value || fallback}`.trim();
      if (!pathname) {
        pathname = fallback;
      }
      if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`;
      }
      return pathname.replace(/\/{2,}/g, '/').replace(/\/$/g, '') || '/ws';
    }

    function isSpecialSchemeUrl(value) {
      return /^(data:|blob:|javascript:|mailto:|tel:|about:|chrome:|edge:|moz-extension:)/i.test(`${value || ''}`);
    }

    function isAbsoluteHttpLikeUrl(value) {
      return /^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(`${value || ''}`);
    }

    function isNocoBaseEndpointShorthand(value) {
      const input = `${value || ''}`.trim();
      if (
        !input ||
        input.startsWith('/') ||
        input.startsWith('./') ||
        input.startsWith('../') ||
        input.startsWith('?') ||
        input.startsWith('#')
      ) {
        return false;
      }
      if (isSpecialSchemeUrl(input) || isAbsoluteHttpLikeUrl(input)) {
        return false;
      }
      return /^[a-z][a-z\d+\-.]*:[^/].*$/i.test(input);
    }

    function joinApiEndpoint(baseUrl, endpoint) {
      const resolvedBase = new URL(baseUrl, location.origin);
      const suffix = `${endpoint || ''}`.replace(/^\/+/g, '');
      resolvedBase.pathname = `${resolvedBase.pathname.replace(/\/?$/g, '/')}${suffix}`.replace(/\/{2,}/g, '/');
      return resolvedBase.toString();
    }

    function buildSubAppApiBaseUrl(apiBaseUrl) {
      return new URL(apiBaseUrl, location.origin).toString();
    }

    function appendSubAppQueryToUrl(value, appName) {
      if (!value || !appName) {
        return value || '';
      }
      try {
        const url = new URL(value, location.origin);
        if (!url.searchParams.has('__appName') && !url.searchParams.has('_app')) {
          url.searchParams.set('__appName', appName);
        }
        return url.toString();
      } catch (error) {
        return value;
      }
    }

    function getEffectiveWsUrl() {
      return appendSubAppQueryToUrl(rule.wsUrl || '', rule.targetAppName);
    }

    function matchesPathPrefix(pathname, prefix) {
      return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
    }

    function stripPathPrefix(pathname, prefix) {
      if (pathname === prefix.slice(0, -1)) {
        return '';
      }
      if (!pathname.startsWith(prefix)) {
        return pathname;
      }
      return pathname.slice(prefix.length);
    }

    function getSourcePublicPath() {
      if (runtime.sourcePublicPath) {
        return normalizePath(runtime.sourcePublicPath, '/');
      }
      return normalizePath(rule.sourcePublicPath || '/', '/');
    }

    function getSourceApiBaseUrl() {
      if (runtime.sourceApiBaseUrl && runtime.sourceApiBaseUrl !== getTargetApiBaseUrl()) {
        return new URL(runtime.sourceApiBaseUrl, location.origin).toString();
      }
      if (rule.sourceApiBaseUrl) {
        return new URL(rule.sourceApiBaseUrl, location.origin).toString();
      }
      const rootPublicPath = getSourcePublicPath().endsWith('/v2/')
        ? normalizePath(getSourcePublicPath().slice(0, -'/v2/'.length) || '/', '/')
        : getSourcePublicPath();
      const fallbackPath = rootPublicPath === '/' ? '/api/' : `${rootPublicPath}api/`;
      return new URL(fallbackPath, location.origin).toString();
    }

    function getSourceApiPathname() {
      return new URL(getSourceApiBaseUrl(), location.origin).pathname;
    }

    function getTargetApiBaseUrl() {
      return buildSubAppApiBaseUrl(new URL(rule.apiBaseUrl, rule.targetOrigin).toString(), rule.targetAppName);
    }

    function getTargetApiUrl() {
      return new URL(getTargetApiBaseUrl(), rule.targetOrigin);
    }

    function getTargetStoragePrefix() {
      return new URL(rule.storagePath, rule.targetOrigin).pathname;
    }

    function getSourceStoragePrefixes() {
      const publicPath = getSourcePublicPath().endsWith('/v2/')
        ? normalizePath(getSourcePublicPath().slice(0, -'/v2/'.length) || '/', '/')
        : getSourcePublicPath();
      const main = publicPath === '/' ? '/storage/uploads/' : `${publicPath}storage/uploads/`;
      const prefixes = new Set([normalizePath(main, '/storage/uploads/')]);
      prefixes.add(normalizePath(rule.storagePath, '/storage/uploads/'));
      return Array.from(prefixes);
    }

    function isSameOriginUrl(url) {
      return url.origin === location.origin;
    }

    function resolveApiBridgeUrl(input) {
      const rawInput = `${input || ''}`.trim();
      if (!rawInput || isSpecialSchemeUrl(rawInput)) {
        return {
          shouldBridge: false,
          originalUrl: rawInput,
          url: rawInput,
        };
      }

      const resolved = isNocoBaseEndpointShorthand(rawInput)
        ? new URL(joinApiEndpoint(getSourceApiBaseUrl(), rawInput))
        : new URL(rawInput, location.href);
      const targetApiUrl = getTargetApiUrl();
      const sourceApiPathname = normalizePath(getSourceApiPathname(), '/api/');
      const targetApiPathname = normalizePath(targetApiUrl.pathname, '/api/');

      if (isSameOriginUrl(resolved) && matchesPathPrefix(resolved.pathname, sourceApiPathname)) {
        const suffix = stripPathPrefix(resolved.pathname, sourceApiPathname);
        const rewritten = new URL(targetApiUrl.toString());
        rewritten.pathname = `${targetApiPathname}${suffix}`.replace(/\/{2,}/g, '/');
        rewritten.search = resolved.search;
        rewritten.hash = resolved.hash;
        return {
          shouldBridge: true,
          originalUrl: resolved.toString(),
          url: rewritten.toString(),
        };
      }

      if (resolved.origin === targetApiUrl.origin && matchesPathPrefix(resolved.pathname, targetApiPathname)) {
        return {
          shouldBridge: true,
          originalUrl: resolved.toString(),
          url: resolved.toString(),
        };
      }

      return {
        shouldBridge: false,
        originalUrl: resolved.toString(),
        url: resolved.toString(),
      };
    }

    function rewriteRequestUrl(input) {
      return resolveApiBridgeUrl(input).url;
    }

    function rewriteStorageUrl(input) {
      if (!input || typeof input !== 'string') {
        return input;
      }
      if (/^(data:|blob:|javascript:|mailto:|tel:)/i.test(input)) {
        return input;
      }
      let resolved;
      try {
        resolved = new URL(input, location.href);
      } catch (error) {
        return input;
      }

      const targetStoragePrefix = normalizePath(getTargetStoragePrefix(), '/storage/uploads/');
      const sourceStoragePrefixes = getSourceStoragePrefixes();
      const normalizedPath = normalizePath(resolved.pathname, '/');
      const hit =
        sourceStoragePrefixes.find((prefix) => normalizedPath === prefix || normalizedPath.startsWith(prefix)) ||
        (normalizedPath === targetStoragePrefix || normalizedPath.startsWith(targetStoragePrefix)
          ? targetStoragePrefix
          : null);

      if (!hit) {
        return input;
      }

      const rewritten = new URL(rule.targetOrigin);
      rewritten.pathname = resolved.pathname;
      rewritten.search = resolved.search;
      rewritten.hash = resolved.hash;
      if (rule.targetAppName) {
        rewritten.searchParams.set('__appName', rule.targetAppName);
      }
      return rewritten.toString();
    }

    function overrideRuntimeValue(name, onSet, getter) {
      let internalValue = getter();
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get() {
            internalValue = getter();
            return internalValue;
          },
          set(value) {
            onSet(value);
            internalValue = getter();
          },
        });
      } catch (error) {
        console.warn('[nbce] failed to override runtime value', name, error);
      }
    }

    overrideRuntimeValue(
      '__nocobase_public_path__',
      (value) => {
        runtime.sourcePublicPath = value;
      },
      () => runtime.sourcePublicPath || rule.sourcePublicPath || '/',
    );

    overrideRuntimeValue(
      '__nocobase_api_base_url__',
      (value) => {
        if (value && value !== getTargetApiBaseUrl()) {
          runtime.sourceApiBaseUrl = value;
        }
      },
      () => getTargetApiBaseUrl(),
    );

    overrideRuntimeValue(
      '__nocobase_ws_url__',
      (value) => {
        runtime.sourceWsUrl = value;
      },
      () => getEffectiveWsUrl(),
    );

    overrideRuntimeValue(
      '__nocobase_ws_path__',
      (value) => {
        runtime.sourceWsPath = value;
      },
      () => normalizeWsPath(rule.wsPath, '/ws'),
    );

    overrideRuntimeValue('__nocobase_api_client_storage_prefix__', () => {}, () => rule.storagePrefix);
    overrideRuntimeValue('__nocobase_api_client_share_token__', () => {}, () => false);

    function appendHeader(result, name, value) {
      const normalizedName = `${name || ''}`.trim();
      if (!normalizedName || value == null) {
        return;
      }
      const normalizedValue = `${value}`.trim();
      if (!normalizedValue) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(result, normalizedName)) {
        result[normalizedName] = `${result[normalizedName]}, ${normalizedValue}`;
        return;
      }
      result[normalizedName] = normalizedValue;
    }

    function headersToObject(headersLike) {
      const result = {};
      if (!headersLike) {
        return result;
      }
      if (headersLike instanceof Headers) {
        headersLike.forEach((value, name) => appendHeader(result, name, value));
        return result;
      }
      if (Array.isArray(headersLike)) {
        headersLike.forEach((entry) => {
          if (!Array.isArray(entry) || entry.length < 2) {
            return;
          }
          appendHeader(result, entry[0], entry[1]);
        });
        return result;
      }
      Object.entries(headersLike).forEach(([name, value]) => {
        if (Array.isArray(value)) {
          value.forEach((item) => appendHeader(result, name, item));
          return;
        }
        appendHeader(result, name, value);
      });
      return result;
    }

    function parseRawHeaders(rawHeaders) {
      const headers = new Headers();
      if (!rawHeaders) {
        return headers;
      }
      rawHeaders.split(/\r?\n/g).forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          return;
        }
        const separatorIndex = trimmedLine.indexOf(':');
        if (separatorIndex <= 0) {
          return;
        }
        const name = trimmedLine.slice(0, separatorIndex).trim();
        const value = trimmedLine.slice(separatorIndex + 1).trim();
        if (!name) {
          return;
        }
        headers.append(name, value);
      });
      return headers;
    }

    function createAbortError() {
      try {
        return new DOMException('The operation was aborted.', 'AbortError');
      } catch (error) {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        return abortError;
      }
    }

    function toBridgeError(errorLike) {
      const message = errorLike?.message || '请求失败';
      const error = new Error(message);
      if (errorLike?.name) {
        error.name = errorLike.name;
      }
      if (errorLike?.code) {
        error.code = errorLike.code;
      }
      if (errorLike?.status) {
        error.status = errorLike.status;
      }
      return error;
    }

    function normalizeResponseStatus(status) {
      const numericStatus = Number(status) || 200;
      if (numericStatus < 200 || numericStatus > 599) {
        return 200;
      }
      return numericStatus;
    }

    function createBridgeRequest(payload) {
      const requestId = `nbce_${Date.now()}_${++bridgeCounter}`;
      let settled = false;
      let rejectRequest = null;
      const timeoutMs = typeof payload.timeout === 'number' && payload.timeout > 0 ? payload.timeout : 15000;
      let timeoutId = null;

      const promise = new Promise((resolve, reject) => {
        rejectRequest = reject;
        bridgePending.set(requestId, {
          resolve(value) {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            bridgePending.delete(requestId);
            resolve(value);
          },
          reject(error) {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            bridgePending.delete(requestId);
            reject(error);
          },
        });
      });

      timeoutId = window.setTimeout(() => {
        const pending = bridgePending.get(requestId);
        if (!pending) {
          return;
        }
        pending.reject(
          toBridgeError({
            message: '桥接请求超时',
            code: 'BRIDGE_TIMEOUT',
            name: 'Error',
          }),
        );
      }, timeoutMs);

      window.postMessage(
        {
          type: bridgeEventType,
          action: 'request',
          id: requestId,
          payload,
        },
        location.origin,
      );

      return {
        promise,
        abort() {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          bridgePending.delete(requestId);
          window.postMessage(
            {
              type: bridgeEventType,
              action: 'abort',
              id: requestId,
            },
            location.origin,
          );
          rejectRequest?.(createAbortError());
        },
      };
    }

    function handleBridgeReply(event) {
      if (event.source !== window) {
        return;
      }
      const message = event.data;
      if (!message || message.type !== bridgeReplyType || !message.id) {
        return;
      }
      const pending = bridgePending.get(message.id);
      if (!pending) {
        return;
      }
      if (message.ok) {
        pending.resolve(message.response || {});
        return;
      }
      pending.reject(toBridgeError(message.error));
    }

    window.addEventListener('message', handleBridgeReply, false);

    async function extractFetchBody(request) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return { kind: 'none', value: null };
      }

      const contentType = (request.headers.get('content-type') || '').toLowerCase();
      if (
        contentType.includes('application/json') ||
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('application/graphql') ||
        contentType.includes('application/xml') ||
        contentType.startsWith('text/')
      ) {
        return { kind: 'text', value: await request.text() };
      }

      if (contentType.includes('multipart/form-data')) {
        try {
          return { kind: 'formData', value: await request.formData() };
        } catch (error) {
          // Keep falling through to more generic body readers.
        }
      }

      try {
        return { kind: 'formData', value: await request.formData() };
      } catch (error) {
        // Keep falling through.
      }

      try {
        return { kind: 'blob', value: await request.blob() };
      } catch (error) {
        // Keep falling through.
      }

      try {
        return { kind: 'text', value: await request.text() };
      } catch (error) {
        return { kind: 'none', value: null };
      }
    }

    function serializeXhrBody(body) {
      if (body == null) {
        return { kind: 'none', value: null };
      }
      if (typeof body === 'string') {
        return { kind: 'text', value: body };
      }
      if (body instanceof URLSearchParams) {
        return { kind: 'text', value: body.toString() };
      }
      if (body instanceof FormData) {
        return { kind: 'formData', value: body };
      }
      if (body instanceof Blob) {
        return { kind: 'blob', value: body };
      }
      if (body instanceof ArrayBuffer) {
        return { kind: 'arrayBuffer', value: body.slice(0) };
      }
      if (ArrayBuffer.isView(body)) {
        return {
          kind: 'arrayBuffer',
          value: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      }
      if (typeof Document !== 'undefined' && body instanceof Document) {
        return { kind: 'text', value: new XMLSerializer().serializeToString(body) };
      }
      return { kind: 'text', value: String(body) };
    }

    async function bridgeFetch(request, plan) {
      if (request.signal?.aborted) {
        throw createAbortError();
      }

      const bridge = createBridgeRequest({
        method: request.method,
        url: plan.url,
        originalUrl: plan.originalUrl || request.url,
        headers: headersToObject(request.headers),
        body: await extractFetchBody(request.clone()),
      });

      const abortListener = () => {
        bridge.abort();
      };
      request.signal?.addEventListener('abort', abortListener, { once: true });

      try {
        const response = await bridge.promise;
        return new Response(response.bodyText || '', {
          status: normalizeResponseStatus(response.status),
          statusText: response.statusText || '',
          headers: parseRawHeaders(response.responseHeaders),
        });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          throw createAbortError();
        }
        throw new TypeError(error?.message || 'Failed to fetch');
      } finally {
        request.signal?.removeEventListener('abort', abortListener);
      }
    }

    const originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (originalFetch) {
      window.fetch = function patchedFetch(input, init) {
        try {
          const requestUrl =
            typeof input === 'string'
              ? input
              : input && typeof input.url === 'string'
                ? input.url
                : '';
          const plan = resolveApiBridgeUrl(requestUrl);
          if (!plan.shouldBridge) {
            return originalFetch(input, init);
          }
          const request = new Request(input, init);
          return bridgeFetch(request, plan);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }

    const OriginalXMLHttpRequest = window.XMLHttpRequest;
    if (OriginalXMLHttpRequest) {
      function WrappedXMLHttpRequest() {
        this._native = new OriginalXMLHttpRequest();
        this._listeners = new EventTarget();
        this._mode = 'native';
        this._bridge = {
          method: 'GET',
          url: '',
          originalUrl: '',
          headers: {},
          readyState: 0,
          status: 0,
          statusText: '',
          responseText: '',
          response: '',
          responseHeaders: '',
          responseURL: '',
          responseType: '',
          timeout: 0,
          withCredentials: false,
          pendingRequest: null,
        };
        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.onabort = null;
        this.ontimeout = null;
        this.onloadend = null;
        this.onloadstart = null;
        this.onprogress = null;
        this.upload = this._native.upload || new EventTarget();

        ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'loadstart', 'progress'].forEach(
          (eventName) => {
            this._native.addEventListener(eventName, () => {
              if (this._mode !== 'native') {
                return;
              }
              this._emit(eventName);
            });
          },
        );
      }

      WrappedXMLHttpRequest.prototype._emit = function _emit(eventName) {
        const event = new Event(eventName);
        this._listeners.dispatchEvent(event);
        const handler = this[`on${eventName}`];
        if (typeof handler === 'function') {
          handler.call(this, event);
        }
      };

      WrappedXMLHttpRequest.prototype._resetBridgeState = function _resetBridgeState() {
        this._bridge.headers = {};
        this._bridge.readyState = WrappedXMLHttpRequest.UNSENT;
        this._bridge.status = 0;
        this._bridge.statusText = '';
        this._bridge.responseText = '';
        this._bridge.response = '';
        this._bridge.responseHeaders = '';
        this._bridge.responseURL = '';
        this._bridge.originalUrl = '';
        this._bridge.pendingRequest = null;
      };

      WrappedXMLHttpRequest.prototype._finalizeBridgeSuccess = function _finalizeBridgeSuccess(response) {
        const bodyText = response.bodyText || '';
        this._bridge.pendingRequest = null;
        this._bridge.status = response.status || 0;
        this._bridge.statusText = response.statusText || '';
        this._bridge.responseHeaders = response.responseHeaders || '';
        this._bridge.responseURL = response.finalUrl || this._bridge.url;
        this._bridge.responseText = bodyText;

        if (this._bridge.responseType === 'json') {
          try {
            this._bridge.response = bodyText ? JSON.parse(bodyText) : null;
          } catch (error) {
            this._bridge.response = null;
          }
        } else {
          this._bridge.response = bodyText;
        }

        this._bridge.readyState = WrappedXMLHttpRequest.HEADERS_RECEIVED;
        this._emit('readystatechange');
        this._bridge.readyState = WrappedXMLHttpRequest.LOADING;
        this._emit('readystatechange');
        this._bridge.readyState = WrappedXMLHttpRequest.DONE;
        this._emit('readystatechange');
        this._emit('load');
        this._emit('loadend');
      };

      WrappedXMLHttpRequest.prototype._finalizeBridgeFailure = function _finalizeBridgeFailure(error) {
        this._bridge.pendingRequest = null;
        this._bridge.status = 0;
        this._bridge.statusText = '';
        this._bridge.readyState = WrappedXMLHttpRequest.DONE;
        this._emit('readystatechange');
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          this._emit('abort');
        } else if (error?.code === 'TIMEOUT_ERR') {
          this._emit('timeout');
        } else {
          this._emit('error');
        }
        this._emit('loadend');
      };

      WrappedXMLHttpRequest.prototype.addEventListener = function addEventListener() {
        return this._listeners.addEventListener.apply(this._listeners, arguments);
      };

      WrappedXMLHttpRequest.prototype.removeEventListener = function removeEventListener() {
        return this._listeners.removeEventListener.apply(this._listeners, arguments);
      };

      WrappedXMLHttpRequest.prototype.dispatchEvent = function dispatchEvent() {
        return this._listeners.dispatchEvent.apply(this._listeners, arguments);
      };

      WrappedXMLHttpRequest.prototype.open = function open(method, url, async, user, password) {
        const requestUrl = typeof url === 'string' ? url : String(url);
        const plan = resolveApiBridgeUrl(requestUrl);
        if (!plan.shouldBridge) {
          this._mode = 'native';
          this._native.timeout = this._bridge.timeout || this._native.timeout;
          this._native.withCredentials = this._bridge.withCredentials;
          if (this._bridge.responseType) {
            this._native.responseType = this._bridge.responseType;
          }
          const args = [method, rewriteRequestUrl(requestUrl)];
          if (arguments.length >= 3) {
            args.push(async);
          }
          if (arguments.length >= 4) {
            args.push(user);
          }
          if (arguments.length >= 5) {
            args.push(password);
          }
          return this._native.open.apply(this._native, args);
        }

        this._mode = 'bridge';
        this._resetBridgeState();
        this._bridge.method = method || 'GET';
        this._bridge.url = plan.url;
        this._bridge.originalUrl = plan.originalUrl || requestUrl;
        this._bridge.timeout = Number(this._native.timeout) || this._bridge.timeout || 0;
        this._bridge.withCredentials = Boolean(this._native.withCredentials || this._bridge.withCredentials);
        this._bridge.responseType = this._native.responseType || this._bridge.responseType || '';
        this._bridge.readyState = WrappedXMLHttpRequest.OPENED;
        this._emit('readystatechange');
      };

      WrappedXMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name, value) {
        if (this._mode !== 'bridge') {
          return this._native.setRequestHeader(name, value);
        }
        appendHeader(this._bridge.headers, name, value);
      };

      WrappedXMLHttpRequest.prototype.send = function send(body) {
        if (this._mode !== 'bridge') {
          return this._native.send(body);
        }
        const bridge = createBridgeRequest({
          method: this._bridge.method,
          url: this._bridge.url,
          originalUrl: this._bridge.originalUrl,
          headers: headersToObject(this._bridge.headers),
          body: serializeXhrBody(body),
          timeout: this._bridge.timeout || 0,
        });
        this._bridge.pendingRequest = bridge;
        bridge.promise.then(
          (response) => {
            if (this._mode !== 'bridge') {
              return;
            }
            this._finalizeBridgeSuccess(response);
          },
          (error) => {
            if (this._mode !== 'bridge') {
              return;
            }
            this._finalizeBridgeFailure(error);
          },
        );
      };

      WrappedXMLHttpRequest.prototype.abort = function abort() {
        if (this._mode !== 'bridge') {
          return this._native.abort();
        }
        if (this._bridge.pendingRequest) {
          this._bridge.pendingRequest.abort();
          return;
        }
        if (this._bridge.readyState !== WrappedXMLHttpRequest.UNSENT) {
          this._finalizeBridgeFailure(createAbortError());
        }
      };

      WrappedXMLHttpRequest.prototype.getAllResponseHeaders = function getAllResponseHeaders() {
        if (this._mode !== 'bridge') {
          return this._native.getAllResponseHeaders();
        }
        return this._bridge.readyState >= WrappedXMLHttpRequest.HEADERS_RECEIVED ? this._bridge.responseHeaders : '';
      };

      WrappedXMLHttpRequest.prototype.getResponseHeader = function getResponseHeader(name) {
        if (this._mode !== 'bridge') {
          return this._native.getResponseHeader(name);
        }
        const targetName = `${name || ''}`.trim().toLowerCase();
        if (!targetName) {
          return null;
        }
        const headers = this._bridge.responseHeaders.split(/\r?\n/g);
        for (const line of headers) {
          const separatorIndex = line.indexOf(':');
          if (separatorIndex <= 0) {
            continue;
          }
          const headerName = line.slice(0, separatorIndex).trim().toLowerCase();
          if (headerName !== targetName) {
            continue;
          }
          return line.slice(separatorIndex + 1).trim();
        }
        return null;
      };

      WrappedXMLHttpRequest.prototype.overrideMimeType = function overrideMimeType(mimeType) {
        if (this._mode !== 'bridge' && typeof this._native.overrideMimeType === 'function') {
          return this._native.overrideMimeType(mimeType);
        }
        return undefined;
      };

      Object.defineProperties(WrappedXMLHttpRequest.prototype, {
        readyState: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.readyState : this._native.readyState;
          },
        },
        status: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.status : this._native.status;
          },
        },
        statusText: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.statusText : this._native.statusText;
          },
        },
        responseType: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.responseType : this._native.responseType;
          },
          set(value) {
            if (this._mode === 'bridge') {
              this._bridge.responseType = value || '';
              return;
            }
            this._native.responseType = value;
          },
        },
        responseText: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.responseText : this._native.responseText;
          },
        },
        response: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.response : this._native.response;
          },
        },
        responseURL: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.responseURL : this._native.responseURL;
          },
        },
        timeout: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.timeout : this._native.timeout;
          },
          set(value) {
            if (this._mode === 'bridge') {
              this._bridge.timeout = Number(value) || 0;
              return;
            }
            this._native.timeout = value;
          },
        },
        withCredentials: {
          configurable: true,
          enumerable: true,
          get() {
            return this._mode === 'bridge' ? this._bridge.withCredentials : this._native.withCredentials;
          },
          set(value) {
            if (this._mode === 'bridge') {
              this._bridge.withCredentials = Boolean(value);
              return;
            }
            this._native.withCredentials = value;
          },
        },
      });

      WrappedXMLHttpRequest.UNSENT = 0;
      WrappedXMLHttpRequest.OPENED = 1;
      WrappedXMLHttpRequest.HEADERS_RECEIVED = 2;
      WrappedXMLHttpRequest.LOADING = 3;
      WrappedXMLHttpRequest.DONE = 4;
      WrappedXMLHttpRequest.prototype.UNSENT = 0;
      WrappedXMLHttpRequest.prototype.OPENED = 1;
      WrappedXMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
      WrappedXMLHttpRequest.prototype.LOADING = 3;
      WrappedXMLHttpRequest.prototype.DONE = 4;

      window.XMLHttpRequest = WrappedXMLHttpRequest;
    }

    function rewriteAttrValue(name, value) {
      if (!value || typeof value !== 'string') {
        return value;
      }
      if (name === 'srcset') {
        return value
          .split(',')
          .map((item) => {
            const trimmed = item.trim();
            if (!trimmed) {
              return trimmed;
            }
            const parts = trimmed.split(/\s+/g);
            parts[0] = rewriteStorageUrl(parts[0]);
            return parts.join(' ');
          })
          .join(', ');
      }
      return rewriteStorageUrl(value);
    }

    function patchElementAttributes(node) {
      if (!(node instanceof Element)) {
        return;
      }
      const attrs = ['src', 'href', 'poster', 'srcset'];
      for (const attrName of attrs) {
        const currentValue = node.getAttribute(attrName);
        if (!currentValue) {
          continue;
        }
        const nextValue = rewriteAttrValue(attrName, currentValue);
        if (nextValue && nextValue !== currentValue) {
          node.setAttribute(attrName, nextValue);
        }
      }
      if (typeof node.querySelectorAll === 'function') {
        const descendants = node.querySelectorAll('[src],[href],[poster],[srcset]');
        descendants.forEach((element) => patchElementAttributes(element));
      }
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          patchElementAttributes(record.target);
          continue;
        }
        record.addedNodes.forEach((node) => patchElementAttributes(node));
      }
    });

    const startObserver = () => {
      if (!document.documentElement) {
        return;
      }
      patchElementAttributes(document.documentElement);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'href', 'poster', 'srcset'],
      });
    };

    if (document.documentElement) {
      startObserver();
    } else {
      document.addEventListener('readystatechange', startObserver, { once: true });
    }

    window.__NBCE_RUNTIME__ = {
      enabled: true,
      rule,
      get effectiveApiBaseUrl() {
        return getTargetApiBaseUrl();
      },
      get sourceApiBaseUrl() {
        return runtime.sourceApiBaseUrl;
      },
      get sourcePublicPath() {
        return runtime.sourcePublicPath;
      },
    };
  }

  function isProbablyNocoBasePage() {
    if (currentRule?.enabled) {
      return true;
    }
    const scripts = Array.from(document.scripts || []);
    return scripts.some((script) => {
      const text = script.textContent || '';
      return text.includes('__nocobase_api_base_url__') || text.includes('__nocobase_public_path__');
    });
  }

  function getStoragePrefixes(rule) {
    const basePrefix = `${rule?.storagePrefix || ''}`.toUpperCase();
    const prefixes = new Set();
    if (basePrefix) {
      prefixes.add(basePrefix);
      if (rule?.targetAppName) {
        prefixes.add(`${basePrefix}${rule.targetAppName.toUpperCase()}_`);
      }
    }
    return Array.from(prefixes);
  }

  function clearStorageByRule(rule) {
    try {
      const prefixes = getStoragePrefixes(rule);
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        const upperKey = key.toUpperCase();
        if (prefixes.some((prefix) => upperKey.startsWith(prefix))) {
          localStorage.removeItem(key);
        }
      }
    } catch (error) {
      console.warn('[nbce] failed to clear localStorage', error);
    }
  }

  function readTokenFromStorage(rule) {
    try {
      const prefixes = getStoragePrefixes(rule);
      const keys = Object.keys(localStorage);
      for (const prefix of prefixes) {
        for (const key of keys) {
          const upperKey = key.toUpperCase();
          if (upperKey.startsWith(prefix) && upperKey.endsWith('TOKEN')) {
            return localStorage.getItem(key);
          }
        }
      }
    } catch (error) {
      console.warn('[nbce] failed to read token', error);
    }
    return '';
  }

  function handleBridgeRequest() {
    const event = arguments[0];
    if (!event || event.origin !== location.origin) {
      return;
    }

    const message = event.data;
    if (!message || message.type !== BRIDGE_EVENT_TYPE || !message.id) {
      return;
    }

    if (message.action === 'abort') {
      const pendingRequest = pendingBridgeRequests.get(message.id);
      if (!pendingRequest) {
        return;
      }
      pendingBridgeRequests.delete(message.id);
      pendingRequest.abort();
      return;
    }

    if (message.action !== 'request' || !isRecord(message.payload)) {
      return;
    }

    const activeRule = normalizeRule(rules[location.origin] || null) || currentRule;
    const payload = message.payload;
    const method = `${payload.method || 'GET'}`.toUpperCase();
    const endpoint = extractDebugEndpoint(payload.url, activeRule);
    const startedAt = Date.now();
    const requestBodySummary = summarizeDebugBody(payload.body);
    const overrideRule = endpoint ? findDebugResponseOverride(method, endpoint) : null;

    if (overrideRule) {
      const responseHeaders =
        overrideRule.responseHeaders || 'content-type: application/json\r\nx-nbce-debug: response-override\r\n';
      const capturedResponse = captureDebugResponseText(overrideRule.responseText);
      addDebugLog({
        id: message.id,
        method,
        endpoint,
        url: payload.url,
        originalUrl: payload.originalUrl || '',
        status: overrideRule.status,
        statusText: overrideRule.statusText,
        responseHeaders,
        durationMs: Date.now() - startedAt,
        requestBodySummary,
        responseText: capturedResponse.text,
        responseTruncated: capturedResponse.truncated,
        ok: true,
        overridden: true,
      });
      window.postMessage(
        {
          type: BRIDGE_REPLY_TYPE,
          id: message.id,
          ok: true,
          response: {
            status: overrideRule.status,
            statusText: overrideRule.statusText,
            responseHeaders,
            finalUrl: payload.url,
            bodyText: overrideRule.responseText,
          },
        },
        location.origin,
      );
      return;
    }

    const bodyKind = payload.body?.kind || 'none';
    const headers = {};
    Object.entries(isRecord(payload.headers) ? payload.headers : {}).forEach(([name, value]) => {
      const lowerName = name.toLowerCase();
      if (
        [
          'host',
          'content-length',
          'origin',
          'referer',
          'cookie',
          'x-app',
          'x-hostname',
          'sec-fetch-mode',
          'sec-fetch-site',
          'sec-fetch-dest',
        ].includes(lowerName)
      ) {
        return;
      }
      if (bodyKind === 'formData' && lowerName === 'content-type') {
        return;
      }
      headers[name] = value;
    });

    try {
      const targetUrl = new URL(payload.url, location.href);
      headers['X-Hostname'] = targetUrl.hostname;
    } catch (error) {
      // Keep request headers as-is if the URL cannot be parsed.
    }
    if (activeRule?.targetAppName) {
      headers['X-App'] = activeRule.targetAppName;
    }

    let requestData;
    if (bodyKind === 'text') {
      requestData = payload.body?.value ?? '';
    } else if (bodyKind === 'formData' || bodyKind === 'blob' || bodyKind === 'arrayBuffer') {
      requestData = payload.body?.value;
    }

    let gmRequest;
    try {
      gmRequest = createGMRequest({
        method,
        url: payload.url,
        headers,
        data: requestData,
        timeout: typeof payload.timeout === 'number' ? payload.timeout : 0,
      });
    } catch (error) {
      addDebugLog({
        id: message.id,
        method,
        endpoint,
        url: payload.url,
        originalUrl: payload.originalUrl || '',
        durationMs: Date.now() - startedAt,
        requestBodySummary,
        ok: false,
        error: stringifyError(error),
      });
      window.postMessage(
        {
          type: BRIDGE_REPLY_TYPE,
          id: message.id,
          ok: false,
          error: {
            message: stringifyError(error),
            code: error?.code || 'UNSUPPORTED',
            name: error?.name || 'Error',
          },
        },
        location.origin,
      );
      return;
    }

    pendingBridgeRequests.set(message.id, gmRequest);
    gmRequest.promise.then(
      (response) => {
        pendingBridgeRequests.delete(message.id);
        const bodyText = rewriteBridgeResponseText(
          activeRule,
          response.finalUrl || payload.url,
          typeof response.responseText === 'string'
            ? response.responseText
            : typeof response.response === 'string'
              ? response.response
              : '',
        );
        const capturedResponse = captureDebugResponseText(bodyText);
        addDebugLog({
          id: message.id,
          method,
          endpoint,
          url: response.finalUrl || payload.url,
          originalUrl: payload.originalUrl || '',
          status: response.status,
          statusText: response.statusText || '',
          responseHeaders: response.responseHeaders || '',
          durationMs: Date.now() - startedAt,
          requestBodySummary,
          responseText: capturedResponse.text,
          responseTruncated: capturedResponse.truncated,
          ok: true,
        });
        window.postMessage(
          {
            type: BRIDGE_REPLY_TYPE,
            id: message.id,
            ok: true,
            response: {
              status: response.status,
              statusText: response.statusText || '',
              responseHeaders: response.responseHeaders || '',
              finalUrl: response.finalUrl || payload.url,
              bodyText,
            },
          },
          location.origin,
        );
      },
      (error) => {
        pendingBridgeRequests.delete(message.id);
        addDebugLog({
          id: message.id,
          method,
          endpoint,
          url: payload.url,
          originalUrl: payload.originalUrl || '',
          status: error?.status || 0,
          durationMs: Date.now() - startedAt,
          requestBodySummary,
          ok: false,
          error: stringifyError(error),
        });
        window.postMessage(
          {
            type: BRIDGE_REPLY_TYPE,
            id: message.id,
            ok: false,
            error: {
              message: stringifyError(error),
              code: error?.code || 'NETWORK_ERR',
              name: error?.name || 'Error',
              status: error?.status || 0,
            },
          },
          location.origin,
        );
      },
    );
  }

  function ensurePanel(openPanel) {
    const existingContainer = document.getElementById(PANEL_ROOT_ID);
    if (existingContainer) {
      if (openPanel) {
        const card = existingContainer.shadowRoot?.querySelector('.nbce-card');
        const toggle = existingContainer.shadowRoot?.getElementById(PANEL_TOGGLE_ID);
        if (card?.hidden && toggle) {
          toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      }
      return;
    }

    const container = document.createElement('div');
    container.id = PANEL_ROOT_ID;
    container.style.all = 'initial';
    const mount = document.body || document.documentElement;
    if (!mount) {
      return;
    }
    mount.appendChild(container);

    const shadow = container.attachShadow({ mode: 'open' });
    const state = {
      expanded: Boolean(openPanel),
      saving: false,
      targetUrl: currentRule?.targetEntryUrl || '',
      status: currentRule?.enabled
        ? `已启用，当前目标：${currentRule.targetEntryUrl}${
            currentRule.targetAppName ? `\n目标子应用：${currentRule.targetAppName}` : ''
          }`
        : '未启用。填写 B 的完整入口 URL 后保存。',
      lastRule: currentRule,
      position: getPanelPosition(),
      view: 'config',
      selectedDebugLogId: '',
      debugEditorValue: '',
      debugStatus: '',
    };

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
      }
      .nbce-shell {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1f2937;
        transition: left 180ms ease, top 180ms ease, right 180ms ease, bottom 180ms ease;
      }
      .nbce-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        box-sizing: border-box;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
        cursor: move;
        user-select: none;
        font-size: 13px;
        font-weight: 800;
        line-height: 1;
        color: #0f172a;
        opacity: 0.82;
        transition: opacity 160ms ease, transform 160ms ease, box-shadow 160ms ease;
      }
      .nbce-toggle:hover,
      .nbce-shell.expanded .nbce-toggle {
        opacity: 1;
        transform: translateX(0) translateY(0);
        box-shadow: 0 14px 36px rgba(15, 23, 42, 0.2);
      }
      .nbce-shell.collapsed.edge-left .nbce-toggle {
        transform: translateX(-18px);
      }
      .nbce-shell.collapsed.edge-right .nbce-toggle {
        transform: translateX(18px);
      }
      .nbce-shell.collapsed.edge-top .nbce-toggle {
        transform: translateY(-18px);
      }
      .nbce-shell.collapsed.edge-bottom .nbce-toggle {
        transform: translateY(18px);
      }
      .nbce-toggle-mark {
        display: block;
        letter-spacing: 0;
        pointer-events: none;
      }
      .nbce-card {
        width: min(560px, calc(100vw - 24px));
        margin-top: 10px;
        border-radius: 8px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
        overflow: hidden;
        backdrop-filter: blur(14px);
      }
      .nbce-card[hidden] {
        display: none;
      }
      .nbce-header {
        padding: 14px 16px 10px;
        background: #f8fafc;
        border-bottom: 1px solid rgba(15, 23, 42, 0.08);
        cursor: move;
        user-select: none;
      }
      .nbce-title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
      }
      .nbce-subtitle {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.5;
        color: #475569;
      }
      .nbce-body {
        padding: 14px 16px 16px;
      }
      .nbce-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 12px;
        padding: 3px;
        border-radius: 6px;
        background: #f1f5f9;
      }
      .nbce-tab {
        flex: 1;
        appearance: none;
        border: none;
        border-radius: 5px;
        padding: 7px 8px;
        background: transparent;
        color: #475569;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
      }
      .nbce-tab.active {
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
      }
      .nbce-pane[hidden] {
        display: none;
      }
      .nbce-field {
        margin-bottom: 12px;
      }
      .nbce-label {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        font-weight: 600;
        color: #334155;
      }
      .nbce-static {
        padding: 9px 10px;
        border-radius: 6px;
        background: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.2);
        font-size: 12px;
        line-height: 1.5;
        color: #0f172a;
        word-break: break-all;
      }
      .nbce-input {
        box-sizing: border-box;
        width: 100%;
        padding: 10px 11px;
        border-radius: 6px;
        border: 1px solid rgba(148, 163, 184, 0.42);
        outline: none;
        font-size: 13px;
        color: #0f172a;
        background: #ffffff;
      }
      .nbce-input:focus {
        border-color: rgba(14, 165, 233, 0.78);
        box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.14);
      }
      .nbce-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
      }
      .nbce-button {
        appearance: none;
        border: none;
        border-radius: 6px;
        padding: 9px 11px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .nbce-button.primary {
        background: #0f172a;
        color: white;
      }
      .nbce-button.secondary {
        background: #e2e8f0;
        color: #0f172a;
      }
      .nbce-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .nbce-status {
        margin-top: 12px;
        padding: 10px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.55;
        background: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.2);
        white-space: pre-wrap;
        color: #334155;
      }
      .nbce-note {
        margin-top: 10px;
        font-size: 11px;
        line-height: 1.55;
        color: #64748b;
      }
      .nbce-debug-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }
      .nbce-debug-grid {
        display: grid;
        grid-template-columns: 210px 1fr;
        gap: 10px;
        min-height: 320px;
      }
      .nbce-debug-list {
        overflow: auto;
        max-height: 430px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 6px;
        background: #f8fafc;
      }
      .nbce-debug-empty {
        padding: 16px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.5;
      }
      .nbce-debug-item {
        display: block;
        width: 100%;
        box-sizing: border-box;
        border: none;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        padding: 8px;
        background: transparent;
        cursor: pointer;
        text-align: left;
        color: #0f172a;
      }
      .nbce-debug-item:hover,
      .nbce-debug-item.active {
        background: #e0f2fe;
      }
      .nbce-debug-item-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 11px;
        font-weight: 800;
      }
      .nbce-debug-item-endpoint {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.35;
        color: #334155;
        word-break: break-all;
      }
      .nbce-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 6px;
        background: #e2e8f0;
        color: #334155;
        font-size: 10px;
        font-weight: 800;
        line-height: 1.2;
      }
      .nbce-badge.ok {
        background: #dcfce7;
        color: #166534;
      }
      .nbce-badge.error {
        background: #fee2e2;
        color: #991b1b;
      }
      .nbce-badge.mock {
        background: #fef3c7;
        color: #92400e;
      }
      .nbce-debug-detail {
        min-width: 0;
      }
      .nbce-debug-meta {
        display: grid;
        grid-template-columns: 88px 1fr;
        gap: 6px 8px;
        margin-bottom: 10px;
        font-size: 11px;
        line-height: 1.45;
      }
      .nbce-debug-meta-label {
        color: #64748b;
        font-weight: 700;
      }
      .nbce-debug-meta-value {
        min-width: 0;
        color: #0f172a;
        word-break: break-all;
      }
      .nbce-debug-textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 210px;
        resize: vertical;
        border-radius: 6px;
        border: 1px solid rgba(148, 163, 184, 0.42);
        padding: 10px;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #0f172a;
        background: #ffffff;
      }
      .nbce-debug-textarea:focus {
        outline: none;
        border-color: rgba(14, 165, 233, 0.78);
        box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.12);
      }
      .nbce-debug-status {
        margin-top: 8px;
        min-height: 17px;
        font-size: 11px;
        line-height: 1.5;
        color: #475569;
      }
      @media (max-width: 560px) {
        .nbce-debug-grid {
          grid-template-columns: 1fr;
        }
        .nbce-debug-list {
          max-height: 180px;
        }
      }
    `;

    shadow.appendChild(style);

    const shell = document.createElement('div');
    shell.className = 'nbce-shell';
    shell.innerHTML = `
      <div id="${PANEL_TOGGLE_ID}" class="nbce-toggle" title="NocoBase Cross Env：点击展开，拖拽移动">
        <span class="nbce-toggle-mark">NB</span>
      </div>
      <div class="nbce-card" ${state.expanded ? '' : 'hidden'}>
        <div class="nbce-header">
          <h2 class="nbce-title">NocoBase Cross Env</h2>
          <div class="nbce-subtitle">让当前页面所在的 A 实例，将 API / 登录 / WS / 文件请求切到 B。</div>
        </div>
        <div class="nbce-body">
          <div class="nbce-tabs">
            <button class="nbce-tab active" data-view="config" type="button">配置</button>
            <button class="nbce-tab" data-view="debug" type="button">请求调试</button>
          </div>
          <div class="nbce-pane nbce-config-pane" data-pane="config">
            <div class="nbce-field">
              <label class="nbce-label">当前 A 域名</label>
              <div class="nbce-static">${escapeHtml(location.origin)}</div>
            </div>
            <div class="nbce-field">
              <label class="nbce-label">B 的完整入口 URL</label>
              <input class="nbce-input" type="url" placeholder="https://nocobase.example.com/apps/sandbox/admin" />
            </div>
            <div class="nbce-actions">
              <button class="nbce-button primary" data-action="save">保存并跳转</button>
              <button class="nbce-button secondary" data-action="disable">停用</button>
              <button class="nbce-button secondary" data-action="clear">清空登录态</button>
              <button class="nbce-button secondary" data-action="diagnose">解析并诊断</button>
            </div>
            <div class="nbce-status"></div>
            <div class="nbce-note">
              说明：子应用 HTTP API 会保持目标实例真实 /api/ 路径，并通过 X-App 选择子应用；不会再请求 /api/__app/xxx/。
            </div>
          </div>
          <div class="nbce-pane nbce-debug-pane" data-pane="debug" hidden>
            <div class="nbce-debug-toolbar">
              <button class="nbce-button secondary" data-action="debug-clear-logs">清空记录</button>
              <button class="nbce-button secondary" data-action="debug-delete-override">删除当前改写</button>
              <button class="nbce-button secondary" data-action="debug-clear-overrides">清空全部改写</button>
            </div>
            <div class="nbce-debug-grid">
              <div class="nbce-debug-list"></div>
              <div class="nbce-debug-detail">
                <div class="nbce-debug-empty">暂无请求。触发一次被桥接的 NocoBase API 后会显示在这里。</div>
                <div class="nbce-debug-selected" hidden>
                  <div class="nbce-debug-meta"></div>
                  <label class="nbce-label">响应 JSON</label>
                  <textarea class="nbce-debug-textarea" spellcheck="false"></textarea>
                  <div class="nbce-actions">
                    <button class="nbce-button primary" data-action="debug-save-override">保存响应改写</button>
                    <button class="nbce-button secondary" data-action="debug-copy-url">复制 URL</button>
                    <button class="nbce-button secondary" data-action="debug-copy-response">复制响应</button>
                  </div>
                  <div class="nbce-debug-status"></div>
                </div>
              </div>
            </div>
            <div class="nbce-note">
              响应改写仅保存在本机油猴存储里，命中后直接返回给前端，不会写入 B 后端。
            </div>
          </div>
        </div>
      </div>
    `;
    shadow.appendChild(shell);

    const toggle = shadow.getElementById(PANEL_TOGGLE_ID);
    const card = shadow.querySelector('.nbce-card');
    const header = shadow.querySelector('.nbce-header');
    const input = shadow.querySelector('.nbce-input');
    const status = shadow.querySelector('.nbce-status');
    const buttons = Array.from(shadow.querySelectorAll('.nbce-button'));
    const tabs = Array.from(shadow.querySelectorAll('.nbce-tab'));
    const panes = Array.from(shadow.querySelectorAll('.nbce-pane'));
    const debugList = shadow.querySelector('.nbce-debug-list');
    const debugEmpty = shadow.querySelector('.nbce-debug-empty');
    const debugSelected = shadow.querySelector('.nbce-debug-selected');
    const debugMeta = shadow.querySelector('.nbce-debug-meta');
    const debugTextarea = shadow.querySelector('.nbce-debug-textarea');
    const debugStatus = shadow.querySelector('.nbce-debug-status');

    input.value = state.targetUrl;
    status.textContent = state.status;

    function getShellSize() {
      const rect = shell.getBoundingClientRect();
      return {
        width: Math.max(rect.width || 0, 38),
        height: Math.max(rect.height || 0, 38),
      };
    }

    function clampPanelPosition(left, top) {
      const size = getShellSize();
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - size.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - size.height - margin);
      return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop),
      };
    }

    function snapPanelPosition(left, top) {
      const size = getShellSize();
      const margin = 8;
      const distances = [
        { edge: 'left', value: left },
        { edge: 'right', value: window.innerWidth - left - size.width },
        { edge: 'top', value: top },
        { edge: 'bottom', value: window.innerHeight - top - size.height },
      ];
      const nearest = distances.reduce((result, item) => (item.value < result.value ? item : result), distances[0]);
      const clamped = clampPanelPosition(left, top);
      if (nearest.edge === 'left') {
        return { left: margin, top: clamped.top, edge: 'left' };
      }
      if (nearest.edge === 'right') {
        return { left: Math.max(margin, window.innerWidth - size.width - margin), top: clamped.top, edge: 'right' };
      }
      if (nearest.edge === 'top') {
        return { left: clamped.left, top: margin, edge: 'top' };
      }
      return { left: clamped.left, top: Math.max(margin, window.innerHeight - size.height - margin), edge: 'bottom' };
    }

    function applyPanelPosition() {
      if (!state.position) {
        shell.style.left = '';
        shell.style.top = '';
        shell.style.right = '16px';
        shell.style.bottom = '16px';
        shell.classList.toggle('expanded', state.expanded);
        shell.classList.toggle('collapsed', !state.expanded);
        shell.classList.add('edge-right');
        return;
      }
      const position = clampPanelPosition(state.position.left, state.position.top);
      state.position = { ...state.position, ...position };
      shell.style.left = `${position.left}px`;
      shell.style.top = `${position.top}px`;
      shell.style.right = 'auto';
      shell.style.bottom = 'auto';
      shell.classList.toggle('expanded', state.expanded);
      shell.classList.toggle('collapsed', !state.expanded);
      ['edge-left', 'edge-right', 'edge-top', 'edge-bottom'].forEach((className) => shell.classList.remove(className));
      shell.classList.add(`edge-${state.position.edge || 'right'}`);
    }

    function getSelectedDebugLog() {
      return debugLogs.find((log) => log.id === state.selectedDebugLogId) || null;
    }

    function formatDebugTime(value) {
      try {
        return new Date(value).toLocaleTimeString();
      } catch (error) {
        return '';
      }
    }

    function getDebugRuleForLog(log) {
      if (!log?.endpoint) {
        return null;
      }
      return getDebugRulesForOrigin()[buildDebugRuleKey(log.method, log.endpoint)] || null;
    }

    function formatDebugJsonText(value) {
      if (!value) {
        return '';
      }
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch (error) {
        return value;
      }
    }

    function setSelectedDebugLog(log) {
      state.selectedDebugLogId = log?.id || '';
      state.debugStatus = '';
      if (!log) {
        state.debugEditorValue = '';
        return;
      }
      const rule = getDebugRuleForLog(log);
      state.debugEditorValue = formatDebugJsonText(rule?.responseText || log.responseText || '');
    }

    function renderDebugList() {
      if (!debugList) {
        return;
      }
      if (!debugLogs.length) {
        debugList.innerHTML = '<div class="nbce-debug-empty">暂无桥接请求。</div>';
        return;
      }
      debugList.innerHTML = debugLogs
        .map((log) => {
          const selected = log.id === state.selectedDebugLogId ? ' active' : '';
          const rule = getDebugRuleForLog(log);
          const statusClass = log.ok ? 'ok' : 'error';
          const statusText = log.ok ? log.status || '-' : 'ERR';
          const badges = [
            `<span class="nbce-badge ${statusClass}">${escapeHtml(statusText)}</span>`,
            log.overridden || rule ? '<span class="nbce-badge mock">改写</span>' : '',
          ]
            .filter(Boolean)
            .join('');
          return `
            <button class="nbce-debug-item${selected}" data-debug-id="${escapeHtml(log.id)}" type="button">
              <div class="nbce-debug-item-head">
                <span>${escapeHtml(log.method)} ${escapeHtml(formatDebugTime(log.at))}</span>
                <span>${badges}</span>
              </div>
              <div class="nbce-debug-item-endpoint">${escapeHtml(log.endpoint || log.url || 'unknown')}</div>
            </button>
          `;
        })
        .join('');
    }

    function renderDebugDetail() {
      if (!debugEmpty || !debugSelected || !debugMeta || !debugTextarea || !debugStatus) {
        return;
      }
      const selectedLog = getSelectedDebugLog();
      debugEmpty.hidden = Boolean(selectedLog);
      debugSelected.hidden = !selectedLog;
      if (!selectedLog) {
        debugEmpty.textContent = debugLogs.length
          ? '请选择左侧请求。'
          : '暂无请求。触发一次被桥接的 NocoBase API 后会显示在这里。';
        debugStatus.textContent = '';
        return;
      }

      const rule = getDebugRuleForLog(selectedLog);
      const metaRows = [
        ['Endpoint', `${selectedLog.method} ${selectedLog.endpoint || '-'}`],
        ['Status', selectedLog.ok ? `${selectedLog.status || 0} ${selectedLog.statusText || ''}`.trim() : '请求失败'],
        ['Duration', `${selectedLog.durationMs} ms`],
        ['Override', selectedLog.overridden ? '已命中本地改写' : rule ? '已有本地改写规则' : '无'],
        ['URL', selectedLog.url],
      ];
      if (selectedLog.originalUrl && selectedLog.originalUrl !== selectedLog.url) {
        metaRows.push(['Original', selectedLog.originalUrl]);
      }
      if (selectedLog.requestBodySummary) {
        metaRows.push(['Body', selectedLog.requestBodySummary]);
      }
      if (selectedLog.error) {
        metaRows.push(['Error', selectedLog.error]);
      }
      if (selectedLog.responseTruncated) {
        metaRows.push(['Note', '响应内容过大，日志中只保留了前半部分。']);
      }
      debugMeta.innerHTML = metaRows
        .map(
          ([label, value]) => `
            <div class="nbce-debug-meta-label">${escapeHtml(label)}</div>
            <div class="nbce-debug-meta-value">${escapeHtml(value)}</div>
          `,
        )
        .join('');
      if (debugTextarea.value !== state.debugEditorValue) {
        debugTextarea.value = state.debugEditorValue;
      }
      debugStatus.textContent = state.debugStatus;
    }

    function renderDebug() {
      if (state.selectedDebugLogId && !getSelectedDebugLog()) {
        setSelectedDebugLog(null);
      }
      if (!state.selectedDebugLogId && debugLogs.length) {
        setSelectedDebugLog(debugLogs[0]);
      }
      renderDebugList();
      renderDebugDetail();
    }

    function render() {
      card.hidden = !state.expanded;
      input.value = state.targetUrl;
      status.textContent = state.status;
      tabs.forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-view') === state.view);
      });
      panes.forEach((pane) => {
        pane.hidden = pane.getAttribute('data-pane') !== state.view;
      });
      buttons.forEach((button) => {
        button.disabled = state.saving;
      });
      renderDebug();
      applyPanelPosition();
    }

    let dragState = null;
    let suppressNextToggleClick = false;

    function startDrag(event) {
      if (event.button != null && event.button !== 0) {
        return;
      }
      if (event.target?.closest?.('input,button,a')) {
        return;
      }
      const rect = shell.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function moveDrag(event) {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        dragState.moved = true;
      }
      if (!dragState.moved) {
        return;
      }
      event.preventDefault();
      state.position = clampPanelPosition(dragState.left + deltaX, dragState.top + deltaY);
      applyPanelPosition();
    }

    function endDrag(event) {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (dragState.moved) {
        suppressNextToggleClick = true;
        state.position = snapPanelPosition(state.position.left, state.position.top);
        applyPanelPosition();
        void savePanelPosition(state.position);
        window.setTimeout(() => {
          suppressNextToggleClick = false;
        }, 0);
      }
      dragState = null;
    }

    [toggle, header].forEach((element) => {
      element.addEventListener('pointerdown', startDrag);
      element.addEventListener('pointermove', moveDrag);
      element.addEventListener('pointerup', endDrag);
      element.addEventListener('pointercancel', endDrag);
    });

    window.addEventListener('resize', () => {
      if (state.position) {
        state.position = state.expanded
          ? clampPanelPosition(state.position.left, state.position.top)
          : snapPanelPosition(state.position.left, state.position.top);
        applyPanelPosition();
        void savePanelPosition(state.position);
      }
    });

    toggle.addEventListener('click', () => {
      if (suppressNextToggleClick) {
        suppressNextToggleClick = false;
        return;
      }
      state.expanded = !state.expanded;
      if (state.position) {
        render();
        state.position = state.expanded
          ? clampPanelPosition(state.position.left, state.position.top)
          : snapPanelPosition(state.position.left, state.position.top);
      }
      render();
    });

    input.addEventListener('input', (event) => {
      state.targetUrl = event.target.value.trim();
    });

    debugTextarea?.addEventListener('input', (event) => {
      state.debugEditorValue = event.target.value;
    });

    subscribeDebugLogs(() => {
      render();
    });

    async function copyDebugText(value) {
      if (!navigator.clipboard?.writeText) {
        throw new Error('当前浏览器不支持剪贴板 API');
      }
      await navigator.clipboard.writeText(value || '');
    }

    shadow.addEventListener('click', async (event) => {
      const viewButton = event.target.closest('[data-view]');
      if (viewButton) {
        state.view = viewButton.getAttribute('data-view') || 'config';
        render();
        return;
      }

      const debugItem = event.target.closest('[data-debug-id]');
      if (debugItem) {
        setSelectedDebugLog(debugLogs.find((log) => log.id === debugItem.getAttribute('data-debug-id')) || null);
        render();
        return;
      }

      const button = event.target.closest('[data-action]');
      if (!button || state.saving) {
        return;
      }

      const action = button.getAttribute('data-action');
      if (!action) {
        return;
      }

      if (action === 'debug-clear-logs') {
        debugLogs.length = 0;
        setSelectedDebugLog(null);
        state.debugStatus = '已清空本页请求记录。';
        render();
        return;
      }

      if (action === 'debug-save-override') {
        const selectedLog = getSelectedDebugLog();
        if (!selectedLog) {
          state.debugStatus = '请先选择一条请求。';
          render();
          return;
        }
        if (!selectedLog.endpoint) {
          state.debugStatus = '当前请求无法识别 endpoint，不能保存改写规则。';
          render();
          return;
        }
        let parsedJson;
        try {
          parsedJson = JSON.parse(state.debugEditorValue || '');
        } catch (error) {
          state.debugStatus = `响应不是有效 JSON：${stringifyError(error)}`;
          render();
          return;
        }
        const responseText = JSON.stringify(parsedJson, null, 2);
        try {
          await saveDebugRuleForOrigin({
            id: buildDebugRuleKey(selectedLog.method, selectedLog.endpoint),
            key: buildDebugRuleKey(selectedLog.method, selectedLog.endpoint),
            mode: 'responseOverride',
            enabled: true,
            method: selectedLog.method,
            endpoint: selectedLog.endpoint,
            responseText,
            status: selectedLog.status || 200,
            statusText: selectedLog.statusText || 'OK',
            responseHeaders: 'content-type: application/json\r\nx-nbce-debug: response-override\r\n',
            createdAt: getDebugRuleForLog(selectedLog)?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          state.debugEditorValue = responseText;
          state.debugStatus = `已保存响应改写：${selectedLog.method} ${selectedLog.endpoint}`;
          render();
        } catch (error) {
          state.debugStatus = `保存失败：${stringifyError(error)}`;
          render();
        }
        return;
      }

      if (action === 'debug-delete-override') {
        const selectedLog = getSelectedDebugLog();
        if (!selectedLog?.endpoint) {
          state.debugStatus = '请先选择一条可识别 endpoint 的请求。';
          render();
          return;
        }
        await deleteDebugRuleForOrigin(selectedLog.method, selectedLog.endpoint);
        state.debugStatus = `已删除响应改写：${selectedLog.method} ${selectedLog.endpoint}`;
        render();
        return;
      }

      if (action === 'debug-clear-overrides') {
        await clearDebugRulesForOrigin();
        state.debugStatus = '已清空当前 A 域名下的全部响应改写规则。';
        render();
        return;
      }

      if (action === 'debug-copy-url' || action === 'debug-copy-response') {
        const selectedLog = getSelectedDebugLog();
        if (!selectedLog) {
          state.debugStatus = '请先选择一条请求。';
          render();
          return;
        }
        try {
          await copyDebugText(action === 'debug-copy-url' ? selectedLog.url : state.debugEditorValue);
          state.debugStatus = action === 'debug-copy-url' ? '已复制 URL。' : '已复制响应内容。';
        } catch (error) {
          state.debugStatus = `复制失败：${stringifyError(error)}`;
        }
        render();
        return;
      }

      if (action === 'save') {
        if (!state.targetUrl) {
          state.status = '请先填写 B 的完整入口 URL。';
          render();
          return;
        }
        state.saving = true;
        state.status = '正在解析 B 的运行时配置...';
        render();
        try {
          const parsedRule = await parseTargetEntry(state.targetUrl);
          parsedRule.updatedAt = new Date().toISOString();
          rules[location.origin] = parsedRule;
          await saveRules(rules);
          state.lastRule = parsedRule;
          const nextHref = parsedRule.targetAppName ? buildLocalEntryHref(parsedRule) : location.href;
          state.status = [
            '已保存并启用。',
            `B 入口：${parsedRule.targetEntryUrl}`,
            parsedRule.targetAppName ? `子应用：${parsedRule.targetAppName}` : '子应用：未检测到，按主应用处理',
            `API：${getEffectiveApiBaseUrl(parsedRule)}`,
            `WS：${getEffectiveWsUrl(parsedRule)}`,
            parsedRule.targetAppName
              ? '即将跳转到 A 上对应的镜像页面路径；API 会通过 X-App 请求 B 的子应用。'
              : '即将刷新当前页面，让新规则生效。',
          ].join('\n');
          render();
          setTimeout(() => {
            if (parsedRule.targetAppName) {
              location.replace(nextHref);
              return;
            }
            location.reload();
          }, 700);
        } catch (error) {
          state.status = `保存失败：${stringifyError(error)}`;
          render();
        } finally {
          state.saving = false;
          render();
        }
        return;
      }

      if (action === 'disable') {
        const rule = normalizeRule(rules[location.origin] || null);
        if (!rule) {
          state.status = '当前没有启用规则。';
          render();
          return;
        }
        rule.enabled = false;
        rule.updatedAt = new Date().toISOString();
        rules[location.origin] = rule;
        await saveRules(rules);
        state.status = '已停用当前 A -> B 映射，正在刷新页面。';
        render();
        setTimeout(() => location.reload(), 500);
        return;
      }

      if (action === 'clear') {
        const rule = normalizeRule(rules[location.origin] || null);
        if (!rule) {
          state.status = '当前没有规则可清理。';
          render();
          return;
        }
        clearStorageByRule(rule);
        state.status = `已清理以 ${rule.storagePrefix.toUpperCase()} 开头的本地登录态。`;
        render();
        return;
      }

      if (action === 'diagnose') {
        if (!state.targetUrl) {
          state.status = '请先填写 B 的完整入口 URL。';
          render();
          return;
        }
        state.saving = true;
        state.status = '正在解析并诊断 B 实例...';
        render();
        try {
          const parsedRule = await parseTargetEntry(state.targetUrl);
          const effectiveApiBaseUrl = getEffectiveApiBaseUrl(parsedRule);
          const publicListUrl = joinApiEndpoint(effectiveApiBaseUrl, 'authenticators:publicList');
          const headers = {
            Accept: 'application/json',
            'X-Hostname': new URL(effectiveApiBaseUrl).hostname,
          };
          if (parsedRule.targetAppName) {
            headers['X-App'] = parsedRule.targetAppName;
          }
          const publicListResponse = await requestViaGM({
            method: 'GET',
            url: publicListUrl,
            headers,
            timeout: 15000,
          });
          const authCheckUrl = joinApiEndpoint(effectiveApiBaseUrl, 'auth:check');
          const token = readTokenFromStorage(parsedRule);
          let authCheckLine = '当前没有 B 的 token，未执行 auth:check。';
          if (token) {
            const authCheckResponse = await requestViaGM({
              method: 'GET',
              url: authCheckUrl,
              headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
              },
              timeout: 15000,
            });
            authCheckLine = `auth:check 返回 HTTP ${authCheckResponse.status}`;
          }
          state.status = [
            '诊断完成。',
            `目标入口：${parsedRule.targetEntryUrl}`,
            parsedRule.targetAppName ? `子应用：${parsedRule.targetAppName}` : '子应用：未检测到，按主应用处理',
            `API：${effectiveApiBaseUrl}`,
            `WS：${getEffectiveWsUrl(parsedRule)}`,
            `authenticators:publicList 返回 HTTP ${publicListResponse.status}`,
            authCheckLine,
            '注意：HTTP 子应用选择走 X-App；WebSocket 是否可用仍取决于 B 的 Origin 策略。',
          ].join('\n');
          render();
        } catch (error) {
          state.status = `诊断失败：${stringifyError(error)}`;
          render();
        } finally {
          state.saving = false;
          render();
        }
      }
    });

    render();
  }
})();
