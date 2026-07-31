// api/match-report-watch.js
//
// PILOT_CLUBSの直近終了試合(fixture.status.short === 'FT')を検知し、新規検知分については
// その場で採点算出+試合解説記事の下書き生成まで行うVercelサーバーレス関数。Vercel Cronで
// 主要リーグの試合が多い時間帯後に1日数回実行する想定(vercel.json参照)。
//
// academy-debut-watch.js と同じ設計パターンを踏襲している(検知→その場で生成→
// 生成成功分だけ検知済みリストに追加、失敗/上限超過分は次回リトライ)。
//
// フロー:
//   1. PILOT_CLUBS の各クラブについて、直近の終了済み試合(fixtures, status=FT)を並列取得
//   2. 同じ試合が両クラブの視点から二重に検知されるケース(例: PSG vs Juventus のような
//      パイロット対象クラブ同士の対戦)を、fixture.idで重複排除
//   3. 検知済みリスト(seen-match-reports.json、Vercel Blob)と突き合わせ、未処理の試合を抽出
//   4. 未処理の試合について、generate-match-report-article.js の
//      computePlayerRatings() で機械採点→generateMatchReportDraft() で記事下書き生成
//   5. 生成に成功した試合だけを検知済みリストに追加する(失敗時は次回実行時に再度候補になる)
//
// 【永続化】Vercel Blob(academy-debut-watch.js / ai-column.jsと同じプライベートストア)。
// 【実行時間対策】fixtures取得は全クラブ並列。1回の実行で記事生成まで行うのは
//   MAX_ARTICLES_PER_RUN 試合までに制限(Web検索+AI生成は1試合あたり数秒〜十数秒かかるため)。
//
// 環境変数: API_FOOTBALL_KEY が必要。

import { put, get } from '@vercel/blob';
import {
  getFixtureDetail,
  getFixtureEvents,
  getFixturePlayers,
  computePlayerRatings,
  generateMatchReportDraft,
} from '../lib/match-report-core.js';
import { saveArticle, listArticles, slugify } from '../lib/article-store.js';
import { PILOT_CLUBS } from '../lib/pilot-clubs.js';
import { apiFootballFetch, mapWithConcurrency } from '../lib/api-football-client.js';

// クラブ名が長い場合の略称テーブル(PILOT_CLUBS分)。「3文字程度の略称」という
// 要望に合わせ、一般的なサッカーメディアでの3文字表記に寄せた。対戦相手がこの表に
// 無いクラブの場合は、長い場合のみ先頭3文字を大文字にしたものにフォールバックする。
const CLUB_ABBREVIATIONS = {
  'Manchester United': 'MUN',
  'Barcelona': 'BAR',
  'Real Madrid': 'RMA',
  'Bayern Munich': 'BAY',
  'Juventus': 'JUV',
  'Paris Saint Germain': 'PSG',
  'Manchester City': 'MCI',
  'Liverpool': 'LIV',
  'Chelsea': 'CHE',
  'Arsenal': 'ARS',
  'Tottenham': 'TOT',
  'Newcastle United': 'NEW',
  'AC Milan': 'MIL',
  'Inter Milan': 'INT',
  'Napoli': 'NAP',
};
// この文字数を超えるクラブ名だけ略称に切り替える(短い名前はそのまま読みやすく表示する)。
// 実データ検証で15文字だと「Manchester United」(18文字)まで略称化されてしまい、
// 片方だけ省略された不揃いな見た目になったため、主要クラブの標準的な名前は
// フルネームのまま収まる20文字に引き上げた("Paris Saint Germain"=20文字も含む)。
const MAX_TITLE_CLUB_NAME_LENGTH = 20;

function shortenClubName(name) {
  if (!name) return '';
  if (name.length <= MAX_TITLE_CLUB_NAME_LENGTH) return name;
  return CLUB_ABBREVIATIONS[name] || name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

// API-Footballのleague.round(例: "Regular Season - 32")から節番号だけを取り出す。
// 見つからない場合(カップ戦のノックアウトラウンド等、数字が無い形式)はnullを返す。
function parseRoundNumber(rawRound) {
  if (!rawRound) return null;
  const match = String(rawRound).match(/(\d+)/);
  return match ? match[1] : null;
}

// 一覧・詳細ページのタイトル表示用。ドラマ調の見出し(本文側に残す)ではなく、
// 「何の試合の記事か一覧でぱっと見て分かる」対戦カード形式にする。
function buildMatchupTitle(matchInfo) {
  const roundLabel = matchInfo.round ? `第${matchInfo.round}節 ` : '';
  return `${roundLabel}${shortenClubName(matchInfo.homeTeam)} vs ${shortenClubName(matchInfo.awayTeam)}`;
}

// fixture(API-Footballの/fixturesレスポンス1件)からmatchInfoを組み立てる共通処理。
// 元々POST用テスト経路とCron検知経路の2箇所に同じ組み立てコードが重複していたため統合した。
function buildMatchInfo(fixture) {
  return {
    fixtureId: fixture.fixture.id,
    homeTeam: fixture.teams.home.name,
    awayTeam: fixture.teams.away.name,
    homeGoals: fixture.goals.home,
    awayGoals: fixture.goals.away,
    homeLogo: fixture.teams.home.logo || null,
    awayLogo: fixture.teams.away.logo || null,
    competition: fixture.league?.name,
    round: parseRoundNumber(fixture.league?.round),
    date: fixture.fixture.date,
    venue: fixture.fixture.venue?.name,
  };
}

// ARTICLE_FORMAT_SPEC(構成:1. 見出し 2. リード文...という番号付きリストで
// 指示している)の内容が、そのまま本文に混入してしまうことがある実データ検証で確認した
// 2パターンを除去する:
//   (a) 仕様書見出し行(# 形式・【】形式のどちらでも)が本文の先頭にそのまま複製される
//   (b) 各セクション見出しに"1. ""2. "等、仕様書の番号がそのまま付いてしまう
//       (例: "## 2. 試合概要" → "## 試合概要")
function cleanArticleBody(draft) {
  let text = (draft || '').replace(/^.*フォーマット\(AM4\).*\n+/m, '');
  text = text.replace(/^(#{1,3})\s+\d+\.\s*/gm, '$1 ');
  return text;
}

async function buildAndSaveArticle(matchInfo, ratingResult) {
  const { draft: rawDraft, searchSources } = await generateMatchReportDraft(matchInfo, ratingResult);
  const draft = cleanArticleBody(rawDraft);
  const dateStr = (matchInfo.date || '').slice(0, 10);
  const id = slugify(`${dateStr}-${matchInfo.homeTeam}-vs-${matchInfo.awayTeam}`) || `match-report-${matchInfo.fixtureId}`;
  const article = {
    id,
    type: 'match_report',
    // 2026-07-31: 一覧・詳細のタイトルをドラマ調見出し(本文冒頭に残す)から
    // 対戦カード形式(第N節 ホーム vs アウェイ)に変更。何の試合の記事か一覧で
    // ぱっと見て分かるようにするため。
    title: buildMatchupTitle(matchInfo),
    publishedAt: new Date().toISOString(),
    body: draft,
    hasScoreTable: true, // このパイプラインは選手個別スタッツが無い試合を事前に除外している
    // scoreboard: 一覧カード・詳細ページ上部のスコアボード風表示(クラブロゴ+スコア)用。
    // ロゴはAPI-Footballのfixturesレスポンスに含まれるteams.{home,away}.logoをそのまま使う。
    scoreboard: {
      homeTeam: matchInfo.homeTeam,
      homeLogo: matchInfo.homeLogo,
      homeGoals: matchInfo.homeGoals,
      awayTeam: matchInfo.awayTeam,
      awayLogo: matchInfo.awayLogo,
      awayGoals: matchInfo.awayGoals,
      round: matchInfo.round,
      competition: matchInfo.competition,
    },
    sources: searchSources,
    status: 'draft',
    match: matchInfo,
    ratings: ratingResult,
  };
  await saveArticle(article);
  return article;
}

// Web検索を伴うAI記事生成(1試合あたり最大5回のweb_search往復)は数十秒かかることがあり、
// 60秒だと実際にFUNCTION_INVOCATION_TIMEOUTになることを確認したため300秒に拡張
// (Vercelは現在Fluid Compute上で全プランともmaxDuration既定値・上限が300秒)。
export const config = { maxDuration: 300 };

const API_KEY = process.env.API_FOOTBALL_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 直近何日分のfixtureを走査するか。
const LOOKBACK_DAYS = 3;

// 検知済み試合(記事化済み)の保存先(Vercel Blob、プライベートアクセス)。
const SEEN_PATHNAME = 'seen-match-reports.json';

// 1回の実行で記事生成まで行う試合数の上限(実行時間対策)。
const MAX_ARTICLES_PER_RUN = 2;

// ヨーロッパのシーズンは概ね7〜8月開始のため、7月以降なら「その年」がシーズン開始年、
// それより前(1〜6月)なら前年開始のシーズンとして扱う(API-Footballのseason命名規則に合わせる)。
function currentSeasonYear(date = new Date()) {
  const month = date.getMonth();
  return month >= 6 ? date.getFullYear() : date.getFullYear() - 1;
}

// API-FootballはHTTPステータス200のまま、パラメータ不正等をdata.errorsに埋めて返す
// ことがある(res.okだけを見ていると気づけない。/fixturesはseason必須など)ため、
// errorsも合わせて返す。
async function getRecentFinishedFixtures(teamId, lookbackDays) {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);

  const data = await apiFootballFetch('/fixtures', {
    team: teamId,
    from: fmt(from),
    to: fmt(to),
    season: currentSeasonYear(to),
  });
  const errors = data.errors && Object.keys(data.errors).length > 0 ? data.errors : null;
  if (errors) console.error(`API-Football /fixtures errors (team=${teamId}):`, errors);

  // 終了済み(Match Finished)の試合だけを対象にする。延長・PK戦を経た終了(AET/PEN)も含める。
  const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
  const fixtures = (data.response || []).filter(f => FINISHED_STATUSES.includes(f.fixture.status?.short));
  return { fixtures, errors, resultsCount: data.results };
}

async function loadSeenMatches() {
  try {
    const result = await get(SEEN_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('seen match reports load error:', err.message);
    return [];
  }
}

async function saveSeenMatches(entries) {
  try {
    await put(SEEN_PATHNAME, JSON.stringify(entries), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('seen match reports save error:', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 【一時的な調査用】UEFA Champions LeagueのリーグID・シーズン確認用。
  // GET ?leagueLookup=1&name=Champions%20League
  if (req.method === 'GET' && req.query.leagueLookup === '1') {
    const name = String(req.query.name || 'Champions League');
    const url = new URL('https://v3.football.api-sports.io/leagues');
    url.searchParams.set('search', name);
    const r = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
    const d = await r.json();
    return res.status(200).json({
      results: d.results,
      leagues: (d.response || []).map(l => ({
        id: l.league.id,
        name: l.league.name,
        type: l.league.type,
        country: l.country?.name,
        seasons: (l.seasons || []).filter(s => s.current).map(s => ({ year: s.year, start: s.start, end: s.end, current: s.current })),
      })),
    });
  }

  // 【一時的な調査用】league=2(Champions League)season=2026の実際のfixture分布確認用。
  // GET ?fixturesLookup=1&league=2&season=2026
  if (req.method === 'GET' && req.query.fixturesLookup === '1') {
    const league = String(req.query.league || '2');
    const season = String(req.query.season || '2026');
    const url = new URL('https://v3.football.api-sports.io/fixtures');
    url.searchParams.set('league', league);
    url.searchParams.set('season', season);
    const r = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
    const d = await r.json();
    const fixtures = d.response || [];
    const rounds = [...new Set(fixtures.map(f => f.league.round))];
    const dates = fixtures.map(f => f.fixture.date).sort();
    return res.status(200).json({
      results: d.results,
      errors: d.errors,
      totalFixtures: fixtures.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      rounds,
      sample: fixtures.slice(0, 3).map(f => ({ id: f.fixture.id, date: f.fixture.date, round: f.league.round, status: f.fixture.status?.short, home: f.teams.home.name, away: f.teams.away.name })),
    });
  }

  // 保存済み記事一覧の確認用(簡易レビュー): GET /api/match-report-watch?list=1
  // 一般公開用の一覧・詳細APIは api/articles.js を使うこと(こちらは動作確認用の簡易版)。
  if (req.method === 'GET' && req.query.list === '1') {
    const result = await listArticles({ type: 'match_report', pageSize: 50 });
    return res.status(200).json({ drafts: result.items });
  }

  // 特定の試合を手動で(再)生成したい場合の動作確認・単体テスト用:
  // POST /api/match-report-watch { "fixtureId": 12345 }
  if (req.method === 'POST') {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
    }
    try {
      const { fixtureId } = req.body || {};
      if (!fixtureId) return res.status(400).json({ error: 'fixtureId is required' });

      const tStart = Date.now();
      const fixture = await getFixtureDetail(fixtureId);
      console.error(`[timing] getFixtureDetail: ${Date.now() - tStart}ms`);
      if (!fixture) return res.status(404).json({ error: '指定されたfixtureIdの試合が見つかりませんでした' });

      const tFetch = Date.now();
      const [events, fixturePlayers] = await Promise.all([
        getFixtureEvents(fixtureId),
        getFixturePlayers(fixtureId),
      ]);
      console.error(`[timing] events+players fetch: ${Date.now() - tFetch}ms`);
      console.error(`[debug] events: ${events.length}, fixturePlayers teams: ${fixturePlayers.length}, players per team: ${fixturePlayers.map(t => t.players?.length ?? 0).join(',')}`);
      const teamGoalsConceded = {
        [fixture.teams.home.id]: fixture.goals.away,
        [fixture.teams.away.id]: fixture.goals.home,
      };
      const ratingResult = computePlayerRatings(fixturePlayers, events, fixture.teams.home.id, fixture.teams.away.id, teamGoalsConceded);
      // 親善試合など、API-Footballが選手個別スタッツ(fixtures/players)自体を提供していない
      // 試合が存在する(採点表が必須のフォーマットのため、空の採点で記事化はしない)。
      if (ratingResult.ratings.length === 0) {
        return res.status(422).json({ error: 'この試合は選手個別スタッツが提供されていないため採点できません(親善試合等でAPI-Football側にデータが無い可能性があります)' });
      }

      const matchInfo = buildMatchInfo(fixture);
      const tGen = Date.now();
      console.error('[timing] calling generateMatchReportDraft...');
      const article = await buildAndSaveArticle(matchInfo, ratingResult);
      console.error(`[timing] generateMatchReportDraft: ${Date.now() - tGen}ms`);
      return res.status(200).json(article);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  // ?lookbackDays= で走査対象日数を一時的に広げられる(動作確認・チューニング用、既定値は3日)。
  // ?debug=1 でクラブごとのfixture件数・エラーを含めて返す(検知0件時の原因切り分け用)。
  const lookbackDaysParam = Number(req.query.lookbackDays);
  const lookbackDays = Number.isInteger(lookbackDaysParam) && lookbackDaysParam > 0
    ? Math.min(lookbackDaysParam, 30)
    : LOOKBACK_DAYS;
  const debugMode = req.query.debug === '1';
  const clubDebug = [];

  try {
    const seenEntries = await loadSeenMatches();
    const seenFixtureIds = new Set(seenEntries.map(e => e.fixtureId));

    // 全クラブの終了済みfixturesをバッチ並列取得(実行時間対策)。
    // 【レート制限対策】PILOT_CLUBSを15クラブに拡張した実データ検証で、全クラブを
    // 一斉にPromise.allで叩くとAPI-Football側のレート制限(data.errors.rateLimit)に
    // 一部のクラブが引っかかることを確認したため、一定数ずつのバッチ処理にした
    // (apiFootballFetch側のリトライと合わせて二重に対策)。
    const clubResults = await mapWithConcurrency(PILOT_CLUBS, 5, async club => {
      const { fixtures, errors, resultsCount } = await getRecentFinishedFixtures(club.teamId, lookbackDays);
      return { club, fixtures, errors, resultsCount };
    });

    if (debugMode) {
      for (const { club, fixtures, errors, resultsCount } of clubResults) {
        clubDebug.push({
          club: club.name,
          teamId: club.teamId,
          apiResults: resultsCount,
          apiErrors: errors,
          finishedFixturesFound: fixtures.length,
          fixtures: fixtures.map(f => ({
            id: f.fixture.id,
            date: f.fixture.date,
            home: f.teams.home.name,
            away: f.teams.away.name,
            score: `${f.goals.home}-${f.goals.away}`,
          })),
        });
      }
    }

    // 同じ試合がパイロット対象クラブ同士の対戦(例: PSG vs Juventus)で2回検知される
    // ことがあるため、fixture.idで重複排除する。
    const uniqueFixtures = new Map();
    for (const { fixtures } of clubResults) {
      for (const f of fixtures) {
        if (!seenFixtureIds.has(f.fixture.id)) uniqueFixtures.set(f.fixture.id, f);
      }
    }
    const candidates = [...uniqueFixtures.values()];

    // 記事生成(採点算出+Web検索+AI生成)は時間・コストがかかるため、1回あたり上限試合数まで。
    // 生成に成功した試合だけを検知済みリストに追加し、それ以外は次回実行時に再度候補になる。
    const generated = [];
    const pending = [];

    for (const fixture of candidates) {
      if (generated.length >= MAX_ARTICLES_PER_RUN) {
        pending.push({ fixtureId: fixture.fixture.id, home: fixture.teams.home.name, away: fixture.teams.away.name });
        continue;
      }
      try {
        const [events, fixturePlayers] = await Promise.all([
          getFixtureEvents(fixture.fixture.id),
          getFixturePlayers(fixture.fixture.id),
        ]);
        const teamGoalsConceded = {
          [fixture.teams.home.id]: fixture.goals.away,
          [fixture.teams.away.id]: fixture.goals.home,
        };
        const ratingResult = computePlayerRatings(
          fixturePlayers, events, fixture.teams.home.id, fixture.teams.away.id, teamGoalsConceded
        );
        // 親善試合など、API-Footballが選手個別スタッツを提供していない試合はスキップする
        // (採点表が必須のフォーマットのため、空の採点で記事化はしない)。
        if (ratingResult.ratings.length === 0) {
          throw new Error('選手個別スタッツが提供されていないため採点できません(親善試合等の可能性)');
        }
        const matchInfo = buildMatchInfo(fixture);
        const article = await buildAndSaveArticle(matchInfo, ratingResult);
        generated.push(article);
        seenEntries.push({
          fixtureId: fixture.fixture.id,
          home: matchInfo.homeTeam,
          away: matchInfo.awayTeam,
          seenAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`match report generation failed for fixture ${fixture.fixture.id}:`, err.message);
        pending.push({ fixtureId: fixture.fixture.id, home: fixture.teams.home.name, away: fixture.teams.away.name, error: err.message });
      }
    }

    if (generated.length > 0) {
      await saveSeenMatches(seenEntries);
    }

    return res.status(200).json({
      detectedCount: candidates.length,
      generatedCount: generated.length,
      generated,
      pending, // 次回実行で処理される(または今回生成に失敗した)候補
      lookbackDays,
      ...(debugMode ? { debug: { clubDebug } } : {}),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
