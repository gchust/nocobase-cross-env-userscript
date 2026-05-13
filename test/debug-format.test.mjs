import test from 'node:test';
import assert from 'node:assert/strict';

function formatDebugQueryValue(value) {
  const text = `${value ?? ''}`;
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (error) {
      return text;
    }
  }
  return text;
}

function formatDebugQuery(value) {
  const url = new URL(value, 'https://example.com');
  const rows = [];
  url.searchParams.forEach((paramValue, paramName) => {
    const formattedValue = formatDebugQueryValue(paramValue);
    rows.push(`${paramName} =${formattedValue.includes('\n') ? `\n${formattedValue}` : ` ${formattedValue}`}`);
  });
  return rows.join('\n\n');
}

test('formats encoded NocoBase filter query as readable JSON', () => {
  const url =
    'https://main.v2.test.nocobase.com/nocobase/api/t1_user:list?filter=%7B%22$and%22:[%7B%22address%22:%7B%22$includes%22:%22dd%22%7D%7D]%7D&page=1&pageSize=40';

  const result = formatDebugQuery(url);

  assert.match(result, /filter =\n\{/);
  assert.match(result, /"\$includes": "dd"/);
  assert.match(result, /page = 1/);
  assert.match(result, /pageSize = 40/);
});

test('keeps non-json query values readable', () => {
  const result = formatDebugQuery('https://example.com/api/users:list?keyword=a%20b&sort=-createdAt');

  assert.equal(result, 'keyword = a b\n\nsort = -createdAt');
});
