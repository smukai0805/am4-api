const test = require("node:test");
const assert = require("node:assert/strict");
const {
  competitionCountryLabel,
  competitionDisplayRank,
  contentAvailabilityBatches,
  contentBadgeLabels,
  contentAvailabilityForFixture,
  mergeRoundFixtureData,
  partitionFavoriteFixtures,
  roundLeagueNames,
  selectFavoriteFixtures,
} = require("../match-centre.js");

test("European club competitions lead the five major leagues in date view", () => {
  const fixtures = [
    { id: "other", competition: "League Cup", competitionId: 48 },
    { id: "ligue-1", competition: "リーグ・アン", competitionId: 61 },
    { id: "bundesliga", competition: "ブンデスリーガ", competitionId: 78 },
    { id: "serie-a", competition: "セリエA", competitionId: 135 },
    { id: "la-liga", competition: "ラ・リーガ", competitionId: 140 },
    { id: "premier-league", competition: "プレミアリーグ", competitionId: 39 },
    // The provider ID for Conference League is deliberately not assumed here.
    // The public competition name must still keep it with the European group.
    { id: "conference", competition: "UEFA Europa Conference League", competitionId: 9000 },
    { id: "europa", competition: "UEFA Europa League", competitionId: 3 },
    { id: "champions", competition: "UEFA Champions League", competitionId: 2 },
  ];

  assert.deepEqual(
    [...fixtures]
      .sort((left, right) => competitionDisplayRank(left) - competitionDisplayRank(right))
      .map((fixture) => fixture.id),
    ["champions", "europa", "conference", "premier-league", "la-liga", "serie-a", "bundesliga", "ligue-1", "other"],
  );
});

test("European competition aliases stay above domestic leagues when provider labels vary", () => {
  assert.ok(
    competitionDisplayRank({ competition: "Europa League", competitionCountry: "World" })
      < competitionDisplayRank({ competition: "Premier League", competitionCountry: "England" }),
  );
  assert.ok(
    competitionDisplayRank({ competition: "Conference League", competitionCountry: "World" })
      < competitionDisplayRank({ competition: "Premier League", competitionCountry: "England" }),
  );
});

test("generic domestic league names do not impersonate the English Premier League", () => {
  const ghanaPremierLeague = { competition: "Premier League", competitionId: 195, competitionCountry: "Ghana" };
  const englishPremierLeague = { competition: "Premier League", competitionCountry: "England" };
  const brazilianSerieA = { competition: "Serie A", competitionId: 71, competitionCountry: "Brazil" };
  const austrianBundesliga = { competition: "Bundesliga", competitionId: 218, competitionCountry: "Austria" };

  assert.equal(competitionDisplayRank(ghanaPremierLeague), Number.MAX_SAFE_INTEGER);
  assert.equal(competitionCountryLabel(ghanaPremierLeague), "Ghana");
  assert.equal(competitionDisplayRank(englishPremierLeague), 4);
  assert.equal(competitionCountryLabel(englishPremierLeague), "イングランド");
  assert.ok(competitionDisplayRank(brazilianSerieA) > 8);
  assert.equal(competitionCountryLabel(brazilianSerieA), "ブラジル");
  assert.ok(competitionDisplayRank(austrianBundesliga) > 8);
  assert.equal(competitionCountryLabel(austrianBundesliga), "オーストリア");
});

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

test("club favourites lead league favourites and ordinary fixtures without duplicate cards", () => {
  const fixtures = [
    { id: 1, competitionId: 39, competition: "プレミアリーグ", homeId: 40, home: "Liverpool", awayId: 42, away: "Arsenal" },
    { id: 2, competitionId: 39, competition: "プレミアリーグ", homeId: 33, home: "Manchester United", awayId: 34, away: "Newcastle" },
    { id: 3, competitionId: 140, competition: "ラ・リーガ", homeId: 541, home: "Real Madrid", awayId: 529, away: "Valencia" },
    { id: 3, competitionId: 140, competition: "ラ・リーガ", homeId: 541, home: "Real Madrid", awayId: 529, away: "Valencia" },
  ];

  const partitioned = partitionFavoriteFixtures(fixtures, {
    leagues: ["league-39"], clubs: ["team-40"], players: [], articles: [],
  });
  assert.deepEqual(partitioned.clubs.map((fixture) => fixture.id), [1]);
  assert.deepEqual(partitioned.leagues.map((fixture) => fixture.id), [2]);
  assert.deepEqual(partitioned.others.map((fixture) => fixture.id), [3]);
  assert.deepEqual([...partitioned.clubs, ...partitioned.leagues, ...partitioned.others].map((fixture) => fixture.id), [1, 2, 3]);
});

test("article availability covers every fixture in bounded API batches", () => {
  const fixtures = Array.from({ length: 61 }, (_, index) => ({ id: index + 1 }));
  assert.deepEqual(contentAvailabilityBatches(fixtures), [
    Array.from({ length: 50 }, (_, index) => index + 1),
    Array.from({ length: 11 }, (_, index) => index + 51),
  ]);
});

test("editorial badges use compact Japanese labels unless the page is English", () => {
  assert.deepEqual(contentBadgeLabels('ja'), { prediction: '予想あり', report: '解説あり' });
  assert.deepEqual(contentBadgeLabels('en-GB'), { prediction: 'PREDICTION', report: 'MATCH REPORT' });
});

test("match card availability merges the exact public Match Key with its fixture ID", () => {
  const previousArchive = globalThis.AM4MatchArchive;
  globalThis.AM4MatchArchive = require("../match-archive.js");
  try {
    assert.deepEqual(contentAvailabilityForFixture({
      availability: { 1557393: [] },
      matchAvailability: { 'premierleague|2026-09-04|ipswichtown|liverpool': ['prediction', 'report'] },
    }, {
      id: 1557393,
      date: '2026-09-05',
      kickoff: '2026-09-05T04:00:00+09:00',
      competition: 'プレミアリーグ',
      home: 'Ipswich',
      away: 'Liverpool',
    }), ['prediction', 'report']);
  } finally {
    globalThis.AM4MatchArchive = previousArchive;
  }
});

test("malformed Match Key availability cannot erase the fixture-ID badges", () => {
  const previousArchive = globalThis.AM4MatchArchive;
  globalThis.AM4MatchArchive = require("../match-archive.js");
  try {
    assert.deepEqual(contentAvailabilityForFixture({
      availability: { 1557393: ['report'] },
      matchAvailability: { 'premierleague|2026-09-04|ipswichtown|liverpool': 'not-an-array' },
    }, {
      id: 1557393,
      date: '2026-09-04',
      competition: 'プレミアリーグ',
      home: 'Ipswich',
      away: 'Liverpool',
    }), ['report']);
  } finally {
    globalThis.AM4MatchArchive = previousArchive;
  }
});
