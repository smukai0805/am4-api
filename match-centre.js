(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchCentre = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const ALL_COMPETITIONS = "すべて";
  const DEFAULT_LEAGUE = "プレミアリーグ";
  const COMPETITION_LOGOS = new Map([
    ["プレミアリーグ", 39], ["Premier League", 39],
    ["ラ・リーガ", 140], ["La Liga", 140],
    ["セリエA", 135], ["Serie A", 135],
    ["ブンデスリーガ", 78], ["Bundesliga", 78],
    ["リーグ・アン", 61], ["Ligue 1", 61],
    ["チャンピオンズリーグ", 2], ["UEFA Champions League", 2],
    ["クラブ親善試合", 667], ["Club Friendlies", 667],
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
    let activeFixtureLeague = ALL_COMPETITIONS;
    let fixtureMode = "date";
    let fixtureStatus = "all";
    let fixtureScope = "all";
    let fixtureCoverage = "focus";
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
      return TEAM_ACCENTS.get(name) || "#4a6eaf";
    }

    function competitionLogo(competition) {
      const leagueId = COMPETITION_LOGOS.get(competition);
      if (!leagueId) return null;
      const logo = document.createElement("img");
      logo.className = "fixture-league-logo";
      logo.src = `https://media.api-sports.io/football/leagues/${leagueId}.png`;
      logo.alt = "";
      logo.width = 28;
      logo.height = 28;
      logo.decoding = "async";
      return logo;
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
      groups.forEach((fixtures, competition) => {
        const group = document.createElement("section");
        group.className = "fixture-league-group";
        const heading = document.createElement("h3");
        heading.className = "fixture-league-heading";
        const logo = competitionLogo(competition);
        const title = document.createElement("span");
        title.textContent = competition;
        if (logo) heading.append(logo, title);
        else heading.append(title);
        const list = document.createElement("div");
        list.className = "fixture-league-list";
        fixtures.forEach((fixture) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "fixture-row";
          const statusGroup = AM4FootballData.classifyFixtureStatus(fixture.status);
          const resultPresentation = AM4FootballData.fixtureResultPresentation(
            fixture,
            spoilersRevealed || revealedFixtureIds.has(fixtureKey(fixture)),
          );
          row.setAttribute("aria-label", `${fixture.home}対${fixture.away}の${resultPresentation.hidden ? "結果を見る" : "詳細を見る"}`);
          row.style.setProperty("--home-team-color", teamAccent(fixture.home));
          row.style.setProperty("--away-team-color", teamAccent(fixture.away));
          row.innerHTML = '<div class="fixture-meta"><div class="fixture-date"></div></div><div class="fixture-teams"></div><strong class="fixture-scoreboard"><span class="fixture-scoreboard-value"></span><small></small></strong><span class="sample-label"></span>';
          row.querySelector(".fixture-date").textContent = fixture.kickoff
            ? `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))} JST`
            : fixture.date;
          const teams = row.querySelector(".fixture-teams");
          const scores = resultPresentation.hidden ? { home: "", away: "" } : fixtureTeamScores(fixture);
          teams.append(
            fixtureTeam(fixture.home, fixture.homeLogo, scores.home),
            fixtureTeam(fixture.away, fixture.awayLogo, scores.away),
          );
          const scoreboard = row.querySelector(".fixture-scoreboard");
          const fullScores = fixtureTeamScores(fixture);
          const scoreText = fullScores.home && fullScores.away ? `${fullScores.home} – ${fullScores.away}` : "VS";
          scoreboard.querySelector(".fixture-scoreboard-value").textContent = scoreText;
          scoreboard.querySelector("small").textContent = statusGroup === "live" ? "LIVE" : statusGroup === "finished" ? "FULL-TIME" : "KICKOFF";
          scoreboard.hidden = statusGroup === "upcoming";
          scoreboard.dataset.resultHidden = String(resultPresentation.hidden);
          const rowLabel = row.querySelector(".sample-label");
          const rowLabelText = resultPresentation.hidden
            ? "結果を見る"
            : statusGroup === "live"
              ? "LIVE"
              : statusGroup === "finished"
                ? "終了"
                : fixture.note || (sourceLabel === "SAMPLE" ? sourceLabel : "");
          rowLabel.textContent = rowLabelText;
          rowLabel.hidden = !rowLabelText;
          rowLabel.dataset.resultHidden = String(resultPresentation.hidden);
          rowLabel.dataset.live = String(statusGroup === "live");
          row.addEventListener("click", () => {
            openMatchDetail(fixture, sourceLabel);
            if (statusGroup === "finished" && resultPresentation.hidden) renderFixtureView();
          });
          list.append(row);
        });
        group.append(heading, list);
        fixturesNode.append(group);
      });
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
        focusOnly: fixtureMode === "date" && fixtureCoverage === "focus" && fixtureScope !== "favorites",
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
      const scopeLabel = fixtureScope === "favorites" ? "お気に入り" : "全クラブ";
      const coverageLabel = fixtureCoverage === "focus" ? "主要＋注目クラブ" : "世界の全試合";
      const competitionLabel = activeFixtureLeague === ALL_COMPETITIONS ? "全大会" : activeFixtureLeague;
      const dateLabel = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${selectedDailyDate}T12:00:00Z`));
      fixturesStatus.textContent = fixtures.length
        ? fixtureMode === "date"
          ? `${dateLabel} · ${coverageLabel} · ${competitionLabel} · ${statusLabel} · ${scopeLabel} · ${fixtures.length}試合 · 試合中・このあと優先 · ${updatedAt()}更新`
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

    document.querySelectorAll(".fixture-coverage-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureCoverage = button.dataset.fixtureCoverage;
      document.querySelectorAll(".fixture-coverage-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (activeFixtureData) renderFixtureView();
    }));

    spoilerToggle?.addEventListener("click", () => {
      spoilersRevealed = !spoilersRevealed;
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
