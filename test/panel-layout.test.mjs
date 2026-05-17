import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve(import.meta.dirname, '..', 'nocobase-cross-env.user.js');

async function readUserscript() {
  return readFile(sourcePath, 'utf8');
}

function extractCssRule(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
  return match?.[1] || '';
}

test('expanded panel caps its height and scrolls content inside the card', async () => {
  const source = await readUserscript();
  const cardRule = extractCssRule(source, '.nbce-card');
  const bodyRule = extractCssRule(source, '.nbce-body');

  assert.match(cardRule, /max-height:\s*calc\(100vh - 64px\);/);
  assert.match(cardRule, /display:\s*flex;/);
  assert.match(cardRule, /flex-direction:\s*column;/);
  assert.match(bodyRule, /min-height:\s*0;/);
  assert.match(bodyRule, /overflow:\s*auto;/);
});
