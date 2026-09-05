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
// GET /api/articles?id=<slug>                              … 個別記事
// GET /api/articles?trending=1                             … 急上昇選手ランキング(表示用、軽量)
// GET /api/articles?trendingRefresh=1                       … 急上昇選手ランキングの再計算(Cron用)
// GET /api/articles?notionSync=1                            … Notion編集コンテンツの同期(Cron用)
// GET /api/articles?matchContent=1&fixtureId=...             … 試合ごとの最新Notion編集コンテンツ
// GET /api/articles?availability=1&fixtureIds=123,456        … 公開済み試合コンテンツの一括有無
//
// 【2026-08-04追加】急上昇選手ランキング機能は、Vercel Hobbyプランの関数数上限
// (12個、この追加時点で既に12/12)により新規api/ファイルを増やせないため、
// 記事データ全般を扱う本ファイルに統合した(実体はlib/trending-players.js)。
// vercel.jsonのcronはこのファイルを?trendingRefresh=1付きで定期実行する。

import { listArticles, getArticle, getMatchContentAvailability } from '../lib/article-store.js';
import { getTrendingPlayersForDisplay, computeAndSaveTrendingPlayers } from '../lib/trending-players.js';
import { fetchNotionMatchContent, syncNotionContent } from '../lib/notion-content-sync.js';
import { isAuthorizedCronRequest } from '../lib/cron-auth.js';
import { getFixtureIdentity } from './fixtures.js';

const VALID_TYPES = ['match_report', 'match_prediction', 'am4_story', 'player_intro', 'transfer_news'];

export const config = { maxDuration: 120 };

const MATCH_CONTENT_RATE_WINDOW_MS = 60_000;
const MATCH_CONTENT_RATE_LIMIT = 12;
const matchContentRateWindows = new Map();
const AVAILABILITY_FIXTURE_LIMIT = 50;

function validMatchDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
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
  // The response itself is CDN-cacheable.  Vary on Origin even when the
  // request has no Origin header; otherwise a cached same-origin/no-origin
  // response can be served before the handler has a chance to reject a
  // third-party browser origin.
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  if (allowedMatchContentOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

function tokyoDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function matchInputFromFixtureId(fixtureId) {
  const fixture = await getFixtureIdentity(fixtureId);
  if (!fixture?.competition || !fixture?.home?.name || !fixture?.away?.name || !fixture?.kickoff) return null;
  return {
    fixtureId,
    competition: fixture.competition,
    // Match Key follows the provider's fixture date. It can differ from the
    // Japanese display date for evening European kickoffs.
    date: validMatchDate(fixture.date) ? fixture.date : tokyoDateKey(fixture.kickoff),
    homeTeam: fixture.home.name,
    awayTeam: fixture.away.name,
    homeTeamId: Number.isInteger(Number(fixture.home.id)) ? Number(fixture.home.id) : null,
    awayTeamId: Number.isInteger(Number(fixture.away.id)) ? Number(fixture.away.id) : null,
    kickoff: fixture.kickoff || null,
    timezone: fixture.timezone || null,
  };
}

async function respondWithMatchContent(req, res) {
  const fixtureId = fixtureIdFromQuery(req.query.fixtureId);
  if (!fixtureId) {
    return res.status(400).json({ error: 'fixtureId は有効な試合IDで指定してください' });
  }
  let match = null;
  try {
    // Never trust caller-provided club/date text for a Notion lookup. The
    // provider's exact fixture identity protects the private Notion capacity
    // and prevents a crafted URL from requesting unrelated editorial pages.
    match = await matchInputFromFixtureId(fixtureId);
  } catch (error) {
    console.error('[match-content] fixture identity unavailable', {
      fixtureId,
      message: error instanceof Error ? error.message : 'Unknown fixture error',
    });
    return res.status(503).json({ error: '試合情報の取得に失敗しました' });
  }
  if (!match) {
    return res.status(404).json({ error: '指定された試合が見つかりません' });
  }
  if (!process.env.NOTION_API_KEY) {
    console.error('[match-content] NOTION_API_KEY is not configured');
    return res.status(503).json({ error: 'AM4編集コンテンツの設定が未完了です' });
  }

  try {
    const content = await fetchNotionMatchContent({ match });
    const errorCount = Object.keys(content.errors || {}).length;
    if (errorCount === 2) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'AM4編集コンテンツを取得できませんでした', matchKey: content.matchKey });
    }
    // A five-minute CDN cache keeps Notion usage bounded while a state change
    // (including a retraction) cannot remain public for up to an hour.
    res.setHeader('Cache-Control', errorCount
      ? 'public, s-maxage=60, stale-while-revalidate=0'
      : 'public, s-maxage=300, stale-while-revalidate=0');
    return res.status(200).json({ ...content, partial: errorCount > 0 });
  } catch (error) {
    console.error('[match-content] request failed', {
      fixtureId: match.fixtureId,
      competition: match.competition,
      date: match.date,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      message: error instanceof Error ? error.message : 'Unknown Notion error',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'AM4編集コンテンツを取得できませんでした' });
  }
}

async function respondWithContentAvailability(req, res) {
  const fixtureIds = fixtureIdsFromQuery(req.query.fixtureIds);
  if (!fixtureIds) {
    return res.status(400).json({ error: `fixtureIds は有効な試合IDを最大${AVAILABILITY_FIXTURE_LIMIT}件、カンマ区切りで指定してください` });
  }
  try {
    // The article index is the public archive's single batched data source;
    // do not call the private Notion bridge or issue per-fixture queries.
    const availability = await getMatchContentAvailability(fixtureIds);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ availability });
  } catch (err) {
    console.error('article availability API error:', err);
    return res.status(500).json({ error: 'コンテンツの取得に失敗しました' });
  }
}

export default async function handler(req, res) {
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

  if (req.query.notionSync === '1') {
    if (!process.env.CRON_SECRET) {
      return res.status(503).json({ error: 'Notion同期はCRON_SECRETの設定後に有効になります' });
    }
    if (!isAuthorizedCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.NOTION_API_KEY) {
      return res.status(503).json({ error: 'Notion同期の設定が未完了です' });
    }
    try {
      const result = await syncNotionContent();
      const hasSourceFailure = Object.keys(result.errors || {}).length > 0;
      // Make a partial source failure visible to Vercel Cron monitoring rather
      // than silently reporting a successful editorial refresh.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(hasSourceFailure ? 503 : 200).json({ ok: !hasSourceFailure, ...result });
    } catch (err) {
      console.error('notion content sync error:', err);
      return res.status(500).json({ error: 'Notionコンテンツの同期に失敗しました' });
    }
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

  // 公開可否が変わった記事をすぐに取り下げられるよう、公開本文・一覧はCDNに残さない。
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.query.id) {
      const article = await getArticle(String(req.query.id), { publishedOnly: true });
      if (!article) return res.status(404).json({ error: '記事が見つかりません' });
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
    const search = req.query.search ? String(req.query.search).trim().slice(0, 120) : undefined;

    const result = await listArticles({ type: typeParam, matchDate, fixtureId: fixtureIdParam, search, page, pageSize, publishedOnly: true });
    return res.status(200).json(result);
  } catch (err) {
    console.error('articles API error:', err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
