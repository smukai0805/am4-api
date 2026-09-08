const test = require('node:test');
const assert = require('node:assert/strict');
const reading = require('../article-reading.js');

test('HTTP(S) source tokens preserve text, punctuation, Japanese labels and balanced parentheses', () => {
  for (const value of [
    '出典：https://www.premierleague.com/history。',
    'Wikipedia https://en.wikipedia.org/wiki/Example_(football). 続き',
    '<img src=x onerror=alert(1)> https://example.org/?x=1&y=2',
  ]) {
    const tokens = reading.linkTokens(value);
    assert.equal(tokens.map(token => token.text).join(''), value);
    assert.equal(tokens.filter(token => token.href).length, 1);
  }
  assert.equal(reading.linkTokens('出典：https://example.org。')[1].href, 'https://example.org/');
  const markdown = reading.linkTokens('[公式資料](https://example.org/archive_(2026))');
  assert.deepEqual(markdown, [{text:'公式資料', href:'https://example.org/archive_(2026)'}]);
});

test('unsafe protocols and HTML remain text, never executable content', () => {
  for (const value of ['[危険](javascript:alert(1))','data:text/html,hello','<script>alert(1)</script>','https://']) {
    assert.deepEqual(reading.linkTokens(value), [{text:value}]);
  }
});

test('long summaries can be expanded without losing any original text', () => {
  const short = '守備が安定した。';
  assert.deepEqual(reading.splitSummary(short), {lead:short, rest:''});
  for (const value of ['守備が安定した。'.repeat(50), 'A'.repeat(700), '前半の分析\n'.repeat(80)]) {
    const result = reading.splitSummary(value);
    assert.equal(result.lead + result.rest, value);
    assert.ok(result.lead.length <= 260);
    assert.ok(result.rest.length);
  }
});
