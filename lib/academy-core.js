// lib/academy-core.js
//
// api/generate-academy-player-article.js から移設した共有ロジック。
// Vercel Hobbyプランのサーバーレス関数数上限(1デプロイ12個まで)を超えないよう、
// api/配下ではなくlib/配下に置くことで関数としてカウントされないようにしている
// (Vercelはapi/直下のファイルのみを関数としてビルドする)。
//
// academy-debut-watch.js からのみimportされる。単体テスト用の手動生成エンドポイントは
// academy-debut-watch.js側に ?list=1 / POST 経由で統合済み。
//
// 環境変数: API_FOOTBALL_KEY, ANTHROPIC_API_KEY が必要。

import { put, get } from '@vercel/blob';

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 生成した下書きを保存するJSONファイルのpathname(Vercel Blob、プライベートアクセス)。
const DRAFTS_PATHNAME = 'academy-article-drafts.json';

const ARTICLE_FORMAT_SPEC = `
# 選手紹介記事フォーマット(AM4)

文体: である調(専門メディア風)
文字数目安: 1500〜2500字

構成:
1. 見出し(選手名+ポジション+所属+一言キャッチ)
2. プロフィール表(生年月日/年齢、国籍、身長、ポジション、利き足、所属クラブ、市場価値)
3. 発掘の経緯・注目された理由
4. プレースタイル解説
5. 直近の実績・出場状況(今回の初出場/トップチーム合流の経緯を含める)
6. 移籍市場での評判・今後の見通し
7. 出典明記(参照した情報源をクレジット)

注意点:
- 事実と推測を混同しない。データの裏付けがない評価は「〜との見方もある」等の表現に留める
- Transfermarkt等の二次情報源は出典を明記する
- 過度な誇張(「次のメッシ」等の煽り文句)は避ける
`;

async function apiFootballFetch(path, params) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API-Football error: ${res.status}`);
  return res.json();
}

// season指定が必須の /players ではなく、season非依存の /players/profiles を使う。
export async function getPlayerProfile(playerId) {
  const data = await apiFootballFetch('/players/profiles', { player: playerId });
  return data.response?.[0] || null;
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

// 検知情報+API-Footballプロフィールをもとに、AIへ記事下書きを生成させる。
export async function generateArticleDraft(detectedPlayer, profile) {
  const prompt = `
あなたはサッカーメディア「AM4」の記者です。以下の選手について、指定フォーマットに沿った
選手紹介記事の下書きを日本語で書いてください。

## 記事フォーマット
${ARTICLE_FORMAT_SPEC}

## 今回のきっかけ(検知情報)
- 選手名: ${detectedPlayer.name}
- 所属クラブ: ${detectedPlayer.club}
- 年齢: ${detectedPlayer.age}
- 出場した試合: ${detectedPlayer.fixtureDate} vs ${detectedPlayer.opponent} (${detectedPlayer.competition})

## API-Footballプロフィール情報(参考・不足があれば補わずその旨明記)
${JSON.stringify(profile, null, 2)}

## 指示
- Web検索ツールを使い、Transfermarktや移籍・育成専門メディアの情報を検索して裏付けを取り、
  出典をURL付きで明記すること。
- 情報が不足している項目は無理に埋めず「詳細は今後の情報を待ちたい」等、正直に書くこと。
- 文字数は1500〜2500字を目安にすること。
`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const draft = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
  const searchSources = extractSearchSources(data.content);

  return { draft, searchSources };
}

export async function loadDraftLog() {
  try {
    const result = await get(DRAFTS_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('draft log load error:', err.message);
    return [];
  }
}

// 生成済みの下書きエントリを、新しい順の配列としてVercel Blobに保存する。
export async function saveDraft(entry) {
  const log = await loadDraftLog();
  log.unshift(entry);
  try {
    await put(DRAFTS_PATHNAME, JSON.stringify(log), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('draft log save error:', err.message);
  }
}
