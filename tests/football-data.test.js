const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createClient,
  isMatchingPlayerName,
  selectRelevantFixtures,
  classifyFixtureStatus,
  filterFixtures,
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
