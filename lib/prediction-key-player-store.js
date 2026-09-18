import './blob-environment.js';
import { get, put } from '@vercel/blob';

const PATH_PREFIX = 'match-prediction-key-players/';

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pathname(articleId) {
  const id = String(articleId || '').trim();
  return id ? PATH_PREFIX + encodeURIComponent(id) + '.json' : null;
}

export function verifiedPredictionKeyPlayerCards(cards) {
  return (Array.isArray(cards) ? cards : []).map((card) => {
    const playerId = numericId(card?.playerId);
    const teamId = numericId(card?.teamId);
    const photoUrl = safeHttpsUrl(card?.photoUrl || card?.photo);
    const logoUrl = safeHttpsUrl(card?.logoUrl || card?.team?.logo);
    if (!card?.resolved || !playerId || !teamId || !photoUrl || !logoUrl) return null;
    return {
      playerName: String(card.playerName || '').trim(),
      clubName: String(card.clubName || '').trim(),
      clubLabel: String(card.clubLabel || '').trim(),
      teamId,
      side: card.side === 'home' || card.side === 'away' ? card.side : null,
      playerId,
      photoUrl,
      logoUrl,
      resolved: true,
    };
  }).filter((card) => card?.playerName);
}

export function changedVerifiedPredictionKeyPlayerCards(article, storedCards = []) {
  const next = verifiedPredictionKeyPlayerCards(article?.prediction?.keyPlayerCards);
  if (!next.length) return false;
  const stored = verifiedPredictionKeyPlayerCards(storedCards);
  return JSON.stringify(next) !== JSON.stringify(stored);
}

export function shouldClearVerifiedPredictionKeyPlayerCards(article, storedCards = []) {
  const cards = verifiedPredictionKeyPlayerCards(article?.prediction?.keyPlayerCards);
  const hasAuthoredCards = Boolean(
    String(article?.prediction?.keyPlayers || '').trim()
    || (Array.isArray(article?.prediction?.keyPlayerCards) && article.prediction.keyPlayerCards.length),
  );
  return !cards.length && !hasAuthoredCards && verifiedPredictionKeyPlayerCards(storedCards).length > 0;
}

export async function readVerifiedPredictionKeyPlayerCards(articleId) {
  const target = pathname(articleId);
  if (!target) return [];
  const result = await get(target, { access: 'private', useCache: false });
  if (!result?.stream) return [];
  const stored = JSON.parse(await new Response(result.stream).text());
  return verifiedPredictionKeyPlayerCards(stored?.cards);
}

export async function saveVerifiedPredictionKeyPlayerCards(article, storedCards = []) {
  const target = pathname(article?.id);
  const cards = verifiedPredictionKeyPlayerCards(article?.prediction?.keyPlayerCards);
  if (!target) return false;
  if (!cards.length) {
    // A removed key-player field must not leave stale media in the cache. Do
    // not clear on a transient unresolved provider read, and do not create a
    // needless tombstone when no verified sidecar existed.
    if (!shouldClearVerifiedPredictionKeyPlayerCards(article, storedCards)) return false;
    await put(target, JSON.stringify({
      version: 1,
      articleId: article.id,
      updatedAt: new Date().toISOString(),
      cards: [],
    }), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return true;
  }
  if (!changedVerifiedPredictionKeyPlayerCards(article, storedCards)) return false;
  await put(target, JSON.stringify({
    version: 1,
    articleId: article.id,
    updatedAt: new Date().toISOString(),
    cards,
  }), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  return true;
}
