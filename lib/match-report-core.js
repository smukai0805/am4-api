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

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;

async function apiFootballFetch(path, params) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API-Football error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const errors = data.errors && Object.keys(data.errors).length > 0 ? data.errors : null;
  if (errors) console.error(`API-Football errors (${path}):`, errors);
  return data;
}

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

    const ownGoal = /own goal/iu.test(String(g.detail || ''));
    contexts.push({
      // For an own goal the event player is the defender who put the ball
      // into their own net. Never reward that player as a scorer or assister.
      playerId: ownGoal ? null : (g.player?.id || null),
      assistPlayerId: ownGoal ? null : (g.assist?.id || null),
      context,
      minute: g.time?.elapsed,
      ownGoal,
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
    const ownGoal = /own goal/iu.test(String(event?.detail || ''));
    return [{ index, teamId, minute, player, ownGoal }];
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

function timelineMinute(entry) {
  const minute = Number(String(entry?.minute || '').split('+')[0]);
  return Number.isFinite(minute) ? minute : null;
}

function goalTimelineLabel(entry, matchInfo) {
  const homeTeamId = integerId(matchInfo?.homeTeamId);
  const team = entry.teamId === homeTeamId ? matchInfo.homeTeam : matchInfo.awayTeam;
  if (entry.ownGoal) {
    return entry.player
      ? `${entry.minute}分：${team} — オウンゴール（${entry.player}）`
      : `${entry.minute}分：${team} — オウンゴール`;
  }
  return `${entry.minute}分：${team}${entry.player ? ` — ${entry.player}` : ''}`;
}

function goalTimelineMarkdown(timeline, matchInfo) {
  if (!timeline.length) return '';
  return `\n\n## 得点経過\n\n${timeline.map((entry) => `- ${goalTimelineLabel(entry, matchInfo)}`).join('\n')}`;
}

function halfReview(timeline, matchInfo, half) {
  const entries = timeline.filter((entry) => {
    const minute = timelineMinute(entry);
    return minute != null && (half === 'first' ? minute <= 45 : minute > 45);
  });
  if (!entries.length) {
    return half === 'first'
      ? '前半は得点が動かず、0-0で折り返した。'
      : '後半は追加の得点が生まれず、そのまま試合終了を迎えた。';
  }
  const sequence = entries.map((entry) => goalTimelineLabel(entry, matchInfo).replace('：', '、')).join('。');
  return `${sequence}。得点の動いた時間帯を軸に、試合のスコアが推移した。`;
}

function decisiveGoal(timeline, matchInfo, homeGoals, awayGoals) {
  if (homeGoals === awayGoals) return null;
  const winnerId = homeGoals > awayGoals ? integerId(matchInfo?.homeTeamId) : integerId(matchInfo?.awayTeamId);
  const loserGoals = homeGoals > awayGoals ? awayGoals : homeGoals;
  let winnerGoals = 0;
  for (const entry of timeline) {
    if (entry.teamId !== winnerId) continue;
    winnerGoals += 1;
    if (winnerGoals === loserGoals + 1) return entry;
  }
  return null;
}

function resultMeaning(homeTeam, awayTeam, homeGoals, awayGoals, penaltyResult) {
  if (penaltyResult) return `${penaltyResult.winner}がPK戦を制し、この試合の勝者となった。`;
  if (homeGoals === awayGoals) return `${homeTeam}と${awayTeam}は勝点1ずつを分け合った。`;
  const winner = homeGoals > awayGoals ? homeTeam : awayTeam;
  return `${winner}が勝点3を獲得した。`;
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
  validatedRatings(ratingResult, matchInfo, homeTeam, awayTeam);
  const searchSources = sourceReferences(matchInfo?.sourceReferences);
  const score = `${homeGoals}-${awayGoals}`;
  const penaltyResult = verifiedPenaltyResult(matchInfo, homeTeam, awayTeam);
  const resultLabel = penaltyResult ? `${score}（PK ${penaltyResult.home}-${penaltyResult.away}）` : score;
  const timeline = verifiedGoalTimeline(matchInfo, homeGoals, awayGoals);
  if (homeGoals + awayGoals > 0 && !timeline.length) {
    throw insufficientReportInput('得点イベントが最終スコアと整合しないため、読者向け試合解説を生成できません');
  }
  const timelineMarkdown = goalTimelineMarkdown(timeline, { ...matchInfo, homeTeam, awayTeam });
  const venueSentence = venue ? `会場は${venue}。` : '';
  const firstHalf = halfReview(timeline, { ...matchInfo, homeTeam, awayTeam }, 'first');
  const secondHalf = halfReview(timeline, { ...matchInfo, homeTeam, awayTeam }, 'second');
  const decisive = decisiveGoal(timeline, matchInfo, homeGoals, awayGoals);
  const meaning = resultMeaning(homeTeam, awayTeam, homeGoals, awayGoals, penaltyResult);
  const sequenceSummary = timeline.length
    ? timeline.map((entry) => goalTimelineLabel(entry, { ...matchInfo, homeTeam, awayTeam })).join('、')
    : '90分を通して得点は生まれなかった';
  const pointOne = decisive
    ? `1. **決勝点**  ${goalTimelineLabel(decisive, { ...matchInfo, homeTeam, awayTeam })}。この得点が最終的な勝敗を分けた。`
    : `1. **最後まで決着しないスコア**  ${homeTeam}と${awayTeam}は同点のまま試合を終えた。`;
  const pointTwo = `2. **得点の時間帯**  ${sequenceSummary}。スコアが動いた局面を追うことで、試合の流れを確認できる。`;

  const draft = `# ${homeTeam} ${resultLabel} ${awayTeam}｜試合解説

## 3行要約
${competition}の${homeTeam}対${awayTeam}は${resultLabel}で終了した。
${timeline.length ? `得点経過は、${sequenceSummary}。` : '90分を通して得点は生まれなかった。'}
${meaning}

## 試合概要
試合日時は${date}。${venueSentence}${homeGoals === awayGoals && !penaltyResult ? '両チームは同点で試合を終えた。' : `${penaltyResult ? penaltyResult.winner : (homeGoals > awayGoals ? homeTeam : awayTeam)}が最終的に勝者となった。`}

## 前半レビュー
${firstHalf}

## 後半レビュー
${secondHalf}${timelineMarkdown}

## 試合を分けたポイント
${pointOne}
${pointTwo}

## 結果の意味
${meaning}`;

  return { draft, searchSources };
}

// 【2026-07-31】「下書きログに追記」方式(旧loadDraftLog/saveDraft、1ファイルに全記事を
// 追記していく方式)は、記事ごとの恒久的なレコード保存(lib/article-store.js)に置き換えた。
// 一覧・個別取得は article-store.js の listArticles()/getArticle() を使うこと。
