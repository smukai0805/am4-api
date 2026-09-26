const assert = require('node:assert/strict');
const test = require('node:test');

const matchCentre = require('../match-centre.js');

const nationalTeamCompetitions = [
  { competitionId: 1, competition: 'World Cup', competitionCountry: 'World' },
  { competitionId: 4, competition: 'Euro Championship', competitionCountry: 'World' },
  { competitionId: 5, competition: 'UEFA Nations League', competitionCountry: 'World' },
  { competitionId: 10, competition: 'Friendlies', competitionCountry: 'World' },
];
const faCup = { competitionId: 45, competition: 'FA Cup', competitionCountry: 'England' };

test('major national-team competitions stay with FA Cup in the primary daily directory', () => {
  const groups = [...nationalTeamCompetitions, faCup].map((fixture) => ({ fixtures: [fixture] }));
  const partitioned = matchCentre.partitionCompetitionGroups(groups);

  assert.deepEqual(
    partitioned.primary.map((group) => group.fixtures[0].competitionId),
    [1, 4, 5, 10, 45],
  );
  assert.deepEqual(partitioned.other, []);
  assert.deepEqual(
    nationalTeamCompetitions.map((fixture) => matchCentre.competitionDisplayRank(fixture)),
    [-4, -3, -2, -1],
  );
  nationalTeamCompetitions.forEach((fixture) => {
    assert.equal(matchCentre.isPrimaryCompetition(fixture), true);
    assert.ok(
      matchCentre.competitionDisplayRank(fixture) < Number.MAX_SAFE_INTEGER,
      `${fixture.competition} has a stable display rank`,
    );
  });
});

test('national Friendlies match by canonical label only for World fixtures', () => {
  assert.equal(
    matchCentre.isPrimaryCompetition({
      competition: 'Friendlies',
      competitionCountry: 'World',
    }),
    true,
  );
  assert.equal(
    matchCentre.isPrimaryCompetition({
      competition: 'Friendlies',
      competitionCountry: 'England',
    }),
    false,
  );
  assert.equal(
    matchCentre.isPrimaryCompetition({
      competitionId: 667,
      competition: 'Friendlies Clubs',
      competitionCountry: 'World',
    }),
    false,
  );
  assert.equal(
    matchCentre.isPrimaryCompetition({
      competitionId: 666,
      competition: 'Friendlies Women',
      competitionCountry: 'World',
    }),
    false,
  );
});
