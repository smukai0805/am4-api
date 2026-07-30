// api/transfer-news-watch.js
//
// Fabrizio Romano発信の移籍情報をAIのWeb検索で定期的にチェックし、新規性がある場合のみ
// 短い速報テキストとして生成・保存するVercelサーバーレス関数。Vercel Cronで定期実行する
// 想定(vercel.json参照。Hobbyプランのcron頻度制約により実現可能な間隔にしてある)。
//
// academy-debut-watch.js / match-report-watch.js と同じ設計パターンを踏襲している
// (検知→その場で生成→新規性がある分だけ検知済みリストに追加)。
//
// フロー:
//   1. lib/transfer-news-core.js の checkTransferNews() で、PILOT_CLUBS全体を対象に
//      Fabrizio Romano発信の最新移籍情報をWeb検索でまとめて取得(1回のAI呼び出し)
//   2. 各アイテムを (選手, 移籍先クラブ) の正規化キーで検知済みリストと突き合わせ、
//      新規性があるものだけを速報として保存する
//   3. 保存はlib/article-store.js経由(type:'transfer_news')。一覧・詳細は
//      api/articles.jsを使う(新規ファイルを増やさないための再利用)
//
// 【永続化】Vercel Blob(academy-debut-watch.js等と同じプライベートストア)。
// 環境変数: ANTHROPIC_API_KEY が必要。

import { put, get } from '@vercel/blob';
import { checkTransferNews, transferDedupeKey } from '../lib/transfer-news-core.js';
import { saveArticle, listArticles, slugify } from '../lib/article-store.js';
import { PILOT_CLUBS } from '../lib/pilot-clubs.js';

export const config = { maxDuration: 300 };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 検知済み(選手+移籍先クラブ)キーの保存先(Vercel Blob、プライベートアクセス)。
const SEEN_PATHNAME = 'seen-transfer-news.json';

// 同じ移籍情報を再度速報化するまでの最短間隔(日数)。移籍報道は状況が変化しながら
// 何週間も続くことがあるため、完全に永久ブロックはせず一定期間後には再度候補になる。
const DEDUPE_WINDOW_DAYS = 21;

async function loadSeenKeys() {
  try {
    const result = await get(SEEN_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('seen transfer news load error:', err.message);
    return [];
  }
}

async function saveSeenKeys(entries) {
  try {
    await put(SEEN_PATHNAME, JSON.stringify(entries), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('seen transfer news save error:', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 保存済み速報一覧の確認用(簡易レビュー): GET /api/transfer-news-watch?list=1
  // 一般公開用の一覧・詳細APIは api/articles.js を使うこと(こちらは動作確認用の簡易版)。
  if (req.method === 'GET' && req.query.list === '1') {
    const result = await listArticles({ type: 'transfer_news', pageSize: 20 });
    return res.status(200).json({ drafts: result.items });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  try {
    const now = Date.now();
    const windowMs = DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const seenEntriesRaw = await loadSeenKeys();
    // 期限切れ(DEDUPE_WINDOW_DAYSより古い)のエントリはここで間引く。
    const seenEntries = seenEntriesRaw.filter(e => now - new Date(e.seenAt).getTime() < windowMs);
    const seenKeys = new Set(seenEntries.map(e => e.key));

    const clubNames = PILOT_CLUBS.map(c => c.name);
    const debugMode = req.query.debug === '1';
    const { items, rejected, searchSources } = await checkTransferNews(clubNames);

    // 【デバッグ用】本人確認基準を満たさず却下された候補を理由付きでログ出力する。
    // 条件が厳しすぎるのか、そもそも検索がヒットしていないのかを切り分けるための情報
    // (本番のレスポンス形状・cron設定には影響しない。?debug=1でレスポンスにも含める)。
    if (rejected.length > 0) {
      console.error(`transfer news: ${rejected.length}件の候補が本人確認基準を満たさず却下されました:`);
      for (const r of rejected) {
        console.error(`  - ${r.description || '(概要不明)'}: ${r.reason || '(理由不明)'}`);
      }
    } else {
      console.error('transfer news: 却下された候補はありませんでした(検索がヒットしなかった可能性もある。searchSourcesCountを確認)');
    }

    const generated = [];
    const skipped = [];

    for (const item of items) {
      const key = transferDedupeKey(item);
      if (seenKeys.has(key)) {
        skipped.push({ key, reason: '既知の移籍情報のため速報化をスキップ' });
        continue;
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const id = slugify(`${dateStr}-${item.player}-${item.toClub}`) || `transfer-${now}-${generated.length}`;
      const article = {
        id,
        type: 'transfer_news',
        title: item.headline,
        publishedAt: new Date().toISOString(),
        body: item.summary,
        hasScoreTable: null,
        // isHereWeGoはトップレベルにも持たせる(hasScoreTableと同様、一覧の軽量メタデータに
        // 含めてフロント側でバッジ表示の判定に使うため。transfer.isHereWeGoは詳細用の複製)。
        isHereWeGo: item.isHereWeGo === true,
        sources: [{ title: 'Fabrizio Romano', url: item.sourceUrl }],
        status: 'published', // 速報性を優先するため、記事アーカイブ(下書き運用)とは異なり即時公開扱い
        transfer: { player: item.player, fromClub: item.fromClub, toClub: item.toClub, status: item.status, isHereWeGo: item.isHereWeGo === true },
      };
      await saveArticle(article);
      generated.push(article);

      seenKeys.add(key);
      seenEntries.push({ key, player: item.player, toClub: item.toClub, seenAt: new Date().toISOString() });
    }

    if (generated.length > 0 || seenEntries.length !== seenEntriesRaw.length) {
      await saveSeenKeys(seenEntries);
    }

    return res.status(200).json({
      checkedClubs: clubNames.length,
      detectedCount: items.length,
      generatedCount: generated.length,
      generated,
      skipped,
      searchSourcesCount: searchSources.length,
      ...(debugMode ? { debug: { rejected } } : {}),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
