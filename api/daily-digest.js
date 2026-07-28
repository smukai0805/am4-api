// api/daily-digest.js
// 「朝刊」「昼刊」「夕刊」——1日3回、直近の時間帯に発生したニュースをまとめて
// AM4編集部が1本の記事として書き下ろす機能。
// Vercel Cron(vercel.json)から1日3回(6:00/12:00/18:00 JST)自動で呼び出される想定。
// 生成結果はVercelのエッジキャッシュ(s-maxage)に乗るため、Cronが「温めて」おいた内容を
// 実際の閲覧者はAnthropic APIを呼ばずに受け取れる(キャッシュが切れていた場合のみ、
// 閲覧者のリクエストがそのまま生成トリガーになる)。
//
// クエリパラメータ:
//   ?period=morning|midday|evening  (省略時は現在のJST時刻から自動判定)
//   ?lang=ja|en|es                   (省略時はja)

export const config = { maxDuration: 60 };

import { fetchAllNewsItems, fetchWikipediaImage } from './news.js';

const LEAGUES_JA = ['プレミアリーグ', 'ラ・リーガ', 'セリエA', 'ブンデスリーガ', 'リーグ・アン', 'ワールドカップ', 'その他'];
const LEAGUES_EN = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'World Cup', 'Other'];

const PERIOD_LABELS = {
  morning: { ja: '朝刊', en: 'Morning Edition', startHour: 0, endHour: 6 },
  midday:  { ja: '昼刊', en: 'Midday Edition',  startHour: 6, endHour: 12 },
  evening: { ja: '夕刊', en: 'Evening Edition', startHour: 12, endHour: 18 },
};

function detectPeriodFromJstHour(jstHour) {
  if (jstHour >= 18 || jstHour < 6) return 'morning';
  if (jstHour < 12) return 'midday';
  return 'evening';
}

function getJstHour(date) {
  return (date.getUTCHours() + 9) % 24;
}

function buildSourceList(items) {
  return items
    .filter(n => n.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 18)
    .map((n, i) => ({
      id: i + 1,
      headline: n.headline,
      summary: n.fullText || n.summary,
      source: n.source,
      link: n.link,
      image: n.image || null,
      time: n.time,
    }));
}

function filterByWindow(sourceList, period) {
  const { startHour, endHour } = PERIOD_LABELS[period];
  const inWindow = sourceList.filter(s => {
    const h = getJstHour(new Date(s.time));
    if (startHour < endHour) return h >= startHour && h < endHour;
    return h >= startHour || h < endHour;
  });
  return inWindow.length >= 3 ? inWindow : sourceList.slice(0, 10);
}

function getSystemPrompt(lang, periodLabel) {
  const leagues = lang === 'ja' ? LEAGUES_JA : LEAGUES_EN;
  if (lang === 'ja') {
    return `あなたはサッカー専門メディア「AM4編集部」の記者です。
渡されたニュース記事一覧(JSON)だけを根拠に、「${periodLabel}」として、この時間帯に起きた複数の話題をまとめた1本の総括記事を日本語で書いてください。

ルール:
- 個々の記事をただ並べるのではなく、記者自身の視点で「この時間帯何が起きたか」を1つの読み物としてまとめること
- 3〜5個程度のトピックに触れること(渡された記事数が少ない場合は無理に増やさなくてよい)
- 見出し(title)は「${periodLabel}」を含む、読みたくなる具体的なタイトルにすること
- 本文(body)は400〜600文字程度
- 参照した記事のidをsourceIdsに配列で入れること
- 扱ったトピックに関連するリーグをleaguesに配列で入れること(該当リーグ名: ${leagues.join('/')})。複数リーグにまたがる場合は最大2つまで
- 記事の内容を視覚的に代表できるもの(選手名・監督名、またはクラブ名)を、英語表記(Wikipediaで検索できる形、例: "Zinedine Zidane"や"Real Madrid CF")の配列でsubjectNamesとして出力してください。最大3つまで。特に代表的なものが無い場合はsubjectNames: []としてください。
- 出力は以下のJSON形式のみ。前後に説明文は一切つけないこと:
{"title":"...","body":"...","leagues":["..."],"sourceIds":[1,2,3],"subjectNames":["Zinedine Zidane"]}`;
  }
  return `You are a reporter for AM4, a football media outlet.
Based only on the provided news list (JSON), write ONE roundup article in English titled "${periodLabel}" summarizing multiple topics from this time window.

Rules:
- Don't just list articles; synthesize "what happened in this window" as a single piece of writing
- Cover roughly 3-5 topics (fewer is fine if few articles were provided)
- title should be a compelling specific headline including "${periodLabel}"
- body should be 250-400 words
- Include the ids of referenced articles in sourceIds
- Include relevant leagues in "leagues" (valid names: ${leagues.join('/')}), max 2
- Output an array in subjectNames of whatever best visually represents the article's content — player names, manager names, or club names — in English form searchable on Wikipedia (e.g. "Zinedine Zidane" or "Real Madrid CF"). Up to 3. Use subjectNames: [] if nothing clearly represents it.
- Output ONLY this JSON shape, no extra text:
{"title":"...","body":"...","leagues":["..."],"sourceIds":[1,2,3],"subjectNames":["Zinedine Zidane"]}`;
}

async function callAnthropic(apiKey, lang, periodLabel, sourceList) {
  const promptSourceList = sourceList.map(({ image, ...rest }) => rest);
  const userPrompt = (lang === 'ja'
    ? `ここに現在配信中のニュース記事一覧をJSONで渡します。この内容だけを根拠に${periodLabel}の総括記事を作成してください。\n\n`
    : `Here is the current news list as JSON. Use only this content to write the ${periodLabel} roundup.\n\n`
  ) + JSON.stringify(promptSourceList, null, 2);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: getSystemPrompt(lang, periodLabel),
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Anthropic APIエラー: HTTP ${response.status} ${detail}`);
  }
  const data = await response.json();
  const text = data?.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI応答のJSON解析に失敗しました: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
    }

    const lang = (String(req.query.lang || 'ja').toLowerCase() === 'en') ? 'en' : 'ja';
    const requestedPeriod = String(req.query.period || '').toLowerCase();
    const period = PERIOD_LABELS[requestedPeriod] ? requestedPeriod : detectPeriodFromJstHour(getJstHour(new Date()));
    const periodLabel = PERIOD_LABELS[period][lang];
    const validLeagues = lang === 'ja' ? LEAGUES_JA : LEAGUES_EN;

    const { items: newsItems } = await fetchAllNewsItems();
    const fullSourceList = buildSourceList(newsItems);
    const windowedSourceList = filterByWindow(fullSourceList, period);

    if (windowedSourceList.length === 0) {
      return res.status(200).json({ digest: null, reason: '対象記事がありませんでした' });
    }

    const parsed = await callAnthropic(apiKey, lang, periodLabel, windowedSourceList);

    const ids = Array.isArray(parsed.sourceIds) ? parsed.sourceIds : [];
    const citedSources = ids.map(id => windowedSourceList.find(s => s.id === id)).filter(Boolean);
    const sources = citedSources.map(s => ({ title: s.headline, link: s.link, source: s.source }));
    const image = citedSources.map(s => s.image).find(Boolean) || null;

    const rawLeagues = Array.isArray(parsed.leagues) ? parsed.leagues : [];
    let leagues = rawLeagues.filter(l => validLeagues.includes(l)).slice(0, 2);
    if (leagues.length === 0) leagues = [validLeagues[validLeagues.length - 1]];

    const names = Array.isArray(parsed.subjectNames) ? parsed.subjectNames.slice(0, 3) : [];
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
    const finalSources = extraSources.length > 0 ? [...sources, ...extraSources] : sources;

    const digest = {
      period,
      category: periodLabel,
      title: parsed.title || periodLabel,
      body: parsed.body || '',
      leagues,
      sources: finalSources,
      image: finalImages[0] || null,
      images: finalImages,
      generatedAt: new Date().toISOString(),
    };

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    return res.status(200).json({ digest });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '生成に失敗しました', detail: err.message });
  }
}
