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
import { generateArticleDraft, calcAge, getPlayerProfile } from '../lib/academy-core.js';
import { saveArticle, listArticles, slugify } from '../lib/article-store.js';
import { PILOT_CLUBS } from '../lib/pilot-clubs.js';
import { apiFootballFetch, mapWithConcurrency } from '../lib/api-football-client.js';
import { getChampionsLeagueFixtures } from '../lib/champions-league.js';

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
  const triggerDescription = `出場した試合: ${candidate.fixtureDate} vs ${candidate.opponent} (${candidate.competition})`;
  const { draft: rawDraft, searchSources } = await generateArticleDraft({ ...candidate, triggerDescription }, profile);
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
    // subject: transfer-news-watch.js側で「同一選手の記事が既にあるか」を検索する際の
    // キーになる(Here we go連動の重複生成防止。lib/article-store.jsのfindArticleBySubject参照)。
    subject: candidate.name,
    // club: 見出しがキャッチコピー形式になり選手名・クラブ名を含まなくなったため、
    // 一覧カード・詳細ページのサブ情報として選手名+クラブ名を表示する用。
    club: candidate.club,
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

const API_KEY = process.env.API_FOOTBALL_KEY;

// 「アカデミー選手」とみなす年齢の上限(この年齢以下の出場を検知対象にする)。
const AGE_THRESHOLD = 20;

// 直近何日分のfixtureを走査するか。
const LOOKBACK_DAYS = 3;

// 検知済み選手リストの保存先(Vercel Blob、プライベートアクセス)。
const SEEN_PATHNAME = 'seen-academy-players.json';

// 選手ID→生年月日のキャッシュ(Vercel Blob、プライベートアクセス)。
// Champions Leagueを大会単位で検知対象に追加したことで、馴染みの薄い予選ラウンド
// 出場クラブの選手も毎回チェック対象になった。生年月日は変わらない情報のため、
// 一度取得した選手は年齢判定の目的では二度とAPIに問い合わせないようにする
// (キャッシュが無いと「既に成人と分かっている選手」を実行のたびに何十人〜何百人分も
// 再取得することになり、apiFootballFetch側の1リクエストあたり1.1秒の間隔規制と
// 合わせて実行時間上限(300秒)を圧迫し、実際にFUNCTION_INVOCATION_TIMEOUTになることを
// 実データ検証で確認した)。年齢判定を通過した候補者本人の完全なプロフィール
// (国籍・身長等、記事生成に必要な情報)は、このキャッシュがヒットした場合でも
// 記事生成の直前に改めて1回だけ取得する(下記の記事生成ループ参照)。
const PROFILE_CACHE_PATHNAME = 'academy-player-birthdate-cache.json';

// 1回の実行で記事生成まで行う人数の上限(実行時間対策)。
const MAX_ARTICLES_PER_RUN = 2;

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

async function loadProfileCache() {
  try {
    const result = await get(PROFILE_CACHE_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return {};
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (err) {
    console.error('profile cache load error:', err.message);
    return {};
  }
}

async function saveProfileCache(cache) {
  try {
    await put(PROFILE_CACHE_PATHNAME, JSON.stringify(cache), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('profile cache save error:', err.message);
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
    const tStart = Date.now();
    const timings = {};
    const seenEntries = await loadSeenPlayers();
    const seenIds = new Set(seenEntries.map(e => e.playerId));
    const profileCache = await loadProfileCache();
    let profileCacheDirty = false;

    const candidates = [];

    // 【実行時間対策】各段階(fixtures取得→lineups取得→profiles取得)を、それぞれ
    // クラブ/試合/選手をまたいで並列化する。逐次awaitのままだと、プレシーズンで
    // 試合数が多い時期に60秒の実行時間上限へすぐ達してしまうため。
    // 【レート制限対策】PILOT_CLUBSを15クラブに拡張した実データ検証で、全クラブを
    // 一斉にPromise.allで叩くとAPI-Football側のレート制限(data.errors.rateLimit)に
    // 一部のクラブが引っかかることを確認した。そのため各段階ともmapWithConcurrencyで
    // 一定数ずつのバッチ処理にし(バッチ内は並列)、apiFootballFetch側のリトライと
    // 合わせて二重に対策している。

    // 1) 全クラブのfixturesをバッチ並列取得
    const clubFixtureResults = await mapWithConcurrency(PILOT_CLUBS, 5, async club => {
      const { fixtures, errors, results } = await getRecentFixtures(club.teamId, lookbackDays);
      return { club, fixtures, errors, results };
    });
    timings.clubFixturesMs = Date.now() - tStart;

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

    // 1.5) Champions Leagueは「大会単位」で全試合を取得する(対象クラブに関係なく検知
    // 対象にするため、PILOT_CLUBS単位の取得とは別経路)。この経路では「クラブ」の文脈が
    // 無いため、fixture自身のhome/awayチーム情報から擬似的なclubオブジェクトを組み立てる
    // (両チームのラインナップを見る必要がある点がPILOT_CLUBS単位の取得と異なる)。
    const clResult = await getChampionsLeagueFixtures(lookbackDays);
    timings.clFixturesMs = Date.now() - tStart;
    if (debugMode) {
      clubDebug.push({
        club: 'UEFA Champions League(大会単位)',
        teamId: null,
        apiResults: clResult.resultsCount,
        apiErrors: clResult.errors,
        fixturesFound: clResult.fixtures.length,
        fixtures: clResult.fixtures.map(f => ({ id: f.fixture.id, date: f.fixture.date, home: f.teams.home.name, away: f.teams.away.name })),
      });
    }
    const clFixtureEntries = clResult.fixtures.flatMap(fixture => ([
      { club: { name: fixture.teams.home.name, teamId: fixture.teams.home.id }, fixture },
      { club: { name: fixture.teams.away.name, teamId: fixture.teams.away.id }, fixture },
    ]));

    // 2) (クラブ, 試合) の組をフラットにし、lineupsを並列取得。
    // PILOT_CLUBS単位・Champions League大会単位の両経路で同じ(試合, クラブ)の組が
    // 重複することがある(例: PILOT_CLUBSのクラブがCLに出場している場合)ため、
    // ラインナップ取得の前に(fixture.id, teamId)単位で重複排除しておく
    // (無駄なAPI呼び出しを避けるため。最終的な選手単位の重複はaddedPlayerIdsで別途防ぐ)。
    const fixtureEntriesRaw = [
      ...clubFixtureResults.flatMap(({ club, fixtures }) => fixtures.map(fixture => ({ club, fixture }))),
      ...clFixtureEntries,
    ];
    const seenFixtureClubKeys = new Set();
    const fixtureEntries = fixtureEntriesRaw.filter(({ club, fixture }) => {
      const key = `${fixture.fixture.id}-${club.teamId}`;
      if (seenFixtureClubKeys.has(key)) return false;
      seenFixtureClubKeys.add(key);
      return true;
    });
    const lineupResults = await mapWithConcurrency(fixtureEntries, 5, async ({ club, fixture }) => {
      const players = await getLineup(fixture.fixture.id, club.teamId);
      return { club, fixture, players };
    });
    timings.lineupsMs = Date.now() - tStart;
    timings.fixtureEntriesCount = fixtureEntries.length;

    // 3) (クラブ, 試合, 未検知選手) の組をフラットにし、profilesをバッチ並列取得
    const playerEntries = lineupResults.flatMap(({ club, fixture, players }) =>
      players
        .filter(p => !seenIds.has(p.id))
        .map(player => ({ club, fixture, player }))
    );
    // 生年月日キャッシュにヒットする選手はAPIに問い合わせない(上記PROFILE_CACHE_PATHNAME参照)。
    // キャッシュが温まるまでの間や、シーズン進行でCL大会単位の対象試合数が急増した場合の
    // 保険として、キャッシュにヒットしない(=実際にAPIへ問い合わせる)人数にも上限を設ける
    // (1回あたりapiFootballFetchはthrottleで約1.1秒かかるため、無制限だと実行時間上限
    // (300秒)を超えるおそれがある)。上限を超えた分は今回はスキップされ、次回以降の実行で
    // 改めて候補になる(MAX_ARTICLES_PER_RUNと同じ「今回処理しきれない分は次回に回す」考え方)。
    const MAX_FRESH_PROFILE_LOOKUPS_PER_RUN = 60;
    let freshProfileLookupCount = 0;
    const profileResults = await mapWithConcurrency(playerEntries, 5, async ({ club, fixture, player }) => {
      const cachedBirthDate = profileCache[player.id];
      if (cachedBirthDate) {
        return { club, fixture, player, birthDate: cachedBirthDate };
      }
      if (freshProfileLookupCount >= MAX_FRESH_PROFILE_LOOKUPS_PER_RUN) {
        return { club, fixture, player, birthDate: null };
      }
      freshProfileLookupCount++;
      const data = await apiFootballFetch('/players/profiles', { player: player.id });
      const birthDate = data.response?.[0]?.player?.birth?.date || null;
      return { club, fixture, player, birthDate };
    });
    timings.profilesMs = Date.now() - tStart;
    timings.playerEntriesCount = playerEntries.length;
    timings.freshProfileLookupCount = freshProfileLookupCount;

    // 同じ選手が期間中の複数試合(例: プレシーズンの連戦)で条件に合致した場合の重複防止。
    const addedPlayerIds = new Set();

    for (const { club, fixture, player, birthDate } of profileResults) {
      if (birthDate && profileCache[player.id] !== birthDate) {
        profileCache[player.id] = birthDate;
        profileCacheDirty = true;
      }
      if (addedPlayerIds.has(player.id)) continue;
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
    }

    if (profileCacheDirty) {
      await saveProfileCache(profileCache);
    }

    // 【一時的な調査用】検知フェーズ(fixtures/lineups/profiles取得)だけの所要時間を
    // 記事生成(AI)と切り分けて計測するための一時パラメータ。検証後に削除予定。
    if (req.query.skipGeneration === '1') {
      return res.status(200).json({
        detectedCount: candidates.length,
        candidates,
        lookbackDays,
        timings,
        ...(debugMode ? { debug: { clubDebug } } : {}),
      });
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
        // 記事生成には生年月日だけでなく国籍・身長等の完全なプロフィールが必要なため、
        // 年齢判定がキャッシュヒットで済んだ場合でも、実際に記事化する候補者本人については
        // ここで1回だけ改めて取得する(候補者はMAX_ARTICLES_PER_RUNで少数に絞られているため、
        // 追加の呼び出しコストは小さい)。
        const profile = await getPlayerProfile(candidate.playerId);
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
