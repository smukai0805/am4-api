(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchArchive = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Shared match-identity helpers keep provider labels and edited Match Keys
  // aligned at the server-side Notion boundary and in the public archive.
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
    alaves: "deportivoalaves", deportivoalaves: "deportivoalaves",
    coventry: "coventrycity", coventrycity: "coventrycity",
    tottenham: "tottenhamhotspur", tottenhamhotspur: "tottenhamhotspur",
    stuttgart: "vfbstuttgart", vfbstuttgart: "vfbstuttgart",
    cologne: "1fckoln", koln: "1fckoln", "1fckoln": "1fckoln",
    mainz: "mainz05", mainz05: "mainz05",
    lask: "lasklinz", lasklinz: "lasklinz",
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
    uefachampionsleague: "championsleague", ucl: "championsleague", cl: "championsleague",
    "ヨーロッパリーグ": "europaleague", europaleague: "europaleague",
    uefaeuropaleague: "europaleague", uel: "europaleague", el: "europaleague",
  };
  const EDITORIAL_TYPES = new Set(["match_prediction", "match_report"]);
  // Legal/organisational suffixes are not club identities. Do not discard
  // words such as `City` or `United`: they distinguish Manchester City from
  // Manchester United. The narrower list is used both to normalise common
  // "Chelsea FC" style labels and in the bounded relative matcher below.
  const CLUB_DESCRIPTOR_TOKENS = new Set([
    "ac", "afc", "as", "cf", "club", "fc", "football", "rcd", "sc",
  ]);
  // A one-word abbreviation with one of these terms is not enough to infer a
  // club. It may still be resolved through TEAM_KEY_ALIASES, but it cannot
  // turn a different fixture into a relative Match Key match.
  const AMBIGUOUS_SOLO_TEAM_TOKENS = new Set([
    "athletic", "atletico", "borussia", "deportivo", "manchester", "racing", "real",
  ]);

  function normalizedPart(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC")
      .replace(/[^a-z0-9ぁ-んァ-ヶー一-龯]/gi, "")
      .toLowerCase();
  }

  function teamNameWords(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9ぁ-んァ-ヶー一-龯]+/gi, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function normalizedTeam(value) {
    const normalized = normalizedPart(value);
    if (TEAM_KEY_ALIASES[normalized]) return TEAM_KEY_ALIASES[normalized];
    const withoutDescriptors = teamNameWords(value)
      .filter((token) => !CLUB_DESCRIPTOR_TOKENS.has(token))
      .join("");
    return TEAM_KEY_ALIASES[withoutDescriptors] || withoutDescriptors || normalized;
  }

  function teamIdentityTokens(value) {
    return [...new Set(teamNameWords(value)
      .filter((token) => token.length >= 3 && !CLUB_DESCRIPTOR_TOKENS.has(token)))];
  }

  // A soft team match is deliberately narrow: after aliases, every meaningful
  // word in the shorter label must exist in the longer label (for example
  // `Chelsea` in `Chelsea FC`). A common word alone (Manchester in Manchester
  // City / Manchester United) is not enough. It is never used alone; the
  // caller also requires the same competition, date and both teams.
  function teamIdentityStrength(left, right) {
    const leftCanonical = normalizedTeam(left);
    const rightCanonical = normalizedTeam(right);
    if (!leftCanonical || !rightCanonical) return 0;
    if (leftCanonical === rightCanonical) return 2;
    const leftTokens = teamIdentityTokens(left);
    const rightTokens = teamIdentityTokens(right);
    const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
    const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
    if (!shorter.length || !longer.length) return 0;
    if (shorter.length === 1 && AMBIGUOUS_SOLO_TEAM_TOKENS.has(shorter[0])) return 0;
    const longerTokens = new Set(longer);
    return shorter.every((token) => longerTokens.has(token)) ? 1 : 0;
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

  // Returns a ranked, full-match comparison instead of a boolean. This keeps
  // match editorial restoration resilient to formal/short club labels and a
  // reversed home/away entry while avoiding a database-wide fuzzy search.
  function matchIdentityComparison(left, right) {
    const leftParts = matchParts(left);
    const rightParts = matchParts(right);
    if (!leftParts || !rightParts) return null;
    const leftCompetition = normalizedCompetition(leftParts.competition);
    const rightCompetition = normalizedCompetition(rightParts.competition);
    if (
      !validDate(leftParts.date)
      || !validDate(rightParts.date)
      || !leftCompetition
      || !rightCompetition
      || leftCompetition !== rightCompetition
      || validDate(leftParts.date) !== validDate(rightParts.date)
    ) return null;

    const directHome = teamIdentityStrength(leftParts.homeTeam, rightParts.homeTeam);
    const directAway = teamIdentityStrength(leftParts.awayTeam, rightParts.awayTeam);
    if (directHome && directAway) {
      const exact = directHome === 2 && directAway === 2;
      return {
        method: exact ? "canonical_match_key" : "relative_match_key",
        // A fully identified reversal is safer than a direct match where a
        // club label is merely relative. This prevents a weak direct candidate
        // from outranking the known pair written home/away in the opposite
        // order.
        score: exact ? 80 : 65,
        orientation: "direct",
      };
    }

    const reversedHome = teamIdentityStrength(leftParts.homeTeam, rightParts.awayTeam);
    const reversedAway = teamIdentityStrength(leftParts.awayTeam, rightParts.homeTeam);
    if (reversedHome && reversedAway) {
      const exact = reversedHome === 2 && reversedAway === 2;
      return {
        method: exact ? "reversed_canonical_match_key" : "reversed_relative_match_key",
        score: exact ? 75 : 60,
        orientation: "reversed",
      };
    }
    return null;
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

  function publishedFixtureEditorialMatch(article, fixture) {
    if (!isPublishedMatchEditorial(article)) return null;
    const match = articleMatch(article);
    const fixtureId = validFixtureId(fixture?.id ?? fixture?.fixtureId);
    const articleFixtureId = validFixtureId(match?.fixtureId);
    // An explicit fixture ID is the strongest identity. Only records without
    // one can be restored through the complete, aliased Match Key.
    if (articleFixtureId) return fixtureId && articleFixtureId === fixtureId
      ? { method: "fixture_id", score: 100, orientation: "direct" }
      : null;
    const kickoff = Date.parse(fixture?.kickoff);
    const date = Number.isFinite(kickoff)
      ? new Date(kickoff).toISOString().slice(0, 10)
      : fixture?.date;
    return matchIdentityComparison(match, { ...fixture, date });
  }

  function matchesPublishedFixtureEditorial(article, fixture) {
    return Boolean(publishedFixtureEditorialMatch(article, fixture));
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
      const articleFixtureId = validFixtureId(match.fixtureId);
      if (fixtureId) return articleFixtureId === fixtureId;
      // Match Key lookup is solely a legacy recovery path. An article with a
      // persisted provider ID must be found through that ID, never rebound to
      // a different fixture by labels or a stale Match Key.
      return !articleFixtureId && Boolean(matchIdentityComparison(match, canonicalKey));
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
    if (anchor && requestedKey && !matchIdentityComparison(anchorMatch, requestedKey)) {
      return { ...emptyResolution(), anchorMismatch: true };
    }
    const canonicalKey = anchorMatch?.canonicalKey || requestedKey;
    const fixtureId = validFixtureId(criteria.fixtureId);
    const candidates = visible.map((article) => {
      const match = articleMatch(article);
      const articleFixtureId = validFixtureId(match?.fixtureId);
      if (fixtureId && articleFixtureId) {
        return articleFixtureId === fixtureId ? { article, score: 100 } : null;
      }
      // A stored fixture ID is authoritative. Only legacy records without an
      // ID may be resolved through a Match Key or relative label comparison.
      if (articleFixtureId) return null;
      if (!canonicalKey) return null;
      const comparison = matchIdentityComparison(match, canonicalKey);
      return comparison ? { article, score: comparison.score } : null;
    }).filter(Boolean);
    const result = { ...emptyResolution(), canonicalKey };
    for (const type of EDITORIAL_TYPES) {
      const typeCandidates = candidates.filter((entry) => entry.article.type === type);
      const anchored = anchor?.type === type ? anchor : null;
      if (anchored) result[type === "match_prediction" ? "prediction" : "report"] = anchored;
      else if (typeCandidates.length) {
        const strongestScore = Math.max(...typeCandidates.map((entry) => entry.score));
        const strongest = typeCandidates.filter((entry) => entry.score === strongestScore);
        if (strongest.length === 1) result[type === "match_prediction" ? "prediction" : "report"] = strongest[0].article;
        else result.ambiguous = true;
      }
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
    matchIdentityComparison,
    normalizedCompetition,
    normalizedPart,
    normalizedTeam,
    publishedFixtureEditorialMatch,
    publishedArchiveQueriesForFixture,
    resolveArchiveEditorials,
  };
});
