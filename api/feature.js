// api/feature.js
// ユーザーが指定した特定のトピックについて、AM4編集部として特集記事を1本生成する。
// ai-column.js/daily-digest.jsが自動で話題を選ぶのに対し、これはピンポイントでリクエストできる。
// 重要: 実際のニュースプールに根拠が無い場合は憶測で断定的な内容を書かず、
// {"feature": null, "reason": "no_relevant_source"} を返す。

export const config = { maxDuration: 60 };

import { fetchAllNewsItems, attachEmbedUrls, fetchWikipediaImage } from './news.js';

const LEAGUES_JA = ['プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン', 'ワールドカップ', 'その他'];
const LEAGUES_EN = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'World Cup', 'Other'];

function buildSourceList(items) {
  return items
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 18)
    .map((n, i) => ({ id: i + 1, headline: n.headline, summary: n.fullText || n.summary, source: n.source, link: n.link, image: n.image || null }));
}

function getSystemPrompt(lang, topic) {
  if (lang === 'ja') {
    return `あなたはサッカー専門メディア「AM4編集部」の記者です。
読者から「${topic}」というトピックについて特集記事を書いてほしいというリクエストがありました。

渡されたニュース記事一覧(JSON)の中に、このトピックに直接関連する実際の報道がある場合のみ、それを根拠に日本語で特集記事を書いてください。

重要なルール:
- 提供された記事の中にこのトピックに関する具体的な情報が無い、または古すぎる/断片的すぎる場合は、絶対に憶測や推測で断定的な内容を書かないでください。その場合は記事を書かず、{"feature": null, "reason": "no_relevant_source"} だけを返してください。
- 関連する情報が見つかった場合、titleは特に力を入れて、具体的で読みたくなるものにしてください。
- 本文(body)は400〜600文字程度。少なくとも1箇所は実際の情報源名を明記し、「〇〇が報じたところによると」という形にしてください。
- 関連する人物・クラブ名を英語表記(Wikipedia検索可能な形)でsubjectNames(配列、最大3)として出力してください。
- 参照した記事のidをsourceIdsに配列で入れてください。
- leaguesも配列で出力してください(該当リーグ名: ${LEAGUES_JA.join('/')})。
- 出力は以下のJSON形式のみ、前後に説明文は一切つけないこと:
{"feature": {"title":"...","body":"...","leagues":["..."],"subjectNames":["..."],"sourceIds":[1,2,3]}}
または情報不足の場合:
{"feature": null, "reason": "no_relevant_source"}`;
  }
  return `You are a reporter for AM4, a football media outlet.
A reader has requested a feature article about the topic: "${topic}".

Only write this feature IF the provided news list (JSON) contains actual reporting directly relevant to this topic. If not, do not speculate — return {"feature": null, "reason": "no_relevant_source"} instead.

If relevant info exists: make the title especially compelling and specific. Body 250-400 words, explicitly name at least one real source ("according to X"). Include subjectNames (array, max 3, English names searchable on Wikipedia). Include sourceIds (array of referenced ids). Include leagues (array, valid: ${LEAGUES_EN.join('/')}).

Output ONLY:
{"feature": {"title":"...","body":"...","leagues":["..."],"subjectNames":["..."],"sourceIds":[1,2,3]}}
or if insufficient info:
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system: getSystemPrompt(lang, topic),
        messages: [{ role: 'user', content: `ここに現在配信中のニュース記事一覧をJSONで渡します。\n\n` + JSON.stringify(promptSourceList, null, 2) }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Anthropic APIエラー: HTTP ${response.status} ${detail}`);
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
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
