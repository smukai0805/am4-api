// api/generate-academy-player-article.js
//
// academy-debut-watch.js が検知した「下部組織選手の初出場/合流」情報を受け取り、
// 選手紹介記事(である調・1500〜2500字・7段構成)をAIで生成する。
//
// 【設計メモ】
// - generateArticleDraft() / saveDraft() は academy-debut-watch.js からも直接importして
//   使う(Cronでの自動検知→自動生成の一連の流れを1つの関数実行内で完結させるため)。
//   このファイル自体のdefault handlerは、特定選手を手動で(再)生成したい場合の
//   動作確認・単体テスト用エンドポイントという位置づけ。
// - Web検索: Anthropic APIのサーバーサイドツール web_search_20260209 を使用。
//   Transfermarkt・移籍/育成専門メディアの情報をAIが自律的に検索して裏付けを取る。
//   claude-sonnet-5はこのツールバージョンに対応している。
// - Sonnet系モデルはデフォルトでadaptive thinkingが有効で、レスポンスのcontent配列の
//   先頭がthinkingブロック(text無し)になることがある(このリポジトリのfeature.jsで
//   実際に踏んだ既知の挙動)。そのため content[0] を決め打ちせず、type:"text" の
//   ブロックだけを抽出・連結する。Web検索を挟むと複数回に分けてtextが生成されることも
//   あるため、全てのtextブロックを結合する。
// - 生成した下書きの保存先: Vercel Blob(このリポジトリのai-column.jsのコラムアーカイブと
//   同じ方式・同じプライベートストアを使用)。1つのJSONファイル(配列)に新しい順で
//   追記していく簡易ログ。専用の確認UIは無いため、GET ?list=1 で一覧を返せるようにしてある。
//
// 環境変数: API_FOOTBALL_KEY, ANTHROPIC_API_KEY が必要。

import crypto from 'node:crypto';
import { put, get } from '@vercel/blob';

export const config = { maxDuration: 60 };

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
// player-stats.jsの写真取得と同じエンドポイントで、現行の無料プラン(2022〜2024
// シーズンのみ対応)の season 制約を受けずに基礎プロフィールを取得できる。
export async function getPlayerProfile(playerId) {
  const data = await apiFootballFetch('/players/profiles', { player: playerId });
  return data.response?.[0] || null;
}

// web_search_tool_result ブロックから検索でヒットしたURLを抜き出す。
// 記事本文中の出典明記(フォーマット仕様の7)とは別に、生成ログ側でも参照元を
// 追跡できるようにしておくための補助情報。
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
// academy-debut-watch.js からも直接呼び出す共通関数。
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
      // 記事本文(最大2500字≒2000トークン程度)に加え、Web検索の結果取り込みや
      // デフォルトで有効なadaptive thinkingの分も余裕を見て確保する。
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

async function loadDraftLog() {
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
// 専用のレビューUIは無いので、ひとまず後から ?list=1 で見返せる簡易ログとしている。
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 保存済み下書き一覧の確認用(簡易レビュー): GET /api/generate-academy-player-article?list=1
  if (req.method === 'GET' && req.query.list === '1') {
    const log = await loadDraftLog();
    return res.status(200).json({ drafts: log });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only(一覧確認は GET ?list=1)' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  try {
    const detectedPlayer = req.body;
    if (!detectedPlayer?.playerId) {
      return res.status(400).json({ error: 'playerId is required' });
    }

    const profile = await getPlayerProfile(detectedPlayer.playerId);
    const { draft, searchSources } = await generateArticleDraft(detectedPlayer, profile);

    const entry = {
      id: crypto.randomUUID(),
      player: detectedPlayer,
      draft,
      searchSources,
      status: 'draft_generated', // 公開前レビュー待ち
      generatedAt: new Date().toISOString(),
    };
    await saveDraft(entry);

    res.status(200).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
