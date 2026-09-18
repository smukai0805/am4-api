import assert from 'node:assert/strict';
import test from 'node:test';

import { generateMatchReportDraft } from '../lib/match-report-core.js';

const matchInfo = {
  fixtureId: 1001,
  homeTeam: 'Home FC',
  awayTeam: 'Away FC',
  homeTeamId: 10,
  awayTeamId: 20,
  homeGoals: 2,
  awayGoals: 1,
  competition: 'Premier League',
  date: '2026-09-16T19:00:00+00:00',
  venue: 'Verified Stadium',
  sourceReferences: [{
    title: 'API-Football fixture 1001: retrieved result, events, and player statistics',
    url: 'https://www.api-football.com/documentation-v3',
  }],
  events: [
    { type: 'Goal', detail: 'Normal Goal', team: { id: 10 }, player: { name: 'Home Scorer One' }, time: { elapsed: 20 } },
    { type: 'Goal', detail: 'Normal Goal', team: { id: 20 }, player: { name: 'Away Scorer' }, time: { elapsed: 44 } },
    { type: 'Goal', detail: 'Normal Goal', team: { id: 10 }, player: { name: 'Home Scorer Two' }, time: { elapsed: 81 } },
  ],
};

const ratingResult = {
  ratings: [
    { name: 'Home Player', team: 'Home FC', minutes: 90, rating: 7.2, comments: ['42分の先制点が勝敗を左右する場面だったため加点'] },
    { name: 'Away Player', team: 'Away FC', minutes: 90, rating: 6.8, comments: ['警告を受けたため減点'] },
  ],
};

test('deterministic report composer uses only supplied verified match and rating values', async () => {
  const result = await generateMatchReportDraft(matchInfo, ratingResult);

  assert.match(result.draft, /Home FC 2-1 Away FC/);
  assert.match(result.draft, /Premier League/);
  assert.match(result.draft, /Verified Stadium/);
  assert.match(result.draft, /Home Player/);
  assert.match(result.draft, /42分の先制点/);
  assert.match(result.draft, /検証済みの得点記録/);
  assert.match(result.draft, /20分：Home FC — Home Scorer One/);
  assert.deepEqual(result.searchSources, matchInfo.sourceReferences);
  assert.equal(/監督|フォーメーション|得点者/u.test(result.draft), true);
  assert.match(result.draft, /検証済み入力には含まれていないため記載しない/);
});

test('deterministic composer omits an unreconciled provider goal timeline', async () => {
  const result = await generateMatchReportDraft({
    ...matchInfo,
    events: [matchInfo.events[0]],
  }, ratingResult);
  assert.equal(result.draft.includes('検証済みの得点記録'), false);
});

test('deterministic composer states a verified penalty winner and safely permits a missing venue', async () => {
  const result = await generateMatchReportDraft({
    ...matchInfo,
    homeGoals: 1,
    awayGoals: 1,
    homePenaltyGoals: 5,
    awayPenaltyGoals: 4,
    status: 'PEN',
    venue: null,
    events: [],
  }, ratingResult);
  assert.match(result.draft, /1-1（PK 5-4）/);
  assert.match(result.draft, /Home FCが勝者/);
  assert.match(result.draft, /会場情報は取得済みの提供データに含まれていない/);
});

test('deterministic composer refuses a penalty fixture with no verified shootout outcome', async () => {
  await assert.rejects(
    generateMatchReportDraft({
      ...matchInfo,
      homeGoals: 1,
      awayGoals: 1,
      status: 'PEN',
      homePenaltyGoals: null,
      awayPenaltyGoals: null,
    }, ratingResult),
    (error) => error?.code === 'REPORT_INPUT_INSUFFICIENT',
  );
});

test('deterministic composer uses team IDs before provider-name differences', async () => {
  const result = await generateMatchReportDraft(matchInfo, {
    ratings: [
      { name: 'Home Player', team: 'Provider Home Alias', teamId: 10, minutes: 90, rating: 7.2 },
      { name: 'Away Player', team: 'Provider Away Alias', teamId: 20, minutes: 90, rating: 6.8 },
    ],
  });
  assert.match(result.draft, /### Home FC/);
  assert.match(result.draft, /### Away FC/);
});

test('deterministic report composer rejects missing match or player evidence', async () => {
  await assert.rejects(
    generateMatchReportDraft({ ...matchInfo, competition: '' }, ratingResult),
    (error) => error?.code === 'REPORT_INPUT_INSUFFICIENT' && error?.retryable === true,
  );
  await assert.rejects(
    generateMatchReportDraft(matchInfo, { ratings: [ratingResult.ratings[0]] }),
    (error) => error?.code === 'REPORT_INPUT_INSUFFICIENT',
  );
});
