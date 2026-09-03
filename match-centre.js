(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchCentre = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const ALL_COMPETITIONS = "すべて";
  const DEFAULT_LEAGUE = "プレミアリーグ";
  const LEAGUE_PREVIEW_LIMIT = 4;
  const LEAGUE_GROUP_PREVIEW_LIMIT = 6;
  const LEAGUE_GROUP_BATCH_SIZE = 6;
  const LIVE_DAILY_REFRESH_MS = 30_000;
  const KICKOFF_RECHECK_BUFFER_MS = 30_000;
  const SCORE_REVEAL_FALLBACK_MS = 700;
  const MAJOR_LEAGUES = [
    { providerId: 39, rank: 1, competition: "プレミアリーグ", country: "England", names: ["プレミアリーグ", "Premier League"] },
    { providerId: 140, rank: 2, competition: "ラ・リーガ", country: "Spain", names: ["ラ・リーガ", "La Liga"] },
    { providerId: 135, rank: 3, competition: "セリエA", country: "Italy", names: ["セリエA", "Serie A"] },
    { providerId: 78, rank: 4, competition: "ブンデスリーガ", country: "Germany", names: ["ブンデスリーガ", "Bundesliga"] },
    { providerId: 61, rank: 5, competition: "リーグ・アン", country: "France", names: ["リーグ・アン", "Ligue 1"] },
  ];
  // 日別の「すべて」はクラブではなく大会単位で案内する。まず5大リーグを
  // 固定し、その後は主要国内リーグの編集順を使う。未登録の大会は開始時刻順。
  const COMPETITION_DISPLAY_ORDER = new Map([
    ...MAJOR_LEAGUES.map(({ providerId, rank }) => [providerId, rank]),
    [88, 6], [94, 7], [144, 8], [179, 9], [203, 10],
    [218, 11], [207, 12], [119, 13], [113, 14], [103, 15],
    [106, 16], [332, 17], [345, 18], [71, 19], [128, 20],
    [253, 21], [262, 22], [98, 23], [292, 24],
  ]);
  const COMPETITION_LOGOS = new Map([
    ["プレミアリーグ", 39], ["Premier League", 39],
    ["ラ・リーガ", 140], ["La Liga", 140],
    ["セリエA", 135], ["Serie A", 135],
    ["ブンデスリーガ", 78], ["Bundesliga", 78],
    ["リーグ・アン", 61], ["Ligue 1", 61],
    ["チャンピオンズリーグ", 2], ["UEFA Champions League", 2],
    ["クラブ親善試合", 667], ["Club Friendlies", 667],
  ]);
  const COMPETITION_COUNTRIES = new Map([
    ["プレミアリーグ", "England"], ["Premier League", "England"],
    ["ラ・リーガ", "Spain"], ["La Liga", "Spain"],
    ["セリエA", "Italy"], ["Serie A", "Italy"],
    ["ブンデスリーガ", "Germany"], ["Bundesliga", "Germany"],
    ["リーグ・アン", "France"], ["Ligue 1", "France"],
    ["チャンピオンズリーグ", "Europe"], ["UEFA Champions League", "Europe"],
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

  function create({ client, teamLogo, updatedAt, fallbackFixtures = [], onDailyData = null }) {
    const fixturesNode = document.getElementById("fixture-list");
    const fixturesSource = document.getElementById("fixtures-source");
    const fixturesStatus = document.getElementById("fixtures-status");
    const fixtureOrderLabel = document.getElementById("fixture-order-label");
    const fixtureFilters = document.getElementById("fixture-filters");
    const spoilerToggle = document.getElementById("spoiler-toggle");
    const matchDialog = document.getElementById("match-detail-dialog");
    const matchDialogBody = document.getElementById("match-detail-body");
    const leagueCache = new Map();
    const dailyCache = new Map();
    const eventCache = new Map();
    const revealedFixtureIds = new Set();
    const expandedLeagueGroups = new Set();
    const expandedLeagueGroupCounts = new Map();
    let activeFixtureLeague = ALL_COMPETITIONS;
    let fixtureMode = "date";
    let fixtureStatus = "all";
    let fixtureScope = "all";
    let activeFixtureData = null;
    let activeFixtureFilter = null;
    let spoilersRevealed = false;
    let pendingRevealedFixtureFocus = null;
    let activeDialogFixtureId = null;
    let selectedDailyDate = AM4FootballData.tokyoDateKey(new Date());
    let liveDailyRefreshTimer = null;
    let liveDailyRefreshInFlight = false;
    let editorialArticles = [];

    function fixtureTeam(name, logo, score = "") {
      const team = document.createElement("span");
      team.className = "fixture-team";
      const clubName = document.createElement("span");
      clubName.className = "fixture-team-name";
      clubName.textContent = name;
      const teamScore = document.createElement("strong");
      teamScore.className = "fixture-team-score";
      teamScore.textContent = score;
      teamScore.hidden = !score;
      team.append(teamLogo(name, logo), clubName, teamScore);
      return team;
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
      const country = fixture?.competitionCountry || (!fixture?.competitionId && COMPETITION_COUNTRIES.get(fixture?.competition));
      return COUNTRY_LABELS.get(country) || country || "";
    }

    function competitionGroupKey(fixture) {
      const providerLeagueId = Number(fixture?.competitionId);
      if (Number.isInteger(providerLeagueId) && providerLeagueId > 0) return `id:${providerLeagueId}`;
      const competition = fixture?.competition || fixture?.roundLabel || "大会情報確認中";
      return `name:${competition}|country:${fixture?.competitionCountry || ""}`;
    }

    function competitionDisplayRank(fixture) {
      const providerLeagueId = Number(fixture?.competitionId);
      if (COMPETITION_DISPLAY_ORDER.has(providerLeagueId)) return COMPETITION_DISPLAY_ORDER.get(providerLeagueId);
      const fallback = MAJOR_LEAGUES.find((entry) =>
        entry.country === fixture?.competitionCountry && entry.names.includes(fixture?.competition),
      );
      return fallback?.rank || Number.MAX_SAFE_INTEGER;
    }

    function fixtureKickoffTime(fixture) {
      const value = Date.parse(fixture?.kickoff);
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    }

    function detailFact(label, value) {
      const row = document.createElement("div");
      row.className = "match-dialog-fact";
      const key = document.createElement("span");
      const detail = document.createElement("span");
      key.textContent = label;
      detail.textContent = value;
      row.append(key, detail);
      return row;
    }

    function clubFavoriteButton(id, name) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "favorite-btn";
      button.dataset.favoriteType = "clubs";
      button.dataset.favoriteId = `team-${id}`;
      button.dataset.favoriteLabel = name;
      button.dataset.favoriteDetail = "次戦と関連記事を見る";
      button.dataset.favoriteHref = "#fixtures";
      const selected = AM4Favorites.has(AM4Favorites.read(localStorage), "clubs", button.dataset.favoriteId);
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? "クラブを保存済み" : `${name}を保存`;
      return button;
    }

    function goalDetailLabel(goal) {
      if (goal.ownGoal) return "オウンゴール";
      if (goal.detail === "Penalty") return "PK";
      return goal.assist ? `アシスト ${goal.assist}` : goal.team;
    }

    function renderGoalTimeline(container, goals) {
      container.replaceChildren();
      const heading = document.createElement("h4");
      heading.textContent = "得点者";
      container.append(heading);
      if (!goals.length) {
        const empty = document.createElement("p");
        empty.className = "goal-empty";
        empty.textContent = "得点イベントの情報はありません。";
        container.append(empty);
        return;
      }
      goals.forEach((goal) => {
        const row = document.createElement("div");
        row.className = "goal-event";
        const minute = document.createElement("time");
        minute.textContent = goal.minute;
        const copy = document.createElement("div");
        const scorer = document.createElement("strong");
        scorer.textContent = goal.scorer;
        const detail = document.createElement("small");
        detail.textContent = goalDetailLabel(goal);
        copy.append(scorer, detail);
        row.append(minute, copy);
        container.append(row);
      });
    }

    async function loadGoalEvents(fixture, container) {
      if (!fixture.id || AM4FootballData.classifyFixtureStatus(fixture.status) === "upcoming") return;
      const loading = document.createElement("p");
      loading.className = "goal-empty";
      loading.textContent = "得点者を読み込んでいます…";
      container.append(loading);
      try {
        const data = eventCache.get(fixture.id) || await client.fixtureEvents(fixture.id);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        eventCache.set(fixture.id, data);
        if (activeDialogFixtureId === fixture.id) renderGoalTimeline(container, data.goals || []);
      } catch (error) {
        if (activeDialogFixtureId === fixture.id) {
          container.replaceChildren();
          const unavailable = document.createElement("p");
          unavailable.className = "goal-empty";
          unavailable.textContent = "得点者情報を取得できませんでした。スコアは公式試合データを表示しています。";
          container.append(unavailable);
        }
        console.warn("Fixture goal events unavailable.", error);
      }
    }

    function fixtureKey(fixture) {
      return String(fixture.id || `${fixture.home}-${fixture.away}-${fixture.kickoff}`);
    }

    function editorialDateKey(value) {
      if (!value) return null;
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp)
        ? AM4FootballData.tokyoDateKey(value)
        : String(value).slice(0, 10) || null;
    }

    function articleMatchesFixture(article, fixture) {
      const match = article?.match;
      if (!match) return false;
      const articleFixtureId = Number(match.fixtureId);
      if (Number.isInteger(articleFixtureId) && articleFixtureId > 0 && articleFixtureId === Number(fixture.id)) return true;
      const fixtureDate = editorialDateKey(fixture.kickoff || fixture.date);
      const articleDate = editorialDateKey(match.date);
      const homeTeam = normalizeTeamName(match.homeTeam);
      const awayTeam = normalizeTeamName(match.awayTeam);
      return Boolean(
        fixtureDate && articleDate && fixtureDate === articleDate
        && homeTeam && awayTeam
        && homeTeam === normalizeTeamName(fixture.home)
        && awayTeam === normalizeTeamName(fixture.away)
      );
    }

    function editorialArticleForFixture(fixture, type) {
      return editorialArticles.find((article) => article?.type === type && articleMatchesFixture(article, fixture)) || null;
    }

    function editorialStrip(fixture, resultPresentation) {
      const status = AM4FootballData.classifyFixtureStatus(fixture.status);
      const report = status === "finished" ? editorialArticleForFixture(fixture, "match_report") : null;
      const prediction = status === "upcoming" ? editorialArticleForFixture(fixture, "match_prediction") : null;
      const article = report || prediction;
      if (!article) return null;

      const isResultGated = report && resultPresentation.hidden;
      const strip = document.createElement(isResultGated ? "aside" : "a");
      strip.className = "fixture-editorial-strip";
      strip.style.setProperty("--home-team-color", teamAccent(fixture.home));
      strip.style.setProperty("--away-team-color", teamAccent(fixture.away));
      const label = document.createElement("span");
      label.className = "fixture-editorial-label";
      label.textContent = report ? "AM4 試合解説" : "AM4 次節プレビュー";
      const copy = document.createElement("div");
      copy.className = "fixture-editorial-copy";
      const title = document.createElement("span");
      title.className = "fixture-editorial-title";

      if (isResultGated) {
        title.textContent = "結果を表示すると、AM4の試合解説を読めます";
        copy.append(title);
        strip.classList.add("fixture-editorial-strip--gated");
      } else {
        title.textContent = article.title || (report ? "試合解説を読む" : "次節プレビューを読む");
        strip.href = `/article.html?id=${encodeURIComponent(article.id)}`;
        strip.setAttribute("aria-label", `${report ? "AM4 試合解説" : "AM4 次節プレビュー"}: ${title.textContent}`);
        copy.append(title);
        const summary = document.createElement("p");
        const predictionMeta = prediction
          ? [article.prediction?.pick, article.prediction?.score].filter(Boolean).join(" · ")
          : "";
        summary.textContent = [predictionMeta, article.summary || article.deck].filter(Boolean).join(" — ");
        if (summary.textContent) copy.append(summary);
      }
      strip.append(label, copy);
      return strip;
    }

    function leagueGroupKey(competition) {
      return [
        fixtureMode,
        selectedDailyDate,
        activeFixtureFilter || "",
        fixtureScope,
        fixtureStatus,
        competition,
      ].join("|");
    }

    function openMatchDetail(fixture, sourceLabel) {
      activeDialogFixtureId = fixture.id || null;
      if (AM4FootballData.classifyFixtureStatus(fixture.status) === "finished") revealedFixtureIds.add(fixtureKey(fixture));
      const meta = document.createElement("div");
      meta.className = "match-dialog-meta";
      const kickoff = fixture.kickoff
        ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))
        : fixture.date || "日時未定";
      meta.textContent = `${fixture.competition || activeFixtureLeague} · ${fixture.roundLabel || "節情報なし"} · ${kickoff} JST`;

      const teams = document.createElement("div");
      teams.className = "match-dialog-teams";
      const home = document.createElement("div");
      const away = document.createElement("div");
      home.className = away.className = "match-dialog-team";
      home.append(teamLogo(fixture.home, fixture.homeLogo), document.createTextNode(fixture.home));
      away.append(teamLogo(fixture.away, fixture.awayLogo), document.createTextNode(fixture.away));
      const score = document.createElement("strong");
      score.className = "match-dialog-score";
      score.textContent = fixtureScoreLabel(fixture, " – ") || "VS";
      teams.append(home, score, away);

      const facts = document.createElement("div");
      facts.className = "match-dialog-facts";
      facts.append(
        detailFact("状況", fixtureStatusLabel(fixture.status)),
        detailFact("会場", fixture.venue || "会場情報は確認中"),
        detailFact("放送", "放送情報は確認中"),
        detailFact("データ", sourceLabel === "SAMPLE" ? "画面確認用サンプル" : "公式試合データ"),
      );

      const actions = document.createElement("div");
      actions.className = "match-dialog-actions";
      if (fixture.homeId) actions.append(clubFavoriteButton(fixture.homeId, fixture.home));
      if (fixture.awayId) actions.append(clubFavoriteButton(fixture.awayId, fixture.away));
      const goals = document.createElement("div");
      goals.className = "goal-timeline";
      goals.hidden = AM4FootballData.classifyFixtureStatus(fixture.status) === "upcoming";
      matchDialogBody.replaceChildren(meta, teams, goals, facts, actions);
      matchDialog.showModal();
      loadGoalEvents(fixture, goals);
    }

    function renderFixtures(items, sourceLabel = "") {
      fixturesNode.replaceChildren();
      const focusAfterReveal = pendingRevealedFixtureFocus;
      pendingRevealedFixtureFocus = null;
      const groups = new Map();
      AM4FootballData.sortFixturesForViewing(items).forEach((fixture) => {
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
      const prioritizeMajorLeagues = fixtureMode === "date"
        && activeFixtureLeague === ALL_COMPETITIONS
        && fixtureScope === "all";
      const showMajorLeagueEmptyStates = prioritizeMajorLeagues && fixtureStatus === "all";
      if (showMajorLeagueEmptyStates) {
        MAJOR_LEAGUES.forEach(({ providerId, competition, country, names }) => {
          const groupId = `id:${providerId}`;
          const isAlreadyRepresented = [...groups.values()].some((group) => (
            group.fixtures.some((fixture) => (
              Number(fixture.competitionId) === providerId || (
                names.includes(fixture.competition)
                && (!fixture.competitionCountry || fixture.competitionCountry === country)
              )
            ))
          ));
          if (!groups.has(groupId) && !isAlreadyRepresented) {
            groups.set(groupId, {
              groupId,
              competition,
              competitionId: providerId,
              competitionCountry: country,
              fixtures: [],
            });
          }
        });
      }
      const orderedGroups = [...groups.values()].sort((left, right) => {
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
      const canPageLeagueGroups = prioritizeMajorLeagues
        && orderedGroups.length > LEAGUE_GROUP_PREVIEW_LIMIT;
      const directoryKey = leagueGroupKey("_directory");
      const visibleGroupLimit = canPageLeagueGroups
        ? Math.min(orderedGroups.length, expandedLeagueGroupCounts.get(directoryKey) || LEAGUE_GROUP_PREVIEW_LIMIT)
        : orderedGroups.length;
      orderedGroups.forEach(({ groupId, competition, competitionId, competitionCountry, fixtures }, currentGroupIndex) => {
        if (currentGroupIndex >= visibleGroupLimit) return;
        const group = document.createElement("section");
        group.className = "fixture-league-group";
        const groupFixture = fixtures[0] || { competition, competitionId, competitionCountry };
        const isEmpty = fixtures.length === 0;
        if (isEmpty) group.classList.add("fixture-league-group--empty");
        const canCompact = fixtureMode === "date"
          && activeFixtureLeague === ALL_COMPETITIONS
          && fixtures.length > LEAGUE_PREVIEW_LIMIT;
        const groupKey = leagueGroupKey(groupId);
        const isExpanded = !canCompact || expandedLeagueGroups.has(groupKey);
        const heading = document.createElement("h3");
        heading.className = "fixture-league-heading";
        heading.tabIndex = -1;
        const logo = competitionLogo(groupFixture);
        const headingCopy = document.createElement("span");
        headingCopy.className = "fixture-league-heading-copy";
        const title = document.createElement("span");
        title.className = "fixture-league-title";
        title.textContent = competition;
        headingCopy.append(title);
        const countryName = competitionCountryLabel(groupFixture);
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
        if (logo) heading.append(logo, headingCopy, count);
        else heading.append(headingCopy, count);
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
            spoilersRevealed || revealedFixtureIds.has(fixtureKey(fixture)),
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
          const teams = document.createElement("div");
          teams.className = "fixture-teams";
          const scores = resultPresentation.hidden ? { home: "", away: "" } : fixtureTeamScores(fixture);
          teams.append(
            fixtureTeam(fixture.home, fixture.homeLogo, scores.home),
            fixtureTeam(fixture.away, fixture.awayLogo, scores.away),
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
            hint.textContent = "タップして";
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

          const cardTarget = document.createElement(resultPresentation.hidden || !fixture.id ? "button" : "a");
          cardTarget.className = "fixture-card-tap-target";
          if (resultPresentation.hidden || !fixture.id) cardTarget.type = "button";
          if (fixture.id && !resultPresentation.hidden) {
            cardTarget.href = `/match.html?id=${encodeURIComponent(fixture.id)}`;
          }
          cardTarget.setAttribute(
            "aria-label",
            resultPresentation.hidden
              ? `${fixture.competition || "大会"}、${fixture.home}対${fixture.away}の試合結果を表示`
              : `${fixture.home}対${fixture.away}${scoreText ? `、${scoreText}` : ""}。${fixture.id ? "試合詳細へ移動" : "試合情報を開く"}`,
          );
          if (resultPresentation.hidden || !fixture.id) {
            cardTarget.addEventListener("click", () => {
              if (resultPresentation.hidden) {
                revealedFixtureIds.add(fixtureKey(fixture));
                pendingRevealedFixtureFocus = fixtureKey(fixture);
                if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                  renderFixtureView();
                  return;
                }
                cardTarget.disabled = true;
                cardTarget.setAttribute("aria-busy", "true");
                let revealCompleted = false;
                const finishReveal = () => {
                  if (revealCompleted) return;
                  revealCompleted = true;
                  renderFixtureView();
                };
                scoreValue.addEventListener("animationend", (event) => {
                  if (event.animationName === "fixture-score-reveal") finishReveal();
                }, { once:true });
                scoreboard.classList.add("is-score-revealing");
                window.setTimeout(finishReveal, SCORE_REVEAL_FALLBACK_MS);
                return;
              }
              openMatchDetail(fixture, sourceLabel);
            });
          }
          row.append(cardTarget, meta, teams, scoreboard);
          if (focusAfterReveal === fixtureKey(fixture)) {
            window.requestAnimationFrame(() => cardTarget.focus());
          }
          list.append(row);
          const relatedEditorial = editorialStrip(fixture, resultPresentation);
          if (relatedEditorial) {
            relatedEditorial.hidden = row.hidden;
            list.append(relatedEditorial);
          }
          if (row.hidden) concealedNodes.push(row, relatedEditorial);
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
    }

    function savedClubFilters() {
      const saved = AM4Favorites.read(localStorage).clubs;
      const legacyNames = {
        "manchester-united": "Manchester United", liverpool: "Liverpool", arsenal: "Arsenal",
        chelsea: "Chelsea", "manchester-city": "Manchester City", newcastle: "Newcastle United",
      };
      return {
        favoriteClubIds: saved.filter((id) => id.startsWith("team-")),
        favoriteClubNames: saved.map((id) => legacyNames[id]).filter(Boolean),
        hasFavorites: saved.length > 0,
      };
    }

    function visibleFixtures(data) {
      const saved = savedClubFilters();
      if (fixtureScope === "favorites" && !saved.hasFavorites) return [];
      const statusFiltered = AM4FootballData.filterFixtures(data.fixtures || [], {
        status: fixtureStatus,
        favoriteClubIds: fixtureScope === "favorites" ? saved.favoriteClubIds : [],
        favoriteClubNames: fixtureScope === "favorites" ? saved.favoriteClubNames : [],
        focusOnly: false,
      });
      const competitionFiltered = fixtureMode === "date" && activeFixtureLeague !== ALL_COMPETITIONS
        ? statusFiltered.filter((fixture) => fixture.competition === activeFixtureLeague)
        : statusFiltered;
      return AM4FootballData.sortDailyFixtures(competitionFiltered);
    }

    function shiftDate(dateKey, days) {
      const value = new Date(`${dateKey}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    }

    function dateOptions() {
      const today = AM4FootballData.tokyoDateKey(new Date());
      return [-2, -1, 0, 1, 2, 3, 4].map((offset) => {
        const date = shiftDate(selectedDailyDate, offset);
        const value = new Date(`${date}T12:00:00Z`);
        return {
          value: date,
          label: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(value),
          small: date === today ? "今日" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(value),
        };
      });
    }

    function roundOptions(data) {
      const visibleRounds = new Set(visibleFixtures(data).map((fixture) => fixture.roundKey).filter(Boolean));
      const rounds = (data.rounds || []).filter((round) => visibleRounds.has(round.key));
      const selectedIndex = Math.max(0, rounds.findIndex((round) => round.key === activeFixtureFilter));
      const start = Math.max(0, Math.min(selectedIndex - 2, rounds.length - 6));
      return rounds.slice(start, start + 6).map((round) => ({ value: round.key, label: round.label, small: "節別" }));
    }

    function defaultRoundFilter(data) {
      const ordered = visibleFixtures(data).filter((fixture) => fixture.roundKey).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      return ordered.find((fixture) => Date.parse(fixture.kickoff) >= Date.now())?.roundKey || ordered.at(-1)?.roundKey || null;
    }

    function setLeagueButtons() {
      document.querySelectorAll(".league-tab").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.league === activeFixtureLeague));
      });
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

    function renderFixtureView() {
      if (!activeFixtureData) return;
      const options = fixtureMode === "date" ? dateOptions() : roundOptions(activeFixtureData);
      renderFilterTabs(options);
      const allVisible = visibleFixtures(activeFixtureData);
      const fixtures = fixtureMode === "round"
        ? allVisible.filter((fixture) => fixture.roundKey === activeFixtureFilter)
        : allVisible;
      renderFixtures(fixtures);
      const statusLabel = { upcoming: "今後", live: "ライブ", finished: "終了", all: "全試合" }[fixtureStatus];
      const scopeLabel = fixtureScope === "favorites" ? "お気に入り" : "すべて";
      const competitionLabel = activeFixtureLeague === ALL_COMPETITIONS ? "全大会" : activeFixtureLeague;
      const dateLabel = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${selectedDailyDate}T12:00:00Z`));
      const displayOrderLabel = fixtureMode === "date" && activeFixtureLeague === ALL_COMPETITIONS && fixtureScope === "all"
        ? "5大リーグ優先・リーグ内は時間順"
        : "リーグごとに時間順";
      if (fixtureOrderLabel) fixtureOrderLabel.textContent = displayOrderLabel;
      fixturesStatus.textContent = fixtures.length
        ? fixtureMode === "date"
          ? `${dateLabel} · ${competitionLabel} · ${statusLabel} · ${scopeLabel} · ${fixtures.length}試合 · ${displayOrderLabel} · ${updatedAt()}更新`
          : `${activeFixtureLeague} · ${activeFixtureFilter || "節未選択"} · ${statusLabel} · ${fixtures.length}試合`
        : fixtureScope === "favorites" && !savedClubFilters().hasFavorites
          ? "試合詳細からクラブを保存すると、該当試合だけを表示できます"
          : fixtureMode === "date"
            ? `${dateLabel}は、選択条件に該当する試合がありません`
            : `${activeFixtureLeague}の選択条件に該当する試合はありません`;
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
      dailyCache.set(date, data);
      fixtureMode = "date";
      selectedDailyDate = date;
      activeFixtureFilter = date;
      activeFixtureData = data;
      fixturesSource.hidden = true;
      setLeagueButtons();
      renderFixtureView();
      if (typeof onDailyData === "function") onDailyData({ date, data });
      scheduleLiveDailyRefresh();
    }

    function setEditorialArticles(items) {
      editorialArticles = Array.isArray(items) ? items.filter((article) => article?.id) : [];
      if (activeFixtureData) renderFixtureView();
    }

    async function loadFixtureDate(date) {
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
      clearLiveDailyRefresh();
      activeFixtureData = null;
      selectedDailyDate = date;
      activeFixtureFilter = date;
      renderFilterTabs(dateOptions());
      fixturesNode.replaceChildren();
      fixturesSource.hidden = false;
      fixturesSource.textContent = "取得できません";
      fixturesStatus.textContent = `${date}の${message}。架空の試合は表示していません。`;
    }

    function useFixtureData(league, data) {
      clearLiveDailyRefresh();
      leagueCache.set(league, data);
      fixtureMode = "round";
      activeFixtureLeague = league;
      activeFixtureData = data;
      activeFixtureFilter = defaultRoundFilter(data);
      fixturesSource.hidden = true;
      setLeagueButtons();
      renderFixtureView();
    }

    async function loadFixtureLeague(league) {
      clearLiveDailyRefresh();
      activeFixtureLeague = league;
      activeFixtureData = null;
      activeFixtureFilter = null;
      setLeagueButtons();
      fixtureFilters.replaceChildren();
      fixturesNode.replaceChildren();
      fixturesStatus.textContent = `${league}の節別日程を読み込んでいます`;
      try {
        const data = leagueCache.get(league) || await client.fixtures(league);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        if (!Array.isArray(data.fixtures)) throw new Error("invalid fixture response");
        if (fixtureMode === "round" && activeFixtureLeague === league) useFixtureData(league, data);
      } catch (error) {
        if (fixtureMode === "round" && activeFixtureLeague === league) {
          showFallback(`${league}を取得できないため、画面確認用サンプルを表示しています`);
        }
        console.warn("Fixture league unavailable.", error);
      }
    }

    function showFallback(message) {
      clearLiveDailyRefresh();
      fixturesSource.hidden = false;
      fixturesSource.textContent = "SAMPLE FALLBACK";
      fixturesStatus.textContent = message;
      renderFixtures(fallbackFixtures, "SAMPLE");
    }

    document.querySelectorAll(".league-tab").forEach((button) => button.addEventListener("click", () => {
      activeFixtureLeague = button.dataset.league;
      setLeagueButtons();
      if (fixtureMode === "date") {
        renderFixtureView();
      } else if (activeFixtureLeague === ALL_COMPETITIONS) {
        document.querySelector('[data-fixture-mode="date"]').click();
      } else {
        loadFixtureLeague(activeFixtureLeague);
      }
    }));

    document.querySelectorAll(".fixture-mode-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureMode = button.dataset.fixtureMode;
      clearLiveDailyRefresh();
      document.querySelectorAll(".fixture-mode-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (fixtureMode === "date") {
        loadFixtureDate(selectedDailyDate);
      } else {
        if (activeFixtureLeague === ALL_COMPETITIONS) activeFixtureLeague = DEFAULT_LEAGUE;
        loadFixtureLeague(activeFixtureLeague);
      }
    }));

    document.querySelectorAll(".fixture-status-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureStatus = button.dataset.fixtureStatus;
      document.querySelectorAll(".fixture-status-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (activeFixtureData) {
        if (fixtureMode === "round") activeFixtureFilter = defaultRoundFilter(activeFixtureData);
        renderFixtureView();
      }
    }));

    document.querySelectorAll(".fixture-scope-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureScope = button.dataset.fixtureScope;
      document.querySelectorAll(".fixture-scope-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (activeFixtureData) renderFixtureView();
    }));

    spoilerToggle?.addEventListener("click", () => {
      spoilersRevealed = !spoilersRevealed;
      if (!spoilersRevealed) revealedFixtureIds.clear();
      spoilerToggle.setAttribute("aria-pressed", String(spoilersRevealed));
      spoilerToggle.querySelector("span").textContent = spoilersRevealed ? "結果を隠す" : "結果を表示";
      if (activeFixtureData) renderFixtureView();
    });

    fixtureFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-fixture-filter]");
      if (!button) return;
      if (fixtureMode === "date") {
        loadFixtureDate(button.dataset.fixtureFilter);
      } else {
        activeFixtureFilter = button.dataset.fixtureFilter;
        renderFixtureView();
      }
    });

    document.addEventListener("am4:favorites-changed", () => {
      if (activeFixtureData && fixtureScope === "favorites") renderFixtureView();
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
    window.addEventListener("pagehide", clearLiveDailyRefresh, { once: true });
    matchDialog.querySelector(".match-dialog-close").addEventListener("click", () => matchDialog.close());
    matchDialog.addEventListener("close", () => { activeDialogFixtureId = null; });
    matchDialog.addEventListener("click", (event) => {
      if (event.target === matchDialog) matchDialog.close();
    });

    return { renderFixtures, useDailyData, loadFixtureDate, showDailyUnavailable, useFixtureData, showFallback, setEditorialArticles };
  }

  return { create };
});
