(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchCentre = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const LEAGUE_PREVIEW_LIMIT = 4;
  const LEAGUE_GROUP_PREVIEW_LIMIT = 6;
  const LEAGUE_GROUP_BATCH_SIZE = 6;
  const LIVE_DAILY_REFRESH_MS = 30_000;
  const KICKOFF_RECHECK_BUFFER_MS = 30_000;
  // Date view keeps European club competitions ahead of domestic leagues.
  // Conference League is matched by its canonical public names instead of an
  // unverified provider ID, so an ID change cannot quietly move it down.
  const EUROPEAN_COMPETITIONS = [
    { providerId: 2, rank: 1, country: "Europe", names: ["チャンピオンズリーグ", "UEFA Champions League", "Champions League"] },
    { providerId: 3, rank: 2, country: "Europe", names: ["ヨーロッパリーグ", "UEFA Europa League", "Europa League"] },
    { providerId: null, rank: 3, country: "Europe", names: ["カンファレンスリーグ", "ヨーロッパカンファレンスリーグ", "UEFA Europa Conference League", "UEFA Conference League", "Europa Conference League", "Conference League"] },
  ];
  const MAJOR_LEAGUES = [
    { providerId: 39, rank: 4, competition: "プレミアリーグ", country: "England", names: ["プレミアリーグ", "Premier League"] },
    { providerId: 140, rank: 5, competition: "ラ・リーガ", country: "Spain", names: ["ラ・リーガ", "La Liga"] },
    { providerId: 135, rank: 6, competition: "セリエA", country: "Italy", names: ["セリエA", "Serie A"] },
    { providerId: 78, rank: 7, competition: "ブンデスリーガ", country: "Germany", names: ["ブンデスリーガ", "Bundesliga"] },
    { providerId: 61, rank: 8, competition: "リーグ・アン", country: "France", names: ["リーグ・アン", "Ligue 1"] },
  ];
  const PRIORITY_COMPETITIONS = [...EUROPEAN_COMPETITIONS, ...MAJOR_LEAGUES];
  // 節別の「すべて」は、日別の全大会とは異なり5大リーグだけを同じ節で
  // 横断する。並び順もここを唯一の定義にして、リーグ選択の状態とは分離する。
  const ROUND_LEAGUES = MAJOR_LEAGUES.map(({ competition }) => competition);
  // 日別の「すべて」はクラブではなく大会単位で案内する。お気に入りの次に
  // 欧州大会、5大リーグ、主要国内リーグの順で置き、未登録の大会は開始時刻順。
  const COMPETITION_DISPLAY_ORDER = new Map([
    ...PRIORITY_COMPETITIONS
      .filter(({ providerId }) => Number.isInteger(providerId) && providerId > 0)
      .map(({ providerId, rank }) => [providerId, rank]),
    [88, 9], [94, 10], [144, 11], [179, 12], [203, 13],
    [218, 14], [207, 15], [119, 16], [113, 17], [103, 18],
    [106, 19], [332, 20], [345, 21], [71, 22], [128, 23],
    [253, 24], [262, 25], [98, 26], [292, 27],
  ]);
  const COMPETITION_LOGOS = new Map([
    ["プレミアリーグ", 39], ["Premier League", 39],
    ["ラ・リーガ", 140], ["La Liga", 140],
    ["セリエA", 135], ["Serie A", 135],
    ["ブンデスリーガ", 78], ["Bundesliga", 78],
    ["リーグ・アン", 61], ["Ligue 1", 61],
    ["チャンピオンズリーグ", 2], ["UEFA Champions League", 2], ["Champions League", 2],
    ["ヨーロッパリーグ", 3], ["UEFA Europa League", 3], ["Europa League", 3],
    ["クラブ親善試合", 667], ["Club Friendlies", 667],
  ]);
  const COMPETITION_COUNTRIES = new Map([
    ["プレミアリーグ", "England"], ["Premier League", "England"],
    ["ラ・リーガ", "Spain"], ["La Liga", "Spain"],
    ["セリエA", "Italy"], ["Serie A", "Italy"],
    ["ブンデスリーガ", "Germany"], ["Bundesliga", "Germany"],
    ["リーグ・アン", "France"], ["Ligue 1", "France"],
    ["チャンピオンズリーグ", "Europe"], ["UEFA Champions League", "Europe"],
    ["ヨーロッパリーグ", "Europe"], ["UEFA Europa League", "Europe"],
    ["カンファレンスリーグ", "Europe"], ["UEFA Europa Conference League", "Europe"],
  ]);
  const COUNTRY_LABELS = new Map([
    ["England", "イングランド"], ["Spain", "スペイン"], ["Italy", "イタリア"],
    ["Germany", "ドイツ"], ["France", "フランス"], ["Europe", "欧州"],
    ["World", "国際"], ["International", "国際"], ["Netherlands", "オランダ"],
    ["Portugal", "ポルトガル"], ["Belgium", "ベルギー"], ["Scotland", "スコットランド"],
    ["Turkey", "トルコ"], ["Greece", "ギリシャ"], ["Austria", "オーストリア"],
    ["Switzerland", "スイス"], ["Denmark", "デンマーク"], ["Norway", "ノルウェー"],
    ["Sweden", "スウェーデン"], ["Poland", "ポーランド"], ["Czech-Republic", "チェコ"],
    ["Croatia", "クロアチア"], ["Serbia", "セルビア"], ["Romania", "ルーマニア"],
    ["Ukraine", "ウクライナ"], ["Georgia", "ジョージア"], ["USA", "アメリカ"],
    ["Brazil", "ブラジル"], ["Argentina", "アルゼンチン"], ["Mexico", "メキシコ"],
    ["Japan", "日本"], ["South-Korea", "韓国"], ["Australia", "オーストラリア"],
  ]);

  function normalizedCompetitionLabel(value) {
    return String(value || "").trim().toLocaleLowerCase("en-US");
  }

  function priorityCompetitionForFixture(fixture) {
    const providerLeagueId = Number(fixture?.competitionId);
    const byProviderId = PRIORITY_COMPETITIONS.find(({ providerId }) => providerId === providerLeagueId);
    if (byProviderId) return byProviderId;
    const label = normalizedCompetitionLabel(fixture?.competition);
    return PRIORITY_COMPETITIONS.find(({ names }) =>
      names.some((name) => normalizedCompetitionLabel(name) === label),
    ) || null;
  }

  function competitionDisplayRank(fixture) {
    const providerLeagueId = Number(fixture?.competitionId);
    if (COMPETITION_DISPLAY_ORDER.has(providerLeagueId)) return COMPETITION_DISPLAY_ORDER.get(providerLeagueId);
    return priorityCompetitionForFixture(fixture)?.rank || Number.MAX_SAFE_INTEGER;
  }

  function mergeRoundFixtureData(leagueData) {
    const roundsByKey = new Map();
    const availableLeagues = [];
    const fixtures = [];
    (leagueData || []).forEach((entry) => {
      const data = entry?.data || entry;
      if (!Array.isArray(data?.fixtures)) return;
      const league = entry?.league || data.league;
      if (league && !availableLeagues.includes(league)) availableLeagues.push(league);
      fixtures.push(...data.fixtures);
      (data.rounds || []).forEach((round) => {
        if (round?.key && !roundsByKey.has(round.key)) roundsByKey.set(round.key, round);
      });
    });
    return { fixtures, rounds: [...roundsByKey.values()], availableLeagues };
  }
  const TEAM_ACCENTS = new Map([
    // Premier League
    ["Arsenal", "#ef0107"], ["Aston Villa", "#95bfe5"], ["Bournemouth", "#da291c"], ["Brentford", "#e30613"],
    ["Brighton", "#0057b8"], ["Brighton & Hove Albion", "#0057b8"], ["Burnley", "#6c1d45"], ["Chelsea", "#034694"],
    ["Crystal Palace", "#1b458f"], ["Everton", "#003399"], ["Fulham", "#cc0000"], ["Leeds", "#ffcd00"],
    ["Liverpool", "#c8102e"], ["Manchester City", "#6cabdd"], ["Manchester United", "#da291c"], ["Newcastle", "#e8edf2"],
    ["Newcastle United", "#e8edf2"], ["Nottingham Forest", "#dd0000"], ["Sunderland", "#e31b23"], ["Tottenham", "#d9e5f4"],
    ["Tottenham Hotspur", "#d9e5f4"], ["West Ham", "#7a263a"], ["West Ham United", "#7a263a"], ["Wolves", "#fdb913"],
    ["Wolverhampton Wanderers", "#fdb913"], ["Ipswich", "#2d5ba8"], ["Leicester", "#003090"], ["Leicester City", "#003090"],
    ["Southampton", "#d71920"],
    // La Liga
    ["Alaves", "#0050a4"], ["Athletic Club", "#e61d35"], ["Atletico Madrid", "#cb3524"], ["Atlético Madrid", "#cb3524"],
    ["Barcelona", "#a50044"], ["Real Betis", "#0b7a3e"], ["Celta Vigo", "#6fc7ef"], ["Elche", "#117a37"],
    ["Espanyol", "#007fc8"], ["Getafe", "#0051a5"], ["Girona", "#d50032"], ["Levante", "#005baa"],
    ["Mallorca", "#e20613"], ["Osasuna", "#c8102e"], ["Rayo Vallecano", "#e30613"], ["Real Madrid", "#d6ad45"],
    ["Real Oviedo", "#003da5"], ["Real Sociedad", "#0067b1"], ["Sevilla", "#d71920"], ["Valencia", "#f58220"],
    ["Villarreal", "#ffe667"], ["Malaga", "#1a76ba"], ["Deportivo La Coruna", "#5c5db1"],
    // Serie A
    ["Atalanta", "#1e71b8"], ["Bologna", "#b1252a"], ["Cagliari", "#bd2637"], ["Como", "#2777bb"],
    ["Cremonese", "#d71920"], ["Fiorentina", "#4f2683"], ["Genoa", "#be2638"], ["Inter", "#1b5fa7"],
    ["Juventus", "#d4af37"], ["Lazio", "#79c7e9"], ["Lecce", "#f6c400"], ["Milan", "#e31b23"],
    ["AC Milan", "#e31b23"], ["Napoli", "#1497d4"], ["Parma", "#f5d000"], ["Pisa", "#005baa"],
    ["Roma", "#8e1f2f"], ["AS Roma", "#8e1f2f"], ["Sassuolo", "#008c45"], ["Torino", "#7d1f2a"], ["Udinese", "#171717"], ["Verona", "#1f4e9b"],
    ["Hellas Verona", "#1f4e9b"], ["Empoli", "#0068b3"], ["Monza", "#e30613"], ["Venezia", "#f58220"],
    // Bundesliga
    ["Bayern Munich", "#dc052d"], ["Bayer Leverkusen", "#e32219"], ["Borussia Dortmund", "#fdeb00"],
    ["Borussia Monchengladbach", "#000000"], ["Borussia Mönchengladbach", "#000000"], ["Eintracht Frankfurt", "#e1000f"],
    ["FC Augsburg", "#bb2635"], ["FC Cologne", "#ed1c24"], ["FC Köln", "#ed1c24"], ["Freiburg", "#e30613"],
    ["Hamburger SV", "#005ca9"], ["Heidenheim", "#e30613"], ["Hoffenheim", "#1d4f91"], ["Mainz", "#c3142d"],
    ["RB Leipzig", "#dd0741"], ["St. Pauli", "#6c3a2d"], ["Union Berlin", "#e30613"], ["VfB Stuttgart", "#e32219"],
    ["Werder Bremen", "#009a44"], ["Wolfsburg", "#65b32e"], ["FC Schalke 04", "#005ca9"], ["Hertha Berlin", "#005ca9"],
    // Ligue 1
    ["Auxerre", "#1c4aa0"], ["Brest", "#e30613"], ["Le Havre", "#6ab2e7"], ["Lens", "#f9d616"],
    ["Lille", "#d71920"], ["Lorient", "#f58220"], ["Lyon", "#1d4f91"], ["Marseille", "#00a8e6"],
    ["Metz", "#7d1f2a"], ["Monaco", "#d9222a"], ["Nantes", "#f8e71c"], ["Nice", "#d71920"],
    ["Paris FC", "#173f8a"], ["Paris Saint Germain", "#004170"], ["Paris Saint-Germain", "#004170"],
    ["PSG", "#004170"], ["Rennes", "#e51c2a"], ["Strasbourg", "#0066b3"], ["Toulouse", "#5b2c83"],
    ["Le Mans", "#d23b36"], ["Angers", "#1f1f1f"], ["Reims", "#e30613"], ["Saint Etienne", "#00853f"],
    ["Saint-Étienne", "#00853f"], ["Montpellier", "#f58220"],
  ]);
  function normalizeTeamName(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
  }
  const NORMALIZED_TEAM_ACCENTS = new Map(
    [...TEAM_ACCENTS].map(([name, accent]) => [normalizeTeamName(name), accent]),
  );
  // Before provider IDs were available in the match UI, a small set of club
  // favourites used these human-readable IDs. Keep them readable so returning
  // visitors retain their saved clubs while new saves use provider IDs.
  const LEGACY_FAVORITE_TEAMS = new Map([
    ["manchester-united", ["Manchester United"]], ["liverpool", ["Liverpool"]],
    ["arsenal", ["Arsenal"]], ["chelsea", ["Chelsea"]],
    ["manchester-city", ["Manchester City"]], ["newcastle", ["Newcastle United", "Newcastle"]],
  ]);

  function favoriteLeagueId(fixture) {
    const providerId = Number(fixture?.competitionId);
    if (Number.isInteger(providerId) && providerId > 0) return `league-${providerId}`;
    return `league-name-${normalizeTeamName(fixture?.competition)}`;
  }

  function favoriteTeamId(teamId, teamName) {
    const providerId = Number(teamId);
    if (Number.isInteger(providerId) && providerId > 0) return `team-${providerId}`;
    return `team-name-${normalizeTeamName(teamName)}`;
  }

  function favoriteTeamAliases(teamName) {
    const normalizedName = normalizeTeamName(teamName);
    return [...LEGACY_FAVORITE_TEAMS]
      .filter(([, names]) => names.some((name) => normalizeTeamName(name) === normalizedName))
      .map(([id]) => id);
  }

  function isFavoriteTeam(favorites, teamId, teamName) {
    const clubs = new Set(favorites?.clubs || []);
    return clubs.has(favoriteTeamId(teamId, teamName)) || favoriteTeamAliases(teamName).some((id) => clubs.has(id));
  }

  function fixtureKey(fixture) {
    return fixture?.id != null
      ? String(fixture.id)
      : `${fixture?.competition}|${fixture?.kickoff}|${fixture?.home}|${fixture?.away}`;
  }

  // Each fixture is assigned once: club favourites outrank league favourites,
  // which in turn outrank the ordinary competition directory. This keeps a
  // reader's preferred matches at the top without showing the same fixture in
  // two groups.
  function partitionFavoriteFixtures(fixtures, favorites) {
    const leagues = new Set(favorites?.leagues || []);
    const result = { clubs: [], leagues: [], others: [] };
    const seen = new Set();
    (fixtures || []).forEach((fixture) => {
      const key = fixtureKey(fixture);
      if (seen.has(key)) return;
      seen.add(key);
      const clubFavorite = isFavoriteTeam(favorites, fixture.homeId, fixture.home)
        || isFavoriteTeam(favorites, fixture.awayId, fixture.away);
      const leagueFavorite = leagues.has(favoriteLeagueId(fixture));
      if (clubFavorite) result.clubs.push(fixture);
      else if (leagueFavorite) result.leagues.push(fixture);
      else result.others.push(fixture);
    });
    return result;
  }

  function selectFavoriteFixtures(fixtures, favorites) {
    const partitioned = partitionFavoriteFixtures(fixtures, favorites);
    return [...partitioned.clubs, ...partitioned.leagues];
  }

  function contentAvailabilityBatches(fixtures, batchSize = 50) {
    const safeBatchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 50;
    const fixtureIds = [...new Set((fixtures || [])
      .map((fixture) => Number(typeof fixture === "object" ? fixture?.id : fixture))
      .filter((fixtureId) => Number.isInteger(fixtureId) && fixtureId > 0))];
    const batches = [];
    for (let offset = 0; offset < fixtureIds.length; offset += safeBatchSize) {
      batches.push(fixtureIds.slice(offset, offset + safeBatchSize));
    }
    return batches;
  }

  function contentBadgeLabels(language) {
    return String(language || "").toLowerCase().startsWith("en")
      ? { prediction: "PREDICTION", report: "MATCH REPORT" }
      : { prediction: "予想あり", report: "解説あり" };
  }

  function contentAvailabilityForFixture(response, fixture) {
    const fixtureId = Number(fixture?.id);
    const types = new Set(Array.isArray(response?.availability?.[fixtureId]) ? response.availability[fixtureId] : []);
    const archive = typeof globalThis !== "undefined" ? globalThis.AM4MatchArchive : null;
    const matchKey = typeof archive?.fixtureMatchKey === "function"
      ? archive.fixtureMatchKey(fixture)
      : typeof archive?.canonicalMatchKey === "function" ? archive.canonicalMatchKey(fixture) : null;
    const matchedTypes = response?.matchAvailability?.[matchKey];
    if (Array.isArray(matchedTypes)) matchedTypes.forEach((type) => types.add(type));
    return [...types];
  }
  // These are deliberately neutral UI accents, not inferred club colours. They keep
  // unlisted teams distinguishable while the provider name remains the source of truth.
  function neutralTeamAccent(normalizedName) {
    if (!normalizedName) return "hsl(216 40% 62%)";
    const hash = [...normalizedName].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 7);
    const hue = hash % 360;
    const saturation = 38 + ((hash >>> 9) % 19);
    const lightness = 55 + ((hash >>> 15) % 10);
    return `hsl(${hue} ${saturation}% ${lightness}%)`;
  }

  function create({
    client,
    teamLogo,
    updatedAt,
    onDailyData = null,
    initialState = null,
    onStateChange = null,
  }) {
    const fixturesNode = document.getElementById("fixture-list");
    const fixturesSource = document.getElementById("fixtures-source");
    const fixturesStatus = document.getElementById("fixtures-status");
    const fixtureOrderLabel = document.getElementById("fixture-order-label");
    const fixtureFilters = document.getElementById("fixture-filters");
    const fixtureTodayButton = document.getElementById("fixture-today-button");
    const spoilerToggle = document.getElementById("spoiler-toggle");
    const leagueCache = new Map();
    const dailyCache = new Map();
    // Editorial availability is a lightweight, public archive lookup. It is
    // deliberately separate from fixture data so a missing article can never
    // affect the schedule itself.
    const contentAvailability = new Map();
    let contentAvailabilityRequestKey = "";
    let contentAvailabilityRequestId = 0;
    const restoredState = initialState && typeof initialState === "object" ? initialState : {};
    const validInitialDate = /^\d{4}-\d{2}-\d{2}$/.test(restoredState.date || "") ? restoredState.date : "";
    const expandedLeagueGroups = new Set(Array.isArray(restoredState.expandedGroups) ? restoredState.expandedGroups : []);
    const expandedLeagueGroupCounts = new Map();
    let fixtureMode = restoredState.mode === "round" ? "round" : "date";
    let fixtureStatus = ["all", "upcoming", "live", "finished"].includes(restoredState.status) ? restoredState.status : "all";
    let activeFixtureData = null;
    let activeFixtureFilter = typeof restoredState.filter === "string" ? restoredState.filter : null;
    let spoilersRevealed = restoredState.spoilersRevealed === true;
    const DATE_WINDOW_DAYS = 30;
    const DATE_WINDOW_EXTENSION_DAYS = 30;
    const initialToday = AM4FootballData.tokyoDateKey(new Date());
    let selectedDailyDate = validInitialDate || initialToday;
    // The date strip and daily provider requests are intentionally separate:
    // the reader can browse a continuous window without downloading 61 days of
    // fixtures up front. `ensureDateInWindow` lets future controls extend it.
    let dateWindowStart = shiftDate(initialToday, -DATE_WINDOW_DAYS);
    let dateWindowEnd = shiftDate(initialToday, DATE_WINDOW_DAYS);
    let liveDailyRefreshTimer = null;
    let liveDailyRefreshInFlight = false;
    let pendingInitialScrollY = Number.isFinite(Number(restoredState.scrollY)) ? Math.max(0, Number(restoredState.scrollY)) : 0;

    function snapshotState() {
      return {
        date: selectedDailyDate,
        mode: fixtureMode,
        filter: activeFixtureFilter || "",
        status: fixtureStatus,
        expandedGroups: [...expandedLeagueGroups],
        spoilersRevealed,
        scrollY: window.scrollY,
      };
    }

    function persistState({ updateUrl = false, forceHash = "" } = {}) {
      if (typeof onStateChange === "function") onStateChange(snapshotState(), { updateUrl, forceHash });
    }

    function restoreInitialScroll() {
      if (!pendingInitialScrollY) return;
      const scrollY = pendingInitialScrollY;
      pendingInitialScrollY = 0;
      window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
    }

    document.querySelectorAll(".fixture-mode-tab").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.fixtureMode === fixtureMode));
    });
    document.querySelectorAll(".fixture-status-tab").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.fixtureStatus === fixtureStatus));
    });
    if (spoilerToggle) {
      spoilerToggle.setAttribute("aria-pressed", String(spoilersRevealed));
      spoilerToggle.querySelector("span").textContent = spoilersRevealed ? "結果を隠す" : "結果を表示";
    }

    function favoriteButton(type, id, label, className = "") {
      const saved = AM4Favorites.read(localStorage);
      const aliases = type === "clubs" ? favoriteTeamAliases(label) : [];
      const selected = AM4Favorites.has(saved, type, id) || aliases.some((alias) => AM4Favorites.has(saved, type, alias));
      const button = document.createElement("button");
      button.type = "button";
      button.className = `fixture-favorite-button ${className}`.trim();
      button.dataset.favoriteType = type;
      button.dataset.favoriteId = id;
      if (aliases.length) button.dataset.favoriteAliases = aliases.join(",");
      button.dataset.favoriteLabel = label;
      button.dataset.favoriteDetail = type === "leagues" ? `${label}の試合を優先表示` : `${label}の試合を優先表示`;
      button.dataset.favoriteHref = "#fixtures";
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${label}をお気に入り${selected ? "から解除" : "に追加"}`);
      button.textContent = selected ? "★" : "☆";
      return button;
    }

    function fixtureTeam(name, logo, score = "", teamId = null) {
      const team = document.createElement("span");
      team.className = "fixture-team";
      const clubName = document.createElement("span");
      clubName.className = "fixture-team-name";
      clubName.textContent = name;
      const teamScore = document.createElement("strong");
      teamScore.className = "fixture-team-score";
      teamScore.textContent = score;
      teamScore.hidden = !score;
      team.append(
        teamLogo(name, logo),
        favoriteButton("clubs", favoriteTeamId(teamId, name), name, "fixture-favorite-button--team"),
        clubName,
        teamScore,
      );
      return team;
    }

    function appendContentBadges(meta, fixture) {
      const types = contentAvailability.get(String(fixture?.id)) || [];
      if (!types.length) return;

      const labels = contentBadgeLabels(document.documentElement.lang);
      const badges = document.createElement("span");
      badges.className = "fixture-content-badges";
      types.forEach((type) => {
        const label = labels[type];
        if (!label) return;
        const badge = document.createElement("span");
        badge.className = `fixture-content-badge fixture-content-badge--${type}`;
        badge.textContent = label;
        badges.append(badge);
      });
      if (badges.childElementCount) meta.append(badges);
    }

    function requestContentAvailability(fixtures) {
      if (typeof client.contentAvailability !== "function") return;
      const batches = contentAvailabilityBatches(fixtures);
      if (!batches.length) return;
      const fixturesById = new Map((fixtures || [])
        .map((fixture) => [Number(fixture?.id), fixture])
        .filter(([fixtureId]) => Number.isInteger(fixtureId) && fixtureId > 0));
      const fixtureBatches = batches.map((fixtureIds) => fixtureIds
        .map((fixtureId) => fixturesById.get(fixtureId))
        .filter(Boolean));

      const requestKey = batches.map((fixtureIds) => fixtureIds.join(",")).join(";");
      if (requestKey === contentAvailabilityRequestKey) return;
      contentAvailabilityRequestKey = requestKey;
      const requestId = ++contentAvailabilityRequestId;

      Promise.allSettled(fixtureBatches.map((fixturesForBatch) => client.contentAvailability(fixturesForBatch)))
        .then((results) => {
          if (requestId !== contentAvailabilityRequestId) return;
          let hasSuccessfulBatch = false;
          let hasFailedBatch = false;
          results.forEach((result, index) => {
            if (result.status !== "fulfilled") {
              hasFailedBatch = true;
              console.warn("Editorial content availability unavailable.", result.reason);
              return;
            }
            hasSuccessfulBatch = true;
            fixtureBatches[index].forEach((fixture) => {
              const fixtureId = String(fixture.id);
              contentAvailability.delete(fixtureId);
              const types = contentAvailabilityForFixture(result.value, fixture);
              if (!Array.isArray(types) || !types.length) return;
              contentAvailability.set(fixtureId, types);
            });
          });
          // Only the schedule cards are redrawn: fixture state, filters, and
          // the selected date remain untouched when availability arrives.
          if (hasFailedBatch) contentAvailabilityRequestKey = "";
          if (hasSuccessfulBatch && activeFixtureData) renderFixtureView({ preserveScroll: true });
        })
        .catch((error) => {
          if (requestId !== contentAvailabilityRequestId) return;
          contentAvailabilityRequestKey = "";
          console.warn("Editorial content availability unavailable.", error);
        });
    }

    function fixtureStatusLabel(status) {
      const group = AM4FootballData.classifyFixtureStatus(status);
      if (group === "live") return "試合中";
      if (group === "upcoming") return "開催予定";
      if (group === "finished") return "試合終了";
      return { PST: "延期", CANC: "中止", ABD: "中断", AWD: "没収試合", WO: "不戦勝" }[status] || "状況確認中";
    }

    function fixtureScoreLabel(fixture, separator = "-") {
      if (fixture.homeGoals != null && fixture.awayGoals != null) return `${fixture.homeGoals}${separator}${fixture.awayGoals}`;
      if (fixture.score && fixture.score !== "-") return String(fixture.score).replace("-", separator);
      return "";
    }

    function fixtureTeamScores(fixture) {
      const score = fixtureScoreLabel(fixture);
      const [home = "", away = ""] = score.split(/[-–]/).map((value) => value.trim());
      return { home, away };
    }

    function teamAccent(name) {
      const normalizedName = normalizeTeamName(name);
      const officialAccent = NORMALIZED_TEAM_ACCENTS.get(normalizedName);
      if (officialAccent) return officialAccent;
      return neutralTeamAccent(normalizedName);
    }

    function competitionLogo(fixture, className = "fixture-league-logo") {
      const competition = typeof fixture === "string" ? fixture : fixture?.competition;
      const providerLeagueId = Number(fixture?.competitionId);
      const leagueId = Number.isInteger(providerLeagueId) && providerLeagueId > 0
        ? providerLeagueId
        : COMPETITION_LOGOS.get(competition);
      const source = fixture?.competitionLogo || (leagueId ? `https://media.api-sports.io/football/leagues/${leagueId}.png` : null);
      if (!source) return null;
      const logo = document.createElement("img");
      logo.className = className;
      logo.src = source;
      logo.alt = "";
      logo.width = 28;
      logo.height = 28;
      logo.decoding = "async";
      logo.addEventListener("error", () => logo.remove(), { once: true });
      return logo;
    }

    function competitionCountryLabel(fixture) {
      const priorityCompetition = priorityCompetitionForFixture(fixture);
      const country = priorityCompetition?.country || fixture?.competitionCountry || (!fixture?.competitionId && COMPETITION_COUNTRIES.get(fixture?.competition));
      return COUNTRY_LABELS.get(country) || country || "";
    }

    function competitionGroupKey(fixture) {
      const providerLeagueId = Number(fixture?.competitionId);
      if (Number.isInteger(providerLeagueId) && providerLeagueId > 0) return `id:${providerLeagueId}`;
      const competition = fixture?.competition || fixture?.roundLabel || "大会情報確認中";
      return `name:${competition}|country:${fixture?.competitionCountry || ""}`;
    }

    function fixtureKickoffTime(fixture) {
      const value = Date.parse(fixture?.kickoff);
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    }

    function leagueGroupKey(competition) {
      return [
        fixtureMode,
        selectedDailyDate,
        activeFixtureFilter || "",
        fixtureStatus,
        competition,
      ].join("|");
    }

    function renderFixtures(items, sourceLabel = "") {
      fixturesNode.replaceChildren();
      const sortedItems = AM4FootballData.sortFixturesForViewing(items);
      const favorites = AM4Favorites.read(localStorage);
      const partitioned = partitionFavoriteFixtures(sortedItems, favorites);
      const groups = new Map();
      partitioned.others.forEach((fixture) => {
        const competition = fixture.competition || fixture.roundLabel || "大会情報確認中";
        const groupId = competitionGroupKey(fixture);
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            groupId,
            competition,
            competitionId: fixture.competitionId || null,
            competitionCountry: fixture.competitionCountry || null,
            fixtures: [],
          });
        }
        groups.get(groupId).fixtures.push(fixture);
      });
      if (partitioned.clubs.length) {
        groups.set("favorites-clubs", {
          groupId: "favorites-clubs",
          competition: "お気に入りクラブ",
          competitionId: null,
          competitionCountry: null,
          fixtures: partitioned.clubs,
          isFavoriteGroup: true,
          favoriteGroupRank: 0,
        });
      }
      if (partitioned.leagues.length) {
        groups.set("favorites-leagues", {
          groupId: "favorites-leagues",
          competition: "お気に入りリーグ",
          competitionId: null,
          competitionCountry: null,
          fixtures: partitioned.leagues,
          isFavoriteGroup: true,
          favoriteGroupRank: 1,
        });
      }
      if ((favorites.clubs.length || favorites.leagues.length) && !partitioned.clubs.length && !partitioned.leagues.length) {
        const notice = document.createElement("p");
        notice.className = "fixture-favorite-empty";
        notice.textContent = "お気に入りの試合はこの表示条件にはありません。ほかの試合を続けて確認できます。";
        fixturesNode.append(notice);
      }
      const prioritizeMajorLeagues = true;
      const orderedGroups = [...groups.values()].sort((left, right) => {
        const favoriteRank = (left.favoriteGroupRank ?? Number.MAX_SAFE_INTEGER) - (right.favoriteGroupRank ?? Number.MAX_SAFE_INTEGER);
        if (favoriteRank) return favoriteRank;
        const leftFixture = left.fixtures[0] || left;
        const rightFixture = right.fixtures[0] || right;
        if (prioritizeMajorLeagues) {
          const rankDifference = competitionDisplayRank(leftFixture) - competitionDisplayRank(rightFixture);
          if (rankDifference) return rankDifference;
        }
        const kickoffDifference = fixtureKickoffTime(leftFixture) - fixtureKickoffTime(rightFixture);
        if (kickoffDifference) return kickoffDifference;
        const leftLabel = `${competitionCountryLabel(leftFixture)} ${left.competition}`;
        const rightLabel = `${competitionCountryLabel(rightFixture)} ${right.competition}`;
        return leftLabel.localeCompare(rightLabel, "ja");
      });
      // League sections are deliberately one continuous directory. This keeps
      // the round selector independent from league visibility.
      const canPageLeagueGroups = false;
      const directoryKey = leagueGroupKey("_directory");
      const visibleGroupLimit = canPageLeagueGroups
        ? Math.min(orderedGroups.length, expandedLeagueGroupCounts.get(directoryKey) || LEAGUE_GROUP_PREVIEW_LIMIT)
        : orderedGroups.length;
      orderedGroups.forEach(({ groupId, competition, competitionId, competitionCountry, fixtures, isFavoriteGroup = false }, currentGroupIndex) => {
        if (currentGroupIndex >= visibleGroupLimit) return;
        const group = document.createElement("section");
        group.className = "fixture-league-group";
        const groupFixture = fixtures[0] || { competition, competitionId, competitionCountry };
        const isEmpty = fixtures.length === 0;
        if (isEmpty) group.classList.add("fixture-league-group--empty");
        const canCompact = fixtureMode === "date" && fixtures.length > LEAGUE_PREVIEW_LIMIT;
        const groupKey = leagueGroupKey(groupId);
        const isExpanded = !canCompact || expandedLeagueGroups.has(groupKey);
        const heading = document.createElement("h3");
        heading.className = "fixture-league-heading";
        heading.tabIndex = -1;
        const logo = isFavoriteGroup ? null : competitionLogo(groupFixture);
        const headingCopy = document.createElement("span");
        headingCopy.className = "fixture-league-heading-copy";
        const title = document.createElement("span");
        title.className = "fixture-league-title";
        title.textContent = competition;
        headingCopy.append(title);
        const countryName = isFavoriteGroup ? "" : competitionCountryLabel(groupFixture);
        if (countryName) {
          const country = document.createElement("small");
          country.className = "fixture-league-country";
          country.textContent = countryName;
          headingCopy.append(country);
        }
        const count = document.createElement("small");
        count.className = "fixture-league-count";
        count.textContent = isEmpty ? "試合なし" : `${fixtures.length}試合`;
        if (isEmpty) count.classList.add("fixture-league-empty-status");
        if (logo) heading.append(logo, headingCopy);
        else heading.append(headingCopy);
        if (isFavoriteGroup) {
          const favoriteMark = document.createElement("span");
          favoriteMark.className = "fixture-favorite-heading-mark";
          favoriteMark.setAttribute("aria-hidden", "true");
          favoriteMark.textContent = "★";
          heading.append(favoriteMark);
        } else {
          heading.append(favoriteButton("leagues", favoriteLeagueId(groupFixture), competition, "fixture-favorite-button--league"));
        }
        heading.append(count);
        if (isEmpty) {
          group.append(heading);
          fixturesNode.append(group);
          return;
        }
        const list = document.createElement("div");
        list.className = "fixture-league-list";
        list.id = "fixture-league-" + currentGroupIndex;
        const concealedNodes = [];
        fixtures.forEach((fixture, fixtureIndex) => {
          const row = document.createElement("article");
          row.className = "fixture-row fixture-row--interactive";
          row.hidden = canCompact && !isExpanded && fixtureIndex >= LEAGUE_PREVIEW_LIMIT;
          const statusGroup = AM4FootballData.classifyFixtureStatus(fixture.status);
          const resultPresentation = AM4FootballData.fixtureResultPresentation(
            fixture,
            spoilersRevealed,
          );
          const homeAccent = teamAccent(fixture.home);
          const awayAccent = teamAccent(fixture.away);
          if (homeAccent) row.style.setProperty("--home-team-color", homeAccent);
          if (awayAccent) row.style.setProperty("--away-team-color", awayAccent);
          const meta = document.createElement("div");
          meta.className = "fixture-meta";
          const date = document.createElement("time");
          date.className = "fixture-date";
          date.textContent = fixture.kickoff
            ? `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))} JST`
            : fixture.date || "日時確認中";
          meta.append(date);
          appendContentBadges(meta, fixture);
          const teams = document.createElement("div");
          teams.className = "fixture-teams";
          const scores = resultPresentation.hidden ? { home: "", away: "" } : fixtureTeamScores(fixture);
          teams.append(
            fixtureTeam(fixture.home, fixture.homeLogo, scores.home, fixture.homeId),
            fixtureTeam(fixture.away, fixture.awayLogo, scores.away, fixture.awayId),
          );
          const scoreboard = document.createElement("div");
          scoreboard.className = "fixture-scoreboard";
          if (resultPresentation.hidden) {
            scoreboard.classList.add("fixture-reveal-action");
          }
          const fullScores = fixtureTeamScores(fixture);
          const scoreText = fullScores.home && fullScores.away ? `${fullScores.home} – ${fullScores.away}` : "";
          const scoreValue = document.createElement("span");
          scoreValue.className = "fixture-scoreboard-value";
          const scoreCaption = document.createElement("small");
          let resultCover = null;
          if (resultPresentation.hidden) {
            scoreboard.setAttribute("aria-hidden", "true");
            scoreValue.textContent = scoreText || "–";
            resultCover = document.createElement("span");
            resultCover.className = "fixture-result-cover";
            const leagueLogo = competitionLogo(fixture, "fixture-result-cover-logo");
            if (leagueLogo) {
              resultCover.append(leagueLogo);
            } else {
              const fallback = document.createElement("span");
              fallback.className = "fixture-result-cover-fallback";
              fallback.textContent = String(fixture.competition || "AM4").slice(0, 2).toUpperCase();
              resultCover.append(fallback);
            }
            const copy = document.createElement("span");
            copy.className = "fixture-result-cover-copy";
            const hint = document.createElement("span");
            hint.textContent = "詳細で";
            const label = document.createElement("strong");
            label.textContent = "試合結果を表示";
            copy.append(hint, label);
            resultCover.append(copy);
          } else {
            if (statusGroup === "upcoming") {
              scoreValue.textContent = fixture.kickoff
                ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))
                : "VS";
              scoreCaption.textContent = "KICKOFF";
            } else if (statusGroup === "live") {
              scoreValue.textContent = scoreText || "LIVE";
              scoreCaption.textContent = fixture.elapsed ? `${fixture.elapsed}'` : "LIVE";
            } else if (statusGroup === "finished") {
              scoreValue.textContent = scoreText || "試合終了";
              scoreCaption.textContent = "FULL-TIME";
            } else {
              scoreValue.textContent = fixtureStatusLabel(fixture.status);
              scoreCaption.textContent = "STATUS";
            }
          }
          scoreboard.append(scoreValue);
          if (resultCover) scoreboard.append(resultCover);
          if (scoreCaption.textContent) scoreboard.append(scoreCaption);
          scoreboard.dataset.resultHidden = String(resultPresentation.hidden);

          const cardTarget = document.createElement(fixture.id ? "a" : "span");
          cardTarget.className = "fixture-card-tap-target";
          if (fixture.id) {
            cardTarget.href = `/match.html?id=${encodeURIComponent(fixture.id)}`;
            cardTarget.addEventListener("click", () => persistState({ updateUrl: true, forceHash: "fixtures" }));
          }
          cardTarget.setAttribute(
            "aria-label",
            resultPresentation.hidden
              ? `${fixture.competition || "大会"}、${fixture.home}対${fixture.away}。試合詳細で結果を表示`
              : `${fixture.home}対${fixture.away}${scoreText ? `、${scoreText}` : ""}。${fixture.id ? "試合詳細へ移動" : "試合情報を開く"}`,
          );
          row.append(cardTarget, meta, teams, scoreboard);
          list.append(row);
          if (row.hidden) concealedNodes.push(row);
        });
        group.append(heading, list);
        if (canCompact && !isExpanded) {
          const showMore = document.createElement("button");
          const remaining = fixtures.length - LEAGUE_PREVIEW_LIMIT;
          showMore.type = "button";
          showMore.className = "fixture-league-toggle";
          showMore.textContent = "残り" + remaining + "試合を表示";
          showMore.setAttribute("aria-controls", list.id);
          showMore.setAttribute("aria-expanded", "false");
          showMore.addEventListener("click", () => {
            expandedLeagueGroups.add(groupKey);
            concealedNodes.forEach((node) => { if (node) node.hidden = false; });
            group.dataset.expanded = "true";
            showMore.remove();
            persistState();
          });
          group.append(showMore);
        }
        fixturesNode.append(group);
      });
      if (visibleGroupLimit < orderedGroups.length) {
        const showMoreGroups = document.createElement("button");
        const remaining = orderedGroups.length - visibleGroupLimit;
        const nextBatch = Math.min(LEAGUE_GROUP_BATCH_SIZE, remaining);
        showMoreGroups.type = "button";
        showMoreGroups.className = "fixture-directory-toggle";
        showMoreGroups.textContent = "さらに" + nextBatch + "リーグを表示 · 残り" + remaining;
        showMoreGroups.setAttribute("aria-label", "次の" + nextBatch + "リーグを表示");
        showMoreGroups.setAttribute("aria-controls", "fixture-list");
        showMoreGroups.setAttribute("aria-expanded", "false");
        showMoreGroups.addEventListener("click", () => {
          const nextLimit = Math.min(orderedGroups.length, visibleGroupLimit + LEAGUE_GROUP_BATCH_SIZE);
          expandedLeagueGroupCounts.set(directoryKey, nextLimit);
          renderFixtures(items, sourceLabel);
          const firstNewHeading = document
            .getElementById("fixture-league-" + visibleGroupLimit)
            ?.closest(".fixture-league-group")
            ?.querySelector(".fixture-league-heading");
          firstNewHeading?.focus();
        });
        fixturesNode.append(showMoreGroups);
      }
      document.dispatchEvent(new CustomEvent("am4:favorites-catalog-updated"));
      requestContentAvailability(items);
    }

    function visibleFixtures(data) {
      const statusFiltered = AM4FootballData.filterFixtures(data.fixtures || [], {
        status: fixtureStatus,
        focusOnly: false,
      });
      return AM4FootballData.sortDailyFixtures(statusFiltered);
    }

    function shiftDate(dateKey, days) {
      const value = new Date(`${dateKey}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    }

    function ensureDateInWindow(date) {
      while (date < dateWindowStart) dateWindowStart = shiftDate(dateWindowStart, -DATE_WINDOW_EXTENSION_DAYS);
      while (date > dateWindowEnd) dateWindowEnd = shiftDate(dateWindowEnd, DATE_WINDOW_EXTENSION_DAYS);
    }

    function dateOptions() {
      const today = AM4FootballData.tokyoDateKey(new Date());
      const options = [];
      for (let date = dateWindowStart; date <= dateWindowEnd; date = shiftDate(date, 1)) {
        const value = new Date(`${date}T12:00:00Z`);
        options.push({
          value: date,
          label: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(value),
          small: date === today ? "今日" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(value),
        });
      }
      return options;
    }

    function roundOptions(data) {
      const rounds = data.rounds || [];
      const selectedIndex = Math.max(0, rounds.findIndex((round) => round.key === activeFixtureFilter));
      const start = Math.max(0, Math.min(selectedIndex - 2, rounds.length - 6));
      return rounds.slice(start, start + 6).map((round) => ({ value: round.key, label: round.label, small: "節別" }));
    }

    function defaultRoundFilter(data) {
      const ordered = (data.fixtures || []).filter((fixture) => fixture.roundKey).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      return ordered.find((fixture) => Date.parse(fixture.kickoff) >= Date.now())?.roundKey || ordered.at(-1)?.roundKey || null;
    }

    function hasRound(data, roundKey) {
      return Boolean(roundKey) && (data?.rounds || []).some((round) => round.key === roundKey);
    }

    function renderFilterTabs(options) {
      fixtureFilters.replaceChildren(...options.map((option) => {
        const button = document.createElement("button");
        button.className = "fixture-filter-tab";
        button.type = "button";
        button.dataset.fixtureFilter = option.value;
        button.setAttribute("aria-pressed", String(option.value === activeFixtureFilter));
        button.innerHTML = "<small></small><span></span>";
        button.querySelector("small").textContent = option.small;
        button.querySelector("span").textContent = option.label;
        return button;
      }));
      if (fixtureMode !== "date") return;
      window.requestAnimationFrame(() => {
        const selected = fixtureFilters.querySelector('[aria-pressed="true"]');
        if (!selected || fixtureFilters.scrollWidth <= fixtureFilters.clientWidth) return;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        selected.scrollIntoView({ block: "nearest", inline: "center", behavior: reducedMotion ? "auto" : "smooth" });
      });
    }

    function renderFixtureView({ preserveScroll = false } = {}) {
      if (!activeFixtureData) return;
      const scrollY = preserveScroll ? window.scrollY : null;
      const options = fixtureMode === "date" ? dateOptions() : roundOptions(activeFixtureData);
      renderFilterTabs(options);
      const allVisible = visibleFixtures(activeFixtureData);
      const fixtures = fixtureMode === "round"
        ? allVisible.filter((fixture) => fixture.roundKey === activeFixtureFilter)
        : allVisible;
      renderFixtures(fixtures);
      const statusLabel = { upcoming: "今後", live: "ライブ", finished: "終了", all: "全試合" }[fixtureStatus];
      const competitionLabel = fixtureMode === "round" ? "5大リーグ" : "全大会";
      const unavailableRoundLeagues = fixtureMode === "round"
        ? activeFixtureData?.unavailableLeagues || []
        : [];
      const unavailableLabel = unavailableRoundLeagues.length
        ? ` · ${unavailableRoundLeagues.join(" / ")}は取得できません`
        : "";
      const dateLabel = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${selectedDailyDate}T12:00:00Z`));
      const displayOrderLabel = "欧州大会・5大リーグ優先・大会内は時間順";
      if (fixtureOrderLabel) fixtureOrderLabel.textContent = displayOrderLabel;
      fixturesStatus.textContent = fixtures.length
        ? fixtureMode === "date"
          ? `${dateLabel} · ${competitionLabel} · ${statusLabel} · ${fixtures.length}試合 · ${displayOrderLabel} · ${updatedAt()}更新`
          : `${competitionLabel} · ${activeFixtureFilter || "節未選択"} · ${statusLabel} · ${fixtures.length}試合${unavailableLabel}`
        : fixtureMode === "date"
          ? `${dateLabel}は、選択条件に該当する試合がありません`
          : `${competitionLabel}の選択条件に該当する試合はありません${unavailableLabel}`;
      if (scrollY != null) {
        window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
      }
    }

    function clearLiveDailyRefresh() {
      if (liveDailyRefreshTimer != null) window.clearTimeout(liveDailyRefreshTimer);
      liveDailyRefreshTimer = null;
    }

    function liveDailyRefreshDelay(data = activeFixtureData) {
      if (fixtureMode !== "date" || !Array.isArray(data?.fixtures)) return null;
      if (selectedDailyDate < AM4FootballData.tokyoDateKey(new Date())) return null;
      if (data.fixtures.some((fixture) => AM4FootballData.classifyFixtureStatus(fixture.status) === "live")) {
        return LIVE_DAILY_REFRESH_MS;
      }
      const nextKickoffAt = data.fixtures
        .filter((fixture) => AM4FootballData.classifyFixtureStatus(fixture.status) === "upcoming")
        .map((fixture) => Date.parse(fixture.kickoff || ""))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      if (!Number.isFinite(nextKickoffAt)) return null;
      const untilKickoff = nextKickoffAt - Date.now();
      return untilKickoff > 0
        ? Math.max(LIVE_DAILY_REFRESH_MS, untilKickoff + KICKOFF_RECHECK_BUFFER_MS)
        : LIVE_DAILY_REFRESH_MS;
    }

    function hasLiveDailyFixtures(data = activeFixtureData) {
      return liveDailyRefreshDelay(data) != null;
    }

    function canRefreshLiveDailyFixtures() {
      return document.visibilityState === "visible" && hasLiveDailyFixtures() && !liveDailyRefreshInFlight;
    }

    function scheduleLiveDailyRefresh() {
      clearLiveDailyRefresh();
      if (!canRefreshLiveDailyFixtures()) return;
      liveDailyRefreshTimer = window.setTimeout(refreshLiveDailyFixtures, liveDailyRefreshDelay());
    }

    async function refreshLiveDailyFixtures() {
      liveDailyRefreshTimer = null;
      if (!canRefreshLiveDailyFixtures()) return;
      const date = selectedDailyDate;
      liveDailyRefreshInFlight = true;
      try {
        // Do not use the in-memory daily cache here. Vercel CDN still coalesces
        // readers, while an active match can advance without a page reload.
        const data = await client.dailyFixtures(date);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        if (!Array.isArray(data.fixtures)) throw new Error("invalid daily fixture response");
        if (fixtureMode === "date" && selectedDailyDate === date) useDailyData(date, data);
      } catch (error) {
        console.warn("Live daily fixtures refresh unavailable.", error);
      } finally {
        liveDailyRefreshInFlight = false;
        scheduleLiveDailyRefresh();
      }
    }

    function useDailyData(date, data) {
      ensureDateInWindow(date);
      dailyCache.set(date, data);
      fixtureMode = "date";
      selectedDailyDate = date;
      activeFixtureFilter = date;
      activeFixtureData = data;
      fixturesSource.hidden = true;
      renderFixtureView();
      if (typeof onDailyData === "function") onDailyData({ date, data });
      scheduleLiveDailyRefresh();
      persistState({ updateUrl: true });
      restoreInitialScroll();
    }

    async function loadFixtureDate(date) {
      ensureDateInWindow(date);
      clearLiveDailyRefresh();
      selectedDailyDate = date;
      activeFixtureFilter = date;
      activeFixtureData = null;
      fixtureFilters.replaceChildren();
      fixturesNode.replaceChildren();
      fixturesSource.hidden = true;
      fixturesStatus.textContent = `${date}の全大会を読み込んでいます`;
      try {
        const data = dailyCache.get(date) || await client.dailyFixtures(date);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        if (!Array.isArray(data.fixtures)) throw new Error("invalid daily fixture response");
        if (fixtureMode === "date" && selectedDailyDate === date) useDailyData(date, data);
      } catch (error) {
        if (fixtureMode === "date" && selectedDailyDate === date) showDailyUnavailable(date);
        console.warn("Daily fixtures unavailable.", error);
      }
    }

    function showDailyUnavailable(date, message = "試合情報を取得できませんでした") {
      ensureDateInWindow(date);
      clearLiveDailyRefresh();
      activeFixtureData = null;
      selectedDailyDate = date;
      activeFixtureFilter = date;
      renderFilterTabs(dateOptions());
      fixturesNode.replaceChildren();
      fixturesSource.hidden = false;
      fixturesSource.textContent = "取得できません";
      fixturesStatus.textContent = `${date}の${message}。架空の試合は表示していません。`;
      persistState({ updateUrl: true });
      restoreInitialScroll();
    }

    function useFixtureData(data) {
      clearLiveDailyRefresh();
      fixtureMode = "round";
      activeFixtureData = data;
      if (!hasRound(data, activeFixtureFilter)) activeFixtureFilter = defaultRoundFilter(data);
      fixturesSource.hidden = true;
      renderFixtureView();
      persistState({ updateUrl: true });
      restoreInitialScroll();
    }

    async function loadAllRoundFixtures() {
      clearLiveDailyRefresh();
      activeFixtureData = null;
      fixtureFilters.replaceChildren();
      fixturesNode.replaceChildren();
      fixturesSource.hidden = true;
      fixturesStatus.textContent = "5大リーグの節別日程を読み込んでいます";
      const results = await Promise.allSettled(ROUND_LEAGUES.map(async (league) => {
        const data = leagueCache.get(league) || await client.fixtures(league);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        if (!Array.isArray(data.fixtures)) throw new Error("invalid fixture response");
        leagueCache.set(league, data);
        return { league, data };
      }));
      if (fixtureMode !== "round") return;
      const availableData = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      if (availableData.length) {
        const roundData = mergeRoundFixtureData(availableData);
        roundData.unavailableLeagues = results
          .map((result, index) => result.status === "rejected" ? ROUND_LEAGUES[index] : null)
          .filter(Boolean);
        useFixtureData(roundData);
      } else {
        showRoundUnavailable("5大リーグの節別日程を取得できませんでした。通信状況を確認して、もう一度お試しください。");
      }
      results.forEach((result, index) => {
        if (result.status === "rejected") console.warn("Fixture league unavailable.", ROUND_LEAGUES[index], result.reason);
      });
    }

    function showRoundUnavailable(message) {
      clearLiveDailyRefresh();
      fixturesSource.hidden = false;
      fixturesSource.textContent = "取得できません";
      fixturesStatus.textContent = message;
      fixturesNode.replaceChildren();
      persistState({ updateUrl: true });
      restoreInitialScroll();
    }

    document.querySelectorAll(".fixture-mode-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureMode = button.dataset.fixtureMode;
      if (fixtureMode === "round" && /^\d{4}-\d{2}-\d{2}$/.test(activeFixtureFilter || "")) activeFixtureFilter = null;
      clearLiveDailyRefresh();
      document.querySelectorAll(".fixture-mode-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (fixtureMode === "date") {
        loadFixtureDate(selectedDailyDate);
      } else {
        loadAllRoundFixtures();
      }
    }));

    fixtureTodayButton?.addEventListener("click", () => {
      const today = AM4FootballData.tokyoDateKey(new Date());
      ensureDateInWindow(today);
      fixtureMode = "date";
      document.querySelectorAll(".fixture-mode-tab").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.fixtureMode === "date"));
      });
      loadFixtureDate(today);
    });

    document.querySelectorAll(".fixture-status-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureStatus = button.dataset.fixtureStatus;
      document.querySelectorAll(".fixture-status-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (activeFixtureData) {
        renderFixtureView();
      }
      persistState({ updateUrl: true });
    }));

    spoilerToggle?.addEventListener("click", () => {
      spoilersRevealed = !spoilersRevealed;
      spoilerToggle.setAttribute("aria-pressed", String(spoilersRevealed));
      spoilerToggle.querySelector("span").textContent = spoilersRevealed ? "結果を隠す" : "結果を表示";
      if (activeFixtureData) renderFixtureView();
      persistState();
    });

    fixtureFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-fixture-filter]");
      if (!button) return;
      if (fixtureMode === "date") {
        loadFixtureDate(button.dataset.fixtureFilter);
      } else {
        activeFixtureFilter = button.dataset.fixtureFilter;
        renderFixtureView();
        persistState({ updateUrl: true });
      }
    });

    document.addEventListener("am4:favorites-changed", () => {
      if (activeFixtureData) renderFixtureView();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        clearLiveDailyRefresh();
      } else if (hasLiveDailyFixtures()) {
        if (activeFixtureData?.fixtures?.some((fixture) => AM4FootballData.classifyFixtureStatus(fixture.status) === "live")) {
          refreshLiveDailyFixtures();
        } else {
          scheduleLiveDailyRefresh();
        }
      }
    });
    window.addEventListener("pagehide", () => {
      persistState({ updateUrl: false });
      clearLiveDailyRefresh();
    }, { once: true });

    return {
      renderFixtures,
      useDailyData,
      loadFixtureDate,
      showDailyUnavailable,
      useFixtureData,
      showRoundUnavailable,
      getState: snapshotState,
    };
  }

  return {
    create,
    competitionDisplayRank,
    contentBadgeLabels,
    contentAvailabilityBatches,
    contentAvailabilityForFixture,
    mergeRoundFixtureData,
    partitionFavoriteFixtures,
    roundLeagueNames: ROUND_LEAGUES,
    selectFavoriteFixtures,
  };
});
