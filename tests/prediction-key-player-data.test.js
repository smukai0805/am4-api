const test = require('node:test');
const assert = require('node:assert/strict');

test('hydrates only lightweight verified squads and reuses resolved key-player media', async () => {
  const {
    clearPredictionKeyPlayerDataCache,
    hydratePredictionKeyPlayers,
  } = await import('../lib/prediction-key-player-data.js');
  clearPredictionKeyPlayerDataCache();
  const fixture = {
    home: { id: 1346, name: 'Coventry City', logo: 'https://media.api-sports.io/football/teams/1346.png' },
    away: { id: 51, name: 'Brighton & Hove Albion', logo: 'https://media.api-sports.io/football/teams/51.png' },
  };
  const article = {
    prediction: {
      keyPlayers: 'Coventry｜Ellis Simms\n\n前線で収めて押し上げる。\n\nBrighton｜Georginio Rutter\n\n狭い局面で違いを作る。',
    },
  };
  const calls = [];
  const fetcher = async (path, params) => {
    calls.push([path, params.team]);
    const players = Number(params.team) === 1346
      ? [{ id: 138786, name: 'E. Simms', photo: 'https://media.api-sports.io/football/players/138786.png' }]
      : [{ id: 90590, name: 'G. Rutter', photo: 'https://media.api-sports.io/football/players/90590.png' }];
    return { response: [{ players }] };
  };

  const hydrated = await hydratePredictionKeyPlayers(article, fixture, { fetcher });
  assert.deepEqual(calls, [['/players/squads', 1346], ['/players/squads', 51]]);
  assert.deepEqual(hydrated.prediction.keyPlayerCards.map((card) => [
    card.playerName, card.clubName, card.playerId, card.teamId, card.photoUrl, card.logoUrl, card.resolved,
  ]), [
    ['Ellis Simms', 'Coventry City', 138786, 1346, 'https://media.api-sports.io/football/players/138786.png', 'https://media.api-sports.io/football/teams/1346.png', true],
    ['Georginio Rutter', 'Brighton & Hove Albion', 90590, 51, 'https://media.api-sports.io/football/players/90590.png', 'https://media.api-sports.io/football/teams/51.png', true],
  ]);

  const reused = await hydratePredictionKeyPlayers(hydrated, fixture, {
    fetcher: async () => { throw new Error('a resolved card must not refetch'); },
  });
  assert.equal(reused.prediction.keyPlayerCards[0].photoUrl, 'https://media.api-sports.io/football/players/138786.png');
  assert.equal(reused.prediction.keyPlayerCards[1].photoUrl, 'https://media.api-sports.io/football/players/90590.png');
});

test('does not cache an API-Football error payload as an empty squad', async () => {
  const {
    clearPredictionKeyPlayerDataCache,
    hydratePredictionKeyPlayers,
  } = await import('../lib/prediction-key-player-data.js');
  clearPredictionKeyPlayerDataCache();
  const fixture = {
    home: { id: 895, name: 'Como', logo: 'https://media.api-sports.io/football/teams/895.png' },
    away: { id: 523, name: 'Parma', logo: 'https://media.api-sports.io/football/teams/523.png' },
  };
  const article = { prediction: { keyPlayers: 'Como：Martin Baturina — 試合を動かす。' } };
  let calls = 0;
  const unavailable = await hydratePredictionKeyPlayers(article, fixture, {
    fetcher: async () => {
      calls += 1;
      return { errors: { rateLimit: 'retry later' }, response: [] };
    },
  });
  assert.equal(unavailable.prediction.keyPlayerCards[0].resolved, false);

  const recovered = await hydratePredictionKeyPlayers(article, fixture, {
    fetcher: async () => {
      calls += 1;
      return { response: [{ players: [{ id: 295026, name: 'M. Baturina', photo: 'https://media.api-sports.io/football/players/295026.png' }] }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(recovered.prediction.keyPlayerCards[0].resolved, true);
  assert.equal(recovered.prediction.keyPlayerCards[0].playerId, 295026);
});

test('keeps only a same-player verified card when the Notion mirror is updated', async () => {
  const { retainVerifiedPredictionKeyPlayerCards } = await import('../lib/notion-content-sync.js');
  const previous = {
    type: 'match_prediction',
    prediction: {
      keyPlayerCards: [{
        playerName: 'Ellis Simms',
        clubName: 'Coventry City',
        clubLabel: 'Coventry',
        reason: '以前の理由',
        teamId: 1346,
        side: 'home',
        playerId: 138786,
        photoUrl: 'https://media.api-sports.io/football/players/138786.png',
        logoUrl: 'https://media.api-sports.io/football/teams/1346.png',
        resolved: true,
      }],
    },
  };
  const changedReason = {
    id: 'prediction-1',
    type: 'match_prediction',
    match: { homeTeamId: 1346, homeTeam: 'Coventry City', awayTeamId: 51, awayTeam: 'Brighton & Hove Albion' },
    prediction: {
      keyPlayers: 'Coventry｜Ellis Simms\n\n更新後の選出理由。',
      keyPlayerCards: [],
    },
  };
  const retained = retainVerifiedPredictionKeyPlayerCards(changedReason, previous);
  assert.deepEqual(retained.prediction.keyPlayerCards.map((card) => [
    card.playerName, card.reason, card.playerId, card.photoUrl, card.resolved,
  ]), [[
    'Ellis Simms', '更新後の選出理由。', 138786,
    'https://media.api-sports.io/football/players/138786.png', true,
  ]]);

  const changedPlayer = retainVerifiedPredictionKeyPlayerCards({
    ...changedReason,
    prediction: { ...changedReason.prediction, keyPlayers: 'Coventry｜Haji Wright\n\n別の選出理由。' },
  }, previous);
  assert.equal(changedPlayer.prediction.keyPlayerCards[0].playerId, null);
  assert.equal(changedPlayer.prediction.keyPlayerCards[0].resolved, false);
});

test('uses the verified media sidecar only for the same normalized card', async () => {
  const { applyStoredPredictionKeyPlayerCards } = await import('../lib/prediction-key-player-data.js');
  const {
    changedVerifiedPredictionKeyPlayerCards,
    shouldClearVerifiedPredictionKeyPlayerCards,
    verifiedPredictionKeyPlayerCards,
  } = await import('../lib/prediction-key-player-store.js');
  const fixture = {
    home: { id: 503, name: 'Torino', logo: 'https://media.api-sports.io/football/teams/503.png' },
    away: { id: 497, name: 'AS Roma', logo: 'https://media.api-sports.io/football/teams/497.png' },
  };
  const stored = verifiedPredictionKeyPlayerCards([{
    playerName: 'Rolando Mandragora',
    clubName: 'Torino',
    clubLabel: 'Torino',
    reason: '以前の理由',
    teamId: 503,
    side: 'home',
    playerId: 30810,
    photoUrl: 'https://media.api-sports.io/football/players/30810.png',
    logoUrl: 'https://media.api-sports.io/football/teams/503.png',
    resolved: true,
  }, {
    playerName: 'Untrusted URL',
    teamId: 503,
    playerId: 1,
    photoUrl: 'http://example.test/not-allowed.png',
    logoUrl: 'https://media.api-sports.io/football/teams/503.png',
    resolved: true,
  }]);
  assert.equal(stored.length, 1);
  const article = { prediction: { keyPlayers: 'Torino：Rolando Mandragora — 更新後の理由。' } };
  const reused = applyStoredPredictionKeyPlayerCards(article, fixture, stored);
  assert.equal(reused.prediction.keyPlayerCards[0].playerId, 30810);
  assert.equal(reused.prediction.keyPlayerCards[0].reason, '更新後の理由。');
  assert.equal(stored[0].reason, undefined);
  assert.equal(changedVerifiedPredictionKeyPlayerCards(reused, stored), false);
  assert.equal(changedVerifiedPredictionKeyPlayerCards(reused, reused.prediction.keyPlayerCards), false);
  assert.equal(shouldClearVerifiedPredictionKeyPlayerCards({ prediction: {} }, stored), true);
  assert.equal(shouldClearVerifiedPredictionKeyPlayerCards({
    prediction: { keyPlayers: 'Torino：Rolando Mandragora — 更新後の理由。', keyPlayerCards: [{ resolved: false }] },
  }, stored), false);

  const changed = applyStoredPredictionKeyPlayerCards(
    { prediction: { keyPlayers: 'Torino：Cesare Casadei — 別の理由。' } },
    fixture,
    stored,
  );
  assert.equal(changed.prediction.keyPlayerCards[0].resolved, false);
  assert.equal(changed.prediction.keyPlayerCards[0].playerId, null);
});

test('does not resync legacy unresolved cards without a fixture identity', async () => {
  const { needsPredictionKeyPlayerRefresh } = await import('../lib/notion-content-sync.js');
  const legacy = {
    match: { fixtureId: null },
    prediction: {
      keyPlayers: 'Torino：Rolando Mandragora — 中盤で試合を動かす。',
      keyPlayerCards: [{ resolved: false }],
    },
  };
  assert.equal(needsPredictionKeyPlayerRefresh(legacy, 'match_prediction'), false);
  assert.equal(needsPredictionKeyPlayerRefresh({
    ...legacy,
    match: { fixtureId: 1550125 },
  }, 'match_prediction'), true);
});
