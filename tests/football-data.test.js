const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, isMatchingPlayerName } = require("../football-data.js");

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
