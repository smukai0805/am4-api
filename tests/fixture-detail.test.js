import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEventType, getFixtureDetail, getFixtureLiveDetail } from '../api/fixtures.js';

test('fixture detail normalizes provider data and degrades unavailable optional sections', async () => {
  const calls = [];
  const fetchFixture = async (path, params) => {
    calls.push({ path, params });
    if (path === '/fixtures') {
      return {
        response: [{
          fixture: { id: 123, date: '2026-08-16T14:00:00+00:00', timestamp: 1786888800, referee: 'A. Ref', timezone: 'UTC', status: { short: 'FT', long: 'Match Finished', elapsed: 90 }, venue: { name: 'Stadium', city: 'City' } },
          league: { id: 39, name: 'Premier League', logo: 'https://example.test/league.png', country: 'England', round: 'Regular Season - 1' },
          teams: { home: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, away: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' } },
          goals: { home: 2, away: 1 },
          score: { halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 1 }, extratime: { home: null, away: null }, penalty: { home: null, away: null } },
        }],
      };
    }
    if (path === '/fixtures/events') return { response: [
      { time: { elapsed: 12, extra: null }, type: 'Goal', detail: 'Normal Goal', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 9, name: 'Bukayo Ayoyinka T. M. Saka', shortName: 'Bukayo Saka' }, assist: { id: 8, name: 'M. Odegaard' } },
      { time: { elapsed: 45, extra: null }, type: 'Goal', detail: 'Normal Goal', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 19, name: 'J. Away' }, assist: { id: 20, name: 'K. Away' } },
      { time: { elapsed: 61, extra: null }, type: 'subst', detail: 'Substitution 1', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 10, name: 'A. Out' }, assist: { id: 11, name: 'B. In' } },
      { time: { elapsed: 70, extra: null }, type: 'Card', detail: 'Yellow Card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 12, name: 'C. Yellow' }, assist: { id: null, name: null } },
      { time: { elapsed: 73, extra: null }, type: 'Card', detail: 'Second Yellow card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 13, name: 'D. Second' }, assist: { id: null, name: null } },
      { time: { elapsed: 78, extra: null }, type: 'Card', detail: 'Red Card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 14, name: 'E. Red' }, assist: { id: null, name: null } },
      { time: { elapsed: 83, extra: null }, type: 'Goal', detail: 'Own Goal', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 15, name: 'F. Own' }, assist: { id: 16, name: 'G. Involved' } },
      { time: { elapsed: 88, extra: null }, type: 'Goal', detail: 'Missed Penalty', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 17, name: 'H. Missed' }, assist: { id: null, name: null } },
      { time: { elapsed: 90, extra: 2 }, type: 'Goal', detail: 'Goal Disallowed', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 18, name: 'I. Disallowed' }, assist: { id: null, name: null } },
    ] };
    if (path === '/fixtures/lineups') return { errors: { coverage: 'Not available' }, response: [] };
    return { response: [{ team: { id: 42, name: 'Arsenal' }, statistics: [{ type: 'Ball Possession', value: '60%' }] }] };
  };

  const detail = await getFixtureDetail(123, fetchFixture);

  assert.deepEqual(calls, [
    { path: '/fixtures', params: { id: 123 } },
    { path: '/fixtures/events', params: { fixture: 123 } },
    { path: '/fixtures/lineups', params: { fixture: 123 } },
    { path: '/fixtures/statistics', params: { fixture: 123 } },
  ]);
  assert.equal(detail.fixture.competition, 'プレミアリーグ');
  assert.equal(detail.fixture.competitionLogo, 'https://example.test/league.png');
  assert.equal(detail.fixture.competitionCountry, 'England');
  assert.equal(detail.fixture.status, 'FT');
  assert.equal(detail.fixture.roundLabel, '第1節');
  assert.deepEqual(detail.events[0], {
    minute: "12'", elapsed: 12, extra: null, type: 'goal', subtype: null, providerType: 'Goal', detail: 'Normal Goal', comments: null,
    team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 9, name: 'Bukayo Ayoyinka T. M. Saka', displayName: 'Bukayo Saka' }, assist: { id: 8, name: 'M. Odegaard' },
  });
  assert.deepEqual(detail.events.slice(1).map((event) => ({
    minute: event.minute, type: event.type, subtype: event.subtype, providerType: event.providerType, detail: event.detail, team: event.team, player: event.player, assist: event.assist,
  })), [
    { minute: "45'", type: 'goal', subtype: null, providerType: 'Goal', detail: 'Normal Goal', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 19, name: 'J. Away' }, assist: { id: 20, name: 'K. Away' } },
    { minute: "61'", type: 'substitution', subtype: null, providerType: 'subst', detail: 'Substitution 1', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 10, name: 'A. Out' }, assist: { id: 11, name: 'B. In' } },
    { minute: "70'", type: 'yellow_card', subtype: null, providerType: 'Card', detail: 'Yellow Card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 12, name: 'C. Yellow' }, assist: { id: null, name: null } },
    { minute: "73'", type: 'red_card', subtype: 'second_yellow', providerType: 'Card', detail: 'Second Yellow card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 13, name: 'D. Second' }, assist: { id: null, name: null } },
    { minute: "78'", type: 'red_card', subtype: null, providerType: 'Card', detail: 'Red Card', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 14, name: 'E. Red' }, assist: { id: null, name: null } },
    { minute: "83'", type: 'own_goal', subtype: null, providerType: 'Goal', detail: 'Own Goal', team: { id: 50, name: 'Manchester City', logo: 'https://example.test/mc.png' }, player: { id: 15, name: 'F. Own' }, assist: { id: 16, name: 'G. Involved' } },
    { minute: "88'", type: 'penalty_missed', subtype: null, providerType: 'Goal', detail: 'Missed Penalty', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 17, name: 'H. Missed' }, assist: { id: null, name: null } },
    { minute: "90+2'", type: 'var', subtype: 'goal_review', providerType: 'Goal', detail: 'Goal Disallowed', team: { id: 42, name: 'Arsenal', logo: 'https://example.test/a.png' }, player: { id: 18, name: 'I. Disallowed' }, assist: { id: null, name: null } },
  ]);
  assert.deepEqual(detail.eventIntegrity, { teamAssociation: true, goalScore: 'consistent' });
  assert.equal(detail.lineups, null);
  assert.deepEqual(detail.statistics, [{ team: { id: 42, name: 'Arsenal', logo: null }, statistics: [{ type: 'Ball Possession', value: '60%' }] }]);
  assert.deepEqual(detail.availability, { events: true, lineups: false, statistics: true });
  assert.equal(detail.cacheControl, 's-maxage=300, stale-while-revalidate=86400');
});

test('fixture detail returns null only when the primary fixture is absent', async () => {
  const detail = await getFixtureDetail(123, async () => ({ response: [] }));
  assert.equal(detail, null);
});

test('live fixture detail refreshes mutable sections without requesting lineups', async () => {
  const calls = [];
  const fetchFixture = async (path, params) => {
    calls.push({ path, params });
    if (path === '/fixtures') return { response: [{
      fixture: { id: 789, date: '2026-08-16T14:00:00+00:00', status: { short: '2H', long: 'Second Half', elapsed: 72 } },
      league: { id: 39, name: 'Premier League' },
      teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
      goals: { home: 1, away: 0 }, score: {},
    }] };
    if (path === '/fixtures/events') return { response: [{ time: { elapsed: 72 }, type: 'Goal', team: { id: 10, name: 'Home' }, player: { name: 'Scorer' } }] };
    if (path === '/fixtures/statistics') return { response: [{ team: { id: 10, name: 'Home' }, statistics: [] }, { team: { id: 20, name: 'Away' }, statistics: [] }] };
    throw new Error(`unexpected request: ${path}`);
  };

  const detail = await getFixtureLiveDetail(789, fetchFixture);

  assert.deepEqual(calls, [
    { path: '/fixtures', params: { id: 789 } },
    { path: '/fixtures/events', params: { fixture: 789 } },
    { path: '/fixtures/statistics', params: { fixture: 789 } },
  ]);
  assert.equal(detail.fixture.elapsed, 72);
  assert.equal(detail.events[0].player.name, 'Scorer');
  assert.equal(detail.lineups, undefined);
  assert.deepEqual(detail.availability, { events: true, statistics: true });
  assert.equal(detail.cacheControl, 's-maxage=15, stale-while-revalidate=15');
});

test('live-detail cache remains short while the provider still reports pre-kickoff status', async () => {
  const fetchFixture = async (path) => {
    if (path === '/fixtures') return { response: [{
      fixture: { id: 790, date: '2026-08-16T14:00:00+00:00', status: { short: 'NS' } },
      league: { id: 39, name: 'Premier League' },
      teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
      goals: { home: null, away: null }, score: {},
    }] };
    return { response: [] };
  };

  const detail = await getFixtureLiveDetail(790, fetchFixture);
  assert.equal(detail.fixture.status, 'NS');
  assert.equal(detail.cacheControl, 's-maxage=15, stale-while-revalidate=15');
});

test('fixture detail orders events and team blocks by the fixture home and away sides', async () => {
  const fetchFixture = async (path) => {
    if (path === '/fixtures') {
      return { response: [{
        fixture: { id: 456, date: '2026-08-16T14:00:00+00:00', status: { short: 'FT' } },
        league: { id: 39, name: 'Premier League' },
        teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
        goals: { home: 0, away: 1 }, score: {},
      }] };
    }
    if (path === '/fixtures/events') return { response: [
      { time: { elapsed: 72 }, type: 'Goal', team: { id: 20, name: 'Away' }, player: { name: 'Late' } },
      { time: { elapsed: 4 }, type: 'Card', team: { id: 10, name: 'Home' }, player: { name: 'Early' } },
    ] };
    if (path === '/fixtures/lineups') return { response: [
      { team: { id: 20, name: 'Away' }, startXI: [], substitutes: [] },
      { team: { id: 10, name: 'Home' }, startXI: [], substitutes: [] },
    ] };
    return { response: [
      { team: { id: 20, name: 'Away' }, statistics: [] },
      { team: { id: 10, name: 'Home' }, statistics: [] },
    ] };
  };

  const detail = await getFixtureDetail(456, fetchFixture);

  assert.deepEqual(detail.events.map((event) => event.minute), ["4'", "72'"]);
  assert.deepEqual(detail.lineups.map((lineup) => lineup.team.id), [10, 20]);
  assert.deepEqual(detail.statistics.map((entry) => entry.team.id), [10, 20]);
});

test('fixture detail excludes foreign events and suppresses contradictory scoring events', async () => {
  const fetchFixture = async (path) => {
    if (path === '/fixtures') return { response: [{
      fixture: { id: 999, date: '2026-08-16T14:00:00+00:00', status: { short: 'FT' } },
      league: { id: 39, name: 'Premier League' },
      teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
      goals: { home: 1, away: 0 }, score: {},
    }] };
    if (path === '/fixtures/events') return { response: [
      { time: { elapsed: 10 }, type: 'Card', detail: 'Yellow Card', team: { id: 10, name: 'Home' }, player: { id: 1, name: 'Booked' } },
      { time: { elapsed: 40 }, type: 'Goal', detail: 'Normal Goal', team: { id: 20, name: 'Away' }, player: { id: 2, name: 'Incorrect scorer' } },
      { time: { elapsed: 55 }, type: 'Goal', detail: 'Normal Goal', team: { id: 30, name: 'Foreign' }, player: { id: 3, name: 'Foreign player' } },
    ] };
    return { response: [] };
  };

  const detail = await getFixtureDetail(999, fetchFixture);
  assert.deepEqual(detail.events.map((event) => [event.type, event.team.id]), [['yellow_card', 10]]);
  assert.deepEqual(detail.eventIntegrity, { teamAssociation: true, goalScore: 'mismatch' });
});

test('provider event labels are normalised to canonical event keys', () => {
  assert.equal(canonicalEventType({ type: 'Goal', detail: 'Normal Goal' }), 'goal');
  assert.equal(canonicalEventType({ type: 'Goal', detail: 'Own Goal' }), 'own_goal');
  assert.equal(canonicalEventType({ type: 'Goal', detail: 'Missed Penalty' }), 'penalty_missed');
  assert.equal(canonicalEventType({ type: 'Card', detail: 'Yellow Card' }), 'yellow_card');
  assert.equal(canonicalEventType({ type: 'subst', detail: 'Substitution 1' }), 'substitution');
  assert.equal(canonicalEventType({ type: 'VAR', detail: 'Goal cancelled' }), 'var');
});

test('fixture detail retains provider display labels for events and lineups', async () => {
  const fetchFixture = async (path) => {
    if (path === '/fixtures') return { response: [{
      fixture: { id: 321, date: '2026-08-16T14:00:00+00:00', status: { short: 'NS' } },
      league: { id: 39, name: 'Premier League' },
      teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
      goals: { home: null, away: null }, score: {},
    }] };
    if (path === '/fixtures/events') return { response: [{
      time: { elapsed: 10 }, type: 'Goal', detail: 'Normal Goal', team: { id: 10, name: 'Home' },
      player: { id: 1, name: 'Vinícius José Paixão de Oliveira Júnior', commonName: 'Vinícius Jr.' },
      assist: { id: 2, name: 'Long Assist Name', knownAs: 'A. Assist' },
    }] };
    if (path === '/fixtures/lineups') return { response: [{
      team: { id: 10, name: 'Home' }, startXI: [{ player: { id: 1, name: 'Natan Bernardo de Souza', shortName: 'Natan', number: 4, pos: 'D' } }], substitutes: [],
    }] };
    return { response: [] };
  };

  const detail = await getFixtureDetail(321, fetchFixture);
  assert.equal(detail.events[0].player.displayName, 'Vinícius Jr.');
  assert.equal(detail.events[0].assist.displayName, 'A. Assist');
  assert.equal(detail.lineups[0].startXI[0].displayName, 'Natan');
});
