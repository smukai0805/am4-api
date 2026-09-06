const assert = require('node:assert/strict');
const test = require('node:test');
const {
  matchListUrl,
  normalizeMatchState,
  parseMatchListUrl,
  readHomeState,
  readMatchListState,
  readMatchReturnUrl,
  writeHomeState,
  writeMatchListState,
} = require('../navigation-state.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('match list state accepts only bounded, shareable selection values', () => {
  assert.deepEqual(normalizeMatchState({
    date: '2026-09-06', mode: 'round', filter: 'Regular Season - 4', status: 'live',
    expandedGroups: ['a', 'a', '', 1], spoilersRevealed: true, scrollY: 241.8,
  }), {
    date: '2026-09-06', mode: 'round', filter: 'Regular Season - 4', status: 'live',
    expandedGroups: ['a'], spoilersRevealed: true, scrollY: 242, savedAt: 0,
  });
  assert.deepEqual(normalizeMatchState({ date: '2026-02-30', mode: 'bad', status: 'none', filter: 0 }), {
    date: '', mode: 'date', filter: '', status: 'all', expandedGroups: [], spoilersRevealed: false, scrollY: 0, savedAt: 0,
  });
});

test('match URL keeps shareable filters but never exposes device-only scroll state', () => {
  const url = matchListUrl('/?columnSearch=history#fixtures', {
    date: '2026-09-06', mode: 'round', filter: 'Regular Season - 4', status: 'live', scrollY: 1000,
  });
  assert.equal(url, '/?columnSearch=history&matchDate=2026-09-06&matchMode=round&matchFilter=Regular+Season+-+4&matchStatus=live#fixtures');
  assert.deepEqual(parseMatchListUrl('?matchDate=2026-09-06&matchMode=round&matchFilter=Regular+Season+-+4&matchStatus=live'), {
    date: '2026-09-06', mode: 'round', filter: 'Regular Season - 4', status: 'live', expandedGroups: [], spoilersRevealed: false, scrollY: 0, savedAt: 0,
  });
});

test('fresh device state restores scroll only for the same URL selection and expires safely', () => {
  const storage = memoryStorage();
  const now = 100_000;
  writeMatchListState(storage, {
    date: '2026-09-06', mode: 'date', filter: '2026-09-06', status: 'all', expandedGroups: ['date|x'], scrollY: 650,
    returnUrl: '/?matchDate=2026-09-06#fixtures',
  }, now);
  assert.equal(readMatchListState({ search: '?matchDate=2026-09-06&matchFilter=2026-09-06', storage, now }).scrollY, 650);
  assert.equal(readMatchReturnUrl(storage, '/#fixtures', now), '/?matchDate=2026-09-06#fixtures');
  assert.equal(readMatchListState({ search: '?matchDate=2026-09-07', storage, now }).scrollY, 0);
  assert.equal(readMatchListState({ search: '', storage, now }), null);
  assert.equal(readMatchListState({ storage, now: now + (7 * 60 * 60 * 1000) }), null);
});

test('article return state is internal-only and expires safely', () => {
  const storage = memoryStorage();
  const now = 100_000;
  writeHomeState(storage, { returnUrl: '/?matchDate=2026-09-06#fixtures', scrollY: 333 }, now);
  assert.deepEqual(readHomeState(storage, now), { returnUrl: '/?matchDate=2026-09-06#fixtures', scrollY: 333 });
  writeHomeState(storage, { returnUrl: 'https://example.invalid', scrollY: 10 }, now);
  assert.deepEqual(readHomeState(storage, now), { returnUrl: '/', scrollY: 10 });
  writeHomeState(storage, { returnUrl: '//example.invalid/path', scrollY: 10 }, now);
  assert.deepEqual(readHomeState(storage, now), { returnUrl: '/', scrollY: 10 });
  writeMatchListState(storage, { returnUrl: '//example.invalid/path' }, now);
  assert.equal(readMatchReturnUrl(storage, '/#fixtures', now), '/#fixtures');
  assert.equal(readHomeState(storage, now + (7 * 60 * 60 * 1000)), null);
});
