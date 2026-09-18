import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateMatchReportMotm,
  motmCardReference,
  selectedMatchReportMotm,
  verifiedMotmCard,
} from '../lib/match-report-motm-data.js';

const fixture = {
  id: 1550125,
  status: 'FT',
  home: { id: 503, name: 'Torino', logo: 'https://media.api-sports.io/football/teams/503.png' },
  away: { id: 497, name: 'AS Roma', logo: 'https://media.api-sports.io/football/teams/497.png' },
};

test('does not treat a passing or abstaining MOTM mention as a player selection', () => {
  assert.equal(selectedMatchReportMotm({
    id: 'notion-match_report-abstain', type: 'match_report',
    report: { keyFigures: 'MOTMは確認できないため、選出は行わない。' },
  }), null);
});

test('hydrates a report-authored MOTM into a structured SSR card without changing selection or rationale', async () => {
  const article = {
    id: 'notion-match_report-example',
    type: 'match_report',
    report: {
      keyFigures: 'MOTM：Paulo Dybala（AS Roma）：決勝点を決め、終盤も前線で違いを作った。',
    },
  };
  const hydrated = await hydrateMatchReportMotm(article, fixture, {
    squadReader: async (team) => team.id === 497 ? [{
      id: 276, name: 'Paulo Dybala', photo: 'https://media.api-sports.io/football/players/276.png', team,
    }] : [],
  });
  const card = hydrated.report.motmCard;
  assert.deepEqual(
    [card.playerName, card.playerId, card.teamId, card.side, card.clubName, card.photoUrl, card.logoUrl, card.resolved],
    ['Paulo Dybala', 276, 497, 'away', 'AS Roma', 'https://media.api-sports.io/football/players/276.png', 'https://media.api-sports.io/football/teams/497.png', true],
  );
  assert.match(card.reason, /決勝点を決め/);
  const reference = motmCardReference(card, fixture);
  assert.equal(reference.player.id, 276);
  assert.equal(reference.team.name, 'AS Roma');
});

test('does not reuse a verified MOTM photo for a newly selected player or an ambiguous name', async () => {
  const prior = {
    playerName: 'Paulo Dybala', playerId: 276, teamId: 497, side: 'away', clubName: 'AS Roma',
    photoUrl: 'https://media.api-sports.io/football/players/276.png',
    logoUrl: 'https://media.api-sports.io/football/teams/497.png', reason: '旧理由', resolved: true,
  };
  const changed = await hydrateMatchReportMotm({
    id: 'notion-match_report-example', type: 'match_report',
    report: { keyFigures: 'MOTM：Lorenzo Pellegrini（AS Roma）：新しい選出理由。', motmCard: prior },
  }, fixture, {
    squadReader: async () => [],
    lineupReader: async () => [],
  });
  assert.equal(changed.report.motmCard, undefined);

  const ambiguous = await hydrateMatchReportMotm({
    id: 'notion-match_report-example', type: 'match_report',
    report: { keyFigures: 'MOTM：Paulo Dybala：選出理由。', motmCard: prior },
  }, fixture, {
    squadReader: async (team) => [
      { id: team.id === 503 ? 1 : 276, name: 'Paulo Dybala', photo: `https://media.api-sports.io/football/players/${team.id}.png`, team },
    ],
    lineupReader: async () => [],
  });
  assert.equal(ambiguous.report.motmCard, undefined);
});

test('retains a same-person verified MOTM card only when provider access fails', async () => {
  const prior = {
    playerName: 'Paulo Dybala', playerId: 276, teamId: 497, side: 'away', clubName: 'AS Roma',
    photoUrl: 'https://media.api-sports.io/football/players/276.png',
    logoUrl: 'https://media.api-sports.io/football/teams/497.png', reason: '決勝点を決めた。', resolved: true,
  };
  assert.ok(verifiedMotmCard(prior, fixture));
  const result = await hydrateMatchReportMotm({
    id: 'notion-match_report-example', type: 'match_report',
    report: { keyFigures: 'MOTM：Paulo Dybala（AS Roma）：終盤の決勝点で試合を決めた。', motmCard: prior },
  }, fixture, {
    squadReader: async () => { throw new Error('429'); },
    lineupReader: async () => { throw new Error('429'); },
  });
  assert.equal(result.report.motmCard.playerId, 276);
  assert.equal(result.report.motmCard.photoUrl, prior.photoUrl);
  assert.match(result.report.motmCard.reason, /終盤の決勝点/);
  assert.doesNotMatch(result.report.motmCard.reason, /決勝点を決めた。$/);
});

test('retains a same-person verified MOTM card when provider responses are empty but not erroneous', async () => {
  const prior = {
    playerName: 'Paulo Dybala', playerId: 276, teamId: 497, side: 'away', clubName: 'AS Roma',
    photoUrl: 'https://media.api-sports.io/football/players/276.png',
    logoUrl: 'https://media.api-sports.io/football/teams/497.png', reason: '旧理由', resolved: true,
  };
  const result = await hydrateMatchReportMotm({
    id: 'notion-match_report-example', type: 'match_report',
    report: { keyFigures: 'MOTM：Paulo Dybala（AS Roma）：終盤の決勝点で試合を決めた。', motmCard: prior },
  }, fixture, {
    squadReader: async () => [],
    lineupReader: async () => [],
  });
  assert.equal(result.report.motmCard.playerId, 276);
  assert.equal(result.report.motmCard.photoUrl, prior.photoUrl);
  assert.match(result.report.motmCard.reason, /終盤の決勝点/);
});

test('does not retain an image on provider failure when the report lacks an exact team anchor', async () => {
  const prior = {
    playerName: 'Paulo Dybala', playerId: 276, teamId: 497, side: 'away', clubName: 'AS Roma',
    photoUrl: 'https://media.api-sports.io/football/players/276.png',
    logoUrl: 'https://media.api-sports.io/football/teams/497.png', reason: '旧理由', resolved: true,
  };
  const result = await hydrateMatchReportMotm({
    id: 'notion-match_report-example', type: 'match_report',
    report: { keyFigures: 'MOTM：Paulo Dybala：新しい選出理由。', motmCard: prior },
  }, fixture, {
    squadReader: async () => { throw new Error('429'); },
    lineupReader: async () => { throw new Error('429'); },
  });
  assert.equal(result.report.motmCard, undefined);
});
