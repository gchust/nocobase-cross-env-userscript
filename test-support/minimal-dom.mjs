const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function escapeHtml(value) {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value) {
  return `${value ?? ''}`
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this._stopped = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation() {
    this._stopped = true;
  }
}

class TestMouseEvent extends TestEvent {}

class TestEventTarget {
  constructor() {
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!type || typeof listener !== 'function') {
      return;
    }
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type);
    if (!listeners) {
      return;
    }
    const nextListeners = listeners.filter((item) => item !== listener);
    if (nextListeners.length) {
      this._listeners.set(type, nextListeners);
      return;
    }
    this._listeners.delete(type);
  }

  dispatchEvent(event) {
    const nextEvent = event instanceof TestEvent ? event : new TestEvent(event?.type || '');
    if (!nextEvent.target) {
      nextEvent.target = this;
    }
    nextEvent.currentTarget = this;
    const listeners = this._listeners.get(nextEvent.type) || [];
    for (const listener of [...listeners]) {
      listener.call(this, nextEvent);
      if (nextEvent._stopped) {
        break;
      }
    }
    if (nextEvent.bubbles && !nextEvent._stopped && this.parentNode) {
      return this.parentNode.dispatchEvent(nextEvent);
    }
    return !nextEvent.defaultPrevented;
  }
}

class TestNode extends TestEventTarget {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument || null;
    this.parentNode = null;
    this.childNodes = [];
    this.nodeType = 0;
  }

  appendChild(node) {
    if (!node) {
      return node;
    }
    if (node.nodeType === 11) {
      [...node.childNodes].forEach((child) => this.appendChild(child));
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    if (this.ownerDocument) {
      this.ownerDocument._notifyNodeAppended(node);
    }
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node.nodeType === 9) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  contains(node) {
    if (!node) {
      return false;
    }
    if (node === this) {
      return true;
    }
    return this.childNodes.some((child) => child.contains?.(node));
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    const text = `${value ?? ''}`;
    if (text) {
      this.appendChild(new TestTextNode(this.ownerDocument, text));
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = `${selector || ''}`
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const results = [];
    const visit = (node) => {
      if (node.nodeType === 1 && selectors.some((item) => matchesSelector(node, item))) {
        results.push(node);
      }
      node.childNodes.forEach((child) => visit(child));
    };
    this.childNodes.forEach((child) => visit(child));
    return results;
  }
}

class TestTextNode extends TestNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 3;
    this.data = `${data ?? ''}`;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = `${value ?? ''}`;
  }
}

class TestDocumentFragment extends TestNode {
  constructor(ownerDocument) {
    super(ownerDocument);
    this.nodeType = 11;
  }
}

class TestClassList {
  constructor(element) {
    this.element = element;
  }

  _sync(nextSet) {
    this.element._classSet = nextSet;
    this.element._attributes.set('class', Array.from(nextSet).join(' '));
  }

  add(...tokens) {
    const nextSet = new Set(this.element._classSet);
    tokens.filter(Boolean).forEach((token) => nextSet.add(token));
    this._sync(nextSet);
  }

  remove(...tokens) {
    const nextSet = new Set(this.element._classSet);
    tokens.filter(Boolean).forEach((token) => nextSet.delete(token));
    this._sync(nextSet);
  }

  toggle(token, force) {
    const nextSet = new Set(this.element._classSet);
    const hasToken = nextSet.has(token);
    const shouldHave = force === undefined ? !hasToken : Boolean(force);
    if (shouldHave) {
      nextSet.add(token);
    } else {
      nextSet.delete(token);
    }
    this._sync(nextSet);
    return shouldHave;
  }

  contains(token) {
    return this.element._classSet.has(token);
  }

  toString() {
    return Array.from(this.element._classSet).join(' ');
  }
}

class TestElement extends TestNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.nodeType = 1;
    this.tagName = `${tagName || 'div'}`.toUpperCase();
    this._attributes = new Map();
    this._classSet = new Set();
    this._value = '';
    this._checked = false;
    this._disabled = false;
    this._hidden = false;
    this._selected = false;
    this._selectionStart = 0;
    this._selectionEnd = 0;
    this.style = {};
    this.shadowRoot = null;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return Array.from(this._classSet).join(' ');
  }

  set className(value) {
    const nextSet = new Set(`${value || ''}`.split(/\s+/g).filter(Boolean));
    this._classSet = nextSet;
    this._attributes.set('class', Array.from(nextSet).join(' '));
  }

  get classList() {
    if (!this._classList) {
      this._classList = new TestClassList(this);
    }
    return this._classList;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    this._hidden = Boolean(value);
    if (this._hidden) {
      this._attributes.set('hidden', '');
    } else {
      this._attributes.delete('hidden');
    }
  }

  get checked() {
    return this._checked;
  }

  set checked(value) {
    this._checked = Boolean(value);
    if (this._checked) {
      this._attributes.set('checked', '');
    } else {
      this._attributes.delete('checked');
    }
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(value) {
    this._disabled = Boolean(value);
    if (this._disabled) {
      this._attributes.set('disabled', '');
    } else {
      this._attributes.delete('disabled');
    }
  }

  get selected() {
    return this._selected;
  }

  set selected(value) {
    this._selected = Boolean(value);
    if (this._selected) {
      this._attributes.set('selected', '');
    } else {
      this._attributes.delete('selected');
    }
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = `${value ?? ''}`;
    if (this.tagName === 'TEXTAREA') {
      this.childNodes = [new TestTextNode(this.ownerDocument, this._value)];
    }
  }

  get type() {
    return this.getAttribute('type') || '';
  }

  set type(value) {
    this.setAttribute('type', value);
  }

  get title() {
    return this.getAttribute('title') || '';
  }

  set title(value) {
    this.setAttribute('title', value);
  }

  get spellcheck() {
    return this.getAttribute('spellcheck') || '';
  }

  set spellcheck(value) {
    this.setAttribute('spellcheck', value);
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this._attributes.has(name);
  }

  setAttribute(name, value) {
    const text = `${value ?? ''}`;
    this._attributes.set(name, text);
    if (name === 'class') {
      this.className = text;
      return;
    }
    if (name === 'value') {
      this._value = text;
      return;
    }
    if (name === 'checked') {
      this.checked = true;
      return;
    }
    if (name === 'disabled') {
      this.disabled = true;
      return;
    }
    if (name === 'hidden') {
      this.hidden = true;
      return;
    }
    if (name === 'selected') {
      this.selected = true;
      return;
    }
  }

  removeAttribute(name) {
    this._attributes.delete(name);
    if (name === 'class') {
      this._classSet = new Set();
    }
    if (name === 'value') {
      this._value = '';
    }
    if (name === 'checked') {
      this._checked = false;
    }
    if (name === 'disabled') {
      this._disabled = false;
    }
    if (name === 'hidden') {
      this._hidden = false;
    }
    if (name === 'selected') {
      this._selected = false;
    }
  }

  get innerHTML() {
    return this.childNodes
      .map((child) => (child.nodeType === 3 ? escapeHtml(child.textContent) : child.outerHTML))
      .join('');
  }

  set innerHTML(value) {
    this.childNodes = [];
    const nodes = parseHTMLFragment(`${value ?? ''}`, this.ownerDocument);
    [...nodes].forEach((node) => this.appendChild(node));
  }

  get outerHTML() {
    const attrs = Array.from(this._attributes.entries())
      .map(([name, value]) => (value === '' ? name : `${name}="${escapeHtml(value)}"`))
      .join(' ');
    const open = attrs ? `<${this.tagName.toLowerCase()} ${attrs}>` : `<${this.tagName.toLowerCase()}>`;
    if (VOID_TAGS.has(this.tagName.toLowerCase())) {
      return attrs ? `<${this.tagName.toLowerCase()} ${attrs} />` : `<${this.tagName.toLowerCase()} />`;
    }
    return `${open}${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  attachShadow({ mode } = {}) {
    const shadow = new TestShadowRoot(this.ownerDocument, this, mode || 'open');
    this.shadowRoot = shadow;
    return shadow;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && matchesSelector(node, selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  select() {
    this.ownerDocument._clipboardCandidate = this.value;
  }

  setSelectionRange(start, end) {
    this._selectionStart = start;
    this._selectionEnd = end;
    this.ownerDocument._clipboardCandidate = this.value;
  }

  click() {
    this.dispatchEvent(new TestMouseEvent('click', { bubbles: true, cancelable: true }));
  }

  focus() {}

  scrollIntoView() {}

  setPointerCapture() {}

  releasePointerCapture() {}

  getBoundingClientRect() {
    if (this.classList.contains('nbce-shell')) {
      const card = this.shadowRoot?.querySelector?.('.nbce-card');
      if (card && !card.hidden) {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 560,
          bottom: 520,
          width: 560,
          height: 520,
          toJSON() {
            return this;
          },
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 38,
        bottom: 38,
        width: 38,
        height: 38,
        toJSON() {
          return this;
        },
      };
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 32,
      width: 100,
      height: 32,
      toJSON() {
        return this;
      },
    };
  }
}

class TestShadowRoot extends TestDocumentFragment {
  constructor(ownerDocument, host, mode) {
    super(ownerDocument);
    this.host = host;
    this.mode = mode;
  }

  getElementById(id) {
    return this.querySelector(`#${cssEscape(id)}`);
  }
}

class TestDocument extends TestEventTarget {
  constructor(options = {}) {
    super();
    this.nodeType = 9;
    this._clipboardCandidate = '';
    this._clipboardText = '';
    this._options = options;
    this.scripts = [];
    this.documentElement = new TestElement(this, 'html');
    this.documentElement.parentNode = this;
    this.head = new TestElement(this, 'head');
    this.body = new TestElement(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.defaultView = null;
  }

  createElement(tagName) {
    return new TestElement(this, tagName);
  }

  createTextNode(value) {
    return new TestTextNode(this, value);
  }

  getElementById(id) {
    return this.documentElement.querySelector(`#${cssEscape(id)}`);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  execCommand(command) {
    if (command === 'copy') {
      this._clipboardText = this._clipboardCandidate || '';
      return true;
    }
    return false;
  }

  _notifyNodeAppended(node) {
    if (node?.tagName === 'SCRIPT' && !this.scripts.includes(node)) {
      this.scripts.push(node);
    }
  }
}

function cssEscape(value) {
  return `${value ?? ''}`.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
}

function matchesSelector(element, selector) {
  const selectors = `${selector || ''}`
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return selectors.some((item) => matchesCompoundSelector(element, item));
}

function splitSelectorParts(selector) {
  const parts = [];
  let current = '';
  let quote = '';
  let attrDepth = 0;
  for (const char of `${selector || ''}`.trim()) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') {
      attrDepth += 1;
      current += char;
      continue;
    }
    if (char === ']') {
      attrDepth = Math.max(0, attrDepth - 1);
      current += char;
      continue;
    }
    if (/\s/.test(char) && attrDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function matchesCompoundSelector(element, selector) {
  const parts = splitSelectorParts(selector);
  if (!parts.length || !matchesSimpleSelector(element, parts[parts.length - 1])) {
    return false;
  }
  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && (ancestor.nodeType !== 1 || !matchesSimpleSelector(ancestor, parts[index]))) {
      ancestor = ancestor.parentNode;
    }
    if (!ancestor) {
      return false;
    }
    ancestor = ancestor.parentNode;
  }
  return true;
}

function matchesSimpleSelector(element, selector) {
  if (!selector || element.nodeType !== 1) {
    return false;
  }
  let remainder = selector.trim();
  let tag = '';
  const tagMatch = remainder.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    tag = tagMatch[0].toUpperCase();
    remainder = remainder.slice(tagMatch[0].length);
    if (element.tagName !== tag) {
      return false;
    }
  }

  while (remainder.startsWith('.')) {
    remainder = remainder.slice(1);
    const match = remainder.match(/^[a-zA-Z0-9_-]+/);
    if (!match || !element.classList.contains(match[0])) {
      return false;
    }
    remainder = remainder.slice(match[0].length);
  }

  while (remainder.startsWith('#')) {
    remainder = remainder.slice(1);
    const match = remainder.match(/^[a-zA-Z0-9_-]+/);
    if (!match || element.id !== match[0]) {
      return false;
    }
    remainder = remainder.slice(match[0].length);
  }

  const attrRe = /^\[([^\]=\s]+)(?:=(["']?)(.*?)\2)?\]/;
  while (remainder.startsWith('[')) {
    const match = remainder.match(attrRe);
    if (!match) {
      return false;
    }
    const [, name, , value] = match;
    const attrValue = element.getAttribute(name);
    if (value === undefined) {
      if (attrValue === null) {
        return false;
      }
    } else if (`${attrValue ?? ''}` !== value) {
      return false;
    }
    remainder = remainder.slice(match[0].length);
  }

  return remainder.length === 0;
}

function parseAttributes(source) {
  const attrs = {};
  const attrRe = /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRe.exec(source))) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    attrs[name] = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
  }
  return attrs;
}

function parseHTMLFragment(html, document) {
  const root = new TestDocumentFragment(document);
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let match;
  while ((match = tokenRe.exec(html))) {
    const token = match[0];
    if (!token) {
      continue;
    }
    if (token.startsWith('<!--')) {
      continue;
    }
    if (token.startsWith('</')) {
      const closingTag = token.slice(2, -1).trim().toUpperCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        const node = stack[index];
        stack.pop();
        if (node.tagName === closingTag) {
          break;
        }
      }
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = /\/>$/.test(token);
      const tagMatch = token.match(/^<\s*([a-zA-Z0-9-]+)/);
      if (!tagMatch) {
        continue;
      }
      const tagName = tagMatch[1];
      const attrsSource = token
        .slice(tagMatch[0].length, token.length - (selfClosing ? 2 : 1))
        .trim();
      const element = document.createElement(tagName);
      const attrs = parseAttributes(attrsSource);
      Object.entries(attrs).forEach(([name, value]) => {
        element.setAttribute(name, value);
      });
      stack[stack.length - 1].appendChild(element);
      if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) {
        stack.push(element);
      }
      continue;
    }
    stack[stack.length - 1].appendChild(document.createTextNode(decodeHtmlEntities(token)));
  }
  return root.childNodes;
}

function createLocation(href) {
  const url = new URL(href);
  return {
    href: url.href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    replace(nextHref) {
      const nextUrl = new URL(nextHref, url.href);
      this.href = nextUrl.href;
      this.origin = nextUrl.origin;
      this.pathname = nextUrl.pathname;
      this.search = nextUrl.search;
      this.hash = nextUrl.hash;
      this._replacedTo = nextUrl.href;
    },
    reload() {
      this._reloaded = true;
    },
  };
}

export function createTestDom(options = {}) {
  const location = createLocation(options.locationHref || 'https://main.v2.test.nocobase.com/nocobase/admin');
  const document = new TestDocument(options);
  const menuCommands = [];
  const gmValues = new Map(Object.entries(options.GM_values || {}));
  const windowListeners = new Map();

  const window = {
    location,
    document,
    navigator: {
      clipboard: options.navigatorClipboard,
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      const nextListeners = listeners.filter((item) => item !== listener);
      if (nextListeners.length) {
        windowListeners.set(type, nextListeners);
      } else {
        windowListeners.delete(type);
      }
    },
    dispatchEvent(event) {
      const nextEvent = event instanceof TestEvent ? event : new TestEvent(event?.type || '');
      if (!nextEvent.target) {
        nextEvent.target = window;
      }
      nextEvent.currentTarget = window;
      const listeners = windowListeners.get(nextEvent.type) || [];
      for (const listener of [...listeners]) {
        listener.call(window, nextEvent);
        if (nextEvent._stopped) {
          break;
        }
      }
      return !nextEvent.defaultPrevented;
    },
    postMessage(message, origin) {
      window._postedMessages = window._postedMessages || [];
      window._postedMessages.push({ message, origin });
      const event = new TestEvent('message', { bubbles: false });
      event.data = message;
      event.origin = origin || location.origin;
      event.source = window;
      window.dispatchEvent(event);
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    innerWidth: options.innerWidth || 1280,
    innerHeight: options.innerHeight || 800,
    MouseEvent: TestMouseEvent,
    Event: TestEvent,
  };

  document.defaultView = window;
  window.window = window;
  window.self = window;

  const originalNotify = document._notifyNodeAppended.bind(document);
  document._notifyNodeAppended = (node) => {
    originalNotify(node);
    if (node?.tagName === 'SCRIPT' && typeof options.onScriptAppended === 'function') {
      options.onScriptAppended(node);
    }
  };

  document.execCommand = document.execCommand.bind(document);

  document.scripts = Array.isArray(options.scripts)
    ? options.scripts.map((item) => {
        if (typeof item === 'string') {
          const script = document.createElement('script');
          script.textContent = item;
          return script;
        }
        const script = document.createElement('script');
        script.textContent = item?.textContent || '';
        if (item?.src) {
          script.setAttribute('src', item.src);
        }
        return script;
      })
    : [];

  document.scripts.forEach((script) => {
    script.ownerDocument = document;
  });

  function fireWindowEvent(type, init = {}) {
    window.dispatchEvent(new TestEvent(type, init));
  }

  function fireDOMContentLoaded() {
    fireWindowEvent('DOMContentLoaded', { bubbles: false });
  }

  function GM_getValue(key, fallback) {
    return gmValues.has(key) ? gmValues.get(key) : fallback;
  }

  function GM_setValue(key, value) {
    gmValues.set(key, value);
    return value;
  }

  function GM_registerMenuCommand(title, callback) {
    menuCommands.push({ title, callback });
    return menuCommands.length;
  }

  function GM_xmlhttpRequest(request) {
    if (typeof options.GM_xmlhttpRequest === 'function') {
      return options.GM_xmlhttpRequest(request, { location, document, window, menuCommands, gmValues });
    }
    const response = {
      status: 200,
      statusText: 'OK',
      responseText: '',
      responseHeaders: '',
      finalUrl: request.url,
    };
    queueMicrotask(() => {
      request.onload?.(response);
    });
    return {
      abort() {
        request.onabort?.({ error: 'aborted' });
      },
    };
  }

  return {
    document,
    window,
    location,
    Element: TestElement,
    Event: TestEvent,
    MouseEvent: TestMouseEvent,
    menuCommands,
    gmValues,
    fireDOMContentLoaded,
    fireWindowEvent,
    clipboard: document,
    GM_getValue,
    GM_setValue,
    GM_registerMenuCommand,
    GM_xmlhttpRequest,
    TestEvent,
  };
}
