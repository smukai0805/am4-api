// lib/match-report-core.js
//
// api/generate-match-report-article.js から移設した共有ロジック(採点エンジン+記事生成)。
// Vercel Hobbyプランのサーバーレス関数数上限(1デプロイ12個まで)を超えないよう、
// api/配下ではなくlib/配下に置くことで関数としてカウントされないようにしている
// (Vercelはapi/直下のファイルのみを関数としてビルドする)。
//
// match-report-watch.js と match-report-repair.js が利用する共有ロジック。
//
// 【採点ロジックについて(重要)】
// 主観評価を避け、スタッツから機械的に算出することでブレを防止する。採点は
// computePlayerRatings() がAPI-Footballの生スタッツ+試合イベントから決定的に計算する。
// 配点は下のSCORING定数にすべて集約してあるので、後から調整する場合はここだけ変えればよい。
//
// 【キーパス→得点、決定的貢献の加点について】
// API-Footballの選手個別スタッツ(passes.key等)は「その試合で何本キーパスを出したか」の
// 集計値のみで、個々のキーパスがどのシュート/得点に繋がったかまでは分からない。一方、
// fixtures/eventsの各Goalイベントにはassist(誰のパスから生まれた得点か)が明記されている
// ため、「そのアシストが記録された得点」を根拠に「このパスが得点に繋がったため加点」と
// 判定している(=API-Footballが公式に紐付けている情報のみを使い、推測や当てずっぽうの
// 紐付けはしていない)。
//
// 環境変数: API_FOOTBALL_KEY が必要。

import { apiFootballFetch } from './api-football-client.js';

export async function getFixtureDetail(fixtureId) {
  const data = await apiFootballFetch('/fixtures', { id: fixtureId });
  return data.response?.[0] || null;
}

export async function getFixtureEvents(fixtureId) {
  const data = await apiFootballFetch('/fixtures/events', { fixture: fixtureId });
  return data.response || [];
}

export async function getFixturePlayers(fixtureId) {
  const data = await apiFootballFetch('/fixtures/players', { fixture: fixtureId });
  return data.response || [];
}

// ---------------------------------------------------------------------------
// 採点ロジック(配点表)。数値はすべて目安・調整可能な定数として切り出してある。
// ---------------------------------------------------------------------------
export const SCORING = {
  BASE: 6.0,

  GOAL: 0.5,          // 得点1つあたりの基礎加点
  ASSIST: 0.3,        // アシスト1つあたりの基礎加点

  KEY_PASS: 0.05, KEY_PASS_CAP: 0.3,           // キーパス数(上限あり)
  DRIBBLE_SUCCESS: 0.05, DRIBBLE_CAP: 0.25,     // successful dribbles(上限あり)
  SHOT_ON_TARGET: 0.03, SHOT_CAP: 0.15,         // 枠内シュート数(得点にならなかった分。上限あり)

  DUEL_WIN_RATE_THRESHOLD: 0.6, DUEL_MIN_COUNT: 4, DUEL_BONUS: 0.2, // デュエル勝率が高い場合の加点

  PASS_ACCURACY_HIGH: 90, PASS_ACCURACY_HIGH_BONUS: 0.15, // パス成功率が高い場合の加点
  PASS_ACCURACY_LOW: 65, PASS_ACCURACY_LOW_PENALTY: -0.15, // 低い場合の減点

  DEFENSIVE_ACTION: 0.05, DEFENSIVE_ACTION_CAP: 0.3, // タックル+インターセプト+ブロックの合計(上限あり)

  FOUL_COMMITTED: -0.05, FOUL_CAP: -0.2, // ファウル数(上限あり)

  YELLOW_CARD: -0.3,
  RED_CARD: -1.2,

  GK_SAVE: 0.1, GK_SAVE_CAP: 0.6,         // GKのセーブ数(上限あり)
  GK_EXTRA_CONCEDED: -0.15,               // GKの2失点目以降、1失点あたりの追加減点

  CLEAN_SHEET: 0.3,                       // GK/DFで規定分数以上出場かつ無失点の場合の加点
  MIN_MINUTES_FOR_CLEAN_SHEET: 60,

  // 得点・アシストが試合展開に与えた影響度に応じた追加ボーナス(上のGOAL/ASSISTに上乗せ)。
  // opener=0-0からの先制、equalizer=ビハインドからの同点、goAhead=同点/ビハインド
  // からの逆転・勝ち越し、insurance=既にリード中の追加点、consolation=依然ビハインドのままの得点。
  GOAL_CONTEXT_BONUS: { opener: 0.3, equalizer: 0.5, goAhead: 0.6, insurance: 0.15, consolation: 0 },
  ASSIST_CONTEXT_BONUS: { opener: 0.2, equalizer: 0.35, goAhead: 0.45, insurance: 0.1, consolation: 0 },

  MIN_RATING: 4.0,
  MAX_RATING: 10.0,
};

const GOAL_CONTEXT_LABEL_JA = {
  opener: '先制点', equalizer: '同点弾', goAhead: '勝ち越し点', insurance: 'ダメ押し点', consolation: '得点',
};

// 得点イベントを時系列で追い、各ゴールが試合展開のどの局面(先制/同点/逆転/追加点/反撃点)に
// あたるかを判定する。得点者・アシスト者へのボーナス配点の根拠として使う。
function analyzeGoalContexts(events, homeTeamId) {
  const goals = (events || [])
    .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
    .sort((a, b) => (a.time?.elapsed || 0) - (b.time?.elapsed || 0));

  let homeScore = 0, awayScore = 0;
  const contexts = [];

  for (const g of goals) {
    const isHomeTeam = g.team?.id === homeTeamId;
    const beforeDiff = homeScore - awayScore; // 正=ホームリード、負=アウェイリード、0=同点
    const wasScoreless = homeScore === 0 && awayScore === 0; // 文字通り0-0だったか
    if (isHomeTeam) homeScore++; else awayScore++;
    const afterDiff = homeScore - awayScore;

    let context;
    if (beforeDiff === 0 && wasScoreless) {
      context = 'opener'; // 文字通り0-0からの先制点
    } else if ((isHomeTeam && beforeDiff < 0 && afterDiff === 0) || (!isHomeTeam && beforeDiff > 0 && afterDiff === 0)) {
      context = 'equalizer';
    } else if ((isHomeTeam && beforeDiff <= 0 && afterDiff > 0) || (!isHomeTeam && beforeDiff >= 0 && afterDiff < 0)) {
      context = 'goAhead'; // 0-0以外の同点、またはビハインドからの逆転・勝ち越し
    } else if ((isHomeTeam && beforeDiff > 0) || (!isHomeTeam && beforeDiff < 0)) {
      context = 'insurance';
    } else {
      context = 'consolation';
    }

    contexts.push({
      playerId: g.player?.id || null,
      assistPlayerId: g.assist?.id || null,
      context,
      minute: g.time?.elapsed,
    });
  }
  return contexts;
}

// fixtures/players のレスポンス(チームごとの選手スタッツ)+試合イベントから、
// 出場選手の採点を機械的に算出する。teamGoalsConceded は { [teamId]: 失点数 } の形。
export function computePlayerRatings(fixturePlayers, events, homeTeamId, awayTeamId, teamGoalsConceded) {
  const goalContexts = analyzeGoalContexts(events, homeTeamId);
  const ratings = [];

  for (const teamBlock of fixturePlayers || []) {
    const teamId = teamBlock.team?.id;
    const concededByThisTeam = teamGoalsConceded?.[teamId] ?? null;

    for (const p of teamBlock.players || []) {
      const stat = p.statistics?.[0];
      if (!stat || !stat.games?.minutes) continue; // 出場していない選手は採点対象外

      const comments = [];
      let score = SCORING.BASE;
      const minutes = stat.games.minutes;
      const position = stat.games.position;

      const goals = stat.goals?.total || 0;
      const assists = stat.goals?.assists || 0;
      if (goals > 0) score += goals * SCORING.GOAL;
      if (assists > 0) score += assists * SCORING.ASSIST;

      // このプレーヤーが直接関与した得点イベント(得点者/アシスト者として記録されたもの)
      // にだけ、試合展開への影響度に応じたボーナスと補足コメントを付ける。
      const myGoals = goalContexts.filter(g => g.playerId === p.player.id);
      const myAssists = goalContexts.filter(g => g.assistPlayerId === p.player.id);
      for (const g of myGoals) {
        const bonus = SCORING.GOAL_CONTEXT_BONUS[g.context] || 0;
        if (bonus > 0) {
          score += bonus;
          comments.push(`${g.minute}分の${GOAL_CONTEXT_LABEL_JA[g.context]}が勝敗を左右する場面だったため加点`);
        }
      }
      for (const g of myAssists) {
        const bonus = SCORING.ASSIST_CONTEXT_BONUS[g.context] || 0;
        if (bonus > 0) score += bonus;
        comments.push(`${g.minute}分の${GOAL_CONTEXT_LABEL_JA[g.context]}に繋がるアシストを記録したため加点`);
      }

      const keyPasses = stat.passes?.key || 0;
      if (keyPasses > 0) score += Math.min(keyPasses * SCORING.KEY_PASS, SCORING.KEY_PASS_CAP);

      const dribbleSuccess = stat.dribbles?.success || 0;
      if (dribbleSuccess > 0) score += Math.min(dribbleSuccess * SCORING.DRIBBLE_SUCCESS, SCORING.DRIBBLE_CAP);

      const shotsOn = stat.shots?.on || 0;
      if (shotsOn > 0) score += Math.min(shotsOn * SCORING.SHOT_ON_TARGET, SCORING.SHOT_CAP);

      const duelsTotal = stat.duels?.total || 0;
      const duelsWon = stat.duels?.won || 0;
      if (duelsTotal >= SCORING.DUEL_MIN_COUNT && (duelsWon / duelsTotal) >= SCORING.DUEL_WIN_RATE_THRESHOLD) {
        score += SCORING.DUEL_BONUS;
      }

      const passAccuracy = stat.passes?.accuracy ? Number(stat.passes.accuracy) : null;
      if (passAccuracy !== null) {
        if (passAccuracy >= SCORING.PASS_ACCURACY_HIGH) score += SCORING.PASS_ACCURACY_HIGH_BONUS;
        else if (passAccuracy < SCORING.PASS_ACCURACY_LOW) score += SCORING.PASS_ACCURACY_LOW_PENALTY;
      }

      const defensiveActions = (stat.tackles?.total || 0) + (stat.tackles?.interceptions || 0) + (stat.tackles?.blocks || 0);
      if (defensiveActions > 0) score += Math.min(defensiveActions * SCORING.DEFENSIVE_ACTION, SCORING.DEFENSIVE_ACTION_CAP);

      const foulsCommitted = stat.fouls?.committed || 0;
      if (foulsCommitted > 0) score += Math.max(foulsCommitted * SCORING.FOUL_COMMITTED, SCORING.FOUL_CAP);

      const yellow = stat.cards?.yellow || 0;
      const red = stat.cards?.red || 0;
      if (yellow > 0) { score += yellow * SCORING.YELLOW_CARD; comments.push('警告を受けたため減点'); }
      if (red > 0) { score += red * SCORING.RED_CARD; comments.push('退場となったため大幅減点'); }

      const isGK = position === 'G';
      if (isGK) {
        const saves = stat.goals?.saves || 0;
        if (saves > 0) score += Math.min(saves * SCORING.GK_SAVE, SCORING.GK_SAVE_CAP);
        if (concededByThisTeam !== null && concededByThisTeam > 1) {
          score += (concededByThisTeam - 1) * SCORING.GK_EXTRA_CONCEDED;
        }
      }
      if ((isGK || position === 'D') && minutes >= SCORING.MIN_MINUTES_FOR_CLEAN_SHEET && concededByThisTeam === 0) {
        score += SCORING.CLEAN_SHEET;
        comments.push('無失点に貢献したため加点');
      }

      score = Math.max(SCORING.MIN_RATING, Math.min(SCORING.MAX_RATING, score));

      ratings.push({
        playerId: p.player.id,
        name: p.player.name,
        team: teamBlock.team?.name,
        teamId,
        position,
        minutes,
        rating: Math.round(score * 10) / 10,
        comments,
      });
    }
  }

  ratings.sort((a, b) => b.rating - a.rating);
  const mom = ratings[0] || null;
  return { ratings, mom };
}

function insufficientReportInput(message) {
  const error = new Error(message);
  error.code = 'REPORT_INPUT_INSUFFICIENT';
  error.retryable = true;
  return error;
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw insufficientReportInput(`${label}が不足しているため、下書きを生成できません`);
  return text;
}

function requiredGoal(value, label) {
  if (value == null || String(value).trim() === '') {
    throw insufficientReportInput(`${label}が検証できないため、下書きを生成できません`);
  }
  const goal = Number(value);
  if (!Number.isInteger(goal) || goal < 0) {
    throw insufficientReportInput(`${label}が検証できないため、下書きを生成できません`);
  }
  return goal;
}

function optionalText(value) {
  return String(value || '').trim();
}

function escapeTableCell(value) {
  return String(value || '').replace(/[|\r\n]+/gu, ' ').trim();
}

function sourceReferences(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((reference) => {
    try {
      const url = new URL(String(reference?.url || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      const title = String(reference?.title || '').replace(/[\r\n]+/gu, ' ').trim();
      return [{ title: title || null, url: url.href }];
    } catch {
      return [];
    }
  });
}

function validatedRatings(ratingResult, matchInfo, homeTeam, awayTeam) {
  const ratings = Array.isArray(ratingResult?.ratings) ? ratingResult.ratings : [];
  if (!ratings.length) throw insufficientReportInput('出場選手の機械採点が不足しているため、下書きを生成できません');
  const homeTeamId = integerId(matchInfo?.homeTeamId);
  const awayTeamId = integerId(matchInfo?.awayTeamId);
  const teams = new Set();
  const normalized = ratings.map((entry) => {
    const name = requiredText(entry?.name, '選手名');
    const providerTeam = requiredText(entry?.team, '選手所属チーム');
    const teamId = integerId(entry?.teamId);
    const minutes = Number(entry?.minutes);
    const rating = Number(entry?.rating);
    const belongsHome = homeTeamId && teamId ? teamId === homeTeamId : providerTeam === homeTeam;
    const belongsAway = awayTeamId && teamId ? teamId === awayTeamId : providerTeam === awayTeam;
    if ((!belongsHome && !belongsAway)
      || !Number.isFinite(minutes) || minutes <= 0
      || !Number.isFinite(rating) || rating < SCORING.MIN_RATING || rating > SCORING.MAX_RATING) {
      throw insufficientReportInput('機械採点のチーム・出場時間・評価点を検証できないため、下書きを生成できません');
    }
    const team = belongsHome ? homeTeam : awayTeam;
    teams.add(team);
    return {
      name, team, teamId, providerTeam, minutes: Math.round(minutes), rating,
      comments: Array.isArray(entry.comments)
        ? entry.comments.map((comment) => String(comment || '').trim()).filter(Boolean)
        : [],
    };
  });
  if (!teams.has(homeTeam) || !teams.has(awayTeam)) {
    throw insufficientReportInput('両チームの出場選手採点が揃っていないため、下書きを生成できません');
  }
  return normalized;
}

function ratingRows(ratings, team) {
  const teamRatings = ratings.filter((entry) => entry.team === team);
  return teamRatings.map((entry) => {
    const note = entry.comments.length ? entry.comments.join('。') : '機械採点';
    return `| ${escapeTableCell(entry.name)} | ${entry.minutes}分 | ${entry.rating.toFixed(1)} | ${escapeTableCell(note)} |`;
  }).join('\n');
}

function integerId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function eventMinute(event) {
  const elapsed = Number(event?.time?.elapsed);
  const extra = Number(event?.time?.extra);
  if (!Number.isInteger(elapsed) || elapsed < 0 || elapsed > 130) return null;
  return Number.isInteger(extra) && extra > 0 ? `${elapsed}+${extra}` : String(elapsed);
}

// Return a scoring timeline only when the retrieved events exactly reconcile
// with the verified final score.  API-Football can legitimately publish event
// data later than the result; silently omitting a partial timeline is safer
// than presenting it as the whole match or filling the gaps by inference.
function verifiedGoalTimeline(matchInfo, homeGoals, awayGoals) {
  const homeTeamId = integerId(matchInfo?.homeTeamId);
  const awayTeamId = integerId(matchInfo?.awayTeamId);
  if (!homeTeamId || !awayTeamId || !Array.isArray(matchInfo?.events)) return [];
  const timeline = matchInfo.events.flatMap((event, index) => {
    if (event?.type !== 'Goal' || event?.detail === 'Missed Penalty') return [];
    const teamId = integerId(event?.team?.id);
    const minute = eventMinute(event);
    if ((!teamId || (teamId !== homeTeamId && teamId !== awayTeamId)) || !minute) return [];
    const player = String(event?.player?.name || '').replace(/[\r\n]+/gu, ' ').trim();
    return [{ index, teamId, minute, player }];
  });
  const homeCount = timeline.filter((entry) => entry.teamId === homeTeamId).length;
  const awayCount = timeline.filter((entry) => entry.teamId === awayTeamId).length;
  if (homeCount !== homeGoals || awayCount !== awayGoals || !timeline.length) return [];
  return timeline.sort((left, right) => {
    const leftBase = Number(left.minute.split('+')[0]);
    const rightBase = Number(right.minute.split('+')[0]);
    return leftBase - rightBase || left.index - right.index;
  });
}

function goalTimelineMarkdown(timeline, matchInfo) {
  if (!timeline.length) return '';
  const homeTeamId = integerId(matchInfo?.homeTeamId);
  return `\n\n## 検証済みの得点記録\n\n${timeline.map((entry) => {
    const team = entry.teamId === homeTeamId ? matchInfo.homeTeam : matchInfo.awayTeam;
    const scorer = entry.player ? ` — ${entry.player}` : '';
    return `- ${entry.minute}分：${team}${scorer}`;
  }).join('\n')}\n\n上記は取得済みイベントと最終スコアの両方で照合できた得点記録のみを掲載している。`;
}

function verifiedPenaltyResult(matchInfo, homeTeam, awayTeam) {
  if (String(matchInfo?.status || '').trim().toUpperCase() !== 'PEN') return null;
  const home = requiredGoal(matchInfo?.homePenaltyGoals, 'ホームPK得点');
  const away = requiredGoal(matchInfo?.awayPenaltyGoals, 'アウェイPK得点');
  if (home === away) throw insufficientReportInput('PK戦の勝者を検証できないため、下書きを生成できません');
  return { home, away, winner: home > away ? homeTeam : awayTeam };
}

// 検証済みの試合結果と computePlayerRatings() の出力だけから下書きを作る。
// 未取得の得点者、得点時刻、戦術、監督コメント、順位などは補完しない。
// 第3引数は既存の呼び出し契約を壊さないために受け取るが、外部サービスには使用しない。
export async function generateMatchReportDraft(matchInfo, ratingResult, _options = {}) {
  const homeTeam = requiredText(matchInfo?.homeTeam, 'ホームチーム');
  const awayTeam = requiredText(matchInfo?.awayTeam, 'アウェイチーム');
  const homeGoals = requiredGoal(matchInfo?.homeGoals, 'ホーム得点');
  const awayGoals = requiredGoal(matchInfo?.awayGoals, 'アウェイ得点');
  const competition = requiredText(matchInfo?.competition, '大会名');
  const date = requiredText(matchInfo?.date, '試合日時');
  const venue = optionalText(matchInfo?.venue);
  const ratings = validatedRatings(ratingResult, matchInfo, homeTeam, awayTeam);
  const searchSources = sourceReferences(matchInfo?.sourceReferences);
  const score = `${homeGoals}-${awayGoals}`;
  const penaltyResult = verifiedPenaltyResult(matchInfo, homeTeam, awayTeam);
  const resultLabel = penaltyResult ? `${score}（PK ${penaltyResult.home}-${penaltyResult.away}）` : score;
  const goalTimeline = goalTimelineMarkdown(verifiedGoalTimeline(matchInfo, homeGoals, awayGoals), {
    ...matchInfo, homeTeam, awayTeam,
  });
  const outcome = penaltyResult
    ? `延長戦までのスコアは${score}で、PK戦を${penaltyResult.home}-${penaltyResult.away}で制した${penaltyResult.winner}が勝者となった。`
    : homeGoals === awayGoals
    ? '両チームが同スコアで試合を終えた。'
    : `${homeGoals > awayGoals ? homeTeam : awayTeam}が最終スコアで上回った。`;
  const venueSentence = venue ? `会場は${venue}である。` : '会場情報は取得済みの提供データに含まれていない。';
  const resultSentence = penaltyResult
    ? `延長戦までのスコアは${homeTeam} ${score} ${awayTeam}で、PK戦は${penaltyResult.home}-${penaltyResult.away}となった。`
    : `最終スコアは${homeTeam} ${score} ${awayTeam}である。`;
  const homeTop = ratings.filter((entry) => entry.team === homeTeam)[0];
  const awayTop = ratings.filter((entry) => entry.team === awayTeam)[0];

  const draft = `# ${homeTeam} ${resultLabel} ${awayTeam}｜${competition}の記録

## 試合概要

${competition}で行われた${homeTeam}対${awayTeam}は、${resultLabel}で終了した。試合日時は${date}。${venueSentence}${outcome}本稿は、確定した試合結果とAPI-Footballの選手別試合スタッツ、そこから算出したAM4機械採点のみを基に構成している。

## 結果から読む試合

${resultSentence}スコア以外の得点時刻、得点者、交代、フォーメーション、戦術的意図については、この下書きの検証済み入力には含まれていないため記載しない。確定情報の範囲を保つため、試合の流れやプレー内容を推測で補うことも行わない。

両チームの出場選手は、同じ計算基準で採点されている。${homeTeam}では${homeTop.name}が${homeTop.rating.toFixed(1)}、${awayTeam}では${awayTop.name}が${awayTop.rating.toFixed(1)}を記録した。これらは賞の選出ではなく、出場時間と取得済みの試合スタッツ・イベントに基づく評価点である。
${goalTimeline}

## 機械採点

### ${homeTeam}

| 選手 | 出場時間 | 採点 | 検証済みの加点・減点根拠 |
| --- | ---: | ---: | --- |
${ratingRows(ratings, homeTeam)}

### ${awayTeam}

| 選手 | 出場時間 | 採点 | 検証済みの加点・減点根拠 |
| --- | ---: | ---: | --- |
${ratingRows(ratings, awayTeam)}

## 総括

この記録で確認できる結果は${resultLabel}と、出場選手の機械採点である。採点表の補足は、取得済みスタッツまたは公式イベントに対応する計算上の根拠だけを示している。追加の公式記録が得られるまでは、監督の発言、戦術評価、個別プレーの因果関係を断定しない。`;

  return { draft, searchSources };
}

// 【2026-07-31】「下書きログに追記」方式(旧loadDraftLog/saveDraft、1ファイルに全記事を
// 追記していく方式)は、記事ごとの恒久的なレコード保存(lib/article-store.js)に置き換えた。
// 一覧・個別取得は article-store.js の listArticles()/getArticle() を使うこと。
