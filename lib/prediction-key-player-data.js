import playerCards from '../prediction-key-players.js';
import { apiFootballFetch } from './api-football-client.js';

const SQUAD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const squadReads = new Map();

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function teamForId(fixture, value) {
  const id = numericId(value);
  if (!id) return null;
  return [fixture?.home, fixture?.away].find((team) => numericId(team?.id) === id) || null;
}

function providerPlayers(data, team) {
  // API-Football reports provider failures (including rate limits) in an HTTP
  // 200 payload. Do not cache those as an empty squad for six hours: a later
  // request must be able to retry and retain an already verified card.
  if (data?.errors && Object.keys(data.errors).length) return null;
  return (data?.response?.[0]?.players || []).map((player) => ({
    id: numericId(player?.id),
    name: String(player?.name || '').trim(),
    photo: player?.photo || null,
    team,
  })).filter((player) => player.id && player.name);
}

// Shared by the report MOTM mirror as well as prediction cards.  It is still
// a bounded, verified provider lookup; callers must already know the fixture
// team and must never use this to search a name across arbitrary clubs.
export async function readTeamSquad(team, fetcher = apiFootballFetch) {
  const id = numericId(team?.id);
  if (!id) return [];
  const now = Date.now();
  const cached = squadReads.get(id);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = Promise.resolve(fetcher('/players/squads', { team: id }, {
    retries: 0,
    timeoutMs: 6000,
  })).then((data) => {
    const players = providerPlayers(data, team);
    if (players == null) throw new Error('API-Football squad response was unavailable');
    return players;
  });
  squadReads.set(id, { expiresAt: now + SQUAD_CACHE_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    if (squadReads.get(id)?.value === value) squadReads.delete(id);
    throw error;
  }
}

function sourceCards(prediction = {}) {
  return Array.isArray(prediction.keyPlayerCards) && prediction.keyPlayerCards.length
    ? prediction.keyPlayerCards
    : prediction.keyPlayers || '';
}

// A sidecar is intentionally separate from the full Notion mirror so a
// rendering request can cache verified provider media without ever writing an
// older article body or publication state back over an editor update.
export function applyStoredPredictionKeyPlayerCards(article, fixture, storedCards = []) {
  const prediction = article?.prediction;
  if (!prediction || !fixture?.home || !fixture?.away) return article;
  const source = prediction.keyPlayers || prediction.keyPlayerCards || '';
  const retained = [
    ...(Array.isArray(prediction.keyPlayerCards) ? prediction.keyPlayerCards : []),
    ...(Array.isArray(storedCards) ? storedCards : []),
  ];
  if (!source || !retained.length) return article;
  return {
    ...article,
    prediction: {
      ...prediction,
      keyPlayerCards: playerCards.mergePredictionCards(source, retained, fixture),
    },
  };
}

// This is deliberately a maximum-two-player path: one home and one away key
// player. It never shares the expensive predicted-lineup retrieval used by the
// lineup panel, and failures leave the authored prose intact.
export async function hydratePredictionKeyPlayers(article, fixture, { fetcher = apiFootballFetch } = {}) {
  const prediction = article?.prediction;
  const source = sourceCards(prediction);
  if (!prediction || !source || !fixture?.home || !fixture?.away) return article;

  const retained = Array.isArray(prediction.keyPlayerCards) ? prediction.keyPlayerCards : [];
  let cards = playerCards.mergePredictionCards(source, retained, fixture);
  const missingTeams = [...new Set(cards.filter((card) => !card.resolved)
    .map((card) => numericId(card.teamId))
    .filter(Boolean))]
    .map((id) => teamForId(fixture, id))
    .filter(Boolean);

  if (missingTeams.length) {
    const settled = await Promise.allSettled(missingTeams.map((team) => readTeamSquad(team, fetcher)));
    const players = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    cards = playerCards.mergePredictionCards(source, retained, fixture, players);
  }

  return {
    ...article,
    prediction: {
      ...prediction,
      keyPlayerCards: cards,
    },
  };
}

export async function hydratePredictionEditorials(editorials = {}, fixture, options = {}) {
  if (!editorials?.prediction) return editorials;
  return {
    ...editorials,
    prediction: await hydratePredictionKeyPlayers(editorials.prediction, fixture, options),
  };
}

export function clearPredictionKeyPlayerDataCache() {
  squadReads.clear();
}
