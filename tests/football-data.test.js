const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createClient,
  isMatchingPlayerName,
  selectRelevantFixtures,
  classifyFixtureStatus,
  filterFixtures,
  fixtureResultPresentation,
  fixturePrestigePresentation,
  sortFixturesForViewing,
  sortDailyFixtures,
  tokyoDateKey,
} = require("../football-data.js");

test("client calls the server-side proxy without exposing an API key", async () => {
  let requested;
  const client = createClient(async (url, options) => {
    requested = { url, options };
    return { ok: true, json: async () => ({ response: [] }) };
  });
  await client.fixtures(39, 2026);
  assert.equal(requested.url, "https://am4-api.vercel.app/api/fixtures?league=39&season=2026");
  assert.deepEqual(requested.options.headers, { Accept: "application/json" });
  assert.equal(JSON.stringify(requested).includes("key"), false);
});

test("client reports provider failures", async () => {
  const client = createClient(async () => ({ ok: false, status: 429 }));
  await assert.rejects(() => client.standings(2026), /429/);
});

test("featured fixtures use the server-side curated endpoint", async () => {
  let requested;
  const client = createClient(async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ fixtures: [] }) };
  });
  await client.featuredFixtures();
  assert.equal(requested, "https://am4-api.vercel.app/api/fixtures?featured=1");
});

test("league fixtures can let the server choose the current football season", async () => {
  let requested;
  const client = createClient(async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ fixtures: [] }) };
  });
  await client.fixtures("プレミアリーグ");
  assert.equal(requested, "https://am4-api.vercel.app/api/fixtures?league=%E3%83%97%E3%83%AC%E3%83%9F%E3%82%A2%E3%83%AA%E3%83%BC%E3%82%B0");
});

test("daily fixtures use one cross-competition request for the selected Tokyo date", async () => {
  let requested;
  const client = createClient(async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ fixtures: [] }) };
  });
  await client.dailyFixtures("2026-08-16");
  assert.equal(requested, "https://am4-api.vercel.app/api/fixtures?date=2026-08-16");
});

test("goal events are loaded lazily through the server-side fixture proxy", async () => {
  let requested;
  const client = createClient(async (url, options) => {
    requested = { url, options };
    return { ok: true, json: async () => ({ goals: [] }) };
  });
  await client.fixtureEvents(123456);
  assert.equal(requested.url, "https://am4-api.vercel.app/api/fixtures?events=123456");
  assert.equal(JSON.stringify(requested).includes("apiKey"), false);
});

test("player photos can use a validated API-Football player reference", async () => {
  let requested;
  const client = createClient(async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ photo: "https://example.test/hato.png", name: "J. Hato" }) };
  });
  await client.playerPhoto({ search: "Hato", fullName: "Jorrel Hato", providerId: 341642 });
  assert.equal(requested, "https://am4-api.vercel.app/api/player-photo?search=Hato&fullName=Jorrel%20Hato&playerId=341642");
});

test("player photo association requires the same normalised surname", () => {
  assert.equal(isMatchingPlayerName("Jorrel Hato", "Jorrel Hato"), true);
  assert.equal(isMatchingPlayerName("J. Hato", "Jorrel Hato"), true);
  assert.equal(isMatchingPlayerName("J. Hatok", "Jorrel Hato"), false);
});

test("relevant fixtures prefer the nearest upcoming matches", () => {
  const fixtures = [
    { id: 1, kickoff: "2026-08-14T10:00:00Z" },
    { id: 2, kickoff: "2026-08-16T10:00:00Z" },
    { id: 3, kickoff: "2026-08-15T18:00:00Z" },
  ];
  assert.deepEqual(
    selectRelevantFixtures(fixtures, Date.parse("2026-08-15T00:00:00Z")).map((item) => item.id),
    [3, 2],
  );
});

test("relevant fixtures fall back to the most recent results", () => {
  const fixtures = [
    { id: 1, kickoff: "2026-08-10T10:00:00Z" },
    { id: 2, kickoff: "2026-08-12T10:00:00Z" },
  ];
  assert.deepEqual(
    selectRelevantFixtures(fixtures, Date.parse("2026-08-15T00:00:00Z")).map((item) => item.id),
    [2, 1],
  );
});

test("fixture statuses are grouped into live, upcoming, and finished views", () => {
  assert.equal(classifyFixtureStatus("1H"), "live");
  assert.equal(classifyFixtureStatus("NS"), "upcoming");
  assert.equal(classifyFixtureStatus("FT"), "finished");
  assert.equal(classifyFixtureStatus("CANC"), "other");
});

test("finished scores stay hidden until the visitor chooses to reveal results", () => {
  const fixture = { status: "FT", homeGoals: 3, awayGoals: 1 };
  assert.deepEqual(fixtureResultPresentation(fixture, false), { hidden: true, label: "結果を見る" });
  assert.deepEqual(fixtureResultPresentation(fixture, true), { hidden: false, label: "3-1" });
});

test("live scores remain visible while spoiler protection hides completed results", () => {
  const fixture = { status: "2H", homeGoals: 2, awayGoals: 2 };
  assert.deepEqual(fixtureResultPresentation(fixture, false), { hidden: false, label: "LIVE · 2-2" });
});

test("fixtures can be limited to upcoming matches involving saved clubs", () => {
  const fixtures = [
    { id: 1, status: "NS", homeId: 33, awayId: 40, home: "Manchester United", away: "Liverpool" },
    { id: 2, status: "1H", homeId: 50, awayId: 42, home: "Manchester City", away: "Arsenal" },
    { id: 3, status: "NS", homeId: 47, awayId: 49, home: "Tottenham", away: "Chelsea" },
  ];
  assert.deepEqual(
    filterFixtures(fixtures, { status: "upcoming", favoriteClubIds: ["team-40"] }).map((item) => item.id),
    [1],
  );
});

test("daily fixtures can be limited to major competitions and AM4 focus clubs", () => {
  const fixtures = [
    { id: 1, status: "NS", am4Focus: true },
    { id: 2, status: "NS", am4Focus: false },
  ];
  assert.deepEqual(filterFixtures(fixtures, { focusOnly: true }).map((item) => item.id), [1]);
});

test("fixture date keys follow Japan time across the UTC date boundary", () => {
  assert.equal(tokyoDateKey("2026-08-14T16:30:00Z"), "2026-08-15");
});

test("daily fixtures are shown in chronological order across competitions", () => {
  const fixtures = [
    { id: 3, kickoff: "2026-08-16T23:30:00+09:00", competition: "ラ・リーガ" },
    { id: 1, kickoff: "2026-08-16T19:30:00+09:00", competition: "クラブ親善試合" },
    { id: 2, kickoff: "2026-08-16T23:00:00+09:00", competition: "クラブ親善試合" },
  ];
  assert.deepEqual(sortDailyFixtures(fixtures).map((item) => item.id), [1, 2, 3]);
});

test("today view puts live and upcoming matches before completed matches", () => {
  const fixtures = [
    { id: 1, status: "FT", kickoff: "2026-08-30T00:30:00+09:00" },
    { id: 2, status: "NS", kickoff: "2026-08-30T22:00:00+09:00" },
    { id: 3, status: "2H", kickoff: "2026-08-30T19:00:00+09:00" },
    { id: 4, status: "NS", kickoff: "2026-08-30T20:00:00+09:00" },
  ];
  assert.deepEqual(sortFixturesForViewing(fixtures).map((item) => item.id), [3, 4, 2, 1]);
});

test("fixtures between two selected elite clubs are presented as a big match", () => {
  assert.deepEqual(
    fixturePrestigePresentation({ homeId: 42, awayId: 40 }),
    {
      level: "marquee",
      label: "BIG MATCH",
      homeElite: true,
      awayElite: true,
      homeColor: "#ef0107",
      awayColor: "#c8102e",
    },
  );
});

test("fixtures with one selected elite club get a top-club highlight", () => {
  assert.deepEqual(
    fixturePrestigePresentation({ homeId: 529, awayId: 9999 }),
    {
      level: "elite",
      label: "TOP CLUB",
      homeElite: true,
      awayElite: false,
      homeColor: "#a50044",
      awayColor: "#465878",
    },
  );
});

test("ordinary fixtures remain visually quiet", () => {
  assert.deepEqual(
    fixturePrestigePresentation({ homeId: 9998, awayId: 9999 }),
    {
      level: "standard",
      label: "",
      homeElite: false,
      awayElite: false,
      homeColor: "#465878",
      awayColor: "#465878",
    },
  );
});

test("prestige only breaks ties at the same kickoff time", () => {
  const fixtures = [
    { id: 1, status: "NS", kickoff: "2026-08-30T20:00:00+09:00", homeId: 9998, awayId: 9999 },
    { id: 2, status: "NS", kickoff: "2026-08-30T21:00:00+09:00", homeId: 42, awayId: 40 },
    { id: 3, status: "NS", kickoff: "2026-08-30T20:00:00+09:00", homeId: 529, awayId: 9999 },
  ];
  assert.deepEqual(sortFixturesForViewing(fixtures).map((item) => item.id), [3, 1, 2]);
});

test("fallback fixtures without a provider kickoff remain visible", () => {
  const fixtures = [
    { id: 1, status: "NS", kickoff: "2026-08-30T20:00:00+09:00", homeId: 9998, awayId: 9999 },
    { id: 2, status: "NS", date: "8月31日 20:30", homeId: 33, awayId: 42 },
  ];
  assert.deepEqual(sortFixturesForViewing(fixtures).map((item) => item.id), [1, 2]);
});
