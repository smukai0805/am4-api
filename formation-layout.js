(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4Formation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function rows(lineup, reverse = false) {
    const groups = new Map(), unplaced = [], occupied = new Set();
    (lineup.startXI || []).forEach(player => {
      const match = /^([1-9]\d*):([1-9]\d*)$/.exec(player.grid || '');
      if (!match || Number(match[1]) > 6 || Number(match[2]) > 6 || occupied.has(player.grid)) { unplaced.push(player); return; }
      occupied.add(player.grid);
      const row = Number(match[1]), col = Number(match[2]);
      groups.set(row, [...(groups.get(row) || []), { player, col }]);
    });
    const placed = [...groups].sort((a,b) => a[0]-b[0]).map(([row, members]) => ({row, players: members.sort((a,b) => a.col-b.col).map(m => m.player)}));
    if (reverse) { placed.reverse(); placed.forEach(row => row.players.reverse()); }
    return { rows: placed, unplaced };
  }
  function contributions(id, events = []) {
    const result = { goals: 0, assists: 0, yellow: 0, red: 0, changes: [], details: [] };
    events.forEach(e => {
      const isPlayer = e.player?.id != null && String(e.player.id) === String(id);
      const isAssist = e.assist?.id != null && String(e.assist.id) === String(id);
      if (isPlayer && ['goal','penalty'].includes(e.type)) result.goals++;
      if (isAssist && ['goal','penalty'].includes(e.type)) result.assists++;
      if (isPlayer && e.type === 'yellow_card') result.yellow++;
      if (isPlayer && e.type === 'red_card') result.red++;
      if (e.type === 'substitution' && (isPlayer || isAssist)) result.changes.push({direction: isPlayer ? 'OUT' : 'IN', minute: e.minute, other: isPlayer ? e.assist : e.player});
      if (isPlayer || isAssist) result.details.push(e);
    });
    return result;
  }
  return { rows, contributions };
});
