const test = require('node:test');
const assert = require('node:assert/strict');

const keyPlayers = require('../prediction-key-players.js');

const fixture = {
  home: { id: 539, name: 'Levante', logo: 'https://example.test/levante.png' },
  away: { id: 529, name: 'Barcelona', logo: 'https://example.test/barcelona.png' },
};

test('renders entity links only for verified player and team IDs', () => {
  const linked = keyPlayers.renderCard({
    playerName: 'Raphinha', playerId: 1, photo: 'https://example.test/raphinha.png',
    team: fixture.away, teamId: 529, reason: 'テスト',
  });
  const unresolved = keyPlayers.renderCard({
    playerName: 'Unknown', playerId: 'name-only', team: { name: 'Unknown FC' }, teamId: 'bad', reason: 'テスト',
  });

  assert.match(linked, /href="\/players\/1"/);
  assert.match(linked, /href="\/teams\/529"/);
  assert.doesNotMatch(unresolved, /href="\/(?:players|teams)\//);
});

test('renders separately named one-word players with their inline club', () => {
  const entries = keyPlayers.splitEntries(
    'Roger Brugué（Levante）：前線から守備で貢献する。\n\nRaphinha（Barcelona）：逆サイドからゴール前へ入る。',
    fixture,
    [{ id: 1, name: 'Raphinha', photo: 'https://example.test/raphinha.png', team: fixture.away }],
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.playerName), ['Roger Brugué', 'Raphinha']);
  assert.equal(entries[1].team, fixture.away);
  assert.equal(entries[1].player.id, 1);
  assert.equal(entries[1].photo, 'https://example.test/raphinha.png');
  assert.equal(entries[1].reason, '逆サイドからゴール前へ入る。');
});

test('keeps a non-team parenthetical as editorial copy', () => {
  const [entry] = keyPlayers.splitEntries(
    'Marc (GK)：重要なセーブで支える。',
    fixture,
    [{ id: 2, name: 'Marc', team: fixture.home }],
  );

  assert.equal(entry.playerName, 'Marc');
  assert.equal(entry.team, fixture.home);
  assert.equal(entry.reason, '(GK)\n\n重要なセーブで支える。');
});

test('keeps an unanchored one-word English label as prose', () => {
  const [entry] = keyPlayers.splitEntries('Conclusion.', fixture);

  assert.deepEqual(entry, { type: 'text', reason: 'Conclusion.' });
});

test('normalizes dash and pipe key-player formats against the real team and player IDs', () => {
  const targetFixture = {
    home: { id: 895, name: 'Como', logo: 'https://media.api-sports.io/football/teams/895.png' },
    away: { id: 523, name: 'Parma', logo: 'https://media.api-sports.io/football/teams/523.png' },
  };
  const cards = keyPlayers.normalizePredictionCards(
    'Como：Martin Baturina — 前進の起点として中盤を動かす。\n\nParma｜Simone Lontani\n\nペナルティーエリアで決定力を出す。',
    targetFixture,
    [
      { id: 295026, name: 'M. Baturina', photo: 'https://media.api-sports.io/football/players/295026.png', team: targetFixture.home },
      { id: 483670, name: 'S. Lontani', photo: 'https://media.api-sports.io/football/players/483670.png', team: targetFixture.away },
    ],
  );

  assert.deepEqual(cards.map((card) => ({
    name: card.playerName,
    club: card.clubName,
    reason: card.reason,
    teamId: card.teamId,
    playerId: card.playerId,
    side: card.side,
  })), [
    { name: 'Martin Baturina', club: 'Como', reason: '前進の起点として中盤を動かす。', teamId: 895, playerId: 295026, side: 'home' },
    { name: 'Simone Lontani', club: 'Parma', reason: 'ペナルティーエリアで決定力を出す。', teamId: 523, playerId: 483670, side: 'away' },
  ]);
  assert.equal(cards[0].photoUrl, 'https://media.api-sports.io/football/players/295026.png');
  assert.equal(cards[1].logoUrl, 'https://media.api-sports.io/football/teams/523.png');
});

test('accepts a provider team-name difference without treating the club as a player', () => {
  const targetFixture = {
    home: { id: 1346, name: 'Coventry City', logo: 'https://media.api-sports.io/football/teams/1346.png' },
    away: { id: 51, name: 'Brighton & Hove Albion', logo: 'https://media.api-sports.io/football/teams/51.png' },
  };
  const cards = keyPlayers.normalizePredictionCards(
    'Coventry｜Ellis Simms\n\n前線で収めて味方を押し上げる。\n\nBrighton｜Georginio Rutter\n\n狭い局面で違いを作る。',
    targetFixture,
    [
      { id: 138786, name: 'E. Simms', photo: 'https://media.api-sports.io/football/players/138786.png', team: targetFixture.home },
      { id: 90590, name: 'G. Rutter', photo: 'https://media.api-sports.io/football/players/90590.png', team: targetFixture.away },
    ],
  );

  assert.deepEqual(cards.map((card) => [card.playerName, card.clubName, card.playerId, card.side]), [
    ['Ellis Simms', 'Coventry City', 138786, 'home'],
    ['Georginio Rutter', 'Brighton & Hove Albion', 90590, 'away'],
  ]);
  assert.match(keyPlayers.renderPrediction(cards, targetFixture), /players\/90590\.png/);
});

test('retains verified portraits across a later raw editorial refresh and caps cards per side', () => {
  const targetFixture = {
    home: { id: 63, name: 'Leeds United', logo: 'https://media.api-sports.io/football/teams/63.png' },
    away: { id: 34, name: 'Newcastle United', logo: 'https://media.api-sports.io/football/teams/34.png' },
  };
  const raw = 'Leeds United：Ao Tanaka — 守備から前進を作る。\n\nLeeds United：Brenden Aaronson — 余剰の候補。\n\nNewcastle United：Harvey Barnes — 背後を突く。';
  const retained = [{
    playerName: 'Ao Tanaka',
    clubName: 'Leeds United',
    clubLabel: 'Leeds United',
    reason: '以前の理由',
    teamId: 63,
    side: 'home',
    playerId: 32966,
    photoUrl: 'https://media.api-sports.io/football/players/32966.png',
    logoUrl: 'https://media.api-sports.io/football/teams/63.png',
    resolved: true,
  }];
  const cards = keyPlayers.mergePredictionCards(raw, retained, targetFixture, [
    { id: 18778, name: 'H. Barnes', photo: 'https://media.api-sports.io/football/players/18778.png', team: targetFixture.away },
  ]);

  assert.deepEqual(cards.map((card) => card.side), ['home', 'away']);
  assert.equal(cards[0].playerId, 32966);
  assert.equal(cards[0].photoUrl, 'https://media.api-sports.io/football/players/32966.png');
  assert.equal(cards[0].reason, '守備から前進を作る。');
});


test('parses H3 player headings with inline clubs and keeps following rationale', () => {
  const targetFixture = {
    home: { id: 84, name: 'Nice', logo: 'https://media.api-sports.io/football/teams/84.png' },
    away: { id: 79, name: 'Lille', logo: 'https://media.api-sports.io/football/teams/79.png' },
  };
  const cards = keyPlayers.parsePredictionEntries(
    '### Elye Wahi（Nice）\n前線で背後を取り、ボックス内の脅威になる。\n\n### Berke Özer（Lille）\n至近距離のシュートストップで試合を支える。',
    targetFixture,
  ).filter((entry) => entry.type === 'player');

  assert.deepEqual(cards.map((card) => ({
    name: card.playerName,
    club: card.clubName,
    reason: card.reason,
    teamId: card.teamId,
    side: card.side,
    resolved: card.resolved,
  })), [
    {
      name: 'Elye Wahi',
      club: 'Nice',
      reason: '前線で背後を取り、ボックス内の脅威になる。',
      teamId: 84,
      side: 'home',
      resolved: false,
    },
    {
      name: 'Berke Özer',
      club: 'Lille',
      reason: '至近距離のシュートストップで試合を支える。',
      teamId: 79,
      side: 'away',
      resolved: false,
    },
  ]);
});

test('ignores generic markdown subheadings instead of attaching them to a player rationale', () => {
  const targetFixture = {
    home: { id: 84, name: 'Nice', logo: 'https://media.api-sports.io/football/teams/84.png' },
    away: { id: 79, name: 'Lille', logo: 'https://media.api-sports.io/football/teams/79.png' },
  };
  const entries = keyPlayers.parsePredictionEntries(
    '### Elye Wahi（Nice）\n前線で背後を取る。\n\n### 補足\n### Berke Özer（Lille）\nゴール前を守る。',
    targetFixture,
  ).filter((entry) => entry.type === 'player');

  assert.equal(entries.length, 2);
  assert.equal(entries[0].reason, '前線で背後を取る。');
  assert.equal(entries[1].reason, 'ゴール前を守る。');
});
