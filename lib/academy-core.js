// lib/academy-core.js
//
// api/generate-academy-player-article.js から移設した共有ロジック。
// Vercel Hobbyプランのサーバーレス関数数上限(1デプロイ12個まで)を超えないよう、
// api/配下ではなくlib/配下に置くことで関数としてカウントされないようにしている
// (Vercelはapi/直下のファイルのみを関数としてビルドする)。
//
// academy-debut-watch.js(下部組織選手の初出場検知)と transfer-news-watch.js
// (2026-07-31追加。Here we go移籍速報検知に連動した選手紹介記事生成)の両方から
// importされる。generateArticleDraft()のdetectedPlayer.triggerDescriptionには、
// 検知理由の説明文をトリガーの種類に応じて呼び出し元が組み立てて渡すこと
// (試合出場によるものか、移籍確定によるものかで文言が変わるため汎用化してある)。
//
// 環境変数: API_FOOTBALL_KEY, ANTHROPIC_API_KEY が必要。

import { apiFootballFetch } from './api-football-client.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ARTICLE_FORMAT_SPEC = `
【選手紹介記事フォーマット(AM4)】(この見出し自体は記事本文に含めないこと。実際の記事は下記の指定フォーマット1.見出しから始めること)

文体: である調(専門メディア風)
文字数目安: 1500〜2500字

構成:
1. 見出し(読者の興味を引くキャッチコピー形式にすること。選手の特徴・出身国・
   ポジション・ストーリー性(下部組織出身か、移籍で加入したか等)を反映した、
   読みたくなる見出しにすること。
   ★「[選手名]([所属クラブ])」のような、選手名とクラブ名を機械的に並べただけの
   見出しは絶対に避けること。選手名・クラブ名を見出しに含めなくても構わない
   (本文側で明示されていればよい)。
   良い例:
     「マンチェスターユナイテッドのフランスの神童、覚醒の兆し」
     「レアル・マドリードが仕込む16歳、下部組織の系譜を継ぐ者」
     「移籍市場を騒がせた18歳ストライカー、新天地での船出」
   悪い例(絶対に避ける):
     「L. Yoro(Manchester United)」
     「Kobbie Mainoo選手紹介」)
2. プロフィール表(生年月日/年齢、国籍、身長、ポジション、利き足、所属クラブ、市場価値)
3. 発掘の経緯・注目された理由
4. プレースタイル解説
5. 直近の実績・出場状況(今回の検知理由(初出場/移籍確定等)の経緯を含める)
6. 移籍市場での評判・今後の見通し
7. 出典明記(参照した情報源をクレジット)

注意点:
- 事実と推測を混同しない。データの裏付けがない評価は「〜との見方もある」等の表現に留める
- Transfermarkt等の二次情報源は出典を明記する
- 過度な誇張(「次のメッシ」等の煽り文句)は避ける
`;

// season指定が必須の /players ではなく、season非依存の /players/profiles を使う。
export async function getPlayerProfile(playerId) {
  const data = await apiFootballFetch('/players/profiles', { player: playerId });
  return data.response?.[0] || null;
}

// 選手ID起点(academy-debut-watch.js、既存のラインナップ検知)ではなく、選手名起点
// (transfer-news-watch.js、Here we go連動の記事生成)で選手プロフィールを探す場合に使う。
// 同姓同名等で複数ヒットする可能性があるが、先頭の結果を採用する簡易実装
// (api/player-stats.jsの選手検索と同じ /players/profiles?search= パターン)。
// 見つからない場合はnullを返す(呼び出し元で「選手情報が見つからず生成をスキップ」に使う)。
export async function searchPlayerProfileByName(name) {
  const data = await apiFootballFetch('/players/profiles', { search: name });
  return data.response?.[0] || null;
}

// 生年月日から基準日時点の年齢を計算する(academy-debut-watch.js/
// transfer-news-watch.jsの両方から使う共通ユーティリティ)。
export function calcAge(birthDateStr, onDate) {
  if (!birthDateStr) return null;
  const birth = new Date(birthDateStr);
  const ref = onDate || new Date();
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) {
    age--;
  }
  return age;
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
// Web検索を伴う呼び出しは所要時間のばらつきが非常に大きい(match-report-core.js側の
// 実データ検証で29秒〜258秒超まで変動を確認)。Vercelの実行時間上限(300秒)内に必ず
// write呼び出し分の時間を残すため、timeoutMsで明示的に頭打ちにする(AbortController)。
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

// 【2段階構成にしている理由】match-report-core.jsの実データ検証で、Web検索(最大5往復)
// の結果(生ページ内容)がそのまま入力コンテキストに乗り、入力トークンが20万を超えて
// (a) 本文生成前にmax_tokensへ到達し記事が打ち切られる、(b) max_tokensを増やすと
// 今度は生成時間がVercelの実行時間上限を超える、という問題が判明した。同じ構成の
// ため、ここでも「Web検索で要点だけ収集する軽量な呼び出し(research)」と「収集済みの
// メモから記事本文を書く呼び出し(write、Web検索なし=高速)」に分割している。
export async function generateArticleDraft(detectedPlayer, profile) {
  const researchPrompt = `
以下のサッカー選手について、Web検索を使い、Transfermarktや移籍・育成専門メディアの情報
(発掘の経緯、プレースタイル評、移籍市場での評判など)を日本語の箇条書きで簡潔に
まとめてください。深追いはせず、要点(5〜8項目、各項目1〜2行)のみでよいです。
各項目に出典URLを付記してください。

- 選手名: ${detectedPlayer.name}
- 所属クラブ: ${detectedPlayer.club}
- 年齢: ${detectedPlayer.age ?? '不明'}
`;
  // research呼び出しは補足情報にすぎず、無くてもwrite側のプロンプトが
  // 「プロフィール情報のみで記述すること」に自動でフォールバックするため、
  // タイムアウト/失敗時はここで握りつぶし、記事生成自体は続行する。
  let researchNotes = '';
  let searchSources = [];
  try {
    const researchData = await callAnthropic({
      maxTokens: 3000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
      prompt: researchPrompt,
      label: 'research',
      timeoutMs: 150000,
    });
    researchNotes = (researchData.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
    searchSources = extractSearchSources(researchData.content);
  } catch (err) {
    console.error('research call failed, proceeding without web research notes:', err.message);
  }

  const writePrompt = `
あなたはサッカーメディア「AM4」の記者です。以下の選手について、指定フォーマットに沿った
選手紹介記事の下書きを日本語で書いてください。

## 記事フォーマット
${ARTICLE_FORMAT_SPEC}

## 今回のきっかけ(検知情報)
- 選手名: ${detectedPlayer.name}
- 所属クラブ: ${detectedPlayer.club}
- 年齢: ${detectedPlayer.age ?? '不明'}
- ${detectedPlayer.triggerDescription || `出場した試合: ${detectedPlayer.fixtureDate} vs ${detectedPlayer.opponent} (${detectedPlayer.competition})`}

## API-Footballプロフィール情報(参考・不足があれば補わずその旨明記)
${JSON.stringify(profile, null, 2)}

## 補足取材メモ(Web検索により事前収集済み、出典付き。そのまま参考にしてよい)
${researchNotes || '(取得できた補足情報なし。プロフィール情報のみで記述すること)'}

## 指示
- 上記の補足取材メモの範囲を超える推測・捏造はしないこと。
- 情報が不足している項目は無理に埋めず「詳細は今後の情報を待ちたい」等、正直に書くこと。
- 見出し(1.)は必ず読者の興味を引くキャッチコピー形式にすること。「${detectedPlayer.name}(${detectedPlayer.club})」のような選手名・クラブ名だけの機械的な見出しは絶対に使わないこと。詳しい要件はフォーマット仕様の1.を参照。
- 選手名は必ず英語表記(アルファベット)で統一すること。カタカナ変換はしないこと
  (例: 「コビー・マイヌー」ではなく「Kobbie Mainoo」)。クラブ名は日本語表記のままでよい。
- 文字数は1500〜2500字の範囲に必ず収めること(プロフィール表のデータ列挙は文字数
  カウントから除く、本文の地の文で厳守すること)。超過する場合は各セクションを簡潔にし、
  不足する場合はプレースタイル解説・今後の見通しの記述を厚くして調整すること。
`;
  const writeData = await callAnthropic({
    maxTokens: 5000,
    tools: null,
    prompt: writePrompt,
    label: 'write',
    timeoutMs: 120000,
  });
  const draft = (writeData.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');

  return { draft, searchSources };
}

// 【2026-07-31】「下書きログに追記」方式(旧loadDraftLog/saveDraft)は、記事ごとの
// 恒久的なレコード保存(lib/article-store.js)に置き換えた。一覧・個別取得は
// article-store.js の listArticles()/getArticle() を使うこと。
