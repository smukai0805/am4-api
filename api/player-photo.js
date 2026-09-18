// api/player-photo.js
// Vercelのサーバーレス関数(Node.js)。
//
// 選手の顔写真URLだけを、名前(姓)から1回のAPI-Football呼び出しで取得する軽量
// エンドポイント。api/player-stats.jsは成績まで含めて1人あたり最大6回のAPI-Football
// リクエスト(プロフィール1回+SEASONS分の成績照会)を行うため、選手一覧・スカッド
// 作成画面のように多数の選手の写真だけをまとめて取得したい場面でそれを使うと、
// レート制限にすぐ達してしまう。
//
// 【2026-08-01発見】football-hub.html側のgetPlayerPhoto()は当初からこのエンドポイントを
// 呼び出す実装になっていたが、このファイル自体がリポジトリに存在しておらず、
// 常に404で失敗し顔写真が一切表示されない状態になっていた(スカッド作成に限らず、
// 選手検索結果等avatarHtml()を使う箇所すべてに影響していた)。今回追加して解消した。
//
// 例: /api/player-photo?search=Haaland
// fullNameを渡すと、姓だけの検索が同姓の別人に当たった場合にフルネームでの再検索へ
// フォールバックする(lib/name-search.js参照。例: search=Mbappé&fullName=Kylian Mbappé)。

import { resolvePlayerProfile } from '../lib/name-search.js';
import { createAdSenseHandler } from '../lib/adsense-loader.js';
import { loadPlayerPageData, loadPlayerSectionData, positiveId as entityPositiveId } from '../lib/team-player-data.js';
import { renderEntityErrorPage, renderPlayerPage, renderPlayerPageFragments } from '../lib/team-player-page-html.js';

function entityReturnPath(value, fallback) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && path.length <= 1200
    ? path
    : fallback;
}

function requestEntityReturnPath(query, fallback) {
  return entityReturnPath(query?.returnPath, entityReturnPath(query?.return, fallback));
}

function entityCacheControl(tab) {
  // The first career slice may include the current season. Keep its public
  // cache aligned with current player statistics rather than serving it stale
  // for most of a day.
  if (tab === 'career') return 's-maxage=300, stale-while-revalidate=600';
  if (tab === 'columns') return 's-maxage=300, stale-while-revalidate=300';
  return 's-maxage=300, stale-while-revalidate=600';
}

function playerErrorPage(res, { status, heading, message }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(renderEntityErrorPage({
    status,
    title: `${heading}｜AM4 Football`,
    heading,
    message,
  }));
}

async function respondWithPlayerPage(req, res) {
  const playerId = entityPositiveId(req.query?.playerId);
  if (!playerId) return playerErrorPage(res, {
    status: 404,
    heading: '選手が見つかりません',
    message: '指定された選手IDは利用できません。',
  });
  if (!process.env.API_FOOTBALL_KEY) return playerErrorPage(res, {
    status: 503,
    heading: '選手情報を取得できませんでした',
    message: '一時的にデータを取得できません。時間をおいてもう一度お試しください。',
  });
  const tab = String(req.query?.tab || 'stats');
  const fallbackPath = `/players/${playerId}${req.query?.tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;
  try {
    const data = await loadPlayerPageData({
      playerId,
      season: req.query?.season,
      leagueId: req.query?.league,
      tab,
      cursor: 0,
    });
    if (data.state === 'not_found') return playerErrorPage(res, {
      status: 404,
      heading: '選手が見つかりません',
      message: '指定された選手、または利用可能な選手情報は見つかりませんでした。',
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', entityCacheControl(data.tab));
    return res.status(200).send(renderPlayerPage(data, {
      origin: 'https://am4football.com',
      requestPath: requestEntityReturnPath(req.query, fallbackPath),
    }));
  } catch (error) {
    console.error(`[player page] ${playerId} unavailable:`, error);
    return playerErrorPage(res, {
      status: 503,
      heading: '選手情報を取得できませんでした',
      message: '一時的にデータを取得できません。時間をおいてもう一度お試しください。',
    });
  }
}

async function respondWithPlayerData(req, res) {
  const playerId = entityPositiveId(req.query?.playerId);
  if (!playerId) return res.status(404).json({ state: 'not_found' });
  if (!process.env.API_FOOTBALL_KEY) return res.status(503).json({ state: 'error', message: '選手情報を取得できませんでした。' });
  const tab = String(req.query?.tab || 'stats');
  try {
    const data = await loadPlayerSectionData({
      playerId,
      season: req.query?.season,
      leagueId: req.query?.league,
      tab,
      cursor: req.query?.cursor,
    });
    if (data.state !== 'ready') return res.status(503).json({ state: 'error', message: data.message || '選手情報を取得できませんでした。' });
    const fragments = renderPlayerPageFragments(data, {
      playerId,
      requestPath: requestEntityReturnPath(req.query, `/players/${playerId}`),
    });
    res.setHeader('Cache-Control', entityCacheControl(data.tab));
    return res.status(200).json({ state: 'ready', tab: data.tab, tabsHtml: fragments.tabsHtml, contentHtml: fragments.contentHtml });
  } catch (error) {
    console.error(`[player data] ${playerId} unavailable:`, error);
    return res.status(503).json({ state: 'error', message: '選手情報を取得できませんでした。' });
  }
}

export default async function handler(req, res) {
  if (String(req.query?.__am4_adsense_loader || '') === '1') {
    return createAdSenseHandler({
      publisherId: process.env.GOOGLE_ADSENSE_PUBLISHER_ID,
    })(req, res);
  }

  if (req.query.playerPage === '1') return respondWithPlayerPage(req, res);
  if (req.query.playerData === '1') return respondWithPlayerData(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, fullName, playerId } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手の姓、3文字以上)が必要です' });
  }

  try {
    let profile;
    if (playerId) {
      const providerId = Number(playerId);
      if (!Number.isInteger(providerId) || providerId <= 0) {
        return res.status(400).json({ error: 'playerId は正の整数で指定してください' });
      }
      const response = await fetch(
        `https://v3.football.api-sports.io/players/profiles?player=${providerId}`,
        { headers: { 'x-apisports-key': API_KEY } }
      );
      if (!response.ok) throw new Error(`取得に失敗: ${response.status}`);
      const data = await response.json();
      profile = data.response?.[0]?.player || null;
    } else {
      profile = await resolvePlayerProfile(API_KEY, { search, fullName });
    }

    // 写真は選手ごとに滅多に変わらないため、長め(1日)にキャッシュしてAPI-Football側の
    // 呼び出し回数を抑える。
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ photo: profile?.photo || null, name: profile?.name || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました' });
  }
}
