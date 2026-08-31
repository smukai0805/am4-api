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
      dailyFixtures: (date) => request(`/fixtures?date=${encodeURIComponent(date)}`),
      fixtureEvents: (fixtureId) => request(`/fixtures?events=${encodeURIComponent(fixtureId)}`),
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

  function fixtureScoreLabel(fixture) {
    if (fixture?.homeGoals != null && fixture?.awayGoals != null) return `${fixture.homeGoals}-${fixture.awayGoals}`;
    if (fixture?.score && fixture.score !== "-") return String(fixture.score);
    return "";
  }

  function fixtureResultPresentation(fixture, spoilersRevealed = false) {
    const group = classifyFixtureStatus(fixture?.status);
    const score = fixtureScoreLabel(fixture);
    if (group === "finished" && !spoilersRevealed) return { hidden: true, label: "結果を見る" };
    if (group === "live") return { hidden: false, label: `LIVE${score ? ` · ${score}` : ""}` };
    if (group === "finished") return { hidden: false, label: score || "試合終了" };
    return { hidden: false, label: "" };
  }

  const ELITE_CLUBS = new Map([
    [33, { name: "Manchester United", color: "#da291c" }],
    [40, { name: "Liverpool", color: "#c8102e" }],
    [42, { name: "Arsenal", color: "#ef0107" }],
    [47, { name: "Tottenham", color: "#132257" }],
    [49, { name: "Chelsea", color: "#034694" }],
    [50, { name: "Manchester City", color: "#6cabdd" }],
    [529, { name: "Barcelona", color: "#a50044" }],
    [541, { name: "Real Madrid", color: "#febe10" }],
    [530, { name: "Atletico Madrid", color: "#cb3524" }],
    [157, { name: "Bayern Munich", color: "#dc052d" }],
    [165, { name: "Borussia Dortmund", color: "#fde100" }],
    [505, { name: "Inter", color: "#00529f" }],
    [496, { name: "Juventus", color: "#000000" }],
    [489, { name: "AC Milan", color: "#fb090b" }],
    [85, { name: "Paris Saint Germain", color: "#004170" }],
  ]);

  function fixturePrestigePresentation(fixture) {
    const homeClub = ELITE_CLUBS.get(Number(fixture?.homeId));
    const awayClub = ELITE_CLUBS.get(Number(fixture?.awayId));
    const level = homeClub && awayClub ? "marquee" : homeClub || awayClub ? "elite" : "standard";
    return {
      level,
      label: level === "marquee" ? "BIG MATCH" : level === "elite" ? "TOP CLUB" : "",
      homeElite: Boolean(homeClub),
      awayElite: Boolean(awayClub),
      homeColor: homeClub?.color || "#465878",
      awayColor: awayClub?.color || "#465878",
    };
  }

  function filterFixtures(fixtures, { status = "all", favoriteClubIds = [], favoriteClubNames = [], focusOnly = false } = {}) {
    const ids = new Set(favoriteClubIds.map((id) => String(id).replace(/^team-/, "")));
    const names = new Set(favoriteClubNames.map(normalizeName));
    return (fixtures || []).filter((fixture) => {
      if (focusOnly && !fixture.am4Focus) return false;
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

  function sortDailyFixtures(fixtures) {
    return [...(fixtures || [])]
      .filter((fixture) => Number.isFinite(Date.parse(fixture.kickoff)))
      .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  }

  function sortFixturesForViewing(fixtures) {
    const groupOrder = { live: 0, upcoming: 1, finished: 2, other: 3 };
    return [...(fixtures || [])].sort((a, b) => {
      const aOrder = groupOrder[classifyFixtureStatus(a.status)] ?? groupOrder.other;
      const bOrder = groupOrder[classifyFixtureStatus(b.status)] ?? groupOrder.other;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aKickoff = Date.parse(a.kickoff);
      const bKickoff = Date.parse(b.kickoff);
      if (Number.isFinite(aKickoff) && Number.isFinite(bKickoff) && aKickoff !== bKickoff) return aKickoff - bKickoff;
      if (Number.isFinite(aKickoff) !== Number.isFinite(bKickoff)) return Number.isFinite(aKickoff) ? -1 : 1;
      return 0;
    });
  }

  return {
    createClient,
    isMatchingPlayerName,
    selectRelevantFixtures,
    classifyFixtureStatus,
    fixtureResultPresentation,
    fixturePrestigePresentation,
    filterFixtures,
    sortFixturesForViewing,
    sortDailyFixtures,
    tokyoDateKey,
  };
});
