import { isPublicArticle } from './article-visibility.js';
import matchArchive from '../match-archive.js';

const CONTENT_TYPE = {
  match_prediction: 'prediction',
  match_report: 'report',
};

function publicContentType(entry) {
  const type = CONTENT_TYPE[entry?.type];
  return type && isPublicArticle(entry) ? type : null;
}

// Keep the public response deliberately small: fixture IDs and the editorial
// kinds that are actually published. Callers must supply already-validated IDs.
export function matchContentAvailability(entries, fixtureIds) {
  const requestedIds = [...new Set(fixtureIds.map(Number))];
  const availability = Object.fromEntries(requestedIds.map((fixtureId) => [fixtureId, []]));

  for (const entry of entries) {
    const fixtureId = Number(entry.match?.fixtureId);
    const type = publicContentType(entry);
    if (!type || !Object.hasOwn(availability, fixtureId)) continue;
    if (!availability[fixtureId].includes(type)) availability[fixtureId].push(type);
  }
  return availability;
}

// Legacy public editorials can predate a stable provider fixture ID. The match
// key is only used after canonicalising the full competition/date/home/away
// identity, so different seasons or fixtures cannot share availability.
export function matchContentAvailabilityByMatchKey(entries, matchKeys) {
  const requestedKeys = [...new Set((matchKeys || [])
    .map((matchKey) => matchArchive.canonicalMatchKey(matchKey))
    .filter(Boolean))];
  const availability = Object.fromEntries(requestedKeys.map((matchKey) => [matchKey, []]));

  for (const entry of entries) {
    const type = publicContentType(entry);
    const matchKey = matchArchive.canonicalMatchKey(entry?.match);
    const fixtureId = Number(entry?.match?.fixtureId);
    // A stored provider fixture ID remains authoritative. Only old records
    // without one can be recovered through the Match Key fallback.
    if (!type || !matchKey || (Number.isInteger(fixtureId) && fixtureId > 0) || !Object.hasOwn(availability, matchKey)) continue;
    if (!availability[matchKey].includes(type)) availability[matchKey].push(type);
  }
  return availability;
}
