const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = {
  fixtureId: 1550125,
  kickoff: '2026-09-15T18:45:00Z',
  leagueName: 'セリエA',
  round: 'Regular Season - 4',
  home: { id: 489, name: 'ミラン', logo: 'https://images.test/milan.png' },
  away: { id: 492, name: 'ナポリ', logo: 'https://images.test/napoli.png' },
  status: { label: '終了', complete: true },
  score: { home: 2, away: 1 },
  editorials: ['prediction'],
};

test('team SSR has an independent canonical page and keeps score controls out of match links', async () => {
  const { renderTeamPage } = await import('../lib/team-player-page-html.js');
  const page = renderTeamPage({
    team: { id: 489, name: 'ミラン', englishName: 'AC Milan', logo: 'https://images.test/milan.png' },
    competitions: [{ leagueId: 135, leagueName: 'セリエA', leagueType: 'League', country: 'Italy', season: 2026, current: true }],
    competitionState: 'ready',
    currentCompetition: { leagueId: 135, leagueName: 'セリエA', season: 2026 },
    selection: { leagueId: 135, leagueName: 'セリエA', season: 2026 },
    tab: 'fixtures',
    columns: { state: 'ready', items: [] },
    section: { state: 'ready', upcoming: [], recent: [fixture], unscheduled: [] },
  }, { requestPath: '/?date=2026-09-15#fixtures' });

  assert.match(page, /<link rel="canonical" href="https:\/\/am4football\.com\/teams\/489">/);
  assert.match(page, /<h1>ミラン<\/h1>/);
  assert.match(page, /現在の所属リーグ: セリエA/);
  assert.match(page, /表示対象: セリエA 2026\/27/);
  assert.match(page, /href="\/teams\/492\?return=/);
  assert.match(page, /href="\/match\.html\?id=1550125"/);
  assert.match(page, /data-score-control/);
  assert.doesNotMatch(page, /data-entity-tab="columns"/);
  assert.match(page, /<a class="entity-fixture-main-link"[^>]*><\/a>/);
});

test('a COLUMN fetch error preserves the local tab instead of falsely looking empty', async () => {
  const { renderTeamPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderTeamPageFragments({
    team: { id: 489, name: 'ミラン' },
    competitions: [],
    competitionState: 'ready',
    selection: null,
    tab: 'columns',
    columns: { state: 'error', items: [] },
    section: { state: 'error', message: '一時的なエラーです。' },
  }, { teamId: 489, requestPath: '/teams/489?tab=columns' });

  assert.match(fragments.tabsHtml, /data-entity-tab="columns"/);
  assert.match(fragments.contentHtml, /data-entity-retry/);
  assert.doesNotMatch(fragments.contentHtml, /公開済みの関連COLUMNはありません/);
});

test('team SSR keeps its selected league and season in nested club return links', async () => {
  const { renderTeamPage } = await import('../lib/team-player-page-html.js');
  const page = renderTeamPage({
    team: { id: 33, name: 'マンチェスター・ユナイテッド' },
    competitions: [],
    competitionState: 'ready',
    currentCompetition: null,
    selection: { leagueId: 39, leagueName: 'Premier League', season: 2026 },
    tab: 'standings',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready',
      groups: [{ rows: [{ rank: 1, teamId: 42, name: 'アーセナル', played: 4, wins: 4, draws: 0, losses: 0, goalsDiff: 7, points: 12, highlighted: false }] }],
    },
  });

  assert.match(page, /href="\/teams\/42\?return=%2Fteams%2F33%3Ftab%3Dstandings%26league%3D39%26season%3D2026">アーセナル<\/a>/);
});

test('a ranking entry is one full-width player link when it has a verified player ID', async () => {
  const { renderTeamPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderTeamPageFragments({
    team: { id: 33, name: 'マンチェスター・ユナイテッド' },
    competitions: [],
    competitionState: 'ready',
    selection: { leagueId: 39, leagueName: 'Premier League', season: 2026 },
    tab: 'rankings',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', scope: '選択した大会・シーズンにおける、このクラブの選手記録です。',
      rankings: {
        goals: [{ playerId: 1485, rank: 1, name: 'Bruno Fernandes', photo: 'https://images.test/1485.png', value: 3 }],
        assists: [], minutes: [], yellow: [], red: [],
      },
    },
  }, { teamId: 33, requestPath: '/teams/33?tab=rankings&league=39&season=2026' });

  assert.match(fragments.contentHtml, /<li><a href="\/players\/1485\?return=[^"]+" class="entity-ranking-player-link"><b>1<\/b><span class="entity-ranking-player-identity">[\s\S]*?<strong>3<\/strong><\/a><\/li>/);
});

test('a roster puts the shirt number beside the portrait and labels every statistic with a non-emoji icon', async () => {
  const { renderTeamPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderTeamPageFragments({
    team: { id: 33, name: 'マンチェスター・ユナイテッド' },
    competitions: [], competitionState: 'ready', selection: null, tab: 'roster',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', scope: '現在の所属選手。',
      players: [{ playerId: 162511, position: 'GK', name: 'S. Lammens', photo: 'https://images.test/162511.png', nationality: 'ベルギー', number: 1, appearances: 3, goals: 0, assists: 0, yellow: 1, red: 0 }],
    },
  }, { teamId: 33, requestPath: '/teams/33?tab=roster' });

  assert.match(fragments.contentHtml, /entity-roster-columns[^>]*>[\s\S]*?entity-stat-icon--appearance[\s\S]*?entity-stat-icon--goal[\s\S]*?entity-stat-icon--assist[\s\S]*?entity-stat-icon--yellow[\s\S]*?entity-stat-icon--red/);
  assert.match(fragments.contentHtml, /<article class="entity-roster-row"><a href="\/players\/162511\?return=[^"]+" class="entity-roster-row-link">[\s\S]*?entity-roster-photo[\s\S]*?entity-shirt" aria-label="背番号 1">1<\/span>[\s\S]*?S\. Lammens[\s\S]*?<dd>3<\/dd>[\s\S]*?<dd>1<\/dd>[\s\S]*?<\/a><\/article>/);
  assert.doesNotMatch(fragments.contentHtml, /⚽|🟨|🟥/);
  assert.doesNotMatch(fragments.contentHtml, /role="(?:row|columnheader)"/);
});

test('team standings reuse the match standings rows, zones, and verified club links', async () => {
  const { renderTeamPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderTeamPageFragments({
    team: { id: 33, name: 'マンチェスター・ユナイテッド' },
    competitions: [],
    competitionState: 'ready',
    selection: { leagueId: 39, leagueName: 'Premier League', season: 2026 },
    tab: 'standings',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready',
      qualificationLegend: ['champions_league'],
      groups: [{
        label: 'Premier League',
        rows: [{
          rank: 4, teamId: 33, name: 'マンチェスター・ユナイテッド', logo: 'https://images.test/33.png',
          played: 4, wins: 2, draws: 2, losses: 0, goalsDiff: 3, points: 8,
          zone: 'champions_league', highlighted: true,
        }],
      }],
    },
  }, { teamId: 33, requestPath: '/teams/33?tab=standings&league=39&season=2026' });

  assert.match(fragments.contentHtml, /class="match-standings-table" role="table"/);
  assert.match(fragments.contentHtml, /class="match-standing-row match-standing-row--head"/);
  assert.match(fragments.contentHtml, /class="match-standing-row match-standing-row--zone-champions_league match-standing-row--fixture-team"/);
  const returnValue = '%2Fteams%2F33%3Ftab%3Dstandings%26league%3D39%26season%3D2026';
  assert.match(fragments.contentHtml, new RegExp(`href="\\/teams\\/33\\?return=${returnValue}" class="match-standing-team-link"`));
  assert.match(fragments.contentHtml, new RegExp(`href="\\/teams\\/33\\?return=${returnValue}">マンチェスター・ユナイテッド<\\/a>`));
  assert.match(fragments.contentHtml, /match-standing-legend-item--champions_league/);
  assert.doesNotMatch(fragments.contentHtml, /class="entity-table"/);
});

test('player SSR uses a semantic profile list and keeps each career row visible with a separate team link', async () => {
  const { renderPlayerPage } = await import('../lib/team-player-page-html.js');
  const page = renderPlayerPage({
    player: {
      id: 44, name: 'ルカ・モドリッチ', firstname: 'Luka', lastname: 'Modric', photo: 'https://images.test/44.png',
      nationality: 'クロアチア', age: 40, birth: { date: '1985-09-09' }, position: 'MF', number: 14,
      currentTeam: { id: 489, name: 'ミラン', logo: 'https://images.test/milan.png' },
    },
    history: [{ season: 2026, teamId: 489, teamName: 'ミラン' }],
    tab: 'career',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', nextCursor: null,
      rows: [{
        season: 2026, teamId: 489, teamName: 'ミラン', teamLogo: 'https://images.test/milan.png',
        appearances: 4, minutes: 233, goals: 0, assists: 0,
        competitions: [{ leagueName: 'セリエA', appearances: 4, minutes: 233, goals: 0, assists: 0 }],
      }],
    },
  });

  assert.match(page, /<link rel="canonical" href="https:\/\/am4football\.com\/players\/44">/);
  assert.match(page, /<dl class="entity-profile-grid"/);
  assert.match(page, /href="\/teams\/489/);
  assert.match(page, /class="entity-career-row"/);
  assert.match(page, /class="entity-career-team-link"/);
  assert.doesNotMatch(page, /<(?:details|summary)\b/);
});

test('player stats renders one set of filters so either selector changes the selected data', async () => {
  const { renderPlayerPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderPlayerPageFragments({
    player: { id: 44, name: 'ルカ・モドリッチ' },
    history: [{ season: 2026 }],
    tab: 'stats',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', season: 2026, selectedLeagueId: 'all',
      leagues: [{ leagueId: 135, leagueName: 'セリエA' }],
      summary: {
        appearances: 4, starts: 2, minutes: 233, goals: 0, assists: 1,
        shots: 6, shotsOnTarget: 2, keyPasses: 5, passes: 126,
        tackles: 3, interceptions: 2, duelsWon: 7, dribblesCompleted: 3,
        foulsDrawn: 1, foulsCommitted: 2, yellow: 0, red: 0,
      },
    },
  }, { playerId: 44 });

  assert.equal((fragments.contentHtml.match(/data-player-league/g) || []).length, 1);
  assert.equal((fragments.contentHtml.match(/data-player-season/g) || []).length, 1);
  assert.match(fragments.contentHtml, /詳しいスタッツ/);
  assert.match(fragments.contentHtml, /キーパス/);
  assert.doesNotMatch(fragments.contentHtml, /確認済みクラブ別内訳/);
});

test('career keeps each season visible with a linked club and four aligned metrics', async () => {
  const { renderPlayerPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderPlayerPageFragments({
    player: { id: 162511, name: 'S. Lammens' }, history: [], tab: 'career',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', nextCursor: null,
      rows: [
        {
          season: 2025, teamId: 33, teamName: 'マンチェスター・ユナイテッド', teamLogo: 'https://images.test/33.png',
          appearances: 33, minutes: 2970, goals: 0, assists: 0,
          competitions: [{ leagueName: 'Premier League', appearances: 33, minutes: 2970, goals: 0, assists: 0 }],
        },
        {
          season: 2024, teamId: 42, teamName: 'アーセナル', teamLogo: 'https://images.test/42.png',
          appearances: 31, minutes: 2413, goals: 3, assists: 1,
          competitions: [{ leagueName: 'Premier League', appearances: 31, minutes: 2413, goals: 3, assists: 1 }],
        },
      ],
    },
  }, { playerId: 162511, requestPath: '/players/162511?tab=career' });

  assert.match(fragments.contentHtml, /class="entity-career-columns"[^>]*><span>SEASON<\/span><span>CLUB<\/span><span>出場<\/span><span>時間<\/span><span>得点<\/span><span>A<\/span>/);
  assert.match(fragments.contentHtml, /<article class="entity-career-row">[\s\S]*?2025\/26[\s\S]*?href="\/teams\/33\?return=[^"]+" class="entity-career-team-link"[\s\S]*?マンチェスター・ユナイテッド[\s\S]*?<\/article>[\s\S]*?<article class="entity-career-row">[\s\S]*?2024\/25[\s\S]*?アーセナル/);
  assert.match(fragments.contentHtml, /class="entity-career-value" aria-label="出場">33<\/span><span class="entity-career-value" aria-label="出場時間">2970<\/span>/);
  assert.doesNotMatch(fragments.contentHtml, /<(?:details|summary)\b/);
});

test('a career slice exposes the next records automatically without a more button', async () => {
  const { renderPlayerPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderPlayerPageFragments({
    player: { id: 162511, name: 'S. Lammens' }, history: [], tab: 'career',
    columns: { state: 'ready', items: [] },
    section: {
      state: 'ready', rows: [], nextCursor: 4,
      message: 'この期間のクラブ記録はありません。',
    },
  }, { playerId: 162511, requestPath: '/players/162511?tab=career' });

  assert.match(fragments.contentHtml, /class="entity-career-progress" data-career-next-cursor="4"/);
  assert.doesNotMatch(fragments.contentHtml, /さらに過去を見る|data-career-cursor=/);
});

test('a final empty career slice adds neither a fake row nor a redundant empty message', async () => {
  const { renderPlayerPageFragments } = await import('../lib/team-player-page-html.js');
  const fragments = renderPlayerPageFragments({
    player: { id: 162511, name: 'S. Lammens' }, history: [], tab: 'career',
    columns: { state: 'ready', items: [] },
    section: { state: 'ready', rows: [], nextCursor: null, message: 'この期間のクラブ記録はありません。' },
  }, { playerId: 162511, requestPath: '/players/162511?tab=career' });

  assert.doesNotMatch(fragments.contentHtml, /class="entity-career-empty"|entity-career-progress|data-career-cursor=/);
});

test('player SSR uses its fallback without inventing a photo when none is provided', async () => {
  const { renderPlayerPage } = await import('../lib/team-player-page-html.js');
  const page = renderPlayerPage({
    player: { id: 999, name: '写真未提供の選手', photo: null, birth: {} },
    history: [],
    tab: 'stats',
    columns: { state: 'ready', items: [] },
    section: { state: 'empty', season: 2026, leagues: [], selectedLeagueId: 'all', message: '記録なし' },
  });

  assert.match(page, /entity-image--player/);
  assert.match(page, /entity-image-fallback/);
  assert.doesNotMatch(page, /players\/999\.png/);
});
