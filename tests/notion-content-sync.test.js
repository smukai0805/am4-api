import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublishableNotionState, markdownExcerpt, notionPageToArticle, syncNotionContent } from '../lib/notion-content-sync.js';

function textProperty(type, text) {
  return { type, [type]: [{ plain_text: text }] };
}

test('Notion publish states keep review-only content out of the public feed', () => {
  assert.equal(isPublishableNotionState('自動生成'), true);
  assert.equal(isPublishableNotionState('公開準備'), true);
  assert.equal(isPublishableNotionState('公開済'), true);
  assert.equal(isPublishableNotionState('要確認'), false);
});

test('Notion prediction entries preserve an exact match identity and prediction fields', () => {
  const page = {
    id: '11111111-2222-3333-4444-555555555555',
    url: 'https://notion.so/example',
    last_edited_time: '2026-09-01T09:00:00.000Z',
    properties: {
      '記事タイトル': textProperty('title', 'Arsenal vs Liverpool｜次節プレビュー'),
      '記事状態': { type: 'select', select: { name: '公開済' } },
      '生成日時': { type: 'date', date: { start: '2026-09-01T08:30:00.000Z' } },
      'Match Key': textProperty('rich_text', 'fixture-123456'),
      'ホーム': textProperty('rich_text', 'Arsenal'),
      'アウェイ': textProperty('rich_text', 'Liverpool'),
      '大会': { type: 'select', select: { name: 'Premier League' } },
      '試合日': { type: 'date', date: { start: '2026-09-02' } },
      '予想スコア': textProperty('rich_text', '2-1'),
      '本命': textProperty('rich_text', 'Arsenal'),
      '確信度': { type: 'number', number: 82 },
    },
  };

  const article = notionPageToArticle({
    type: 'match_prediction',
    page,
    markdown: '前節で見えた修正点と、欠場者の影響を整理する。\n\n## 注目点\nホームの強度が鍵になる。',
  });

  assert.equal(article.type, 'match_prediction');
  assert.equal(article.match.fixtureId, 123456);
  assert.deepEqual(article.match, {
    fixtureId: 123456,
    matchKey: 'fixture-123456',
    homeTeam: 'Arsenal',
    awayTeam: 'Liverpool',
    date: '2026-09-02',
    competition: 'Premier League',
  });
  assert.deepEqual(article.prediction, { score: '2-1', pick: 'Arsenal', confidence: 82 });
  assert.match(article.summary, /前節で見えた/);
  assert.equal(article.public, true);
});

test('Notion story entries retain the editorial taxonomy and produce a compact excerpt', () => {
  const page = {
    id: 'story-id',
    last_edited_time: '2026-09-01T10:00:00.000Z',
    properties: {
      '記事タイトル': textProperty('title', 'クラシコはなぜ特別なのか'),
      '記事状態': { type: 'select', select: { name: '自動生成' } },
      'カテゴリ': { type: 'select', select: { name: 'ライバル・ダービー' } },
      '主題': textProperty('rich_text', 'エル・クラシコの歴史'),
      '関連クラブ': textProperty('rich_text', 'Real Madrid / FC Barcelona'),
      'Topic Key': textProperty('rich_text', 'rivalry|clasico'),
      'タグ': { type: 'multi_select', multi_select: [{ name: 'La Liga' }, { name: 'Rivalry' }] },
      '表示優先度': { type: 'number', number: 100 },
      '人気順位': { type: 'number', number: 2 },
      'カバー画像': { type: 'url', url: 'https://images.example/clasico.jpg' },
    },
  };
  const article = notionPageToArticle({ type: 'am4_story', page, markdown: '## 見出し\n\n100年以上かけて作られた特別な一戦を読み解く。' });

  assert.equal(article.story.category, 'ライバル・ダービー');
  assert.equal(article.story.relatedClubs, 'Real Madrid / FC Barcelona');
  assert.equal(article.summary, '100年以上かけて作られた特別な一戦を読み解く。');
  assert.deepEqual(article.tags, ['La Liga', 'Rivalry']);
  assert.equal(article.priority, 100);
  assert.equal(article.popularRank, 2);
  assert.equal(article.coverImage, 'https://images.example/clasico.jpg');
  assert.equal(markdownExcerpt('## 見出し\n\n本文'), '本文');
});

test('Notion status properties use the same public-state gate as select properties', () => {
  const page = {
    id: 'status-page',
    properties: {
      '記事タイトル': textProperty('title', 'Status property article'),
      '記事状態': { type: 'status', status: { name: '公開済' } },
    },
  };
  const article = notionPageToArticle({ type: 'am4_story', page, markdown: '本文' });
  assert.equal(article.notion.state, '公開済');
  assert.equal(isPublishableNotionState(article.notion.state), true);
});

test('sync retracts a public mirror when its Notion page is archived or deleted', async () => {
  const articleId = 'notion-match_report-removedpage';
  const records = new Map([[articleId, {
    id: articleId,
    type: 'match_report',
    title: '古い試合解説',
    public: true,
    notion: { pageId: 'removed-page', pageUrl: 'https://notion.so/removed-page', updatedAt: '2026-09-01T00:00:00.000Z', state: '公開済' },
  }]]);
  const store = {
    listArticles: async () => ({ items: [...records.values()], page: 1, totalPages: 1 }),
    getArticle: async (id) => records.get(id) || null,
    saveArticle: async (article) => { records.set(article.id, article); return article; },
  };
  const fetcher = async () => ({ ok: true, json: async () => ({ results: [], has_more: false, next_cursor: null }) });

  const result = await syncNotionContent({
    apiKey: 'test-key',
    fetcher,
    articleStore: store,
    sourceIds: { match_report: 'reports', match_prediction: 'predictions', am4_story: 'stories' },
  });

  assert.equal(result.hidden, 1);
  assert.equal(records.get(articleId).public, false);
  assert.equal(records.get(articleId).notion.state, 'Notionで非公開または削除');
});
