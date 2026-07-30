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
// 要約(100〜150字程度)+出典(URLがあれば)のみの短い速報用に、構造化JSON配列で出力させる。
//
// 【検知条件の設計方針(重要・2026-07-31修正)】
// 当初は「出典URLが明確な場合のみ速報化する」という厳格な条件にしていたが、実データ検証で
// 検知件数が2回とも0件になった。ロマーノの投稿はX上のテキストが情報源そのものであることが
// 多く、必ずしも別記事への外部リンクを伴わないため、「出典URLが明確」という条件が
// 厳しすぎたと判断し、出典URLの必須要件は撤廃した(無ければ「情報源: Fabrizio Romano」の
// 表記のみで速報化してよい)。
//
// 一方で、優先すべきは「精度(どれだけ多く拾えるか)」ではなく「本人確認の正確さ」である。
// ロマーノの偽アカウント・なりすましからの発信を誤って本人発信として拾わないよう、
// 本人発信とみなす条件(複数の信頼できるニュースサイトが明記して報道している/検索結果内で
// 広く引用・言及されている)をプロンプト側で明示している。多少の検知漏れ(見逃し)は
// 許容し、誤検知(なりすまし等を本人発信として拾ってしまうこと)は避ける、という優先順位。

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

## 最優先事項: 「本人確認の正確さ」を、拾える件数の多さより優先すること
- ここで最も重要なのは、偽アカウント・なりすまし・伝聞の伝聞ではなく、本当にFabrizio
  Romano本人の発信を根拠にしているかどうかの見極めである。件数を多く拾うことより、
  拾った1件1件が本当に本人発信であることの方がずっと重要
- 以下のいずれかを満たす場合のみ「本人発信」とみなしてよい:
  (a) 複数の信頼できるスポーツニュースサイトが「Fabrizio Romanoが報じた/確認した」と
      明記して報道している
  (b) 検索結果内で、その情報がロマーノの発信内容として広く引用・言及されている
  上記いずれも満たさない(単一の弱い情報源のみ、真偽不明な引用、なりすましの疑いがある等)
  場合は、多少の見逃しになってもよいので対象から外すこと。迷った場合は「拾わない」を選ぶこと

## 出典について(2026-07-31緩和)
- ロマーノの投稿はX上のテキスト自体が情報源であり、必ずしも別記事への外部リンクを
  伴わないため、出典URLの有無は速報化の必須条件ではない
- 検索結果の中に、ロマーノの発信を報じている/引用しているページ(ニュースサイトの記事、
  彼のX投稿を引用しているページなど)のURLがあればsourceUrlとして使うこと
- 該当するURLが見当たらない場合はsourceUrlをnullにしてよい(その場合でも上記の
  「本人確認の正確さ」の基準さえ満たしていれば速報化してよい)

## その他の指示
- 検索クエリの例: "Fabrizio Romano [クラブ名] transfer latest"
- 見つかった移籍情報ごとに、以下のJSON配列の要素として出力すること(最大8件まで)
- 選手名・クラブ名は英語表記で統一すること(カタカナ変換はしないこと)
- headlineは40字程度の短い見出し、summaryは100〜150字程度の要約(2〜3文)にすること
- 該当する移籍情報が無い場合(本人確認の基準を満たすものが無い場合を含む)は
  空配列 [] を返すこと

## 出力形式(このJSON配列のみを出力し、前後に説明文を一切つけないこと)
[
  {
    "player": "選手名(英語表記)",
    "fromClub": "現所属クラブ(英語表記)",
    "toClub": "移籍先クラブ(英語表記)",
    "status": "状況を表す短い一言(例: here we go / 合意間近 / 中断中 など)",
    "headline": "40字程度の短い見出し",
    "summary": "100〜150字程度の要約",
    "sourceUrl": "報道/引用しているページのURL(見当たらない場合はnull)"
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

  // 出典URLの有無は必須条件ではない(2026-07-31緩和、ファイル冒頭コメント参照)。
  // player/toClubが無い(=何の移籍か特定できない)項目のみ除外する。
  // 本人確認の正確さの見極めはプロンプト側でモデルに行わせている。
  items = items.filter(item => item && item.player && item.toClub);
  items = items.map(item => ({ ...item, sourceUrl: item.sourceUrl || null }));

  return { items, searchSources };
}

// 同じ移籍情報(選手+移籍先)を重複して速報化しないための正規化キー。
export function transferDedupeKey(item) {
  return `${String(item.player || '').trim().toLowerCase()}|${String(item.toClub || '').trim().toLowerCase()}`;
}
