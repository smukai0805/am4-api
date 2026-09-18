(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4PredictionKeyPlayers = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const nameKey = value => String(value || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ø/g, 'o').replace(/ð/g, 'd').replace(/ł/g, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const clubKey = value => nameKey(value).replace(/\b(?:afc|as|cf|club|fc|football|rcd|sc)\b/g, '').replace(/\s/g, '');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const DEFAULT_MOTM_CRITERIA = '選定基準：試合を動かす決定的な貢献、重要局面でのプレー、攻守にわたる影響を総合して選定。';
  const safeImage = value => {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
  };
  const numericId = value => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const fixtureTeams = fixture => [fixture?.home, fixture?.away].filter(Boolean);
  function teamForId(id, fixture) {
    const expected = numericId(id);
    return expected ? fixtureTeams(fixture).find(team => numericId(team?.id) === expected) || null : null;
  }
  function sideForTeam(team, fixture) {
    const id = numericId(team?.id);
    if (id && id === numericId(fixture?.home?.id)) return 'home';
    if (id && id === numericId(fixture?.away?.id)) return 'away';
    return null;
  }
  function teamForLabel(label, fixture) {
    const key = clubKey(label);
    if (!key) return null;
    // Editorial labels can omit an optional provider suffix (Brighton /
    // Brighton & Hove Albion, Roma / AS Roma). Accept that only when one
    // fixture team is uniquely identified; an ambiguous label stays unknown.
    const matches = fixtureTeams(fixture).filter((team) => {
      const candidate = clubKey(team?.name);
      return candidate && (candidate === key
        || (key.length >= 4 && candidate.length >= 4 && (candidate.includes(key) || key.includes(candidate))));
    });
    return matches.length === 1 ? matches[0] : null;
  }
  function samePlayerName(actual, expected) {
    const a = nameKey(actual).split(' '), b = nameKey(expected).split(' ');
    if (!a[0] || !b[0]) return false;
    if (a.join(' ') === b.join(' ')) return true;
    return a.length === b.length && a.length > 1 && a.at(-1) === b.at(-1)
      && a.slice(0, -1).every((part, i) => part === b[i]
        || (part.length === 1 && b[i].startsWith(part)) || (b[i].length === 1 && part.startsWith(b[i])));
  }
  function participants(detail) {
    const fixture = detail?.fixture || {};
    const teamForId = id => [fixture.home, fixture.away].find(t => Number(t?.id) === Number(id));
    return [
      ...(detail?.lineups || []).flatMap(l => [...(l.startXI || []), ...(l.substitutes || []), ...(l.absences || [])].map(p => ({...(p.player || p), team: l.team}))),
      ...(detail?.players || []).map(p => ({...(p.player || p), team:p.team || teamForId(p.teamId)})),
      ...(detail?.events || []).flatMap(e => [e.player,e.assist].filter(Boolean).map(p => ({...p,team:e.team || teamForId(e.teamId)}))),
    ];
  }
  function resolveReference(reference, fixture, players = []) {
    let team = reference.team || teamForLabel(reference.clubLabel, fixture);
    const matches = new Map();
    for (const entry of players) {
      const p = entry?.player || entry;
      if (!Number.isSafeInteger(Number(p?.id)) || Number(p.id) <= 0 || !samePlayerName(p.name, reference.playerName)) continue;
      const candidateTeam = entry.team || p.team || [fixture?.home,fixture?.away].find(t => Number(t?.id) === Number(entry.teamId));
      if (team && candidateTeam && Number(team.id) !== Number(candidateTeam.id)) continue;
      const prior = matches.get(Number(p.id));
      matches.set(Number(p.id), {...prior,...p,team:candidateTeam || prior?.team});
    }
    const player = matches.size === 1 ? [...matches.values()][0] : null;
    team ||= player?.team || null;
    const id = Number(player?.id);
    return {...reference,team,player,photo:player && (safeImage(player.photo) || `https://media.api-sports.io/football/players/${id}.png`)};
  }
  function legacySplitEntries(value, fixture, players = []) {
    const entries = [];
    const latin = String.raw`(?:[A-Z]\\.|[\\p{Script=Latin}\\p{M}’'\\-]+)(?:\\s+(?:[A-Z]\\.|[\\p{Script=Latin}\\p{M}’'\\-]+)){0,5}`.replace(/\\\\/g,'\\');
    const kana = '[ァ-ヶー・]{2,35}';
    const head = new RegExp(`^(${latin}|${kana})(\\s*[（(][^）)\\n]*[）)])?\\s*(?:[。.!?！？:：]\\s*|$)(.*)$`, 'u');
    const lines = String(value || '').replace(/\r\n?/g,'\n').replace(/\*\*/g,'').split('\n');
    for (const line of lines) {
      const clean = line.replace(/^\s*(?:[-*]|#{1,6})\s+/,'').trim();
      const prefix = clean.match(/^([^:：\n]{2,80})\s*[:：]\s*(.*)$/u);
      const team = prefix && teamForLabel(prefix[1],fixture);
      const match = (team ? prefix[2] : clean).match(head);
      if (match) {
        const inlineClubLabel = match[2]?.replace(/^\s*[（(]\s*|\s*[）)]\s*$/g, '').trim() || '';
        const inlineTeam = inlineClubLabel ? teamForLabel(inlineClubLabel, fixture) : null;
        const playerName = match[1].trim();
        const isSingleWordLatin = !/\s/u.test(playerName)
          && /^[\p{Script=Latin}\p{M}’'\-]+$/u.test(playerName);
        const isKnownPlayer = players.some(player => samePlayerName((player?.player || player)?.name, playerName));
        // A bare single English word can be a prose heading (for example,
        // "Conclusion."). Treat it as a player only when the club or squad
        // data anchors the reference.
        if (isSingleWordLatin && !team && !inlineTeam && !isKnownPlayer) {
          if (entries.length) {
            const last = entries.at(-1); last.reason = `${last.reason}\n${line}`;
          } else if (clean) entries.push({type:'text',reason:line});
          continue;
        }
        const reference = {
          clubLabel: team ? prefix[1].trim() : inlineTeam ? inlineClubLabel : '',
          playerName,
          reason: [inlineTeam ? '' : match[2]?.trim(), match[3]?.trim()].filter(Boolean).join('\n\n'),
        };
        entries.push({type:'player',...resolveReference(reference,fixture,players)});
      } else if (entries.length) {
        const last = entries.at(-1); last.reason = `${last.reason}\n${line}`;
      } else if (clean) entries.push({type:'text',reason:line});
    }
    return entries.map(e=>({...e,reason:e.reason.trim()}));
  }
  function resolvePredictionReference(reference = {}, fixture, players = []) {
    let team = reference.team
      || teamForId(reference.teamId, fixture)
      || teamForLabel(reference.clubName || reference.clubLabel, fixture);
    const requestedPlayerId = numericId(reference.playerId);
    const matches = new Map();
    for (const entry of players || []) {
      const player = entry?.player || entry;
      const playerId = numericId(player?.id);
      if (!playerId || !samePlayerName(player?.name, reference.playerName)) continue;
      if (requestedPlayerId && requestedPlayerId !== playerId) continue;
      const candidateTeam = entry?.team || player?.team || teamForId(entry?.teamId || player?.teamId, fixture);
      if (team && candidateTeam && numericId(team.id) !== numericId(candidateTeam.id)) continue;
      const previous = matches.get(playerId);
      matches.set(playerId, {...previous, ...player, team: candidateTeam || previous?.team});
    }
    let player = matches.size === 1 ? [...matches.values()][0] : null;
    team ||= player?.team || null;
    const teamId = numericId(team?.id) || numericId(reference.teamId);
    const canReuse = Boolean(reference.resolved && requestedPlayerId && teamId && teamForId(teamId, fixture));
    if (!player && canReuse) {
      player = {
        id: requestedPlayerId,
        name: reference.playerName,
        photo: safeImage(reference.photoUrl || reference.photo)
          || 'https://media.api-sports.io/football/players/' + requestedPlayerId + '.png',
        team,
      };
    }
    const playerId = numericId(player?.id);
    const resolved = Boolean(playerId && teamId && teamForId(teamId, fixture));
    const photoUrl = resolved
      ? safeImage(player?.photo) || 'https://media.api-sports.io/football/players/' + playerId + '.png'
      : null;
    const logoUrl = safeImage(team?.logo)
      || (teamId ? 'https://media.api-sports.io/football/teams/' + teamId + '.png' : null);
    return {
      ...reference,
      type: 'player',
      playerName: String(reference.playerName || '').trim(),
      clubLabel: String(reference.clubLabel || reference.clubName || team?.name || '').trim(),
      clubName: String(team?.name || reference.clubName || reference.clubLabel || '').trim(),
      reason: String(reference.reason || '').trim(),
      team: team && (safeImage(team.logo) ? team : {...team, logo: logoUrl}),
      teamId,
      side: sideForTeam(team, fixture) || reference.side || null,
      player: player || null,
      playerId,
      photo: photoUrl,
      photoUrl,
      logoUrl,
      resolved,
    };
  }
  function appendPredictionReason(entries, value) {
    const reason = String(value || '').trim();
    if (!reason) return;
    if (!entries.length) {
      entries.push({type: 'text', reason});
      return;
    }
    const last = entries.at(-1);
    last.reason = [last.reason, reason].filter(Boolean).join('\n\n');
  }
  function parsePredictionEntries(value, fixture, players = []) {
    const entries = [];
    const latin = "(?:[A-Z]\\.|[\\p{Script=Latin}\\p{M}’'\\-]+)(?:\\s+(?:[A-Z]\\.|[\\p{Script=Latin}\\p{M}’'\\-]+)){0,5}";
    const kana = '[ァ-ヶー・]{2,35}';
    const head = new RegExp("^(" + latin + "|" + kana + ")(\\s*[（(][^）)\\n]*[）)])?(?:\\s*(?:[—–]\\s*|-\\s+|[。.!?！？:：]\\s*|$))(.*)$", 'u');
    String(value || '').replace(/\r\n?/g, '\n').replace(/\*\*/g, '').split('\n').forEach((line) => {
      const isHeading = /^\s*#{1,6}\s+/u.test(line);
      const clean = line.replace(/^\s*(?:[-*]|#{1,6})\s+/, '').trim();
      if (!clean || isHeading) return;
      const prefix = clean.match(/^([^:：｜|\n]{2,80})\s*(?:[:：｜|])\s*(.*)$/u);
      // A parenthetical on the left of a colon belongs to the player form
      // "Name (Club)：reason", not to a club label. In particular, the
      // safe partial club matcher must not mistake that whole string for a
      // team merely because it contains "Levante" or "Barcelona".
      const team = prefix && !/[（(]/u.test(prefix[1]) && teamForLabel(prefix[1], fixture);
      const match = (team ? prefix[2] : clean).match(head);
      if (!match) {
        appendPredictionReason(entries, clean);
        return;
      }
      const inlineClubLabel = match[2]?.replace(/^\s*[（(]\s*|\s*[）)]\s*$/g, '').trim() || '';
      const inlineTeam = inlineClubLabel ? teamForLabel(inlineClubLabel, fixture) : null;
      const playerName = match[1].trim();
      const isKnownPlayer = players.some((entry) => samePlayerName((entry?.player || entry)?.name, playerName));
      // A club label, an inline fixture club, or an exact provider-name match
      // is required. This makes unresolved prose stay prose instead of
      // attaching a portrait to an unrelated person.
      if (!team && !inlineTeam && !isKnownPlayer) {
        appendPredictionReason(entries, clean);
        return;
      }
      entries.push(resolvePredictionReference({
        clubLabel: team ? prefix[1].trim() : inlineTeam ? inlineClubLabel : '',
        clubName: (team || inlineTeam)?.name || '',
        playerName,
        reason: [inlineTeam ? '' : match[2]?.trim(), match[3]?.trim()].filter(Boolean).join('\n\n'),
      }, fixture, players));
    });
    return entries.map((entry) => ({...entry, reason: String(entry.reason || '').trim()}));
  }
  function normalizedPredictionEntries(value, fixture, players = []) {
    if (!Array.isArray(value)) return parsePredictionEntries(value, fixture, players);
    return value.map((entry) => entry?.type === 'text'
      ? {type: 'text', reason: String(entry.reason || '').trim()}
      : resolvePredictionReference(entry || {}, fixture, players));
  }
  function displayPredictionEntries(value, fixture, players = []) {
    const usedSides = new Set();
    return normalizedPredictionEntries(value, fixture, players).map((entry) => {
      if (entry.type !== 'player') return entry;
      if (entry.side && !usedSides.has(entry.side)) {
        usedSides.add(entry.side);
        return entry;
      }
      // Preserve excess authoring copy as prose, while guaranteeing no more
      // than one home and one away portrait card.
      const label = [entry.clubName || entry.clubLabel, entry.playerName].filter(Boolean).join('：');
      return {type: 'text', reason: [label, entry.reason].filter(Boolean).join('\n')};
    });
  }
  function normalizePredictionCards(value, fixture, players = []) {
    return displayPredictionEntries(value, fixture, players).filter((entry) => entry.type === 'player');
  }
  function predictionCardKey(reference) {
    return [reference?.side || '', numericId(reference?.teamId) || '', nameKey(reference?.playerName)].join('|');
  }
  function mergePredictionCards(value, retained, fixture, players = []) {
    const prior = new Map(normalizePredictionCards(retained, fixture, players)
      .map((card) => [predictionCardKey(card), card]));
    return normalizePredictionCards(value, fixture, players).map((card) => {
      const saved = prior.get(predictionCardKey(card));
      if (!saved?.resolved || card.resolved) return card;
      return resolvePredictionReference({...card, ...saved, reason: card.reason || saved.reason}, fixture, players);
    });
  }
  function splitEntries(value, fixture, players = []) {
    return parsePredictionEntries(value, fixture, players);
  }
  const references = (value,fixture,players=[]) => parsePredictionEntries(value,fixture,players).filter(e=>e.type==='player');
  const paragraphs = value => String(value || '').split(/\n\s*\n+/).filter(s=>s.trim()).map(s=>`<p class="match-player-reason">${escape(s.trim()).replace(/\n/g,'<br>')}</p>`).join('');
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
  const motmSentences = value => String(value || '').replace(/\*\*/g,'').split(/\n+/)
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
  const visibleMotmCopy = value => String(value || '').split(/\n\s*\n+/)
    .map(block => motmSentences(block).filter(sentence => !isInternalMotmCopy(sentence)).join(' '))
    .filter(Boolean).join('\n\n').trim();
  const uniqueParagraphs = values => {
    const seen = new Set();
    return values.filter(value => {
      const key = value.replace(/\s+/g,' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  function renderCard(reference, {motm=false,label=''} = {}) {
    const team = reference.team;
    const logo = safeImage(team?.logo);
    const photo = safeImage(reference.photo);
    const name = reference.playerName;
    const playerId = numericId(reference.playerId || reference.player?.id);
    const teamId = numericId(reference.teamId || team?.id);
    const playerHref = playerId ? `/players/${playerId}` : '';
    const teamHref = teamId ? `/teams/${teamId}` : '';
    const initials = name.split(/\s+/).slice(0,2).map(p=>p[0]).join('').toUpperCase();
    const portrait = `<span class="match-player-portrait" aria-hidden="true">${escape(initials)}${photo?`<img src="${escape(photo)}" alt="" width="64" height="64" loading="eager" decoding="async">`:''}</span>`;
    const identity = playerHref ? `<a class="match-player-link match-player-link--portrait" href="${playerHref}" aria-label="${escape(`${name}の選手詳細`)}">${portrait}</a>` : portrait;
    const playerName = playerHref ? `<a class="match-player-link" href="${playerHref}"><h4 class="match-player-name">${escape(name)}</h4></a>` : `<h4 class="match-player-name">${escape(name)}</h4>`;
    const teamIdentity = team ? `${teamHref ? `<a class="match-player-team" href="${teamHref}">` : '<span class="match-player-team">'}${logo?`<img src="${escape(logo)}" alt="" width="24" height="24" loading="eager" decoding="async">`:''}<span>${escape(team.name)}</span>${teamHref ? '</a>' : '</span>'}` : '';
    const data = [
      `data-player-name="${escape(name)}"`,
      playerId ? `data-player-id="${playerId}"` : '',
      teamId ? `data-team-id="${teamId}"` : '',
      photo ? `data-player-photo-url="${escape(photo)}"` : '',
    ].filter(Boolean).join(' ');
    return `<section class="match-player-card${motm?' match-player-card--motm':''}" ${data}><div class="match-player-header">${identity}<div class="match-player-copy">${label?`<span class="match-player-label">${escape(label)}</span>`:''}${playerName}${teamIdentity}</div></div>${paragraphs(reference.reason)}</section>`;
  }
  function renderPrediction(value,fixture,players=[]) {
    return displayPredictionEntries(value,fixture,players).map(e=>e.type==='player'?renderCard(e):paragraphs(e.reason)).join('');
  }
  function motmReference(value,selection,fixture,players=[]) {
    const lines=String(value || '').replace(/\*\*/g,'').split('\n');
    const index=lines.findIndex(l=>/MOTM|POTM|(?:Man|Player) of the Match/iu.test(l) && l.includes(selection.name));
    const awardLine=index>=0?lines[index]:'';
    const clubLabels=[...awardLine.matchAll(/[（(]([^）)]+)[）)]/g)].map(m=>m[1]);
    const clubLabel=clubLabels.find(l=>teamForLabel(l,fixture)) || '';
    const before=index>=0?lines.slice(0,index).join('\n').trim():'';
    if(index>=0) {
      const end=awardLine.indexOf(selection.name)+selection.name.length;
      lines[index]=awardLine.slice(end).replace(/^\s*[（(][^）)]*[）)]\s*/,'').replace(/^\s*[。:：]\s*/,'').trim();
    }
    const body=(index>=0?lines.slice(index):lines).join('\n').trim();
    const separated=body
      // Preserve a contextual paragraph even if an upstream formatter has
      // collapsed its leading line break.
      .replace(/([。！？!?])\s*((?:ほか(?:では|にも)?|他では|他の(?:選手|注目)|その他|一方[、,]|Others?\b|Elsewhere\b))/giu, '$1\n\n$2')
      .replace(/\n([^\n]+)/g, (full,line) => references(line,fixture,players).length || /^(?:ほか|他では|その他|Others?\b|Elsewhere\b)/iu.test(line.trim()) ? `\n\n${line}` : full);
    const blocks=separated.split(/\n\s*\n+/).filter(Boolean);
    const reasons=[],remaining=before?[before]:[];
    const hasDedicatedSelectionReason=Boolean(visibleMotmCopy(selection.reason));
    let other=false;
    for(const paragraph of blocks) {
      const named=references(paragraph,fixture,players)[0];
      if (/^(?:ほか(?:では|にも)?|他では|他の(?:選手|注目)|その他|一方[、,]|Others?\b|Elsewhere\b)/iu.test(paragraph)
        || (named && !samePlayerName(named.playerName,selection.name))) other=true;
      (other || ((hasDedicatedSelectionReason || selection.basis === 'data') && !named) ? remaining : reasons).push(paragraph);
    }
    const reason=uniqueParagraphs([selection.criteria,selection.reason,reasons.join('\n\n')]
      .map(visibleMotmCopy).filter(Boolean)).join('\n\n') || DEFAULT_MOTM_CRITERIA;
    const visibleRemaining=uniqueParagraphs(remaining.map(visibleMotmCopy).filter(Boolean))
      .filter(paragraph=>paragraph.trim()!==reason.trim()).join('\n\n');
    return {...resolveReference({playerName:selection.name,clubLabel,reason},fixture,[...players,...(selection.player?[selection.player]:[])]),remaining:visibleRemaining};
  }
  function renderMotm(reference,options={}) {
    return renderCard(reference,{...options,motm:true}) + (reference.remaining ? `<div class="match-player-context">${paragraphs(reference.remaining)}</div>` : '');
  }
  function photoSearchName(name) { return nameKey(name).split(' ').at(-1) || ''; }
  return {references,splitEntries,parsePredictionEntries,samePlayerName,photoSearchName,participants,resolveReference,resolvePredictionReference,normalizePredictionCards,mergePredictionCards,renderCard,renderPrediction,renderMotm,motmReference,teamForLabel,teamForId,visibleMotmCopy};
});
