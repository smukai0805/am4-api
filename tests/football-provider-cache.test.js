const test = require('node:test');
const assert = require('node:assert/strict');

const start = Date.parse('2026-09-20T10:00:00Z');
function fixture(id = 1, status = '1H') {
  return { fixture: { id, date: new Date(start).toISOString(), status: { short: status } },
    teams: { home: { id: 10 }, away: { id: 20 } }, goals: { home: 1, away: 0 },
    events: [{ type: 'Goal', player: { id: 7 } }], lineups: [{ team: { id: 10 } }],
    statistics: [{ team: { id: 10 } }], players: [{ team: { id: 10 }, players: [] }] };
}
async function setup(options = {}) {
  const api = await import('../lib/football-provider-cache.js');
  let time = start, calls = 0, failing = null;
  const store = options.store || api.createMemoryProviderStore();
  const transport = async (path, params) => {
    calls++;
    if (failing) {
      if (failing instanceof Error) throw failing;
      return { data: structuredClone(failing), remaining: null };
    }
    return { data: { errors: [], response: [fixture(Number(params.ids || params.id || 1))] }, remaining: null };
  };
  const config = { store, now: () => time, sleep: async () => {}, logger: { warn() {} }, fetchProvider: transport, ...options };
  const cache = api.createFootballProviderCache(config);
  return { api, store, cache, config, get calls() { return calls; }, advance(ms) { time += ms; }, fail(value) { failing = value; } };
}

test('1000 same-fixture readers consume one upstream call, not 1000', async () => {
  const run = await setup();
  const results = await Promise.all(Array.from({ length: 1000 }, () => run.cache.request('/fixtures', { id: 1 })));
  assert.equal(run.calls, 1); assert.equal(results.length, 1000);
  results[0].response[0].goals.home = 99;
  assert.equal(results[1].response[0].goals.home, 1);
});

test('identity, events, lineups, statistics and players share one documented bundle', async () => {
  const run = await setup();
  const values = await Promise.all([
    run.cache.request('/fixtures', { id: 1 }),
    ...['events', 'lineups', 'statistics', 'players'].map((section) => run.cache.request(`/fixtures/${section}`, { fixture: 1 })),
  ]);
  assert.equal(run.calls, 1);
  assert.equal(values[0].response[0].fixture.id, 1);
  assert.equal(values[1].response[0].type, 'Goal');
  assert.equal(values[2].parameters.fixture, 1);
});

test('another server process reuses the persisted response', async () => {
  const run = await setup();
  await run.cache.request('/fixtures', { id: 1 });
  const second = run.api.createFootballProviderCache(run.config);
  await second.request('/fixtures/statistics', { fixture: 1 });
  assert.equal(run.calls, 1);
});

test('concurrent processes acquire only one lease', async () => {
  const run = await setup();
  const second = run.api.createFootballProviderCache({ ...run.config, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))) });
  const values = await Promise.all([run.cache.request('/fixtures', { id: 1 }), second.request('/fixtures', { id: 1 })]);
  assert.equal(run.calls, 1); assert.equal(values.length, 2);
});

test('HTTP-200 daily error never overwrites the last good score or lineup', async () => {
  const run = await setup();
  const initial = await run.cache.request('/fixtures', { id: 1 });
  run.advance(61_000);
  run.fail({ errors: { requests: 'Daily quota exhausted' }, response: [] });
  const stale = await run.cache.request('/fixtures', { id: 1 });
  assert.deepEqual(stale.response, initial.response);
  assert.equal(stale._am4Cache.stale, true);
  assert.equal(stale._am4Cache.fetchedAt, initial._am4Cache.fetchedAt);
  await run.cache.request('/fixtures', { id: 1 });
  await assert.rejects(run.cache.request('/fixtures', { id: 2 }), /paused/);
  assert.equal(run.calls, 2);
});

test('a timeout retains the previous data instead of an empty response', async () => {
  const run = await setup();
  await run.cache.request('/fixtures', { id: 1 });
  run.advance(61_000); run.fail(new Error('request timed out'));
  const saved = await run.cache.request('/fixtures', { id: 1 });
  assert.equal(saved.response[0].goals.home, 1);
  assert.equal(saved._am4Cache.stale, true);
});

test('a cold failure remains an error, not a fabricated zero-fixture success', async () => {
  const run = await setup(); run.fail({ errors: { requests: 'limit' }, response: [] });
  await assert.rejects(run.cache.request('/fixtures', { date: '2026-09-20' }));
  await assert.rejects(run.cache.request('/fixtures', { date: '2026-09-20' }));
  assert.equal(run.calls, 1);
});

test('the daily budget is shared by processes, while saved data still displays', async () => {
  const run = await setup({ dailyBudget: 2 });
  const second = run.api.createFootballProviderCache(run.config);
  await run.cache.request('/fixtures', { id: 1 });
  await second.request('/fixtures', { id: 2 });
  await assert.rejects(second.request('/fixtures', { id: 3 }), /budget/);
  assert.equal((await second.request('/fixtures', { id: 1 })).response[0].fixture.id, 1);
  assert.equal(run.calls, 2);
});

test('quota resets on the provider UTC day, not at Japanese midnight', async () => {
  const run = await setup({ dailyBudget: 1 });
  await run.cache.request('/fixtures', { id: 1 });
  run.advance(8 * 60 * 60 * 1000);
  await assert.rejects(run.cache.request('/fixtures', { id: 2 }), /budget/);
  run.advance(7 * 60 * 60 * 1000);
  await run.cache.request('/fixtures', { id: 3 });
  assert.equal(run.calls, 2);
});

test('league, season, date, timezone and page remain independent cache keys', async () => {
  const run = await setup();
  await run.cache.request('/players', { league: 39, season: 2026, page: 1 });
  await run.cache.request('/players', { page: 1, season: 2026, league: 39 });
  await run.cache.request('/players', { league: 39, season: 2025, page: 1 });
  await run.cache.request('/players', { league: 39, season: 2026, page: 2 });
  assert.equal(run.calls, 3);
});

test('missing optional sections preserve their old data and original timestamp', async () => {
  const run = await setup();
  const first = await run.cache.request('/fixtures/lineups', { fixture: 1 });
  run.advance(61_000);
  const partial = fixture(); delete partial.lineups;
  run.fail({ errors: [], response: [partial] });
  const second = await run.cache.request('/fixtures/lineups', { fixture: 1 });
  assert.deepEqual(second.response, first.response);
  assert.equal(second._am4Cache.stale, true);
  assert.equal(second._am4Cache.fetchedAt, first._am4Cache.fetchedAt);
});

test('a bundle for a different fixture cannot replace the requested fixture', async () => {
  const run = await setup();
  await run.cache.request('/fixtures', { id: 1 }); run.advance(61_000);
  run.fail({ errors: [], response: [fixture(2)] });
  const saved = await run.cache.request('/fixtures', { id: 1 });
  assert.equal(saved.response[0].fixture.id, 1); assert.equal(saved._am4Cache.stale, true);
});

test('a missing photo preserves the same verified player photo, not another player', async () => {
  const run = await setup();
  run.fail({ errors: [], response: [{ player: { id: 7, name: 'Player', photo: 'https://images.test/7.png' } }] });
  await run.cache.request('/players/profiles', { player: 7 }); run.advance(86_401_000);
  run.fail({ errors: [], response: [{ player: { id: 7, name: 'Player', photo: null } }] });
  const kept = await run.cache.request('/players/profiles', { player: 7 });
  assert.equal(kept.response[0].player.photo, 'https://images.test/7.png'); assert.equal(kept._am4Cache.stale, true);
});

test('final and profile data have longer TTLs, without freezing live games', async () => {
  const { providerCacheTtl } = await import('../lib/football-provider-cache.js');
  assert.equal(providerCacheTtl('/fixtures', { ids: 1 }, { response: [fixture()] }, start), 60_000);
  assert.equal(providerCacheTtl('/fixtures', { ids: 1 }, { response: [fixture(1, 'FT')] }, start + 25 * 3600_000), 86_400_000);
  assert.equal(providerCacheTtl('/players/profiles', { player: 7 }, { response: [{ player: { id: 7 } }] }, start), 86_400_000);
});

test('a store outage serves a known snapshot and does not fan out upstream', async () => {
  const run = await setup(); await run.cache.request('/fixtures', { id: 1 });
  run.advance(61_000); run.store.read = async () => { throw new Error('store offline'); };
  const saved = await run.cache.request('/fixtures', { id: 1 });
  assert.equal(saved._am4Cache.stale, true); assert.equal(run.calls, 1);
  await assert.rejects(run.cache.request('/fixtures', { id: 2 }), /cache is unavailable/);
});

test('stale JSON is labelled and must not poison the CDN as fresh', async () => {
  const { withFootballCacheMetadata, recordFootballCacheRead } = await import('../lib/football-cache-context.js');
  const headers = {}; let output;
  const res = { setHeader(k, v) { headers[k] = v; }, json(value) { output = value; } };
  await withFootballCacheMetadata(async () => {
    recordFootballCacheRead({ fetchedAt: '2026-09-20T10:00:00Z', stale: true });
    res.setHeader('Cache-Control', 's-maxage=60'); res.json({ fixtures: [1] });
  })({}, res);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(output.dataFreshness.stale, true); assert.deepEqual(output.fixtures, [1]);
});

test('HTTP-200 error bodies are never cached as successful empty data', async () => {
  const { withFootballCacheMetadata } = await import('../lib/football-cache-context.js');
  const headers = {}; const res = { setHeader(k, v) { headers[k] = v; }, json(value) { return value; } };
  await withFootballCacheMetadata(async () => {
    res.setHeader('Cache-Control', 's-maxage=60'); res.json({ errors: { requests: 'limit' }, fixtures: [] });
  })({}, res);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('an empty refresh cannot delete a previously populated daily list', async () => {
  const run = await setup();
  const first = await run.cache.request('/fixtures', { date: '2026-09-20' });
  run.advance(61_000); run.fail({ errors: [], response: [] });
  const saved = await run.cache.request('/fixtures', { date: '2026-09-20' });
  assert.deepEqual(saved.response, first.response); assert.equal(saved._am4Cache.stale, true);
});

test('a mismatched profile ID never replaces a known photo', async () => {
  const run = await setup();
  run.fail({ errors: [], response: [{ player: { id: 7, name: 'Player', photo: 'https://images.test/7.png' } }] });
  await run.cache.request('/players/profiles', { player: 7 }); run.advance(86_401_000);
  run.fail({ errors: [], response: [{ player: { id: 8, name: 'Other', photo: 'https://images.test/8.png' } }] });
  const saved = await run.cache.request('/players/profiles', { player: 7 });
  assert.equal(saved.response[0].player.id, 7); assert.equal(saved._am4Cache.stale, true);
});

test('an HTML-only response retains its article and exposes saved-data age', async () => {
  const { withFootballCacheMetadata, recordFootballCacheRead } = await import('../lib/football-cache-context.js');
  const headers = {}; let html;
  const res = { setHeader(k, v) { headers[k] = v; }, send(value) { html = value; } };
  await withFootballCacheMetadata(async () => {
    recordFootballCacheRead({ fetchedAt: '2026-09-20T10:00:00Z', stale: true });
    res.send('<html><body><main><article>unchanged report and photo</article></main></body></html>');
  })({}, res);
  assert.match(html, /unchanged report and photo/);
  assert.match(html, /data-am4-data-stale="true"/); assert.equal(headers['Cache-Control'], 'no-store');
});

test('the daily display uses data timestamps instead of the time it rendered', async () => {
  const { readFile } = require('node:fs/promises');
  const source = await readFile(new URL('../match-centre.js', `file://${__filename}`), 'utf8');
  assert.match(source, /activeFixtureData\?\.dataFreshness\?\.fetchedAt/);
  assert.doesNotMatch(source, /\$\{updatedAt\(\)\}更新/);
});

test('a swallowed optional provider failure cannot cache null as a normal success', async () => {
  const { withFootballCacheMetadata, recordFootballCacheFailure } = await import('../lib/football-cache-context.js');
  const headers = {}; let body;
  const res = { setHeader(k, v) { headers[k] = v; }, json(value) { body = value; } };
  await withFootballCacheMetadata(async () => {
    recordFootballCacheFailure();
    res.setHeader('Cache-Control', 's-maxage=86400'); res.json({ found: false, photo: null });
  })({}, res);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(body.dataFreshness.unavailable, true); assert.equal(body.dataFreshness.fetchedAt, null);
});
