// lib/match-report-core.js
//
// api/generate-match-report-article.js から移設した共有ロジック(採点エンジン+記事生成)。
// Vercel Hobbyプランのサーバーレス関数数上限(1デプロイ12個まで)を超えないよう、
// api/配下ではなくlib/配下に置くことで関数としてカウントされないようにしている
// (Vercelはapi/直下のファイルのみを関数としてビルドする)。
//
// match-report-watch.js からのみimportされる。単体テスト用の手動生成(fixtureId指定)/
// 下書き一覧確認は match-report-watch.js 側に POST / ?list=1 経由で統合済み。
//
// 【採点ロジックについて(重要)】
// 「主観的なAI評価ではなく、スタッツから機械的に算出することでブレを防止する」という方針の
// ため、AIには完成した採点データをそのまま記事に落とし込ませるだけで、採点自体は
// computePlayerRatings() がAPI-Footballの生スタッツ+試合イベントから決定的に計算する。
// 配点は下のSCORING定数にすべて集約してあるので、後から調整する場合はここだけ変えればよい。
//
// 【キーパス→得点、決定的貢献の加点について】
// API-Footballの選手個別スタッツ(passes.key等)は「その試合で何本キーパスを出したか」の
// 集計値のみで、個々のキーパスがどのシュート/得点に繋がったかまでは分からない。一方、
// fixtures/eventsの各Goalイベントにはassist(誰のパスから生まれた得点か)が明記されている
// ため、「そのアシストが記録された得点」を根拠に「このパスが得点に繋がったため加点」と
// 判定している(=API-Footballが公式に紐付けている情報のみを使い、AIの推測や当てずっぽうの
// 紐付けはしていない)。
//
// 環境変数: API_FOOTBALL_KEY, ANTHROPIC_API_KEY が必要。

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ARTICLE_FORMAT_SPEC = `
# 試合解説記事フォーマット(AM4)

文体: である調(専門メディア風)
文字数目安: 1500〜2500字

構成:
1. 見出し(試合結果+スコア+フック)
2. リード文(3〜4行、試合の位置づけ・注目ポイント)
3. 試合概要(大会名/親善試合の別、日時、会場、スコア、両チームスタメン・フォーメーション)
4. 試合展開(前半・後半に分けて記述)
5. 采配・戦術ポイント(監督コメントは補足として引用。マルカ/AS等の記事はエピソード補足程度に留め、著作権的な独自性を保つこと)
6. 採点表(渡された採点データをそのまま使って出場選手を評価、MOM選出、ボーナス加点箇所には補足コメントを表示)
7. 総括・今後の見どころ

注意点:
- 事実と推測を混同しない。データの裏付けがない評価は「〜との見方もある」等の表現に留める
- 採点(6.の採点表)は渡された算出済みデータをそのまま使うこと。記事内で独自に採点し直したり、
  渡された数値を変更したりしないこと
- 監督コメント・試合エピソードはWeb検索で見つかった範囲に留め、直接話法の捏造はしないこと
`;

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

// web_search_tool_result ブロックから検索でヒットしたURLを抜き出す(生成ログでの参照元追跡用)。
function extractSearchSources(content) {
  const sources = [];
  for (const block of content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result?.url) sources.push({ title: result.title || null, url: result.url });
      }
    }
  }
  return sources;
}

async function callAnthropic({ maxTokens, tools, prompt, label }) {
  const tFetch = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      ...(tools ? { tools } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  console.error(`[timing] anthropic ${label} fetch(): ${Date.now() - tFetch}ms, status=${response.status}`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${label}): ${response.status} ${errText}`);
  }

  const data = await response.json();
  console.error(`[timing] anthropic ${label} usage: stop_reason=${data.stop_reason}, ${JSON.stringify(data.usage)}`);
  return data;
}

// 試合情報+機械採点データをもとに、AIへ記事下書きを生成させる。
//
// 【2段階構成にしている理由(重要)】
// 当初はWeb検索ツール込みの1回の呼び出しで記事全文まで書かせていたが、実データ検証で
// 以下の問題が判明した:
//   - Web検索(最大5往復)の結果(生ページ内容)がそのまま入力コンテキストに乗り、
//     入力トークンが20万を超えるケースがあった
//   - その結果、(a) 本文生成前にmax_tokensへ到達し記事が書かれないまま打ち切られる、
//     または (b) max_tokensを増やすと今度は生成時間がVercelの実行時間上限(300秒)を
//     超えてタイムアウトする、という板挟みになった
// そのため「Web検索で要点だけ収集する軽量な呼び出し(research)」と「収集済みのメモ+
// 採点データから記事本文を書く呼び出し(write、Web検索なし=ツール往復が無く高速)」に
// 分割した。research側の入力トークンを抑えることで、write側は生の検索結果を再処理せずに
// 済み、両呼び出しの合計時間・トークン量とも大幅に削減できる。
export async function generateMatchReportDraft(matchInfo, ratingResult) {
  const researchPrompt = `
以下のサッカーの試合について、Web検索を使い、統計データだけでは分からない補足情報
(監督のコメント、試合の背景・エピソード、選手交代の意図など)を日本語の箇条書きで
簡潔にまとめてください。深追いはせず、要点(5〜8項目、各項目1〜2行)のみでよいです。
各項目に出典URLを付記してください。

- 対戦カード: ${matchInfo.homeTeam} ${matchInfo.homeGoals}-${matchInfo.awayGoals} ${matchInfo.awayTeam}
- 大会: ${matchInfo.competition || '不明'}
- 日時: ${matchInfo.date}
`;
  const researchData = await callAnthropic({
    maxTokens: 3000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
    prompt: researchPrompt,
    label: 'research',
  });
  const researchNotes = (researchData.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
  const searchSources = extractSearchSources(researchData.content);

  const writePrompt = `
あなたはサッカーメディア「AM4」の記者です。以下の試合について、指定フォーマットに沿った
試合解説記事を日本語で書いてください。

## 記事フォーマット
${ARTICLE_FORMAT_SPEC}

## 試合情報
- 対戦カード: ${matchInfo.homeTeam} ${matchInfo.homeGoals}-${matchInfo.awayGoals} ${matchInfo.awayTeam}
- 大会: ${matchInfo.competition || '不明'}
- 日時: ${matchInfo.date}
- 会場: ${matchInfo.venue || '不明'}

## 採点データ(このまま採用すること、記事内で独自に評価し直さない)
${JSON.stringify(ratingResult, null, 2)}

## 補足取材メモ(Web検索により事前収集済み、出典付き。そのまま参考にしてよい)
${researchNotes || '(取得できた補足情報なし。統計データのみで記述すること)'}

## 指示
- 上記の補足取材メモの範囲を超える推測・捏造はしないこと。
- 采配・戦術ポイントのセクションでは、補足取材メモの内容をエピソード補足程度に留め、
  丸写しにならないよう独自の視点でまとめ直すこと。
- 情報が不足している項目は無理に埋めず、正直に書くこと。
- 選手名・監督名は必ず英語表記(アルファベット)で統一すること。カタカナ変換は
  しないこと(例: 「コビー・マイヌー」ではなく「Kobbie Mainoo」)。チーム名は
  日本語表記のままでよい。
- 文字数は1500〜2500字の範囲に必ず収めること(採点表の行データ・選手名の羅列は文字数
  カウントから除く、本文の地の文で厳守すること)。超過する場合は各セクションを簡潔にし、
  不足する場合は試合展開・戦術ポイントの記述を厚くして調整すること。
`;
  const writeData = await callAnthropic({
    maxTokens: 5000,
    tools: null, // ここではWeb検索を使わない(ツール往復を挟まず高速・確実に完走させるため)
    prompt: writePrompt,
    label: 'write',
  });
  const draft = (writeData.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');

  return { draft, searchSources };
}

// 【2026-07-31】「下書きログに追記」方式(旧loadDraftLog/saveDraft、1ファイルに全記事を
// 追記していく方式)は、記事ごとの恒久的なレコード保存(lib/article-store.js)に置き換えた。
// 一覧・個別取得は article-store.js の listArticles()/getArticle() を使うこと。
