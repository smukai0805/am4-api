(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchArchive = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // This is an explicit identity registry, not fuzzy matching. It is shared by
  // the server-side Notion boundary and the public archive so provider labels
  // and edited Match Keys stay aligned.
  const TEAM_KEY_ALIASES = {
    acmilan: "acmilan", milan: "acmilan",
    internazionale: "inter", inter: "inter", intermilan: "inter",
    manchesterunited: "manchesterunited", manunited: "manchesterunited",
    parissaintgermain: "parissaintgermain", psg: "parissaintgermain",
    atleticomadrid: "atleticomadrid",
    malaga: "malaga",
    bayernmunchen: "bayernmuenchen", bayernmunich: "bayernmuenchen",
    borussiamonchengladbach: "borussiamonchengladbach", borussiamgladbach: "borussiamonchengladbach",
    newcastle: "newcastleunited", newcastleunited: "newcastleunited",
    bournemouth: "bournemouth", afcbournemouth: "bournemouth",
    brighton: "brightonandhovealbion", brightonandhovealbion: "brightonandhovealbion",
    leeds: "leedsunited", leedsunited: "leedsunited",
    ipswich: "ipswichtown", ipswichtown: "ipswichtown",
    celta: "celtavigo", celtavigo: "celtavigo",
    coventry: "coventrycity", coventrycity: "coventrycity",
    tottenham: "tottenhamhotspur", tottenhamhotspur: "tottenhamhotspur",
    stuttgart: "vfbstuttgart", vfbstuttgart: "vfbstuttgart",
    cologne: "1fckoln", koln: "1fckoln", "1fckoln": "1fckoln",
    mainz: "mainz05", mainz05: "mainz05",
    paderborn: "scpaderborn", scpaderborn: "scpaderborn",
    freiburg: "scfreiburg", scfreiburg: "scfreiburg",
    deportivo: "deportivolacoruna", rcdeportivo: "deportivolacoruna", deportivolacoruna: "deportivolacoruna",
  };
  const COMPETITION_ALIASES = {
    "プレミアリーグ": "premierleague", premierleague: "premierleague",
    "ラリーガ": "laliga", laliga: "laliga",
    "セリエa": "seriea", seriea: "seriea",
    "ブンデスリーガ": "bundesliga", bundesliga: "bundesliga",
    "リーグアン": "ligue1", ligue1: "ligue1",
    "チャンピオンズリーグ": "championsleague", championsleague: "championsleague",
  };
  const EDITORIAL_TYPES = new Set(["match_prediction", "match_report"]);

  function normalizedPart(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC")
      .replace(/[^a-z0-9ぁ-んァ-ヶー一-龯]/gi, "")
      .toLowerCase();
  }

  function normalizedTeam(value) {
    const normalized = normalizedPart(value);
    return TEAM_KEY_ALIASES[normalized] || normalized;
  }

  function normalizedCompetition(value) {
    const normalized = normalizedPart(value);
    return COMPETITION_ALIASES[normalized] || normalized;
  }

  function validDate(value) {
    const date = String(value || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }

  function matchParts(value) {
    if (typeof value === "string") {
      const parts = value.split("|").map((part) => part.trim());
      return parts.length === 4
        ? { competition: parts[0], date: parts[1], homeTeam: parts[2], awayTeam: parts[3] }
        : null;
    }
    if (!value || typeof value !== "object") return null;
    return {
      competition: value.competition,
      date: value.date,
      homeTeam: value.homeTeam || value.home?.name || value.home,
      awayTeam: value.awayTeam || value.away?.name || value.away,
    };
  }

  function canonicalMatchKey(value) {
    const parts = matchParts(value);
    if (!parts) return null;
    const canonical = [
      normalizedCompetition(parts.competition),
      validDate(parts.date),
      normalizedTeam(parts.homeTeam),
      normalizedTeam(parts.awayTeam),
    ];
    return canonical.every(Boolean) ? canonical.join("|") : null;
  }

  function articleMatch(article) {
    const match = article?.match;
    if (!match) return null;
    const canonicalKey = canonicalMatchKey(match);
    if (!canonicalKey) return null;
    return { ...match, canonicalKey };
  }

  function isPublishedMatchEditorial(article) {
    if (!EDITORIAL_TYPES.has(article?.type) || article?.status !== "published" || article?.public === false) return false;
    if (article?.contentKind && article.contentKind !== `notion_${article.type}`) return false;
    return Boolean(articleMatch(article));
  }

  function validFixtureId(value) {
    const fixtureId = Number(value);
    return Number.isInteger(fixtureId) && fixtureId > 0 ? fixtureId : null;
  }

  // Schedules are grouped by the reader's local timezone, whereas historic
  // Match Keys retain the provider's UTC fixture date. Use the instant itself
  // when it is available so a late-night Japan kickoff remains discoverable.
  function fixtureMatchKey(fixture) {
    const kickoff = Date.parse(fixture?.kickoff);
    const date = Number.isFinite(kickoff)
      ? new Date(kickoff).toISOString().slice(0, 10)
      : fixture?.date;
    return canonicalMatchKey({ ...fixture, date });
  }

  // Normal detail pages still have a provider fixture, but an older public
  // editorial may only have a Match Key. Keep this identity logic here so the
  // normal and provider-missing archive paths use the same explicit aliases.
  function publishedArchiveQueriesForFixture(fixture) {
    const fixtureId = validFixtureId(fixture?.id ?? fixture?.fixtureId);
    const matchKey = fixtureMatchKey(fixture);
    const queries = [];
    if (fixtureId) queries.push({ fixtureId });
    if (matchKey) queries.push({ matchKey });
    return queries;
  }

  function matchesPublishedFixtureEditorial(article, fixture) {
    if (!isPublishedMatchEditorial(article)) return false;
    const match = articleMatch(article);
    const fixtureId = validFixtureId(fixture?.id ?? fixture?.fixtureId);
    const articleFixtureId = validFixtureId(match?.fixtureId);
    // An explicit fixture ID is the strongest identity. Only records without
    // one can be restored through the complete, aliased Match Key.
    if (articleFixtureId) return Boolean(fixtureId && articleFixtureId === fixtureId);
    const fixtureKey = fixtureMatchKey(fixture);
    return Boolean(fixtureKey && match?.canonicalKey === fixtureKey);
  }

  function criteriaKey(criteria = {}) {
    return canonicalMatchKey(criteria.canonicalKey || criteria.matchKey);
  }

  function filterPublishedArchiveMatches(articles, criteria = {}) {
    const fixtureId = validFixtureId(criteria.fixtureId);
    const canonicalKey = criteriaKey(criteria);
    if (!fixtureId && !canonicalKey) return [];
    return (articles || []).filter((article) => {
      if (!isPublishedMatchEditorial(article)) return false;
      const match = articleMatch(article);
      return fixtureId
        ? validFixtureId(match.fixtureId) === fixtureId
        : match.canonicalKey === canonicalKey;
    });
  }

  function archiveArticlesFromSettled(results, types = []) {
    const fulfilled = (results || []).filter((result) => result?.status === "fulfilled");
    const unavailableTypes = (results || []).flatMap((result, index) => (
      result?.status === "rejected" && types[index] ? [types[index]] : []
    ));
    if (!fulfilled.length) return { items: [], unavailable: true };
    const items = new Map();
    fulfilled.forEach((result) => {
      (result.value?.items || []).forEach((article) => {
        if (article?.id) items.set(article.id, article);
      });
    });
    return {
      items: [...items.values()],
      unavailable: false,
      partial: unavailableTypes.length > 0,
      unavailableTypes,
    };
  }

  function emptyResolution() {
    return { prediction: null, report: null, canonicalKey: null, ambiguous: false, anchorMismatch: false };
  }

  // One public article ID is a stronger anchor than a URL string. It also makes
  // every archive route validate against a known, publicly readable article.
  function resolveArchiveEditorials(articles, criteria = {}) {
    const visible = (articles || []).filter(isPublishedMatchEditorial);
    const anchor = criteria.articleId
      ? visible.find((article) => article.id === criteria.articleId) || null
      : null;
    const requestedKey = criteriaKey(criteria);
    const anchorMatch = anchor && articleMatch(anchor);
    if (anchor && requestedKey && anchorMatch.canonicalKey !== requestedKey) {
      return { ...emptyResolution(), anchorMismatch: true };
    }
    const canonicalKey = anchorMatch?.canonicalKey || requestedKey;
    const fixtureId = validFixtureId(criteria.fixtureId);
    const candidates = canonicalKey
      ? visible.filter((article) => articleMatch(article)?.canonicalKey === canonicalKey)
      : fixtureId
        ? visible.filter((article) => validFixtureId(articleMatch(article)?.fixtureId) === fixtureId)
        : [];
    const result = { ...emptyResolution(), canonicalKey };
    for (const type of EDITORIAL_TYPES) {
      const typeCandidates = candidates.filter((article) => article.type === type);
      const anchored = anchor?.type === type ? anchor : null;
      if (anchored) result[type === "match_prediction" ? "prediction" : "report"] = anchored;
      else if (typeCandidates.length === 1) result[type === "match_prediction" ? "prediction" : "report"] = typeCandidates[0];
      else if (typeCandidates.length > 1) result.ambiguous = true;
    }
    return result;
  }

  function fixtureFromArchiveEditorials(editorials) {
    const article = editorials?.prediction || editorials?.report;
    const match = articleMatch(article);
    if (!match) return null;
    return {
      archive: true,
      fixture: {
        id: validFixtureId(match.fixtureId),
        date: validDate(match.date),
        kickoff: null,
        competition: match.competition,
        competitionId: null,
        competitionLogo: null,
        competitionCountry: null,
        round: null,
        roundLabel: null,
        status: "ARCHIVE",
        statusLong: "公開済みアーカイブ",
        elapsed: null,
        home: { id: validFixtureId(match.homeTeamId), name: match.homeTeam, logo: null },
        away: { id: validFixtureId(match.awayTeamId), name: match.awayTeam, logo: null },
        goals: { home: null, away: null },
        score: { halftime: { home: null, away: null } },
        venue: { name: null, city: null },
        referee: null,
        timezone: null,
      },
    };
  }

  return {
    archiveArticlesFromSettled,
    canonicalMatchKey,
    filterPublishedArchiveMatches,
    fixtureMatchKey,
    fixtureFromArchiveEditorials,
    isPublishedMatchEditorial,
    matchesPublishedFixtureEditorial,
    normalizedCompetition,
    normalizedPart,
    normalizedTeam,
    publishedArchiveQueriesForFixture,
    resolveArchiveEditorials,
  };
});
