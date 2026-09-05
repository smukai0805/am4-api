(function () {
  "use strict";

  const page = document.getElementById("match-page");
  const fixtureId = new URLSearchParams(window.location.search).get("id");
  const locale = document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "ja";
  const text = (value, fallback = "—") => value == null || value === "" ? fallback : String(value);
  const UI = {
    ja: {
      back: "試合一覧へ戻る", retry: "もう一度試す", overview: "概要", events: "イベント", lineups: "ラインナップ", statistics: "スタッツ", standings: "順位",
      eventDescription: "試合終了からキックオフへ遡って表示", lineupDescription: "フォーメーション、監督、登録選手", statsDescription: "チーム比較", standingsDescription: "この対戦のリーグ内での現在地",
      home: "ホーム", away: "アウェイ", assist: "アシスト", goal: "ゴール", yellow_card: "イエローカード", red_card: "レッドカード", substitution: "選手交代",
      penalty: "PK", penalty_missed: "PK失敗", own_goal: "オウンゴール", var: "VAR", other: "イベント", second_yellow: "2枚目のイエローカード",
      preview: "MATCH PREVIEW", live: "LIVE MATCH", summary: "MATCH SUMMARY", prediction: "AM4 PREDICTION", matchSummary: "AM4 MATCH SUMMARY",
      score: "SCORE", goals: "GOALS", cards: "CARDS", predictionPending: "AM4の試合予想は公開準備中です。", reportPending: "AM4の試合解説は公開準備中です。",
      priorPrediction: "試合前のAM4予想を読む", previewDescription: "AM4の予想と、試合の見どころをまとめています。", liveDescription: "現在の試合状況と、試合前の見立てを確認できます。", summaryDescription: "結果と試合の要点を短時間で確認できます。",
      threeLine: "3行要約", previousReview: "前節レビュー", adjustments: "前節からの修正", tacticalMatchup: "戦術的な噛み合わせ", keyPlayers: "キープレイヤー", absences: "欠場情報", matchOutlook: "予想される試合展開", rationale: "予想の根拠",
      turningPoints: "試合を分けたポイント", firstHalf: "前半レビュー", secondHalf: "後半レビュー", tactics: "戦術分析", individualPerformance: "個人パフォーマンス", resultMeaning: "結果の意味", nextMatchFocus: "次戦への課題",
      pick: "本命", confidence: "確信度", kickoff: "KICK OFF", fullTime: "試合終了", halfTime: "前半終了", firstHalfFlow: "前半の流れ", secondHalfFlow: "後半の流れ", liveUpdate: "15秒ごとに更新", halftime: "前半", venue: "会場", referee: "主審", noEvents: "この試合では記録されたイベントはありません。", noLineups: "ラインナップはまだ発表されていません。", noStats: "比較できるチームスタッツはありません。", standingsLoading: "順位表を読み込んでいます。", noStandings: "この大会には順位表がありません。", standingsUnavailable: "順位表を取得できませんでした。", champions_league: "チャンピオンズリーグ", europa_league: "ヨーロッパリーグ", conference_league: "カンファレンスリーグ", relegation: "降格",
    },
    en: {
      back: "Back to matches", retry: "Try again", overview: "Overview", events: "Events", lineups: "Line-ups", statistics: "Stats", standings: "Standings",
      eventDescription: "Follow the match from full-time back to kick-off", lineupDescription: "Formation, coach and squad", statsDescription: "Team comparison", standingsDescription: "Where these two teams sit in this competition",
      home: "Home", away: "Away", assist: "ASSIST", goal: "Goal", yellow_card: "Yellow Card", red_card: "Red Card", substitution: "Substitution",
      penalty: "Penalty", penalty_missed: "Penalty Missed", own_goal: "Own Goal", var: "VAR", other: "Event", second_yellow: "Second Yellow",
      preview: "MATCH PREVIEW", live: "LIVE MATCH", summary: "MATCH SUMMARY", prediction: "AM4 PREDICTION", matchSummary: "AM4 MATCH SUMMARY",
      score: "SCORE", goals: "GOALS", cards: "CARDS", predictionPending: "AM4 prediction is being prepared.", reportPending: "AM4 match analysis is being prepared.",
      priorPrediction: "Read the pre-match AM4 prediction", previewDescription: "AM4 prediction and the key matchups.", liveDescription: "Follow the score and revisit the pre-match view.", summaryDescription: "The result and decisive moments, at a glance.",
      threeLine: "Three-line summary", previousReview: "Previous-match review", adjustments: "Expected adjustments", tacticalMatchup: "Tactical matchup", keyPlayers: "Key players", absences: "Absences", matchOutlook: "Expected match flow", rationale: "Why AM4 sees it this way",
      turningPoints: "Decisive moments", firstHalf: "First-half review", secondHalf: "Second-half review", tactics: "Tactical analysis", individualPerformance: "Individual performances", resultMeaning: "What the result means", nextMatchFocus: "Next-match focus",
      pick: "Pick", confidence: "Confidence", kickoff: "KICK OFF", fullTime: "FULL TIME", halfTime: "HALF TIME", firstHalfFlow: "FIRST-HALF FLOW", secondHalfFlow: "SECOND-HALF FLOW", liveUpdate: "updates every 15 seconds", halftime: "Half-time", venue: "Venue", referee: "Referee", noEvents: "No recorded events for this match.", noLineups: "Line-ups have not been announced.", noStats: "Comparable team stats are not available.", standingsLoading: "Loading standings.", noStandings: "This competition does not have a standings table.", standingsUnavailable: "Standings could not be loaded.", champions_league: "Champions League", europa_league: "Europa League", conference_league: "Conference League", relegation: "Relegation",
    },
  };
  const t = (key) => UI[locale][key] || key;
  const statusLabels = { NS: ["開催予定", "Scheduled"], TBD: ["日時未定", "Date TBD"], FT: ["試合終了", "Full-time"], AET: ["延長終了", "After extra time"], PEN: ["PK戦終了", "Penalties"], HT: ["ハーフタイム", "Half-time"], "1H": ["前半", "First half"], "2H": ["後半", "Second half"], ET: ["延長戦", "Extra time"], BT: ["休憩", "Break"], P: ["PK戦", "Penalties"], LIVE: ["試合中", "Live"], INT: ["中断", "Interrupted"], PST: ["延期", "Postponed"], CANC: ["中止", "Cancelled"], ABD: ["中断", "Abandoned"], SUSP: ["中断", "Suspended"], AWD: ["没収試合", "Awarded"], WO: ["不戦勝", "Walkover"] };
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
  let currentEditorial = { prediction: null, report: null, loading: true };
  let currentStandings = { state: "idle", data: null };
  const PANEL_IDS = new Set(["overview", "events", "lineups", "statistics", "standings"]);
  let activePanel = PANEL_IDS.has(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "overview";
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;
  let editorialRequest = 0;
  let standingsRequest = 0;

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content != null) el.textContent = content;
    return el;
  }

  function backLink() {
    const link = node("a", "match-back", t("back"));
    link.href = "/#fixtures";
    return link;
  }

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
      const data = await client.lineupInsights(fixtureId);
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
    button.setAttribute('aria-label',`${displayPlayerName(player)} · ${locale === 'ja' ? '選手詳細' : 'Player details'}`);
    const portrait = node('span','pitch-portrait',String(player.number ?? '–'));
    const stat = !predicted && insightState.data?.players?.find(p=>p.id===player.id);
    const photo = player.photo || stat?.photo || (player.id ? `https://media.api-sports.io/football/players/${player.id}.png` : null);
    if (photo) { const img = node('img',''); img.src=photo; img.alt=''; img.loading='lazy'; img.width=44; img.height=44; img.addEventListener('error',()=>img.remove(),{once:true}); portrait.append(img); }
    button.append(portrait,node('span','pitch-number',String(player.number ?? '–')),node('span','pitch-name',displayPlayerName(player)));
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

  function playerRow(player) {
    const item = node("li", "lineup-player");
    const number = node("span", "lineup-number", player.number == null ? "—" : String(player.number));
    const name = playerButton(player, "lineup-name");
    const position = node("small", "", text(player.position, "—"));
    item.append(number, name, position);
    AM4Formation.contributions(player.id,currentDetail?.events || []).changes.forEach(c => item.append(node('span','lineup-change',`${c.direction} ${c.minute || ''} · ${displayPlayerName(c.other)}`)));
    return item;
  }
  function lineupCard(lineup) {
    const card = node("article", "lineup-card");
    const heading = node("div", "lineup-card-head");
    heading.append(node("h3", "", text(lineup.team?.name, "チーム情報なし")), node("span", "", lineup.formation ? `${lineup.formation}` : "フォーメーション未発表"));
    const coach = node("p", "lineup-coach", `${locale === "ja" ? "監督" : "Coach"} ${text(lineup.coach?.name, "—")}`);
    card.append(heading, coach);
    const xiTitle = node("h4", "", locale === "ja" ? "スターティングXI" : "Starting XI");
    card.append(xiTitle);
    if (lineup.startXI?.length) { const list = node("ol", "lineup-list"); lineup.startXI.forEach((player) => list.append(playerRow(player))); card.append(list); }
    else card.append(node("p", "match-empty", "先発メンバーは未発表です。"));
    const subTitle = node("h4", "", locale === "ja" ? "控え選手" : "Substitutes");
    card.append(subTitle);
    if (lineup.substitutes?.length) { const list = node("ol", "lineup-list lineup-list--subs"); lineup.substitutes.forEach((player) => list.append(playerRow(player))); card.append(list); }
    else card.append(node("p", "match-empty", "控え選手の情報はありません。"));
    return card;
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
      layout.rows.forEach(row=>{const line=node('div','pitch-row');line.style.setProperty('--players',row.players.length);line.dataset.count=row.players.length;row.players.forEach(p=>line.append(pitchPlayer(p,Boolean(lineup.predicted))));field.append(line);});
      if (!layout.rows.length) field.append(node('p','match-empty',locale==='ja'?'配置情報はまだありません。':'Positions are not available yet.'));
      half.append(field);
      if (layout.unplaced.length) half.append(node('p','match-empty',locale==='ja'?`${layout.unplaced.length}人は配置情報がないため下の一覧で確認できます。`:`${layout.unplaced.length} players without positions are listed below.`));
      if (lineup.predicted) {half.append(node('p','pitch-disclaimer',locale==='ja'?'配置も直近の布陣を基にした推定です。':'Positions are estimated from recent formations.')); half.append(predictionEvidence(lineup));}
      pitch.append(half);
    });
    el.append(pitch);
    if(insightState.data?.updatedAt) el.append(node('p','lineup-updated',`${locale==='ja'?'最終更新':'Updated'} ${new Date(insightState.data.updatedAt).toLocaleString(locale==='ja'?'ja-JP':'en-GB')}`));
    const lists=node('details','lineup-details');lists.append(node('summary','',locale==='ja'?'先発・控え・監督を確認':'Starting XI, substitutes and coaches'));
    const grid=node('div','lineup-grid');lineups.forEach(l=>grid.append(lineupCard(l)));lists.append(grid);el.append(lists);
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
    return fixture.kickoff
      ? new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(fixture.kickoff))
      : "—";
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
    [["overview", t("overview")], ["events", t("events")], ["lineups", t("lineups")], ["statistics", t("statistics")], ["standings", t("standings")]].forEach(([id, label]) => {
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

  function normalizedCompetition(value) {
    const normalized = normalizedIdentityPart(value);
    return {
      "プレミアリーグ": "premierleague", premierleague: "premierleague", "ラリーガ": "laliga", laliga: "laliga",
      "セリエa": "seriea", seriea: "seriea", "ブンデスリーガ": "bundesliga", bundesliga: "bundesliga", "リーグアン": "ligue1", ligue1: "ligue1",
    }[normalized] || normalized;
  }

  function fixtureDateKey(fixture) {
    // AM4's Notion Match Key uses API-FOOTBALL's fixture date (the competition
    // date), not the Japanese display date. A Premier League evening fixture is
    // often the following day in JST, so converting kickoff to Tokyo first
    // would join the wrong editorial record or miss the right one.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(fixture?.date || ""))) return fixture.date;
    const value = fixture?.kickoff || fixture?.date;
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? AM4FootballData.tokyoDateKey(value) : String(value).slice(0, 10) || null;
  }

  function canonicalFixtureKey(fixture) {
    const parts = [normalizedCompetition(fixture?.competition), fixtureDateKey(fixture), normalizedIdentityPart(fixture?.home?.name), normalizedIdentityPart(fixture?.away?.name)];
    return parts.every(Boolean) ? parts.join("|") : null;
  }

  function editorialMatchesFixture(article, fixture) {
    const match = article?.match;
    if (!match) return false;
    const articleFixtureId = Number(match.fixtureId);
    if (Number.isInteger(articleFixtureId) && articleFixtureId > 0) return articleFixtureId === Number(fixture.id);
    const expectedKey = canonicalFixtureKey(fixture);
    if (match.canonicalKey && expectedKey) return match.canonicalKey === expectedKey;
    const articleDate = String(match.date || "").slice(0, 10);
    return Boolean(
      articleDate && articleDate === fixtureDateKey(fixture)
      && normalizedIdentityPart(match.homeTeam) === normalizedIdentityPart(fixture.home?.name)
      && normalizedIdentityPart(match.awayTeam) === normalizedIdentityPart(fixture.away?.name)
      && (!match.competition || normalizedCompetition(match.competition) === normalizedCompetition(fixture.competition))
    );
  }

  function isNotionEditorial(article, type) {
    return article?.contentKind === `notion_${type}` && Boolean(article?.notion?.pageId);
  }

  async function fullEditorialArticle(type, fixture) {
    const fallbackDate = fixtureDateKey(fixture);
    const requests = [client.articles({ type, fixtureId: fixture.id, pageSize: 12 })];
    if (fallbackDate) requests.push(client.articles({ type, matchDate: fallbackDate, pageSize: 100 }));
    const results = await Promise.allSettled(requests);
    const candidates = new Map();
    results.forEach((result) => {
      if (result.status === "fulfilled") (result.value.items || []).forEach((article) => candidates.set(article.id, article));
    });
    const selected = [...candidates.values()].find((article) => isNotionEditorial(article, type) && editorialMatchesFixture(article, fixture));
    if (!selected?.id) return null;
    const response = await client.article(selected.id);
    return response?.article && isNotionEditorial(response.article, type) && editorialMatchesFixture(response.article, fixture)
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
      const unavailableTypes = Object.keys(editorial.errors || {});
      if (unavailableTypes.length) {
        const fallbackResults = await Promise.allSettled(unavailableTypes.map((type) => fullEditorialArticle(type, fixture)));
        unavailableTypes.forEach((type, index) => {
          if (fallbackResults[index].status !== "fulfilled") return;
          if (type === "match_prediction") editorial.prediction = fallbackResults[index].value;
          if (type === "match_report") editorial.report = fallbackResults[index].value;
        });
      }
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
    return String(value || "").replace(/\r\n?/g, "\n").replace(/^[-*+]\s+/gm, "").replace(/\*\*/g, "").trim();
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

  function editorialBlock(label, value) {
    if (!value) return null;
    const block = node("article", "match-editorial-block");
    block.append(node("h3", "", label), node("p", "", value));
    return block;
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
    const fields = [
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
    return fields.map(([label, field, aliases]) => editorialBlock(label, editorialValue(report, "report", field, aliases))).filter(Boolean);
  }

  function predictionPanel(prediction, { disclosure = false } = {}) {
    if (!prediction) return editorialEmpty('match_prediction');
    const wrap = node(disclosure ? "details" : "div", disclosure ? "match-editorial-disclosure" : "match-editorial-content");
    if (disclosure) wrap.append(node("summary", "", t("priorPrediction")));
    const content = node("div", "match-editorial-content");
    const hero = node("article", "match-editorial-hero match-editorial-hero--prediction");
    hero.append(node("span", "match-editorial-kicker", t("prediction")));
    const values = node("div", "match-prediction-values");
    if (prediction.prediction?.score) values.append(node("strong", "", prediction.prediction.score));
    if (prediction.prediction?.pick) {
      const pick = node("span", "match-prediction-pick");
      pick.append(node("small", "", t("pick")), node("b", "", prediction.prediction.pick));
      values.append(pick);
    }
    if (Number.isFinite(Number(prediction.prediction?.confidence))) {
      const confidence = node("span", "match-prediction-pick");
      confidence.append(node("small", "", t("confidence")), node("b", "", `${Math.round(Number(prediction.prediction.confidence))}%`));
      values.append(confidence);
    }
    if (values.childElementCount) hero.append(values);
    const summary = editorialValue(prediction, "prediction", "summary", ["3行要約", "予想要約", "summary"]);
    if (summary) hero.append(node("p", "match-editorial-summary", summary));
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
  function reportPanel(report) {
    if (!report) return editorialEmpty('match_report');
    const content = node("div", "match-editorial-content match-editorial-content--report");
    content.append(node("span", "match-editorial-kicker", t("matchSummary")));
    const summary = editorialValue(report, "report", "summary", ["3行要約", "試合要約", "summary"]);
    if (summary) content.append(node("p", "match-editorial-summary", summary));
    const blocks = reportBlocks(report);
    if (blocks.length) {
      const grid = node("div", "match-editorial-grid");
      grid.append(...blocks);
      content.append(grid);
    }
    return content;
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
      const substitutions = summaryBlock(detail, t("substitution"), substitutionEvents(detail));
      if (goals) overview.append(goals);
      if (cards) overview.append(cards);
      if (substitutions) overview.append(substitutions);
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

  async function load() {
    if (!/^[1-9]\d*$/.test(fixtureId || "")) { state(locale === "ja" ? "試合が指定されていません" : "No match selected", locale === "ja" ? "試合一覧から試合を選んでください。" : "Choose a match from the match list."); return; }
    state(locale === "ja" ? "試合情報を読み込み中" : "Loading match", locale === "ja" ? "イベント、ラインナップ、スタッツを準備しています。" : "Preparing events, line-ups and stats.");
    try {
      client = AM4FootballData.createClient(fetch, AM4SiteConfig.resolveApiBase(window.location.hostname));
      const detail = await client.fixtureDetail(fixtureId);
      if (!detail || !detail.fixture) { state(locale === "ja" ? "試合が見つかりません" : "Match not found", locale === "ja" ? "指定された試合は見つかりませんでした。" : "The requested match could not be found."); return; }
      currentDetail = detail;
      currentEditorial = { prediction: null, report: null, loading: true };
      currentStandings = { state: "loading", data: null };
      render(currentDetail);
      if (activePanel === "lineups") void refreshInsights();
      scheduleLiveRefresh();
      // Editorial loading is intentionally independent: a missing Notion record
      // can never hide the API-FOOTBALL facts already rendered above.
      void refreshEditorialForFixture(currentDetail.fixture);
      void refreshStandingsForFixture(currentDetail.fixture);
    } catch (error) {
      console.warn("Fixture detail unavailable.", error);
      state(locale === "ja" ? "試合情報を取得できませんでした" : "Could not load match", locale === "ja" ? "時間をおいて、もう一度お試しください。" : "Please try again shortly.", true);
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
