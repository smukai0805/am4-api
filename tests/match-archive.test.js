const test = require("node:test");
const assert = require("node:assert/strict");

const {
  archiveArticlesFromSettled,
  canonicalMatchKey,
  filterPublishedArchiveMatches,
  fixtureMatchKey,
  fixtureFromArchiveEditorials,
  matchesPublishedFixtureEditorial,
  publishedFixtureEditorialMatch,
  publishedArchiveQueriesForFixture,
  resolveArchiveEditorials,
} = require("../match-archive.js");

function editorial({
  id,
  type,
  fixtureId = null,
  homeTeam = "Ipswich Town",
  awayTeam = "Liverpool",
  date = "2026-09-04",
  competition = "Premier League",
  status = "published",
  public: isPublic = true,
} = {}) {
  return {
    id,
    type,
    status,
    public: isPublic,
    contentKind: `notion_${type}`,
    notion: { pageId: `${id}-page` },
    match: {
      fixtureId,
      matchKey: `${competition}|${date}|${homeTeam}|${awayTeam}`,
      canonicalKey: canonicalMatchKey({ competition, date, homeTeam, awayTeam }),
      competition,
      date,
      homeTeam,
      awayTeam,
    },
    ...(type === "match_prediction" ? { prediction: { summary: "予想" } } : { report: { summary: "解説" } }),
  };
}

test("a stored fixture ID restores its published prediction and report without a current fixture response", () => {
  const prediction = editorial({ id: "prediction", type: "match_prediction", fixtureId: 1557393 });
  const report = editorial({ id: "report", type: "match_report", fixtureId: 1557393 });
  const result = resolveArchiveEditorials([prediction, report], { fixtureId: 1557393 });

  assert.equal(result.prediction?.id, "prediction");
  assert.equal(result.report?.id, "report");
  assert.equal(result.ambiguous, false);
});

test("Ipswich aliases resolve the exact public archive Match Key when the fixture API no longer has the match", () => {
  // Captured from the public AM4 archive on 2026-09-07. Keeping the durable
  // archive identifier here protects this real regression without contacting
  // production during the unit suite.
  const ipswichReport = editorial({ id: "notion-match_report-3d1b49a367ef81fd9395f3b88addf64a", type: "match_report" });
  const requestedKey = canonicalMatchKey({
    competition: "プレミアリーグ",
    date: "2026-09-04",
    homeTeam: "Ipswich",
    awayTeam: "Liverpool",
  });
  const result = resolveArchiveEditorials([ipswichReport], { canonicalKey: requestedKey });

  assert.equal(requestedKey, "premierleague|2026-09-04|ipswichtown|liverpool");
  assert.equal(result.report?.id, "notion-match_report-3d1b49a367ef81fd9395f3b88addf64a");
  assert.deepEqual(fixtureFromArchiveEditorials(result), {
    archive: true,
    fixture: {
      id: null,
      date: "2026-09-04",
      kickoff: null,
      competition: "Premier League",
      competitionId: null,
      competitionLogo: null,
      competitionCountry: null,
      round: null,
      roundLabel: null,
      status: "ARCHIVE",
      statusLong: "公開済みアーカイブ",
      elapsed: null,
      home: { id: null, name: "Ipswich Town", logo: null },
      away: { id: null, name: "Liverpool", logo: null },
      goals: { home: null, away: null },
      score: { halftime: { home: null, away: null } },
      venue: { name: null, city: null },
      referee: null,
      timezone: null,
    },
  });
});

test("a normal provider fixture restores Ipswich editorial content through its aliased Match Key", () => {
  // The user-facing completed-fixture route is still provider-backed. Its team
  // label is `Ipswich`, whereas the real public editorial uses `Ipswich Town`
  // and has no stored fixtureId. This was the missing normal-page path.
  const providerFixture = {
    id: 1557393,
    date: "2026-09-04",
    competition: "プレミアリーグ",
    home: { name: "Ipswich" },
    away: { name: "Liverpool" },
  };
  const prediction = editorial({
    id: "notion-match_prediction-3ceb49a367ef81dabee4ef9087aaa651",
    type: "match_prediction",
    fixtureId: null,
  });
  const report = editorial({
    id: "notion-match_report-3d1b49a367ef81fd9395f3b88addf64a",
    type: "match_report",
    fixtureId: null,
  });

  assert.deepEqual(publishedArchiveQueriesForFixture(providerFixture), [
    { fixtureId: 1557393 },
    { matchKey: "premierleague|2026-09-04|ipswichtown|liverpool" },
  ]);
  assert.equal(matchesPublishedFixtureEditorial(prediction, providerFixture), true);
  assert.equal(matchesPublishedFixtureEditorial(report, providerFixture), true);
  assert.equal(matchesPublishedFixtureEditorial({ ...report, status: "draft" }, providerFixture), false);
});

test("a reversed formal club name restores a unique public archive editorial without weakening fixture-ID conflicts", () => {
  const providerFixture = {
    id: 1557387,
    date: "2026-09-06",
    competition: "Premier League",
    home: { name: "Arsenal" },
    away: { name: "Chelsea" },
  };
  const report = editorial({
    id: "chelsea-arsenal-report",
    type: "match_report",
    fixtureId: null,
    homeTeam: "Chelsea FC",
    awayTeam: "Arsenal",
    date: "2026-09-06",
  });
  const requestedKey = canonicalMatchKey({
    competition: "Premier League",
    date: "2026-09-06",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
  });
  const resolved = resolveArchiveEditorials([report], { canonicalKey: requestedKey });

  assert.equal(publishedFixtureEditorialMatch(report, providerFixture)?.method, "reversed_canonical_match_key");
  assert.equal(matchesPublishedFixtureEditorial(report, providerFixture), true);
  assert.equal(resolved.report?.id, "chelsea-arsenal-report");
  assert.equal(matchesPublishedFixtureEditorial({ ...report, match: { ...report.match, fixtureId: 999999 } }, providerFixture), false);
});

test("daily fixtures use the kickoff's UTC date for legacy editorial Match Keys", () => {
  // The schedule is grouped by Japan time (September 5), while the archived
  // provider identity was stored on its UTC date (September 4).
  const dailyFixture = {
    id: 1557393,
    date: "2026-09-05",
    kickoff: "2026-09-05T04:00:00+09:00",
    competition: "プレミアリーグ",
    home: "Ipswich",
    away: "Liverpool",
  };
  assert.equal(fixtureMatchKey(dailyFixture), "premierleague|2026-09-04|ipswichtown|liverpool");
  assert.deepEqual(publishedArchiveQueriesForFixture(dailyFixture), [
    { fixtureId: 1557393 },
    { matchKey: "premierleague|2026-09-04|ipswichtown|liverpool" },
  ]);
});

test("CL and EL provider labels share stable editorial competition identities", () => {
  assert.equal(
    canonicalMatchKey({
      competition: "UEFA Champions League",
      date: "2026-09-09",
      homeTeam: "AEK Athens FC",
      awayTeam: "LASK Linz",
    }),
    "championsleague|2026-09-09|aekathens|lasklinz",
  );
  assert.equal(
    canonicalMatchKey({
      competition: "UEFA Europa League",
      date: "2026-09-09",
      homeTeam: "Club Brugge KV",
      awayTeam: "Aston Villa",
    }),
    "europaleague|2026-09-09|bruggekv|astonvilla",
  );
  assert.equal(
    canonicalMatchKey("ヨーロッパリーグ|2026-09-09|Club Brugge KV|Aston Villa"),
    "europaleague|2026-09-09|bruggekv|astonvilla",
  );
});

test("a public article ID anchors its Match Key and keeps seasons with the same clubs separate", () => {
  const priorSeason = editorial({ id: "prior-season", type: "match_report", date: "2025-09-04" });
  const currentSeason = editorial({ id: "current-season", type: "match_report", date: "2026-09-04" });
  const result = resolveArchiveEditorials([priorSeason, currentSeason], {
    articleId: "prior-season",
    canonicalKey: "premierleague|2025-09-04|ipswichtown|liverpool",
  });

  assert.equal(result.report?.id, "prior-season");
  assert.equal(result.canonicalKey, "premierleague|2025-09-04|ipswichtown|liverpool");
  assert.equal(resolveArchiveEditorials([priorSeason, currentSeason], {
    articleId: "prior-season",
    canonicalKey: "premierleague|2026-09-04|ipswichtown|liverpool",
  }).anchorMismatch, true);
});

test("public archive filtering never restores draft, private, non-editorial, or ambiguous articles", () => {
  const published = editorial({ id: "published", type: "match_report" });
  const draft = editorial({ id: "draft", type: "match_report", status: "draft" });
  const privateArticle = editorial({ id: "private", type: "match_report", public: false });
  const story = { ...editorial({ id: "story", type: "match_report" }), type: "am4_story", contentKind: "notion_am4_story" };
  const criteria = { canonicalKey: published.match.canonicalKey };

  assert.deepEqual(filterPublishedArchiveMatches([published, draft, privateArticle, story], criteria).map((article) => article.id), ["published"]);
  assert.equal(resolveArchiveEditorials([draft, privateArticle], criteria).report, null);
  assert.equal(resolveArchiveEditorials([published, { ...published, id: "duplicate" }], criteria).report, null);
  assert.equal(resolveArchiveEditorials([published, { ...published, id: "duplicate" }], criteria).ambiguous, true);
});

test("Match Key archive recovery never rebinds an editorial with a conflicting stored fixture ID", () => {
  const staleFixture = editorial({ id: "stale-fixture", type: "match_report", fixtureId: 999999 });
  const legacy = editorial({ id: "legacy", type: "match_report" });
  const criteria = { canonicalKey: staleFixture.match.canonicalKey };

  assert.deepEqual(
    filterPublishedArchiveMatches([staleFixture, legacy], criteria).map((article) => article.id),
    ["legacy"],
  );
  assert.equal(resolveArchiveEditorials([staleFixture], criteria).report, null);
  assert.equal(resolveArchiveEditorials([staleFixture], {
    fixtureId: 1557393,
    canonicalKey: staleFixture.match.canonicalKey,
  }).report, null);
});

test("a complete reversed pair outranks and a near-name direct pair cannot impersonate it", () => {
  const requestedKey = canonicalMatchKey({
    competition: "Premier League",
    date: "2026-09-06",
    homeTeam: "Manchester United",
    awayTeam: "Liverpool",
  });
  const correctReversed = editorial({
    id: "correct-reversed",
    type: "match_report",
    homeTeam: "Liverpool",
    awayTeam: "Manchester United",
    date: "2026-09-06",
  });
  const nearNameDirect = editorial({
    id: "near-name-direct",
    type: "match_report",
    homeTeam: "Manchester City",
    awayTeam: "Liverpool",
    date: "2026-09-06",
  });

  const result = resolveArchiveEditorials([correctReversed, nearNameDirect], { canonicalKey: requestedKey });

  assert.equal(result.report?.id, "correct-reversed");
  assert.equal(result.ambiguous, false);
});

test("an archive match with no public editorial stays absent instead of fabricating a fixture", () => {
  assert.equal(fixtureFromArchiveEditorials(resolveArchiveEditorials([], {
    canonicalKey: "premierleague|2026-09-04|ipswichtown|liverpool",
  })), null);
});

test("a partial public archive outage keeps the missing editorial type retryable", () => {
  const report = editorial({ id: "report", type: "match_report" });
  const result = archiveArticlesFromSettled([
    { status: "rejected", reason: new Error("prediction archive unavailable") },
    { status: "fulfilled", value: { items: [report] } },
  ], ["match_prediction", "match_report"]);

  assert.deepEqual(result, {
    items: [report],
    unavailable: false,
    partial: true,
    unavailableTypes: ["match_prediction"],
  });
});

test("a total public archive outage remains retryable instead of becoming an absent match", () => {
  const result = archiveArticlesFromSettled([
    { status: "rejected", reason: new Error("prediction archive unavailable") },
    { status: "rejected", reason: new Error("report archive unavailable") },
  ]);

  assert.deepEqual(result, { items: [], unavailable: true });
});
