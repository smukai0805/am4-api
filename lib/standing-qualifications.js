// Qualification presentation belongs to the data-normalisation layer, never
// in a React/DOM condition. API-Football's per-row description is authoritative
// when it exists. Qualification places can change across league and season,
// so an unknown season must remain unlabelled rather than being guessed.

export const STANDING_ZONE_ORDER = [
  'champions_league',
  'europa_league',
  'conference_league',
  'relegation',
];

// Add a rule only after it has been verified for that exact competition and
// season. Shape: { [competition]: { [season]: { champions_league: [[1, 4]] } } }
// Keeping this empty is deliberate: no current season allocation is guessed
// when API-Football omits its qualification description.
const FALLBACK_QUALIFICATION_RULES = Object.freeze({});

function providerZone(description, status) {
  const value = `${description || ''} ${status || ''}`.toLocaleLowerCase('en-US');
  if (!value) return null;
  if (/relegat|demot|drop zone/.test(value)) return 'relegation';
  if (/champions league|\bucl\b/.test(value)) return 'champions_league';
  if (/europa conference|conference league|\buecl\b/.test(value)) return 'conference_league';
  if (/europa league|\buel\b/.test(value)) return 'europa_league';
  return null;
}

function fallbackZone(rank, competition, season) {
  const rulesBySeason = FALLBACK_QUALIFICATION_RULES[competition];
  if (!rulesBySeason || !Number.isInteger(rank)) return null;
  const rules = rulesBySeason[String(season)];
  if (!rules) return null;
  return STANDING_ZONE_ORDER.find((zone) =>
    (rules[zone] || []).some(([start, end]) => rank >= start && rank <= end),
  ) || null;
}

export function resolveStandingZone({ rank, description, status, competition, season }) {
  const authoritative = providerZone(description, status);
  if (authoritative) return { key: authoritative, source: 'provider' };
  const fallback = fallbackZone(Number(rank), competition, Number(season));
  return fallback ? { key: fallback, source: 'fallback' } : { key: null, source: null };
}

export function standingZoneLegend(rows) {
  const zones = new Set((rows || []).map((row) => row.zone).filter(Boolean));
  return STANDING_ZONE_ORDER.filter((zone) => zones.has(zone));
}
