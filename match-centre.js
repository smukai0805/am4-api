(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchCentre = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function create({ client, teamLogo, updatedAt, fallbackFixtures = [] }) {
    const fixturesNode = document.getElementById("fixture-list");
    const fixturesSource = document.getElementById("fixtures-source");
    const fixturesStatus = document.getElementById("fixtures-status");
    const fixtureFilters = document.getElementById("fixture-filters");
    const matchDialog = document.getElementById("match-detail-dialog");
    const matchDialogBody = document.getElementById("match-detail-body");
    const fixtureCache = new Map();
    let activeFixtureLeague = "プレミアリーグ";
    let fixtureMode = "date";
    let fixtureStatus = "upcoming";
    let fixtureScope = "all";
    let activeFixtureData = null;
    let activeFixtureFilter = null;

    function fixtureTeam(name, logo) {
      const team = document.createElement("span");
      team.className = "fixture-team";
      team.append(teamLogo(name, logo), document.createTextNode(name));
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

    function openMatchDetail(fixture, sourceLabel) {
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
      matchDialogBody.replaceChildren(meta, teams, facts, actions);
      matchDialog.showModal();
    }

    function renderFixtures(items, sourceLabel = "") {
      fixturesNode.replaceChildren();
      items.forEach((fixture) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "fixture-row";
        row.setAttribute("aria-label", `${fixture.home}対${fixture.away}の詳細を見る`);
        row.innerHTML = '<div><div class="fixture-date"></div><div class="fixture-comp"></div></div><div class="fixture-teams"></div><span class="sample-label"></span>';
        row.querySelector(".fixture-date").textContent = fixture.kickoff
          ? `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))} JST`
          : fixture.date;
        row.querySelector(".fixture-comp").textContent = fixture.roundLabel || fixture.competition || "Premier League";
        const teams = row.querySelector(".fixture-teams");
        const versus = document.createElement("span");
        versus.className = "fixture-versus";
        versus.textContent = "vs";
        teams.append(fixtureTeam(fixture.home, fixture.homeLogo), versus, fixtureTeam(fixture.away, fixture.awayLogo));
        const rowLabel = row.querySelector(".sample-label");
        const statusGroup = AM4FootballData.classifyFixtureStatus(fixture.status);
        const scoreLabel = fixtureScoreLabel(fixture);
        const rowLabelText = statusGroup === "live" ? `LIVE${scoreLabel ? ` · ${scoreLabel}` : ""}` : scoreLabel || fixture.note || (sourceLabel === "SAMPLE" ? sourceLabel : "");
        rowLabel.textContent = rowLabelText;
        rowLabel.hidden = !rowLabelText;
        row.addEventListener("click", () => openMatchDetail(fixture, sourceLabel));
        fixturesNode.append(row);
      });
    }

    function nearestUpcomingDate(dates) {
      const today = AM4FootballData.tokyoDateKey(new Date());
      return dates.find((date) => date >= today) || dates.at(-1) || null;
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
      return AM4FootballData.filterFixtures(data.fixtures || [], {
        status: fixtureStatus,
        favoriteClubIds: fixtureScope === "favorites" ? saved.favoriteClubIds : [],
        favoriteClubNames: fixtureScope === "favorites" ? saved.favoriteClubNames : [],
      });
    }

    function filterOptions(data) {
      const visible = visibleFixtures(data);
      if (fixtureMode === "round") {
        const visibleRounds = new Set(visible.map((fixture) => fixture.roundKey).filter(Boolean));
        const rounds = (data.rounds || []).filter((round) => visibleRounds.has(round.key));
        const selectedIndex = Math.max(0, rounds.findIndex((round) => round.key === activeFixtureFilter));
        const start = Math.max(0, Math.min(selectedIndex - 2, rounds.length - 6));
        return rounds.slice(start, start + 6).map((round) => ({ value: round.key, label: round.label, small: "節別" }));
      }
      const dates = [...new Set(visible.filter((fixture) => fixture.kickoff).map((fixture) => AM4FootballData.tokyoDateKey(fixture.kickoff)))].sort();
      const anchor = fixtureStatus === "finished" ? dates.at(-1) : nearestUpcomingDate(dates);
      const start = Math.max(0, Math.min(dates.indexOf(anchor) - 2, dates.length - 6));
      return dates.slice(start, start + 6).map((date) => {
        const value = new Date(`${date}T12:00:00Z`);
        return {
          value: date,
          label: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(value),
          small: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(value),
        };
      });
    }

    function defaultFixtureFilter(data) {
      const fixtures = visibleFixtures(data);
      if (fixtureMode === "date") {
        const dates = [...new Set(fixtures.filter((fixture) => fixture.kickoff).map((fixture) => AM4FootballData.tokyoDateKey(fixture.kickoff)))].sort();
        return fixtureStatus === "finished" ? dates.at(-1) || null : nearestUpcomingDate(dates);
      }
      const ordered = fixtures.filter((fixture) => fixture.roundKey).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      const selected = fixtureStatus === "finished" ? ordered.at(-1) : ordered.find((fixture) => Date.parse(fixture.kickoff) >= Date.now()) || ordered.at(-1);
      return selected?.roundKey || null;
    }

    function renderFixtureView() {
      if (!activeFixtureData) return;
      if (!activeFixtureFilter) activeFixtureFilter = defaultFixtureFilter(activeFixtureData);
      const options = filterOptions(activeFixtureData);
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
      const fixtures = visibleFixtures(activeFixtureData).filter((fixture) =>
        fixtureMode === "date" ? AM4FootballData.tokyoDateKey(fixture.kickoff) === activeFixtureFilter : fixture.roundKey === activeFixtureFilter,
      );
      renderFixtures(fixtures);
      const statusLabel = { upcoming: "今後", live: "ライブ", finished: "終了", all: "すべて" }[fixtureStatus];
      const scopeLabel = fixtureScope === "favorites" ? "お気に入りクラブ" : "全クラブ";
      fixturesStatus.textContent = fixtures.length
        ? `${activeFixtureLeague} · ${statusLabel} · ${scopeLabel} · ${fixtures.length}試合 · ${updatedAt()}更新 · 時刻はJST`
        : fixtureScope === "favorites" && !savedClubFilters().hasFavorites
          ? "お気に入りクラブを試合詳細から保存すると、ここに試合が並びます"
          : `${activeFixtureLeague} · ${statusLabel}に該当する試合はありません`;
    }

    function useFixtureData(league, data) {
      fixtureCache.set(league, data);
      activeFixtureLeague = league;
      activeFixtureData = data;
      activeFixtureFilter = defaultFixtureFilter(data);
      document.querySelectorAll(".league-tab").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.league === league)));
      fixturesSource.hidden = true;
      renderFixtureView();
    }

    async function loadFixtureLeague(league) {
      activeFixtureLeague = league;
      activeFixtureData = null;
      activeFixtureFilter = null;
      document.querySelectorAll(".league-tab").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.league === league)));
      fixtureFilters.replaceChildren();
      fixturesNode.replaceChildren();
      fixturesStatus.textContent = `${league}の試合を読み込んでいます`;
      try {
        const data = fixtureCache.get(league) || await client.fixtures(league);
        if (data.errors && Object.keys(data.errors).length) throw new Error("provider returned errors");
        if (!Array.isArray(data.fixtures)) throw new Error("invalid fixture response");
        if (activeFixtureLeague === league) useFixtureData(league, data);
      } catch (error) {
        if (activeFixtureLeague === league) {
          showFallback(`${league}の試合を取得できないため、画面確認用サンプルを表示しています`);
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

    document.querySelectorAll(".league-tab").forEach((button) => button.addEventListener("click", () => loadFixtureLeague(button.dataset.league)));
    document.querySelectorAll(".fixture-mode-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureMode = button.dataset.fixtureMode;
      document.querySelectorAll(".fixture-mode-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      activeFixtureFilter = activeFixtureData ? defaultFixtureFilter(activeFixtureData) : null;
      renderFixtureView();
    }));
    document.querySelectorAll(".fixture-status-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureStatus = button.dataset.fixtureStatus;
      document.querySelectorAll(".fixture-status-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      activeFixtureFilter = activeFixtureData ? defaultFixtureFilter(activeFixtureData) : null;
      renderFixtureView();
    }));
    document.querySelectorAll(".fixture-scope-tab").forEach((button) => button.addEventListener("click", () => {
      fixtureScope = button.dataset.fixtureScope;
      document.querySelectorAll(".fixture-scope-tab").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      activeFixtureFilter = activeFixtureData ? defaultFixtureFilter(activeFixtureData) : null;
      renderFixtureView();
    }));
    fixtureFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-fixture-filter]");
      if (!button) return;
      activeFixtureFilter = button.dataset.fixtureFilter;
      renderFixtureView();
    });
    document.addEventListener("am4:favorites-changed", () => {
      if (activeFixtureData && fixtureScope === "favorites") {
        activeFixtureFilter = defaultFixtureFilter(activeFixtureData);
        renderFixtureView();
      }
    });
    matchDialog.querySelector(".match-dialog-close").addEventListener("click", () => matchDialog.close());
    matchDialog.addEventListener("click", (event) => {
      if (event.target === matchDialog) matchDialog.close();
    });

    return { renderFixtures, useFixtureData, showFallback };
  }

  return { create };
});
