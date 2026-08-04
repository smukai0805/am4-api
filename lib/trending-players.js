// lib/trending-players.js
//
// 「急上昇選手ランキング」機能の中核ロジック。api/articles.jsから呼ばれる
// (Vercel Hobbyプランの関数数上限(12個、2026-08-04時点で12/12)に達しているため、
// 新規api/ファイルは追加せず、既存のapi/articles.js(記事データ全般を扱うハブ)に
// 統合している)。
//
// 【設計方針(2026-08-04、実データ検証を踏まえて決定)】
// 当初はGoogle Trendsの「特定の選手名リストの検索ボリュームを直接比較する」機能を
// ランキングの主軸にする想定だったが、実際に検証したところ該当エンドポイントが
// 429(Too Many Requests)で実用に耐えないことが分かった(lib/google-trends.js冒頭の
// コメント参照)。唯一安定して動くGoogle Trendsの「一般トレンド」RSSも、サッカーに
// 限らない全般的な急上昇ワードで、対象選手データベースとの一致はまれ(実データ検証で
// 6カ国×10件=60件中サッカー関連は数件程度)。
//
// そのため、ランキングの主軸は「サイト内での話題度」(直近の選手紹介記事・移籍速報
// 記事での言及頻度、新しいほど・選手紹介記事の方が移籍速報より重み大)とし、
// Google Trendsの一般トレンドに実際に載っていた選手には🔥急上昇バッジ(+ボーナス
// スコア)を追加する、というハイブリッド設計にした。

import { listArticles } from './article-store.js';
import { fetchTrendingTermsBlob } from './google-trends.js';
import { put, get } from '@vercel/blob';

// Google Trendsの一般トレンドRSSを確認する国(5大リーグの主要国+英語圏)。
const TREND_COUNTRIES = ['GB', 'US', 'ES', 'IT', 'DE', 'FR'];

// この日数より古い記事はランキング対象にしない(「急上昇」の趣旨から、恒久的な
// 話題度ではなく直近の動きを見るため)。
const RECENT_WINDOW_DAYS = 30;

// 選手紹介記事1件・移籍速報1件あたりのスコア(選手紹介記事の方が実質的な取材・
// 記事化コストが高いため重みを大きくしている)。Google Trends一致時のボーナスは
// この2つの重みより大きくし、「実際に世間でも話題になっている」ことを強く反映する。
const SCORE_PLAYER_INTRO = 2;
const SCORE_TRANSFER_NEWS = 1;
const SCORE_GOOGLE_TRENDS_BONUS = 3;

const RANKING_PATHNAME = 'trending-players.json';
const TOP_N = 10;

async function loadStoredRanking() {
  try {
    const result = await get(RANKING_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (err) {
    console.error('trending players: 前回データの読み込みに失敗しました:', err.message);
    return null;
  }
}

async function saveStoredRanking(data) {
  await put(RANKING_PATHNAME, JSON.stringify(data), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

// フロント側の表示用(GET /api/articles?trending=1)。取得失敗時は空のランキング+
// エラー情報を返す(呼び出し元でその旨を表示できるようにする、指示にあった
// 「取得失敗時のフォールバック」対応)。
export async function getTrendingPlayersForDisplay() {
  const stored = await loadStoredRanking();
  if (!stored) {
    return { computedAt: null, ranking: [], trendsOk: false, error: 'まだランキングが計算されていません' };
  }
  return stored;
}

// ランキングを再計算して保存する(cronからの呼び出し用、GET /api/articles?trendingRefresh=1)。
export async function computeAndSaveTrendingPlayers() {
  const now = Date.now();
  const windowMs = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const [playerIntroResult, transferResult, prevStored, trends] = await Promise.all([
    listArticles({ type: 'player_intro', pageSize: 500 }),
    listArticles({ type: 'transfer_news', pageSize: 500 }),
    loadStoredRanking(),
    // Google Trendsの取得自体が失敗しても(fetchTrendingTermsBlob内部で個別に
    // 握りつぶす設計)、ここで例外は投げない。念のため二重にtry/catchしている。
    fetchTrendingTermsBlob(TREND_COUNTRIES).catch(err => {
      console.error('trending players: Google Trends取得が全体的に失敗しました:', err.message);
      return { text: '', countriesOk: [], countriesFailed: TREND_COUNTRIES.map(geo => ({ geo, reason: err.message })) };
    }),
  ]);

  const scoreByPlayer = new Map();

  function bump(name, weight, extra, articleId, articleType, publishedAt) {
    if (!name) return;
    const key = name.trim().toLowerCase();
    if (!key) return;
    const t = new Date(publishedAt).getTime();
    if (!Number.isFinite(t) || now - t > windowMs) return;
    const cur = scoreByPlayer.get(key) || { displayName: name, score: 0, latestAt: 0 };
    cur.score += weight;
    if (t > cur.latestAt) cur.latestAt = t;
    if (extra.club) cur.club = extra.club;
    if (extra.playerId) cur.playerId = extra.playerId;
    if (extra.clubId) cur.clubId = extra.clubId;
    if (extra.nationality) cur.nationality = extra.nationality;
    if (articleType === 'player_intro') cur.playerIntroArticleId = articleId;
    if (articleType === 'transfer_news') cur.transferNewsArticleId = articleId;
    cur.displayName = name;
    scoreByPlayer.set(key, cur);
  }

  for (const a of playerIntroResult.items) {
    const name = a.subject || a.player?.name;
    bump(name, SCORE_PLAYER_INTRO, {
      club: a.club, playerId: a.player?.playerId, clubId: a.player?.clubId, nationality: a.player?.nationality,
    }, a.id, 'player_intro', a.publishedAt);
  }
  for (const a of transferResult.items) {
    const name = a.transfer?.player;
    bump(name, SCORE_TRANSFER_NEWS, {
      club: a.transfer?.toClub, clubId: a.transfer?.toClubId,
    }, a.id, 'transfer_news', a.publishedAt);
  }

  // Google Trends一致判定は、選手名の姓(最後の単語)で行う(略称"S. Mfuni"のような
  // 表記だと"Stephen Mfuni"を含む一般トレンドの文章とフルネームでは一致しないため。
  // 3文字未満の姓は誤マッチが多くなるため対象から除外する)。
  for (const info of scoreByPlayer.values()) {
    const surname = info.displayName.trim().split(/\s+/).pop().toLowerCase();
    info.isGoogleTrending = surname.length >= 3 && trends.text.includes(surname);
    if (info.isGoogleTrending) info.score += SCORE_GOOGLE_TRENDS_BONUS;
  }

  const sorted = [...scoreByPlayer.values()].sort((a, b) => (b.score - a.score) || (b.latestAt - a.latestAt));
  const top = sorted.slice(0, TOP_N);

  const prevRankByPlayer = new Map((prevStored?.ranking || []).map(r => [r.player.trim().toLowerCase(), r.rank]));

  const ranking = top.map((info, i) => ({
    rank: i + 1,
    previousRank: prevRankByPlayer.get(info.displayName.trim().toLowerCase()) ?? null,
    player: info.displayName,
    score: info.score,
    isGoogleTrending: !!info.isGoogleTrending,
    club: info.club || null,
    playerId: info.playerId || null,
    clubId: info.clubId || null,
    nationality: info.nationality || null,
    playerIntroArticleId: info.playerIntroArticleId || null,
    transferNewsArticleId: info.transferNewsArticleId || null,
  }));

  const result = {
    computedAt: new Date().toISOString(),
    trendsOk: trends.countriesOk.length > 0,
    trendsCountriesOk: trends.countriesOk,
    trendsCountriesFailed: trends.countriesFailed,
    ranking,
  };

  try {
    await saveStoredRanking(result);
  } catch (err) {
    // 保存に失敗しても、直前まで保存されていたトップは残る(getTrendingPlayersForDisplay
    // 側は次回もそのまま古いデータを返す=指示にあった「前回取得時のデータを表示する」
    // フォールバックが自然に成立する)。
    console.error('trending players: 保存に失敗しました:', err.message);
  }

  return result;
}
