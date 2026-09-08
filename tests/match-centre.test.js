const test = require("node:test");
const assert = require("node:assert/strict");
const {
  competitionCountryLabel,
  competitionAccent,
  competitionDisplayRank,
  isPrimaryCompetition,
  partitionCompetitionGroups,
  contentAvailabilityBatches,
  contentBadgeLabels,
  visibleContentTypes,
  contentAvailabilityForFixture,
  mergeRoundFixtureData,
  partitionFavoriteFixtures,
  roundLeagueNames,
  selectFavoriteFixtures,
  scoreDisplayParts,
} = require("../match-centre.js");

test("finished fixtures only advertise readable reports while upcoming and live predictions remain", () => {
  const types = ["report", "prediction"];
  for (const status of ["FT", "AET", "PEN", "ft"]) {
    assert.deepEqual(visibleContentTypes(types, status), ["report"]);
    assert.deepEqual(visibleContentTypes(["prediction"], status), []);
  }
  for (const status of ["NS", "TBD", "1H", "HT", "2H", "LIVE", "ARCHIVE"]) {
    assert.deepEqual(visibleContentTypes(types, status), types);
  }
  assert.deepEqual(types, ["report", "prediction"]);
  assert.deepEqual(visibleContentTypes(undefined, "FT"), []);
});

test("five major leagues and European club competitions stay outside the drawer", () => {
  for (const competitionId of [39, 140, 135, 78, 61, 2, 3]) {
    assert.equal(isPrimaryCompetition({ competitionId }), true);
  }
  assert.equal(isPrimaryCompetition({ competition: "UEFA Conference League" }), true);
});

test("major domestic cups stay visible using their name and country together", () => {
  for (const [competitionCountry, competition] of [
    ["England", "FA Cup"], ["England", "League Cup"], ["England", "Community Shield"],
    ["Spain", "Copa del Rey"], ["Spain", "Super Cup"],
    ["Italy", "Coppa Italia"], ["Italy", "Super Cup"],
    ["Germany", "DFB Pokal"], ["Germany", "Super Cup"],
    ["France", "Coupe de France"], ["France", "Trophée des Champions"],
  ]) assert.equal(isPrimaryCompetition({ competitionCountry, competition }), true, `${competitionCountry}: ${competition}`);
});

test("other countries, lower divisions, youth and women's cups default to the drawer", () => {
  for (const [competitionCountry, competition] of [
    ["Ghana", "Premier League"], ["Japan", "J1 League"], ["Brazil", "Serie A"],
    ["England", "Championship"], ["England", "FA Youth Cup"], ["England", "FA Cup Women"],
    ["Germany", "2. Bundesliga"], ["France", "Ligue 2"],
    ["Thailand", "FA Cup"], ["Turkey", "Super Cup"], ["World", "Friendlies Clubs"],
    ["", "Super Cup"],
  ]) assert.equal(isPrimaryCompetition({ competitionCountry, competition }), false, `${competitionCountry}: ${competition}`);
});

test("favorite competitions and clubs stay above the drawer without duplicating fixtures", () => {
  const fixtures = [
    { id: 1, competitionId: 98, competition: "J1 League", competitionCountry: "Japan", homeId: 1001 },
    { id: 2, competitionId: 667, competition: "Friendlies Clubs", competitionCountry: "World", homeId: 541 },
    { id: 3, competitionId: 253, competition: "Major League Soccer", competitionCountry: "USA" },
    { id: 4, competitionId: 39, competition: "Premier League", competitionCountry: "England" },
  ];
  const favorites = partitionFavoriteFixtures(fixtures, { leagues: ["league-98"], clubs: ["team-541"] });
  const groups = [
    { isFavoriteGroup: true, fixtures: favorites.clubs },
    { isFavoriteGroup: true, fixtures: favorites.leagues },
    ...favorites.others.map((fixture) => ({ fixtures: [fixture] })),
  ];
  const split = partitionCompetitionGroups(groups);
  assert.deepEqual(split.primary.flatMap((group) => group.fixtures.map((fixture) => fixture.id)), [2, 1, 4]);
  assert.deepEqual(split.other.flatMap((group) => group.fixtures.map((fixture) => fixture.id)), [3]);
  assert.equal(new Set([...split.primary, ...split.other].flatMap((group) => group.fixtures.map((fixture) => fixture.id))).size, 4);
});

test("competition partition keeps ordering and handles days with only other or primary matches", () => {
  const other = [{ competition: "J1 League", competitionCountry: "Japan" }, { competition: "Championship", competitionCountry: "England" }];
  assert.deepEqual(partitionCompetitionGroups(other), { primary: [], other });
  const primary = [{ competitionId: 39 }, { competitionId: 140 }];
  assert.deepEqual(partitionCompetitionGroups(primary), { primary, other: [] });
  assert.deepEqual(partitionCompetitionGroups([]), { primary: [], other: [] });
});

test("hidden scores have identical silhouettes regardless of digit shape or length", () => {
  const concealed = scoreDisplayParts(0, 0, true);
  for (const [home, away] of [[1, 0], [2, 1], [8, 8], [10, 0], [0, 12]]) {
    assert.deepEqual(scoreDisplayParts(home, away, true), concealed);
  }
  assert.deepEqual(scoreDisplayParts(0, 12, false), ["0", "12"]);
});

test("league accents follow verified competition identity across names", () => {
  assert.equal(competitionAccent({ competitionId: 39 }), competitionAccent({ competition: "プレミアリーグ" }));
  assert.notEqual(competitionAccent({ competitionId: 39 }), competitionAccent({ competitionId: 140 }));
  assert.notEqual(competitionAccent({ competitionId: 39 }), competitionAccent({ competition: "Premier League", competitionCountry: "Ghana" }));
});

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
