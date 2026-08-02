// lib/transfer-news-core.js
//
// ファブリツィオ・ロマーノ(Fabrizio Romano)が発信する移籍情報を、Anthropic APIの
// Web検索ツールで定期的にチェックし、短い速報テキストとして生成する機能の中核ロジック。
//
// 【Xの投稿を直接取得しない理由】X(Twitter)API(有料)への登録が未着手のため、
// 代わりにWeb検索で「ロマーノが報じた最新の移籍情報」を調べる方式にしている。
// Web検索経由のため、実際のXの投稿と比べて反映にタイムラグが出ることは許容している。
//
// 【2026-08-04 根本的に再設計】当初は「対象15クラブ(PILOT_CLUBS)それぞれについて
// Web検索する」という設計(1回の呼び出し内でmax_uses:12のWeb検索を横断的に行う)に
// なっていたが、これは元々の目的を取り違えていた。移籍速報はロマーノの発信そのものを
// 拾うことが目的であり、クラブを限定する必要は無い(むしろ15クラブ限定だと、対象外の
// クラブに関するロマーノの速報を取りこぼしてしまう)。加えて、実データ検証で15クラブ分を
// 1回の呼び出しでカバーしようとするresearch呼び出しが恒常的にタイムアウト
// (timeoutMs:220000に到達)し、移籍速報が1件も生成されない状態が続いていた
// (根本原因: 検索範囲が広すぎて所要時間が長くなりすぎていた)。
//
// 対策として、「対象クラブ一覧を渡して横断検索させる」方式をやめ、「ロマーノ本人の
// 直近の発信内容を(クラブを問わず)直接調べる」軽量な検索に変更した。検索対象が
// 1つのトピック(この人物の最近の発信)に絞られるため、Web検索の回数(max_uses)・
// タイムアウト設定ともに大幅に縮小できる。
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
// 【2段階構成(2026-07-31導入、2026-08-04も維持)】検索(web_search)と分析・JSON整形を
// 1回のAI呼び出しにまとめると、Web検索ツールが実際には検索結果(searchSources)を
// 取得できていたにもかかわらず、モデルがrejectedに「検索がエラーで一切取得できなかった」
// と記録し、items 0件で返す事例があった。一部のクエリでのエラー(ツール利用上限超過等)が
// 発生すると、モデルが同じ応答内で既に得た検索結果まで巻き込んで「全滅」と結論づけて
// しまう挙動と見られる。
//
// match-report-core.js・academy-core.jsが既に採用している「検索(research、web_search
// あり)」→「分析・執筆(write、web_searchなし)」の2段階呼び出しに構成を合わせている。
// research呼び出しはツールエラーが起きても、その回で実際に得られた検索結果(テキスト
// メモ+searchSources)をそのまま返すだけで、本人確認の判断や JSON整形は行わない。
// 判断・整形は完全に独立した2回目の呼び出し(write、ツール無し)で、渡されたメモの
// 範囲内でのみ行わせる。これにより「検索ツールのエラー」と「本人確認の判断」が
// 同一の応答内で混線することを防ぐ。

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function callAnthropic({ maxTokens, tools, prompt, label, timeoutMs }) {
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
      throw new Error(`Anthropic API error (${label}): ${response.status} ${errText}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Anthropic API timeout (${label}): ${timeoutMs}ms を超過`);
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

// Fabrizio Romano本人の直近の発信内容を(クラブを限定せず)横断的に検索させる。
// 返り値: { items: [{ player, fromClub, toClub, status, isHereWeGo, headline, summary,
//           sourceUrl }], rejected: [{ description, reason }], searchSources }
//
// 【2026-08-04】以前はclubNames引数で対象クラブ一覧を渡していたが、根本設計の見直しに
// 伴い廃止した(ヘッダーコメント参照)。
//
// 【2026-07-31 追加、2026-08-04も維持】rejectedは、本人確認基準を満たさず却下した候補を
// 理由付きで返させるためのデバッグ用フィールド。「条件が厳しすぎるのか」「そもそも検索が
// ヒットしていないのか」を切り分けられるようにする(呼び出し元でログ出力する)。
export async function checkTransferNews() {
  // ---- 1. research(web_searchあり、判断・整形はさせない。見つけた事実だけを
  //         箇条書きメモとして書き出させる。ツールエラーが起きても、それまでに
  //         得られた検索結果はそのままsearchSourcesとして残る) ----
  const researchPrompt = `
Fabrizio Romano(ファブリツィオ・ロマーノ、X/Twitterアカウント: @FabrizioRomano)が
直近数日以内に発信した最新の移籍関連情報をWeb検索で調べてください。特定のクラブに
限定する必要はありません。彼が報じた移籍・退団・契約関連のニュース全般を対象に
してください。

## 検索の進め方
「Fabrizio Romano transfer news」「Fabrizio Romano here we go」「Fabrizio Romano
latest」のような検索語で、彼自身の直近の発信内容・それを引用/報道している記事を
探してください。特定のクラブや選手名を起点に調べる必要はなく、ロマーノ自身の
直近の発信を起点に調べてください。

## 調べる範囲
「移籍が正式に成立した」情報だけでなく、交渉開始・関心表明、交渉進展・合意間近
(here we go一歩手前)、交渉破談・決裂、合意成立・正式発表(here we go等)まで、
「動きがあった」と言えるものは幅広く対象にしてよい。

## 出力形式
見つかった移籍関連の動きを、1件につき以下を含む日本語の箇条書きでまとめてください
(深追いはせず、検索で見つかった範囲の要点のみでよい):
- 選手名・移籍元クラブ・移籍先クラブ(英語表記)
- 状況(交渉中/合意間近/here we go/破談 等)
- Fabrizio Romano本人の発信だと確認できる根拠(複数の信頼できるサイトが「Romanoが
  報じた」と明記しているか、単一の弱い情報源しか無いか等、確認できた事実をそのまま書く。
  ここでは判断・取捨選択はせず、確認できたことをそのまま記録すること)
- 出典URL(あれば)

該当する情報が見当たらない場合は、その旨(何を検索して何も見つからなかったか)を
書いてください。一部の検索でエラーが発生した場合でも、他の検索で得られた結果があれば
それをそのまま書き出してください(エラーを理由に調査全体を放棄しないこと)。
`;
  let researchNotes = '';
  let searchSources = [];
  try {
    const researchData = await callAnthropic({
      maxTokens: 4000,
      // 2026-08-04: クラブ横断検索(旧設計、max_uses:12)をやめ、ロマーノ本人の直近の
      // 発信という1つのトピックに絞った検索にしたため、必要な検索回数も大幅に減った。
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      prompt: researchPrompt,
      label: 'research',
      // 2026-08-04: 検索範囲を1トピックに絞ったことに伴い、220000ms→120000msに短縮
      // (旧設計は15クラブ分の横断検索が必要で、これが恒常的なタイムアウトの原因になって
      // いた。単一トピックの検索であれば academy-core.js の個別選手リサーチ
      // (timeoutMs:150000)と同程度かそれ以下で十分なはず)。
      timeoutMs: 120000,
    });
    researchNotes = (researchData.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
    searchSources = extractSearchSources(researchData.content);
  } catch (err) {
    console.error('transfer news: research call failed:', err.message);
  }

  // ---- 2. write(ツール無し。research結果のメモだけをもとに、本人確認の判断と
  //         JSON整形を行う。検索ツール自体のエラーとは完全に切り離されているため、
  //         「検索エラーだったので全滅」という誤った結論に至ることがない) ----
  const writePrompt = `
あなたはサッカー移籍情報専門のリサーチャーです。以下は、Fabrizio Romano(ファブリツィオ・
ロマーノ)が報じた移籍情報について、Web検索で事前に収集した調査メモです。この
メモに書かれている内容だけをもとに判断してください(メモに無い情報を推測で
補ったり、メモの範囲を超えて創作したりしないこと)。

## 調査メモ
${researchNotes || '(検索により得られた情報なし)'}

## 「Here we go」の特別な扱い(重要)
メモの中で、Fabrizio Romano本人が実際に "Here we go" という、移籍合意が正式に
固まったことを示す彼の代名詞的な表現を使ったと確認できる場合(またはそれに相当する
明確な確定表現)のみ、isHereWeGoをtrueにすること。それ以外(交渉中、合意間近、破談等)
は必ずfalseにすること。確信が持てない場合はfalseにすること
(「誤って強調する」より「見逃す」方を選ぶこと)。

## 最優先事項: 「本人確認の正確さ」を、拾える件数の多さより優先すること
- 最も重要なのは、偽アカウント・なりすまし・伝聞の伝聞ではなく、本当にFabrizio Romano
  本人の発信を根拠にしているかどうかの見極めである。件数を多く拾うことより、拾った
  1件1件が本当に本人発信であることの方がずっと重要
- メモの中で、以下のいずれかが確認できる項目のみ「本人発信」とみなしてよい:
  (a) 複数の信頼できるスポーツニュースサイトが「Fabrizio Romanoが報じた/確認した」と
      明記して報道している、とメモに書かれている
  (b) その情報がロマーノの発信内容として広く引用・言及されている、とメモに書かれている
  メモがこれらを確認できていない(単一の弱い情報源のみ、真偽不明、なりすましの疑いがある、
  そもそもメモに記載が無い等)場合は、多少の見逃しになってもよいので対象から外すこと。
  迷った場合は「拾わない」を選ぶこと
- 本人確認の基準を満たさず対象から外した候補があれば、rejected配列に理由付きで
  記録すること(除外基準が厳しすぎるのか、そもそもメモに情報が無かったのかを後から
  切り分けるためのデバッグ用途。最大10件まで)
- 調査メモ自体が「情報なし」の場合は、itemsを空配列にし、rejectedに「検索により
  有効な情報が得られなかった」旨を1件だけ記録すること

## 出典について
- ロマーノの投稿はX上のテキスト自体が情報源であり、必ずしも別記事への外部リンクを
  伴わないため、出典URLの有無は速報化の必須条件ではない
- メモの中にURLの記載があればsourceUrlとして使うこと。無ければnullでよい
  (その場合でも上記の「本人確認の正確さ」の基準さえ満たしていれば速報化してよい)

## その他の指示
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
  const writeData = await callAnthropic({
    maxTokens: 4500,
    tools: null,
    prompt: writePrompt,
    label: 'write',
    // ツール無しの純粋なテキスト生成のため、researchより短時間で十分。
    timeoutMs: 60000,
  });
  const text = (writeData.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');

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
