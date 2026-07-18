// api/ai-column.js
// Vercelのサーバーレス関数(Node.js)。
//
// 「AM4コラム」機能: RSSで取れる実際の報道記事とは別に、Anthropic API(Claude)を使って
// AM4独自の短いコラム記事(分析・移籍観測・展望)を生成して返す。
//
// 重要: これは実際の取材・報道ではなく、AIが生成した参考コンテンツ。
// フロント側(football-hub.html)でも「AI生成」バッジと免責文言を必ず表示し、
// 実ニュース(/api/news)とは別のセクションに分けて表示することで、
// ユーザーが実際の報道と混同しないようにしている。
//
// 生成内容の信頼性を守るため、プロンプト側で以下を明示的に禁止している:
//   - 実在の選手・監督の発言をカギカッコ付きの直接話法で捏造すること
//   - 具体的な数値(得点・移籍金額など)を断定的な事実として書くこと
//   - 移籍交渉が実際に進行中であるかのような断定表現
//
// 環境変数 ANTHROPIC_API_KEY が必要(Vercelのプロジェクト設定 > Environment Variables で追加)。
// https://console.anthropic.com/ で取得できる。
//
// コストを抑えるため、生成結果は6時間キャッシュする(s-maxage)。
// フロント側は「更新」ボタン押下時のみ ?refresh=1 を付けてキャッシュを無視した再生成をリクエストする。

const SYSTEM_PROMPT_JA = `あなたはサッカー情報サイト『AM4』のコラム担当AIです。
5大リーグ(プレミアリーグ・ラ・リーガ・セリエA・ブンデスリーガ・リーグ・アン)とFIFAワールドカップ2026を主なテーマに、短いコラム記事を3本、日本語で作成してください。

3本の内訳(この順番・カテゴリ名で):
1. category:"分析" — 今シーズンの5大リーグやW杯で話題になりやすいトピック(得点争い、注目の若手、戦術トレンドなど)についての一般的な分析コラム。
2. category:"移籍観測" — 一般的な移籍市場の動向・トレンドについての考察記事。
3. category:"展望" — 今後の試合や大会展開についての展望記事。

厳守事項(違反しないこと):
- 実在の選手・監督・関係者の発言を、カギカッコ付きの直接話法で捏造してはいけません。「〜と語った」「〜とコメントした」のような直接引用は一切使わないでください。
- 得点数・移籍金額・具体的な日付などの数値を、確定した事実であるかのように断定してはいけません。数値に触れる場合は「近年の傾向として」「一般的に」のような一般論の範囲にとどめてください。
- 特定の選手の移籍が「決定した」「合意した」など、進行中の事実であるかのような断定表現は避けてください。
- 実在しない架空の試合結果やスコアを事実として書かないでください。
- 各記事は200〜320文字程度の日本語で、コラム・読み物として自然な文体にしてください。

出力は必ず以下のJSON形式のみで返してください。説明文・前置き・マークダウンのコードブロック記法(\`\`\`)は一切付けないでください:
{"columns":[{"category":"分析","title":"...","body":"..."},{"category":"移籍観測","title":"...","body":"..."},{"category":"展望","title":"...","body":"..."}]}`;

const SYSTEM_PROMPT_EN = `You are the column-writing AI for the football site "AM4".
Write 3 short columns in English about the Top 5 European leagues (Premier League, La Liga, Serie A, Bundesliga, Ligue 1) and the FIFA World Cup 2026.

The 3 columns (in this order, with these category names):
1. category:"Analysis" — a general analysis column about a topic likely to be relevant this season (goal-scoring races, breakout young players, tactical trends, etc).
2. category:"Transfer Watch" — a general commentary piece about transfer market trends.
3. category:"Outlook" — a preview/outlook piece about upcoming matches or tournament developments.

Strict rules (must not violate):
- Never fabricate direct quotes attributed to real players, managers, or officials. Do not use direct quotation formatting for anything a real person "said".
- Do not state specific numbers (goals, transfer fees, exact dates) as confirmed facts. If numbers come up, keep them general ("in recent seasons", "typically").
- Avoid stating that a specific transfer has "been agreed" or "completed" as if it were a confirmed fact in progress.
- Do not invent fictional match results or scores presented as real.
- Each article should be about 120-180 words, written in a natural column/feature style.

Return ONLY the following JSON format. No preamble, no explanation, no markdown code fences:
{"columns":[{"category":"Analysis","title":"...","body":"..."},{"category":"Transfer Watch","title":"...","body":"..."},{"category":"Outlook","title":"...","body":"..."}]}`;

const USER_PROMPT = 'Please write the 3 columns now, dated as of the current 2026 football season / World Cup 2026 context.';

function getSystemPrompt(lang) {
  return lang === 'en' || lang === 'es' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_JA;
  // esにはまだ専用プロンプトを用意していないため、英語版で代用している
}

function extractJson(text) {
  // Claudeがまれに```json ... ``` で囲んでしまう場合に備えて剥がす
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません(Vercelの環境変数に追加してください)' });
  }

  const lang = String(req.query.lang || 'ja').toLowerCase();
  const forceRefresh = req.query.refresh === '1';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: getSystemPrompt(lang),
        messages: [{ role: 'user', content: USER_PROMPT }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: `Anthropic APIエラー: HTTP ${response.status}` });
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text || '';

    let parsed;
    try {
      parsed = extractJson(rawText);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr, rawText);
      return res.status(502).json({ error: 'AI応答のJSON解析に失敗しました' });
    }

    const columns = Array.isArray(parsed.columns) ? parsed.columns.slice(0, 3) : [];

    // 手動更新(refresh=1)以外は6時間キャッシュしてAPIコストを抑える。
    // 手動更新時も直後の連打で無駄なAPI呼び出しが起きないよう短時間だけキャッシュする。
    res.setHeader(
      'Cache-Control',
      forceRefresh ? 's-maxage=60, stale-while-revalidate' : 's-maxage=21600, stale-while-revalidate'
    );
    return res.status(200).json({ columns, generatedAt: new Date().toISOString(), lang });

  } catch (err) {
    console.error('ai-column error:', err);
    return res.status(500).json({ error: '生成に失敗しました', detail: err.message });
  }
}
