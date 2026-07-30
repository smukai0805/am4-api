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

import crypto from 'node:crypto';
import { put, get } from '@vercel/blob';
import {
  getFixtureDetail,
  getFixtureEvents,
  getFixturePlayers,
  computePlayerRatings,
  generateMatchReportDraft,
  saveDraft,
  loadDraftLog,
} from '../lib/match-report-core.js';

// Web検索を伴うAI記事生成(1試合あたり最大5回のweb_search往復)は数十秒かかることがあり、
// 60秒だと実際にFUNCTION_INVOCATION_TIMEOUTになることを確認したため300秒に拡張
// (Vercelは現在Fluid Compute上で全プランともmaxDuration既定値・上限が300秒)。
export const config = { maxDuration: 300 };

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// academy-debut-watch.jsと同じ対象クラブでパイロット開始(team_idはAPI-Footballの実IDで
// api/player-stats.js の TEAM_IDS 対応表と一致することを確認済み)。
const PILOT_CLUBS = [
  { name: 'Manchester United', teamId: 33 },
  { name: 'Barcelona', teamId: 529 },
  { name: 'Real Madrid', teamId: 541 },
  { name: 'Bayern Munich', teamId: 157 },
  { name: 'Juventus', teamId: 496 },
  { name: 'Paris Saint Germain', teamId: 85 },
];

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

async function apiFootballFetch(path, params) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) {
    throw new Error(`API-Football error: ${res.status} ${await res.text()}`);
  }
  return res.json();
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

  // 保存済み下書き一覧の確認用(簡易レビュー): GET /api/match-report-watch?list=1
  // (旧 api/generate-match-report-article.js の一覧エンドポイントをここに統合。
  //  Vercel Hobbyプランのサーバーレス関数数上限(12個/デプロイ)対策で、当該ファイルは
  //  lib/match-report-core.js に統合し、api/配下の関数としては数えない形にした)
  if (req.method === 'GET' && req.query.list === '1') {
    const log = await loadDraftLog();
    return res.status(200).json({ drafts: log });
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

      const matchInfo = {
        fixtureId,
        homeTeam: fixture.teams.home.name,
        awayTeam: fixture.teams.away.name,
        homeGoals: fixture.goals.home,
        awayGoals: fixture.goals.away,
        competition: fixture.league?.name,
        date: fixture.fixture.date,
        venue: fixture.fixture.venue?.name,
      };
      const tGen = Date.now();
      console.error('[timing] calling generateMatchReportDraft...');
      const { draft, searchSources } = await generateMatchReportDraft(matchInfo, ratingResult);
      console.error(`[timing] generateMatchReportDraft: ${Date.now() - tGen}ms`);

      const entry = {
        id: crypto.randomUUID(),
        match: matchInfo,
        ratings: ratingResult,
        draft,
        searchSources,
        status: 'draft_generated',
        generatedAt: new Date().toISOString(),
      };
      await saveDraft(entry);
      return res.status(200).json(entry);
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

    // 全クラブの終了済みfixturesを並列取得(実行時間対策)。
    const clubResults = await Promise.all(
      PILOT_CLUBS.map(async club => {
        const { fixtures, errors, resultsCount } = await getRecentFinishedFixtures(club.teamId, lookbackDays);
        return { club, fixtures, errors, resultsCount };
      })
    );

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
        const matchInfo = {
          fixtureId: fixture.fixture.id,
          homeTeam: fixture.teams.home.name,
          awayTeam: fixture.teams.away.name,
          homeGoals: fixture.goals.home,
          awayGoals: fixture.goals.away,
          competition: fixture.league?.name,
          date: fixture.fixture.date,
          venue: fixture.fixture.venue?.name,
        };
        const { draft, searchSources } = await generateMatchReportDraft(matchInfo, ratingResult);

        const entry = {
          id: crypto.randomUUID(),
          match: matchInfo,
          ratings: ratingResult,
          draft,
          searchSources,
          status: 'draft_generated',
          generatedAt: new Date().toISOString(),
        };
        await saveDraft(entry);
        generated.push(entry);
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
