import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = resolve(import.meta.dirname, '..');
const sourceFile = resolve(rootDir, 'nocobase-cross-env.user.js');
const host = process.env.NBCE_DEV_HOST || '127.0.0.1';
const port = Number(process.env.NBCE_DEV_PORT || 5173);

export function withoutUserscriptHeader(source) {
  return source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n?/, '');
}

function withoutProductionSourceHint(source) {
  return source.replace(/\n?\/\/# sourceURL=nbce-userscript\.js\s*$/g, '');
}

export function withDevSourceHints(source) {
  return [
    withoutProductionSourceHint(withoutUserscriptHeader(source)),
    '',
    '//# sourceURL=nbce-userscript-dev.js',
    '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5iY2UtdXNlcnNjcmlwdC1kZXYuanMiXSwibWFwcGluZ3MiOiIifQ==',
    '',
  ].join('\n');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store, max-age=0');

  if (url.pathname === '/' || url.pathname === '/nocobase-cross-env.dev.js') {
    try {
      const source = await readFile(sourceFile, 'utf8');
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(withDevSourceHints(source));
    } catch (error) {
      response.statusCode = 500;
      response.end(`console.error(${JSON.stringify(`[nbce-dev] ${error.message}`)});`);
    }
    return;
  }

  if (url.pathname === '/healthz') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.statusCode = 404;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end('Not found');
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, host, () => {
    console.log(`[nbce-dev] serving http://${host}:${port}/nocobase-cross-env.dev.js`);
    console.log('[nbce-dev] install dev/nocobase-cross-env.dev.user.js in Tampermonkey, then disable the production script.');
  });
}
