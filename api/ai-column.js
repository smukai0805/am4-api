// api/ai-column.js
// Vercelのサーバーレス関数(Node.js)。
//
// 「AM4編集部」記事機能: 外部メディアの記事をそのままカード表示するのではなく、
// 実際に配信されている報道(RSS)を根拠データとして読み込んだうえで、AM4編集部としての
// オリジナル記事をAnthropic API(Claude)に書かせて返す。フロント側のニュースタブは
// このエンドポイントの記事のみを主コンテンツとして表示する(外部記事の生カード表示はしない)。
//
// 【2026-07 改修】
//   - 記事数を2〜3本から最大6本に拡大(ニュースタブの主コンテンツになったため)。
//   - 各記事に "leagues" フィールド(配列)を追加。プレミアリーグ/ラ・リーガ/セリエA/
//     ブンデスリーガ/リーグ・アン/ワールドカップ/その他、から関係する分だけ1〜2個選んで付与する。
//     フロント側のリーグ別タブ(全体/プレミア/...)はこの配列に含まれていれば表示するOR一致。
//     (例: 「ビニシウスがアーセナル移籍」のような記事は、現所属のラ・リーガと移籍先候補の
//     プレミアリーグの両方に関わるため、単一リーグだと片方のタブから見えなくなってしまう。
//     複数タグにすることで、どちらのタブからも同じ記事が見えるようにしている。)
//   - 記事の種類は引き続き
//       1. category:"話題まとめ"   — 複数の実記事を横断して要約する記事
//       2. category:"編集部コラム" — 実記事1本を踏まえたAM4独自の考察・便乗記事
//     の2パターン。
//
// 各記事には根拠にした実記事への sources(タイトル+リンク)を必ず添えさせる。
// これは実際の取材・報道ではなく、AIが実記事を読んだ上で書いた記事だが、フロント側では
// 「AM4編集部」の記名記事として表示しつつ、AI執筆であることが分かる小さな注記は残す
// (信頼性を装うために実際の執筆主体を隠すのは逆効果なため)。
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

import { fetchAllNewsItems, attachEmbedUrls, fetchWikipediaImage } from './news.js';

// 【重要】この関数はRSS取得(最大4フィード)+Anthropic API呼び出しを直列で行うため、
// 旧バージョン(Anthropic呼び出しのみ)より実行時間が伸びる。Vercelのサーバーレス関数は
// デフォルトだと実行時間の上限が短く(プランやmaxDuration未指定時の既定値によっては
// 10秒程度)、上限を超えると接続が強制切断されクライアント側には空応答/エラーとして
// 見える。それを避けるため上限を明示的に伸ばす(Hobbyプランでは60秒が上限)。
export const config = {
  maxDuration: 60,
};

function buildSourceList(items) {
  // プロンプトに埋め込む実記事一覧。1件あたりのトークン数を抑えるため、
  // 見出し・要約(短縮)・情報源・リンクのみに絞る。最大18件。
  // fetchAllNewsItems()はフィード取得順のままで日時ソートされていないため、
  // ここで新しい記事を優先するよう並べ替えてから絞り込む。
  // image はAIへのプロンプトには送らず(トークンの無駄なので)、後段でAM4記事の
  // サムネイル画像を選ぶための内部データとしてだけ保持する(callAnthropicの直前でstrip)。
  const sorted = [...items].sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  return sorted.slice(0, 18).map((n, i) => ({
    id: i + 1,
    headline: n.headline,
    summary: n.fullText || n.summary,
    source: n.source,
    link: n.link,
    image: n.image || null
  }));
}

const LEAGUES_JA = ['プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン', 'ワールドカップ', 'その他'];
const LEAGUES_EN = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'World Cup', 'Other'];

const SYSTEM_PROMPT_JA = `あなたはサッカー情報サイト『AM4』の編集部AIです。
以下に、実際に配信されている最新のサッカー関連ニュース記事一覧(id・見出し・要約・情報源・リンク)を渡します。
この一覧「だけ」を事実の根拠として、日本語の記事を作成してください。一覧に無い情報を事実として書いてはいけません。
このサイトのニュースタブでは外部記事をそのまま並べず、この記事群だけを表示するので、できるだけ幅広い話題(複数のリーグ・大会)をカバーしてください。

作成する記事(3〜6本、素材の量に応じて調整可):
1. category:"話題まとめ" — 一覧の中から関連性がある/話題性が高いと思われる記事をまとめて、横断的に要約・整理した記事。同じリーグ・大会の話題ごとに分けて複数本作ってよい(例: W杯関連で1本、プレミア移籍市場で1本、など)。単なる翻訳や丸写しではなく、AM4としての視点でまとめ直すこと。
2. category:"編集部コラム" — 一覧の中から特に読者の関心を引きそうな記事を1本選び、その内容を踏まえたAM4独自の短い考察・便乗コラムを書く。例:移籍報道があれば、その移籍が実現した場合のチームへの影響についての考察、など。

各記事には以下を必ず含めること:
- "sourceIds": 根拠にした記事のid配列(例: [1,3,4])。実際に参照していないidを含めてはいけない。
- "leagues": その記事が関係しているリーグ・大会を、次の中から1〜2個選んで配列で挙げる: ${LEAGUES_JA.join(' / ')}。
  例えば移籍の噂記事(選手の現所属クラブのリーグと、移籍先候補クラブのリーグが異なる場合)は、その両方のリーグを挙げること(例:["ラ・リーガ","プレミアリーグ"])。1つのリーグしか関係しない記事は1個だけでよい。判断が難しい場合は ["その他"]。

一部の記事にはhasEmbed:trueが付いています。これは本人または公式アカウントの投稿(SNS)が見つかっていることを意味します。生成する記事の中に、こうした投稿が話の中心となるもの(移籍発表・本人コメントなど)があれば、該当記事のidをembedSourceIdとして出力してください。無ければembedSourceId: nullにしてください。

記事の内容を視覚的に代表できるもの(選手名・監督名、またはクラブ名)を、英語表記(Wikipediaで検索できる形、例: "Cristian Romero"や"Tottenham Hotspur F.C.")の配列でsubjectNamesとして出力してください。単独の人物に関する記事ならその人物名を1つ、複数の話題にまたがる「まとめ」記事の場合は各話題を代表する人物名またはクラブ名を最大3つまで(例: ["Cristian Romero", "Liverpool F.C.", "Kazuyoshi Miura"])。特に代表的な人物が思い浮かばない話題は、その話題のクラブ名で代用してよい。何も視覚的に代表できるものが無い場合のみsubjectNames: []としてください。

本文中では、少なくとも1箇所は実際の情報源名(渡された記事のsource値、例: The Guardian、BBC Sport、kicker、L'Équipe、Marca等)を明記し、「〇〇が報じたところによると」「〇〇によると」といった形で、海外・国内メディアの報道をAM4編集部が翻訳・要約して伝えている、という書き方にしてください。AM4編集部が独自に取材したかのような書き方は避けてください。

情報源名を本文中に明記する際、同じ話題について複数の情報源がある場合は、ゲキサカよりも海外の一次情報源(The Guardian、BBC Sport、kicker、L'Équipe、Marca等)の名前を優先して挙げてください。ゲキサカは、日本人選手・Jリーグ関連など日本発の話題が中心の場合にのみ情報源として明記してください。

厳守事項(違反しないこと):
- 提供された記事一覧に書かれていない事実(移籍の確定、スコア、具体的な数値、日付など)を新たに作り出してはいけません。
- 実在の選手・監督・関係者の発言を、カギカッコ付きの直接話法で捏造してはいけません。記事一覧内の要約に基づいて間接的に言及するのは可(例:「〜と報じられている」)。
- 記事一覧が空、または話題として使えるものが無い場合は、無理に記事を作らず、その旨がわかる短い1本の記事(category:"話題まとめ"、内容は「現在参照できる話題が少ない」旨、leagues:["その他"])のみを返してください。
- 各記事は200〜320文字程度の日本語で、読み応えのある記事らしい文体にしてください(単なる箇条書きの要約にしない)。
- 見出し(title)は元記事の見出しをそのまま使わず、AM4独自の見出しを付けること。

出力は必ず以下のJSON形式のみで返してください。説明文・前置き・マークダウンのコードブロック記法(\`\`\`)は一切付けないでください:
{"columns":[{"category":"話題まとめ","title":"...","body":"...","leagues":["ワールドカップ"],"sourceIds":[1,2,3],"embedSourceId":null,"subjectNames":["Kylian Mbappe","Jude Bellingham"]},{"category":"編集部コラム","title":"...","body":"...","leagues":["ラ・リーガ","プレミアリーグ"],"sourceIds":[4],"embedSourceId":4,"subjectNames":["Vinicius Junior"]}]}`;

const SYSTEM_PROMPT_EN = `You are the editorial AI for the football site "AM4".
Below is a list of actual, currently published football news articles (id, headline, summary, source, link).
Use ONLY this list as your factual basis for the English-language articles you write. Do not state anything as fact that isn't in this list.
The news tab on this site shows only these AM4-written articles (no raw external article cards), so try to cover a range of topics/leagues when the source material allows it.

Articles to write (3-6 total, adjust based on how much material is available):
1. category:"Topic Roundup" — Pick related/notable articles from the list and write synthesized pieces connecting them. Feel free to write multiple, one per league/topic cluster (e.g. one about World Cup fallout, one about Premier League transfer buzz). Write in your own words and with AM4's own framing, not a translation or copy of the originals.
2. category:"Editor's Take" — Pick one article likely to interest readers and write a short original commentary/reaction piece building on it.

Each article must include:
- "sourceIds": an array of the ids it actually drew from (e.g. [1,3,4]). Never include an id you didn't actually use.
- "leagues": an array of 1-2 leagues/competitions this article relates to, chosen from: ${LEAGUES_EN.join(' / ')}.
  For example, a transfer rumor article (where the player's current club and the rumored destination club are in different leagues) should list BOTH leagues (e.g. ["La Liga","Premier League"]). An article about only one league needs just one entry. Use ["Other"] if unclear.

Some articles have hasEmbed:true. This means a post from the player/club's own or an official account (a social media post) was found for that article. If one of the articles you write centers on such a post (a transfer announcement, a direct comment from the player, etc.), output that article's id as embedSourceId. Otherwise set embedSourceId: null.

Output an array in subjectNames of whatever best visually represents the article's content — player names, manager names, or club names — in English form searchable on Wikipedia (e.g. "Cristian Romero" or "Tottenham Hotspur F.C."). For a single-subject article, output one name; for a roundup spanning multiple topics, output up to 3 names or club names, one per topic (e.g. ["Cristian Romero", "Liverpool F.C.", "Kazuyoshi Miura"]). If no individual clearly represents a given topic, use that topic's club name instead. Only use subjectNames: [] if there is truly nothing that could visually represent the article.

Somewhere in the body text, name the actual source at least once (the source value from the provided articles, e.g. The Guardian, BBC Sport, kicker, L'Équipe, Marca), using phrasing like "according to X" or "as X reported" — make it clear AM4's editorial team is translating/summarizing foreign and domestic media coverage, not reporting as an original AM4 investigation.

When multiple sources cover the same topic, prefer naming an international primary source (The Guardian, BBC Sport, kicker, L'Équipe, Marca, etc.) over Gekisaka. Only name Gekisaka as the source when the topic centers on a Japanese player or the J.League.

Strict rules (must not violate):
- Never invent facts (confirmed transfers, scores, specific numbers, dates) that are not present in the provided article list.
- Never fabricate direct quotes attributed to real players, managers, or officials. Indirect reference based on the provided summaries is fine (e.g., "reportedly...").
- If the article list is empty or has nothing usable, do not force content — return a single short "Topic Roundup" article (leagues: ["Other"]) noting that few topics are currently available.
- Each article should be about 120-180 words, written in a natural article/feature style, not a bare bullet-point summary.
- Write your own headline (title); do not just reuse a source article's headline verbatim.

Return ONLY the following JSON format. No preamble, no explanation, no markdown code fences:
{"columns":[{"category":"Topic Roundup","title":"...","body":"...","leagues":["World Cup"],"sourceIds":[1,2,3],"embedSourceId":null,"subjectNames":["Kylian Mbappe","Jude Bellingham"]},{"category":"Editor's Take","title":"...","body":"...","leagues":["La Liga","Premier League"],"sourceIds":[4],"embedSourceId":4,"subjectNames":["Vinicius Junior"]}]}`;

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
    await attachEmbedUrls(sourceList, 5);
    // image/embedUrlはAIには不要な情報(トークンの無駄・実URLを渡すと捏造リスクもある)なので、
    // プロンプトに渡す分だけ除き、embedUrlの有無だけをhasEmbedとして渡す。
    // sourceList自体(image/embedUrl込み)は後でサムネイル・埋め込みURL選定に使うため保持しておく。
    const promptSourceList = sourceList.map(({ image, embedUrl, ...rest }) => ({ ...rest, hasEmbed: !!embedUrl }));

    const userPrompt =
      `ここに現在配信中のニュース記事一覧をJSONで渡します。この内容だけを根拠にコラムを作成してください。\n\n` +
      JSON.stringify(promptSourceList, null, 2);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3500,
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

    const rawColumns = Array.isArray(parsed.columns) ? parsed.columns.slice(0, 6) : [];
    const validLeagues = lang === 'en' || lang === 'es' ? LEAGUES_EN : LEAGUES_JA;

    // sourceIds(1始まりのid配列)を、実際のsourceList上の記事(title+link)に変換して
    // フロント側で「元記事」リンクとして表示できるようにする。
    // AIが範囲外・不正なidを返した場合は無視する(存在しないidは捏造の可能性があるため)。
    const columns = await Promise.all(rawColumns.map(async col => {
      const ids = Array.isArray(col.sourceIds) ? col.sourceIds : [];
      const citedSources = ids.map(id => sourceList.find(s => s.id === id)).filter(Boolean);
      const sources = citedSources.map(s => ({ title: s.headline, link: s.link, source: s.source }));
      // 記事のサムネイル画像: 根拠にした実記事(sources)のうち、画像を持つ最初の1件を使う。
      // AM4記事自体は合成コンテンツで専用の画像を持たないため、実際の報道写真を借りる形。
      const image = citedSources.map(s => s.image).find(Boolean) || null;
      // AIが想定外のリーグ名を返した場合はフロント側のタブフィルタが壊れないよう「その他」に丸める。
      // leaguesは配列(1〜2個)。旧バージョンとの後方互換のため、万一AIが単一文字列を返しても
      // 配列に正規化する。
      const rawLeagues = Array.isArray(col.leagues) ? col.leagues : (col.league ? [col.league] : []);
      let leagues = rawLeagues
        .filter(l => validLeagues.includes(l))
        .slice(0, 2);
      if (leagues.length === 0) leagues = [validLeagues[validLeagues.length - 1]]; // "その他"/"Other"
      // embedSourceId: AIが指定した記事(citedSources内)が実際にembedUrlを持っている場合のみ採用。
      // 範囲外・未引用のidや、embedUrlが見つからなかった記事のidは無視する(捏造防止のため)。
      const embedSourceId = typeof col.embedSourceId === 'number' ? col.embedSourceId : null;
      const embedSource = embedSourceId ? citedSources.find(s => s.id === embedSourceId) : null;
      const embedUrl = (embedSource && embedSource.embedUrl) ? embedSource.embedUrl : null;

      // subjectNames: 記事に関連する人物(最大3人)が明確な場合、RSS由来の画像より高解像度・
      // 出典が明確なWikipediaの画像を人数分まとめて使い、出典(sources)にもWikipediaを明記する。
      const names = Array.isArray(col.subjectNames) ? col.subjectNames.slice(0, 3) : (col.subjectName ? [col.subjectName] : []);
      let wikiImages = [];
      let extraSources = [];
      if (names.length > 0) {
        const wikiResults = await Promise.all(names.map(n => fetchWikipediaImage(n)));
        wikiResults.forEach(wiki => {
          if (wiki) {
            wikiImages.push(wiki.imageUrl);
            extraSources.push({ title: wiki.pageTitle, link: wiki.pageUrl, source: 'Wikipedia' });
          }
        });
      }
      const finalImages = wikiImages.length > 0 ? wikiImages : (image ? [image] : []);
      const finalImage = finalImages[0] || null;
      const finalSources = extraSources.length > 0 ? [...sources, ...extraSources] : sources;

      return {
        category: col.category,
        image: finalImage,
        images: finalImages,
        title: col.title,
        body: col.body,
        leagues,
        sources: finalSources,
        embedUrl,
        subjectNames: names,
        generatedAt: new Date().toISOString()
      };
    }));

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
