import test from 'node:test';
import assert from 'node:assert/strict';
import '../column-series.js';

const series = globalThis.AM4ColumnSeries;

test('20 Seasons collection covers the exact 2006-07 through 2025-26 range', () => {
  const seasons = series.seasons();
  assert.equal(seasons.length, 20);
  assert.equal(seasons[0], '2006-07');
  assert.equal(seasons.at(-1), '2025-26');
  assert.equal(series.validSeason('2024 — 25'), '2024-25');
  assert.equal(series.validSeason('2025-27'), null);
});

test('only an explicit 20 Seasons marker can attach an article to the feature', () => {
  const matching = {
    id: 'story-2006',
    title: 'カカ、欧州の王になる',
    story: {
      topicKey: '大会史|20 Seasons, 20 Stories. 2006-07',
      subject: '20 Seasons, 20 Stories. 2006-07シーズン',
    },
  };
  const unrelated = {
    id: 'other-2006',
    title: '2006-07の欧州サッカー',
    story: { topicKey: '大会史|2006-07', subject: '大会史' },
  };

  assert.equal(series.isTwentySeasonsStory(matching), true);
  assert.equal(series.seasonForStory(matching), '2006-07');
  assert.equal(series.isTwentySeasonsStory(unrelated), false);
  assert.equal(series.storiesBySeason([unrelated, matching]).get('2006-07'), matching);
});

test('duplicate stories for a season resolve deterministically without inventing a story', () => {
  const earlier = {
    id: 'earlier',
    publishedAt: '2026-09-01T00:00:00.000Z',
    story: { series: '20 Seasons, 20 Stories.', season: '2008-09' },
  };
  const selected = {
    id: 'selected',
    publishedAt: '2026-09-02T00:00:00.000Z',
    story: { series: '20 Seasons, 20 Stories.', season: '2008-09' },
  };

  assert.equal(series.storiesBySeason([earlier, selected]).get('2008-09'), selected);
  assert.equal(series.storiesBySeason([]).size, 0);
});

test('series navigation skips unpublished seasons and does not invent membership', () => {
  const story = (id, season) => ({id, title:id, story:{series:series.SERIES_NAME,season}});
  const first = story('first', '2006-07');
  const middle = story('middle', '2015-16');
  const last = story('last', '2025-26');
  assert.deepEqual(series.storyNavigation(middle, [last,first,middle]), {
    season:'2015-16', previous:first, next:last,
  });
  assert.equal(series.storyNavigation(first, [first,middle,last]).previous, null);
  assert.equal(series.storyNavigation(last, [first,middle,last]).next, null);
  assert.equal(series.storyNavigation({id:'other',title:'2015-16'}, [first,middle,last]), null);
});
