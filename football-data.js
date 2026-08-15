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
      fixtures: (league, season) => request(`/fixtures?league=${encodeURIComponent(league)}&season=${encodeURIComponent(season)}`),
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

  return { createClient, isMatchingPlayerName, selectRelevantFixtures };
});
