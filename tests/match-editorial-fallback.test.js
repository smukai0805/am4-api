const test = require("node:test");
const assert = require("node:assert/strict");
const { publishedArchiveCandidates, withPublishedFallback } = require("../match-editorial-fallback.js");

test("a successful but empty live lookup restores both published editorial types", async () => {
  const calls = [];
  const prediction = { id: "published-prediction" };
  const report = { id: "published-report" };

  const result = await withPublishedFallback(
    { prediction: null, report: null, errors: {} },
    async (type) => {
      calls.push(type);
      return type === "match_prediction" ? prediction : report;
    },
  );

  assert.deepEqual(calls, ["match_prediction", "match_report"]);
  assert.equal(result.prediction, prediction);
  assert.equal(result.report, report);
});

test("a live editorial result is preserved and only the missing type uses the archive", async () => {
  const livePrediction = { id: "live-prediction" };
  const archivedReport = { id: "published-report" };
  const calls = [];

  const result = await withPublishedFallback(
    { prediction: livePrediction, report: null, errors: { match_report: "unavailable" } },
    async (type) => {
      calls.push(type);
      return archivedReport;
    },
  );

  assert.deepEqual(calls, ["match_report"]);
  assert.equal(result.prediction, livePrediction);
  assert.equal(result.report, archivedReport);
  assert.deepEqual(result.errors, { match_report: "unavailable" });
});

test("a missing archive entry remains absent without treating it as published", async () => {
  const result = await withPublishedFallback(
    { prediction: null, report: null, errors: {} },
    async () => null,
  );

  assert.equal(result.prediction, null);
  assert.equal(result.report, null);
});

test("an archive retrieval failure remains retryable instead of becoming a false pending state", async () => {
  const result = await withPublishedFallback(
    { prediction: null, report: null, errors: {} },
    async (type) => {
      if (type === "match_prediction") throw new Error("archive unavailable");
      return null;
    },
  );

  assert.deepEqual(result.errors, { match_prediction: "unavailable" });
});

test("a complete public archive-list failure is surfaced to the retry path", async () => {
  const failedLists = [
    { status: "rejected", reason: new Error("fixture archive unavailable") },
    { status: "rejected", reason: new Error("date archive unavailable") },
  ];
  assert.throws(
    () => publishedArchiveCandidates(failedLists),
    /Published AM4 editorial archive unavailable/,
  );

  const result = await withPublishedFallback(
    { prediction: null, report: null, errors: {} },
    async () => publishedArchiveCandidates(failedLists).at(0) || null,
  );

  assert.deepEqual(result.errors, {
    match_prediction: "unavailable",
    match_report: "unavailable",
  });
});
