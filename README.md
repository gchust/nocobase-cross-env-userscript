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

## Notes

- WebSocket connections are still direct browser connections, so they depend on the target instance's Origin policy.
- Remote plugin URLs from `pm:listEnabled` are rewritten to the current frontend's asset base to avoid cross-version chunk loading errors.
- Do not store secrets, tokens, or private environment data in the script.
