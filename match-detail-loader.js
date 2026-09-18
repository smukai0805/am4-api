(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchDetailLoader = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function validFixtureId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function missingResponse(error) {
    return /(?:\(|\b)404(?:\)|\b)/.test(String(error?.message || ""));
  }

  // Keep the provider as the primary source. Public archival content is read
  // only after a fixture cannot be restored, and a temporary archive failure
  // remains distinct from a genuinely absent match.
  async function loadMatchWithArchiveFallback({ fixtureId, hasArchiveLocator = false, readFixture, readArchive } = {}) {
    const id = validFixtureId(fixtureId);
    if (!id && !hasArchiveLocator) return { state: "missing-input" };

    let fixtureFailure = null;
    if (id) {
      try {
        const detail = await readFixture(id);
        if (detail?.fixture) return { state: "fixture", detail };
        fixtureFailure = new Error("Football data unavailable (404)");
      } catch (error) {
        fixtureFailure = error;
      }
    }

    let archive;
    try {
      archive = await readArchive();
    } catch (_error) {
      return { state: "archive-unavailable" };
    }
    if (archive?.state === "ready") return { state: "archive", archive };
    if (archive?.state === "unavailable") return { state: "archive-unavailable" };
    if (!id || missingResponse(fixtureFailure)) return { state: "absent" };
    return { state: "fixture-unavailable" };
  }

  return { loadMatchWithArchiveFallback };
});
