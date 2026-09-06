const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMatchWithArchiveFallback } = require("../match-detail-loader.js");

test("a current provider fixture remains the first path and skips archive reads", async () => {
  let archiveReads = 0;
  const detail = { fixture: { id: 1570368 } };
  const result = await loadMatchWithArchiveFallback({
    fixtureId: 1570368,
    readFixture: async (id) => {
      assert.equal(id, 1570368);
      return detail;
    },
    readArchive: async () => { archiveReads += 1; return { state: "ready" }; },
  });

  assert.deepEqual(result, { state: "fixture", detail });
  assert.equal(archiveReads, 0);
});

test("a provider-missing past fixture restores its public archive instead", async () => {
  const archive = { state: "ready", editorials: { report: { id: "public-report" } } };
  const result = await loadMatchWithArchiveFallback({
    fixtureId: 1557393,
    readFixture: async () => { throw new Error("Football data unavailable (404)"); },
    readArchive: async () => archive,
  });

  assert.deepEqual(result, { state: "archive", archive });
});

test("a missing archive is not confused with a provider outage", async () => {
  const absent = await loadMatchWithArchiveFallback({
    fixtureId: 1557393,
    readFixture: async () => { throw new Error("Football data unavailable (404)"); },
    readArchive: async () => ({ state: "absent" }),
  });
  const unavailable = await loadMatchWithArchiveFallback({
    fixtureId: 1557393,
    readFixture: async () => { throw new Error("Football data unavailable (503)"); },
    readArchive: async () => ({ state: "absent" }),
  });
  const archiveUnavailable = await loadMatchWithArchiveFallback({
    fixtureId: 1557393,
    readFixture: async () => { throw new Error("Football data unavailable (404)"); },
    readArchive: async () => ({ state: "unavailable" }),
  });

  assert.equal(absent.state, "absent");
  assert.equal(unavailable.state, "fixture-unavailable");
  assert.equal(archiveUnavailable.state, "archive-unavailable");
});

test("a direct public archive locator works without a provider fixture ID", async () => {
  const archive = { state: "ready", editorials: { prediction: { id: "public-prediction" } } };
  const result = await loadMatchWithArchiveFallback({
    hasArchiveLocator: true,
    readFixture: async () => { throw new Error("should not read fixture"); },
    readArchive: async () => archive,
  });

  assert.deepEqual(result, { state: "archive", archive });
});
