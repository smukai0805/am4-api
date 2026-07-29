// api/feature.js
// ユーザーが指定した特定のトピックについて、AM4編集部として特集記事を1本生成する。
// ai-column.js/daily-digest.jsが自動で話題を選ぶのに対し、これはピンポイントでリクエストできる。
// 重要: 実際のニュースプールに根拠が無い場合は憶測で断定的な内容を書かず、
// {"feature": null, "reason": "no_relevant_source"} を返す。

export const config = { maxDuration: 60 };

import { fetchAllNewsItems, attachEmbedUrls, fetchWikipediaImage, fetchWikipediaSummary } from './news.js';

const LEAGUES_JA = ['プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン', 'ワールドカップ', 'その他'];
const LEAGUES_EN = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'World Cup', 'Other'];

function buildSourceList(items) {
  return items
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 18)
    .map((n, i) => ({ id: i + 1, headline: n.headline, summary: n.fullText || n.summary, source: n.source, link: n.link, image: n.image || null }));
}

function buildWikiFactsBlockJa(wikiFacts) {
  if (wikiFacts && wikiFacts.length > 0) {
    return `
以下はWikipediaで裏取りした実在の人物/クラブの情報です。プロフィールを書く場合は、必ずこの情報と矛盾しないようにしてください。もしトピックの文脈(例: 特定のポジションでの移籍報道)とこの情報が食い違う場合(例: トピックではDFの移籍と言っているのにWikipediaの情報がGKになっている等)、無理に断定せず「情報の特定に確信が持てないため、詳細な断定は避けます」といった慎重な書き方にしてください。

${wikiFacts.map(f => `- ${f.title}: ${f.description || ''} / ${f.extract}`).join('\n')}
`;
  }
  return `Wikipediaでの裏取りができませんでした。一般知識で書く場合も、確信が持てない具体的な数値(身長・年齢等)やポジションは断定せず、慎重な書き方にしてください。`;
}

function buildWikiFactsBlockEn(wikiFacts) {
  if (wikiFacts && wikiFacts.length > 0) {
    return `
Below is verified information from Wikipedia about the real person/club in question. If you write a profile, it must not contradict this information. If the topic's context (e.g. a transfer rumor mentioning a specific position) conflicts with this information (e.g. the topic says a defender, but Wikipedia says this person is a goalkeeper), do not force a confident statement — instead write cautiously, e.g. "we can't confirm the exact identity/details here."

${wikiFacts.map(f => `- ${f.title}: ${f.description || ''} / ${f.extract}`).join('\n')}
`;
  }
  return `Wikipedia verification was not available. Even when writing from general knowledge, do not assert specific numbers (height, age, etc.) or a position you're not confident about — write cautiously instead.`;
}

function getSystemPrompt(lang, topic, wikiFacts) {
  if (lang === 'ja') {
    return `あなたはサッカー専門メディア「AM4編集部」の記者です。
読者から「${topic}」というトピックについて特集記事を書いてほしいというリクエストがありました。

まず、「${topic}」が実在する(実在した)サッカー選手・監督・クラブを指しているかどうかを、あなた自身の一般知識で判断してください。有名・無名は問いません。あなたが知っている実在の人物・クラブであれば、たとえニュース一覧に情報が無くても「材料が無い」という理由だけで記事を諦めてはいけません。

対応方針(必ずこの優先順位で判定):
1. 渡されたニュース記事一覧(JSON)の中に、このトピックに直接関連する実際の報道がある場合
   → それを根拠に日本語で特集記事を書いてください(本文中で情報源に言及すること)。
2. ニュース一覧に直接の材料が無くても、「${topic}」があなたの知っている実在の選手・監督・クラブを指している場合
   → 一覧に情報が無いことは記事を書かない理由にはなりません。必ずあなたの一般知識(経歴・実績・プレースタイル・タイトル歴など、時間が経っても変わらない情報)をもとに紹介記事を書いてください。現在の所属・怪我・直近の試合結果など「今まさに変わりうる」具体的事実だけは、一覧に無い限り断定せず、過去の実績・経歴中心の記述にとどめてください。
3. 「${topic}」が実在の選手・監督・クラブのいずれとも結びつかない場合(存在しない名前、サッカーと無関係なトピックなど)
   → この場合のみ、記事を書かず {"feature": null, "reason": "no_relevant_source"} を返してください。

パターン2の出力例(topicが「ペレ」の場合):
{"feature": {"title":"『サッカーの王様』ペレ、3度のワールドカップ制覇という金字塔","body":"ブラジルが生んだ稀代のストライカー、ペレは...(経歴・実績に基づく紹介文、約500文字)","leagues":["その他"],"subjectNames":["Pelé"],"sourceIds":[]}}

${buildWikiFactsBlockJa(wikiFacts)}

重要なルール:
- パターン3以外は、実在の情報(一覧記載の事実、またはあなたの一般知識として確立している経歴・実績)のみを書いてください。存在しない移籍・スコア・日付などを新たに作り出すことは常に禁止です。
- titleは特に力を入れて、具体的で読みたくなるものにしてください。
- 本文(body)は400〜600文字程度。パターン1で情報源を使った場合は、少なくとも1箇所は実際の情報源名を明記し、「〇〇が報じたところによると」という形にしてください。パターン2(一般知識のみ)の場合はこの限りではありません。
- 関連する人物・クラブ名を英語表記(Wikipedia検索可能な形)でsubjectNames(配列、最大3)として出力してください。
- 参照した記事がある場合のみ、そのidをsourceIdsに配列で入れてください(無ければ空配列)。
- leaguesも配列で出力してください(該当リーグ名: ${LEAGUES_JA.join('/')}、判断が難しい場合は["その他"])。
- 出力は以下のJSON形式のみ、前後に説明文は一切つけないこと:
{"feature": {"title":"...","body":"...","leagues":["..."],"subjectNames":["..."],"sourceIds":[1,2,3]}}
またはパターン3の場合:
{"feature": null, "reason": "no_relevant_source"}`;
  }
  return `You are a reporter for AM4, a football media outlet.
A reader has requested a feature article about the topic: "${topic}".

First, using your own general knowledge, judge whether "${topic}" refers to a real (or formerly real/active) football player, manager, or club — famous or obscure, it doesn't matter. If you recognize it as a real person/club, the mere absence of matching articles in the news list is NOT a reason to give up on writing the feature.

Handling policy (evaluate in this order):
1. The provided news list (JSON) contains actual reporting directly relevant to this topic
   → Write the feature based on that, naming the source in the body (e.g. "according to X").
2. The news list has no direct material, but "${topic}" refers to a real player, manager, or club you recognize
   → Lack of list material is never a reason to refuse. You MUST write an introductory profile piece from your own general knowledge (career, playing style, honors, titles — stable, historical facts). Only avoid asserting specific "currently changing" facts (current club, injury status, recent match results) unless they appear in the list — stick to past achievements and career history for those.
3. "${topic}" cannot be tied to any real player, manager, or club (a nonexistent name, an unrelated topic, etc.)
   → Only in this case, do not write a feature — return {"feature": null, "reason": "no_relevant_source"} instead.

Example of case 2 (topic = "Pelé"):
{"feature": {"title":"The King of Football: Pelé's Unmatched Legacy of Three World Cup Titles","body":"Widely regarded as one of the greatest players in the sport's history, Pelé...(profile based on career/achievements, ~300 words)","leagues":["Other"],"subjectNames":["Pelé"],"sourceIds":[]}}

${buildWikiFactsBlockEn(wikiFacts)}

Rules:
- Outside of case 3, only write real information — either facts from the list, or well-established biographical/career facts from your general knowledge. Never invent a transfer, score, or date that doesn't exist.
- Make the title especially compelling and specific.
- Body 250-400 words. If you used case 1, explicitly name at least one real source. Case 2 (general-knowledge profile) doesn't require this.
- Include subjectNames (array, max 3, English names searchable on Wikipedia).
- Include sourceIds (array of referenced ids; empty array if none were used).
- Include leagues (array, valid: ${LEAGUES_EN.join('/')}; use ["Other"] if unclear).

Output ONLY:
{"feature": {"title":"...","body":"...","leagues":["..."],"subjectNames":["..."],"sourceIds":[1,2,3]}}
or for case 3:
{"feature": null, "reason": "no_relevant_source"}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });

    const topic = String(req.query.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topicパラメータが必要です' });

    const lang = (String(req.query.lang || 'ja').toLowerCase() === 'en') ? 'en' : 'ja';
    const validLeagues = lang === 'ja' ? LEAGUES_JA : LEAGUES_EN;

    const { items: newsItems } = await fetchAllNewsItems();
    const sourceList = buildSourceList(newsItems);
    await attachEmbedUrls(sourceList, 5);
    const promptSourceList = sourceList.map(({ image, embedUrl, ...rest }) => ({ ...rest, hasEmbed: !!embedUrl }));

    // ステップ1: トピックから実在の人物/クラブ候補を推定(軽量な1回目の呼び出し)
    const candidateResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `与えられたトピック文から、それが指している可能性のある実在のサッカー選手・監督・クラブの名前を、Wikipediaで検索できる英語表記で最大2つ推定してください。同姓の別人がいて曖昧な場合は両方候補として挙げてください。出力は{"candidates":["...","..."]}のJSON形式のみ。心当たりが無い場合は{"candidates":[]}。`,
        messages: [{ role: 'user', content: topic }],
      }),
    });
    let candidates = [];
    if (candidateResponse.ok) {
      const cdata = await candidateResponse.json();
      const ctextBlock = (cdata?.content || []).find(b => b.type === 'text');
      const cmatch = ctextBlock?.text?.match(/\{[\s\S]*\}/);
      if (cmatch) {
        try { candidates = JSON.parse(cmatch[0]).candidates || []; } catch {}
      }
    }

    // ステップ2: 候補それぞれについてWikipediaで裏取り
    const wikiFacts = (await Promise.all(candidates.slice(0, 2).map(fetchWikipediaSummary))).filter(Boolean);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        // このエンドポイントはユーザーがボタンを押した時だけ呼ばれるオンデマンド機能で、
        // cronで定期実行されるai-column.js/daily-digest.jsと違い呼び出し頻度が低いため、
        // コスト影響が小さい一方、パターン2(ニュース一覧に無くても実在の選手・監督・クラブなら
        // 一般知識で紹介記事を書く)の判断はHaikuでは安定して一般化しなかったため、
        // より指示追従力の高いSonnetを使う。
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        system: getSystemPrompt(lang, topic, wikiFacts),
        messages: [{ role: 'user', content: `ここに現在配信中のニュース記事一覧をJSONで渡します。\n\n` + JSON.stringify(promptSourceList, null, 2) }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Anthropic APIエラー: HTTP ${response.status} ${detail}`);
    }
    const data = await response.json();
    // Sonnetは拡張思考(type:"thinking")ブロックをcontent[0]に返すことがあるため、
    // 先頭決め打ちではなくtype:"text"のブロックを探す。
    const text = (data?.content || []).find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI応答のJSON解析に失敗: ' + text.slice(0, 200));
    const parsed = JSON.parse(match[0]);

    if (!parsed.feature) {
      return res.status(200).json({ feature: null, reason: parsed.reason || 'no_relevant_source' });
    }

    const col = parsed.feature;
    const ids = Array.isArray(col.sourceIds) ? col.sourceIds : [];
    const citedSources = ids.map(id => sourceList.find(s => s.id === id)).filter(Boolean);
    const sources = citedSources.map(s => ({ title: s.headline, link: s.link, source: s.source }));
    const embedSource = citedSources.find(s => s.embedUrl);
    const embedUrl = embedSource ? embedSource.embedUrl : null;

    const names = Array.isArray(col.subjectNames) ? col.subjectNames.slice(0, 3) : [];
    let wikiImages = [];
    let extraSources = [];
    if (names.length > 0) {
      const wikiResults = await Promise.all(names.map(n => fetchWikipediaImage(n)));
      wikiResults.forEach(wiki => { if (wiki) { wikiImages.push(wiki.imageUrl); extraSources.push({ title: wiki.pageTitle, link: wiki.pageUrl, source: 'Wikipedia' }); } });
    }
    const citedImages = citedSources.map(s => s.image).filter(Boolean);
    const finalImages = wikiImages.length > 0 ? wikiImages : citedImages;
    const finalSources = extraSources.length > 0 ? [...sources, ...extraSources] : sources;
    const leagues = (Array.isArray(col.leagues) ? col.leagues.filter(l => validLeagues.includes(l)) : []);

    const feature = {
      topic,
      category: '特集',
      title: col.title,
      body: col.body,
      leagues,
      sources: finalSources,
      image: finalImages[0] || null,
      images: finalImages,
      embedUrl,
      subjectNames: names,
      generatedAt: new Date().toISOString(),
    };

    return res.status(200).json({ feature });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '生成に失敗しました', detail: err.message });
  }
}
