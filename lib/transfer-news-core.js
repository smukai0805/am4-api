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
//
// 【検索エラー時の挙動について(2026-07-31修正)】実データ検証で、Web検索ツールが
// 実際には検索結果(searchSources)を52件取得できていたにもかかわらず、モデルが
// rejectedに「検索がエラーで一切取得できなかった」と記録し、items 0件で返す事例を
// 確認した。一部のクエリでのエラー(ツール利用上限超過等)を理由に、既に得られている
// 検索結果まで無視して全クラブを一括却下してしまう挙動と見られる。プロンプトに
// 「部分的にでも検索結果が得られていればそれを最大限活用すること」という指示を追加した。

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
// 返り値: { items: [{ player, fromClub, toClub, status, isHereWeGo, headline, summary,
//           sourceUrl }], rejected: [{ description, reason }], searchSources }
//
// 【2026-07-31 追加】rejectedは、本人確認基準を満たさず却下した候補を理由付きで
// 返させるためのデバッグ用フィールド。「条件が厳しすぎるのか」「そもそも検索が
// ヒットしていないのか」を切り分けられるようにする(呼び出し元でログ出力する)。
export async function checkTransferNews(clubNames) {
  const prompt = `
あなたはサッカー移籍情報専門のリサーチャーです。Web検索を使い、移籍情報で最も信頼される
記者の一人であるFabrizio Romano(ファブリツィオ・ロマーノ)が直近数日以内に報じた、
以下のクラブに関係する移籍情報を調べてください。

対象クラブ: ${clubNames.join(', ')}

## 対象とする情報の範囲(2026-07-31拡大)
「移籍が正式に成立した」情報だけでなく、以下のような移籍関連情報全般を対象にすること:
- 交渉開始・関心表明(クラブが特定選手に関心を示している、打診した等)
- 交渉が進展中・合意間近(here we go一歩手前の段階)
- 交渉破談・決裂(一度進んでいた話がまとまらなかった等)
- 合意成立・正式発表(here we go、契約合意、メディカルチェック等)
「動きがあった」と言えるものは幅広く候補にしてよい(ただし本人確認の基準は下記の通り
厳格に保つこと)。

## 「Here we go」の特別な扱い(重要)
Fabrizio Romano本人が実際に "Here we go" という、移籍合意が正式に固まったことを示す
彼の代名詞的な表現を使った場合(またはそれに相当する明確な確定表現を使った場合)のみ、
isHereWeGoをtrueにすること。それ以外(交渉中、合意間近、破談等)は必ずfalseにすること。
このフラグは読者向けの速報一覧で特別に強調表示するため、確信が持てない場合はfalseにする
こと(ここでも「誤って強調する」より「見逃す」方を選ぶこと)。

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
- 本人確認の基準を満たさず対象から外した候補があれば、rejected配列に理由付きで
  記録すること(除外基準が厳しすぎるのか、検索自体がヒットしていないのかを後から
  切り分けるためのデバッグ用途。最大10件まで)

## 出典について
- ロマーノの投稿はX上のテキスト自体が情報源であり、必ずしも別記事への外部リンクを
  伴わないため、出典URLの有無は速報化の必須条件ではない
- 検索結果の中に、ロマーノの発信を報じている/引用しているページ(ニュースサイトの記事、
  彼のX投稿を引用しているページなど)のURLがあればsourceUrlとして使うこと
- 該当するURLが見当たらない場合はsourceUrlをnullにしてよい(その場合でも上記の
  「本人確認の正確さ」の基準さえ満たしていれば速報化してよい)

## 検索エラーへの対処(重要)
Web検索ツールの利用中に、一部のクエリでエラー(ツール利用上限超過等)が発生することが
ある。その場合でも、実際に検索結果が1件でも得られていれば、その結果を最大限活用して
分析すること。一部のクエリでエラーが発生したことを理由に、既に得られている検索結果まで
無視して全クラブを「検索不能」として一括で却下してはならない(得られた結果の範囲内で
判断すること。全く検索結果が得られなかった場合のみ、rejectedにその旨を記録してよい)。

## その他の指示
- 検索クエリの例: "Fabrizio Romano [クラブ名] transfer latest"
- 選手名・クラブ名は英語表記で統一すること(カタカナ変換はしないこと)
- headlineは40字程度の短い見出し、summaryは100〜150字程度の要約(2〜3文)にすること
- itemsは最大8件まで。該当する移籍情報が無い場合(本人確認の基準を満たすものが無い
  場合を含む)はitemsを空配列 [] にすること

## 出力形式(このJSONオブジェクトのみを出力し、前後に説明文を一切つけないこと)
{
  "items": [
    {
      "player": "選手名(英語表記)",
      "fromClub": "現所属クラブ(英語表記)",
      "toClub": "移籍先クラブ(英語表記)",
      "status": "状況を表す短い一言(例: here we go / 合意間近 / 交渉決裂 / 関心表明 など)",
      "isHereWeGo": false,
      "headline": "40字程度の短い見出し",
      "summary": "100〜150字程度の要約",
      "sourceUrl": "報道/引用しているページのURL(見当たらない場合はnull)"
    }
  ],
  "rejected": [
    { "description": "見送った候補の概要(選手名・移籍先など)", "reason": "却下した理由" }
  ]
}
`;

  const data = await callAnthropic({
    maxTokens: 4500,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    prompt,
    // 260秒。プロンプト拡張(対象範囲の拡大+rejectedの理由付き記録)後、実データ検証で
    // 200秒では2回連続タイムアウトすることを確認したため引き上げた。この呼び出し自体が
    // 主目的(速報の検知・保存)であり、後続のHere we go連動の選手記事生成は
    // api/transfer-news-watch.js側でチェックポイント後のベストエフォート処理のため、
    // ここを優先して時間を確保してよい。
    timeoutMs: 260000,
  });

  const text = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
  const searchSources = extractSearchSources(data.content);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('transfer news: AI応答からJSONオブジェクトを抽出できませんでした:', text.slice(0, 300));
    return { items: [], rejected: [], searchSources };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    console.error('transfer news: JSON解析に失敗しました:', err.message, text.slice(0, 300));
    return { items: [], rejected: [], searchSources };
  }

  let items = Array.isArray(parsed.items) ? parsed.items : [];
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];

  // 出典URLの有無は必須条件ではない(2026-07-31緩和、ファイル冒頭コメント参照)。
  // player/toClubが無い(=何の移籍か特定できない)項目のみ除外する。
  // 本人確認の正確さの見極めはプロンプト側でモデルに行わせている。
  items = items
    .filter(item => item && item.player && item.toClub)
    .map(item => ({ ...item, sourceUrl: item.sourceUrl || null, isHereWeGo: item.isHereWeGo === true }));

  return { items, rejected, searchSources };
}

// 同じ移籍情報(選手+移籍先)を重複して速報化しないための正規化キー。
export function transferDedupeKey(item) {
  return `${String(item.player || '').trim().toLowerCase()}|${String(item.toClub || '').trim().toLowerCase()}`;
}
