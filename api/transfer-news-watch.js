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
//      新規性があるものだけを速報として保存する(この時点でseenKeysを保存し確定させる)
//   3. 保存はlib/article-store.js経由(type:'transfer_news')。一覧・詳細は
//      api/articles.jsを使う(新規ファイルを増やさないための再利用)
//   4. 【2026-07-31追加】Here we go(isHereWeGo:true)の速報については、対象選手の
//      選手紹介記事(type:'player_intro')を生成/更新し、両記事を相互リンクする
//      (下記「Here we go連動」セクション参照)。新規ファイルは追加せず、
//      academy-debut-watch.jsが使うlib/academy-core.jsの生成ロジックをここでも再利用する。
//
// 【永続化について(重要・2026-07-31明記)】Vercel Blob(academy-debut-watch.js等と
// 同じプライベートストア)。保存した速報は自動削除・自動ローテーションせず、恒久的に
// 保持する(試合解説・選手紹介の記事アーカイブと同じ扱い)。特集タブ上部のセクションで
// 表示件数を絞っているのはUI側の演出であり、データ自体は消えない
// (lib/article-store.js冒頭のコメントも参照)。
// 環境変数: ANTHROPIC_API_KEY, API_FOOTBALL_KEY が必要
// (API_FOOTBALL_KEYはHere we go連動の選手プロフィール検索に使う)。

import { put, get } from '@vercel/blob';
import { checkTransferNews, transferDedupeKey } from '../lib/transfer-news-core.js';
import { generateArticleDraft, searchPlayerProfileByName, calcAge } from '../lib/academy-core.js';
import { saveArticle, getArticle, findArticleBySubject, listArticles, slugify } from '../lib/article-store.js';
import { PILOT_CLUBS } from '../lib/pilot-clubs.js';

export const config = { maxDuration: 300 };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 検知済み(選手+移籍先クラブ)キーの保存先(Vercel Blob、プライベートアクセス)。
const SEEN_PATHNAME = 'seen-transfer-news.json';

// 同じ移籍情報を再度速報化するまでの最短間隔(日数)。移籍報道は状況が変化しながら
// 何週間も続くことがあるため、完全に永久ブロックはせず一定期間後には再度候補になる。
const DEDUPE_WINDOW_DAYS = 21;

// 【Here we go連動】1回の実行で選手紹介記事の生成/更新まで行うのは最大この件数まで。
// checkTransferNews自体が最大280秒(research 220秒+write 60秒、2026-07-31に
// research/write 2段階構成へ変更)かかりうる上に、選手紹介記事の生成(research+write)も
// 最大270秒かかりうるため(academy-core.js参照)、合計でVercelの実行時間上限(300秒)を
// 超えるリスクがある。件数を絞ることで最悪ケースの影響範囲を限定している。
// 速報本体の検知・保存・重複排除(このファイルの主目的)は、この処理より前に完了・保存
// 済みのため、仮にここでタイムアウトしても速報自体が失われることはない。
const MAX_PLAYER_ARTICLES_PER_RUN = 1;

// academy-debut-watch.jsと同じ見出しクリーニング処理(フォーマット仕様書見出しの
// 誤混入除去)。3ファイル目の重複になるが、既存2ファイルの構成を崩さないための判断。
function extractTitle(draft, fallback) {
  const headings = [...(draft || '').matchAll(/^#\s+(.+)$/gm)].map(m => m[1].trim());
  const real = headings.find(h => !h.includes('フォーマット(AM4)'));
  return real || fallback;
}
function cleanArticleBody(draft) {
  let text = (draft || '').replace(/^.*フォーマット\(AM4\).*\n+/m, '');
  text = text.replace(/^(#{1,3})\s+\d+\.\s*/gm, '$1 ');
  return text;
}

// Here we go速報1件について、対象選手の選手紹介記事を生成または更新する。
// - 既存記事があれば(academy-debut-watch.js検知分・過去のHere we go連動分いずれも対象)
//   新規生成はせず、「移籍確定」の追記のみ行う
// - 無ければAPI-Footballで選手名から検索し、見つかった場合のみ新規生成する
//   (見つからない場合はログを残してスキップ。15クラブの範囲外への/からの移籍でも、
//   API-Footballに選手情報さえあれば対象になる)
// 戻り値: 生成/更新した記事のid、またはnull(スキップ/失敗時)
async function generateOrUpdatePlayerArticle(item) {
  const subject = item.player;
  const existingMeta = await findArticleBySubject('player_intro', subject);

  if (existingMeta) {
    const article = await getArticle(existingMeta.id);
    if (!article) {
      console.error(`transfer news: 既存記事メタは見つかったが本体の取得に失敗しました: ${existingMeta.id}`);
      return null;
    }
    const noteDate = new Date().toISOString().slice(0, 10);
    article.body = `${article.body}\n\n---\n\n**【追記 ${noteDate}】** Fabrizio Romanoが"Here we go"と報じ、${item.toClub}への移籍が正式に確定した。`;
    article.publishedAt = new Date().toISOString(); // 新着順一覧で上位に表示されるよう更新扱いにする
    await saveArticle(article);
    console.error(`transfer news: 既存の選手紹介記事に移籍確定の追記を行いました: ${article.id}`);
    return article.id;
  }

  const profile = await searchPlayerProfileByName(subject);
  if (!profile) {
    console.error(`transfer news: API-Footballで選手情報が見つからないため選手紹介記事の生成をスキップしました: ${subject}`);
    return null;
  }

  const candidate = {
    name: subject,
    club: item.toClub,
    age: calcAge(profile.player?.birth?.date),
    triggerDescription: `移籍情報: Fabrizio Romanoが"Here we go"と報道、${item.fromClub ? `${item.fromClub}から` : ''}${item.toClub}への移籍が正式に確定`,
  };

  try {
    const { draft: rawDraft, searchSources } = await generateArticleDraft(candidate, profile);
    const draft = cleanArticleBody(rawDraft);
    const dateStr = new Date().toISOString().slice(0, 10);
    const id = slugify(`${dateStr}-${subject}`) || `player-intro-herewego-${Date.now()}`;
    const fallbackTitle = `${subject}(${item.toClub})`;
    const article = {
      id,
      type: 'player_intro',
      title: extractTitle(draft, fallbackTitle),
      publishedAt: new Date().toISOString(),
      body: draft,
      hasScoreTable: null,
      sources: searchSources,
      status: 'draft',
      subject,
      // club: 見出しがキャッチコピー形式になり選手名・クラブ名を含まなくなったため、
      // 一覧カード・詳細ページのサブ情報として選手名+クラブ名を表示する用。
      club: item.toClub,
      player: candidate,
    };
    await saveArticle(article);
    console.error(`transfer news: Here we go連動で新規に選手紹介記事を生成しました: ${article.id}`);
    return article.id;
  } catch (err) {
    console.error(`transfer news: 選手紹介記事の生成に失敗しました(${subject}):`, err.message);
    return null;
  }
}

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
    const hereWeGoQueue = []; // { item, articleId } のうち、まだ選手記事とリンクしていないもの

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

      if (item.isHereWeGo) hereWeGoQueue.push({ item, articleId: id });
    }

    // 【重要】ここで速報の検知・保存・重複排除を確定させる(チェックポイント)。この後の
    // Here we go連動の選手紹介記事生成は時間がかかりうる(最悪ケースでVercelの実行時間
    // 上限に達する可能性がある)ため、先に本体の処理結果を安全に保存しておく。仮にこの後の
    // 処理でタイムアウトしても、速報自体は失われず、次回実行時に重複して再生成されない。
    if (generated.length > 0 || seenEntries.length !== seenEntriesRaw.length) {
      await saveSeenKeys(seenEntries);
    }

    // 【Here we go連動】対象選手の選手紹介記事を生成/更新し、相互リンクする。
    // 件数はMAX_PLAYER_ARTICLES_PER_RUNまで(理由は同定数の定義コメント参照)。
    // 処理しきれなかった分は次回実行時には再度候補にならない(このHere we go速報自体は
    // 既にseenKeysに記録済みのため)。取りこぼしは許容し、確実性より安全性を優先している。
    const playerArticlesLinked = [];
    for (const { item, articleId } of hereWeGoQueue.slice(0, MAX_PLAYER_ARTICLES_PER_RUN)) {
      try {
        const playerArticleId = await generateOrUpdatePlayerArticle(item);
        if (!playerArticleId) continue;

        // 速報側 → 選手紹介記事へのリンク
        const transferArticle = await getArticle(articleId);
        if (transferArticle) {
          transferArticle.relatedArticleId = playerArticleId;
          await saveArticle(transferArticle);
        }
        // 選手紹介記事側 → 速報へのリンク(逆方向)
        const playerArticle = await getArticle(playerArticleId);
        if (playerArticle) {
          playerArticle.relatedArticleId = articleId;
          await saveArticle(playerArticle);
        }
        playerArticlesLinked.push({ transferArticleId: articleId, playerArticleId });
      } catch (err) {
        console.error(`transfer news: Here we go連動の選手記事リンク処理に失敗しました(${item.player}):`, err.message);
      }
    }

    return res.status(200).json({
      checkedClubs: clubNames.length,
      detectedCount: items.length,
      generatedCount: generated.length,
      generated,
      skipped,
      searchSourcesCount: searchSources.length,
      hereWeGoCount: hereWeGoQueue.length,
      playerArticlesLinked,
      ...(debugMode ? { debug: { rejected } } : {}),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
