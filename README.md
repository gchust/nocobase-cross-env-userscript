# NocoBase Cross Env

Tampermonkey userscript for switching a NocoBase frontend page to another NocoBase backend. It is intended for development and debugging when you want to reuse an existing frontend environment without running a local backend.

## Install

Install or update from:

https://gchust.github.io/nocobase-cross-env-userscript/nocobase-cross-env.user.js

After installation, open any NocoBase page and use the floating **NB Cross Env** panel or the Tampermonkey menu command.

## Usage

1. Open the NocoBase frontend environment you want to use as instance A.
2. Open the **NB Cross Env** panel.
3. Paste the full entry URL of instance B, for example:

   `https://nocobase-b.example.com/nocobase/apps/sandbox/admin`

4. Click **保存并跳转**.

The script bridges HTTP API requests through Tampermonkey, keeps sub-application API paths on the real `/api/` base, and selects the target sub-application with `X-App`.

## Updates

Tampermonkey checks `@updateURL` and `@downloadURL` automatically. When releasing a new version, update `@version` in `nocobase-cross-env.user.js` and push to `main`.

## Development

Install dependencies once:

```bash
npm install
```

Run the local userscript dev server:

```bash
npm run dev
```

Then install `dev/nocobase-cross-env.dev.user.js` in Tampermonkey. The DEV script loads the current local script from:

```text
http://127.0.0.1:5173/nocobase-cross-env.dev.js
```

Disable the production `NocoBase Cross Env` script while using `NocoBase Cross Env DEV`, otherwise both scripts may patch `fetch` and `XMLHttpRequest`.

### Debugging

- Open the page DevTools and look for `nbce-userscript-dev.js` and `nbce-page-bootstrap.js` in Sources.
- Use the in-page **请求调试** tab first. Tampermonkey `GM_xmlhttpRequest` traffic is not reliably visible in the page Network panel.
- Enable detailed bridge logs from the Tampermonkey menu command **NocoBase Cross Env: 切换调试日志** or the **请求调试** tab button. Logs are persisted locally and can be turned off the same way.
- For one-off local debugging, setting `globalThis.NBCE_DEBUG = true` before the script initializes enables the same detailed logs without changing backend data.
- The local dev server sends `Cache-Control: no-store`; refresh the target page after editing the script.
- If you are debugging `document-start` timing issues, install the production bundle directly instead of the DEV loader, because `@require` from localhost can change timing.

Chrome/Edge may require Tampermonkey user-script permissions and extension developer mode. For local `file://` workflows, Tampermonkey also needs file URL access; the default workflow here uses `localhost` to avoid that.

Run checks before committing:

```bash
npm run check
npm test
```

### Real Tampermonkey checklist

Before publishing changes that touch injection, bridge, or request rewriting behavior:

1. Chrome or Edge with stable Tampermonkey: enable user-script permissions if prompted.
2. Chrome or Edge with Tampermonkey BETA: verify the same A -> B bridge flow.
3. Firefox with Tampermonkey: verify the same A -> B bridge flow.
4. In each browser, test a page refresh where the first API request is issued early.
5. Confirm the **请求调试** tab records requests and detailed console logs can be toggled.
6. Re-test using the production script when investigating `@run-at document-start` timing.

## Notes

- WebSocket connections are still direct browser connections, so they depend on the target instance's Origin policy.
- Remote plugin URLs from `pm:listEnabled` are rewritten to the current frontend's asset base to avoid cross-version chunk loading errors.
- Do not store secrets, tokens, or private environment data in the script.
