(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4MatchTransition = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MATCH_TRANSITION_STORAGE_KEY = 'am4:match-transition';
  const MATCH_TRANSITION_MAX_AGE_MS = 30_000;
  const MAX_PREFETCHED_MATCHES = 3;

  function fixtureId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function boundedText(value, limit = 180) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, limit) : '';
  }

  function safeHttpUrl(value) {
    const source = boundedText(value, 1_500);
    if (!source) return null;
    try {
      const url = new URL(source);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function nullableScore(value) {
    if (value == null || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function createMatchTransitionSnapshot(fixture, { startedAt = Date.now() } = {}) {
    const id = fixtureId(fixture?.id);
    const timestamp = Number(startedAt);
    if (!id || !Number.isFinite(timestamp)) return null;
    const home = boundedText(fixture?.home);
    const away = boundedText(fixture?.away);
    if (!home || !away) return null;
    return {
      version: 1,
      fixtureId: id,
      startedAt: timestamp,
      competition: boundedText(fixture?.competition),
      competitionLogo: safeHttpUrl(fixture?.competitionLogo),
      roundLabel: boundedText(fixture?.roundLabel),
      kickoff: boundedText(fixture?.kickoff),
      status: boundedText(fixture?.status, 24),
      home: {
        id: fixtureId(fixture?.homeId),
        name: home,
        logo: safeHttpUrl(fixture?.homeLogo),
      },
      away: {
        id: fixtureId(fixture?.awayId),
        name: away,
        logo: safeHttpUrl(fixture?.awayLogo),
      },
      goals: {
        home: nullableScore(fixture?.homeGoals),
        away: nullableScore(fixture?.awayGoals),
      },
      venue: { name: boundedText(fixture?.venue) },
    };
  }

  function readMatchTransitionSnapshot(storage, requestedFixtureId, { now = Date.now() } = {}) {
    const id = fixtureId(requestedFixtureId);
    if (!id || !storage?.getItem) return null;
    try {
      const snapshot = JSON.parse(storage.getItem(MATCH_TRANSITION_STORAGE_KEY) || 'null');
      if (!snapshot || snapshot.version !== 1 || snapshot.fixtureId !== id) return null;
      if (!Number.isFinite(snapshot.startedAt) || Number(now) - snapshot.startedAt > MATCH_TRANSITION_MAX_AGE_MS) return null;
      if (Number(now) < snapshot.startedAt - 5_000) return null;
      if (!boundedText(snapshot.home?.name) || !boundedText(snapshot.away?.name)) return null;
      return snapshot;
    } catch (_error) {
      return null;
    }
  }

  function shouldPrefetchMatch({ prefetchedCount = 0, connection = null } = {}) {
    if (Number(prefetchedCount) >= MAX_PREFETCHED_MATCHES) return false;
    if (connection?.saveData) return false;
    return !['slow-2g', '2g'].includes(String(connection?.effectiveType || '').toLowerCase());
  }

  return {
    MATCH_TRANSITION_STORAGE_KEY,
    MATCH_TRANSITION_MAX_AGE_MS,
    MAX_PREFETCHED_MATCHES,
    createMatchTransitionSnapshot,
    readMatchTransitionSnapshot,
    shouldPrefetchMatch,
  };
});
