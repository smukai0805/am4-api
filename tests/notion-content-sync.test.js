import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMatchKey, fetchNotionMatchContent, isPublishableNotionState, markdownExcerpt, notionPageToArticle, syncNotionContent } from '../lib/notion-content-sync.js';

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
    canonicalKey: 'premierleague|2026-09-02|arsenal|liverpool',
    homeTeam: 'Arsenal',
    awayTeam: 'Liverpool',
    date: '2026-09-02',
    competition: 'Premier League',
  });
  assert.deepEqual(article.prediction, { score: '2-1', pick: 'Arsenal', confidence: 82 });
  assert.match(article.summary, /前節で見えた/);
  assert.equal(article.public, true);
});

test('Notion uses an explicit fixture ID before a legacy Match Key and retains structured editorial fields', () => {
  const page = {
    id: 'report-with-direct-fixture-id',
    properties: {
      '記事タイトル': textProperty('title', 'Brentford vs Sunderland｜試合解説'),
      '記事状態': { type: 'select', select: { name: '公開済' } },
      'Fixture ID': { type: 'number', number: 654321 },
      'Match Key': textProperty('rich_text', 'fixture-123456'),
      'ホーム': textProperty('rich_text', 'Brentford'),
      'アウェイ': textProperty('rich_text', 'Sunderland'),
      '大会': { type: 'select', select: { name: 'Premier League' } },
      '試合日': { type: 'date', date: { start: '2026-09-05' } },
      '3行要約': textProperty('rich_text', 'AM4の要約です。'),
      '試合を分けたポイント': textProperty('rich_text', '後半の交代で主導権が変わった。'),
      '戦術分析': textProperty('rich_text', '中盤の数的優位が決定的だった。'),
    },
  };

  const article = notionPageToArticle({ type: 'match_report', page, markdown: '本文' });
  assert.equal(article.match.fixtureId, 654321);
  assert.equal(article.match.canonicalKey, 'premierleague|2026-09-05|brentford|sunderland');
  assert.deepEqual(article.report, {
    summary: 'AM4の要約です。',
    turningPoints: '後半の交代で主導権が変わった。',
    tactics: '中盤の数的優位が決定的だった。',
  });
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

test('Notion story entries derive 20 Seasons metadata from the existing Topic Key and subject', () => {
  const page = {
    id: 'twenty-seasons-story',
    properties: {
      '記事タイトル': textProperty('title', 'カカ、欧州の王になる'),
      '記事状態': { type: 'select', select: { name: '自動生成' } },
      'カテゴリ': { type: 'select', select: { name: '大会史' } },
      'Topic Key': textProperty('rich_text', '大会史|20 Seasons, 20 Stories. 2006-07'),
      '主題': textProperty('rich_text', '20 Seasons, 20 Stories. 2006-07シーズン'),
    },
  };

  const article = notionPageToArticle({ type: 'am4_story', page, markdown: '本文' });
  assert.equal(article.story.series, '20 Seasons, 20 Stories.');
  assert.equal(article.story.season, '2006-07');
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

function notionResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function matchPage({ id, type, matchKey, home, away, date, competition = 'Premier League' }) {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: '2026-09-03T10:00:00.000Z',
    properties: {
      '記事タイトル': textProperty('title', `${home} vs ${away}｜${type === 'match_prediction' ? '試合予想' : '試合解説'}`),
      '記事状態': { type: 'select', select: { name: '自動生成' } },
      'Match Key': textProperty('rich_text', matchKey),
      'ホーム': textProperty('rich_text', home),
      'アウェイ': textProperty('rich_text', away),
      '大会': { type: 'select', select: { name: competition } },
      '試合日': { type: 'date', date: { start: date } },
      ...(type === 'match_prediction' ? {
        '予想スコア': textProperty('rich_text', '2-1'),
        '本命': textProperty('rich_text', home),
      } : {}),
    },
  };
}

function editorialBlocks(type) {
  if (type === 'match_prediction') return {
    root: [
      { id: 'prediction-summary', type: 'callout', callout: { rich_text: [{ plain_text: '3行要約' }] }, has_children: true },
      { id: 'prediction-tactics', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '戦術的な噛み合わせ' }] }, has_children: false },
      { id: 'prediction-tactics-copy', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '中盤の数的優位が鍵になる。' }] }, has_children: false },
    ],
    children: {
      'prediction-summary': [
        { id: 'prediction-summary-1', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '守備の安定を評価する。' }] }, has_children: false },
        { id: 'prediction-summary-2', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '速攻への対応が焦点になる。' }] }, has_children: false },
      ],
    },
  };
  return {
    root: [
      { id: 'report-summary', type: 'callout', callout: { rich_text: [{ plain_text: '3行要約' }] }, has_children: true },
      { id: 'report-first-half', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '前半レビュー' }] }, has_children: false },
      { id: 'report-first-half-copy', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'ホームが主導権を握った。' }] }, has_children: false },
      { id: 'report-tactics', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '戦術解説' }] }, has_children: false },
      { id: 'report-tactics-copy', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '左サイドの前進が勝負を分けた。' }] }, has_children: false },
    ],
    children: {
      'report-summary': [
        { id: 'report-summary-1', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '決勝点で均衡が動いた。' }] }, has_children: false },
      ],
    },
  };
}

function matchContentFetcher({ prediction, report, exactMatchKeys = {}, sourceSchemas = {}, unavailableSources = [], predictionSourceId = 'predictions' }) {
  const blocks = {
    [prediction.id]: editorialBlocks('match_prediction'),
    [report.id]: editorialBlocks('match_report'),
  };
  return async (url, init = {}) => {
    const parsedUrl = new URL(url);
    const sourceSchemaMatch = parsedUrl.pathname.match(/\/data_sources\/([^/]+)$/);
    if (sourceSchemaMatch) {
      const sourceId = sourceSchemaMatch[1];
      if (unavailableSources.includes(sourceId)) return notionResponse({ message: 'unavailable' }, 503);
      return sourceSchemas[sourceId]
        ? notionResponse({ properties: sourceSchemas[sourceId] })
        : notionResponse({ message: 'not found' }, 404);
    }
    const sourceMatch = parsedUrl.pathname.match(/\/data_sources\/([^/]+)\/query$/);
    if (sourceMatch) {
      const sourceId = sourceMatch[1];
      if (unavailableSources.includes(sourceId)) return notionResponse({ message: 'unavailable' }, 503);
      const page = sourceId === predictionSourceId ? prediction : report;
      const body = JSON.parse(init.body || '{}');
      const exact = body.filter?.rich_text?.equals;
      const date = body.filter?.date?.equals;
      const fixtureId = body.filter?.number?.equals;
      const pages = fixtureId != null
        ? (Number(page.properties['Fixture ID']?.number) === Number(fixtureId) ? [page] : [])
        : exact
        ? (exact === (exactMatchKeys[sourceId] || page.properties['Match Key'].rich_text[0].plain_text) ? [page] : [])
        : (date === page.properties['試合日'].date.start ? [page] : []);
      return notionResponse({ results: pages, has_more: false, next_cursor: null });
    }
    const blockMatch = parsedUrl.pathname.match(/\/blocks\/([^/]+)\/children$/);
    if (blockMatch) {
      const blockId = blockMatch[1];
      const parent = Object.entries(blocks).find(([pageId, content]) => pageId === blockId || content.children[blockId]);
      if (!parent) return notionResponse({ results: [], has_more: false, next_cursor: null });
      const [pageId, content] = parent;
      const results = pageId === blockId ? content.root : content.children[blockId] || [];
      return notionResponse({ results, has_more: false, next_cursor: null });
    }
    return notionResponse({ message: 'not found' }, 404);
  };
}

test('live match-content lookup reads both real Notion content shapes without a browser token', async () => {
  const prediction = matchPage({
    id: 'prediction-page', type: 'match_prediction', matchKey: 'Premier League|2026-09-06|Arsenal|Chelsea', home: 'Arsenal', away: 'Chelsea', date: '2026-09-06',
  });
  const report = matchPage({
    id: 'report-page', type: 'match_report', matchKey: 'Premier League|2026-09-06|Arsenal|Chelsea', home: 'Arsenal', away: 'Chelsea', date: '2026-09-06',
  });
  const logs = [];
  const result = await fetchNotionMatchContent({
    match: { fixtureId: 1558607, competition: 'プレミアリーグ', date: '2026-09-06', homeTeam: 'Arsenal', awayTeam: 'Chelsea' },
    apiKey: 'test-key',
    fetcher: matchContentFetcher({ prediction, report }),
    sourceIds: { match_prediction: 'predictions', match_report: 'reports' },
    logger: { info: (...args) => logs.push(args), error: () => assert.fail('Notion mock should not fail') },
  });

  assert.equal(result.matchKey, 'Premier League|2026-09-06|Arsenal|Chelsea');
  assert.equal(result.prediction.notion.pageId, 'prediction-page');
  assert.equal(result.prediction.prediction.score, '2-1');
  assert.match(result.prediction.prediction.summary, /守備の安定/);
  assert.match(result.prediction.prediction.tacticalMatchup, /中盤の数的優位/);
  assert.equal(result.report.notion.pageId, 'report-page');
  assert.match(result.report.report.summary, /決勝点/);
  assert.match(result.report.report.firstHalf, /主導権/);
  assert.match(result.report.report.tactics, /左サイド/);
  assert.equal(Object.keys(result.errors).length, 0);
  assert.ok(logs.some((entry) => entry[0] === '[match-content] article matched'));
});

test('Match Key alias fallback requires the full competition, date, home and away identity', async () => {
  const prediction = matchPage({
    id: 'milan-prediction', type: 'match_prediction', matchKey: 'Serie A|2026-09-07|Milan|Internazionale', home: 'Milan', away: 'Internazionale', date: '2026-09-07', competition: 'Serie A',
  });
  const report = matchPage({
    id: 'other-report', type: 'match_report', matchKey: 'Serie A|2026-09-07|Roma|Lecce', home: 'Roma', away: 'Lecce', date: '2026-09-07', competition: 'Serie A',
  });
  const result = await fetchNotionMatchContent({
    match: { competition: 'Serie A', date: '2026-09-07', homeTeam: 'AC Milan', awayTeam: 'Inter' },
    apiKey: 'test-key',
    fetcher: matchContentFetcher({ prediction, report }),
    sourceIds: { match_prediction: 'predictions', match_report: 'reports' },
    logger: { info: () => {}, error: () => {} },
  });

  assert.equal(canonicalMatchKey({ competition: 'Serie A', date: '2026-09-07', homeTeam: 'AC Milan', awayTeam: 'Inter' }), 'seriea|2026-09-07|acmilan|inter');
  assert.equal(result.prediction.notion.pageId, 'milan-prediction');
  assert.equal(result.report, null);
});

test('an explicit Fixture ID wins even when a legacy Match Key and date are stale', async () => {
  const prediction = matchPage({
    id: 'fixture-id-prediction', type: 'match_prediction', matchKey: 'Premier League|2026-08-01|Old Home|Old Away', home: 'Old Home', away: 'Old Away', date: '2026-08-01',
  });
  prediction.properties['Fixture ID'] = { type: 'number', number: 1557387 };
  const report = matchPage({
    id: 'no-report', type: 'match_report', matchKey: 'Premier League|2026-09-06|Arsenal|Chelsea', home: 'Arsenal', away: 'Chelsea', date: '2026-09-06',
  });
  const result = await fetchNotionMatchContent({
    match: { fixtureId: 1557387, competition: 'Premier League', date: '2026-09-06', homeTeam: 'Arsenal', awayTeam: 'Chelsea' },
    apiKey: 'test-key',
    fetcher: matchContentFetcher({
      prediction,
      report,
      predictionSourceId: 'fixture-predictions',
      sourceSchemas: { 'fixture-predictions': { 'Fixture ID': { type: 'number' } } },
    }),
    sourceIds: { match_prediction: 'fixture-predictions', match_report: 'fixture-reports' },
    logger: { info: () => {}, error: () => {} },
  });

  assert.equal(result.prediction.notion.pageId, 'fixture-id-prediction');
  assert.equal(result.report.notion.pageId, 'no-report');
});

test('one unavailable Notion source is explicit while the healthy source remains usable', async () => {
  const prediction = matchPage({
    id: 'healthy-prediction', type: 'match_prediction', matchKey: 'Premier League|2026-09-06|Arsenal|Chelsea', home: 'Arsenal', away: 'Chelsea', date: '2026-09-06',
  });
  const report = matchPage({
    id: 'unavailable-report', type: 'match_report', matchKey: 'Premier League|2026-09-06|Arsenal|Chelsea', home: 'Arsenal', away: 'Chelsea', date: '2026-09-06',
  });
  const result = await fetchNotionMatchContent({
    match: { fixtureId: 1557387, competition: 'Premier League', date: '2026-09-06', homeTeam: 'Arsenal', awayTeam: 'Chelsea' },
    apiKey: 'test-key',
    fetcher: matchContentFetcher({ prediction, report, unavailableSources: ['reports'] }),
    sourceIds: { match_prediction: 'predictions', match_report: 'reports' },
    logger: { info: () => {}, error: () => {} },
  });

  assert.equal(result.prediction.notion.pageId, 'healthy-prediction');
  assert.equal(result.report, null);
  assert.deepEqual(result.errors, { match_report: 'unavailable' });
});
