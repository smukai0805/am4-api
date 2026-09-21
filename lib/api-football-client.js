// Shared provider entry point. Persistent snapshots, conditional refresh leases
// and a daily request budget are implemented in football-provider-runtime.js.
// No article parsing, player selection or Notion writes belong in this layer.

import { cachedFootballFetch } from './football-provider-runtime.js';

// All readers share durable successful responses and a provider-wide budget.
// Retries and concurrent cache misses must not multiply paid requests.
export const apiFootballFetch = cachedFootballFetch;

// 2026-08-04: 略称での検索が、公式名に略称が含まれない全く無関係の弱小クラブに
// 誤ヒットすることを実データで確認した(例: "PSG"で検索すると、フランスのパリ・
// サンジェルマン(公式名"Paris Saint Germain"には"PSG"という文字列が含まれない)
// ではなく、インドネシアの"PSGC Ciamis"がヒットしてしまい、急上昇選手ランキングの
// サムネイルに誤ったクラブロゴが表示される不具合につながった)。AIが移籍速報生成時に
// この種の一般的な略称を使うことがあるため、既知の主要な略称は検索前に正式名へ
// 変換しておく。
const TEAM_NAME_ALIASES = {
  'psg': 'Paris Saint Germain',
  'man utd': 'Manchester United',
  'man united': 'Manchester United',
  'man city': 'Manchester City',
  'barca': 'Barcelona',
  'atletico': 'Atletico Madrid',
  'atleti': 'Atletico Madrid',
  'inter': 'Inter Milan',
  'bayern': 'Bayern Munich',
  'juve': 'Juventus',
};

// クラブ名(英語表記)からAPI-FootballのチームIDを検索する(2026-08-04追加、
// 移籍元/移籍先クラブのロゴ表示などに使う)。
// 同名の下部組織・女子チーム等が複数ヒットする可能性があるが、先頭の結果(実データで
// 確認した限り、主要クラブが常に最初に返る)を採用する簡易実装。見つからない場合はnullを返す。
export async function searchTeamIdByName(name) {
  const alias = TEAM_NAME_ALIASES[name.trim().toLowerCase()];
  const data = await apiFootballFetch('/teams', { search: alias || name });
  return data.response?.[0]?.team?.id ?? null;
}

// items を limit 件ずつのバッチに分けて順に処理する(バッチ内は並列)。
// スロットリングにより実際のリクエスト送出はどのみち直列化されるが、
// 同時に開くコネクション数を抑える目的でバッチ分割も併用している。
export async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
