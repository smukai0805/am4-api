(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchReportPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const nameKey = value => String(value || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ø/g, "o").replace(/ð/g, "d").replace(/ł/g, "l")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  const validName = name => name && name.length <= 80 && /^[\p{L}\p{M} .’'\-・]+$/u.test(name)
    && !/未|確認|選出|なし|不明|候補|該当|推測|unknown|none|unavailable|not\s|pending|unconfirmed|tbc|tbd/iu.test(name);
  const AM4_MOTM_CRITERIA = '選定基準：試合を動かす決定的な貢献、重要局面でのプレー、攻守にわたる影響を総合して選定。';
  const stripExternalAwardClause = sentence => {
    const cleaned = String(sentence || '').replace(
      /(?:^|[、,]\s*)(?:Sky\s*Sport|Sofascore|FotMob|Sports Mole|UEFA|FIFA)[^、。！？!?]*(?:評価(?:点)?|評点|MVP|MOTM|POTM|選出)[^、。！？!?]*(?=[、。！？!?]|$)/giu,
      (match, offset, source) => {
        const before = source.slice(0, offset).trimEnd();
        const next = source.charAt(offset + match.length);
        if (!before) return '';
        return next === '、' || next === ',' ? '' : (/し$/u.test(before) ? 'た' : '');
      },
    ).replace(/^[、,]\s*/u, '').trim();
    return /[^\s、。！？!?]/u.test(cleaned) ? cleaned : '';
  };
  const motmSentences = value => String(value || '').replace(/\*\*/g, '').split(/\n+/)
    .flatMap(line => line.match(/[^。！？!?]+[。！？!?]?/gu) || []).map(stripExternalAwardClause).map(line => line.trim()).filter(Boolean);
  const isInternalMotmCopy = sentence => [
    /api[-\s]?football|api[-\s]?sports/iu,
    /(?:Sky\s*Sport|Sofascore|FotMob|Sports Mole|UEFA|FIFA)[^。！？!?]*(?:評価(?:点)?|評点|MVP|MOTM|POTM|選出)/iu,
    /(?:評価点|同評価|出場時間の順|得点・アシストへの関与[^。！？!?]*(?:比較|順))/iu,
    /(?:公式|信頼できる(?:媒体|情報源)?|外部(?:媒体|情報源)?)[^。！？!?]*(?:MOTM|POTM|MVP)[^。！？!?]*(?:確定|確認|発表|選出|設定|情報)[^。！？!?]*(?:ない|ず|ません|行わない|しない)/iu,
    /(?:推測|憶測)[^。！？!?]*(?:選出|設定)[^。！？!?]*(?:ない|ず|ません|行わない|しない)/iu,
    /(?:MOTM|POTM|MVP)[^。！？!?]*(?:確定情報|確認でき|選出は行わない|選出しない|設定しない|見つから)/iu,
    /選出(?:しない|(?:を|は)?行わない)|設定(?:しない|(?:を|は)?行わない)/u,
  ].some(pattern => pattern.test(sentence));

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
    const matches = [...text.matchAll(/(?:^|[\n。])\s*(?:[-*]\s+)?(?:(Sofascore|FotMob|Sports Mole|UEFA|FIFA|公式|AM4)(?:選出)?\s*)?(?:Man of the Match|Player of the Match|MOTM|POTM)(?:\s*[（(]([^）)\n]+)[）)])?\s*[：:]\s*([^（(\n。:：]+)/giu)]
      .map(match => ({ name:match[3].trim(), authority:match[1] || match[2] || "" })).filter(item => validName(item.name));
    // Legacy reports sometimes state a named player's MVP award in prose.
    const proseAward = text.match(/(?:^|\n)\s*([\p{L}\p{M} .’'\-・]+?)[（(][^）)\n]+[）)]\s*[：:]\s*(Sofascore|FotMob|UEFA|FIFA)の[^。\n]*?(?:MVP|MOTM|POTM)として(?:扱われ|選出され)/iu);
    if (proseAward && validName(proseAward[1].trim())) matches.push({name:proseAward[1].trim(),authority:proseAward[2]});
    const distinct = new Map(matches.map(item => [nameKey(item.name), item]));
    if (distinct.size !== 1) return null;
    const selection = [...distinct.values()][0];
    return {...selection, source:selection.authority || null, authority:'AM4', criteria:AM4_MOTM_CRITERIA,
      player:resolvePlayer(selection.name, players)};
  }

  function hasAwardStatement(value) {
    // Protect unparsed positive awards from a competing automatic selection.
    return String(value || "").split(/\n|。/u).some(line =>
      /MOTM|POTM|MVP|(?:Man|Player) of the Match/iu.test(line)
      && !/未|確認でき|設定しない|見つから|不明|なし|候補|not |unknown|unavailable|unconfirmed/iu.test(line));
  }

  function withoutMotmAbstention(value) {
    // Keep source line boundaries: `motmReference` uses them to keep a
    // following "ほかでは…" paragraph outside the selected player's card.
    return String(value || '').replace(/\r\n?/g, '\n').split('\n')
      .map(line => motmSentences(line).filter(sentence => !isInternalMotmCopy(sentence)).join(' ').trim())
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Editorial choices made from the published reports below, not official awards.
  // Exact article identities prevent a choice leaking into a rematch.
  const editorialChoices = {
    'notion-match_report-3dfb49a367ef81b88fd7cc9f3677597b': {name:'Kevin Schade',clubName:'Brentford',reason:'自身の得点はなかったが、2点目のシュートと3点目の折り返しでBrentfordの終盤2得点に直接関与した。'},
    'notion-match_report-3d4b49a367ef819a8a67f9f90e845605': {name:'Job Ochieng',reason:'1得点2アシストで全3得点に関与。10人になってからも決勝点を演出した攻撃への貢献を評価。'},
    'notion-match_report-3d4b49a367ef81d7b279fb6d54f4033c': {name:'Albert Guðmundsson',reason:'途中出場から決勝点を奪い、逆転勝利を決定づけた。短い出場時間で試合を変えた決定力を評価。'},
    'notion-match_report-3d0b49a367ef81b78893d0dee3622e7e': {name:'Eric Dier',reason:'決勝点に加え、最終ライン中央で後半の押し込みに対応。攻守両面で無失点勝利を支えた貢献を評価。'},
    'notion-match_report-3d4b49a367ef8168af08e431e12b12e9': {name:'Carl Starfelt',reason:'同点ゴールに加え、前半には相手の決定機を阻止。攻守両面で勝点1に直結した働きを評価。'},
    'notion-match_report-3d4b49a367ef8187a4abee8340999adf': {name:'Daniel Maldini',reason:'試合唯一の得点を決め、5本のシュートを記録。継続してゴールに迫り、勝利につなげた働きを評価。'},
    'notion-match_report-3d0b49a367ef81f28883e4bad4738340': {name:'Malick Fofana',reason:'途中出場から攻撃の流れを変え、勝利を近づける2点目を記録。終盤の攻撃への貢献を評価。'},
    'notion-match_report-3d0b49a367ef81c2a8cbf67d478e19fb': {name:'Donyell Malen',reason:'2得点で勝利に直結。背後への動きを繰り返し、相手の最終ラインを押し下げた貢献を評価。'},
  };

  function editorialAm4Motm(articleId, value, players = []) {
    if (hasAwardStatement(value)) return null;
    const choice = editorialChoices[articleId];
    return choice ? {...choice, authority:'AM4', basis:'editorial',criteria:AM4_MOTM_CRITERIA,
      player:resolvePlayer(choice.name,players)} : null;
  }

  function withEditorialArticleMotm(article, blocks = []) {
    if (article?.type !== 'match_report' || !Array.isArray(blocks)) return blocks;
    const keyFigures = String(article?.report?.keyFigures || '');
    if (selectedMotm(keyFigures, [])) return blocks;
    const selection = editorialAm4Motm(article?.id, keyFigures, []);
    if (!selection) return blocks;
    const headingIndex = blocks.findIndex(block => block?.type === 'heading'
      && /^(?:試合主要人物|主要人物|MOTM)$/iu.test(String(block.text || '').trim()));
    if (headingIndex < 0) return blocks;
    const nextHeadingIndex = blocks.findIndex((block, index) => index > headingIndex && block?.type === 'heading');
    const sectionEnd = nextHeadingIndex < 0 ? blocks.length : nextHeadingIndex;
    const club = String(selection.clubName || '').trim();
    return [
      ...blocks.slice(0, headingIndex + 1),
      {type:'paragraph',text:`AM4独自MOTM：${selection.name}${club ? `（${club}）` : ''}`},
      {type:'paragraph',text:selection.reason},
      ...blocks.slice(sectionEnd),
    ];
  }

  function dataAm4Motm(fixture, players, value = '') {
    if (!['FT','AET','PEN'].includes(fixture?.status) || hasAwardStatement(value) || !Array.isArray(players)) return null;
    const teams = [Number(fixture.home?.id),Number(fixture.away?.id)];
    if (teams.some(id=>!Number.isSafeInteger(id) || id<=0) || teams[0]===teams[1]) return null;
    const eligible = [...new Map(players.filter(p => p && Number.isSafeInteger(Number(p.id)) && Number(p.id)>0
      && validName(p.name) && teams.includes(Number(p.teamId)) && typeof p.rating==='number' && Number.isFinite(p.rating)
      && p.rating>=1 && p.rating<=10 && typeof p.minutes==='number' && p.minutes>0).map(p=>[Number(p.id),p])).values()];
    // Do not crown someone from a one-sided or substantially incomplete payload.
    if (teams.some(id=>eligible.filter(p=>Number(p.teamId)===id).length<9)) return null;
    const contribution = p => (Number.isFinite(p.goals)?p.goals:0)+(Number.isFinite(p.assists)?p.assists:0);
    eligible.sort((a,b)=>b.rating-a.rating || contribution(b)-contribution(a) || b.minutes-a.minutes);
    const [best,next] = eligible;
    if (next && best.rating===next.rating && contribution(best)===contribution(next) && best.minutes===next.minutes) return null;
    return {name:best.name,player:best,authority:'AM4',basis:'data',rating:best.rating,
      criteria:AM4_MOTM_CRITERIA};
  }

  return { selectedMotm, hasAwardStatement, editorialAm4Motm, withEditorialArticleMotm, dataAm4Motm, resolvePlayer, withoutMotmAbstention, AM4_MOTM_CRITERIA };
});
