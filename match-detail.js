(function () {
  "use strict";

  const page = document.getElementById("match-page");
  const fixtureId = new URLSearchParams(window.location.search).get("id");
  const text = (value, fallback = "情報なし") => value == null || value === "" ? fallback : String(value);
  const statusLabels = { NS: "開催予定", TBD: "日時未定", FT: "試合終了", AET: "延長終了", PEN: "PK戦終了", HT: "ハーフタイム", "1H": "前半", "2H": "後半", ET: "延長戦", BT: "休憩", P: "PK戦", LIVE: "試合中", INT: "中断", PST: "延期", CANC: "中止", ABD: "中断", SUSP: "中断", AWD: "没収試合", WO: "不戦勝" };
  const statLabels = {
    "Shots on Goal": "枠内シュート", "Shots off Goal": "枠外シュート", "Total Shots": "シュート数", "Blocked Shots": "ブロックされたシュート",
    "Shots insidebox": "ペナルティエリア内", "Shots outsidebox": "ペナルティエリア外", Fouls: "ファウル", "Corner Kicks": "コーナーキック",
    Offsides: "オフサイド", "Ball Possession": "ボール支配率", "Yellow Cards": "イエローカード", "Red Cards": "レッドカード",
    "Goalkeeper Saves": "セーブ数", "Total passes": "パス数", "Passes accurate": "成功パス", "Passes %": "パス成功率",
    expected_goals: "xG", goals_prevented: "失点阻止",
  };
  const eventDetails = { "Normal Goal": "通常ゴール", "Own Goal": "オウンゴール", Penalty: "PK", "Yellow Card": "イエローカード", "Red Card": "レッドカード" };
  const LIVE_REFRESH_MS = 15_000;
  const KICKOFF_RECHECK_BUFFER_MS = 30_000;
  let client = null;
  let currentDetail = null;
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content != null) el.textContent = content;
    return el;
  }

  function backLink() {
    const link = node("a", "match-back", "試合一覧へ戻る");
    link.href = "/#fixtures";
    return link;
  }

  function state(title, message, retry) {
    const box = node("section", "match-page-state");
    box.append(node("h1", "", title), node("p", "", message));
    if (retry) {
      const button = node("button", "brand-button", "もう一度試す");
      button.type = "button";
      button.addEventListener("click", load);
      box.append(button);
    }
    page.replaceChildren(backLink(), box);
  }

  function crest(team) {
    team = team || {};
    const wrap = node("span", "match-crest");
    const fallback = node("span", "match-crest-fallback", text(team.name, "?").slice(0, 3));
    fallback.setAttribute("aria-hidden", "true");
    if (!team.logo) { wrap.append(fallback); return wrap; }
    const image = document.createElement("img");
    image.src = team.logo;
    image.alt = `${text(team.name)}のエンブレム`;
    image.width = 76;
    image.height = 76;
    image.decoding = "async";
    image.addEventListener("error", () => image.replaceWith(fallback), { once: true });
    wrap.append(image);
    return wrap;
  }

  function favorite(team) {
    team = team || {};
    if (!team.id) return null;
    const id = `team-${team.id}`;
    const button = node("button", "favorite-btn", "");
    button.type = "button";
    button.setAttribute("aria-pressed", String(AM4Favorites.has(AM4Favorites.read(localStorage), "clubs", id)));
    function update() {
      const active = AM4Favorites.has(AM4Favorites.read(localStorage), "clubs", id);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? `${text(team.name)}を保存済み` : `${text(team.name)}を保存`;
      button.setAttribute("aria-label", active ? `${text(team.name)}をお気に入りから削除` : `${text(team.name)}をお気に入りに保存`);
    }
    button.addEventListener("click", () => {
      AM4Favorites.toggle(localStorage, "clubs", id);
      update();
      document.dispatchEvent(new CustomEvent("am4:favorites-changed"));
    });
    update();
    return button;
  }

  function section(id, title, description) {
    const el = node("section", "match-section");
    el.id = id;
    const head = node("div", "match-section-head");
    head.append(node("h2", "", title));
    if (description) head.append(node("p", "", description));
    el.append(head);
    return el;
  }

  function unavailable(label) { return node("p", "match-unavailable", `${label}は提供されていません。`); }
  function eventKind(event) {
    const value = `${event.type || ""} ${event.detail || ""}`.toLowerCase();
    if (value.includes("goal")) return "goal";
    if (value.includes("card")) return value.includes("red") || value.includes("second yellow") ? "red-card" : "card";
    if (value.includes("subst")) return "sub";
    return "other";
  }
  function eventLabel(kind) {
    return { goal: "得点", card: "警告", "red-card": "退場", sub: "交代", other: "イベント" }[kind];
  }
  function eventSecondaryCopy(event, kind) {
    const detail = event.detail ? eventDetails[event.detail] || event.detail : "";
    if (kind === "goal" && event.assist?.name) return [`アシスト ${event.assist.name}`, detail].filter(Boolean).join(" · ");
    if (kind === "sub" && event.assist?.name) return [`交代相手 ${event.assist.name}`, detail].filter(Boolean).join(" · ");
    return detail || (event.player?.name ? "記録済み" : "選手情報なし");
  }

  function eventPlayer(event) {
    const player = event.player || {};
    return { id: player.id, name: text(player.name, "選手情報なし") };
  }

  function appendEventPhoto(target, player) {
    const id = Number(player.id);
    if (!Number.isInteger(id) || id <= 0) return;
    const image = document.createElement("img");
    image.className = "match-event-photo";
    image.src = `https://media.api-sports.io/football/players/${id}.png`;
    image.alt = "";
    image.width = 34;
    image.height = 34;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove(), { once: true });
    target.prepend(image);
  }

  function renderEvents(detail) {
    const el = section("events", "イベント", "得点、カード、交代");
    if (!detail.availability?.events || detail.events == null) { el.append(unavailable("イベントデータ")); return el; }
    if (!detail.events.length) { el.append(node("p", "match-empty", "この試合では記録されたイベントはありません。")); return el; }
    const teams = node("div", "match-timeline-teams");
    const home = node("span", "match-timeline-team match-timeline-team--home");
    const away = node("span", "match-timeline-team match-timeline-team--away");
    home.append(node("b", "", "ホーム"), node("strong", "", text(detail.fixture?.home?.name, "ホーム")));
    away.append(node("b", "", "アウェイ"), node("strong", "", text(detail.fixture?.away?.name, "アウェイ")));
    teams.append(home, node("span", "match-timeline-axis", "時間"), away);
    const timeline = node("ol", "match-timeline");
    detail.events.forEach((event) => {
      const kind = eventKind(event);
      const homeId = detail.fixture?.home?.id;
      const awayId = detail.fixture?.away?.id;
      const side = event.team?.id === homeId ? "home" : event.team?.id === awayId ? "away" : "neutral";
      const item = node("li", `match-event match-event--${kind} match-event--${side}`);
      const minute = node("time", "match-event-minute", text(event.minute, "—"));
      const body = node("div", "match-event-body");
      const player = eventPlayer(event);
      const playerLine = node("div", "match-event-player");
      appendEventPhoto(playerLine, player);
      playerLine.append(node("span", "match-event-player-name", player.name));
      const secondary = eventSecondaryCopy(event, kind);
      body.append(node("span", "match-event-type", eventLabel(kind)), playerLine, node("p", "", secondary));
      item.setAttribute("aria-label", `${text(event.team?.name, "チーム情報なし")}、${side === "home" ? "ホーム" : side === "away" ? "アウェイ" : "所属不明"}、${minute.textContent}、${eventLabel(kind)}、${player.name}、${secondary}`);
      if (side === "away") item.append(node("div", "match-event-spacer"), minute, body);
      else item.append(body, minute, node("div", "match-event-spacer"));
      timeline.append(item);
    });
    el.append(teams, timeline);
    return el;
  }

  function playerRow(player) {
    const item = node("li", "lineup-player");
    const number = node("span", "lineup-number", player.number == null ? "—" : String(player.number));
    const name = node("span", "lineup-name", text(player.name, "選手情報なし"));
    const position = node("small", "", text(player.position, "—"));
    item.append(number, name, position);
    return item;
  }
  function lineupCard(lineup) {
    const card = node("article", "lineup-card");
    const heading = node("div", "lineup-card-head");
    heading.append(node("h3", "", text(lineup.team?.name, "チーム情報なし")), node("span", "", lineup.formation ? `${lineup.formation}` : "フォーメーション未発表"));
    const coach = node("p", "lineup-coach", `監督 ${text(lineup.coach?.name, "情報なし")}`);
    card.append(heading, coach);
    const xiTitle = node("h4", "", "スターティングXI");
    card.append(xiTitle);
    if (lineup.startXI?.length) { const list = node("ol", "lineup-list"); lineup.startXI.forEach((player) => list.append(playerRow(player))); card.append(list); }
    else card.append(node("p", "match-empty", "先発メンバーは未発表です。"));
    const subTitle = node("h4", "", "控え選手");
    card.append(subTitle);
    if (lineup.substitutes?.length) { const list = node("ol", "lineup-list lineup-list--subs"); lineup.substitutes.forEach((player) => list.append(playerRow(player))); card.append(list); }
    else card.append(node("p", "match-empty", "控え選手の情報はありません。"));
    return card;
  }
  function renderLineups(detail) {
    const el = section("lineups", "ラインナップ", "フォーメーション、監督、登録選手");
    if (!detail.availability?.lineups || detail.lineups == null) { el.append(unavailable("ラインナップ")); return el; }
    if (!detail.lineups.length) { el.append(node("p", "match-empty", "ラインナップはまだ発表されていません。")); return el; }
    const grid = node("div", "lineup-grid"); detail.lineups.slice(0, 2).forEach((lineup) => grid.append(lineupCard(lineup))); el.append(grid); return el;
  }

  function statNumber(value) {
    const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function statLabel(value) { return statLabels[value] || text(value, "項目"); }
  function statBars(homeValue, awayValue) {
    const home = statNumber(homeValue);
    const away = statNumber(awayValue);
    if (home == null || away == null || home < 0 || away < 0 || home + away === 0) return null;
    const homeShare = Math.max(0, Math.min(100, (home / (home + away)) * 100));
    const bars = node("span", "match-stat-bars");
    bars.setAttribute("aria-hidden", "true");
    const homeBar = node("i", "match-stat-bar match-stat-bar--home");
    const awayBar = node("i", "match-stat-bar match-stat-bar--away");
    homeBar.style.width = `${homeShare}%`;
    awayBar.style.width = `${100 - homeShare}%`;
    bars.append(homeBar, awayBar);
    return bars;
  }
  function renderStatistics(detail) {
    const el = section("statistics", "スタッツ", "チーム比較");
    if (!detail.availability?.statistics || detail.statistics == null) { el.append(unavailable("スタッツ")); return el; }
    if (detail.statistics.length < 2) { el.append(node("p", "match-empty", "比較できるチームスタッツはありません。")); return el; }
    const home = detail.statistics.find((entry) => entry.team?.id === detail.fixture?.home?.id) || detail.statistics[0];
    const away = detail.statistics.find((entry) => entry.team?.id === detail.fixture?.away?.id && entry !== home) || detail.statistics.find((entry) => entry !== home);
    if (!home || !away) { el.append(node("p", "match-empty", "比較できるチームスタッツはありません。")); return el; }
    const values = new Map((home.statistics || []).map((stat) => [stat.type, { home: stat.value, away: null }]));
    (away.statistics || []).forEach((stat) => { const row = values.get(stat.type) || { home: null, away: null }; row.away = stat.value; values.set(stat.type, row); });
    if (!values.size) { el.append(node("p", "match-empty", "チームスタッツはまだ記録されていません。")); return el; }
    const table = node("div", "match-stats");
    const label = node("div", "match-stats-clubs"); label.append(node("span", "", text(home.team?.name)), node("span", "", text(away.team?.name))); table.append(label);
    values.forEach((stat, labelText) => {
      const row = node("div", "match-stat-row");
      const metric = node("div", "match-stat-metric");
      metric.append(node("span", "", statLabel(labelText)));
      const bars = statBars(stat.home, stat.away);
      if (bars) metric.append(bars);
      row.append(node("strong", "", text(stat.home, "—")), metric, node("strong", "", text(stat.away, "—")));
      table.append(row);
    });
    el.append(table); return el;
  }

  function kickoffLabel(fixture) {
    return fixture.kickoff
      ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))
      : "日時未定";
  }

  function isLiveFixture(fixture) {
    return AM4FootballData.classifyFixtureStatus(fixture?.status) === "live";
  }

  function renderBoard(fixture) {
    const kickoff = kickoffLabel(fixture);
    const board = node("article", "match-board");
    const competition = node("div", "match-competition");
    if (fixture.competitionLogo) { const logo = document.createElement("img"); logo.src = fixture.competitionLogo; logo.alt = ""; logo.width = 32; logo.height = 32; logo.decoding = "async"; logo.addEventListener("error", () => logo.remove(), { once: true }); competition.append(logo); }
    competition.append(node("span", "", text(fixture.competition, "大会情報なし")), node("small", "", text(fixture.competitionCountry, "国・地域情報なし")));
    const meta = node("p", "match-meta", `${kickoff} JST · ${text(fixture.roundLabel || fixture.round, "節情報なし")} · ${statusLabels[fixture.status] || text(fixture.statusLong, "状況確認中")}`);
    const liveRefresh = isLiveFixture(fixture)
      ? node("p", "match-live-refresh", `${fixture.elapsed ? `${fixture.elapsed}' · ` : ""}LIVE · 15秒ごとに更新`)
      : null;
    if (liveRefresh) liveRefresh.setAttribute("aria-live", "polite");
    const score = node("div", "match-score-grid");
    const home = node("div", "match-team match-team--home");
    home.append(crest(fixture.home), node("h1", "", text(fixture.home?.name)));
    const homeFavorite = favorite(fixture.home);
    if (homeFavorite) home.append(homeFavorite);
    const middle = node("div", "match-score");
    const hasScore = fixture.goals?.home != null && fixture.goals?.away != null;
    middle.append(node("strong", "", hasScore ? `${fixture.goals.home} – ${fixture.goals.away}` : "VS"), node("span", "", hasScore ? "SCORE" : "KICKOFF"));
    const away = node("div", "match-team match-team--away");
    away.append(crest(fixture.away), node("h1", "", text(fixture.away?.name)));
    const awayFavorite = favorite(fixture.away);
    if (awayFavorite) away.append(awayFavorite);
    score.append(home, middle, away);
    const facts = node("dl", "match-facts");
    [["会場", [fixture.venue?.name, fixture.venue?.city].filter(Boolean).join(" · ") || "会場情報なし"], ["主審", text(fixture.referee, "主審情報なし")], ["前半", fixture.score?.halftime?.home != null && fixture.score?.halftime?.away != null ? `${fixture.score.halftime.home} – ${fixture.score.halftime.away}` : "記録なし"]].forEach(([label, value]) => {
      const fact = node("div", "match-fact");
      fact.append(node("dt", "", label), node("dd", "", value));
      facts.append(fact);
    });
    board.append(competition, meta);
    if (liveRefresh) board.append(liveRefresh);
    board.append(score, facts);
    return board;
  }

  function renderNavigation() {
    const nav = node("nav", "match-anchor-nav"); nav.setAttribute("aria-label", "試合詳細のセクション"); [["overview", "概要"], ["events", "イベント"], ["lineups", "ラインナップ"], ["statistics", "スタッツ"]].forEach(([id, label]) => { const link = node("a", "", label); link.href = `#${id}`; nav.append(link); });
    return nav;
  }

  function renderOverview(fixture) {
    const overview = section("overview", "概要", "試合基本情報");
    overview.append(node("p", "match-overview-copy", statusLabels[fixture.status] || fixture.statusLong || "試合状況の詳しい情報はありません。"));
    return overview;
  }

  function replaceSection(id, sectionNode) {
    const previous = page.querySelector(`#${id}`);
    if (previous) previous.replaceWith(sectionNode);
  }

  function render(detail) {
    const fixture = detail.fixture;
    document.title = `${text(fixture.home?.name)} vs ${text(fixture.away?.name)}｜AM4`;
    page.replaceChildren(
      backLink(),
      renderBoard(fixture),
      renderNavigation(),
      renderOverview(fixture),
      renderEvents(detail),
      renderLineups(detail),
      renderStatistics(detail),
    );
    // Only the compact live indicator announces a later refresh. Re-announcing
    // an entire event timeline every 15 seconds would be disruptive to readers.
    page.setAttribute("aria-live", "off");
  }

  function renderLiveUpdate(detail) {
    const fixture = detail.fixture;
    const previousScrollY = window.scrollY;
    document.title = `${text(fixture.home?.name)} vs ${text(fixture.away?.name)}｜AM4`;
    page.querySelector(".match-board")?.replaceWith(renderBoard(fixture));
    replaceSection("overview", renderOverview(fixture));
    replaceSection("events", renderEvents(detail));
    replaceSection("statistics", renderStatistics(detail));
    window.scrollTo(0, previousScrollY);
  }

  function clearLiveRefresh() {
    if (liveRefreshTimer != null) window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  function liveRefreshDelay(fixture = currentDetail?.fixture) {
    if (!fixture) return null;
    if (isLiveFixture(fixture)) return LIVE_REFRESH_MS;
    if (AM4FootballData.classifyFixtureStatus(fixture.status) !== "upcoming") return null;
    const kickoffAt = Date.parse(fixture.kickoff || "");
    if (!Number.isFinite(kickoffAt)) return null;
    const untilKickoff = kickoffAt - Date.now();
    // A page opened before the whistle should wake once just after kickoff, then
    // switch to the normal 15-second live cadence when the provider says live.
    return untilKickoff > 0
      ? Math.max(LIVE_REFRESH_MS, untilKickoff + KICKOFF_RECHECK_BUFFER_MS)
      : LIVE_REFRESH_MS;
  }

  function canRefreshLiveDetail() {
    return document.visibilityState === "visible" && liveRefreshDelay() != null && !liveRefreshInFlight;
  }

  function scheduleLiveRefresh() {
    clearLiveRefresh();
    if (!canRefreshLiveDetail()) return;
    liveRefreshTimer = window.setTimeout(refreshLiveDetail, liveRefreshDelay());
  }

  async function refreshLiveDetail() {
    liveRefreshTimer = null;
    if (!canRefreshLiveDetail() || !client) return;
    liveRefreshInFlight = true;
    try {
      const fresh = await client.fixtureLiveDetail(fixtureId);
      if (!fresh?.fixture) return;
      const availability = { ...currentDetail.availability };
      const nextDetail = {
        ...currentDetail,
        fixture: fresh.fixture,
        availability,
      };
      // Optional live sections may fail independently. Keep the last confirmed
      // timeline/stat block instead of replacing it with an unavailable state.
      if (fresh.availability?.events === true) {
        nextDetail.events = fresh.events;
        availability.events = true;
      } else if (currentDetail.events == null) {
        availability.events = false;
      }
      if (fresh.availability?.statistics === true) {
        nextDetail.statistics = fresh.statistics;
        availability.statistics = true;
      } else if (currentDetail.statistics == null) {
        availability.statistics = false;
      }
      currentDetail = nextDetail;
      renderLiveUpdate(currentDetail);
    } catch (error) {
      console.warn("Live fixture detail refresh unavailable.", error);
    } finally {
      liveRefreshInFlight = false;
      scheduleLiveRefresh();
    }
  }

  async function load() {
    if (!/^[1-9]\d*$/.test(fixtureId || "")) { state("試合が指定されていません", "試合一覧から「試合詳細」を選んでください。"); return; }
    state("試合情報を読み込み中", "イベント、ラインナップ、スタッツを準備しています。");
    try {
      client = AM4FootballData.createClient(fetch, AM4SiteConfig.resolveApiBase(window.location.hostname));
      const detail = await client.fixtureDetail(fixtureId);
      if (!detail || !detail.fixture) { state("試合が見つかりません", "指定された試合は見つかりませんでした。"); return; }
      currentDetail = detail;
      render(currentDetail);
      scheduleLiveRefresh();
    } catch (error) {
      console.warn("Fixture detail unavailable.", error);
      state("試合情報を取得できませんでした", "時間をおいて、もう一度お試しください。", true);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      clearLiveRefresh();
    } else if (isLiveFixture(currentDetail?.fixture)) {
      refreshLiveDetail();
    } else {
      scheduleLiveRefresh();
    }
  });
  window.addEventListener("pagehide", clearLiveRefresh, { once: true });
  load();
})();
