// Structured, verified MOTM media for the server-rendered match page.  The
// authored report remains the only source for the selected person and their
// rationale; API-Football is used solely to resolve an already selected name
// to a unique player/team ID and official media URL.

import playerCards from '../prediction-key-players.js';
import reportPresentation from '../match-report-presentation.js';
import { apiFootballFetch } from './api-football-client.js';
import { readTeamSquad } from './prediction-key-player-data.js';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function fixtureTeam(fixture, teamId) {
  const id = positiveId(teamId);
  return [fixture?.home, fixture?.away].find((team) => positiveId(team?.id) === id) || null;
}

function sideForTeam(fixture, teamId) {
  const id = positiveId(teamId);
  if (id && id === positiveId(fixture?.home?.id)) return 'home';
  if (id && id === positiveId(fixture?.away?.id)) return 'away';
  return null;
}

// Keep the monitor's definition of a selected MOTM exactly aligned with the
// hydrator.  A passing mention of "MOTM" (including an abstention) is not an
// editorial selection and must never create a false media-repair job.
export function selectedMatchReportMotm(article) {
  const keyFigures = String(article?.report?.keyFigures || '').trim();
  if (!keyFigures) return null;
  return reportPresentation.selectedMotm(keyFigures, [])
    || reportPresentation.editorialAm4Motm(article?.id, keyFigures, []);
}

function cleanReportWithCard(article, card) {
  const report = { ...(article?.report || {}) };
  if (card) report.motmCard = card;
  else delete report.motmCard;
  return { ...article, report };
}

export function verifiedMotmCard(card, fixture) {
  const playerId = positiveId(card?.playerId);
  const teamId = positiveId(card?.teamId);
  const team = fixtureTeam(fixture, teamId);
  const photoUrl = safeHttps(card?.photoUrl || card?.photo);
  const logoUrl = safeHttps(card?.logoUrl);
  const playerName = String(card?.playerName || '').trim();
  const reason = String(card?.reason || '').trim();
  if (!card?.resolved || !playerId || !team || !photoUrl || !logoUrl || !playerName || !reason) return null;
  return {
    playerName,
    playerId,
    teamId,
    side: sideForTeam(fixture, teamId),
    clubName: String(team.name || '').trim(),
    clubLabel: String(card.clubLabel || team.name || '').trim(),
    photoUrl,
    logoUrl,
    reason,
    remaining: String(card?.remaining || '').trim(),
    resolved: true,
  };
}

// `renderMotm` expects the same card shape used by the shared browser helper.
// Resolve the team from the current fixture so a stale stored club name cannot
// leak across a rematch or transfer.
export function motmCardReference(card, fixture) {
  const verified = verifiedMotmCard(card, fixture);
  if (!verified) return null;
  const team = fixtureTeam(fixture, verified.teamId);
  return {
    ...verified,
    photo: verified.photoUrl,
    team: { ...team, logo: verified.logoUrl },
    player: { id: verified.playerId, name: verified.playerName, photo: verified.photoUrl, team },
  };
}

function providerLineupPlayers(data, fixture) {
  if (data?.errors && Object.keys(data.errors).length) throw new Error('API-Football lineup response was unavailable');
  const players = [];
  for (const lineup of Array.isArray(data?.response) ? data.response : []) {
    const team = fixtureTeam(fixture, lineup?.team?.id);
    if (!team) continue;
    for (const item of [...(lineup?.startXI || []), ...(lineup?.substitutes || [])]) {
      const player = item?.player || {};
      const id = positiveId(player.id);
      const name = String(player.name || '').trim();
      if (!id || !name) continue;
      players.push({
        id,
        name,
        photo: safeHttps(player.photo) || `https://media.api-sports.io/football/players/${id}.png`,
        team,
      });
    }
  }
  return players;
}

async function readHistoricalLineupPlayers(fixture, fetcher) {
  const id = positiveId(fixture?.id);
  if (!id) return [];
  const data = await fetcher('/fixtures/lineups', { fixture: id }, { retries: 0, timeoutMs: 6_000 });
  return providerLineupPlayers(data, fixture);
}

function referenceToCard(reference, fixture) {
  const playerId = positiveId(reference?.player?.id || reference?.playerId);
  const teamId = positiveId(reference?.team?.id || reference?.teamId);
  const team = fixtureTeam(fixture, teamId);
  const photoUrl = safeHttps(reference?.photo || reference?.photoUrl);
  const logoUrl = safeHttps(reference?.team?.logo || reference?.logoUrl)
    || (teamId ? `https://media.api-sports.io/football/teams/${teamId}.png` : null);
  const playerName = String(reference?.playerName || reference?.player?.name || '').trim();
  const reason = String(reference?.reason || '').trim();
  if (!playerId || !team || !photoUrl || !logoUrl || !playerName || !reason) return null;
  return {
    playerName,
    playerId,
    teamId,
    side: sideForTeam(fixture, teamId),
    clubName: String(team.name || '').trim(),
    clubLabel: String(reference.clubLabel || team.name || '').trim(),
    photoUrl,
    logoUrl,
    reason,
    remaining: String(reference.remaining || '').trim(),
    resolved: true,
  };
}

function exactPersonName(left, right) {
  const normalise = (value) => String(value || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øð]/g, (letter) => ({ ø: 'o', ð: 'd' })[letter])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const a = normalise(left);
  const b = normalise(right);
  return Boolean(a && b && a === b);
}

function retainedCardForSameVerifiedPerson(existing, authoredReference, selection, fixture) {
  const verified = verifiedMotmCard(existing, fixture);
  const authoredTeamId = positiveId(authoredReference?.team?.id || authoredReference?.teamId);
  // Never reuse a stored ID based on a surname/initials alone. The report must
  // still explicitly anchor the very same full name to the very same fixture
  // club while the provider is unavailable.
  if (!verified || !authoredTeamId || verified.teamId !== authoredTeamId || !exactPersonName(verified.playerName, selection?.name)) return null;
  const reason = String(authoredReference?.reason || '').trim();
  if (!reason) return null;
  const team = fixtureTeam(fixture, verified.teamId);
  if (!team) return null;
  return {
    ...verified,
    playerName: String(selection.name).trim(),
    side: sideForTeam(fixture, verified.teamId),
    clubName: String(team.name || '').trim(),
    clubLabel: String(authoredReference.clubLabel || team.name || '').trim(),
    // The authored current report remains the source of truth for display
    // text even if only the verified image identity is being retained.
    reason,
    remaining: String(authoredReference.remaining || '').trim(),
  };
}

// This deliberately does not call `dataAm4Motm`: monitor repair may restore a
// portrait for an authored/previously selected person, but must not make a new
// award choice from provider statistics.
export async function hydrateMatchReportMotm(article, fixture, {
  fetcher = apiFootballFetch,
  squadReader = readTeamSquad,
  lineupReader = readHistoricalLineupPlayers,
} = {}) {
  if (article?.type !== 'match_report' || !fixture?.home || !fixture?.away) return article;
  const selection = selectedMatchReportMotm(article);
  const existing = verifiedMotmCard(article?.report?.motmCard, fixture);
  if (!selection) return cleanReportWithCard(article, null);

  const keyFigures = reportPresentation.withoutMotmAbstention(article?.report?.keyFigures || '');
  // Parse the report before provider access so an outage can retain only an
  // already verified identity, while still using the freshly authored reason.
  const authoredReference = playerCards.motmReference(keyFigures, selection, fixture, []);
  let players = [];
  try {
    const settled = await Promise.allSettled([
      squadReader(fixture.home, fetcher),
      squadReader(fixture.away, fetcher),
    ]);
    players = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  } catch { /* A verified same-person card below remains a valid fallback. */ }

  let reference = playerCards.motmReference(keyFigures, selection, fixture, players);
  if (!reference?.player && positiveId(fixture.id)) {
    try {
      const historical = await lineupReader(fixture, fetcher);
      reference = playerCards.motmReference(keyFigures, selection, fixture, [...players, ...historical]);
    } catch { /* A verified same-person card below remains a valid fallback. */ }
  }
  const card = referenceToCard(reference, fixture);
  if (card) return cleanReportWithCard(article, card);
  // An empty-but-successful squad/lineup response is inconclusive, not proof
  // that a previously verified identity became incorrect. Preserve a card
  // only when the current authored selection still names that exact person at
  // that exact fixture team. A changed or unanchored selection still clears it
  // so another player can never inherit a portrait.
  const retained = retainedCardForSameVerifiedPerson(existing, authoredReference, selection, fixture);
  if (retained) return cleanReportWithCard(article, retained);
  return cleanReportWithCard(article, null);
}
