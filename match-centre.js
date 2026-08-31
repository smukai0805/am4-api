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
    ["Real Madrid", "#d6ad45"], ["Malaga", "#1a76ba"], ["Deportivo La Coruna", "#5c5db1"], ["Valencia", "#f58220"],
    ["Celta Vigo", "#6fc7ef"], ["Athletic Club", "#e61d35"], ["Rennes", "#e51c2a"], ["Le Mans", "#d23b36"],
    ["Monaco", "#d9222a"], ["Marseille", "#00a8e6"], ["Manchester United", "#da291c"], ["Ipswich", "#2d5ba8"],
    ["FC Augsburg", "#bb2635"], ["FC Schalke 04", "#005ca9"], ["Napoli", "#1497d4"], ["Como", "#2777bb"],
    ["Cagliari", "#bd2637"], ["Inter", "#1b5fa7"], ["Lazio", "#79c7e9"], ["Genoa", "#be2638"],
  ]);

  function create({ client, teamLogo, updatedAt, fallbackFixtures = [] }) {
    const fixturesNode = document.getElementById("fixture-list");
    const fixturesSource = document.getElementById("fixtures-source");
    const fixturesStatus = document.getElementById("fixtures-status");
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
    let activeDialogFixtureId = null;
    let selectedDailyDate = AM4FootballData.tokyoDateKey(new Date());

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
      return TEAM_ACCENTS.get(name) || null;
    }

    function competitionLogo(fixture) {
      const competition = typeof fixture === "string" ? fixture : fixture?.competition;
      const leagueId = COMPETITION_LOGOS.get(competition);
      const source = fixture?.competitionLogo || (leagueId ? `https://media.api-sports.io/football/leagues/${leagueId}.png` : null);
      if (!source) return null;
      const logo = document.createElement("img");
      logo.className = "fixture-league-logo";
      logo.src = source;
      logo.alt = "";
      logo.width = 28;
      logo.height = 28;
      logo.decoding = "async";
      logo.addEventListener("error", () => logo.remove(), { once: true });
      return logo;
    }

    function competitionCountryLabel(fixture) {
      const country = fixture?.competitionCountry || COMPETITION_COUNTRIES.get(fixture?.competition);
      return COUNTRY_LABELS.get(country) || country || "";
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

    function eyeIcon() {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>';
      return icon;
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
      const groups = new Map();
      AM4FootballData.sortFixturesForViewing(items).forEach((fixture) => {
        const competition = fixture.competition || fixture.roundLabel || "大会情報確認中";
        if (!groups.has(competition)) groups.set(competition, []);
        groups.get(competition).push(fixture);
      });
      const canPageLeagueGroups = fixtureMode === "date"
        && activeFixtureLeague === ALL_COMPETITIONS
        && fixtureScope === "all"
        && groups.size > LEAGUE_GROUP_PREVIEW_LIMIT;
      const directoryKey = leagueGroupKey("_directory");
      const visibleGroupLimit = canPageLeagueGroups
        ? Math.min(groups.size, expandedLeagueGroupCounts.get(directoryKey) || LEAGUE_GROUP_PREVIEW_LIMIT)
        : groups.size;
      let groupIndex = 0;
      groups.forEach((fixtures, competition) => {
        const currentGroupIndex = groupIndex;
        groupIndex += 1;
        if (currentGroupIndex >= visibleGroupLimit) return;
        const group = document.createElement("section");
        group.className = "fixture-league-group";
        const canCompact = fixtureMode === "date"
          && activeFixtureLeague === ALL_COMPETITIONS
          && fixtures.length > LEAGUE_PREVIEW_LIMIT;
        const groupKey = leagueGroupKey(competition);
        const isExpanded = !canCompact || expandedLeagueGroups.has(groupKey);
        const heading = document.createElement("h3");
        heading.className = "fixture-league-heading";
        heading.tabIndex = -1;
        const logo = competitionLogo(fixtures[0] || competition);
        const headingCopy = document.createElement("span");
        headingCopy.className = "fixture-league-heading-copy";
        const title = document.createElement("span");
        title.className = "fixture-league-title";
        title.textContent = competition;
        headingCopy.append(title);
        const countryName = competitionCountryLabel(fixtures[0]);
        if (countryName) {
          const country = document.createElement("small");
          country.className = "fixture-league-country";
          country.textContent = countryName;
          headingCopy.append(country);
        }
        const count = document.createElement("small");
        count.className = "fixture-league-count";
        count.textContent = `${fixtures.length}試合`;
        if (logo) heading.append(logo, headingCopy, count);
        else heading.append(headingCopy, count);
        const list = document.createElement("div");
        list.className = "fixture-league-list";
        list.id = "fixture-league-" + currentGroupIndex;
        const concealedRows = [];
        fixtures.forEach((fixture, fixtureIndex) => {
          const row = document.createElement("article");
          row.className = "fixture-row";
          row.hidden = canCompact && !isExpanded && fixtureIndex >= LEAGUE_PREVIEW_LIMIT;
          if (row.hidden) concealedRows.push(row);
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
          const scoreboard = document.createElement(resultPresentation.hidden ? "button" : "div");
          scoreboard.className = "fixture-scoreboard";
          if (resultPresentation.hidden) {
            scoreboard.type = "button";
            scoreboard.classList.add("fixture-reveal-action");
            scoreboard.setAttribute("aria-label", `${fixture.home}対${fixture.away}の結果を見る`);
          }
          const fullScores = fixtureTeamScores(fixture);
          const scoreText = fullScores.home && fullScores.away ? `${fullScores.home} – ${fullScores.away}` : "";
          const scoreValue = document.createElement("span");
          scoreValue.className = "fixture-scoreboard-value";
          const scoreCaption = document.createElement("small");
          if (resultPresentation.hidden) {
            const icon = eyeIcon();
            icon.classList.add("fixture-scoreboard-icon");
            scoreboard.append(icon);
            scoreValue.textContent = "結果を見る";
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
          if (scoreCaption.textContent) scoreboard.append(scoreCaption);
          scoreboard.dataset.resultHidden = String(resultPresentation.hidden);
          const details = document.createElement(fixture.id ? "a" : "button");
          if (fixture.id) details.href = `/match.html?id=${encodeURIComponent(fixture.id)}`;
          else details.type = "button";
          details.className = "fixture-detail-action";
          details.textContent = "試合詳細 →";
          details.setAttribute("aria-label", `${fixture.home}対${fixture.away}の試合詳細${fixture.id ? "へ移動" : "を開く"}`);
          if (!fixture.id) details.addEventListener("click", () => openMatchDetail(fixture, sourceLabel));
          if (resultPresentation.hidden) {
            scoreboard.addEventListener("click", () => {
              revealedFixtureIds.add(fixtureKey(fixture));
              renderFixtureView();
            });
          }
          row.append(meta, teams, scoreboard, details);
          list.append(row);
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
            concealedRows.forEach((row) => { row.hidden = false; });
            group.dataset.expanded = "true";
            showMore.remove();
          });
          group.append(showMore);
        }
        fixturesNode.append(group);
      });
      if (visibleGroupLimit < groups.size) {
        const showMoreGroups = document.createElement("button");
        const remaining = groups.size - visibleGroupLimit;
        const nextBatch = Math.min(LEAGUE_GROUP_BATCH_SIZE, remaining);
        showMoreGroups.type = "button";
        showMoreGroups.className = "fixture-directory-toggle";
        showMoreGroups.textContent = "さらに" + nextBatch + "リーグを表示 · 残り" + remaining;
        showMoreGroups.setAttribute("aria-label", "次の" + nextBatch + "リーグを表示");
        showMoreGroups.setAttribute("aria-controls", "fixture-list");
        showMoreGroups.setAttribute("aria-expanded", "false");
        showMoreGroups.addEventListener("click", () => {
          const nextLimit = Math.min(groups.size, visibleGroupLimit + LEAGUE_GROUP_BATCH_SIZE);
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
      fixturesStatus.textContent = fixtures.length
        ? fixtureMode === "date"
          ? `${dateLabel} · ${competitionLabel} · ${statusLabel} · ${scopeLabel} · ${fixtures.length}試合 · リーグごとに時間順 · ${updatedAt()}更新`
          : `${activeFixtureLeague} · ${activeFixtureFilter || "節未選択"} · ${statusLabel} · ${fixtures.length}試合`
        : fixtureScope === "favorites" && !savedClubFilters().hasFavorites
          ? "試合詳細からクラブを保存すると、該当試合だけを表示できます"
          : fixtureMode === "date"
            ? `${dateLabel}は、選択条件に該当する試合がありません`
            : `${activeFixtureLeague}の選択条件に該当する試合はありません`;
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
    }

    async function loadFixtureDate(date) {
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
    matchDialog.querySelector(".match-dialog-close").addEventListener("click", () => matchDialog.close());
    matchDialog.addEventListener("close", () => { activeDialogFixtureId = null; });
    matchDialog.addEventListener("click", (event) => {
      if (event.target === matchDialog) matchDialog.close();
    });

    return { renderFixtures, useDailyData, loadFixtureDate, showDailyUnavailable, useFixtureData, showFallback };
  }

  return { create };
});
