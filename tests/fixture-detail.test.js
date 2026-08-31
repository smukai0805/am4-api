import test from 'node:test';
import assert from 'node:assert/strict';
import { getFixtureDetail } from '../api/fixtures.js';

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
    if (path === '/fixtures/events') return { response: [{ time: { elapsed: 12, extra: null }, type: 'Goal', detail: 'Normal Goal', team: { id: 42, name: 'Arsenal' }, player: { id: 9, name: 'B. Saka' }, assist: { id: 8, name: 'M. Odegaard' } }] };
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
  assert.deepEqual(detail.events, [{
    minute: "12'", elapsed: 12, extra: null, type: 'Goal', detail: 'Normal Goal', comments: null,
    team: { id: 42, name: 'Arsenal', logo: null }, player: { id: 9, name: 'B. Saka' }, assist: { id: 8, name: 'M. Odegaard' },
  }]);
  assert.equal(detail.lineups, null);
  assert.deepEqual(detail.statistics, [{ team: { id: 42, name: 'Arsenal', logo: null }, statistics: [{ type: 'Ball Possession', value: '60%' }] }]);
  assert.deepEqual(detail.availability, { events: true, lineups: false, statistics: true });
  assert.equal(detail.cacheControl, 's-maxage=300, stale-while-revalidate=86400');
});

test('fixture detail returns null only when the primary fixture is absent', async () => {
  const detail = await getFixtureDetail(123, async () => ({ response: [] }));
  assert.equal(detail, null);
});

test('fixture detail orders events and team blocks by the fixture home and away sides', async () => {
  const fetchFixture = async (path) => {
    if (path === '/fixtures') {
      return { response: [{
        fixture: { id: 456, date: '2026-08-16T14:00:00+00:00', status: { short: 'FT' } },
        league: { id: 39, name: 'Premier League' },
        teams: { home: { id: 10, name: 'Home' }, away: { id: 20, name: 'Away' } },
        goals: { home: 1, away: 2 }, score: {},
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
