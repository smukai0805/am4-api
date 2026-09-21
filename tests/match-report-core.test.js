import assert from 'node:assert/strict';
import test from 'node:test';

import { computePlayerRatings, generateMatchReportDraft } from '../lib/match-report-core.js';

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
  assert.match(result.draft, /## 前半レビュー/);
  assert.match(result.draft, /## 後半レビュー/);
  assert.match(result.draft, /## 得点経過/);
  assert.match(result.draft, /20分：Home FC — Home Scorer One/);
  assert.deepEqual(result.searchSources, matchInfo.sourceReferences);
  assert.equal(result.draft.includes('機械採点'), false);
  assert.equal(result.draft.includes('検証済み入力'), false);
  assert.equal(result.draft.includes('API-Football'), false);
});

test('deterministic composer refuses an unreconciled provider goal timeline instead of publishing a contradiction', async () => {
  await assert.rejects(
    generateMatchReportDraft({
      ...matchInfo,
      events: [matchInfo.events[0]],
    }, ratingResult),
    (error) => error?.code === 'REPORT_INPUT_INSUFFICIENT',
  );
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
    events: [
      { type: 'Goal', detail: 'Normal Goal', team: { id: 10 }, player: { name: 'Home Scorer' }, time: { elapsed: 10 } },
      { type: 'Goal', detail: 'Normal Goal', team: { id: 20 }, player: { name: 'Away Scorer' }, time: { elapsed: 70 } },
    ],
  }, ratingResult);
  assert.match(result.draft, /1-1（PK 5-4）/);
  assert.match(result.draft, /Home FCがPK戦を制し/);
  assert.equal(result.draft.includes('提供データ'), false);
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
  assert.match(result.draft, /Home FC 2-1 Away FC/);
  assert.equal(result.draft.includes('Provider Home Alias'), false);
  assert.equal(result.draft.includes('Provider Away Alias'), false);
});

test('own goals are labelled as own goals and never create a positive scorer contribution', async () => {
  const ownGoalMatch = {
    ...matchInfo,
    homeGoals: 1,
    awayGoals: 0,
    events: [
      { type: 'Goal', detail: 'Own Goal', team: { id: 10 }, player: { id: 99, name: 'Away Defender' }, time: { elapsed: 22 } },
    ],
  };
  const ownGoalRatings = computePlayerRatings([
    {
      team: { id: 10, name: 'Home FC' },
      players: [{ player: { id: 1, name: 'Home Player' }, statistics: [{ games: { minutes: 90, position: 'F' }, goals: { total: 0, assists: 0 }, passes: { key: 0, accuracy: 80 }, dribbles: { success: 0 }, shots: { on: 0 }, duels: { total: 0, won: 0 }, tackles: { total: 0, interceptions: 0, blocks: 0 }, fouls: { committed: 0 }, cards: { yellow: 0, red: 0 } }] }],
    },
    {
      team: { id: 20, name: 'Away FC' },
      players: [{ player: { id: 99, name: 'Away Defender' }, statistics: [{ games: { minutes: 90, position: 'D' }, goals: { total: 0, assists: 0 }, passes: { key: 0, accuracy: 80 }, dribbles: { success: 0 }, shots: { on: 0 }, duels: { total: 0, won: 0 }, tackles: { total: 0, interceptions: 0, blocks: 0 }, fouls: { committed: 0 }, cards: { yellow: 0, red: 0 } }] }],
    },
  ], ownGoalMatch.events, 10, 20, { 10: 0, 20: 1 });
  const defender = ownGoalRatings.ratings.find((entry) => entry.playerId === 99);
  assert.equal(defender.comments.some((comment) => /加点/u.test(comment)), false);

  const result = await generateMatchReportDraft(ownGoalMatch, {
    ratings: [
      { name: 'Home Player', team: 'Home FC', teamId: 10, minutes: 90, rating: 6.0, comments: [] },
      { name: 'Away Defender', team: 'Away FC', teamId: 20, minutes: 90, rating: 6.0, comments: [] },
    ],
  });
  assert.match(result.draft, /22分：Home FC — オウンゴール（Away Defender）/);
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
