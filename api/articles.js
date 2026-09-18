// api/articles.js
//
// 試合解説記事(match_report)・選手紹介記事(player_intro)の恒久アーカイブ用、
// 一般公開向けの一覧・個別取得API。実体はlib/article-store.jsのVercel Blobストア。
//
// 公開APIは status:'published' かつ public !== false の記事だけを返す。
// 下書きは同じBlobストアに保持し、同期・生成・編集用の内部経路だけから参照する。
//
// GET /api/articles?type=match_report&fixtureId=123&page=1&pageSize=10
//   … 一覧(新着順、種別・fixture ID絞り込み可)
// GET /api/articles?type=match_report&matchKey=...          … 公開済み試合アーカイブをMatch Keyで照合
// GET /api/articles?id=<slug>                              … 個別記事
// GET /api/articles?trending=1                             … 急上昇選手ランキング(表示用、軽量)
// GET /api/articles?trendingRefresh=1                       … 急上昇選手ランキングの再計算(Cron用)
// GET /api/articles?matchContent=1&fixtureId=...             … 試合ごとの公開済み永続アーカイブ
// GET /api/articles?availability=1&fixtureIds=123,456        … 公開済み試合コンテンツの一括有無
//
// 急上昇選手ランキングは記事データと同じ公開APIに統合している
// (実体はlib/trending-players.js)。監視・修復は公開面と権限を混ぜず、
// 認証済みの api/site-monitor.js だけで実行する。

import { listArticles, getArticle, getMatchContentAvailability, listPublicArticleMetadata } from '../lib/article-store.js';
import { getTrendingPlayersForDisplay, computeAndSaveTrendingPlayers } from '../lib/trending-players.js';
import { isAuthorizedCronRequest } from '../lib/cron-auth.js';
import matchArchive from '../match-archive.js';
import { renderArticleErrorPage, renderArticlePage, renderSitemapXml } from '../lib/article-page-html.js';

const VALID_TYPES = ['match_report', 'match_prediction', 'am4_story', 'player_intro', 'transfer_news'];

export const config = { maxDuration: 120 };

const MATCH_CONTENT_RATE_WINDOW_MS = 60_000;
const MATCH_CONTENT_RATE_LIMIT = 12;
const MATCH_CONTENT_EDITORIAL_TYPES = ['match_prediction', 'match_report'];
const MAX_MATCH_CONTENT_ARCHIVE_PAGES = 10;
const matchContentRateWindows = new Map();
const AVAILABILITY_FIXTURE_LIMIT = 50;
const PUBLIC_ARTICLE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=0';
const ARTICLE_SITEMAP_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=0';
export function publicArticlesCacheControl() {
  return PUBLIC_ARTICLE_CACHE_CONTROL;
}

// Fixture-card badges are fetched in batches and read only the compact public
// archive index. Do not let a CDN response from before a webhook sync hide a
// newly published prediction on the next visit.
export function contentAvailabilityCacheControl() {
  return 'no-store';
}

function publicArticleId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 200 ? id : null;
}

function sendArticlePageError(response, { status, title, heading, message }) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).send(renderArticleErrorPage({ title, heading, message }));
}

// This reuses the existing article Function so the Hobby-plan function count
// stays at 12. The public page is a same-app rewrite of /article.html; the
// browser retains that URL while the JSON API remains /api/articles?id=….
export async function respondWithArticlePage(req, response, { getArticleById = getArticle } = {}) {
  const id = publicArticleId(req?.query?.id);
  if (!id) {
    return sendArticlePageError(response, {
      status: 404,
      title: '記事が見つかりません｜AM4 Football',
      heading: '記事が見つかりません',
      message: 'URLを確認するか、ホームから別の記事を選んでください。',
    });
  }

  try {
    const article = await getArticleById(id, { publishedOnly: true });
    if (!article) {
      return sendArticlePageError(response, {
        status: 404,
        title: '記事が見つかりません｜AM4 Football',
        heading: '記事が見つかりません',
        message: 'URLを確認するか、ホームから別の記事を選んでください。',
      });
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', publicArticlesCacheControl());
    return response.status(200).send(renderArticlePage(article));
  } catch (error) {
    console.error('article page render error:', error);
    return sendArticlePageError(response, {
      status: 503,
      title: '記事を取得できませんでした｜AM4 Football',
      heading: '記事を取得できませんでした',
      message: '一時的な通信障害の可能性があります。時間をおいてもう一度お試しください。',
    });
  }
}

export async function respondWithArticleSitemap(_req, response, { listPublicArticles = listPublicArticleMetadata } = {}) {
  try {
    const articles = await listPublicArticles();
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.setHeader('Cache-Control', ARTICLE_SITEMAP_CACHE_CONTROL);
    return response.status(200).send(renderSitemapXml(articles));
  } catch (error) {
    console.error('article sitemap error:', error);
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    return response.status(503).send('<?xml version="1.0" encoding="UTF-8"?><error>一時的にサイトマップを生成できませんでした。</error>');
  }
}

function fixtureIdFromQuery(value) {
  if (value == null || value === '') return null;
  const fixtureId = Number(value);
  return Number.isInteger(fixtureId) && fixtureId > 0 ? fixtureId : null;
}

function fixtureIdsFromQuery(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const rawIds = value.split(',').map((id) => id.trim());
  if (!rawIds.length || rawIds.length > AVAILABILITY_FIXTURE_LIMIT) return null;
  const fixtureIds = rawIds.map((id) => Number(id));
  if (fixtureIds.some((id) => !Number.isInteger(id) || id <= 0)) return null;
  return [...new Set(fixtureIds)];
}

function matchKeysFromQuery(value) {
  if (value == null || value === '') return [];
  if (typeof value !== 'string') return null;
  const rawKeys = value.split(',').map((matchKey) => matchKey.trim());
  if (!rawKeys.length || rawKeys.length > AVAILABILITY_FIXTURE_LIMIT || rawKeys.some((matchKey) => !matchKey || matchKey.length > 240)) return null;
  const matchKeys = rawKeys.map((matchKey) => matchArchive.canonicalMatchKey(matchKey));
  if (matchKeys.some((matchKey) => !matchKey)) return null;
  return [...new Set(matchKeys)];
}

function requestAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 160);
}

function withinMatchContentRateLimit(req, now = Date.now()) {
  if (matchContentRateWindows.size > 1_000) {
    for (const [key, value] of matchContentRateWindows) {
      if (now - value.startedAt >= MATCH_CONTENT_RATE_WINDOW_MS) matchContentRateWindows.delete(key);
    }
  }
  const key = requestAddress(req);
  const current = matchContentRateWindows.get(key);
  if (!current || now - current.startedAt >= MATCH_CONTENT_RATE_WINDOW_MS) {
    matchContentRateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MATCH_CONTENT_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function allowedMatchContentOrigin(origin) {
  if (!origin) return true;
  return origin === 'https://am4football.com'
    || /^https:\/\/am4-[a-z0-9-]+-am-4\.vercel\.app$/i.test(origin)
    || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
}

function applyMatchContentCors(req, res) {
  const origin = String(req.headers.origin || '');
  // Keep the origin decision explicit even though this response is no-store;
  // it prevents a later cache-policy change from turning a same-origin reply
  // into a cross-origin one.
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  if (allowedMatchContentOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

// This compatibility endpoint used to read Notion during a reader request.
// It is intentionally mirror-only now: the signed webhook/hourly collector
// owns all upstream calls, and a missing mirror record remains retryable until
// that collector has safely synchronized it.  Never cache this response at
// the CDN, or a completed targeted repair can remain invisible to a reader.
export function matchContentCacheControl() {
  return 'no-store';
}

async function listFixtureArchiveEditorials(type, fixtureId, listPublicArticles) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_MATCH_CONTENT_ARCHIVE_PAGES; page += 1) {
    const result = await listPublicArticles({
      type,
      fixtureId,
      page,
      pageSize: 100,
      publishedOnly: true,
      // A Blob/index failure is not evidence that the fixture has no article.
      throwOnError: true,
    });
    for (const article of result?.items || []) {
      if (article?.id && !seen.has(article.id)) {
        seen.add(article.id);
        items.push(article);
      }
    }
    const totalPages = Number(result?.totalPages);
    if (!Number.isInteger(totalPages) || totalPages <= page) return items;
  }
  // A single fixture should only have its (at most) two editorial records.
  // Stop safely rather than allowing a corrupted index to create an unbounded
  // public request. The monitor will retain the inconsistency for repair.
  throw new Error(`fixture ${fixtureId} ${type} archive exceeds page safety limit`);
}

export async function respondWithMatchContent(req, res, {
  listPublicArticles = listArticles,
  getArticleById = getArticle,
  logger = console,
} = {}) {
  const fixtureId = fixtureIdFromQuery(req.query.fixtureId);
  if (!fixtureId) {
    return res.status(400).json({ error: 'fixtureId は有効な試合IDで指定してください' });
  }

  try {
    const listed = await Promise.all(MATCH_CONTENT_EDITORIAL_TYPES.map((type) => (
      listFixtureArchiveEditorials(type, fixtureId, listPublicArticles)
    )));
    const candidates = listed.flat();
    const resolution = matchArchive.resolveArchiveEditorials(candidates, { fixtureId });
    if (resolution.ambiguous || resolution.anchorMismatch) {
      logger?.warn?.('[match-content] persisted archive association is ambiguous', { fixtureId });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(409).json({ error: '試合記事の対応を安全に確定できませんでした', fixtureId });
    }

    const selections = [
      ['prediction', resolution.prediction],
      ['report', resolution.report],
    ].filter(([, article]) => article?.id);
    const fullArticles = await Promise.all(selections.map(async ([property, article]) => {
      const full = await getArticleById(article.id, { publishedOnly: true });
      // The index and article body are switched independently. Treat a split
      // write or a later visibility change as retryable, never as "no article".
      if (!full || !matchArchive.matchesPublishedFixtureEditorial(full, { id: fixtureId })) {
        throw new Error(`fixture ${fixtureId} ${property} archive is inconsistent`);
      }
      return [property, full];
    }));
    const content = Object.fromEntries(fullArticles);
    const identity = content.prediction?.match || content.report?.match || null;
    const canonicalKey = resolution.canonicalKey || matchArchive.canonicalMatchKey(identity);
    res.setHeader('Cache-Control', matchContentCacheControl());
    return res.status(200).json({
      matchKey: identity?.matchKey || canonicalKey || null,
      canonicalKey: canonicalKey || null,
      prediction: content.prediction || null,
      report: content.report || null,
      errors: {},
      partial: false,
    });
  } catch (error) {
    logger?.error?.('[match-content] persisted archive unavailable', {
      fixtureId,
      message: error instanceof Error ? error.message : 'Unknown archive error',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: '公開済み記事アーカイブを取得できませんでした' });
  }
}

export async function respondWithContentAvailability(req, res, {
  getAvailability = getMatchContentAvailability,
  logger = console,
} = {}) {
  const fixtureIds = fixtureIdsFromQuery(req.query.fixtureIds);
  const matchKeys = matchKeysFromQuery(req.query.matchKeys);
  if (!fixtureIds || !matchKeys) {
    return res.status(400).json({ error: `fixtureIds と matchKeys は有効な試合IDまたは完全なMatch Keyを最大${AVAILABILITY_FIXTURE_LIMIT}件、カンマ区切りで指定してください` });
  }
  try {
    // The article index is the public archive's single batched data source;
    // do not call the private Notion bridge or issue per-fixture queries.
    // A storage read failure is not proof that this fixture has no editorial
    // content. Surface a retryable error instead of removing badges/links.
    const availability = await getAvailability(fixtureIds, matchKeys, { fresh: true, throwOnError: true });
    res.setHeader('Cache-Control', contentAvailabilityCacheControl());
    return res.status(200).json(availability);
  } catch (err) {
    logger?.error?.('article availability API error:', err);
    return res.status(500).json({ error: 'コンテンツの取得に失敗しました' });
  }
}

export default async function handler(req, res) {
  if (req.query.articlePage === '1') {
    return respondWithArticlePage(req, res);
  }

  if (req.query.articleSitemap === '1') {
    return respondWithArticleSitemap(req, res);
  }

  if (req.query.matchContent === '1') {
    const origin = String(req.headers.origin || '');
    if (!allowedMatchContentOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });
    applyMatchContentCors(req, res);
    if (!withinMatchContentRateLimit(req)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'しばらくしてからもう一度お試しください' });
    }
    return respondWithMatchContent(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.query.availability === '1') {
    return respondWithContentAvailability(req, res);
  }

  if (req.query.trendingRefresh === '1') {
    if (!isAuthorizedCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await computeAndSaveTrendingPlayers();
      return res.status(200).json(result);
    } catch (err) {
      console.error('trending players refresh error:', err);
      return res.status(500).json({ error: '急上昇選手ランキングの計算に失敗しました', detail: err.message });
    }
  }

  if (req.query.trending === '1') {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    try {
      const result = await getTrendingPlayersForDisplay();
      return res.status(200).json(result);
    } catch (err) {
      console.error('trending players display error:', err);
      // 指示にある「取得失敗時のフォールバック」: 500にはせず、空ランキング+
      // エラー情報を返す(フロント側で「取得できませんでした」を出しつつ、
      // ページ全体は壊さないため)。
      return res.status(200).json({ computedAt: null, ranking: [], trendsOk: false, error: err.message });
    }
  }

  try {
    if (req.query.id) {
      const article = await getArticle(String(req.query.id), { publishedOnly: true });
      if (!article) return res.status(404).json({ error: '記事が見つかりません' });
      res.setHeader('Cache-Control', publicArticlesCacheControl());
      return res.status(200).json({ article });
    }

    const typeParam = req.query.type ? String(req.query.type) : undefined;
    if (typeParam && !VALID_TYPES.includes(typeParam)) {
      return res.status(400).json({ error: `type は ${VALID_TYPES.join(' / ')} のいずれかを指定してください` });
    }

    const pageParam = Number(req.query.page);
    const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
    const pageSizeParam = Number(req.query.pageSize);
    const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam > 0 ? Math.min(pageSizeParam, 100) : 10;
    const matchDate = req.query.matchDate ? String(req.query.matchDate) : undefined;
    if (matchDate && !/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
      return res.status(400).json({ error: 'matchDate は YYYY-MM-DD 形式で指定してください' });
    }
    const fixtureIdParam = req.query.fixtureId == null ? undefined : Number(req.query.fixtureId);
    if (fixtureIdParam !== undefined && (!Number.isInteger(fixtureIdParam) || fixtureIdParam <= 0)) {
      return res.status(400).json({ error: 'fixtureId は有効な試合IDで指定してください' });
    }
    const matchKey = req.query.matchKey ? String(req.query.matchKey).trim().slice(0, 320) : undefined;
    if (matchKey && !matchArchive.canonicalMatchKey(matchKey)) {
      return res.status(400).json({ error: 'matchKey は大会・日付・ホーム・アウェイを含む有効な試合キーで指定してください' });
    }
    const search = req.query.search ? String(req.query.search).trim().slice(0, 120) : undefined;

    const result = await listArticles({
      type: typeParam, matchDate, fixtureId: fixtureIdParam, matchKey, search, page, pageSize,
      publishedOnly: true, throwOnError: true,
    });
    res.setHeader('Cache-Control', publicArticlesCacheControl());
    return res.status(200).json(result);
  } catch (err) {
    console.error('articles API error:', err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
