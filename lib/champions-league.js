// lib/champions-league.js
//
// UEFA Champions League(API-FootballのリーグID=2。実データ検証で確認済み。
// 女子版・地域版など類似名の大会が多数あるため、推測ではなく/leagues?search=で
// 実際に検索して特定した)を「大会単位」で検知するための共有ヘルパー。
// PILOT_CLUBS(15クラブ)によるクラブ単位の検知とは別経路で、対象クラブに
// 関係なく全試合を取得する(match-report-watch.js・academy-debut-watch.jsの
// 両方から使う)。同じ試合がクラブ単位の経路でも検知された場合の重複排除は、
// 呼び出し側(fixture.id、または(fixture.id, teamId)単位)で行う。
//
// 【season値について】実データ検証(2026-07-31)で league=2 season=2026 は
// 2026-27シーズンの予選ラウンド(1st〜3rd Qualifying Round、2026年7月〜8月分)を
// 返した。これはシーズン開幕直後でリーグフェーズ以降がまだ組まれていないための
// 状態であり、season自体は正しい(API-Football は1シーズンを通して同じ年で
// 呼ぶ規約のため、この後リーグフェーズ・決勝トーナムが追加されても season=2026
// のまま拾える)。既存ファイルと同じ「7月以降はその年」のcurrentSeasonYear()を
// そのまま使えばよく、特別なシーズン切り替えロジックは不要。
//
// 返り値は未フィルタのfixtures配列(FINISHED等のstatus絞り込みや、
// 既に検知済みかの判定は呼び出し側の流儀に合わせて行う)。

import { apiFootballFetch } from './api-football-client.js';

export const CHAMPIONS_LEAGUE_ID = 2;

function currentSeasonYear(date = new Date()) {
  const month = date.getMonth();
  return month >= 6 ? date.getFullYear() : date.getFullYear() - 1;
}

export async function getChampionsLeagueFixtures(lookbackDays) {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);

  const data = await apiFootballFetch('/fixtures', {
    league: CHAMPIONS_LEAGUE_ID,
    season: currentSeasonYear(to),
    from: fmt(from),
    to: fmt(to),
  });
  const errors = data.errors && Object.keys(data.errors).length > 0 ? data.errors : null;
  if (errors) console.error('API-Football /fixtures(Champions League) errors:', errors);

  return { fixtures: data.response || [], errors, resultsCount: data.results };
}
