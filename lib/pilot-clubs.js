// lib/pilot-clubs.js
//
// academy-debut-watch.js(選手紹介記事)・match-report-watch.js(試合解説記事)の
// 両パイプラインで検知対象とするクラブの一覧。以前は両ファイルに同じ配列が重複して
// 定義されていたため、この共有定義に一本化した(クラブを追加する際はここだけ変更すればよい)。
//
// team_idはAPI-Footballの実IDで、api/player-stats.js の TEAM_IDS 対応表と一致することを
// 確認済み(2026-07時点)。Tottenham/Newcastle United/Napoliは対応表に無かったため、
// API-Football の /teams?search= で実際に検索して実IDを確認した上で追加した
// (手元で推測した値は使っていない)。

export const PILOT_CLUBS = [
  { name: 'Manchester United', teamId: 33 },
  { name: 'Barcelona', teamId: 529 },
  { name: 'Real Madrid', teamId: 541 },
  { name: 'Bayern Munich', teamId: 157 },
  { name: 'Juventus', teamId: 496 },
  { name: 'Paris Saint Germain', teamId: 85 },
  { name: 'Manchester City', teamId: 50 },
  { name: 'Liverpool', teamId: 40 },
  { name: 'Chelsea', teamId: 49 },
  { name: 'Arsenal', teamId: 42 },
  { name: 'Tottenham', teamId: 47 },
  { name: 'Newcastle United', teamId: 34 },
  { name: 'AC Milan', teamId: 489 },
  { name: 'Inter Milan', teamId: 505 },
  { name: 'Napoli', teamId: 492 },
];
