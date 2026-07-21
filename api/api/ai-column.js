// api/ai-column.js
// Vercelのサーバーレス関数(Node.js)。
//
// 「AM4コラム」機能: RSSで取れる実際の報道記事とは別に、Anthropic API(Claude)を使って
// AM4独自の短いコラム記事を生成して返す。
//
// 【2026-07 改修】単なる一般論のコラムから、実データに基づく内容へ変更した。
// 具体的には、/api/news と同じRSS取得処理(news.js の fetchAllNewsItems())を呼び出し、
// 実際に配信されている見出し・要約・リンクをAIへのプロンプトに埋め込んだうえで、
//   1. category:"話題まとめ"   — 直近の複数の実記事を横断して要約する「今日の注目トピック」記事(1本)
//   2. category:"編集部コラム" — 実記事1本を選び、それに対するAM4独自の切り口・考察を加える「便乗」記事(最大2本)
// を生成させるようにした。各記事には根拠にした実記事への sources(タイトル+リンク)を
// 必ず添えさせることで、AIが「何も無いところから」書いていないことをユーザー側でも確認できるようにしている。
//
// これは実際の取材・報道ではなく、AIが実記事を読んだ上で書いた考察・まとめコンテンツ。
// フロント側(football-hub.html)でも「AI生成」バッジと免責文言を必ず表示し、
// 実ニュース(/api/news)とは別のセクションに分けて表示することで、
// ユーザーが実際の報道と混同しないようにしている。
//
// 生成内容の信頼性を守るため、プロンプト側で以下を明示的に禁止している:
//   - 実在の選手・監督の発言をカギカッコ付きの直接話法で捏造すること
//   - プロンプトに含まれていない具体的な数値・移籍の確定情報を書くこと
//   - 提供された実記事一覧に無い出来事をあたかも実際に起きたかのように書くこと
//   - sourcesに、実際に参照していない記事を挙げること
//
// 環境変数 ANTHROPIC_API_KEY が必要(Vercelのプロジェクト設定 > Environment Variables で追加)。
// https://console.anthropic.com/ で取得できる。
//
// コストを抑えるため、生成結果は6時間キャッシュする(s-maxage)。
// フロント側は「更新」ボタン押下時のみ ?refresh=1 を付けてキャッシュを無視した再生成をリクエストする。

import { fetchAllNewsItems } from './news.js';

function buildSourceList(items) {
  // プロンプトに埋め込む実記事一覧。1件あたりのトークン数を抑えるため、
  // 見出し・要約(短縮)・情報源・リンクのみに絞る。最大18件。
  return items.slice(0, 18).map((n, i) => ({
    id: i + 1,
    headline: n.headline,
    summary: n.summary,
    source: n.source,
    link: n.link
  }));
}

const SYSTEM_PROMPT_JA = `あなたはサッカー情報サイト『AM4』のコラム担当AIです。
以下に、実際に配信されている最新のサッカー関連ニュース記事一覧(id・見出し・要約・情報源・リンク)を渡します。
この一覧「だけ」を事実の根拠として、日本語のコラムを作成してください。一覧に無い情報を事実として書いてはいけません。

作成する記事(この順番・カテゴリ名で、合計2〜3本):
1. category:"話題まとめ" — 一覧の中から関連性がある/話題性が高いと思われる記事を3〜5本選び、横断的に要約・整理した「今日の注目トピック」記事を1本。単なる翻訳や丸写しではなく、AM4としての視点でまとめ直すこと。
2. category:"編集部コラム" — 一覧の中から特に読者の関心を引きそうな記事を1本選び、その内容を踏まえたAM4独自の短い考察・便乗コラムを書く。例:移籍report記事があれば、その移籍が実現した場合のチームへの影響についての考察、など。これを1〜2本作成する。

各記事には、根拠にした記事のidを "sourceIds" 配列(例: [1,3,4])として必ず含めること。実際に参照していないidを含めてはいけない。

厳守事項(違反しないこと):
- 提供された記事一覧に書かれていない事実(移籍の確定、スコア、具体的な数値、日付など)を新たに作り出してはいけません。
- 実在の選手・監督・関係者の発言を、カギカッコ付きの直接話法で捏造してはいけません。記事一覧内の要約に基づいて間接的に言及するのは可(例:「〜と報じられている」)。
- 記事一覧が空、または話題として使えるものが無い場合は、無理に記事を作らず、その旨がわかる短い1本の記事(category:"話題まとめ"、内容は「現在参照できる話題が少ない」旨)のみを返してください。
- 各記事は200〜320文字程度の日本語で、コラム・読み物として自然な文体にしてください。
- 見出し(title)は元記事の見出しをそのまま使わず、AM4独自の見出しを付けること。

出力は必ず以下のJSON形式のみで返してください。説明文・前置き・マークダウンのコードブロック記法(\`\`\`)は一切付けないでください:
{"columns":[{"category":"話題まとめ","title":"...","body":"...","sourceIds":[1,2,3]},{"category":"編集部コラム","title":"...","body":"...","sourceIds":[4]}]}`;

const SYSTEM_PROMPT_EN = `You are the column-writing AI for the football site "AM4".
Below is a list of actual, currently published football news articles (id, headline, summary, source, link).
Use ONLY this list as your factual basis for the English-language columns you write. Do not state anything as fact that isn't in this list.

Articles to write (in this order, with these category names, 2-3 total):
1. category:"Topic Roundup" — Pick 3-5 related/notable articles from the list and write one synthesized "today's key topics" piece that connects them. Write in your own words and with AM4's own framing, not a translation or copy of the originals.
2. category:"Editor's Take" — Pick one article likely to interest readers and write a short original commentary/reaction piece building on it (e.g., if there's a transfer report, discuss what that move could mean for the club). Write 1-2 of these.

Each article must include a "sourceIds" array (e.g. [1,3,4]) listing the ids of the articles it actually drew from. Never include an id you didn't actually use.

Strict rules (must not violate):
- Never invent facts (confirmed transfers, scores, specific numbers, dates) that are not present in the provided article list.
- Never fabricate direct quotes attributed to real players, managers, or officials. Indirect reference based on the provided summaries is fine (e.g., "reportedly...").
- If the article list is empty or has nothing usable, do not force content — return a single short "Topic Roundup" article noting that few topics are currently available.
- Each article should be about 120-180 words, written in a natural column/feature style.
- Write your own headline (title); do not just reuse a source article's headline verbatim.

Return ONLY the following JSON format. No preamble, no explanation, no markdown code fences:
{"columns":[{"category":"Topic Roundup","title":"...","body":"...","sourceIds":[1,2,3]},{"category":"Editor's Take","title":"...","body":"...","sourceIds":[4]}]}`;

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
    // 実際に配信されているニュース記事を取得し、AIへのプロンプトに埋め込む。
    // ここで取得に失敗しても(failedFeeds)、成功した分だけで続行する。
    const { items: newsItems } = await fetchAllNewsItems();
    const sourceList = buildSourceList(newsItems);

    const userPrompt =
      `ここに現在配信中のニュース記事一覧をJSONで渡します。この内容だけを根拠にコラムを作成してください。\n\n` +
      JSON.stringify(sourceList, null, 2);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: getSystemPrompt(lang),
        messages: [{ role: 'user', content: userPrompt }]
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

    const rawColumns = Array.isArray(parsed.columns) ? parsed.columns.slice(0, 3) : [];

    // sourceIds(1始まりのid配列)を、実際のsourceList上の記事(title+link)に変換して
    // フロント側で「元記事」リンクとして表示できるようにする。
    // AIが範囲外・不正なidを返した場合は無視する(存在しないidは捏造の可能性があるため)。
    const columns = rawColumns.map(col => {
      const ids = Array.isArray(col.sourceIds) ? col.sourceIds : [];
      const sources = ids
        .map(id => sourceList.find(s => s.id === id))
        .filter(Boolean)
        .map(s => ({ title: s.headline, link: s.link, source: s.source }));
      return {
        category: col.category,
        title: col.title,
        body: col.body,
        sources
      };
    });

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
