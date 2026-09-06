const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRoundFixtureData, roundLeagueNames } = require("../match-centre.js");

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
