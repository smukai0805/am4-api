(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4FootballData = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function createClient(fetcher, baseUrl = "https://am4-api.vercel.app/api") {
    async function request(path) {
      const response = await fetcher(`${baseUrl}${path}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Football data unavailable (${response.status})`);
      return response.json();
    }
    return {
      fixtures: (league, season) => request(`/fixtures?league=${encodeURIComponent(league)}${season == null ? "" : `&season=${encodeURIComponent(season)}`}`),
      featuredFixtures: () => request('/fixtures?featured=1'),
      standings: (season) => request(`/standings?season=${encodeURIComponent(season)}`),
      playerPhoto: ({ search, fullName, providerId }) => {
        const providerReference = providerId ? `&playerId=${encodeURIComponent(providerId)}` : "";
        return request(`/player-photo?search=${encodeURIComponent(search)}&fullName=${encodeURIComponent(fullName)}${providerReference}`);
      },
      playerStats: (search, team, fullName) => request(`/player-stats?search=${encodeURIComponent(search)}&team=${encodeURIComponent(team)}&fullName=${encodeURIComponent(fullName)}`),
    };
  }

  function normalizeName(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f.]/g, "").toLowerCase().trim();
  }

  function isMatchingPlayerName(actual, expected) {
    const actualParts = normalizeName(actual).split(/\s+/);
    const expectedParts = normalizeName(expected).split(/\s+/);
    return actualParts.length > 1 && expectedParts.length > 1 && actualParts.at(-1) === expectedParts.at(-1);
  }

  function selectRelevantFixtures(fixtures, now = Date.now(), limit = 3) {
    const valid = (fixtures || []).filter((fixture) => Number.isFinite(Date.parse(fixture.kickoff)));
    const upcoming = valid
      .filter((fixture) => Date.parse(fixture.kickoff) >= now)
      .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    if (upcoming.length) return upcoming.slice(0, limit);
    return valid.sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff)).slice(0, limit);
  }

  function classifyFixtureStatus(status) {
    const value = String(status || "").toUpperCase();
    if (["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"].includes(value)) return "live";
    if (["NS", "TBD"].includes(value)) return "upcoming";
    if (["FT", "AET", "PEN"].includes(value)) return "finished";
    return "other";
  }

  function filterFixtures(fixtures, { status = "all", favoriteClubIds = [], favoriteClubNames = [] } = {}) {
    const ids = new Set(favoriteClubIds.map((id) => String(id).replace(/^team-/, "")));
    const names = new Set(favoriteClubNames.map(normalizeName));
    return (fixtures || []).filter((fixture) => {
      if (status !== "all" && classifyFixtureStatus(fixture.status) !== status) return false;
      if (!ids.size && !names.size) return true;
      return ids.has(String(fixture.homeId)) || ids.has(String(fixture.awayId)) ||
        names.has(normalizeName(fixture.home)) || names.has(normalizeName(fixture.away));
    });
  }

  function tokyoDateKey(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(value)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  return { createClient, isMatchingPlayerName, selectRelevantFixtures, classifyFixtureStatus, filterFixtures, tokyoDateKey };
});
