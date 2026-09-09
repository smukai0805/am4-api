(function (root, factory) {
  const motmTextPolicy = typeof module === "object" && module.exports
    ? require("./motm-text-policy.js")
    : root?.AM4MotmTextPolicy;
  const api = factory(motmTextPolicy);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchReportPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function (motmTextPolicy) {
  "use strict";

  const nameKey = value => String(value || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ø/g, "o").replace(/ð/g, "d").replace(/ł/g, "l")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  const validName = name => name && name.length <= 80 && /^[\p{L}\p{M} .’'\-・]+$/u.test(name)
    && !/未|確認|選出|なし|不明|候補|該当|推測|unknown|none|unavailable|not\s|pending|unconfirmed|tbc|tbd/iu.test(name);

  function hasAwardLabel(value) {
    const text=String(value || '').replace(/\*\*/g,'');
    return /(?:^|[\n。])\s*(?:[-*]\s+)?(?:(?:Sofascore|FotMob|WhoScored|Sports Mole|ESPN|UEFA|FIFA|公式|AM4)\s*(?:の\s*)?)?(?:Man of the Match|Player of the Match|MOTM|POTM|MOM|MVP|プレイヤー[・\s]?オブ[・\s]?ザ[・\s]?マッチ|マン[・\s]?オブ[・\s]?ザ[・\s]?マッチ)(?:\s*[（(][^）)\n]+[）)])?\s*(?:[：:]|は)/iu.test(text)
      || /(?:^|[\n。])\s*(?:[-*]\s+)?(?:Sofascore|FotMob|WhoScored|Sports Mole|ESPN)\s*(?:の\s*)?(?:最高評価(?:選手)?|Highest[- ]rated(?: player)?)\s*(?:[：:]|は)/iu.test(text);
  }

  function resolvePlayer(name, players = []) {
    const wanted = nameKey(name);
    const wantedParts = wanted.split(" ");
    const matches = new Map();
    for (const entry of players) {
      const player = entry?.player || entry;
      const id = Number(player?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const candidate = nameKey(player.name);
      const parts = candidate.split(" ");
      const exact = candidate === wanted;
      // Accept M. Ødegaard for Martin Ødegaard, but not a different first name
      // or an ambiguous surname shared by two participants.
      const abbreviated = parts.length === wantedParts.length && parts.length > 1
        && parts.every((part, index) => part === wantedParts[index]
          || (index < parts.length - 1 && part.length === 1 && wantedParts[index].startsWith(part)));
      const surnameOnly = parts.length === 1 && wantedParts.length > 1 && candidate === wantedParts.at(-1);
      if (exact || abbreviated || surnameOnly) matches.set(id, { ...player, id });
    }
    return matches.size === 1 ? [...matches.values()][0] : null;
  }

  function selectedMotm(value, players = []) {
    const text = String(value || "").replace(/\*\*/g, "");
    const matches = [...text.matchAll(/(?:^|[\n。])\s*(?:[-*]\s+)?(?:(Sofascore|FotMob|WhoScored|Sports Mole|ESPN|UEFA|FIFA|公式|AM4)\s*(?:の\s*)?)?(?:Man of the Match|Player of the Match|MOTM|POTM|MOM|MVP|プレイヤー[・\s]?オブ[・\s]?ザ[・\s]?マッチ|マン[・\s]?オブ[・\s]?ザ[・\s]?マッチ)(?:\s*[（(]([^）)\n]+)[）)])?\s*(?:[：:]|は)\s*([^（(\n。:：]+)/giu)]
      .map(match => ({ name:match[3].trim(), authority:match[1] || match[2] || "AM4" })).filter(item => validName(item.name));
    // A named highest-rated player from a recognized ratings provider is an
    // explicit external selection. Generic analysis saying only "highest
    // rated" remains insufficient to create an award.
    for (const match of text.matchAll(/(?:^|[\n。])\s*(?:[-*]\s+)?(Sofascore|FotMob|WhoScored|Sports Mole|ESPN)\s*(?:の\s*)?(?:最高評価(?:選手)?|Highest[- ]rated(?: player)?)\s*(?:[：:]|は)\s*([^（(\n。:：]+)/giu)) {
      const name=match[2].trim();
      if (validName(name)) matches.push({name,authority:match[1]});
    }
    // Legacy reports sometimes state a named player's MVP award in prose.
    const proseAward = text.match(/(?:^|\n)\s*([\p{L}\p{M} .’'\-・]+?)[（(][^）)\n]+[）)]\s*[：:]\s*(Sofascore|FotMob|WhoScored|Sports Mole|ESPN|UEFA|FIFA)の[^。\n]*?(?:MVP|MOTM|POTM)として(?:扱われ|選出され)/iu);
    if (proseAward && validName(proseAward[1].trim())) matches.push({name:proseAward[1].trim(),authority:proseAward[2]});
    const distinct = new Map(matches.map(item => [nameKey(item.name), item]));
    if (distinct.size !== 1) return null;
    const selection = [...distinct.values()][0];
    return {...selection, player:resolvePlayer(selection.name, players)};
  }

  function hasAwardStatement(value) {
    // Protect unparsed positive awards from a competing automatic selection.
    return motmTextPolicy?.hasPositiveSelection?.(value) ?? false;
  }

  function withoutMotmAbstention(value) {
    return motmTextPolicy?.withoutAbstention?.(value) ?? String(value || '').trim();
  }

  // Editorial choices made from the published reports below, not official awards.
  // Exact article identities prevent a choice leaking into a rematch.
  const editorialChoices = {
    'notion-match_report-3d4b49a367ef819a8a67f9f90e845605': {name:'Job Ochieng',reason:'1得点2アシストで全3得点に関与。10人になってからも決勝点を演出した攻撃への貢献を評価。'},
    'notion-match_report-3d4b49a367ef81d7b279fb6d54f4033c': {name:'Albert Guðmundsson',reason:'途中出場から決勝点を奪い、逆転勝利を決定づけた。短い出場時間で試合を変えた決定力を評価。'},
    'notion-match_report-3d0b49a367ef81b78893d0dee3622e7e': {name:'Eric Dier',reason:'決勝点に加え、最終ライン中央で後半の押し込みに対応。攻守両面で無失点勝利を支えた貢献を評価。'},
    'notion-match_report-3d4b49a367ef8168af08e431e12b12e9': {name:'Carl Starfelt',reason:'同点ゴールに加え、前半には相手の決定機を阻止。攻守両面で勝点1に直結した働きを評価。'},
    'notion-match_report-3d4b49a367ef8187a4abee8340999adf': {name:'Daniel Maldini',reason:'試合唯一の得点を決め、5本のシュートを記録。継続してゴールに迫り、勝利につなげた働きを評価。'},
    'notion-match_report-3d0b49a367ef81f28883e4bad4738340': {name:'Malick Fofana',reason:'途中出場から攻撃の流れを変え、勝利を近づける2点目を記録。終盤の攻撃への貢献を評価。'},
    'notion-match_report-3d0b49a367ef81c2a8cbf67d478e19fb': {name:'Donyell Malen',reason:'2得点で勝利に直結。背後への動きを繰り返し、相手の最終ラインを押し下げた貢献を評価。'},
    'notion-match_report-3d5b49a367ef81eb997bf054ca5b0a4c': {name:'Thibaut Courtois',reason:'7セーブでInterの連続攻撃を阻止。劣勢の時間帯を耐え、2-1の勝利を支えた貢献を評価。'},
  };

  function editorialAm4Motm(articleId, value, players = []) {
    if (hasAwardStatement(value)) return null;
    const choice = editorialChoices[articleId];
    return choice ? {...choice, authority:'AM4', basis:'editorial',player:resolvePlayer(choice.name,players)} : null;
  }

  function mergeParticipants(players = []) {
    const merged = new Map();
    for (const entry of players) {
      const player = entry?.player || entry;
      const id = Number(player?.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const previous = merged.get(id) || {};
      const next = {...previous,...player,id};
      for (const field of ['teamId','rating','minutes','goals','assists','photo']) {
        if (player?.[field] == null && previous[field] != null) next[field]=previous[field];
      }
      next.appeared=Boolean(previous.appeared || player?.appeared || player?.started
        || (typeof next.minutes==='number' && Number.isFinite(next.minutes) && next.minutes>0));
      merged.set(id,next);
    }
    return [...merged.values()];
  }

  function actualParticipants(fixture, players = []) {
    const teams=[Number(fixture?.home?.id),Number(fixture?.away?.id)];
    if (teams.some(id=>!Number.isSafeInteger(id) || id<=0) || teams[0]===teams[1]) return [];
    return mergeParticipants(players).filter(player=>player.appeared && validName(player.name)
      && teams.includes(Number(player.teamId)));
  }

  function narrativeAm4Motm(fixture, value, players = [], options = {}) {
    if (hasAwardStatement(value)) return null;
    const participants=actualParticipants(fixture,players);
    const textKey=nameKey(value);
    if (!textKey || !participants.length) return null;
    const surnames=new Map();
    participants.forEach(player=>{
      const surname=nameKey(player.name).split(' ').at(-1);
      if (!surname) return;
      const matches=surnames.get(surname) || [];
      matches.push(player);surnames.set(surname,matches);
    });
    const mentionIndex=surname=>{
      const escaped=surname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const match=new RegExp(`(?:^|\\s)${escaped}(?=$|\\s|[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}])`,'u').exec(textKey);
      return match ? match.index : -1;
    };
    const cueScore=sentence=>{
      let score=0;
      if (/最大の支え|最大の功労者|勝利の立役者|最優秀|試合を決め/iu.test(sentence)) score+=100;
      if (/決勝点|決勝ゴール/iu.test(sentence)) score+=40;
      if (/勝利に直結|勝利を支え|無失点を支え/iu.test(sentence)) score+=30;
      if (/先制点|同点ゴール|逆転ゴール/iu.test(sentence)) score+=15;
      const goals=sentence.match(/(\d+)\s*(?:得点|ゴール)/u);
      if (goals) score+=Number(goals[1])*18;
      const saves=sentence.match(/(\d+)\s*セーブ/u);
      if (saves) score+=Number(saves[1])*5;
      if (/アシスト|得点を演出/iu.test(sentence)) score+=10;
      return score;
    };
    const sentences=String(value || '').split(/(?<=[。.!?！？])|\n+/u).filter(Boolean);
    const mentioned=[...surnames.entries()].filter(([,matches])=>matches.length===1).map(([surname,matches])=>{
      const index=mentionIndex(surname);
      const score=sentences.filter(sentence=>nameKey(sentence).includes(surname)).reduce((total,sentence)=>total+cueScore(sentence),0);
      return {player:matches[0],index,score};
    }).filter(item=>item.index>=0).sort((a,b)=>b.score-a.score || a.index-b.index);
    const winner=mentioned[0];
    if (options.requireCue && (!winner || winner.score<=0)) return null;
    if (!winner) return null;
    return {name:winner.player.name,player:winner.player,authority:'AM4',basis:'editorial-narrative',
      reason:winner.score>0
        ? '試合解説に記録された決定的な貢献を比較し、AM4が選出。'
        : '試合解説の主要人物欄で中心に扱われた実出場選手として、AM4が選出。'};
  }

  function dataAm4Motm(fixture, players, value = '') {
    if (!['FT','AET','PEN'].includes(fixture?.status) || hasAwardStatement(value) || !Array.isArray(players)) return null;
    const teams = [Number(fixture.home?.id),Number(fixture.away?.id)];
    if (teams.some(id=>!Number.isSafeInteger(id) || id<=0) || teams[0]===teams[1]) return null;
    const rating = p => typeof p.rating === 'number' && Number.isFinite(p.rating) && p.rating >= 1 && p.rating <= 10 ? p.rating : -1;
    const contribution = p => (Number.isFinite(p.goals)?p.goals:0)+(Number.isFinite(p.assists)?p.assists:0);
    const minutes = p => typeof p.minutes === 'number' && Number.isFinite(p.minutes) && p.minutes > 0 ? p.minutes : 0;
    const eligible = actualParticipants(fixture,players);
    if (!eligible.length) return null;
    const homeGoals=Number(fixture.goals?.home),awayGoals=Number(fixture.goals?.away);
    const winnerTeamId=Number.isFinite(homeGoals)&&Number.isFinite(awayGoals)&&homeGoals!==awayGoals
      ? (homeGoals>awayGoals ? teams[0] : teams[1]) : null;
    eligible.sort((a,b)=>rating(b)-rating(a)
      || contribution(b)-contribution(a)
      || minutes(b)-minutes(a)
      || Number(Number(b.teamId)===winnerTeamId)-Number(Number(a.teamId)===winnerTeamId)
      || Number(Boolean(b.started))-Number(Boolean(a.started))
      || nameKey(a.name).localeCompare(nameKey(b.name)));
    const [best,next] = eligible;
    const exactFootballTie=next && rating(best)===rating(next) && contribution(best)===contribution(next)
      && minutes(best)===minutes(next) && Number(best.teamId===winnerTeamId)===Number(next.teamId===winnerTeamId)
      && Boolean(best.started)===Boolean(next.started);
    if (exactFootballTie) {
      const editorial=narrativeAm4Motm(fixture,value,eligible);
      if (editorial) return editorial;
    }
    const hasRating = rating(best) >= 1;
    return {name:best.name,player:best,authority:'AM4',basis:'data',rating:hasRating ? best.rating : null,
      reason:hasRating
        ? `API-FOOTBALLの評価点${best.rating.toFixed(1)}を基に選出。同評価では得点・アシストへの関与、出場時間の順に比較。`
        : contribution(best)>0
          ? '得点・アシストへの関与と出場記録を比較し、AM4が選出。'
          : '確認できた実出場者を対象に、試合解説と出場記録を総合してAM4が選出。'};
  }

  return { selectedMotm, hasAwardLabel, hasAwardStatement, editorialAm4Motm, narrativeAm4Motm, dataAm4Motm, resolvePlayer, withoutMotmAbstention };
});
