// api/academy-debut-watch.js
//
// 下部組織(アカデミー)選手のトップチーム合流・初出場を検知し、新規検知分については
// その場で選手紹介記事の下書き生成まで行うVercelサーバーレス関数。Vercel Cronで
// 1日2回程度自動実行する想定(vercel.json参照)。
//
// フロー:
//   1. PILOT_CLUBS の各クラブについて、直近の試合(fixtures)を取得
//   2. 各試合のスタメン(lineups)を取得
//   3. 出場選手のプロフィール(生年月日等)をAPI-Footballから取得し、年齢を算出
//   4. AGE_THRESHOLD以下 かつ 検知済みリスト未登録の選手を「新規検知」として抽出
//   5. 新規検知した選手について、generate-academy-player-article.js の
//      generateArticleDraft() をその場で呼び出して記事下書きを生成・保存する
//   6. 実際に下書き生成まで完了した選手だけを検知済みリストに追加する
//      (生成に失敗した場合はリストに追加せず、次回実行時に再度候補として拾われる)
//
// 【永続化について】
// Vercelはステートレスなため、検知済み選手リスト(誰の記事をもう生成したか)を
// どこかに保存しておく必要がある。GitHub Contents API経由でリポジトリ内の
// JSONファイルを都度コミットする方式も検討したが、実装・運用(コンフリクト、
// API呼び出しの複雑さ)の割に得るものが少ないため、このリポジトリで既に
// 動作実績のあるVercel Blob(ai-column.jsのコラムアーカイブと同じ仕組み・
// 同じプライベートストア)を採用した。
//
// 【1回の実行あたりの処理人数について】
// 記事生成はWeb検索+AI生成を伴うため、1人あたり数秒〜十数秒かかる。Vercelの
// サーバーレス関数の実行時間上限(Hobbyプランで60秒)を踏まえ、1回の実行で
// 記事生成まで行うのは MAX_ARTICLES_PER_RUN 人までに制限している。それを超えた
// 新規検知分は検知済みリストに追加されないため、次回のCron実行時に改めて
// 候補として拾われ、順次処理される。
//
// 環境変数: API_FOOTBALL_KEY が必要。

import { put, get } from '@vercel/blob';
import { generateArticleDraft } from '../lib/academy-core.js';
import { saveArticle, listArticles, slugify } from '../lib/article-store.js';

// Markdownの下書き本文から見出し(# で始まる行)を抜き出してタイトルにする。
// プロンプト内のフォーマット仕様書見出しがそのまま複製されてしまうことがあるため、
// 「フォーマット(AM4)」を含む見出しは除外し、実際の記事見出しだけを拾う。
// 見つからない場合は選手名+クラブ名をフォールバックにする。
function extractTitle(draft, fallback) {
  const headings = [...(draft || '').matchAll(/^#\s+(.+)$/gm)].map(m => m[1].trim());
  const real = headings.find(h => !h.includes('フォーマット(AM4)'));
  return real || fallback;
}

// ARTICLE_FORMAT_SPEC(構成:1. 見出し 2. プロフィール表...という番号付きリストで
// 指示している)の内容が、そのまま本文に混入してしまうことがある実データ検証で確認した
// 2パターンを除去する:
//   (a) 仕様書見出し行(# 形式・【】形式のどちらでも)が本文の先頭にそのまま複製される
//   (b) 各セクション見出しに"1. ""2. "等、仕様書の番号がそのまま付いてしまう
//       (例: "## 2. プロフィール" → "## プロフィール")
function cleanArticleBody(draft) {
  let text = (draft || '').replace(/^.*フォーマット\(AM4\).*\n+/m, '');
  text = text.replace(/^(#{1,3})\s+\d+\.\s*/gm, '$1 ');
  return text;
}

async function buildAndSaveArticle(candidate, profile) {
  const { draft: rawDraft, searchSources } = await generateArticleDraft(candidate, profile);
  const draft = cleanArticleBody(rawDraft);
  const dateStr = (candidate.fixtureDate || '').slice(0, 10);
  const id = slugify(`${dateStr}-${candidate.name}`) || `player-intro-${candidate.playerId}`;
  const fallbackTitle = `${candidate.name}(${candidate.club})`;
  const article = {
    id,
    type: 'player_intro',
    title: extractTitle(draft, fallbackTitle),
    publishedAt: new Date().toISOString(),
    body: draft,
    hasScoreTable: null, // player_introには該当しない
    sources: searchSources,
    status: 'draft',
    player: candidate,
  };
  await saveArticle(article);
  return article;
}

// Web検索を伴うAI記事生成(1人あたり最大5回のweb_search往復)は数十秒かかることがあり、
// match-report-watch.js側で同じパターンが60秒でFUNCTION_INVOCATION_TIMEOUTになることを
// 確認したため300秒に拡張(Vercelは現在Fluid Compute上で全プランともmaxDuration
// 既定値・上限が300秒)。
export const config = { maxDuration: 300 };

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;

// パイロット対象クラブ(5大リーグの主要クラブ、team_idはAPI-Footballの実IDで
// api/player-stats.js の TEAM_IDS 対応表と一致することを確認済み)。
const PILOT_CLUBS = [
  { name: 'Manchester United', teamId: 33 },
  { name: 'Barcelona', teamId: 529 },
  { name: 'Real Madrid', teamId: 541 },
  { name: 'Bayern Munich', teamId: 157 },
  { name: 'Juventus', teamId: 496 },
  { name: 'Paris Saint Germain', teamId: 85 },
];

// 「アカデミー選手」とみなす年齢の上限(この年齢以下の出場を検知対象にする)。
const AGE_THRESHOLD = 20;

// 直近何日分のfixtureを走査するか。
const LOOKBACK_DAYS = 3;

// 検知済み選手リストの保存先(Vercel Blob、プライベートアクセス)。
const SEEN_PATHNAME = 'seen-academy-players.json';

// 1回の実行で記事生成まで行う人数の上限(実行時間対策)。
const MAX_ARTICLES_PER_RUN = 2;

async function apiFootballFetch(path, params) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) {
    throw new Error(`API-Football error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function calcAge(birthDateStr, onDate) {
  const birth = new Date(birthDateStr);
  const ref = onDate || new Date();
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// ヨーロッパのシーズンは概ね7〜8月開始のため、7月以降なら「その年」がシーズン開始年、
// それより前(1〜6月)なら前年開始のシーズンとして扱う(API-Footballのseason命名規則に合わせる)。
function currentSeasonYear(date = new Date()) {
  const month = date.getMonth(); // 0-indexed; 6 = 7月
  return month >= 6 ? date.getFullYear() : date.getFullYear() - 1;
}

async function getRecentFixtures(teamId, lookbackDays) {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);

  // API-Footballの/fixturesは team+from+to だけでは "The Season field is required."
  // というエラー(HTTP自体は200)を返す。season明示が必須。
  const data = await apiFootballFetch('/fixtures', {
    team: teamId,
    from: fmt(from),
    to: fmt(to),
    season: currentSeasonYear(to),
  });
  // API-FootballはHTTPステータス200のまま、パラメータ不正等をdata.errorsに埋めて返す
  // ことがある(res.okだけを見ていると気づけない)。呼び出し元(debugモード)で
  // 原因切り分けできるよう、errorsとresultsも合わせて返す。
  const errors = data.errors && Object.keys(data.errors).length > 0 ? data.errors : null;
  if (errors) console.error(`API-Football /fixtures errors (team=${teamId}):`, errors);
  return { fixtures: data.response || [], errors, results: data.results };
}

async function getLineup(fixtureId, teamId) {
  const data = await apiFootballFetch('/fixtures/lineups', { fixture: fixtureId });
  const teamLineup = (data.response || []).find(l => l.team.id === teamId);
  // 未来の試合や、ラインナップがまだ登録されていない試合ではstartXIが無い(undefined)
  // ことがあるため、配列であることを確認してから使う。
  if (!teamLineup || !Array.isArray(teamLineup.startXI)) return [];
  // まずはスタメン(startXI)出場のみを検知対象にする。「メンバー入り(ベンチ)のみ」も
  // 記事化対象にしたい場合は teamLineup.substitutes も含めて判定ロジックを追加すること。
  return teamLineup.startXI.map(p => p.player);
}

async function loadSeenPlayers() {
  try {
    const result = await get(SEEN_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('seen players load error:', err.message);
    return [];
  }
}

async function saveSeenPlayers(entries) {
  try {
    await put(SEEN_PATHNAME, JSON.stringify(entries), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('seen players save error:', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 保存済み記事一覧の確認用(簡易レビュー): GET /api/academy-debut-watch?list=1
  // 一般公開用の一覧・詳細APIは api/articles.js を使うこと(こちらは動作確認用の簡易版)。
  if (req.method === 'GET' && req.query.list === '1') {
    const result = await listArticles({ type: 'player_intro', pageSize: 50 });
    return res.status(200).json({ drafts: result.items });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  // ?lookbackDays= で走査対象日数を一時的に広げられる(動作確認・チューニング用、既定値は3日)。
  // ?debug=1 でクラブごとのfixture/lineup件数を含めて返す(検知0件時の原因切り分け用)。
  const lookbackDaysParam = Number(req.query.lookbackDays);
  const lookbackDays = Number.isInteger(lookbackDaysParam) && lookbackDaysParam > 0
    ? Math.min(lookbackDaysParam, 30)
    : LOOKBACK_DAYS;
  const debugMode = req.query.debug === '1';
  const clubDebug = [];

  try {
    const seenEntries = await loadSeenPlayers();
    const seenIds = new Set(seenEntries.map(e => e.playerId));

    const candidates = [];
    const profilesById = new Map();

    // 【実行時間対策】各段階(fixtures取得→lineups取得→profiles取得)を、それぞれ
    // クラブ/試合/選手をまたいでPromise.allで並列化する。逐次awaitのままだと、
    // プレシーズンで試合数が多い時期に60秒の実行時間上限へすぐ達してしまうため。

    // 1) 全クラブのfixturesを並列取得
    const clubFixtureResults = await Promise.all(
      PILOT_CLUBS.map(async club => {
        const { fixtures, errors, results } = await getRecentFixtures(club.teamId, lookbackDays);
        return { club, fixtures, errors, results };
      })
    );

    if (debugMode) {
      for (const { club, fixtures, errors, results } of clubFixtureResults) {
        clubDebug.push({
          club: club.name,
          teamId: club.teamId,
          apiResults: results,
          apiErrors: errors,
          fixturesFound: fixtures.length,
          fixtures: fixtures.map(f => ({ id: f.fixture.id, date: f.fixture.date, opponent: f.teams.home.id === club.teamId ? f.teams.away.name : f.teams.home.name })),
        });
      }
    }

    // 2) (クラブ, 試合) の組をフラットにし、lineupsを並列取得
    const fixtureEntries = clubFixtureResults.flatMap(({ club, fixtures }) =>
      fixtures.map(fixture => ({ club, fixture }))
    );
    const lineupResults = await Promise.all(
      fixtureEntries.map(async ({ club, fixture }) => {
        const players = await getLineup(fixture.fixture.id, club.teamId);
        return { club, fixture, players };
      })
    );

    // 3) (クラブ, 試合, 未検知選手) の組をフラットにし、profilesを並列取得
    const playerEntries = lineupResults.flatMap(({ club, fixture, players }) =>
      players
        .filter(p => !seenIds.has(p.id))
        .map(player => ({ club, fixture, player }))
    );
    const profileResults = await Promise.all(
      playerEntries.map(async ({ club, fixture, player }) => {
        // season非依存の /players/profiles で基礎プロフィール(生年月日含む)を取得。
        // ここで取得したプロフィールは、年齢判定だけでなく後段の記事生成にもそのまま使う
        // (二重にAPI-Footballへ問い合わせない)。
        const data = await apiFootballFetch('/players/profiles', { player: player.id });
        return { club, fixture, player, profile: data.response?.[0] || null };
      })
    );

    // 同じ選手が期間中の複数試合(例: プレシーズンの連戦)で条件に合致した場合の重複防止。
    const addedPlayerIds = new Set();

    for (const { club, fixture, player, profile } of profileResults) {
      if (addedPlayerIds.has(player.id)) continue;
      const birthDate = profile?.player?.birth?.date;
      if (!birthDate) continue;

      const age = calcAge(birthDate, new Date(fixture.fixture.date));
      if (age > AGE_THRESHOLD) continue;

      addedPlayerIds.add(player.id);
      candidates.push({
        playerId: player.id,
        name: player.name,
        age,
        club: club.name,
        fixtureId: fixture.fixture.id,
        fixtureDate: fixture.fixture.date,
        opponent:
          fixture.teams.home.id === club.teamId
            ? fixture.teams.away.name
            : fixture.teams.home.name,
        competition: fixture.league?.name,
      });
      profilesById.set(player.id, profile);
    }

    // 記事生成(Web検索+AI生成)は時間・コストがかかるため、1回あたり上限人数まで。
    // 生成に成功した人だけを検知済みリストに追加し、それ以外は次回実行時に再度候補になる。
    const generated = [];
    const pending = [];

    for (const candidate of candidates) {
      if (generated.length >= MAX_ARTICLES_PER_RUN) {
        pending.push(candidate);
        continue;
      }
      try {
        const profile = profilesById.get(candidate.playerId) || null;
        const article = await buildAndSaveArticle(candidate, profile);
        generated.push(article);
        seenEntries.push({
          playerId: candidate.playerId,
          name: candidate.name,
          club: candidate.club,
          firstSeenAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`article generation failed for player ${candidate.playerId}:`, err.message);
        pending.push(candidate);
      }
    }

    if (generated.length > 0) {
      await saveSeenPlayers(seenEntries);
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
