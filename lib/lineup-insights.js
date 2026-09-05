// Server-only: bounded, coalesced provider reads. No credentials enter the payload.
import { apiFootballFetch } from './api-football-client.js';
const cache = new Map();
const valid = data => data && (!data.errors || Object.keys(data.errors).length === 0) && Array.isArray(data.response);
export function createCachedReader(fetcher = apiFootballFetch, store = cache, clock = Date.now) {
  return async (path, params, ttl = 900000) => {
    const key = path + JSON.stringify(params), existing = store.get(key);
    if (existing && existing.until > clock()) return existing.value;
    const value = fetcher(path, params, {timeoutMs: 6000, retries: 0}).then(data => {
      if (!valid(data)) throw new Error('Provider section unavailable');
      return data.response;
    });
    store.set(key, {until: clock() + ttl, value});
    // Bound warm-instance memory; errors are not cached.
    if (store.size > 300) store.delete(store.keys().next().value);
    try { return await value; } catch (error) { if (store.get(key)?.value === value) store.delete(key); throw error; }
  };
}
const read = createCachedReader();
const safe = async promise => { try { return await promise; } catch { return null; } };
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function playerStats(entries) {
  return (entries || []).flatMap(team => (team.players || []).map(entry => {
    const stats = entry.statistics?.[0] || {};
    return {id: entry.player?.id, teamId: team.team?.id, name: entry.player?.name, photo: entry.player?.photo,
      rating: number(stats.games?.rating), minutes: number(stats.games?.minutes), goals: number(stats.goals?.total), assists: number(stats.goals?.assists)};
  }));
}
const normalize = entry => { const p = entry.player || entry; return {id:p.id,name:p.name,number:p.number ?? null,position:p.pos || p.position || null,grid:p.grid || null,photo:p.photo || null}; };
const position = p => ({Goalkeeper:'G',Defender:'D',Midfielder:'M',Attacker:'F'}[p.position] || p.position);
export function predictTeam({team, histories = [], squad, injuries, minutes = [], kickoff, updatedAt}) {
  const recent = histories.filter(h => h?.lineup?.startXI?.length && Date.parse(h.date) < Date.parse(kickoff)).sort((a,b) => Date.parse(b.date)-Date.parse(a.date));
  const template = recent[0]?.lineup;
  const missing = (injuries || []).filter(e => Number(e.team?.id) === Number(team.id));
  const absences = missing.map(e => ({...normalize(e), reason: e.player?.reason || null, status: e.player?.type === 'Missing Fixture' ? 'out' : 'doubtful'}));
  const excluded = new Set(absences.filter(p => p.status === 'out').map(p => p.id));
  const doubtful = new Set(absences.filter(p => p.status === 'doubtful').map(p => p.id));
  const roster = squad?.flatMap(entry => entry.team?.id === team.id ? entry.players || [] : []) ?? null;
  const rosterIds = roster ? new Set(roster.map(p => p.id)) : null;
  const candidates = new Map();
  recent.forEach((h, i) => {
    [...h.lineup.startXI.map(p => ({...normalize(p),starter:true})), ...(h.lineup.substitutes || []).map(normalize)].forEach(p => {
      if (!p.id || excluded.has(p.id) || (rosterIds && !rosterIds.has(p.id))) return;
      const prior = candidates.get(p.id);
      const played = minutes.find(m => m.id === p.id)?.minutes || 0;
      const restDays = (Date.parse(kickoff) - Date.parse(recent[0].date)) / 86400000;
      const score = (prior?.score || 0) + (p.starter ? (3-i)*10 : 1) + (i === 0 ? played/30 : 0) - (!prior && doubtful.has(p.id) ? 20 : 0) - (i === 0 && restDays < 4 && played >= 80 ? 4 : 0);
      candidates.set(p.id, {...p,...prior,score});
    });
  });
  const used = new Set(), slots = (template?.startXI || []).map(normalize), startXI = [];
  const selected = new Map();
  for (const role of new Set(slots.map(position))) {
    const count = slots.filter(p => position(p) === role).length;
    [...candidates.values()].filter(p => position(p) === role).sort((a,b) => b.score-a.score || a.id-b.id).slice(0,count).forEach(p => selected.set(p.id,p));
  }
  // Preserve each returning starter's exact historical grid before allocating replacements.
  const assigned = new Map();
  slots.forEach(slot => { if (selected.has(slot.id)) { assigned.set(slot,selected.get(slot.id)); used.add(slot.id); } });
  slots.forEach(slot => {
    if (assigned.has(slot)) return;
    const p = [...selected.values()].filter(p => !used.has(p.id) && position(p) === position(slot)).sort((a,b) => Number(b.grid === slot.grid)-Number(a.grid === slot.grid) || b.score-a.score)[0];
    if (p) {assigned.set(slot,p);used.add(p.id);}
  });
  slots.forEach(slot => {
    const chosen = assigned.get(slot); if (!chosen) return;
    const {score,starter,...player} = chosen;
    startXI.push({...player,grid:slot.grid,uncertain:doubtful.has(player.id),roleUncertain:player.id !== slot.id && player.grid !== slot.grid});
  });
  return {team, formation: template?.formation || null, coach: template?.coach || {}, startXI,
    substitutes: [...candidates.values()].filter(p => !used.has(p.id)).map(({score,starter,...p}) => p), predicted:true, estimatedPositions:true,
    updatedAt, absences, evidence: {fixtures:recent.map(h => ({id:h.id,date:h.date})), roster:roster ? 'available' : 'unavailable', injuries: injuries == null ? 'unavailable' : 'available', suspensionVerification:'provider-fixture-only', minutes:minutes.length > 0, restDays:recent[0] ? Math.round((Date.parse(kickoff)-Date.parse(recent[0].date))/86400000*10)/10 : null}};
}
export async function getLineupInsights(fixture, reader = read) {
  const id = fixture.id, updatedAt = new Date().toISOString();
  const upcoming = ['NS','TBD'].includes(fixture.status);
  const official = await safe(reader('/fixtures/lineups', {fixture:id}, upcoming ? 60000 : 300000));
  const confirmed = (official || []).filter(l => l.startXI?.length === 11);
  const lineups = confirmed.map(l => ({...l,startXI:l.startXI.map(normalize),substitutes:(l.substitutes || []).map(normalize),predicted:false}));
  if (!upcoming) {
    const stats = await safe(reader('/fixtures/players', {fixture:id}, 300000));
    return {fixtureId:id,lineups,players: stats == null ? null : playerStats(stats),updatedAt,errors:{official:official === null,players:stats === null},officialAvailable:official !== null};
  }
  // Only build a prediction while the provider explicitly reports a scheduled fixture.
  // Historical/squad reads are cached independently of the 60s official-lineup check.
  const injuries = confirmed.length < 2 ? await safe(reader('/injuries', {fixture:id}, 300000)) : [];
  for (const team of [fixture.home,fixture.away]) {
    if (confirmed.some(l => l.team?.id === team.id)) continue;
    const [games,squad] = await Promise.all([
      safe(reader('/fixtures', {team:team.id,last:3}, 1800000)),
      safe(reader('/players/squads', {team:team.id}, 900000))
    ]);
    const recent = (games || []).filter(g => ['FT','AET','PEN'].includes(g.fixture?.status?.short) && Date.parse(g.fixture?.date) < Date.parse(fixture.kickoff) && Date.parse(g.fixture?.date) > Date.parse(fixture.kickoff)-45*86400000).sort((a,b) => Date.parse(b.fixture.date)-Date.parse(a.fixture.date)).slice(0,3);
    const histories = await Promise.all(recent.map(async g => ({id:g.fixture.id,date:g.fixture.date,lineup:(await safe(reader('/fixtures/lineups',{fixture:g.fixture.id},86400000)))?.find(l => l.team?.id === team.id)})));
    const minuteData = recent[0] ? await safe(reader('/fixtures/players',{fixture:recent[0].fixture.id},86400000)) : null;
    lineups.push(predictTeam({team,histories,squad,injuries,minutes:playerStats(minuteData).filter(p => p.teamId === team.id),kickoff:fixture.kickoff,updatedAt}));
  }
  return {fixtureId:id,lineups,players:null,updatedAt,errors:{official:official === null},officialAvailable:official !== null};
}
