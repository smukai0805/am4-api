import { isPublicArticle } from './article-visibility.js';

// Keep the public response deliberately small: fixture IDs and the editorial
// kinds that are actually published. Callers must supply already-validated IDs.
export function matchContentAvailability(entries, fixtureIds) {
  const requestedIds = [...new Set(fixtureIds.map(Number))];
  const availability = Object.fromEntries(requestedIds.map((fixtureId) => [fixtureId, []]));
  const contentType = {
    match_prediction: 'prediction',
    match_report: 'report',
  };

  for (const entry of entries) {
    const fixtureId = Number(entry.match?.fixtureId);
    const type = contentType[entry.type];
    if (!type || !Object.hasOwn(availability, fixtureId) || !isPublicArticle(entry)) continue;
    if (!availability[fixtureId].includes(type)) availability[fixtureId].push(type);
  }
  return availability;
}
