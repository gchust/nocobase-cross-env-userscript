// ==UserScript==
// @name         NocoBase Cross Env
// @namespace    https://nocobase.com/
// @version      0.3.3
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
  const PANEL_ROOT_ID = 'nbce-panel-root';
  const PANEL_TOGGLE_ID = 'nbce-panel-toggle';
  const BRIDGE_EVENT_TYPE = '__NBCE_USERSCRIPT_BRIDGE__';
  const BRIDGE_REPLY_TYPE = '__NBCE_USERSCRIPT_BRIDGE_REPLY__';
  const pendingBridgeRequests = new Map();

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
    return { left, top };
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
        method: payload.method || 'GET',
        url: payload.url,
        headers,
        data: requestData,
        timeout: typeof payload.timeout === 'number' ? payload.timeout : 0,
      });
    } catch (error) {
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
              bodyText: rewriteBridgeResponseText(
                activeRule,
                response.finalUrl || payload.url,
                typeof response.responseText === 'string'
                  ? response.responseText
                  : typeof response.response === 'string'
                    ? response.response
                    : '',
              ),
            },
          },
          location.origin,
        );
      },
      (error) => {
        pendingBridgeRequests.delete(message.id);
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
      }
      .nbce-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
        cursor: move;
        user-select: none;
        font-size: 12px;
        line-height: 1;
      }
      .nbce-toggle strong {
        font-weight: 700;
      }
      .nbce-card {
        width: 360px;
        margin-top: 12px;
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
    `;

    shadow.appendChild(style);

    const shell = document.createElement('div');
    shell.className = 'nbce-shell';
    shell.innerHTML = `
      <div id="${PANEL_TOGGLE_ID}" class="nbce-toggle" title="点击展开，拖拽移动">
        <strong>NB Cross Env</strong>
        <span>${currentRule?.enabled ? '已启用' : '配置 B 实例'}</span>
      </div>
      <div class="nbce-card" ${state.expanded ? '' : 'hidden'}>
        <div class="nbce-header">
          <h2 class="nbce-title">NocoBase Cross Env</h2>
          <div class="nbce-subtitle">让当前页面所在的 A 实例，将 API / 登录 / WS / 文件请求切到 B。</div>
        </div>
        <div class="nbce-body">
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
      </div>
    `;
    shadow.appendChild(shell);

    const toggle = shadow.getElementById(PANEL_TOGGLE_ID);
    const card = shadow.querySelector('.nbce-card');
    const header = shadow.querySelector('.nbce-header');
    const input = shadow.querySelector('.nbce-input');
    const status = shadow.querySelector('.nbce-status');
    const buttons = Array.from(shadow.querySelectorAll('.nbce-button'));

    input.value = state.targetUrl;
    status.textContent = state.status;

    function clampPanelPosition(left, top) {
      const rect = shell.getBoundingClientRect();
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop),
      };
    }

    function applyPanelPosition() {
      if (!state.position) {
        shell.style.left = '';
        shell.style.top = '';
        shell.style.right = '16px';
        shell.style.bottom = '16px';
        return;
      }
      const position = clampPanelPosition(state.position.left, state.position.top);
      state.position = position;
      shell.style.left = `${position.left}px`;
      shell.style.top = `${position.top}px`;
      shell.style.right = 'auto';
      shell.style.bottom = 'auto';
    }

    function render() {
      card.hidden = !state.expanded;
      input.value = state.targetUrl;
      status.textContent = state.status;
      buttons.forEach((button) => {
        button.disabled = state.saving;
      });
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
        state.position = clampPanelPosition(state.position.left, state.position.top);
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
      render();
    });

    input.addEventListener('input', (event) => {
      state.targetUrl = event.target.value.trim();
    });

    shadow.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button || state.saving) {
        return;
      }

      const action = button.getAttribute('data-action');
      if (!action) {
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
