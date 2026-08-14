// api/fixtures.js
// Vercelのサーバーレス関数(Node.js)。
// api/standings.jsと同じ5大リーグを対象に、指定シーズンの全試合データを返す。
// 「試合結果」セクションの日付順/節別ビューが、実際に特定の日付・節を選べるように
// するための実データソース(2026-07-31追加。それまではフロント側にサンプル
// (架空)の試合結果が数件ハードコードされているだけで、日付・節の選択機能は
// 無かった)。
//
// 例: /api/fixtures?league=プレミアリーグ&season=2025
//
// 【2026-07-31修正】ページ読み込み時、このエンドポイント(既定リーグ=プレミアリーグ)と
// api/standings.js(5リーグ分を並列でAPI-Footballへ問い合わせる)がほぼ同時に実行され、
// API-Football側のレート制限(data.errors.rateLimit、HTTPステータス自体は200)に
// 一部だけ引っかかることを確認した(実データ検証で、初回読み込み時のプレミアリーグだけ
// 「日付・節がありません」表示になり、その後の個別のリーグタブ切り替え(単発リクエスト、
// 競合が無い)では問題なく取得できる、という症状で発覚)。リトライ・グローバル
// スロットリング機能を持つlib/api-football-client.jsのapiFootballFetch()に統一した。

import { apiFootballFetch } from '../lib/api-football-client.js';

const LEAGUES = {
  'プレミアリーグ': 39,
  'ラ・リーガ': 140,
  'セリエA': 135,
  'ブンデスリーガ': 78,
  'リーグ・アン': 61,
  'チャンピオンズリーグ': 2,
  // 2026-08-12追加(EL BLANCO連携作業時): クラブの「次節試合カード」的な用途では、
  // 国内リーグ・CL戦だけでなくプレシーズンの親善試合も対象に含めたいという要望があった。
  // API-Footballの/leagues?search=Friendliesで実際に検索したところ、"Friendlies"
  // (id:10、国代表の親善試合)・"Friendlies Women"(id:666)・"Friendlies Clubs"
  // (id:667、クラブの親善試合)の3つが存在することを確認した。クラブの試合カード用途に
  // 合うのはid:667のみ(実データでレアル・マドリードのプレシーズンツアー戦を確認済み、
  // id:10は国代表戦のため0件だった)。
  'クラブ親善試合': 667
};

// api/standings.js・api/top-scorers.jsと同じ範囲・既定値(2026-07-31のPro
// プラン切り替えの根拠はstandings.jsのコメント参照)。
const MIN_SEASON = 2022;
const MAX_SEASON = 2026;
const DEFAULT_SEASON = 2025;

// 終了済み(Match Finished)の試合のみスコア表示の対象にする(延長・PK戦を含む)。
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const FEATURED_LEAGUES = [
  'プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン',
  'チャンピオンズリーグ', 'クラブ親善試合'
];
const FEATURED_FIXTURE_LIMIT = 3;
const FEATURED_HORIZON_DAYS = 45;
const SCHEDULED_STATUSES = new Set(['NS', 'TBD']);
const FEATURED_TEAM_IDS = new Set([
  33, 34, 40, 42, 47, 49, 50, 529, 530, 541, 157, 165, 168, 489, 496, 505, 85,
]);

// Champions Leagueの決勝トーナメント各ラウンド(API-Football表記→日本語ラベル)。
// 2026-07-31追加: リーグフェーズの「第N節」表記と紛らわしいとの指摘を受け、
// 決勝トーナメントは段階名で表示するようにした。
const KNOCKOUT_STAGE_LABELS = {
  'Round of 32': 'ベスト32',
  'Round of 16': 'ベスト16',
  'Quarter-finals': '準々決勝',
  'Semi-finals': '準決勝',
  'Final': '決勝',
};
// 節別タブの並び順に使う値(数字の節より必ず後ろ、かつ決勝トーナメントの
// 進行順になるよう大きめの値を割り振ってある)。
const KNOCKOUT_STAGE_ORDER = {
  'Round of 32': 100,
  'Round of 16': 101,
  'Quarter-finals': 102,
  'Semi-finals': 103,
  'Final': 104,
};

// API-Footballのleague.round(例: "Regular Season - 24"、Champions Leagueの
// リーグフェーズなら"League Stage - 3"、決勝トーナメントなら"Round of 16"等)から、
// 節別タブ用のキー・表示ラベル・並び順を求める。該当しない場合(予選ラウンド・
// プレーオフ等)はnullを返し、節別タブには出さない(日付順タブでは引き続き閲覧できる)。
//
// 【2026-07-31、Champions League対応で修正】当初は文字列中の最初の数字を
// そのまま拾うだけだったが、Champions Leagueの予選ラウンド("1st Qualifying Round"
// 等)にも数字が含まれるため、本戦のリーグフェーズ("League Stage - 1")と
// 同じ節番号1〜3として誤って衝突することが実データ検証で判明した(決勝
// トーナメントの"Round of 16"/"Round of 32"も同様に数字を含み、節と紛らわしい)。
// そのため「Regular Season - N」「League Stage - N」の2形式のみを数字の節として
// 扱うホワイトリスト方式にし、決勝トーナメントの各ラウンドは別途、段階名の
// 固定リスト(KNOCKOUT_STAGE_LABELS)と突き合わせて判定する。
function resolveRoundInfo(rawRound) {
  if (!rawRound) return null;
  const seasonMatch = String(rawRound).match(/^Regular Season\s*-\s*(\d+)$/i);
  if (seasonMatch) {
    const n = Number(seasonMatch[1]);
    return { key: `season-${n}`, label: `第${n}節`, order: n };
  }
  // 2026-07-31: 国内リーグの「第N節」表記と紛らわしいとの指摘を受け、Champions
  // Leagueのリーグフェーズ(旧グループステージ)は「GL第N節」表記にした。
  const stageMatch = String(rawRound).match(/^League Stage\s*-\s*(\d+)$/i);
  if (stageMatch) {
    const n = Number(stageMatch[1]);
    return { key: `league-stage-${n}`, label: `GL第${n}節`, order: n };
  }
  if (KNOCKOUT_STAGE_LABELS[rawRound]) {
    return { key: `ko-${rawRound}`, label: KNOCKOUT_STAGE_LABELS[rawRound], order: KNOCKOUT_STAGE_ORDER[rawRound] };
  }
  return null;
}

function simplifyFixture(f, competition, includeProviderRound = false) {
  const played = FINISHED_STATUSES.includes(f.fixture.status?.short);
  const roundInfo = resolveRoundInfo(f.league.round);
  return {
    id: f.fixture.id,
    date: (f.fixture.date || '').slice(0, 10),
    kickoff: f.fixture.date || null,
    competition,
    roundKey: roundInfo?.key || null,
    roundLabel: roundInfo?.label || (includeProviderRound ? f.league.round : null),
    status: f.fixture.status?.short,
    homeId: f.teams.home.id,
    awayId: f.teams.away.id,
    home: f.teams.home.name,
    away: f.teams.away.name,
    homeLogo: f.teams.home.logo || null,
    awayLogo: f.teams.away.logo || null,
    homeGoals: f.goals.home,
    awayGoals: f.goals.away,
    score: played ? `${f.goals.home}-${f.goals.away}` : '-',
    venue: f.fixture.venue?.name || null,
  };
}

function featuredScore(fixture) {
  const prominentTeams = Number(FEATURED_TEAM_IDS.has(fixture.homeId)) + Number(FEATURED_TEAM_IDS.has(fixture.awayId));
  const competitionWeight = fixture.competition === 'チャンピオンズリーグ' ? 5 : fixture.competition === 'クラブ親善試合' ? 3 : 2;
  return prominentTeams * 10 + competitionWeight;
}

async function getFeaturedFixtures(season) {
  const responses = [];
  const successfulSources = [];
  const errors = {};
  for (const name of FEATURED_LEAGUES) {
    try {
      const data = await apiFootballFetch('/fixtures', { league: LEAGUES[name], season });
      if (data.errors && Object.keys(data.errors).length > 0) {
        console.error(`[featured fixtures] ${name}:`, data.errors);
        errors[name] = data.errors;
        continue;
      }
      successfulSources.push(name);
      responses.push(...(data.response || []).map((fixture) => simplifyFixture(fixture, name, true)));
    } catch (caughtError) {
      console.error(`[featured fixtures] ${name} unavailable:`, caughtError);
      errors[name] = { unavailable: true };
    }
  }

  const now = Date.now();
  const horizon = now + FEATURED_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const upcoming = responses.filter((fixture) =>
    Number.isFinite(Date.parse(fixture.kickoff)) &&
    Date.parse(fixture.kickoff) >= now &&
    SCHEDULED_STATUSES.has(fixture.status)
  );
  const candidates = upcoming.filter((fixture) => Date.parse(fixture.kickoff) <= horizon);
  const ranked = (candidates.length >= FEATURED_FIXTURE_LIMIT ? candidates : upcoming)
    .sort((a, b) => featuredScore(b) - featuredScore(a) || Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const selected = [];
  const usedTeams = new Set();
  for (const fixture of ranked) {
    if (selected.length === FEATURED_FIXTURE_LIMIT) break;
    if (usedTeams.has(fixture.homeId) || usedTeams.has(fixture.awayId)) continue;
    selected.push(fixture);
    usedTeams.add(fixture.homeId); usedTeams.add(fixture.awayId);
  }
  for (const fixture of ranked) {
    if (selected.length === FEATURED_FIXTURE_LIMIT) break;
    if (!selected.some((item) => item.id === fixture.id)) selected.push(fixture);
  }
  return { fixtures: selected, sources: successfulSources, errors };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  const { league, featured } = req.query;

  const seasonParam = Number(req.query.season);
  const SEASON = Number.isInteger(seasonParam) ? seasonParam : DEFAULT_SEASON;
  if (SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
    return res.status(400).json({ error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲で指定してください` });
  }

  try {
    if (featured === '1') {
      const featuredResult = await getFeaturedFixtures(SEASON);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ season: SEASON, ...featuredResult });
    }

    const leagueId = LEAGUES[league];
    if (!leagueId) {
      return res.status(400).json({ error: `league は次のいずれかを指定してください: ${Object.keys(LEAGUES).join(' / ')}` });
    }
    const data = await apiFootballFetch('/fixtures', { league: leagueId, season: SEASON });

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error(`[fixtures] ${league} (league=${leagueId}, season=${SEASON}):`, data.errors);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ league, season: SEASON, errors: data.errors, fixtures: [], rounds: [], dates: [] });
    }

    const roundInfoByKey = new Map();
    const fixtures = (data.response || []).map(f => {
      const roundInfo = resolveRoundInfo(f.league.round);
      if (roundInfo && !roundInfoByKey.has(roundInfo.key)) {
        roundInfoByKey.set(roundInfo.key, roundInfo);
      }
      return simplifyFixture(f, league);
    });

    // 節・段階タブ一覧(並び順つき)・日付一覧(昇順)。フロント側のタブ用。
    const rounds = [...roundInfoByKey.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ key, label }) => ({ key, label }));
    const dates = [...new Set(fixtures.map(f => f.date).filter(Boolean))].sort();

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ league, season: SEASON, fixtures, rounds, dates });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
