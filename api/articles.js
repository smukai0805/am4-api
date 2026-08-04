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
//
// 【2026-08-04追加】急上昇選手ランキング機能は、Vercel Hobbyプランの関数数上限
// (12個、この追加時点で既に12/12)により新規api/ファイルを増やせないため、
// 記事データ全般を扱う本ファイルに統合した(実体はlib/trending-players.js)。
// vercel.jsonのcronはこのファイルを?trendingRefresh=1付きで定期実行する。

import { listArticles, getArticle } from '../lib/article-store.js';
import { getTrendingPlayersForDisplay, computeAndSaveTrendingPlayers } from '../lib/trending-players.js';

const VALID_TYPES = ['match_report', 'player_intro', 'transfer_news'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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
    const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam > 0 ? Math.min(pageSizeParam, 50) : 10;

    const result = await listArticles({ type: typeParam, page, pageSize });
    return res.status(200).json(result);
  } catch (err) {
    console.error('articles API error:', err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
