import assert from 'node:assert/strict';
import test from 'node:test';
import { generateArticleDraft } from '../lib/academy-core.js';
import { generateMatchReportDraft } from '../lib/match-report-core.js';

const matchInfo = {
  fixtureId: 1,
  homeTeam: 'Ipswich Town',
  awayTeam: 'Liverpool',
  homeGoals: 0,
  awayGoals: 2,
  competition: 'Premier League',
  date: '2026-09-04T19:00:00Z',
};

const ratings = { ratings: [], mom: null };
const player = { name: 'Example Player', club: 'Example FC', age: 18 };
const profile = { player: { id: 1, name: 'Example Player' } };

function researchFailureClient(calls, error) {
  return async ({ label }) => {
    calls.push(label);
    if (label === 'research') throw error;
    return { content: [{ type: 'text', text: '# Writer must not run' }] };
  };
}

function successfulClient(calls) {
  return async ({ label }) => {
    calls.push(label);
    if (label === 'research') {
      return {
        content: [
          { type: 'text', text: '確認済みの取材メモ' },
          { type: 'web_search_tool_result', content: [{ title: 'Primary source', url: 'https://example.com/source' }] },
        ],
      };
    }
    return { content: [{ type: 'text', text: '# 下書き' }] };
  };
}

function incompleteResearchClient(calls, content) {
  return async ({ label }) => {
    calls.push(label);
    if (label === 'research') return { content };
    return { content: [{ type: 'text', text: '# Writer must not run' }] };
  };
}

for (const [name, makeDraft, input] of [
  ['match report', generateMatchReportDraft, [matchInfo, ratings]],
  ['academy article', generateArticleDraft, [player, profile]],
]) {
  for (const [failure, error] of [
    ['5xx', new Error('provider returned 500')],
    ['network interruption', new TypeError('fetch failed')],
    ['timeout', new Error('request timed out')],
  ]) {
    test(`${name} skips writing when research has a ${failure} failure`, async () => {
      const calls = [];
      await assert.rejects(
        () => makeDraft(...input, { client: researchFailureClient(calls, error) }),
        /取材情報を取得できなかったため、下書き生成を中止しました/,
      );
      assert.deepEqual(calls, ['research']);
    });
  }

  test(`${name} writes only after research is available`, async () => {
    const calls = [];
    const result = await makeDraft(...input, { client: successfulClient(calls) });
    assert.equal(result.draft, '# 下書き');
    assert.deepEqual(result.searchSources, [{ title: 'Primary source', url: 'https://example.com/source' }]);
    assert.deepEqual(calls, ['research', 'write']);
  });

  for (const [description, content] of [
    ['empty', []],
    ['text-only', [{ type: 'text', text: '出典なしの調査メモ' }]],
    ['source-only', [{ type: 'web_search_tool_result', content: [{ title: 'Primary source', url: 'https://example.com/source' }] }]],
    ['unsafe source', [
      { type: 'text', text: '安全でない出典だけを含む調査メモ' },
      { type: 'web_search_tool_result', content: [{ title: 'Unsafe', url: 'javascript:alert(1)' }] },
    ]],
  ]) {
    test(`${name} skips writing when research is ${description}`, async () => {
      const calls = [];
      await assert.rejects(
        () => makeDraft(...input, { client: incompleteResearchClient(calls, content) }),
        /取材情報を取得できなかったため、下書き生成を中止しました/,
      );
      assert.deepEqual(calls, ['research']);
    });
  }
}

test('match report writer must always use the approved MOTM fallback without publishing abstention text', async () => {
  const prompts = {};
  await generateMatchReportDraft(matchInfo, { ratings: [], mom: { name: 'Example Player', rating: 8.2 } }, {
    client: async ({ label, prompt }) => {
      prompts[label] = prompt;
      if (label === 'research') {
        return {
          content: [
            { type: 'text', text: '確認済みの取材メモ' },
            { type: 'web_search_tool_result', content: [{ title: 'Primary source', url: 'https://example.com/source' }] },
          ],
        };
      }
      return { content: [{ type: 'text', text: '# 下書き' }] };
    },
  });

  assert.match(prompts.write, /確認できない場合は、採点データのmomがある場合はAM4独自のMOTMとして必ず選出/);
  assert.match(prompts.write, /「AM4選出」と明記/);
  assert.match(prompts.write, /「記載しない」「選出しない」などの不掲載説明は本文に一切書かない/);
});

test('match report strips a prohibited MOTM abstention even when the writer ignores its prompt', async () => {
  const result = await generateMatchReportDraft(matchInfo, { ratings: [], mom: { name: 'Example Player', rating: 8.2 } }, {
    client: async ({ label }) => label === 'research'
      ? {
          content: [
            { type: 'text', text: '確認済みの取材メモ' },
            { type: 'web_search_tool_result', content: [{ title: 'Primary source', url: 'https://example.com/source' }] },
          ],
        }
      : { content: [{ type: 'text', text: '公式MOTM／POTMは確認できなかったため記載しない。Example Playerは決勝点を挙げた。' }] },
  });

  assert.equal(result.draft, 'Example Playerは決勝点を挙げた。\n\n## MOTM\n\nAM4選出MOTM：Example Player。API-FOOTBALLの評価点8.2を基に選出。');
});

test('match report deterministically adds the AM4 MOTM when the writer omits the selection', async () => {
  const result = await generateMatchReportDraft(matchInfo, { ratings: [], mom: { name: 'Example Player', rating: 8.2 } }, {
    client: async ({ label }) => label === 'research'
      ? {
          content: [
            { type: 'text', text: '確認済みの取材メモ' },
            { type: 'web_search_tool_result', content: [{ title: 'Primary source', url: 'https://example.com/source' }] },
          ],
        }
      : { content: [{ type: 'text', text: '試合の分析本文。' }] },
  });

  assert.match(result.draft, /## MOTM\n\nAM4選出MOTM：Example Player。API-FOOTBALLの評価点8\.2を基に選出。$/);
});
