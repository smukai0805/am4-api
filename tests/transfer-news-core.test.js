import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTransferNews } from '../lib/transfer-news-core.js';

test('a failed transfer-news research call never invokes the writer or returns candidates', async () => {
  const labels = [];
  const result = await checkTransferNews({
    client: async ({ label }) => {
      labels.push(label);
      throw new Error('simulated provider outage');
    },
  });

  assert.deepEqual(labels, ['research']);
  assert.equal(result.researchStatus, 'unavailable');
  assert.deepEqual(result.items, []);
  assert.match(result.rejected[0].reason, /生成しなかった/);
});

test('available research can proceed to writing through the injected local client', async () => {
  const calls = [];
  const result = await checkTransferNews({
    client: async ({ label }) => {
      calls.push(label);
      if (label === 'research') {
        return { content: [{ type: 'text', text: '確認済みの移籍メモ' }] };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            items: [{ player: 'Example Player', fromClub: 'Club A', toClub: 'Club B', headline: '見出し', summary: '要約' }],
            rejected: [],
          }),
        }],
      };
    },
  });

  assert.deepEqual(calls, ['research', 'write']);
  assert.equal(result.researchStatus, 'available');
  assert.deepEqual(result.items.map(item => item.player), ['Example Player']);
});
