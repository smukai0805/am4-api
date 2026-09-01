// api/articles.js
//
// 試合解説記事(match_report)・選手紹介記事(player_intro)の恒久アーカイブ用、
// 一般公開向けの一覧・個別取得API。実体はlib/article-store.jsのVercel Blobストア。
//
// 【現状の公開ステータスについて】記事はすべてstatus:'draft'で保存される(レビュー後に
// 公開フラグを立てる運用は今後別途整備予定)。このエンドポイントは現段階では
// status に関わらず全件を返す(公開フローが無い今の時点でdraftのみ除外すると、
// フロントに何も表示されなくなってしまうため)。
//
// GET /api/articles?type=match_report&page=1&pageSize=10  … 一覧(新着順、種別絞り込み可)
// GET /api/articles?id=<slug>                              … 個別記事
// GET /api/articles?trending=1                             … 急上昇選手ランキング(表示用、軽量)
// GET /api/articles?trendingRefresh=1                       … 急上昇選手ランキングの再計算(Cron用)
// GET /api/articles?notionSync=1                            … Notion編集コンテンツの同期(Cron用)
//
// 【2026-08-04追加】急上昇選手ランキング機能は、Vercel Hobbyプランの関数数上限
// (12個、この追加時点で既に12/12)により新規api/ファイルを増やせないため、
// 記事データ全般を扱う本ファイルに統合した(実体はlib/trending-players.js)。
// vercel.jsonのcronはこのファイルを?trendingRefresh=1付きで定期実行する。

import { listArticles, getArticle } from '../lib/article-store.js';
import { getTrendingPlayersForDisplay, computeAndSaveTrendingPlayers } from '../lib/trending-players.js';
import { syncNotionContent } from '../lib/notion-content-sync.js';

const VALID_TYPES = ['match_report', 'match_prediction', 'am4_story', 'player_intro', 'transfer_news'];

export const config = { maxDuration: 120 };

function isAuthorizedCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers?.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

  try {
    if (req.query.id) {
      const article = await getArticle(String(req.query.id));
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

    const result = await listArticles({ type: typeParam, matchDate, page, pageSize });
    return res.status(200).json(result);
  } catch (err) {
    console.error('articles API error:', err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
