(function () {
  "use strict";

  const page = document.getElementById("match-page");
  const query = new URLSearchParams(window.location.search);
  const fixtureId = query.get("id");
  const archiveArticleQueryId = query.get("article");
  const archiveMatchKey = query.get("matchKey");
  const locale = document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "ja";
  const text = (value, fallback = "—") => value == null || value === "" ? fallback : String(value);
  const UI = {
    ja: {
      back: "試合一覧へ戻る", retry: "もう一度試す", overview: "概要", events: "イベント", lineups: "ラインナップ", statistics: "スタッツ", standings: "順位",
      eventDescription: "試合終了からキックオフへ遡って表示", lineupDescription: "フォーメーション、監督、登録選手", statsDescription: "チーム比較", standingsDescription: "この対戦のリーグ内での現在地",
      home: "ホーム", away: "アウェイ", assist: "アシスト", goal: "ゴール", yellow_card: "イエローカード", red_card: "レッドカード", substitution: "選手交代",
      penalty: "PK", penalty_missed: "PK失敗", own_goal: "オウンゴール", var: "VAR", other: "イベント", second_yellow: "2枚目のイエローカード",
      preview: "MATCH PREVIEW", live: "LIVE MATCH", summary: "MATCH SUMMARY", archive: "AM4 ARCHIVE", prediction: "AM4 PREDICTION", matchSummary: "AM4 MATCH SUMMARY",
      score: "SCORE", goals: "GOALS", cards: "CARDS", predictionPending: "AM4の試合予想は公開準備中です。", reportPending: "AM4の試合解説は公開準備中です。",
      priorPrediction: "試合前のAM4予想を読む", previewDescription: "AM4の予想と、試合の見どころをまとめています。", liveDescription: "現在の試合状況と、試合前の見立てを確認できます。", summaryDescription: "結果と試合の要点を短時間で確認できます。", archiveDescription: "現在の試合データを取得できないため、公開済みAM4記事のみを表示しています。試合結果・イベント・ラインナップはこのアーカイブには保存されていません。",
      threeLine: "3行要約", previousReview: "前節レビュー", adjustments: "前節からの修正", tacticalMatchup: "戦術的な噛み合わせ", keyPlayers: "キープレイヤー", absences: "欠場情報", matchOutlook: "予想される試合展開", rationale: "予想の根拠",
      turningPoints: "試合を分けたポイント", firstHalf: "前半レビュー", secondHalf: "後半レビュー", tactics: "戦術分析", individualPerformance: "個人パフォーマンス", resultMeaning: "結果の意味", nextMatchFocus: "次戦への課題",
      pick: "本命", confidence: "確信度", kickoff: "KICK OFF", fullTime: "試合終了", halfTime: "前半終了", firstHalfFlow: "前半の流れ", secondHalfFlow: "後半の流れ", liveUpdate: "15秒ごとに更新", halftime: "前半", venue: "会場", referee: "主審", noEvents: "この試合では記録されたイベントはありません。", noLineups: "ラインナップはまだ発表されていません。", noStats: "比較できるチームスタッツはありません。", standingsLoading: "順位表を読み込んでいます。", noStandings: "この大会には順位表がありません。", standingsUnavailable: "順位表を取得できませんでした。", champions_league: "チャンピオンズリーグ", europa_league: "ヨーロッパリーグ", conference_league: "カンファレンスリーグ", relegation: "降格",
    },
    en: {
      back: "Back to matches", retry: "Try again", overview: "Overview", events: "Events", lineups: "Line-ups", statistics: "Stats", standings: "Standings",
      eventDescription: "Follow the match from full-time back to kick-off", lineupDescription: "Formation, coach and squad", statsDescription: "Team comparison", standingsDescription: "Where these two teams sit in this competition",
      home: "Home", away: "Away", assist: "ASSIST", goal: "Goal", yellow_card: "Yellow Card", red_card: "Red Card", substitution: "Substitution",
      penalty: "Penalty", penalty_missed: "Penalty Missed", own_goal: "Own Goal", var: "VAR", other: "Event", second_yellow: "Second Yellow",
      preview: "MATCH PREVIEW", live: "LIVE MATCH", summary: "MATCH SUMMARY", archive: "AM4 ARCHIVE", prediction: "AM4 PREDICTION", matchSummary: "AM4 MATCH SUMMARY",
      score: "SCORE", goals: "GOALS", cards: "CARDS", predictionPending: "AM4 prediction is being prepared.", reportPending: "AM4 match analysis is being prepared.",
      priorPrediction: "Read the pre-match AM4 prediction", previewDescription: "AM4 prediction and the key matchups.", liveDescription: "Follow the score and revisit the pre-match view.", summaryDescription: "The result and decisive moments, at a glance.", archiveDescription: "Current match data is unavailable. Showing only published AM4 editorial; scores, events, and line-ups were not retained in this archive.",
      threeLine: "Three-line summary", previousReview: "Previous-match review", adjustments: "Expected adjustments", tacticalMatchup: "Tactical matchup", keyPlayers: "Key players", absences: "Absences", matchOutlook: "Expected match flow", rationale: "Why AM4 sees it this way",
      turningPoints: "Decisive moments", firstHalf: "First-half review", secondHalf: "Second-half review", tactics: "Tactical analysis", individualPerformance: "Individual performances", resultMeaning: "What the result means", nextMatchFocus: "Next-match focus",
      pick: "Pick", confidence: "Confidence", kickoff: "KICK OFF", fullTime: "FULL TIME", halfTime: "HALF TIME", firstHalfFlow: "FIRST-HALF FLOW", secondHalfFlow: "SECOND-HALF FLOW", liveUpdate: "updates every 15 seconds", halftime: "Half-time", venue: "Venue", referee: "Referee", noEvents: "No recorded events for this match.", noLineups: "Line-ups have not been announced.", noStats: "Comparable team stats are not available.", standingsLoading: "Loading standings.", noStandings: "This competition does not have a standings table.", standingsUnavailable: "Standings could not be loaded.", champions_league: "Champions League", europa_league: "Europa League", conference_league: "Conference League", relegation: "Relegation",
    },
  };
  const t = (key) => UI[locale][key] || key;
  const statusLabels = { NS: ["開催予定", "Scheduled"], TBD: ["日時未定", "Date TBD"], FT: ["試合終了", "Full-time"], AET: ["延長終了", "After extra time"], PEN: ["PK戦終了", "Penalties"], HT: ["ハーフタイム", "Half-time"], "1H": ["前半", "First half"], "2H": ["後半", "Second half"], ET: ["延長戦", "Extra time"], BT: ["休憩", "Break"], P: ["PK戦", "Penalties"], LIVE: ["試合中", "Live"], INT: ["中断", "Interrupted"], PST: ["延期", "Postponed"], CANC: ["中止", "Cancelled"], ABD: ["中断", "Abandoned"], SUSP: ["中断", "Suspended"], AWD: ["没収試合", "Awarded"], WO: ["不戦勝", "Walkover"], ARCHIVE: ["公開済みアーカイブ", "Published archive"] };
  const statLabels = {
    "Shots on Goal": "枠内シュート", "Shots off Goal": "枠外シュート", "Total Shots": "シュート数", "Blocked Shots": "ブロックされたシュート",
    "Shots insidebox": "ペナルティエリア内", "Shots outsidebox": "ペナルティエリア外", Fouls: "ファウル", "Corner Kicks": "コーナーキック",
    Offsides: "オフサイド", "Ball Possession": "ボール支配率", "Yellow Cards": "イエローカード", "Red Cards": "レッドカード",
    "Goalkeeper Saves": "セーブ数", "Total passes": "パス数", "Passes accurate": "成功パス", "Passes %": "パス成功率",
    expected_goals: "xG", goals_prevented: "失点阻止",
  };
  const LIVE_REFRESH_MS = 15_000;
  const KICKOFF_RECHECK_BUFFER_MS = 30_000;
  let client = null;
  let currentDetail = null;
  const reportReadingState = new Map();
  let currentEditorial = { prediction: null, report: null, loading: true };
  let currentStandings = { state: "idle", data: null };
  const PANEL_IDS = new Set(["overview", "events", "lineups", "statistics", "standings"]);
  let activePanel = PANEL_IDS.has(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "overview";
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;
  let editorialRequest = 0;
  let standingsRequest = 0;
  let lineupMemberTeamId = null;

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content != null) el.textContent = content;
    return el;
  }

  function matchListReturnUrl() {
    return window.AM4NavigationState?.readMatchReturnUrl(sessionStorage, "/#fixtures") || "/#fixtures";
  }

  function backLink() {
    const link = node("a", "match-back", t("back"));
    link.href = matchListReturnUrl();
    return link;
  }

  // Keep the static loading/error-state return link in sync too; users should
  // not lose their selected list merely because the detail request is pending.
  const initialBackLink = page?.querySelector(".match-back");
  if (initialBackLink) initialBackLink.href = matchListReturnUrl();

  function state(title, message, retry) {
    const box = node("section", "match-page-state");
    box.append(node("h1", "", title), node("p", "", message));
    if (retry) {
      const button = node("button", "brand-button", t("retry"));
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
    const button = node("button", "favorite-btn match-team-favorite", "");
    button.type = "button";
    button.setAttribute("aria-pressed", String(AM4Favorites.has(AM4Favorites.read(localStorage), "clubs", id)));
    function update() {
      const active = AM4Favorites.has(AM4Favorites.read(localStorage), "clubs", id);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? "★" : "☆";
      button.setAttribute("aria-label", active ? `${text(team.name)}をお気に入りから削除` : `${text(team.name)}をお気に入りに保存`);
      button.title = button.getAttribute("aria-label");
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const saved = AM4Favorites.toggleWithItem(localStorage, "clubs", id, {
        label: text(team.name),
        detail: `${text(team.name)}の試合を優先表示`,
        href: "/#fixtures",
      });
      if (!saved) {
        button.setAttribute("aria-label", `${text(team.name)}をこの端末に保存できませんでした`);
        button.title = "この端末に保存できませんでした";
        return;
      }
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

  function unavailable(label) { return node("p", "match-unavailable", locale === "ja" ? `${label}は提供されていません。` : `${label} is not available.`); }
  const canonicalEventTypes = new Set(["goal", "yellow_card", "red_card", "substitution", "penalty", "penalty_missed", "own_goal", "var", "other"]);
  function eventKind(event) {
    if (canonicalEventTypes.has(event?.type)) return event.type;
    const value = `${event?.type || ""} ${event?.detail || ""}`.toLowerCase();
    if (value.includes("var") || value.includes("disallowed") || value.includes("cancelled") || value.includes("canceled")) return "var";
    if (value.includes("subst")) return "substitution";
    if (value.includes("card")) return value.includes("red") || value.includes("second yellow") ? "red_card" : "yellow_card";
    if (value.includes("goal")) {
      if (value.includes("missed penalty")) return "penalty_missed";
      if (value.includes("own goal")) return "own_goal";
      if (value.includes("penalty")) return "penalty";
      return "goal";
    }
    return "other";
  }
  function eventLabel(event) {
    const kind = eventKind(event);
    if (kind === "red_card" && event?.subtype === "second_yellow") return t("second_yellow");
    return t(kind);
  }
  function eventNote(event) {
    const kind = eventKind(event);
    if (kind === "var" && event.detail) return locale === "ja" ? "VAR判定" : "VAR review";
    if (kind === "other") return text(event.detail || event.comments, "");
    return "";
  }

  let nameRegistry = AM4PlayerDisplay.createRegistry();
  let insightState = {state:'idle', data:null};
  let insightFetchedAt = 0;
  const insightReads = new Map();
  function readLineupInsights(id, force = false) {
    const prior = insightReads.get(id);
    if (prior && (prior.pending || (!force && prior.until > Date.now()))) return prior.promise;
    const entry = {pending:true, until:Date.now()+60000};
    entry.promise = client.lineupInsights(id).then(data => {
      if (Number(data?.fixtureId) !== Number(id)) throw new Error('Fixture mismatch');
      return data;
    }).catch(error => { if (insightReads.get(id) === entry) insightReads.delete(id); throw error; })
      .finally(() => { entry.pending=false; });
    insightReads.set(id,entry);
    if (insightReads.size > 4) insightReads.delete(insightReads.keys().next().value);
    return entry.promise;
  }
  function updateNames(detail) {
    nameRegistry = AM4PlayerDisplay.createRegistry([
      ...(detail.events || []).flatMap(e => [e.player,e.assist]),
      ...(insightState.data?.lineups || detail.lineups || []).flatMap(l => [...(l.startXI || []),...(l.substitutes || [])]),
      ...(insightState.data?.players || [])
    ]);
  }
  function displayPlayerName(player) { return nameRegistry.name(player?.player || player || {}); }
  function playerButton(player, className = '') {
    const button = node('button', `player-name-button ${className}`, displayPlayerName(player));
    button.type = 'button';
    button.addEventListener('click', () => showPlayer(player));
    return button;
  }
  function showPlayer(player) {
    const dialog = node('dialog','player-sheet');
    const close = node('button','player-sheet-close',locale === 'ja' ? '閉じる' : 'Close');
    close.type = 'button'; close.addEventListener('click',()=>dialog.close());
    const title = node('h2','', nameRegistry.full(player)); title.id = 'player-sheet-title';
    dialog.setAttribute('aria-labelledby',title.id);
    dialog.append(close,title);
    const stat = insightState.data?.players?.find(p => p.id === player.id);
    if (stat?.rating != null) dialog.append(node('p','',`${locale === 'ja' ? '評価' : 'Rating'} ${stat.rating.toFixed(1)}`));
    const contribution = AM4Formation.contributions(player.id,currentDetail?.events || []);
    contribution.details.forEach(e => dialog.append(node('p','', `${e.minute || ''} ${e.assist?.id === player.id && ['goal','penalty'].includes(e.type) ? t('assist') : eventLabel(e)}${e.type === 'substitution' ? ` · OUT ${displayPlayerName(e.player)} → IN ${displayPlayerName(e.assist)}` : ''}`)));
    if (player.roleUncertain) dialog.append(node('p','',locale === 'ja' ? 'この選手の左右・中央の役割は推定です。' : 'This positional role is estimated.'));
    if (player.uncertain) dialog.append(node('p','',locale === 'ja' ? '出場可否は未確定です。' : 'Availability is uncertain.'));
    if (!contribution.details.length && !stat) dialog.append(node('p','',locale === 'ja' ? '追加の出場成績はありません。' : 'No additional appearance data.'));
    document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.addEventListener('click',event=>{if(event.target === dialog){ const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close(); }});
    dialog.showModal();
  }
  async function refreshInsights(force = false) {
    if (!currentDetail || insightState.state === 'loading' || (!force && Date.now()-insightFetchedAt < 60000)) return;
    insightState = {...insightState,state:'loading'};
    if (activePanel === 'lineups') replaceActivePanel();
    try {
      const data = await readLineupInsights(fixtureId, force);
      if (data.fixtureId !== currentDetail.fixture.id) throw new Error('Fixture mismatch');
      if (data.errors?.players && insightState.data?.players) data.players = insightState.data.players;
      insightState = {state:Object.values(data.errors || {}).some(Boolean) ? 'partial' : 'ready',data}; insightFetchedAt = Date.now();
      const official = (data.lineups || []).filter(l => !l.predicted);
      if (official.length) {
        const map = new Map((currentDetail.lineups || []).map(l => [l.team.id,l]));
        official.forEach(l => map.set(l.team.id,l));
        currentDetail.lineups = [...map.values()];
        currentDetail.availability.lineups = true;
      }
      updateNames(currentDetail);
    } catch { insightState = {...insightState,state:'error'}; }
    if (activePanel === 'lineups') replaceActivePanel();
  }
  function pitchPlayer(player, predicted) {
    const item = node('div','pitch-player');
    const button = node('button','pitch-player-button'); button.type='button';
    const formationName=nameRegistry.jersey(player);
    button.setAttribute('aria-label',`${formationName} · ${locale === 'ja' ? '選手詳細' : 'Player details'}`);
    const portrait = node('span','pitch-portrait',String(player.number ?? '–'));
    const stat = !predicted && insightState.data?.players?.find(p=>p.id===player.id);
    const photo = player.photo || stat?.photo || (player.id ? `https://media.api-sports.io/football/players/${player.id}.png` : null);
    if (photo) { const img = node('img',''); img.src=photo; img.alt=''; img.loading='lazy'; img.width=44; img.height=44; img.addEventListener('error',()=>img.remove(),{once:true}); portrait.append(img); }
    button.append(portrait,node('span','pitch-number',String(player.number ?? '–')),node('span','pitch-name',formationName));
    if (stat && stat.rating != null) button.append(node('span','pitch-rating',Number(stat.rating).toFixed(1)));
    if (player.uncertain) button.append(node('span','pitch-uncertain','?'));
    if (!predicted) {
      const c=AM4Formation.contributions(player.id,currentDetail.events || []), icons=node('span','pitch-icons');
      [[c.goals,'⚽'],[c.assists,'A'],[c.yellow,'▨'],[c.red,'▨']].forEach(([count,label],i)=>{if(count){const mark=node('span',`pitch-icon pitch-icon--${i}`,`${label}${count>1 ? count : ''}`);mark.setAttribute('aria-label',`${[t('goal'),t('assist'),t('yellow_card'),t('red_card')][i]} ${count}`);icons.append(mark);}});
      c.changes.forEach(change=>{const mark=node('span','pitch-change',change.direction==='IN'?'↑':'↓');mark.setAttribute('aria-label',`${change.direction} ${change.minute || ''}`);icons.append(mark);});
      if(icons.childElementCount) button.append(icons);
    }
    button.addEventListener('click',()=>showPlayer(player)); item.append(button); return item;
  }
  function predictionEvidence(lineup) {
    const box=node('details','lineup-evidence');
    box.append(node('summary','',locale==='ja'?'予想の根拠・欠場情報':'Reasoning and availability'));
    const e=lineup.evidence || {};
    box.append(node('p','',locale==='ja'?`直近${e.fixtures?.length || 0}試合の先発・配置を基にした未確定の予想。${e.minutes?'直近試合の出場時間を反映。':'出場時間は未取得。'}${e.restDays != null ? `前の試合から約${e.restDays}日。短い間隔では負荷を加味しています。` : ''}`:`Unconfirmed prediction based on ${e.fixtures?.length || 0} recent line-ups. Minutes ${e.minutes?'available':'unavailable'}. Rest: ${e.restDays ?? '—'} days.`));
    box.append(node('p','',locale==='ja'?`所属情報：${e.roster==='available'?'現行登録リストと照合':'直近の出場記録のみ。最新の所属は未確認'}。欠場情報：${e.injuries==='available'?'この試合のAPI情報を参照':'未取得'}。累積警告による停止・復帰・公式会見の独立確認は未実施。カード枚数から出場停止を推定していません。`:`Squad: ${e.roster}. Availability feed: ${e.injuries}. Suspensions, returns and press conferences are not independently verified; card totals are not used to infer suspensions.`));
    (lineup.absences || []).forEach(p=>box.append(node('p','',`${displayPlayerName(p)} · ${p.status==='out'?(locale==='ja'?'欠場（API報告）':'Out (provider)'):(locale==='ja'?'出場不透明':'Doubtful')} · ${p.reason || '—'}`)));
    (e.fixtures || []).forEach(f=>{const link=node('a','',`${locale==='ja'?'参照試合':'Source match'} · ${new Date(f.date).toLocaleDateString(locale==='ja'?'ja-JP':'en-GB')}`);link.href=`/match.html?id=${f.id}#lineups`;box.append(link);});
    return box;
  }

  function eventParticipant(participant) {
    const value = participant || {};
    return { ...value, fullName: nameRegistry.full(value), name: displayPlayerName(value) };
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
    target.append(image);
  }

  function eventPersonLine(player, className = "match-event-person") {
    if (!player.name) return null;
    const line = node("div", className);
    appendEventPhoto(line, player);
    line.append(playerButton(player, "match-event-player-name"));
    return line;
  }

  function eventTeam(detail, event, side) {
    const fixtureTeam = side === "home" ? detail.fixture?.home : side === "away" ? detail.fixture?.away : null;
    return {
      name: event.team?.name || fixtureTeam?.name || "",
      logo: event.team?.logo || fixtureTeam?.logo || "",
    };
  }

  function eventTeamMark(team) {
    if (!team.name && !team.logo) return null;
    const mark = node("span", "match-event-team");
    if (team.logo) {
      const image = document.createElement("img");
      image.className = "match-event-team-crest";
      image.src = team.logo;
      image.alt = "";
      image.width = 18;
      image.height = 18;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      mark.append(image);
    }
    if (team.name) mark.append(node("span", "", team.name));
    return mark;
  }

  function appendSubstitutionRow(card, direction, player) {
    if (!player.name) return;
    const incoming = direction === "in";
    const row = node("div", `match-event-sub-row match-event-sub-row--${direction}`);
    row.append(
      node("span", "match-event-sub-arrow", incoming ? "↑" : "↓"),
      node("span", "match-event-sub-label", incoming ? "IN" : "OUT"),
      eventPersonLine(player, "match-event-sub-person"),
    );
    card.append(row);
  }

  function timelineMarker(label) {
    const marker = node("li", "match-timeline-marker");
    marker.append(node("span", "", label));
    return marker;
  }

  function timelineFlow(label, copy) {
    if (!copy) return null;
    const item = node("li", "match-timeline-flow");
    const card = node("article", "match-timeline-flow-card");
    card.append(node("h3", "", label), node("p", "", copy));
    item.append(card);
    return item;
  }

  function eventSide(detail, event) {
    if (event.team?.id === detail.fixture?.home?.id) return "home";
    if (event.team?.id === detail.fixture?.away?.id) return "away";
    return "neutral";
  }

  function eventCard(detail, event, side) {
    const kind = eventKind(event);
    const card = node("article", "match-event-card");
    const team = eventTeam(detail, event, side);
    const cardHead = node("div", "match-event-card-head");
    const teamMark = eventTeamMark(team);
    if (teamMark) cardHead.append(teamMark);
    const type = node("span", "match-event-type", ["yellow_card", "red_card"].includes(kind) ? "" : eventLabel(event));
    type.setAttribute("aria-label", eventLabel(event));
    if (["yellow_card", "red_card"].includes(kind)) type.classList.add("match-event-type--icon-only");
    cardHead.append(type);
    card.append(cardHead);
    const player = eventParticipant(event.player);
    const assist = eventParticipant(event.assist);
    if (kind === "substitution") {
      // API-Football convention: player is OUT, assist is IN.
      appendSubstitutionRow(card, "in", assist);
      appendSubstitutionRow(card, "out", player);
    } else {
      const primary = eventPersonLine(player, "match-event-primary");
      if (primary) card.append(primary);
      if (["goal", "penalty", "own_goal"].includes(kind) && assist.name) {
        const assistLine = node("div", "match-event-assist");
        assistLine.append(node("span", "", t("assist")), eventPersonLine(assist, "match-event-assist-person"));
        card.append(assistLine);
      }
    }
    const note = eventNote(event);
    if (note) card.append(node("p", "match-event-note", note));
    return { card, team, player, assist, note, kind };
  }

  function reverseEvents(events) {
    return [...events].map((event, index) => ({ event, index })).sort((left, right) => {
      const elapsed = (right.event.elapsed ?? -1) - (left.event.elapsed ?? -1);
      if (elapsed) return elapsed;
      const extra = (right.event.extra ?? 0) - (left.event.extra ?? 0);
      return extra || right.index - left.index;
    }).map(({ event }) => event);
  }

  function eventFlow(report, half) {
    if (half === "second") return editorialValue(report, "report", "secondHalf", ["後半の流れ", "後半レビュー", "second half"]);
    return editorialValue(report, "report", "firstHalf", ["前半の流れ", "前半レビュー", "first half"]);
  }

  function renderTimelineEvent(detail, event) {
    const kind = eventKind(event);
    const cssKind = kind.replace(/_/g, "-");
    const side = eventSide(detail, event);
    const item = node("li", `match-event match-event--${cssKind} match-event--${side}`);
    const minute = node("time", "match-event-minute", text(event.minute, "—"));
    if (event.elapsed != null) {
      minute.setAttribute("aria-label", locale === "ja"
        ? `${event.elapsed}分${event.extra ? `${event.extra}分追加` : ""}`
        : `${event.elapsed}${event.extra ? ` plus ${event.extra}` : ""} minutes`);
    }
    const eventData = eventCard(detail, event, side);
    eventData.card.classList.add(`match-event-card--${side}`);
    const cardHead = eventData.card.querySelector(".match-event-card-head");
    if (side === "away") cardHead?.prepend(minute);
    else cardHead?.append(minute);
    const sideLabel = side === "home" ? t("home") : side === "away" ? t("away") : "";
    const people = kind === "substitution"
      ? [eventData.assist.name ? `IN ${eventData.assist.name}` : "", eventData.player.name ? `OUT ${eventData.player.name}` : ""].filter(Boolean)
      : [eventData.player.name, ["goal", "penalty", "own_goal"].includes(kind) ? eventData.assist.name && `${t("assist")} ${eventData.assist.name}` : ""].filter(Boolean);
    item.setAttribute("aria-label", [eventData.team.name, sideLabel, minute.textContent, eventLabel(event), ...people, eventData.note].filter(Boolean).join(locale === "ja" ? "、" : ", "));
    item.append(eventData.card);
    return item;
  }

  function renderEvents(detail, report = currentEditorial.report) {
    const el = section("events", t("events"), t("eventDescription"));
    if (!detail.availability?.events || detail.events == null) { el.append(unavailable("イベントデータ")); return el; }
    if (!detail.events.length) { el.append(node("p", "match-empty", t("noEvents"))); return el; }

    const timeline = node("ol", "match-timeline");
    const events = reverseEvents(detail.events);
    const secondHalfEvents = events.filter((event) => event.elapsed == null || event.elapsed > 45);
    const firstHalfEvents = events.filter((event) => event.elapsed != null && event.elapsed <= 45);
    const finished = matchGroup(detail.fixture) === "finished";
    const reachedHalfTime = finished || ["HT", "2H", "ET", "BT", "P"].includes(detail.fixture?.status) || events.some((event) => event.elapsed > 45);
    if (finished) timeline.append(timelineMarker(t("fullTime")));
    secondHalfEvents.forEach((event) => timeline.append(renderTimelineEvent(detail, event)));
    const secondHalfFlow = timelineFlow(t("secondHalfFlow"), eventFlow(report, "second"));
    if (secondHalfFlow) timeline.append(secondHalfFlow);
    if (reachedHalfTime) timeline.append(timelineMarker(t("halfTime")));
    firstHalfEvents.forEach((event) => timeline.append(renderTimelineEvent(detail, event)));
    const firstHalfFlow = timelineFlow(t("firstHalfFlow"), eventFlow(report, "first"));
    if (firstHalfFlow) timeline.append(firstHalfFlow);
    timeline.append(timelineMarker(t("kickoff")));
    el.append(timeline);
    return el;
  }

  function memberPhoto(person, kind = "players") {
    const photo = node("span", "lineup-member-photo", text(person?.name, "?").slice(0, 1));
    const source = person?.photo || (person?.id ? `https://media.api-sports.io/football/${kind}/${person.id}.png` : null);
    if (!source) return photo;
    const image = document.createElement("img");
    image.src = source;
    image.alt = "";
    image.loading = "lazy";
    image.width = 42;
    image.height = 42;
    image.addEventListener("error", () => image.remove(), { once: true });
    photo.append(image);
    return photo;
  }
  function playerRow(player) {
    const item = node("li", "lineup-player");
    const number = node("span", "lineup-number", player.number == null ? "—" : String(player.number));
    const name = playerButton(player, "lineup-name");
    const position = node("small", "", text(player.position, "—"));
    item.append(memberPhoto(player), number, name, position);
    AM4Formation.contributions(player.id,currentDetail?.events || []).changes.forEach(c => item.append(node('span','lineup-change',`${c.direction} ${c.minute || ''} · ${displayPlayerName(c.other)}`)));
    return item;
  }
  function lineupCard(lineup) {
    const card = node("article", "lineup-card");
    const subTitle = node("h4", "", locale === "ja" ? "控え選手" : "Substitutes");
    card.append(subTitle);
    if (lineup.substitutes?.length) { const list = node("ol", "lineup-list lineup-list--subs"); lineup.substitutes.forEach((player) => list.append(playerRow(player))); card.append(list); }
    else card.append(node("p", "match-empty", "控え選手の情報はありません。"));
    const coachTitle = node("h4", "", locale === "ja" ? "監督" : "Coach");
    const coach = node("div", "lineup-coach");
    coach.append(memberPhoto(lineup.coach, "coachs"), node("strong", "", text(lineup.coach?.name, "—")));
    card.append(coachTitle, coach);
    return card;
  }
  function lineupMemberDetails(lineups) {
    const details=node('section','lineup-details');
    details.append(node('h3','lineup-details-title',locale==='ja'?'控え選手と監督':'Substitutes and coach'));
    const switcher=node('div','lineup-team-switch');switcher.setAttribute('role','tablist');
    const panel=node('div','lineup-member-panel');panel.setAttribute('role','tabpanel');panel.id=`lineup-member-panel-${fixtureId}`;
    if (!lineups.some(lineup => String(lineup.team?.id) === String(lineupMemberTeamId))) lineupMemberTeamId=lineups[0]?.team?.id ?? null;
    const buttons=lineups.map((lineup,index)=>{
      const button=node('button','lineup-team-tab');button.type='button';button.setAttribute('role','tab');
      button.id=`lineup-member-tab-${fixtureId}-${index}`;button.setAttribute('aria-controls',panel.id);
      button.setAttribute('aria-label',`${index ? t('away') : t('home')} · ${text(lineup.team?.name)}`);
      button.append(crest(lineup.team));
      button.addEventListener('click',()=>{lineupMemberTeamId=lineup.team?.id;renderMembers();});
      button.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
        lineupMemberTeamId=lineups[next].team?.id;renderMembers();buttons[next].focus();
      });
      switcher.append(button);return button;
    });
    function renderMembers(){
      const selectedIndex=Math.max(0,lineups.findIndex(lineup=>String(lineup.team?.id)===String(lineupMemberTeamId)));
      buttons.forEach((button,index)=>{const selected=index===selectedIndex;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
      panel.setAttribute('aria-labelledby',buttons[selectedIndex].id);
      panel.replaceChildren(lineupCard(lineups[selectedIndex]));
    }
    details.append(switcher,panel);renderMembers();return details;
  }
  function renderLineups(detail) {
    const el = section('lineups',t('lineups'),locale==='ja'?'配置から試合を読む。選手をタップして詳細へ。':'Read the shape. Tap a player for details.');
    if (insightState.state === 'loading') el.append(node('p','match-empty',locale==='ja'?'選手成績・スタメン情報を更新中…':'Updating line-ups and player stats…'));
    if (['error','partial'].includes(insightState.state)) {
      el.append(node('p','match-unavailable',locale==='ja'?'追加情報を取得できませんでした。取得済みの情報を表示しています。':'Additional data could not be loaded. Showing available information.'));
      const retry=node('button','lineup-retry',t('retry'));retry.type='button';retry.addEventListener('click',()=>refreshInsights(true));el.append(retry);
    }
    const official = new Map((detail.lineups || []).map(l=>[l.team.id,l]));
    const additional = new Map((insightState.data?.lineups || []).map(l=>[l.team.id,l]));
    const lineups = [detail.fixture.home,detail.fixture.away].map(team=> {
      const actual=official.get(team.id), extra=additional.get(team.id);
      return actual?.startXI?.length===11 ? actual : extra && (!extra.predicted || matchGroup(detail.fixture)==='upcoming') ? extra : actual || {team,startXI:[],substitutes:[]};
    });
    const pitch=node('div','formation-pitch');
    lineups.forEach((lineup,index)=> {
      const half=node('section',`pitch-half pitch-half--${index ? 'away':'home'}`);
      const heading=node('header','pitch-team');
      heading.append(crest(lineup.team),node('h3','',lineup.team.name),node('strong','',lineup.formation || '—'));
      const label=lineup.predicted ? (locale==='ja'?'予想スタメン · 未確定':'Predicted · Unconfirmed') : lineup.startXI?.length===11 ? (locale==='ja'?'確定スタメン':'Confirmed XI') : (locale==='ja'?'スタメン情報未取得':'Line-up unavailable');
      heading.append(node('span','pitch-status',label));half.append(heading);
      const layout=AM4Formation.rows(lineup,Boolean(index));
      const field=node('div','pitch-field');
      field.dataset.outfieldLines=String(Math.max(0,layout.rows.length-1));
      const markings=node('span','pitch-markings');markings.setAttribute('aria-hidden','true');field.append(markings);
      layout.rows.forEach(row=>{const line=node('div','pitch-row');line.style.setProperty('--players',row.players.length);line.dataset.count=row.players.length;row.players.forEach(p=>line.append(pitchPlayer(p,Boolean(lineup.predicted))));field.append(line);});
      if (!layout.rows.length) field.append(node('p','match-empty',locale==='ja'?'配置情報はまだありません。':'Positions are not available yet.'));
      half.append(field);
      if (layout.unplaced.length) {
        const missing=node('div','lineup-unplaced');
        missing.append(node('p','match-empty',locale==='ja'?'配置情報がない先発選手':'Starting players without position data'));
        const list=node('ol','lineup-list');layout.unplaced.forEach(player=>list.append(playerRow(player)));missing.append(list);half.append(missing);
      }
      if (lineup.predicted) {half.append(node('p','pitch-disclaimer',locale==='ja'?'配置も直近の布陣を基にした推定です。':'Positions are estimated from recent formations.')); half.append(predictionEvidence(lineup));}
      pitch.append(half);
    });
    el.append(pitch);
    if(insightState.data?.updatedAt) el.append(node('p','lineup-updated',`${locale==='ja'?'最終更新':'Updated'} ${new Date(insightState.data.updatedAt).toLocaleString(locale==='ja'?'ja-JP':'en-GB')}`));
    el.append(lineupMemberDetails(lineups));
    return el;
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

  function fixtureSeason(fixture) {
    const kickoff = Date.parse(fixture?.kickoff || fixture?.date || "");
    const reference = Number.isFinite(kickoff) ? new Date(kickoff) : new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" })
      .formatToParts(reference).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
    return Number(parts.month) >= 7 ? Number(parts.year) : Number(parts.year) - 1;
  }

  function sameStandingTeam(row, fixture) {
    const ids = [fixture?.home?.id, fixture?.away?.id].filter((id) => Number.isInteger(Number(id))).map(Number);
    if (Number.isInteger(Number(row?.teamId)) && ids.includes(Number(row.teamId))) return true;
    const name = normalizedIdentityPart(row?.club);
    return Boolean(name && [fixture?.home?.name, fixture?.away?.name].some((team) => normalizedIdentityPart(team) === name));
  }

  function standingLogo(row) {
    if (!row?.logo) return null;
    const image = document.createElement("img");
    image.className = "match-standing-logo";
    image.src = row.logo;
    image.alt = "";
    image.width = 22;
    image.height = 22;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove(), { once: true });
    return image;
  }

  function renderStandings(detail, state = currentStandings) {
    const el = section("standings", t("standings"), t("standingsDescription"));
    if (state.state === "idle" || state.state === "loading") {
      el.append(node("p", "match-empty", t("standingsLoading")));
      return el;
    }
    if (state.state === "unavailable" || state.data?.errors) {
      el.append(node("p", "match-unavailable", t("standingsUnavailable")));
      return el;
    }
    const data = state.data;
    const rows = Array.isArray(data?.standings) ? data.standings : [];
    if (!data?.standingsAvailable || !rows.length) {
      el.append(node("p", "match-empty", t("noStandings")));
      return el;
    }

    const table = node("div", "match-standings-table");
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", `${text(data.competition, t("standings"))} ${t("standings")}`);
    const head = node("div", "match-standing-row match-standing-row--head");
    head.setAttribute("role", "row");
    [["#", "順位"], ["", ""], ["CLUB", "クラブ"], ["P", "Played"], ["W", "Won"], ["D", "Drawn"], ["L", "Lost"], ["+/-", "Goal difference"], ["PTS", "Points"]].forEach(([label, description]) => {
      const cell = node("span", "", label);
      if (description) cell.title = locale === "ja" ? description : label;
      cell.setAttribute("role", "columnheader");
      head.append(cell);
    });
    table.append(head);
    rows.forEach((row) => {
      const classes = ["match-standing-row"];
      if (row.zone) classes.push(`match-standing-row--zone-${row.zone}`);
      if (sameStandingTeam(row, detail.fixture)) classes.push("match-standing-row--fixture-team");
      const item = node("div", classes.join(" "));
      item.setAttribute("role", "row");
      item.setAttribute("aria-label", `${row.rank || "—"}. ${text(row.club)}, ${row.played} P, ${row.win} W, ${row.draw} D, ${row.lose} L, ${row.goalsDiff >= 0 ? "+" : ""}${row.goalsDiff}, ${row.points} PTS`);
      const rank = node("span", "match-standing-rank", text(row.rank));
      rank.setAttribute("role", "cell");
      const logo = node("span", "match-standing-crest");
      logo.setAttribute("role", "cell");
      const image = standingLogo(row);
      if (image) logo.append(image);
      const club = node("span", "match-standing-club", text(row.club));
      club.setAttribute("role", "cell");
      const values = [row.played, row.win, row.draw, row.lose, `${row.goalsDiff >= 0 ? "+" : ""}${row.goalsDiff}`, row.points];
      item.append(rank, logo, club, ...values.map((value, index) => {
        const cell = node("span", index === values.length - 1 ? "match-standing-points" : "", String(value));
        cell.setAttribute("role", "cell");
        return cell;
      }));
      table.append(item);
    });
    el.append(table);
    const legend = Array.isArray(data.qualificationLegend) ? data.qualificationLegend : [];
    if (legend.length) {
      const legendNode = node("ul", "match-standing-legend");
      legend.forEach((zone) => {
        const item = node("li", `match-standing-legend-item match-standing-legend-item--${zone}`, t(zone));
        legendNode.append(item);
      });
      el.append(legendNode);
    }
    return el;
  }

  function kickoffLabel(fixture) {
    if (fixture.kickoff) {
      return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(fixture?.date || ""))) {
      return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${fixture.date}T12:00:00Z`));
    }
    return "—";
  }

  function isLiveFixture(fixture) {
    return AM4FootballData.classifyFixtureStatus(fixture?.status) === "live";
  }

  // The detail URL never changes. Its overview grows from a preview into a
  // live view and finally a completed-match summary as the provider status
  // changes, while all factual tabs keep their own API-backed payloads.
  function matchGroup(fixture) {
    return AM4FootballData.classifyFixtureStatus(fixture?.status);
  }

  function renderBoard(fixture) {
    const kickoff = kickoffLabel(fixture);
    const board = node("article", "match-board");
    const competition = node("div", "match-competition");
    if (fixture.competitionLogo) { const logo = document.createElement("img"); logo.src = fixture.competitionLogo; logo.alt = ""; logo.width = 32; logo.height = 32; logo.decoding = "async"; logo.addEventListener("error", () => logo.remove(), { once: true }); competition.append(logo); }
    competition.append(node("span", "", text(fixture.competition, "大会情報なし")), node("small", "", text(fixture.competitionCountry, "国・地域情報なし")));
    const status = statusLabels[fixture.status]?.[locale === "ja" ? 0 : 1] || text(fixture.statusLong, "");
    const meta = node("p", "match-meta", [kickoff, fixture.roundLabel || fixture.round, status].filter(Boolean).join(" · "));
    const liveRefresh = isLiveFixture(fixture)
      ? node("p", "match-live-refresh", `${fixture.elapsed ? `${fixture.elapsed}' · ` : ""}${t("live")} · ${t("liveUpdate")}`)
      : null;
    if (liveRefresh) liveRefresh.setAttribute("aria-live", "polite");
    const score = node("div", "match-score-grid");
    const home = node("div", "match-team match-team--home");
    home.append(crest(fixture.home), node("h1", "", text(fixture.home?.name)));
    const homeFavorite = favorite(fixture.home);
    if (homeFavorite) home.append(homeFavorite);
    const middle = node("div", "match-score");
    const hasScore = fixture.goals?.home != null && fixture.goals?.away != null;
    middle.append(node("strong", "", hasScore ? `${fixture.goals.home} – ${fixture.goals.away}` : "VS"), node("span", "", hasScore ? t("score") : t("kickoff")));
    const away = node("div", "match-team match-team--away");
    away.append(crest(fixture.away), node("h1", "", text(fixture.away?.name)));
    const awayFavorite = favorite(fixture.away);
    if (awayFavorite) away.append(awayFavorite);
    score.append(home, middle, away);
    const facts = node("dl", "match-facts");
    [[t("venue"), [fixture.venue?.name, fixture.venue?.city].filter(Boolean).join(" · ")], [t("referee"), fixture.referee], [t("halftime"), fixture.score?.halftime?.home != null && fixture.score?.halftime?.away != null ? `${fixture.score.halftime.home} – ${fixture.score.halftime.away}` : null]].filter(([, value]) => Boolean(value)).forEach(([label, value]) => {
      const fact = node("div", "match-fact");
      fact.append(node("dt", "", label), node("dd", "", value));
      facts.append(fact);
    });
    board.append(competition, meta);
    if (liveRefresh) board.append(liveRefresh);
    board.append(score);
    if (facts.childElementCount) board.append(facts);
    return board;
  }

  function renderNavigation() {
    const nav = node("nav", "match-anchor-nav");
    nav.setAttribute("aria-label", locale === "ja" ? "試合詳細のセクション" : "Match detail sections");
    const panels = currentDetail?.archive
      ? [["overview", t("overview")]]
      : [["overview", t("overview")], ["events", t("events")], ["lineups", t("lineups")], ["statistics", t("statistics")], ["standings", t("standings")]];
    panels.forEach(([id, label]) => {
      const button = node("button", "", label);
      button.type = "button";
      button.dataset.matchPanel = id;
      if (id === activePanel) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => selectPanel(id));
      nav.append(button);
    });
    return nav;
  }

  function renderActivePanel(detail) {
    if (detail.archive) return renderArchiveOverview(detail, currentEditorial);
    if (activePanel === "overview") return renderOverview(detail, currentEditorial);
    if (activePanel === "lineups") return renderLineups(detail);
    if (activePanel === "statistics") return renderStatistics(detail);
    if (activePanel === "standings") return renderStandings(detail, currentStandings);
    return renderEvents(detail, currentEditorial.report);
  }

  function selectPanel(id, { updateHash = true } = {}) {
    if (!PANEL_IDS.has(id)) return;
    activePanel = id;
    // A hash can change while the fixture request is still in flight. Preserve
    // that requested panel so the first completed render respects the URL.
    if (!currentDetail) return;
    if (updateHash && window.location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
    const previous = page.querySelector(".match-section[data-match-panel]");
    const next = renderActivePanel(currentDetail);
    next.dataset.matchPanel = id;
    if (previous) previous.replaceWith(next);
    else page.append(next);
    const nav = page.querySelector('.match-anchor-nav');
    if (updateHash && nav && nav.getBoundingClientRect().top < 100) nav.scrollIntoView({block:'start',behavior:'instant'});
    if (id === 'lineups') void refreshInsights();
    page.querySelectorAll(".match-anchor-nav [data-match-panel]").forEach((button) => {
      if (button.dataset.matchPanel === id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }

  function normalizedIdentityPart(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").replace(/[^a-z0-9ぁ-んァ-ヶー一-龯]/gi, "").toLowerCase();
  }

  function isNotionEditorial(article, type) {
    return article?.contentKind === `notion_${type}` && Boolean(article?.notion?.pageId);
  }

  const ARCHIVE_FIXTURE_STORAGE_PREFIX = "am4:fixture-identity:";
  const ARCHIVE_FIXTURE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

  function validFixtureId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function archiveCanonicalKey(value) {
    return window.AM4MatchArchive?.canonicalMatchKey(value) || null;
  }

  function parsedArchiveArticleId() {
    const id = String(archiveArticleQueryId || "").trim();
    return /^[a-z0-9][a-z0-9._-]{0,180}$/i.test(id) ? id : null;
  }

  function rememberFixtureIdentity(fixture) {
    const id = validFixtureId(fixture?.id);
    const canonicalKey = archiveCanonicalKey(fixture);
    if (!id || !canonicalKey) return;
    try {
      localStorage.setItem(`${ARCHIVE_FIXTURE_STORAGE_PREFIX}${id}`, JSON.stringify({
        fixtureId: id,
        canonicalKey,
        savedAt: Date.now(),
      }));
    } catch (_error) {
      // Archive recovery is an enhancement. A storage restriction must never
      // affect the normal provider-backed detail page.
    }
  }

  function savedFixtureCanonicalKey(id) {
    const fixtureId = validFixtureId(id);
    if (!fixtureId) return null;
    try {
      const value = JSON.parse(localStorage.getItem(`${ARCHIVE_FIXTURE_STORAGE_PREFIX}${fixtureId}`) || "null");
      if (value?.fixtureId !== fixtureId || !Number.isFinite(value?.savedAt) || Date.now() - value.savedAt > ARCHIVE_FIXTURE_MAX_AGE_MS) return null;
      return archiveCanonicalKey(value.canonicalKey);
    } catch (_error) {
      return null;
    }
  }

  async function publicArchiveItems(criteria) {
    const fixture = validFixtureId(criteria?.fixtureId);
    const canonicalKey = archiveCanonicalKey(criteria?.canonicalKey || criteria?.matchKey);
    if (!fixture && !canonicalKey) return [];
    const types = ["match_prediction", "match_report"];
    const results = await Promise.allSettled(types.map((type) => client.articles({
      type,
      ...(fixture ? { fixtureId: fixture } : { matchKey: canonicalKey }),
      pageSize: 100,
    })));
    const archive = window.AM4MatchArchive.archiveArticlesFromSettled(results, types);
    if (archive.unavailable) throw new Error("Published AM4 match archive unavailable");
    return archive;
  }

  function hasArchiveEditorial(editorials) {
    return Boolean(editorials?.prediction || editorials?.report);
  }

  async function archiveResolutionFor(criteria) {
    const requestedArticleId = criteria?.articleId || null;
    let anchor = null;
    if (requestedArticleId) {
      try {
        const response = await client.article(requestedArticleId);
        anchor = response?.article || null;
      } catch (error) {
        if (responseWasMissing(error)) return { state: "absent" };
        throw error;
      }
      if (!window.AM4MatchArchive.isPublishedMatchEditorial(anchor)) return { state: "absent" };
    }
    const anchorKey = anchor ? archiveCanonicalKey(anchor.match) : null;
    const canonicalKey = anchorKey || archiveCanonicalKey(criteria?.canonicalKey || criteria?.matchKey);
    if (anchor && criteria?.canonicalKey && canonicalKey !== archiveCanonicalKey(criteria.canonicalKey)) return { state: "absent" };
    const fixture = validFixtureId(criteria?.fixtureId);
    if (!anchor && !fixture && !canonicalKey) return { state: "absent" };

    let archiveItems = anchor ? [anchor] : [];
    let unavailableTypes = [];
    try {
      const archive = await publicArchiveItems(fixture && !canonicalKey ? { fixtureId: fixture } : { canonicalKey });
      archiveItems.push(...archive.items);
      unavailableTypes = archive.unavailableTypes || [];
    } catch (error) {
      unavailableTypes = ["match_prediction", "match_report"];
      if (!anchor) throw error;
    }
    const editorials = window.AM4MatchArchive.resolveArchiveEditorials(archiveItems, {
      ...(fixture && !canonicalKey ? { fixtureId: fixture } : { canonicalKey }),
      ...(anchor ? { articleId: anchor.id } : {}),
    });
    if (editorials.ambiguous || editorials.anchorMismatch) return { state: "unavailable" };
    const archiveErrors = Object.fromEntries(unavailableTypes
      .filter((type) => !(type === "match_prediction" ? editorials.prediction : editorials.report))
      .map((type) => [type, "unavailable"]));
    if (!hasArchiveEditorial(editorials)) return Object.keys(archiveErrors).length ? { state: "unavailable" } : { state: "absent" };
    return {
      state: "ready",
      editorials,
      errors: archiveErrors,
    };
  }

  async function archivedDetailFallback() {
    const attempts = [];
    const id = validFixtureId(fixtureId);
    // Preserve the provider-first path. These fallback locators are only used
    // after it cannot return a fixture, and all archive reads remain public.
    if (id) attempts.push({ fixtureId: id });
    const savedKey = savedFixtureCanonicalKey(id);
    if (savedKey) attempts.push({ canonicalKey: savedKey });
    const urlKey = archiveCanonicalKey(archiveMatchKey);
    if (urlKey && urlKey !== savedKey) attempts.push({ canonicalKey: urlKey });
    const articleId = parsedArchiveArticleId();
    if (articleId) attempts.push({ articleId, ...(urlKey ? { canonicalKey: urlKey } : {}) });

    let unavailable = false;
    for (const criteria of attempts) {
      try {
        const result = await archiveResolutionFor(criteria);
        if (result.state === "ready") return result;
        if (result.state === "unavailable") unavailable = true;
      } catch (_error) {
        unavailable = true;
      }
    }
    return { state: unavailable ? "unavailable" : "absent" };
  }

  async function fullEditorialArticle(type, fixture) {
    const archiveQueries = window.AM4MatchArchive?.publishedArchiveQueriesForFixture(fixture) || [];
    if (!archiveQueries.length) return null;
    const requests = archiveQueries.map((criteria) => client.articles({ type, ...criteria, pageSize: 100 }));
    const results = await Promise.allSettled(requests);
    const selected = window.AM4MatchEditorialFallback.selectPublishedArchiveEditorial(
      results,
      type,
      (article) => window.AM4MatchArchive.publishedFixtureEditorialMatch(article, fixture),
    );
    if (!selected?.id) return null;
    const response = await client.article(selected.id);
    return response?.article
      && isNotionEditorial(response.article, type)
      && window.AM4MatchArchive.matchesPublishedFixtureEditorial(response.article, fixture)
      ? response.article
      : null;
  }

  async function currentNotionEditorial(fixture) {
    const response = await client.matchContent({ fixtureId: fixture.id });
    if (response?.partial) console.warn("Some AM4 editorial content is temporarily unavailable.", response.errors);
    return {
      prediction: response?.prediction || null,
      report: response?.report || null,
      errors: response?.errors || {},
    };
  }

  async function refreshEditorialForFixture(fixture) {
    if (!client || !fixture?.id) return;
    const request = ++editorialRequest;
    let editorial = null;
    try {
      // This is the primary path: it reads the two Notion sources server-side
      // for this exact fixture, so new AM4 analysis does not wait for the
      // archive's scheduled mirror sync.
      editorial = await currentNotionEditorial(fixture);
      // A legacy Notion page can be marked as generated provenance even though
      // its already-published Blob mirror is safe to show. A successful empty
      // live lookup is therefore not enough to conclude that no public
      // editorial exists; restore only missing types from the public archive.
      editorial = await window.AM4MatchEditorialFallback.withPublishedFallback(
        editorial,
        (type) => fullEditorialArticle(type, fixture),
      );
    } catch (error) {
      // Keep the previously published Blob mirror as a resilience fallback.
      // It is never presented as newly fetched Notion content, and an absence
      // still renders the normal understated empty state.
      console.warn("Live AM4 editorial content unavailable; using archive fallback.", error);
      const results = await Promise.allSettled([
        fullEditorialArticle("match_prediction", fixture),
        fullEditorialArticle("match_report", fixture),
      ]);
      editorial = {
        prediction: results[0].status === "fulfilled" ? results[0].value : null,
        report: results[1].status === "fulfilled" ? results[1].value : null,
        errors: { match_prediction: true, match_report: true },
      };
    }
    if (request !== editorialRequest || currentDetail?.fixture?.id !== fixture.id) return;
    currentEditorial = editorial;
    // Editorial content changes the active overview and can also add the
    // Notion-backed first-/second-half flow to the events panel.
    if (activePanel === "overview" || activePanel === "events") replaceActivePanel();
  }

  async function refreshStandingsForFixture(fixture) {
    if (!client || !fixture?.id) return;
    const request = ++standingsRequest;
    currentStandings = { state: "loading", data: null };
    if (activePanel === "standings") replaceActivePanel();
    try {
      const data = await client.standings({
        season: fixtureSeason(fixture),
        competition: fixture.competition,
        competitionId: fixture.competitionId,
      });
      if (request !== standingsRequest || currentDetail?.fixture?.id !== fixture.id) return;
      currentStandings = data?.errors
        ? { state: "unavailable", data }
        : { state: "ready", data };
    } catch (error) {
      if (request !== standingsRequest || currentDetail?.fixture?.id !== fixture.id) return;
      console.warn("Fixture standings unavailable.", error);
      currentStandings = { state: "unavailable", data: null };
    }
    if (activePanel === "standings") replaceActivePanel();
  }

  function cleanEditorialText(value) {
    const cleaned = String(value || "").replace(/\r\n?/g, "\n").replace(/^[-*+]\s+/gm, "").replace(/\*\*/g, "").trim();
    return window.AM4ArticlePresentation?.readerEditorialText?.(cleaned) ?? cleaned;
  }

  function markdownSections(markdown) {
    const sections = [];
    let current = null;
    String(markdown || "").replace(/\r\n?/g, "\n").split("\n").forEach((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        if (current?.body.trim()) sections.push({ ...current, body: cleanEditorialText(current.body) });
        current = { heading: heading[1], body: "" };
      } else if (current) {
        current.body += `${line}\n`;
      }
    });
    if (current?.body.trim()) sections.push({ ...current, body: cleanEditorialText(current.body) });
    return sections;
  }

  function editorialValue(article, kind, field, headingAliases = []) {
    const structured = article?.[kind]?.[field];
    if (structured) return cleanEditorialText(structured);
    const aliases = headingAliases.map(normalizedIdentityPart);
    const found = markdownSections(article?.body).find((entry) => aliases.some((alias) => normalizedIdentityPart(entry.heading).includes(alias)));
    if (found?.body) return found.body;
    if (field === "summary") return cleanEditorialText(article?.summary || article?.deck || "");
    return "";
  }

  function editorialBlock(label, value, field) {
    if (!value) return null;
    const block = node("article", "match-editorial-block");
    block.append(node("h3", "", label));
    const contentBlocks = field === "turningPoints"
      ? window.AM4EditorialList?.turningPointBlocks?.(value)
      : window.AM4EditorialList?.editorialBlocksWithLocalNumbering(value);
    if (contentBlocks) {
      contentBlocks.forEach((content) => {
        if (content.type === "ordered-list") {
          const list = node("ol", "match-editorial-list");
          content.items.forEach((item) => list.append(node("li", "", item)));
          block.append(list);
        } else {
          block.append(node("p", "", content.text));
        }
      });
    } else {
      block.append(node("p", "", value));
    }
    return block;
  }

  function highlightMotm(block, value, suppliedSelection) {
    const detail = currentDetail || {};
    const players = [
      ...(detail.events || []).flatMap(event => [event.player, event.assist]),
      ...(detail.lineups || []).flatMap(lineup => [...(lineup.startXI || []), ...(lineup.substitutes || [])]),
    ];
    const selection = suppliedSelection || window.AM4MatchReportPresentation?.selectedMotm(value, players);
    if (!selection) return;
    block.querySelector('.match-motm-header')?.remove();
    block.querySelector('.match-motm-reason')?.remove();
    const header = node("div", "match-motm-header");
    const portrait = node("span", "match-motm-portrait", selection.name.split(/\s+/).map(part => part[0]).slice(0, 2).join(""));
    portrait.setAttribute("aria-hidden", "true");
    const playerPhoto = selection.player?.photo || (selection.player?.id
      ? `https://media.api-sports.io/football/players/${selection.player.id}.png`
      : "");
    if (playerPhoto) {
      const image = node("img", "");
      image.src = playerPhoto;
      image.alt = "";
      image.width = 88;
      image.height = 88;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      portrait.append(image);
    }
    const copy = node("div", "match-motm-copy");
    copy.append(node("span", "match-motm-label", selection.authority === 'AM4' ? (locale === 'ja' ? 'AM4選出' : 'AM4 SELECTION') : "PLAYER OF THE MATCH"), node("h4", "match-motm-name", selection.name));
    header.append(portrait, copy);
    block.querySelector("h3").after(header);
    block.classList.add("match-editorial-block--motm");
    block.querySelector("h3").textContent = "MOTM";
    if (selection.reason) header.after(node('p','match-motm-reason',selection.reason));
  }

  function playerOfMatchEditorialValue(report) {
    const value = editorialValue(report, "report", "playerOfMatch", ["Player of the Match", "POTM", "MOTM", "MOM", "プレイヤー・オブ・ザ・マッチ", "マン・オブ・ザ・マッチ"]);
    if (!value) return "";
    const alreadyLabeled = window.AM4MatchReportPresentation?.hasAwardLabel?.(value)
      || /(?:Man of the Match|Player of the Match|MOTM|POTM|MOM|MVP|プレイヤー[・\s]?オブ[・\s]?ザ[・\s]?マッチ|マン[・\s]?オブ[・\s]?ザ[・\s]?マッチ)(?:\s*[（(][^）)\n]+[）)])?\s*(?:[：:]|は)/iu.test(value);
    return alreadyLabeled
      ? value
      : `Player of the Match: ${value}`;
  }

  async function completeReportMotm(content, report) {
    const helper = window.AM4MatchReportPresentation;
    const detail = currentDetail;
    if (!helper || !detail) return;
    const dedicated = playerOfMatchEditorialValue(report);
    const value = dedicated
      ? dedicated
      : editorialValue(report,'report','keyFigures',['試合主要人物','主要人物','MOTM','key figure']);
    const eventPlayers = (detail.events || []).flatMap(e=>[e.player,e.assist].filter(Boolean).map(player=>({...player,teamId:e.team?.id,appeared:true})));
    const lineupPlayers = (detail.lineups || []).flatMap(l=>[
      ...(l.startXI || []).map(player=>({...(player.player || player),teamId:l.team?.id,started:true,appeared:true})),
      ...(l.substitutes || []).map(player=>({...(player.player || player),teamId:l.team?.id})),
    ]);
    const participants = [...eventPlayers,...lineupPlayers];
    let selection = helper.selectedMotm(value,participants) || helper.editorialAm4Motm(report.id,value,participants)
      || helper.narrativeAm4Motm(detail.fixture,value,participants,{requireCue:true});
    const apply = choice => {
      if (!choice || currentDetail !== detail) return;
      let block = content.querySelector('[data-report-field="playerOfMatch"]') || content.querySelector('[data-report-field="keyFigures"]');
      if (!block) {
        block = node('article','match-editorial-block');
        block.dataset.reportField='playerOfMatch';
        block.append(node('h3','','MOTM'));
        content.querySelector('.match-editorial-grid').prepend(block);
      }
      highlightMotm(block,value,choice);
      if (choice.authority === 'AM4') {
        block.querySelectorAll('p').forEach(paragraph => {
          if (paragraph.classList.contains('match-motm-reason')) return;
          const text = helper.withoutMotmAbstention(paragraph.textContent);
          if (text) paragraph.textContent=text; else paragraph.remove();
        });
      }
    };
    const withPlayerPhoto = async choice => {
      if (!choice?.name || choice.player || !client?.playerPhoto || currentDetail !== detail) return choice;
      const nameParts = choice.name.trim().split(/\s+/);
      try {
        const photo = await client.playerPhoto({ search:nameParts.at(-1), fullName:choice.name });
        if (currentDetail !== detail || !photo?.photo) return choice;
        const enhanced = { ...choice, player:{ name:photo.name || choice.name, photo:photo.photo } };
        apply(enhanced);
        return enhanced;
      } catch (error) {
        console.warn('Optional MOTM portrait unavailable.',error);
        return choice;
      }
    };
    apply(selection);
    // Match-Key archives have no provider fixture ID, events or line-ups. The
    // explicit editorial winner can still receive a verified profile portrait.
    if (matchGroup(detail.fixture)!=='finished') selection = await withPlayerPhoto(selection);
    if (selection?.player || (!selection && helper.hasAwardStatement(value)) || matchGroup(detail.fixture)!=='finished') return;
    // Optional, coalesced data retrieval never gates the article or replaces its
    // content. Only this MOTM block is enhanced, preserving scroll and disclosures.
    const data = await readLineupInsights(String(detail.fixture.id));
    if (currentDetail !== detail || Number(data.fixtureId)!==Number(detail.fixture.id)) return;
    const insightLineupPlayers = (data.lineups || []).flatMap(l=>[
      ...(l.startXI || []).map(player=>({...(player.player || player),teamId:l.team?.id,started:true,appeared:true})),
      ...(l.substitutes || []).map(player=>({...(player.player || player),teamId:l.team?.id})),
    ]);
    const allPlayers = [...participants,...(data.players || []),...insightLineupPlayers];
    selection = helper.selectedMotm(value,allPlayers) || helper.editorialAm4Motm(report.id,value,allPlayers)
      || helper.narrativeAm4Motm(detail.fixture,value,allPlayers,{requireCue:true})
      || helper.dataAm4Motm(detail.fixture,[...(data.players || []),...insightLineupPlayers,...eventPlayers],value)
      || helper.narrativeAm4Motm(detail.fixture,value,allPlayers);
    apply(selection);
    await withPlayerPhoto(selection);
  }

  function predictionBlocks(prediction) {
    const fields = [
      [t("previousReview"), "previousReview", ["前節レビュー", "前節の振り返り", "previous match"]],
      [t("adjustments"), "adjustments", ["前節からの修正", "修正ポイント", "adjustment"]],
      [t("tacticalMatchup"), "tacticalMatchup", ["戦術的な噛み合わせ", "戦術分析", "tactical"]],
      [t("keyPlayers"), "keyPlayers", ["キープレイヤー", "注目選手", "key player"]],
      [t("absences"), "absences", ["欠場情報", "欠場者", "absence"]],
      [t("matchOutlook"), "matchOutlook", ["予想される試合展開", "試合展開", "match flow"]],
      [t("rationale"), "rationale", ["予想の根拠", "根拠", "reason"]],
    ];
    return fields.map(([label, field, aliases]) => editorialBlock(label, editorialValue(prediction, "prediction", field, aliases))).filter(Boolean);
  }

  function reportBlocks(report) {
    const dedicated = editorialValue(report, "report", "playerOfMatch", ["Player of the Match", "POTM", "MOTM", "MOM", "プレイヤー・オブ・ザ・マッチ", "マン・オブ・ザ・マッチ"]);
    const fields = [
      [locale === "ja" ? "POTM" : "Player of the Match", "playerOfMatch", ["Player of the Match", "POTM", "MOTM", "MOM", "プレイヤー・オブ・ザ・マッチ", "マン・オブ・ザ・マッチ"]],
      [locale === "ja" ? "試合主要人物" : "Key figures", "keyFigures", ["試合主要人物", "主要人物", "MOTM", "key figure"]],
      [t("turningPoints"), "turningPoints", ["試合を分けたポイント", "勝負を分けたポイント", "turning point"]],
      [t("firstHalf"), "firstHalf", ["前半レビュー", "first half"]],
      [t("secondHalf"), "secondHalf", ["後半レビュー", "second half"]],
      [t("tactics"), "tactics", ["戦術分析", "戦術解説", "戦術的なポイント", "tactical"]],
      [t("individualPerformance"), "individualPerformance", ["個人パフォーマンス", "個人評価", "individual"]],
      [locale === "ja" ? "主要スタッツ" : "Key stats", "mainStats", ["主要スタッツ", "主なスタッツ", "key stats"]],
      [t("resultMeaning"), "resultMeaning", ["結果の意味", "what the result"]],
      [t("nextMatchFocus"), "nextMatchFocus", ["次戦への課題", "next match"]],
    ];
    return fields.map(([label, field, aliases]) => {
      const value = field === "playerOfMatch" ? playerOfMatchEditorialValue(report) : editorialValue(report, "report", field, aliases);
      const block = editorialBlock(label, value, field);
      if (block) block.dataset.reportField = field;
      if (block && (field === "playerOfMatch" || (field === "keyFigures" && !dedicated))) {
        // A missing optional helper or portrait enhancement must not hide prose.
        try { highlightMotm(block, value); } catch (error) { console.warn("MOTM presentation unavailable.", error); }
      }
      return block;
    }).filter(Boolean);
  }

  function predictionPanel(prediction, { disclosure = false } = {}) {
    if (!prediction) return editorialEmpty('match_prediction');
    const wrap = node(disclosure ? "details" : "div", disclosure ? "match-editorial-disclosure" : "match-editorial-content");
    if (disclosure) wrap.append(node("summary", "", t("priorPrediction")));
    const content = node("div", "match-editorial-content");
    const hero = node("article", "match-editorial-hero match-editorial-hero--prediction");
    hero.append(editorialHeading(prediction, t('prediction')));
    const values = node("div", "match-prediction-values");
    if (prediction.prediction?.score) values.append(node("strong", "", prediction.prediction.score));
    if (prediction.prediction?.pick) {
      const pick = node("span", "match-prediction-pick");
      pick.append(node("small", "", t("pick")), node("b", "", prediction.prediction.pick));
      values.append(pick);
    }
    const confidenceValue = window.AM4ArticlePresentation?.normalizeConfidence(prediction.prediction?.confidence);
    if (confidenceValue !== null && confidenceValue !== undefined) {
      const confidence = node("span", "match-prediction-pick");
      confidence.append(node("small", "", t("confidence")), node("b", "", `${Math.round(confidenceValue)}%`));
      values.append(confidence);
    }
    if (values.childElementCount) hero.append(values);
    const summary = editorialValue(prediction, "prediction", "summary", ["3行要約", "予想要約", "summary"]);
    if (summary) appendEditorialSummary(hero, summary);
    content.append(hero);
    const blocks = predictionBlocks(prediction);
    if (blocks.length) {
      const grid = node("div", "match-editorial-grid");
      grid.append(...blocks);
      content.append(grid);
    }
    wrap.append(content);
    return wrap;
  }

  function scoringEvents(detail) {
    return (detail.events || []).filter((event) => ["goal", "penalty", "own_goal"].includes(eventKind(event)));
  }

  function cardEvents(detail) {
    return (detail.events || []).filter((event) => ["yellow_card", "red_card"].includes(eventKind(event)));
  }

  function substitutionEvents(detail) {
    return (detail.events || []).filter((event) => eventKind(event) === "substitution");
  }

  function summaryEventRow(detail, event) {
    const row = node("li", "match-summary-event");
    const kind = eventKind(event);
    const side = event.team?.id === detail.fixture?.home?.id ? "home" : "away";
    const team = eventTeam(detail, event, side);
    const player = eventParticipant(event.player);
    const assist = eventParticipant(event.assist);
    const copy = node("div", "match-summary-event-copy");
    const top = node("div", "match-summary-event-main");
    const primaryName = kind === "substitution"
      ? assist.name ? `IN ${assist.name}` : player.name ? `OUT ${player.name}` : eventLabel(event)
      : player.name || eventLabel(event);
    const primary = playerButton(kind === 'substitution' && assist.name ? assist : player);
    primary.textContent = primaryName;
    if (["goal", "penalty", "own_goal"].includes(kind)) {
      primary.textContent = "";
      appendEventPhoto(primary, player);
      primary.append(node("span", "", primaryName));
    }
    top.append(node("time", "", text(event.minute)), primary);
    if (["yellow_card", "red_card"].includes(kind)) {
      const kindMark = node("span", `match-summary-event-kind match-summary-event-kind--${kind}`);
      kindMark.setAttribute("aria-label", eventLabel(event));
      top.append(kindMark);
    }
    if (team.name) top.append(node("span", "match-summary-team-name", team.name));
    copy.append(top);
    if (["goal", "penalty", "own_goal"].includes(kind) && assist.name) { const by=playerButton(assist,'summary-assist'); by.textContent=`${t('assist')} ${displayPlayerName(assist)}`; copy.append(by); }
    if (kind === "substitution" && assist.name && player.name) { const out=playerButton(player,'summary-assist'); out.textContent=`OUT ${player.name}`; copy.append(out); };
    if (kind === "own_goal") copy.append(node("small", "", t("own_goal")));
    row.append(copy);
    return row;
  }

  function summaryBlock(detail, title, events) {
    if (!events.length) return null;
    const block = node("div", "match-summary-block match-summary-block--mirror");
    block.append(node("h3", "", title));
    const lanes = node("div", "match-summary-lanes");
    ["home", "away"].forEach((side) => {
      const laneEvents = events.filter((event) => eventSide(detail, event) === side);
      const lane = node("div", `match-summary-lane match-summary-lane--${side}`);
      lane.append(node("p", "match-summary-lane-label", text(detail.fixture?.[side]?.name, t(side))));
      if (laneEvents.length) {
        const list = node("ol", "match-summary-list");
        laneEvents.forEach((event) => list.append(summaryEventRow(detail, event)));
        lane.append(list);
      }
      lanes.append(lane);
    });
    block.append(lanes);
    return block;
  }

  function summaryScore(detail) {
    const fixture = detail.fixture;
    if (fixture.goals?.home == null || fixture.goals?.away == null) return null;
    const score = node("div", "match-summary-score");
    score.append(node("span", "", t("score")), node("strong", "", `${fixture.goals.home} – ${fixture.goals.away}`));
    return score;
  }

  function editorialEmpty(kind) {
    if (currentEditorial.loading) return node('p','match-editorial-pending',locale==='ja'?'AM4の記事を読み込んでいます。':'Loading AM4 editorial.');
    if (currentEditorial.errors?.[kind]) {
      const wrap=node('div','match-editorial-pending');
      wrap.append(node('p','',locale==='ja'?'記事の取得・照合が完了していません。未公開とは限りません。':'Editorial retrieval or matching is incomplete; publication status is unknown.'));
      const retry=node('button','lineup-retry',t('retry'));retry.type='button';retry.addEventListener('click',()=>refreshEditorialForFixture(currentDetail.fixture));wrap.append(retry);return wrap;
    }
    return node('p','match-editorial-pending',t(kind==='match_report'?'reportPending':'predictionPending'));
  }
  function editorialHeading(article, label) {
    const heading = node('div','match-editorial-heading');
    heading.append(node('span','match-editorial-kicker',label));
    if (!article?.id || !window.AM4Favorites) return heading;
    const save = node('button','favorite-btn read-later-button');
    save.type = 'button';
    save.innerHTML = '<svg class="bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z"></path></svg><span></span>';
    const status = node('span','match-save-status');
    status.setAttribute('role','status');
    const sync = () => {
      const selected = AM4Favorites.has(AM4Favorites.read(localStorage),'articles',article.id);
      save.setAttribute('aria-pressed',String(selected));
      save.setAttribute('aria-label',locale === 'ja' ? (selected ? 'あとで読むから解除' : 'あとで読むに追加') : (selected ? 'Remove from reading list' : 'Read later'));
      save.querySelector('span').textContent = locale === 'ja' ? (selected ? '追加済み' : 'あとで読む') : (selected ? 'Saved' : 'Read later');
    };
    save.addEventListener('click', () => {
      const result = AM4Favorites.toggleWithItem(localStorage,'articles',article.id, {
        label:article.title || document.title, detail:label,
        href:window.AM4ArticleLoadState?.articleHref(article,currentDetail?.fixture?.id) || `/article.html?id=${encodeURIComponent(article.id)}`,
      });
      if (!result) { status.textContent = locale === 'ja' ? 'この端末に保存できませんでした。' : 'Could not save on this device.'; return; }
      status.textContent = '';
      sync();
      document.dispatchEvent(new CustomEvent('am4:favorites-changed'));
    });
    sync();
    heading.append(save, status);
    return heading;
  }

  function reportPanel(report) {
    if (!report) return editorialEmpty('match_report');
    const content = node("div", "match-editorial-content match-editorial-content--report");
    content.append(editorialHeading(report, t('matchSummary')));
    const summary = editorialValue(report, "report", "summary", ["3行要約", "試合要約", "summary"]);
    if (summary) appendEditorialSummary(content, summary);
    const blocks = reportBlocks(report);
    const readingKey = `${currentDetail?.fixture?.id || 'archive'}:${report.id}`;
    const sections = node('div','match-report-sections');
    try {
      if (!window.AM4ArticleReading?.appendReportSections) throw new Error('Optional reading helper unavailable');
      window.AM4ArticleReading.appendReportSections(sections, blocks, {
        locale, open: reportReadingState.get(readingKey) === true,
        onToggle: open => reportReadingState.set(readingKey, open),
      });
    } catch (_error) {
      const grid = node("div", "match-editorial-grid");
      grid.append(...blocks);
      sections.replaceChildren(grid);
    }
    content.append(sections);
    void completeReportMotm(content, report).catch(error => console.warn('Optional MOTM selection unavailable.',error));
    return content;
  }

  function appendEditorialSummary(container, summary) {
    const parts = window.AM4ArticleReading?.splitSummary(summary) || {lead:summary, rest:""};
    container.append(node("p", "match-editorial-summary", parts.lead));
    if (!parts.rest) return;
    const details = node("details", "match-summary-more");
    const toggle = node("summary", "", locale === "ja" ? "要約の続きを読む" : "Read the rest of the summary");
    details.append(toggle, node("p", "match-editorial-summary", parts.rest));
    details.addEventListener("toggle", () => {
      toggle.textContent = details.open
        ? (locale === "ja" ? "続きを閉じる" : "Show less")
        : (locale === "ja" ? "要約の続きを読む" : "Read the rest of the summary");
    });
    container.append(details);
  }

  function renderArchiveOverview(detail, editorial = currentEditorial) {
    const overview = section("overview", t("archive"), t("archiveDescription"));
    if (editorial.prediction) overview.append(predictionPanel(editorial.prediction));
    if (editorial.report) overview.append(reportPanel(editorial.report));
    ["match_prediction", "match_report"].forEach((type) => {
      const property = type === "match_prediction" ? "prediction" : "report";
      if (!editorial[property] && editorial.errors?.[type]) {
        const pending = node("div", "match-editorial-pending");
        pending.append(node("p", "", locale === "ja"
          ? "公開済み記事の照合が一時的に完了していません。未公開とは限りません。"
          : "Published editorial matching is temporarily incomplete; this does not mean it is unpublished."));
        const retry = node("button", "lineup-retry", t("retry"));
        retry.type = "button";
        retry.addEventListener("click", () => { void load(); });
        pending.append(retry);
        overview.append(pending);
      }
    });
    if (!editorial.prediction && !editorial.report) {
      overview.append(node("p", "match-editorial-pending", locale === "ja" ? "公開済みのAM4記事は見つかりませんでした。" : "No published AM4 editorial was found."));
    }
    return overview;
  }

  function renderOverview(detail, editorial = currentEditorial) {
    const fixture = detail.fixture;
    const group = matchGroup(fixture);
    if (group === "upcoming") {
      const overview = section("overview", t("preview"), t("previewDescription"));
      overview.append(predictionPanel(editorial.prediction));
      return overview;
    }
    if (group === "live") {
      const overview = section("overview", t("live"), t("liveDescription"));
      if (editorial.prediction) overview.append(predictionPanel(editorial.prediction, { disclosure: true }));
      return overview;
    }
    if (group === "finished") {
      const overview = section("overview", t("summary"), t("summaryDescription"));
      const score = summaryScore(detail);
      if (score) overview.append(score);
      const goals = summaryBlock(detail, t("goals"), scoringEvents(detail));
      const cards = summaryBlock(detail, t("cards"), cardEvents(detail));
      if (goals) overview.append(goals);
      if (cards) overview.append(cards);
      overview.append(reportPanel(editorial.report));
      return overview;
    }
    const overview = section("overview", t("overview"), "");
    overview.append(node("p", "match-overview-copy", statusLabels[fixture.status]?.[locale === "ja" ? 0 : 1] || fixture.statusLong || "—"));
    return overview;
  }

  function replaceActivePanel() {
    const previous = page.querySelector(".match-section[data-match-panel]");
    if (!previous || !currentDetail) return;
    const next = renderActivePanel(currentDetail);
    next.dataset.matchPanel = activePanel;
    previous.replaceWith(next);
  }

  function render(detail) {
    updateNames(detail);
    const fixture = detail.fixture;
    document.title = `${text(fixture.home?.name)} vs ${text(fixture.away?.name)}｜AM4 Football`;
    const panel = renderActivePanel(detail);
    panel.dataset.matchPanel = activePanel;
    page.replaceChildren(backLink(), renderBoard(fixture), renderNavigation(), panel);
    // Only the compact live indicator announces a later refresh. Re-announcing
    // an entire event timeline every 15 seconds would be disruptive to readers.
    page.setAttribute("aria-live", "off");
  }

  function renderLiveUpdate(detail) {
    const fixture = detail.fixture;
    const previousScrollY = window.scrollY;
    const activeElement = document.activeElement;
    const focusedSummarySection = activeElement instanceof HTMLElement && activeElement.matches("summary")
      ? activeElement.closest(".match-section")?.id
      : null;
    document.title = `${text(fixture.home?.name)} vs ${text(fixture.away?.name)}｜AM4 Football`;
    page.querySelector(".match-board")?.replaceWith(renderBoard(fixture));
    replaceActivePanel();
    if (focusedSummarySection) page.querySelector(`#${focusedSummarySection} summary`)?.focus({ preventScroll: true });
    window.scrollTo(0, previousScrollY);
  }

  function fixtureUpdateSignature(fixture) {
    return [fixture?.status, fixture?.goals?.home, fixture?.goals?.away].join("|");
  }

  function announceFixtureUpdate(previous, next) {
    if (fixtureUpdateSignature(previous) === fixtureUpdateSignature(next)) return;
    let announcer = document.getElementById("match-live-announcer");
    if (!announcer) {
      announcer = node("p", "sr-only");
      announcer.id = "match-live-announcer";
      announcer.setAttribute("aria-live", "polite");
      announcer.setAttribute("aria-atomic", "true");
      document.body.append(announcer);
    }
    const score = next?.goals?.home != null && next?.goals?.away != null
      ? `${next.home?.name || ""} ${next.goals.home} – ${next.goals.away} ${next.away?.name || ""}`
      : `${next?.home?.name || ""} VS ${next?.away?.name || ""}`;
    const status = statusLabels[next?.status]?.[locale === "ja" ? 0 : 1] || next?.statusLong || "";
    announcer.textContent = [score, status].filter(Boolean).join(locale === "ja" ? "、" : ", ");
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
      const previousFixture = currentDetail?.fixture;
      const previousGroup = matchGroup(previousFixture);
      const availability = { ...currentDetail.availability };
      const nextDetail = {
        ...currentDetail,
        fixture: fresh.fixture,
        availability,
        eventIntegrity: fresh.eventIntegrity || currentDetail.eventIntegrity,
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
      announceFixtureUpdate(previousFixture, fresh.fixture);
      renderLiveUpdate(currentDetail);
      if (previousGroup !== matchGroup(currentDetail.fixture)) {
        void refreshEditorialForFixture(currentDetail.fixture);
        finishedInsightsUntil = Date.now() + 30 * 60 * 1000;
        if (activePanel === 'lineups') void refreshInsights(true);
      }
    } catch (error) {
      console.warn("Live fixture detail refresh unavailable.", error);
    } finally {
      liveRefreshInFlight = false;
      scheduleLiveRefresh();
    }
  }

  function showArchiveDetail(result) {
    const archive = window.AM4MatchArchive.fixtureFromArchiveEditorials(result.editorials);
    if (!archive?.fixture) return false;
    currentDetail = {
      ...archive,
      events: null,
      lineups: null,
      statistics: null,
      eventIntegrity: { teamAssociation: null, goalScore: "unavailable" },
      availability: { events: false, lineups: false, statistics: false },
    };
    currentEditorial = {
      prediction: result.editorials.prediction,
      report: result.editorials.report,
      loading: false,
      errors: result.errors || {},
    };
    currentStandings = { state: "idle", data: null };
    activePanel = "overview";
    render(currentDetail);
    return true;
  }

  async function load() {
    const requestedFixtureId = validFixtureId(fixtureId);
    const archiveLocator = Boolean(parsedArchiveArticleId() || archiveCanonicalKey(archiveMatchKey));
    if (!requestedFixtureId && !archiveLocator) {
      state(locale === "ja" ? "試合が指定されていません" : "No match selected", locale === "ja" ? "試合一覧または公開済み記事から試合を選んでください。" : "Choose a match from the match list or a published article.");
      return;
    }
    const loader = window.AM4MatchDetailLoader?.loadMatchWithArchiveFallback;
    if (!loader) {
      state(locale === "ja" ? "試合情報を取得できませんでした" : "Could not load match", locale === "ja" ? "必要な表示モジュールを読み込めませんでした。時間をおいて、もう一度お試しください。" : "A required display module could not load. Please try again shortly.", true);
      return;
    }
    state(locale === "ja" ? "試合情報を読み込み中" : "Loading match", locale === "ja" ? "試合情報と公開済みAM4記事を確認しています。" : "Checking match data and published AM4 editorial.");
    client = AM4FootballData.createClient(fetch, AM4SiteConfig.resolveApiBase(window.location.hostname));
    const result = await loader({
      fixtureId: requestedFixtureId,
      hasArchiveLocator: archiveLocator,
      readFixture: async (id) => {
        try {
          return await client.fixtureDetail(id);
        } catch (error) {
          console.warn("Fixture detail unavailable; checking the public AM4 archive.", error);
          throw error;
        }
      },
      readArchive: archivedDetailFallback,
    });
    if (result.state === "fixture") {
      currentDetail = result.detail;
      rememberFixtureIdentity(result.detail.fixture);
      currentEditorial = { prediction: null, report: null, loading: true };
      currentStandings = { state: "loading", data: null };
      render(currentDetail);
      if (activePanel === "lineups") void refreshInsights();
      scheduleLiveRefresh();
      // Editorial loading is intentionally independent: a missing Notion record
      // can never hide the API-FOOTBALL facts already rendered above.
      void refreshEditorialForFixture(currentDetail.fixture);
      void refreshStandingsForFixture(currentDetail.fixture);
      return;
    }
    if (result.state === "archive" && showArchiveDetail(result.archive)) return;
    if (result.state === "archive-unavailable") {
      state(locale === "ja" ? "公開済み記事を照合できませんでした" : "Could not verify published editorial", locale === "ja" ? "一時的な取得障害の可能性があります。時間をおいて、もう一度お試しください。" : "This may be a temporary retrieval problem. Please try again shortly.", true);
      return;
    }
    if (result.state === "absent") {
      state(locale === "ja" ? "試合が見つかりません" : "Match not found", locale === "ja" ? "指定された試合、または一致する公開済み記事は見つかりませんでした。" : "The requested match or matching published editorial was not found.");
      return;
    }
    state(locale === "ja" ? "試合情報を取得できませんでした" : "Could not load match", locale === "ja" ? "時間をおいて、もう一度お試しください。" : "Please try again shortly.", true);
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
  window.addEventListener("hashchange", () => {
    const requestedPanel = window.location.hash.slice(1);
    if (!requestedPanel || PANEL_IDS.has(requestedPanel)) selectPanel(requestedPanel || "overview", { updateHash: false });
  });
  let finishedInsightsUntil = Date.now() + 30 * 60 * 1000;
  const insightTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || activePanel !== 'lineups' || !currentDetail) return;
    const finished = matchGroup(currentDetail.fixture) === 'finished';
    if (!finished || (Date.now() < finishedInsightsUntil && Date.now()-insightFetchedAt >= 300000)) void refreshInsights();
  },60000);
  window.addEventListener("pagehide", () => { clearLiveRefresh(); clearInterval(insightTimer); }, { once: true });
  const topbar=document.querySelector('.brand-topbar');
  if (topbar && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => document.documentElement.style.setProperty('--match-header-height',`${topbar.getBoundingClientRect().height}px`)).observe(topbar);
  load();
})();
