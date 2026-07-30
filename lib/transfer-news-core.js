// lib/transfer-news-core.js
//
// ファブリツィオ・ロマーノ(Fabrizio Romano)が発信する移籍情報を、Anthropic APIの
// Web検索ツールで定期的にチェックし、短い速報テキストとして生成する機能の中核ロジック。
//
// 【Xの投稿を直接取得しない理由】X(Twitter)API(有料)への登録が未着手のため、
// 代わりにWeb検索で「ロマーノが報じた最新の移籍情報」を調べる方式にしている。
// Web検索経由のため、実際のXの投稿と比べて反映にタイムラグが出ることは許容している。
//
// 【1回のAI呼び出しで全クラブをまとめてチェックする理由】
// PILOT_CLUBS(15クラブ)を1クラブずつ個別に問い合わせると、Web検索を伴うAI呼び出しが
// 15回発生しコストが嵩む。1回の呼び出しで「対象クラブ一覧」を渡し、見つかった移籍情報を
// まとめて配列で返させることで、コストを抑えつつ運用する。
//
// 【出力形式について】記事本文のような長文フォーマットではなく、見出し(40字程度)+
// 要約(100〜150字程度)+出典URLのみの短い速報用に、構造化JSON配列で出力させる。

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropic({ maxTokens, tools, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
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
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errText}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Anthropic API timeout: ${timeoutMs}ms を超過`);
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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

// クラブ名一覧を渡し、Fabrizio Romanoの直近の移籍報道を横断的に検索させる。
// 返り値: [{ player, fromClub, toClub, status, headline, summary, sourceUrl }]
export async function checkTransferNews(clubNames) {
  const prompt = `
あなたはサッカー移籍情報専門のリサーチャーです。Web検索を使い、移籍情報で最も信頼される
記者の一人であるFabrizio Romano(ファブリツィオ・ロマーノ)が直近数日以内に報じた、
以下のクラブに関係する移籍情報を調べてください。

対象クラブ: ${clubNames.join(', ')}

## 指示
- 検索クエリの例: "Fabrizio Romano [クラブ名] transfer latest"
- Fabrizio Romano本人の発信(Twitter/X投稿、彼のコラム記事、彼の発言を引用した記事)を
  根拠とする情報のみを対象にすること。他の記者・メディア独自の憶測記事は対象外とする
- 見つかった移籍情報ごとに、以下のJSON配列の要素として出力すること(最大8件まで)
- 選手名・クラブ名は英語表記で統一すること(カタカナ変換はしないこと)
- headlineは40字程度の短い見出し、summaryは100〜150字程度の要約(2〜3文)にすること
- 情報源のURLが特定できない場合は、その項目自体を含めないこと(出典不明のまま速報化しない)
- 該当する移籍情報が無い場合は空配列 [] を返すこと

## 出力形式(このJSON配列のみを出力し、前後に説明文を一切つけないこと)
[
  {
    "player": "選手名(英語表記)",
    "fromClub": "現所属クラブ(英語表記)",
    "toClub": "移籍先クラブ(英語表記)",
    "status": "状況を表す短い一言(例: here we go / 合意間近 / 中断中 など)",
    "headline": "40字程度の見出し",
    "summary": "100〜150字程度の要約",
    "sourceUrl": "根拠となった情報源のURL"
  }
]
`;

  const data = await callAnthropic({
    maxTokens: 4000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    prompt,
    timeoutMs: 200000, // 200秒。maxDuration(300秒)内で1回の呼び出しのみのため余裕を持たせる
  });

  const text = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
  const searchSources = extractSearchSources(data.content);

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('transfer news: AI応答からJSON配列を抽出できませんでした:', text.slice(0, 300));
    return { items: [], searchSources };
  }

  let items;
  try {
    items = JSON.parse(match[0]);
  } catch (err) {
    console.error('transfer news: JSON解析に失敗しました:', err.message, text.slice(0, 300));
    return { items: [], searchSources };
  }
  if (!Array.isArray(items)) return { items: [], searchSources };

  // sourceUrlが無い項目(出典不明)は速報化しない。
  items = items.filter(item => item && item.player && item.toClub && item.sourceUrl);

  return { items, searchSources };
}

// 同じ移籍情報(選手+移籍先)を重複して速報化しないための正規化キー。
export function transferDedupeKey(item) {
  return `${String(item.player || '').trim().toLowerCase()}|${String(item.toClub || '').trim().toLowerCase()}`;
}
