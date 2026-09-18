// Safe repair of a match editorial's durable fixture identity.  The monitor
// uses this after the normal Notion mirror has supplied a full article.
// Fixture ID wins. Otherwise, full identity is preferred; a uniquely matching
// ordered home/away pair in the editor day ±48-hour window is the approved
// timezone-safe final fallback. Reversed cards and multiple candidates never
// become an automatic association.

import matchArchive from '../match-archive.js';
import { apiFootballFetch, mapWithConcurrency } from './api-football-client.js';
import { getFixtureIdentity } from '../api/fixtures.js';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function dateInZone(value, timeZone) {
  const instant = Date.parse(value || '');
  if (!Number.isFinite(instant)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function fixtureDateCandidates(fixture) {
  const dates = new Set([validDate(fixture?.date)]);
  const kickoff = fixture?.kickoff;
  if (kickoff) {
    dates.add(dateInZone(kickoff, 'UTC'));
    dates.add(dateInZone(kickoff, 'Asia/Tokyo'));
    if (fixture?.timezone) dates.add(dateInZone(kickoff, fixture.timezone));
  }
  return [...dates].filter(Boolean);
}

function withinHours(left, right, hours = 48) {
  const first = Date.parse(`${validDate(left) || ''}T12:00:00.000Z`);
  const second = Date.parse(`${validDate(right) || ''}T12:00:00.000Z`);
  return Number.isFinite(first)
    && Number.isFinite(second)
    && Math.abs(first - second) <= Math.max(0, Number(hours) || 0) * 60 * 60 * 1000;
}

function dateWindow(date, hours = 48) {
  const normalized = validDate(date);
  if (!normalized) return [];
  const parsed = Date.parse(`${normalized}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return [normalized];
  const span = Math.max(0, Math.floor(Number(hours) || 0));
  const days = Math.ceil(span / 24);
  const candidates = [];
  for (let offset = -days; offset <= days; offset += 1) {
    candidates.push(new Date(parsed + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return [...new Set(candidates)];
}

// A ±48-hour identity search spans at most five calendar days.  Run a small
// bounded group rather than waiting for each day serially. `apiFootballFetch`
// still applies its process-wide request throttle, so this only overlaps
// transport latency; it never increases the provider request rate.  Keeping
// this deliberately below the full five-day window also makes injected or
// alternate fetchers respect the same conservative concurrency ceiling.
const FIXTURE_DATE_LOOKUP_CONCURRENCY = 3;

function providerFixture(value) {
  const fixture = value?.fixture || {};
  const league = value?.league || {};
  const teams = value?.teams || {};
  const id = positiveId(fixture.id);
  const homeId = positiveId(teams.home?.id);
  const awayId = positiveId(teams.away?.id);
  const homeName = String(teams.home?.name || '').trim();
  const awayName = String(teams.away?.name || '').trim();
  const competition = String(league.name || '').trim();
  if (!id || !homeId || !awayId || !homeName || !awayName || !competition) return null;
  return {
    id,
    date: validDate(fixture.date),
    kickoff: fixture.date || null,
    timezone: fixture.timezone || null,
    competition,
    home: { id: homeId, name: homeName, logo: teams.home?.logo || null },
    away: { id: awayId, name: awayName, logo: teams.away?.logo || null },
  };
}

function identityComparison(match, fixture) {
  // Once a prior safe association has supplied provider team IDs, use them as
  // an additional hard guard.  We still retain the competition and both club
  // labels because a team can play more than once inside the 48-hour window.
  const expectedHomeId = positiveId(match?.homeTeamId);
  const expectedAwayId = positiveId(match?.awayTeamId);
  if (
    (expectedHomeId && expectedHomeId !== positiveId(fixture?.home?.id))
    || (expectedAwayId && expectedAwayId !== positiveId(fixture?.away?.id))
  ) return null;
  const exact = fixtureDateCandidates(fixture)
    .map((date) => matchArchive.matchIdentityComparison(match, {
      competition: fixture.competition,
      date,
      home: fixture.home,
      away: fixture.away,
    }))
    // A persisted report describes an ordered fixture.  The archive helper
    // deliberately supports reverse-card discovery for legacy reader links,
    // but automatic fixture repair must never borrow that looser behavior.
    // Home/away must be the same orientation before an association is safe.
    .filter((comparison) => comparison?.orientation === 'direct')
    .sort((left, right) => right.score - left.score)[0] || null;
  if (exact) return { ...exact, identityTier: 'full_identity' };

  // A Notion `試合日` can be the editor's local calendar day while the
  // provider exposes the fixture under a nearby UTC/local day. After the
  // bounded ±48-hour lookup, allow the date to align to the returned fixture
  // only when the competition and both ordered club identities still match.
  // The caller requires a unique strongest candidate, so this never becomes a
  // broad name-only association.
  const articleDate = validDate(match?.date);
  const fullIdentityWithin48h = fixtureDateCandidates(fixture)
    .filter((date) => withinHours(articleDate, date, 48))
    .map((date) => {
      const comparison = matchArchive.matchIdentityComparison(
        { ...match, date },
        {
          competition: fixture.competition,
          date,
          home: fixture.home,
          away: fixture.away,
        },
      );
      return comparison?.orientation === 'direct' ? {
        ...comparison,
        method: `${comparison.method}_within_48h`,
        // Prefer an exact calendar match if one exists while still treating a
        // fully identified ±48-hour pair as stronger than fuzzy labels.
        score: Math.max(60, comparison.score - 5),
        identityTier: 'full_identity',
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)[0] || null;
  if (fullIdentityWithin48h) return fullIdentityWithin48h;

  // The Notion date is frequently authored in Japan while the provider
  // fixture is indexed in stadium-local or UTC time. When competition labels
  // are missing or differ, a *unique* ordered home/away pair inside the
  // same ±48-hour window is the requested final association rule. The archive
  // helper retains alias normalization (Celta / RC Celta / Celta de Vigo)
  // and rejects reversed home/away cards.
  return fixtureDateCandidates(fixture)
    .filter((date) => withinHours(articleDate, date, 48))
    .map((date) => {
      const comparison = matchArchive.orderedTeamIdentityComparison(match, {
        home: fixture.home,
        away: fixture.away,
      });
      return comparison?.orientation === 'direct' ? {
        ...comparison,
        method: `${comparison.method}_ordered_teams_within_48h`,
        // Full identity wins whenever present across candidates. This fallback
        // is eligible only when no full identity matched at all.
        score: Math.max(60, comparison.score - 10),
        identityTier: 'ordered_teams_within_48h',
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)[0] || null;
}

async function fixturesForDate(date, fetcher, fixtureCache = null) {
  if (fixtureCache?.has(date)) return fixtureCache.get(date);
  const load = async () => {
  const result = await fetcher('/fixtures', { date }, { retries: 0, timeoutMs: 6_000 });
  if (result?.errors && Object.keys(result.errors).length) throw new Error('API-Football fixtures response was unavailable');
  return (Array.isArray(result?.response) ? result.response : []).map(providerFixture).filter(Boolean);
  };
  // Sharing requests by date keeps a reconciliation run bounded: many reports
  // are from the same round, and a 48-hour window otherwise repeats the same
  // provider call for every article.
  const pending = load();
  fixtureCache?.set(date, pending);
  try {
    return await pending;
  } catch (error) {
    fixtureCache?.delete(date);
    throw error;
  }
}

async function resolveByMatchIdentity(match, { fetcher, fixtureCache }) {
  const date = validDate(match?.date);
  if (!date || !match?.homeTeam || !match?.awayTeam) return { state: 'insufficient_identity' };
  let candidates;
  try {
    const byId = new Map();
    const datedFixtures = await mapWithConcurrency(
      dateWindow(date, 48),
      FIXTURE_DATE_LOOKUP_CONCURRENCY,
      (candidateDate) => fixturesForDate(candidateDate, fetcher, fixtureCache),
    );
    for (const fixtures of datedFixtures) {
      for (const fixture of fixtures) byId.set(fixture.id, fixture);
    }
    candidates = [...byId.values()];
  } catch (error) {
    return { state: 'source_unavailable', error: error.message };
  }
  const matches = candidates.map((fixture) => ({ fixture, comparison: identityComparison(match, fixture) }))
    .filter((entry) => entry.comparison && entry.comparison.score >= 60);
  if (!matches.length) return { state: 'not_found' };
  // A full competition/date/card match retains precedence across all source
  // results. Only when it yielded none may the approved ordered-team fallback
  // choose a fixture, and it must still be unique.
  const fullIdentityMatches = matches.filter((entry) => entry.comparison.identityTier === 'full_identity');
  const eligible = fullIdentityMatches.length ? fullIdentityMatches : matches;
  const highest = Math.max(...eligible.map((entry) => entry.comparison.score));
  const strongest = eligible.filter((entry) => entry.comparison.score === highest);
  if (strongest.length !== 1) return { state: 'ambiguous', candidates: strongest.map((entry) => entry.fixture.id) };
  return { state: 'resolved', ...strongest[0], method: strongest[0].comparison.method };
}

export async function resolveVerifiedFixtureForArticle(article, {
  getFixture = getFixtureIdentity,
  fetcher = apiFootballFetch,
  fixtureCache = null,
  // Existing callers that only validate an explicit ID retain the conservative
  // historical result. The durable synchronizer opts in to a unique full-card
  // recovery when repairing a stale legacy link.
  recoverConflictingFixtureId = false,
} = {}) {
  const match = article?.match;
  if (!['match_prediction', 'match_report'].includes(article?.type) || !match) {
    return { state: 'not_applicable' };
  }
  const explicitId = positiveId(match.fixtureId);
  if (explicitId) {
    let fixture;
    try {
      fixture = await getFixture(explicitId);
    } catch (error) {
      return { state: 'source_unavailable', fixtureId: explicitId, error: error.message };
    }
    if (!fixture) {
      if (!recoverConflictingFixtureId) return { state: 'fixture_missing', fixtureId: explicitId };
      const recovered = await resolveByMatchIdentity(match, { fetcher, fixtureCache });
      return recovered.state === 'resolved'
        ? { ...recovered, method: `repaired_fixture_id:${recovered.method}`, replacedFixtureId: explicitId }
        : { ...recovered, state: recovered.state === 'not_found' ? 'fixture_missing' : recovered.state, fixtureId: explicitId };
    }
    const comparison = identityComparison(match, fixture);
    // The fixture ID is authoritative only if the article's complete match
    // identity agrees. A mistaken ID must create a review item, not a
    // confident rebind to an unrelated card.
    if (!comparison) {
      if (!recoverConflictingFixtureId) return { state: 'fixture_conflict', fixtureId: explicitId, fixture };
      const recovered = await resolveByMatchIdentity(match, { fetcher, fixtureCache });
      return recovered.state === 'resolved'
        ? { ...recovered, method: `repaired_fixture_id:${recovered.method}`, replacedFixtureId: explicitId }
        : { ...recovered, state: recovered.state === 'not_found' ? 'fixture_conflict' : recovered.state, fixtureId: explicitId, fixture };
    }
    return { state: 'resolved', fixture, comparison, method: 'fixture_id' };
  }

  return resolveByMatchIdentity(match, { fetcher, fixtureCache });
}

export function associationRepairArticle(article, fixture) {
  const fixtureId = positiveId(fixture?.id);
  const homeTeamId = positiveId(fixture?.home?.id);
  const awayTeamId = positiveId(fixture?.away?.id);
  if (!article?.match || !fixtureId || !homeTeamId || !awayTeamId) return null;
  const nextMatch = {
    ...article.match,
    fixtureId,
    homeTeamId,
    awayTeamId,
    // Preserve the editor-facing Match Key labels, but refresh its canonical
    // projection from the same full provider fixture that powers badges and
    // match-detail links.
    canonicalKey: matchArchive.fixtureMatchKey(fixture),
    identityVersion: 2,
  };
  if (JSON.stringify(nextMatch) === JSON.stringify(article.match)) return article;
  return { ...article, match: nextMatch };
}
