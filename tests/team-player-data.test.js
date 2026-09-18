const test = require('node:test');
const assert = require('node:assert/strict');

test('keeps provider IDs numeric and rejects an ambiguous route value', async () => {
  const { positiveId } = await import('../lib/team-player-data.js');

  assert.equal(positiveId('489'), 489);
  assert.equal(positiveId(489), 489);
  assert.equal(positiveId('489.5'), null);
  assert.equal(positiveId('0'), null);
  assert.equal(positiveId('milan'), null);
});

test('uses a current domestic league for the header without turning an old selection into current affiliation', async () => {
  const { currentTeamCompetition } = await import('../lib/team-player-data.js');
  const result = currentTeamCompetition([
    { leagueId: 2, leagueName: 'Champions League', leagueType: 'Cup', country: 'World', season: 2026, current: true },
    { leagueId: 135, leagueName: 'Serie A', leagueType: 'League', country: 'Italy', season: 2026, current: true },
    { leagueId: 135, leagueName: 'Serie A', leagueType: 'League', country: 'Italy', season: 2024, current: false },
  ]);

  assert.equal(result.leagueId, 135);
  assert.equal(result.season, 2026);
});

test('uses only a selected club and competition for squad statistics', async () => {
  const { normalizeTeamPlayerStatistics } = await import('../lib/team-player-data.js');
  const records = normalizeTeamPlayerStatistics({
    response: [
      {
        player: { id: 44, name: 'A. Rossonero', photo: 'https://images.test/44.png' },
        statistics: [
          {
            team: { id: 489, name: 'AC Milan', logo: 'https://images.test/milan.png' },
            league: { id: 135, name: 'Serie A' },
            games: { appearances: 4, lineups: 2, minutes: 180 },
            goals: { total: 1, assists: 0 },
            cards: { yellow: 0, red: 1 },
          },
          {
            team: { id: 50, name: 'Manchester City' },
            league: { id: 135, name: 'Serie A' },
            games: { appearances: 8, lineups: 8, minutes: 720 },
            goals: { total: 9, assists: 2 },
            cards: { yellow: 2, red: 0 },
          },
        ],
      },
      {
        player: { id: 45, name: 'B. Missing' },
        statistics: [{
          team: { id: 489, name: 'AC Milan' },
          league: { id: 2, name: 'Champions League' },
          games: { appearances: 3 },
          goals: { total: 2 },
          cards: {},
        }],
      },
    ],
  }, { teamId: 489, leagueId: 135 });

  assert.deepEqual(records, [{
    playerId: 44,
    name: 'A. Rossonero',
    photo: 'https://images.test/44.png',
    teamId: 489,
    teamName: 'ミラン',
    teamEnglishName: 'AC Milan',
    teamLogo: 'https://images.test/milan.png',
    teamNational: false,
    teamNationalVerified: false,
    leagueId: 135,
    leagueName: 'Serie A',
    season: null,
    appearances: 4,
    starts: 2,
    minutes: 180,
    goals: 1,
    assists: 0,
    shots: null,
    shotsOnTarget: null,
    keyPasses: null,
    passes: null,
    tackles: null,
    interceptions: null,
    duelsWon: null,
    dribblesCompleted: null,
    foulsDrawn: null,
    foulsCommitted: null,
    yellow: 0,
    red: 1,
  }]);
});

test('keeps detailed current-season player statistics separate from missing values', async () => {
  const { buildPlayerStatsSummary } = await import('../lib/team-player-data.js');
  const summary = buildPlayerStatsSummary([
    {
      appearances: 4, starts: 3, minutes: 270, goals: 2, assists: 1,
      shots: 8, shotsOnTarget: 5, keyPasses: 7, passes: 164,
      tackles: 4, interceptions: 2, duelsWon: 11, dribblesCompleted: 6,
      foulsDrawn: 3, foulsCommitted: 1, yellow: 0, red: 0,
    },
    {
      appearances: 2, starts: 1, minutes: 80, goals: 0, assists: 1,
      shots: 3, shotsOnTarget: 1, keyPasses: 4, passes: 61,
      tackles: 1, interceptions: 1, duelsWon: 4, dribblesCompleted: 2,
      foulsDrawn: 1, foulsCommitted: 2, yellow: 1, red: 0,
    },
  ]);

  assert.deepEqual(summary, {
    appearances: 6, starts: 4, minutes: 350, goals: 2, assists: 2,
    shots: 11, shotsOnTarget: 6, keyPasses: 11, passes: 225,
    tackles: 5, interceptions: 3, duelsWon: 15, dribblesCompleted: 8,
    foulsDrawn: 4, foulsCommitted: 3, yellow: 1, red: 0,
  });
  assert.equal(buildPlayerStatsSummary([{ appearances: 1, shots: null }]).shots, null);
});

test('does not invent top-player rows and keeps equal values tied', async () => {
  const { buildTopPlayerRankings } = await import('../lib/team-player-data.js');
  const rankings = buildTopPlayerRankings([
    { playerId: 1, name: 'One', goals: 2, assists: 1, minutes: 90, yellow: 0, red: 0 },
    { playerId: 2, name: 'Two', goals: 2, assists: 0, minutes: 180, yellow: 1, red: 0 },
    { playerId: 3, name: 'Three', goals: 0, assists: 0, minutes: 0, yellow: 0, red: 0 },
  ]);

  assert.deepEqual(rankings.goals.map((row) => [row.playerId, row.value, row.rank]), [[1, 2, 1], [2, 2, 1]]);
  assert.deepEqual(rankings.minutes.map((row) => [row.playerId, row.value, row.rank]), [[2, 180, 1], [1, 90, 2]]);
  assert.deepEqual(rankings.red.map((row) => [row.playerId, row.value, row.rank]), []);
});

test('does not turn unknown or cancelled fixtures into a scoreline', async () => {
  const { normalizeTeamFixture } = await import('../lib/team-player-data.js');
  const unknown = normalizeTeamFixture({
    fixture: { id: 100, date: null, status: { short: 'TBD', long: 'Time To Be Defined' } },
    league: { id: 135, name: 'Serie A', season: 2026 },
    teams: { home: { id: 489, name: 'AC Milan' }, away: { id: 492, name: 'Napoli' } },
    goals: { home: null, away: null },
  });
  const cancelled = normalizeTeamFixture({
    fixture: { id: 101, date: '2026-10-01T18:45:00+00:00', status: { short: 'CANC', long: 'Cancelled' } },
    league: { id: 135, name: 'Serie A', season: 2026 },
    teams: { home: { id: 489, name: 'AC Milan' }, away: { id: 492, name: 'Napoli' } },
    goals: { home: null, away: null },
  });

  assert.equal(unknown.kickoff, null);
  assert.equal(unknown.score.home, null);
  assert.equal(unknown.status.kind, 'unscheduled');
  assert.equal(cancelled.score.away, null);
  assert.equal(cancelled.status.kind, 'cancelled');
});

test('preserves provider qualification metadata for the shared standings presentation', async () => {
  const { normalizeStandingGroups } = await import('../lib/team-player-data.js');
  const groups = normalizeStandingGroups({
    response: [{
      league: {
        standings: [[{
          rank: 4,
          team: { id: 33, name: 'Manchester United', logo: 'https://images.test/33.png' },
          all: { played: 4, win: 2, draw: 2, lose: 0 },
          goalsDiff: 3,
          points: 8,
          description: 'Champions League',
          status: 'same',
        }]],
      },
    }],
  }, { teamId: 33, competition: 'Premier League', season: 2026 });

  assert.deepEqual(groups[0].rows[0], {
    rank: 4,
    teamId: 33,
    name: 'マンチェスター・ユナイテッド',
    logo: 'https://images.test/33.png',
    played: 4,
    wins: 2,
    draws: 2,
    losses: 0,
    goalsDiff: 3,
    points: 8,
    description: 'Champions League',
    status: 'same',
    zone: 'champions_league',
    zoneSource: 'provider',
    highlighted: true,
  });

  const noQualification = normalizeStandingGroups({
    response: [{
      league: {
        standings: [[{
          rank: 1,
          team: { id: 34, name: 'No Description' },
          all: { played: 1, win: 1, draw: 0, lose: 0 },
          goalsDiff: 1,
          points: 3,
        }]],
      },
    }],
  }, { teamId: 33, competition: 'Premier League', season: 2026 });
  assert.equal(noQualification[0].rows[0].zone, null);
  assert.equal(noQualification[0].rows[0].zoneSource, null);
});

test('keeps a same-season transfer as separate club and competition records', async () => {
  const { buildPlayerCareerRows } = await import('../lib/team-player-data.js');
  const rows = buildPlayerCareerRows([
    { playerId: 10, season: 2025, teamId: 489, teamName: 'AC Milan', leagueId: 135, leagueName: 'Serie A', appearances: 12, minutes: 900, goals: 4, assists: 2 },
    { playerId: 10, season: 2025, teamId: 541, teamName: 'Real Madrid', leagueId: 140, leagueName: 'La Liga', appearances: 8, minutes: 500, goals: 1, assists: 1 },
    { playerId: 10, season: 2025, teamId: 489, teamName: 'AC Milan', leagueId: 2, leagueName: 'Champions League', appearances: 4, minutes: 280, goals: 1, assists: 0 },
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.teamId, row.appearances, row.minutes, row.goals, row.assists]), [
    [489, 16, 1180, 5, 2],
    [541, 8, 500, 1, 1],
  ]);
  assert.equal(rows[0].competitions.length, 2);
});

test('orders a same-season move with the later club first when its tenure continues', async () => {
  const { buildPlayerCareerRows } = await import('../lib/team-player-data.js');
  const rows = buildPlayerCareerRows([
    { playerId: 1485, season: 2019, teamId: 228, teamName: 'Sporting CP', leagueId: 94, leagueName: 'Primeira Liga', appearances: 25, minutes: 1800, goals: 8, assists: 7 },
    { playerId: 1485, season: 2019, teamId: 33, teamName: 'Manchester United', leagueId: 39, leagueName: 'Premier League', appearances: 21, minutes: 1753, goals: 12, assists: 8 },
  ], {
    history: [
      { season: 2018, teamId: 228 },
      { season: 2019, teamId: 228 },
      { season: 2019, teamId: 33 },
      { season: 2020, teamId: 33 },
    ],
  });

  assert.deepEqual(rows.map((row) => row.teamId), [33, 228]);
});

test('does not let a later return to a former club reverse an older same-season move', async () => {
  const { buildPlayerCareerRows } = await import('../lib/team-player-data.js');
  const rows = buildPlayerCareerRows([
    { playerId: 99, season: 2019, teamId: 1, teamName: 'Alpha', leagueId: 10, leagueName: 'League A', appearances: 12 },
    { playerId: 99, season: 2019, teamId: 2, teamName: 'Beta', leagueId: 20, leagueName: 'League B', appearances: 8 },
  ], {
    history: [
      { season: 2018, teamId: 1 },
      { season: 2019, teamId: 1 },
      { season: 2019, teamId: 2 },
      { season: 2020, teamId: 2 },
      { season: 2021, teamId: 2 },
      { season: 2023, teamId: 1 },
    ],
  });

  assert.deepEqual(rows.map((row) => row.teamId), [2, 1]);
});

test('normalizes numeric player-team seasons and keeps association candidates separate from verified clubs', async () => {
  const { confirmedClubPlayerRecords, currentTeamCandidatesFromPlayerSquad, normalizePlayerTeamHistory, normalizeTeamIdentity } = await import('../lib/team-player-data.js');
  const history = normalizePlayerTeamHistory({
    response: [{
      team: { id: 489, name: 'AC Milan', logo: 'https://images.test/milan.png', national: false },
      seasons: [2026, 2025],
    }],
  });
  const candidates = currentTeamCandidatesFromPlayerSquad({
    response: [{
      team: { id: 489, name: 'AC Milan', logo: 'https://images.test/milan.png', national: false },
      players: [{ id: 44, name: 'A. Rossonero' }],
    }],
  }, 44);
  const mismatched = currentTeamCandidatesFromPlayerSquad({
    response: [{ team: { id: 489, name: 'AC Milan' }, players: [{ id: 45 }] }],
  }, 44);
  const noPlayerIdentity = currentTeamCandidatesFromPlayerSquad({
    response: [{ team: { id: 489, name: 'AC Milan' }, players: [] }],
  }, 44);
  const ambiguousAssociation = currentTeamCandidatesFromPlayerSquad({
    response: [
      { team: { id: 2, name: 'France', national: true }, players: [{ id: 44 }] },
      { team: { id: 489, name: 'AC Milan' }, players: [{ id: 44 }] },
    ],
  }, 44);

  assert.deepEqual(history.map((row) => row.season), [2026, 2025]);
  assert.deepEqual(candidates, [{
    id: 489,
    name: 'ミラン',
    englishName: 'AC Milan',
    logo: 'https://images.test/milan.png',
    national: false,
  }]);
  assert.deepEqual(mismatched, []);
  assert.deepEqual(noPlayerIdentity, []);
  assert.equal(ambiguousAssociation.length, 2);
  assert.equal(normalizeTeamIdentity({ response: [{ team: { id: 489, name: 'AC Milan' } }] }, 489).national, null);
  assert.deepEqual(confirmedClubPlayerRecords([
    { playerId: 44, teamNational: false, teamNationalVerified: true },
    { playerId: 44, teamNational: true, teamNationalVerified: true },
    { playerId: 44, teamNational: false, teamNationalVerified: false },
  ]), [{ playerId: 44, teamNational: false, teamNationalVerified: true }]);
});
