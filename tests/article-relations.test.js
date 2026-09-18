const test = require('node:test');
const assert = require('node:assert/strict');

test('uses explicit article IDs and a full known club label, never a partial name', async () => {
  const { articleRelatedPlayerIds, articleRelatedTeamIds } = await import('../lib/article-relations.js');
  const article = {
    relatedTeamIds: [489, '489', 'bad'],
    relatedPlayerIds: [77, '77'],
    story: { relatedClubs: 'ミラン、United' },
    player: { playerId: 77, teamId: 489 },
  };

  assert.deepEqual(articleRelatedTeamIds(article), [489]);
  assert.deepEqual(articleRelatedPlayerIds(article), [77]);
});

test('allows only public COLUMN kinds in team and player related lists', async () => {
  const { isRelatedColumnArticle } = await import('../lib/article-relations.js');

  assert.equal(isRelatedColumnArticle({ type: 'am4_story', public: true, status: 'published' }), true);
  assert.equal(isRelatedColumnArticle({ type: 'player_intro', public: true, status: 'published' }), true);
  assert.equal(isRelatedColumnArticle({ type: 'match_report', public: true, status: 'published' }), false);
  assert.equal(isRelatedColumnArticle({ type: 'am4_story', public: false, status: 'published' }), false);
});

test('imports only verified numeric Notion entity IDs, never names from prose', async () => {
  const { notionPageToArticle } = await import('../lib/notion-content-sync.js');
  const article = notionPageToArticle({
    type: 'am4_story',
    markdown: '本文には Milan と United が登場する。',
    page: {
      id: 'a1b2c3',
      created_time: '2026-09-14T00:00:00.000Z',
      properties: {
        記事タイトル: { type: 'title', title: [{ plain_text: '検証済みの関連ID' }] },
        'Related Team IDs': { type: 'multi_select', multi_select: [{ name: '489' }, { name: 'Milan' }, { name: '489' }] },
        'Related Player IDs': { type: 'rich_text', rich_text: [{ plain_text: '44, not-an-id 45' }] },
      },
    },
  });

  assert.deepEqual(article.relatedTeamIds, [489]);
  assert.deepEqual(article.relatedPlayerIds, [44, 45]);
});

test('adds a team-detail tag only for an exact verified team ID with a known display label', async () => {
  const { articleRelatedTeams } = await import('../lib/article-store.js');

  assert.deepEqual(articleRelatedTeams({ relatedTeamIds: [489, 'invalid'] }), [{ id: 489, name: 'ミラン' }]);
});
