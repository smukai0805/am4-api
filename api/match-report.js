// api/match-report.js
// Vercelのサーバーレス関数(Node.js)。
//
// 「試合レポート」機能: ニュースタブの新セクション。試合結果をもとに、AM4編集部として
// 前半/後半・延長/記録、のような構成で読み応えのある独自解説記事を書く。
//
// 【データの根拠について】専用の試合結果API(得点者・時系列イベント等)は用意していない。
// 代わりに、既存のニュース取得処理(news.js の fetchAllNewsItems())が返す記事の中から、
// ゲキサカが試合直後によく出す「◯◯vs△△ 試合記録」のような見出しパターンを検出して
// 対戦カードを自動抽出し、同じ2チーム名が本文に登場する関連記事(記録・MVP・写真特集など)
// を束ねて1つの素材セットにする。この素材セット「だけ」を事実の根拠としてAIに記事を書かせる。
//
// 重要: この試合(2026年W杯)はAIの学習データより後の出来事なので、AIはこの試合の結果を
// 元から知らない。ゲキサカの実記事を読ませない限り何も書けない、というのがそのまま
// 捏造防止の安全装置になっている。
//
// 【動画埋め込みについて】YouTube Data API v3を使い、対戦カード名+大会名で検索して
// ハイライト動画のvideoIdを1件取得する(環境変数 YOUTUBE_API_KEY が必要)。
// キー未設定の場合はvideoId:nullを返し、フロント側は動画欄を「準備中」表示にする
// (この機能自体は無くても記事生成は問題なく動く)。
// 【2026-07 修正】検索クエリにteam1/team2(ゲキサカ見出しから抽出した表記。日本語の
// 場合がある)をそのまま使うと、YouTube側で実際の動画titleとマッチせず、無関係な
// 人気動画(例: 別の試合のハイライト)がヒットすることがあった。そのため、AIに
// homeTeamEn/awayTeamEn(英語表記)を出力させて検索クエリに使い、さらに検索結果の
// titleに両チーム名が含まれているかを照合してから採用するようにした。
// X(Twitter)の投稿埋め込みは、特定の試合のゴールシーン投稿を自動検索する手段が
// 現実的でない(検索APIが有料プラン前提)ため自動化していない。手動でURLを追加できる
// 余地だけ残してある(未実装、将来的な拡張ポイント)。

import { fetchAllNewsItems } from './news.js';

export const config = {
  maxDuration: 60,
};

const LEAGUES_JA = ['プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン', 'ワールドカップ', 'その他'];
const LEAGUES_EN = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'World Cup', 'Other'];

// ゲキサカの見出しは「スペインvsアルゼンチン 試合記録」のように、見出し先頭が
// 「チーム名vsチーム名」になっていることが多い。このパターンから対戦カードを検出する。
function detectMatchups(items) {
  const seen = new Map();
  for (const item of items) {
    const headline = item.headline || '';
    const m = headline.match(/^(\S+?)vs(\S+)/);
    if (!m) continue;
    const team1 = m[1].trim();
    const team2 = m[2].trim();
    if (!team1 || !team2 || team1 === team2) continue;
    const key = [team1, team2].sort().join('|');
    if (!seen.has(key)) seen.set(key, { team1, team2 });
  }
  return [...seen.values()];
}

// 対戦カードの2チーム名が、見出しまたは本文(fullText)に両方登場する記事だけを集める。
// 時系列順(古い→新しい)に並べる: 前半→後半→延長→表彰、という試合の流れをAIが
// 掴みやすくするため。
function buildMatchSourceList(items, team1, team2) {
  const related = items.filter(n => {
    const text = `${n.headline} ${n.fullText || n.summary || ''}`;
    return text.includes(team1) && text.includes(team2);
  });
  const sorted = [...related].sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  // image はAIへのプロンプトには含めず(呼び出し側でstripする)、レポートのサムネイル
  // 選定用に内部データとしてだけ保持する。
  return sorted.slice(0, 15).map((n, i) => ({
    id: i + 1,
    headline: n.headline,
    detail: n.fullText || n.summary,
    source: n.source,
    link: n.link,
    image: n.image || null
  }));
}

function getSystemPrompt(lang) {
  const leagues = lang === 'en' || lang === 'es' ? LEAGUES_EN : LEAGUES_JA;
  if (lang === 'en' || lang === 'es') {
    return `You are the editorial AI for the football site "AM4", writing a match report.
You will be given a list of real, actually-published articles (id, headline, detail, source, link) about ONE specific match. This list is your ONLY source of facts — you have no prior knowledge of this match's result, so anything not in this list must not be stated as fact.

Write ONE match report with this exact structure (as a "sections" array, in this order):
1. label:"First Half" — what happened in the first half, based only on the provided material.
2. label:"Second Half & Extra Time" — what happened afterward (second half, extra time/penalties if mentioned).
3. label:"Records & Talking Points" — notable stats, records, or standout performances mentioned in the material.
If the material doesn't clearly cover one of these phases (e.g. no extra time happened), write a short honest sentence saying so rather than inventing detail.

Also include:
- "competition": the competition/round name if determinable from the material (e.g. "FIFA World Cup 2026 Final"), else null.
- "leagues": an array of 1-2 entries from ${leagues.join(' / ')} — usually just one (both teams are in the same competition), but if the two teams belong to different leagues, list both. "Other" if unclear.
- "score": the final score as a short string (e.g. "1-0") ONLY if explicitly stated in the material, else null. Never guess or calculate it yourself.
- "title": your own original headline for the report (not copied verbatim from a source). Put extra effort into this: rather than a plain score report (e.g. "Team A beat Team B"), lead with the single most notable thing about this match if the material supports it — an individual award, a dramatic late winner, a record, a red card or controversial VAR call. Prefer a specific, click-worthy sentence over a generic summary.
- "homeTeamEn" / "awayTeamEn": the two teams' official English names (e.g. "Argentina", "Cape Verde"), even if the source material refers to them in another language. These are used to search for a highlight video, so they must be accurate English names, not transliterations.
- "sourceIds": array of ids actually used.

Strict rules:
- Never state a fact (score, goal-scorer, minute, card, attendance, record) that isn't present in the provided material.
- Never fabricate direct quotes attributed to real players/managers. Indirect reference is fine ("according to reports...").
- Each section body should be 80-150 words, written in a natural sports-journalism style.

Return ONLY this JSON format, no preamble, no markdown fences:
{"competition":"...","leagues":["World Cup"],"score":"1-0","title":"...","homeTeamEn":"Argentina","awayTeamEn":"Cape Verde","sections":[{"label":"First Half","body":"..."},{"label":"Second Half & Extra Time","body":"..."},{"label":"Records & Talking Points","body":"..."}],"sourceIds":[1,2,3]}`;
  }
  return `あなたはサッカー情報サイト『AM4』編集部として試合レポートを書くAIです。
これから、ある1試合についての実際に配信された記事一覧(id・見出し・本文・情報源・リンク)を渡します。この一覧が唯一の事実の根拠です。この試合の結果についてあなたは元々何も知らないので、一覧に無いことを事実として書いてはいけません。

以下の構成で、1本の試合レポートを "sections" 配列として書いてください(この順番):
1. label:"前半" — 前半の展開。提供された素材に基づく内容のみ。
2. label:"後半〜延長戦" — 後半以降の展開(延長・PK戦があれば触れる)。
3. label:"記録・注目ポイント" — 素材に出てくる記録・注目スタッツ・目立った選手など。
素材にその局面の情報が無い場合(延長が無かった等)は、無理に作らず「素材からは確認できない」旨を短く書いてください。

以下も含めてください:
- "competition": 大会名・ラウンドが分かれば(例:「FIFAワールドカップ2026 決勝」)、不明ならnull。
- "leagues": 次の中から1〜2個を配列で: ${leagues.join(' / ')}。通常は1つ(両チームが同じ大会に所属)で良いが、2チームが異なるリーグに所属する場合は両方挙げること。判断が難しい場合は["その他"]。
- "score": 素材に明記されている場合のみ、最終スコアを短い文字列で(例:"1-0")。書かれていなければ必ずnull(自分で推測・計算しない)。
- "title": AM4独自の見出し(元記事の見出しの丸写しは禁止)。titleは特に力を入れて作成してください。単なるスコアの報告(「〇〇が△△を下す」等)ではなく、この試合で最も特筆すべき出来事(例: 個人賞受賞、劇的な決勝点、記録達成、退場・物議を醸したVAR判定など)があれば、それを見出しの主軸に据えてください。抽象的な要約より、具体的で読みたくなる一文を優先してください。
- "homeTeamEn" / "awayTeamEn": 両チームの公式英語表記(例: "Argentina"、"Cape Verde")。素材が日本語など英語以外の言語でチーム名を表記している場合も、正確な英語表記に変換すること。ハイライト動画検索に使うため、音訳ではなく実際に使われる英語名にすること。
- "sourceIds": 実際に使った記事idの配列。

厳守事項:
- 素材に無い事実(スコア・得点者・時間・カード・観客数・記録など)を書いてはいけません。
- 実在の選手・監督の発言をカギカッコ付き直接話法で捏造してはいけません。間接的な言及は可(「〜と報じられている」等)。
- 各セクションは日本語80〜150文字程度、スポーツ記事らしい自然な文体で(単なる箇条書きにしない)。

出力は必ず以下のJSON形式のみで返してください。説明文・前置き・マークダウンのコードブロック記法は一切付けないでください:
{"competition":"...","leagues":["ワールドカップ"],"score":"1-0","title":"...","homeTeamEn":"Argentina","awayTeamEn":"Cape Verde","sections":[{"label":"前半","body":"..."},{"label":"後半〜延長戦","body":"..."},{"label":"記録・注目ポイント","body":"..."}],"sourceIds":[1,2,3]}`;
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}

// 動画titleに両チーム名(の一部)が含まれているか確認する。team名は英語表記の先頭の
// 単語(例: "Cape Verde" → "cape")だけで判定し、表記ゆれ("Cabo Verde"等)にはある程度
// 寛容にする。どちらか一方でも含まれていなければ無関係な動画とみなす。
function titleMatchesTeams(title, team1, team2) {
  if (!title || !team1 || !team2) return false;
  const t = title.toLowerCase();
  const key1 = team1.split(/\s+/)[0].toLowerCase();
  const key2 = team2.split(/\s+/)[0].toLowerCase();
  if (!key1 || !key2) return false;
  return t.includes(key1) && t.includes(key2);
}

async function searchYoutubeHighlight(team1, team2, competition) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null; // キー未設定時は静かにnullを返す(記事生成自体は継続させる)
  try {
    // team1/team2は英語表記(homeTeamEn/awayTeamEn)であることが前提。大会名が
    // 取れなかった場合も、この機能が主にW杯の試合レポート向けであることを踏まえ
    // 「FIFA World Cup 2026」を補って検索クエリを具体的にする。
    const competitionHint = competition || 'FIFA World Cup 2026';
    const q = encodeURIComponent(`${team1} vs ${team2} highlights ${competitionHint}`.trim());
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&order=relevance&type=video&q=${q}&key=${key}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const item = data?.items?.[0];
    if (!item) return null;
    // 検索結果のtitleに両チーム名が含まれていない場合、無関係な人気動画がヒットした
    // 可能性が高いので採用しない(写真フォールバックに委ねた方が安全なため)。
    if (!titleMatchesTeams(item?.snippet?.title, team1, team2)) return null;
    return item?.id?.videoId || null;
  } catch (err) {
    console.error('youtube search error:', err);
    return null;
  }
}

async function callAnthropic(apiKey, lang, sourceList) {
  // imageはAIには不要な情報(トークンの無駄)なので、プロンプトに渡す分だけ除いておく。
  const promptSourceList = sourceList.map(({ image, ...rest }) => rest);
  const userPrompt =
    `ここに、ある1試合についての実際の記事一覧をJSONで渡します。この内容だけを根拠にレポートを作成してください。\n\n` +
    JSON.stringify(promptSourceList, null, 2);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: getSystemPrompt(lang),
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Anthropic API error:', response.status, errText);
    return null;
  }

  const data = await response.json();
  const rawText = data?.content?.[0]?.text || '';
  try {
    return extractJson(rawText);
  } catch (parseErr) {
    console.error('JSON parse error:', parseErr, rawText);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません(Vercelの環境変数に追加してください)' });
  }

  const lang = String(req.query.lang || 'ja').toLowerCase();
  const forceRefresh = req.query.refresh === '1';
  const validLeagues = lang === 'en' || lang === 'es' ? LEAGUES_EN : LEAGUES_JA;

  try {
    const { items: newsItems } = await fetchAllNewsItems();
    const matchups = detectMatchups(newsItems).slice(0, 3); // コスト対策として直近検出3試合まで

    const reports = [];
    for (const { team1, team2 } of matchups) {
      const sourceList = buildMatchSourceList(newsItems, team1, team2);
      if (sourceList.length < 2) continue; // 素材が薄すぎる場合は無理にレポート化しない

      const parsed = await callAnthropic(API_KEY, lang, sourceList);
      if (!parsed || !Array.isArray(parsed.sections)) continue;

      const ids = Array.isArray(parsed.sourceIds) ? parsed.sourceIds : [];
      const citedSources = ids.map(id => sourceList.find(s => s.id === id)).filter(Boolean);
      const sources = citedSources.map(s => ({ title: s.headline, link: s.link, source: s.source }));
      // 動画が見つからない場合のフォールバック用に、根拠記事の画像も1枚選んでおく。
      const image = citedSources.map(s => s.image).find(Boolean) || null;

      // leaguesは配列(1〜2個)。旧バージョン互換のため単一文字列で返ってきた場合も配列化する。
      const rawLeagues = Array.isArray(parsed.leagues) ? parsed.leagues : (parsed.league ? [parsed.league] : []);
      let leagues = rawLeagues.filter(l => validLeagues.includes(l)).slice(0, 2);
      if (leagues.length === 0) leagues = [validLeagues[validLeagues.length - 1]];
      // team1/team2はRSS見出しから抽出した表記(日本語の場合がある)なので、YouTube検索には
      // AIが出力した英語表記(homeTeamEn/awayTeamEn)を使う。AIが省略した場合のみ元の表記で妥協する。
      const team1En = parsed.homeTeamEn || team1;
      const team2En = parsed.awayTeamEn || team2;
      const videoId = await searchYoutubeHighlight(team1En, team2En, parsed.competition);

      reports.push({
        homeTeam: team1,
        awayTeam: team2,
        competition: parsed.competition || null,
        leagues,
        score: parsed.score || null,
        title: parsed.title,
        sections: parsed.sections,
        sources,
        image,
        videoId
      });
    }

    res.setHeader(
      'Cache-Control',
      forceRefresh ? 's-maxage=60, stale-while-revalidate' : 's-maxage=21600, stale-while-revalidate'
    );
    return res.status(200).json({ reports, generatedAt: new Date().toISOString(), lang });

  } catch (err) {
    console.error('match-report error:', err);
    return res.status(500).json({ error: '生成に失敗しました', detail: err.message });
  }
}
