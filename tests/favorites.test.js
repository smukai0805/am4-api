const test = require('node:test');
const assert = require('node:assert/strict');

const favorites = require('../favorites.js');

test('upgrades verified saved clubs and players from the legacy match-list destination', () => {
  const catalog = favorites.normalizeCatalog({
    'clubs:team-489': { type: 'clubs', id: 'team-489', href: '#fixtures' },
    'players:44': { type: 'players', id: '44', href: '/#fixtures' },
    'clubs:club-name-only': { type: 'clubs', id: 'club-name-only', href: '#fixtures' },
  });

  assert.equal(catalog['clubs:team-489'].href, '/teams/489');
  assert.equal(catalog['players:44'].href, '/players/44');
  assert.equal(catalog['clubs:club-name-only'].href, '#fixtures');
});
