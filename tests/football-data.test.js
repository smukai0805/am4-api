const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, isMatchingPlayerName, selectRelevantFixtures } = require("../football-data.js");

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
