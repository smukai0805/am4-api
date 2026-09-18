const test = require('node:test');
const assert = require('node:assert/strict');

const matchArchive = require('../match-archive.js');

test('normalizes Brighton & Hove Albion to the provider Brighton identity', () => {
  const editorialKey = matchArchive.canonicalMatchKey(
    'Premier League|2026-09-13|Coventry City|Brighton & Hove Albion',
  );
  const fixtureKey = matchArchive.canonicalMatchKey(
    'Premier League|2026-09-13|Coventry|Brighton',
  );

  assert.equal(editorialKey, fixtureKey);
  assert.equal(editorialKey, 'premierleague|2026-09-13|coventrycity|brightonandhovealbion');
});
