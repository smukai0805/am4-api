const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRoundFixtureData, roundLeagueNames, selectFavoriteFixtures } = require("../match-centre.js");

test("round view combines the five major leagues without selecting one of them", () => {
  assert.deepEqual(roundLeagueNames, [
    "プレミアリーグ",
    "ラ・リーガ",
    "セリエA",
    "ブンデスリーガ",
    "リーグ・アン",
  ]);

  const data = mergeRoundFixtureData(roundLeagueNames.map((league, index) => ({
    league,
    data: { fixtures: [{ id: index + 1, competition: league, roundKey: "league-1" }], rounds: [{ key: "league-1", label: "第1節" }] },
  })));
  assert.deepEqual(data.fixtures.filter((fixture) => fixture.roundKey === "league-1").map((fixture) => fixture.competition), roundLeagueNames);
  assert.deepEqual(data.rounds, [{ key: "league-1", label: "第1節" }]);
  assert.deepEqual(data.availableLeagues, roundLeagueNames);
});

test("round view retains only leagues whose fixture data was available", () => {
  const data = mergeRoundFixtureData([
    { league: "プレミアリーグ", data: { fixtures: [{ id: 1, competition: "プレミアリーグ", roundKey: "league-2" }], rounds: [{ key: "league-2", label: "第2節" }] } },
    { league: "ラ・リーガ", data: { fixtures: [{ id: 2, competition: "ラ・リーガ", roundKey: "league-2" }], rounds: [{ key: "league-2", label: "第2節" }] } },
  ]);

  assert.deepEqual(data.availableLeagues, ["プレミアリーグ", "ラ・リーガ"]);
  assert.equal(data.availableLeagues.includes("セリエA"), false);
});

test("favourite league and club fixtures are deduplicated by match id", () => {
  const fixtures = [
    { id: 1, competitionId: 140, competition: "ラ・リーガ", homeId: 541, home: "Real Madrid", awayId: 529, away: "Valencia" },
    { id: 2, competitionId: 39, competition: "プレミアリーグ", homeId: 40, home: "Liverpool", awayId: 42, away: "Arsenal" },
    { id: 3, competitionId: 135, competition: "セリエA", homeId: 505, home: "Inter", awayId: 489, away: "Milan" },
  ];

  assert.deepEqual(
    selectFavoriteFixtures(fixtures, { leagues: ["league-140"], clubs: ["team-541", "team-40"], players: [], articles: [] }).map((fixture) => fixture.id),
    [1, 2],
  );
});

test("legacy club favourite IDs still select their provider fixture", () => {
  const fixtures = [
    { id: 2, competitionId: 39, competition: "プレミアリーグ", homeId: 40, home: "Liverpool", awayId: 42, away: "Arsenal" },
    { id: 3, competitionId: 39, competition: "プレミアリーグ", homeId: 34, home: "Newcastle", awayId: 49, away: "Chelsea" },
  ];
  assert.deepEqual(
    selectFavoriteFixtures(fixtures, { leagues: [], clubs: ["liverpool"], players: [], articles: [] }).map((fixture) => fixture.id),
    [2],
  );
  assert.deepEqual(
    selectFavoriteFixtures(fixtures, { leagues: [], clubs: ["newcastle"], players: [], articles: [] }).map((fixture) => fixture.id),
    [3],
  );
});
