import { createHash, randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const DAY = 86_400_000;
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const FINISHED = new Set(['FT', 'AET', 'PEN', 'CANC', 'AWD', 'WO']);
const SECTION_PATHS = new Map([
  ['/fixtures/events', 'events'], ['/fixtures/lineups', 'lineups'],
  ['/fixtures/statistics', 'statistics'], ['/fixtures/players', 'players'],
]);
const clone = (value) => structuredClone(value);
const utcDay = (time) => new Date(time).toISOString().slice(0, 10);
const nextUtcDay = (time) => Date.parse(`${utcDay(time)}T00:00:00Z`) + DAY;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function hasProviderErrors(data) {
  return !data || (data.errors != null && Object.keys(data.errors).length > 0);
}

export class FootballProviderError extends Error {
  constructor(message, code = 'provider_unavailable') {
    super(message);
    this.name = 'FootballProviderError';
    this.code = code;
  }
}

export function canonicalProviderRequest(path, params = {}) {
  if (!/^\/[a-z][a-z0-9/-]*$/i.test(path)) throw new Error('Invalid provider path');
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
  const id = Number(SECTION_PATHS.has(path) ? clean.fixture : path === '/fixtures' ? clean.id : null);
  // The documented ids response includes all available match sections. This
  // shares one upstream response between SSR, detail, live detail and lineups.
  if (Number.isSafeInteger(id) && id > 0 && Object.keys(clean).length === 1) {
    return { path: '/fixtures', params: { ids: String(id) }, id, section: SECTION_PATHS.get(path) || null };
  }
  return { path, params: clean, id: null, section: null };
}

export function providerCacheTtl(path, params, data, now = Date.now()) {
  if (!Array.isArray(data?.response) || !data.response.length) return MINUTE;
  if (path === '/players/profiles') return DAY;
  if (path === '/fixtures') {
    const rows = data.response;
    if (rows.some((row) => LIVE.has(row.fixture?.status?.short))) return MINUTE;
    const unsettled = rows.filter((row) => !FINISHED.has(row.fixture?.status?.short));
    const kickoffs = unsettled.map((row) => Date.parse(row.fixture?.date || '')).filter(Number.isFinite);
    if (unsettled.length) {
      if (kickoffs.length && Math.min(...kickoffs) <= now + 10 * MINUTE) return MINUTE;
      if (kickoffs.length && Math.min(...kickoffs) <= now + 90 * MINUTE) return 5 * MINUTE;
      if (params.ids || params.id) return 10 * MINUTE;
      // A future date or league schedule need not be re-fetched per reader.
      return 60 * MINUTE;
    }
    const mostRecent = Math.max(...rows.map((row) => Date.parse(row.fixture?.date || '') || 0));
    // Allow post-match corrections before archiving the stable result.
    return now - mostRecent < 3 * 60 * MINUTE ? 5 * MINUTE
      : now - mostRecent < DAY ? 60 * MINUTE : DAY;
  }
  if (SECTION_PATHS.has(path)) return MINUTE;
  if (['/standings', '/players', '/players/topscorers', '/players/topassists'].includes(path)) return 60 * MINUTE;
  if (['/teams', '/players/squads', '/coachs', '/leagues'].includes(path)) return 6 * 60 * MINUTE;
  return 60 * MINUTE;
}

function responseForProjection(data, originalPath, originalParams, request, cache) {
  const result = clone(data);
  if (request.id) {
    const row = result.response.find((item) => Number(item.fixture?.id) === request.id);
    if (!row) throw new FootballProviderError('Requested fixture missing from provider response');
    if (request.section) {
      if (!Array.isArray(row[request.section])) {
        throw new FootballProviderError(`Fixture ${request.section} is not available`, 'section_unavailable');
      }
      result.response = row[request.section];
    } else result.response = [row];
    result.get = originalPath.slice(1);
    result.parameters = originalParams;
    result.results = result.response.length;
    result.paging = { current: 1, total: 1 };
  }
  result._am4Cache = cache;
  return result;
}

function validateResponse(data, request) {
  if (hasProviderErrors(data)) {
    const code = data?.errors?.requests ? 'daily_limit' : data?.errors?.rateLimit ? 'rate_limit' : 'provider_error';
    throw new FootballProviderError('API-Football returned an error response', code);
  }
  if (!Array.isArray(data.response)) throw new FootballProviderError('Invalid API-Football response');
  if (request.path === '/players/profiles' && request.params.player != null
      && data.response.length && !data.response.every((row) => Number(row.player?.id) === Number(request.params.player))) {
    throw new FootballProviderError('API-Football returned a different player');
  }
  if (request.id && !data.response.some((row) => Number(row.fixture?.id) === request.id)) {
    throw new FootballProviderError('API-Football did not return the requested fixture');
  }
}

export function createMemoryProviderStore() {
  const entries = new Map();
  let version = 0;
  return {
    async read(key) { return clone(entries.get(key) || { value: null, etag: null }); },
    async write(key, value, expected = null) {
      const current = entries.get(key);
      if ((current?.etag || null) !== expected) {
        const error = new Error('Conditional write conflict'); error.code = 'conflict'; throw error;
      }
      const etag = String(++version);
      entries.set(key, { value: clone(value), etag });
      return { value: clone(value), etag };
    },
  };
}

export function isProviderStoreConflict(error) {
  return error?.code === 'conflict' || /precondition|already exists|condition.*failed|412/i.test(`${error?.name} ${error?.message}`);
}

// No Notion/article records are read or written by this cache. store.read/write
// must be strongly consistent, with conditional creation and ETag replacement.
export function createFootballProviderCache({
  store, fetchProvider, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  prefix = 'football-provider-cache/v1', quotaPrefix = prefix,
  dailyBudget = 6500, dailyLimit = 7500, logger = console,
} = {}) {
  if (!store || typeof fetchProvider !== 'function') throw new Error('Provider cache requires a store and transport');
  const pending = new Map();
  const memory = new Map();
  const quotaPath = `${quotaPrefix}/quota.json`;

  function remember(key, value) {
    memory.delete(key); memory.set(key, value);
    while (memory.size > 512) memory.delete(memory.keys().next().value);
  }

  async function mutate(key, initial, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await store.read(key);
      const next = fn(current.value || initial());
      if (next === null) return current;
      try { return await store.write(key, next, current.etag); }
      catch (error) { if (!isProviderStoreConflict(error)) throw error; }
    }
    throw new FootballProviderError('Shared cache is busy', 'cache_busy');
  }

  function quotaState(state = {}) {
    return state.day === utcDay(now()) ? state : { day: utcDay(now()), reserved: 0, observedUsed: 0, blockedUntil: 0, nextRequestAt: 0 };
  }

  async function reserve() {
    let slot;
    await mutate(quotaPath, () => ({}), (stored) => {
      const state = quotaState(stored);
      if (state.blockedUntil > now()) throw new FootballProviderError('Provider requests are paused', 'provider_paused');
      if (Math.max(state.reserved, state.observedUsed || 0) >= dailyBudget) {
        throw new FootballProviderError('AM4 daily provider budget reached', 'daily_budget');
      }
      slot = Math.max(now(), state.nextRequestAt || 0);
      if (slot - now() > 5000) throw new FootballProviderError('Provider request queue is full', 'rate_limit');
      return { ...state, reserved: Math.max(state.reserved, state.observedUsed || 0) + 1, nextRequestAt: slot + 300 };
    });
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
  }

  async function observe(remaining, error = null) {
    if (remaining == null && !error) return;
    await mutate(quotaPath, () => ({}), (stored) => {
      const state = quotaState(stored);
      const next = { ...state };
      if (remaining != null && Number.isFinite(Number(remaining))) {
        next.observedUsed = Math.max(state.observedUsed || 0, dailyLimit - Number(remaining));
      }
      if (error?.code === 'daily_limit') next.blockedUntil = nextUtcDay(now());
      else if (error?.code === 'rate_limit') next.blockedUntil = Math.max(state.blockedUntil || 0, now() + MINUTE);
      return next;
    });
  }

  async function load(key, request, options) {
    let current;
    try { current = await store.read(key); }
    catch (error) {
      const saved = memory.get(key);
      if (saved?.data) return { ...saved, stale: true, reason: 'cache_store_unavailable' };
      // Do not turn a storage outage into one paid call per visitor.
      throw new FootballProviderError('Shared provider cache is unavailable', 'cache_store_unavailable');
    }
    let saved = current.value;
    if (saved?.data) remember(key, saved);
    if (saved?.data && saved.validUntil > now()) return { ...saved, stale: false };
    if (saved?.retryAt > now()) {
      if (saved.data) return { ...saved, stale: true, reason: saved.lastError };
      throw new FootballProviderError('Provider retry is paused', saved.lastError || 'provider_paused');
    }
    const owner = randomUUID();
    let acquired = false;
    const locked = await mutate(key, () => ({}), (value) => {
      acquired = false;
      if (value.data && value.validUntil > now()) return null;
      if (value.leaseUntil > now() || value.retryAt > now()) return null;
      acquired = true;
      return { ...value, owner, leaseUntil: now() + 30_000 };
    });
    saved = locked.value;
    if (!acquired) {
      if (saved?.data) return { ...saved, stale: saved.validUntil <= now(), reason: 'refresh_in_progress' };
      // Cold concurrent readers wait briefly for the single lease owner.
      for (const delay of [100, 250, 500, 1000]) {
        await sleep(delay);
        const next = await store.read(key);
        if (next.value?.data) return { ...next.value, stale: next.value.validUntil <= now() };
      }
      throw new FootballProviderError('Fixture data is being fetched', 'refresh_in_progress');
    }
    try {
      await reserve();
      const result = await fetchProvider(request.path, request.params, options);
      await observe(result.remaining);
      validateResponse(result.data, request);
      // An unexplained disappearance is not proof that a known match/profile
      // no longer exists. Keep it labelled stale until a valid refresh arrives.
      if (!result.data.response.length && saved?.data?.response?.length) {
        throw new FootballProviderError('Previously populated provider data is temporarily empty', 'empty_refresh');
      }
      const timestamp = now();
      const next = {
        version: 1, fetchedAt: timestamp,
        validUntil: timestamp + providerCacheTtl(request.path, request.params, result.data, timestamp),
        data: result.data, owner: null, leaseUntil: 0, retryAt: 0,
      };
      // A missing optional bundle section cannot delete a previously verified
      // section; its age is tracked separately and exposed as partial/stale.
      if (request.id && saved?.data) {
        const previous = saved.data.response?.find((row) => Number(row.fixture?.id) === request.id);
        const fresh = next.data.response.find((row) => Number(row.fixture?.id) === request.id);
        for (const section of SECTION_PATHS.values()) {
          if (!Array.isArray(fresh[section]) && Array.isArray(previous?.[section])) {
            fresh[section] = clone(previous[section]);
            next.partial = true;
            next.sectionFetchedAt = { ...saved.sectionFetchedAt, ...(next.sectionFetchedAt || {}), [section]: saved.sectionFetchedAt?.[section] || saved.fetchedAt };
          }
        }
      }
      if (request.path === '/players/profiles' && saved?.data) {
        for (const row of next.data.response) {
          const old = saved.data.response?.find((item) => Number(item.player?.id) === Number(row.player?.id));
          if (row.player?.id && !row.player.photo && old?.player?.photo) {
            row.player.photo = old.player.photo;
            next.partial = true;
            next.sectionFetchedAt = { profile: saved.sectionFetchedAt?.profile || saved.fetchedAt };
            next.validUntil = timestamp + 60_000;
          }
        }
      }
      const written = await store.write(key, next, locked.etag);
      remember(key, written.value);
      return { ...written.value, stale: Boolean(next.partial), reason: next.partial ? 'partial_provider_response' : null };
    } catch (error) {
      try { await observe(null, error); } catch { /* Existing snapshot remains safe. */ }
      const retryAt = ['daily_limit', 'daily_budget'].includes(error.code) ? nextUtcDay(now()) : now() + MINUTE;
      const next = { ...saved, owner: null, leaseUntil: 0, retryAt, lastError: error.code || 'provider_unavailable' };
      try { await store.write(key, next, locked.etag); } catch { /* Never overwrite a newer lease or snapshot. */ }
      if (saved?.data) {
        remember(key, next);
        return { ...next, stale: true, reason: next.lastError };
      }
      throw error;
    }
  }

  async function request(path, params = {}, options = {}) {
    const canonical = canonicalProviderRequest(path, params);
    const query = new URLSearchParams(Object.entries(canonical.params).sort(([a], [b]) => a.localeCompare(b))).toString();
    const key = `${prefix}/responses/${digest(`${canonical.path}?${query}`)}.json`;
    const local = memory.get(key);
    let saved;
    if (local?.data && local.validUntil > now()) saved = { ...local, stale: Boolean(local.partial) };
    else {
      if (!pending.has(key)) pending.set(key, load(key, canonical, options).finally(() => pending.delete(key)));
      try { saved = await pending.get(key); }
      catch (error) {
        const fallback = memory.get(key);
        if (!fallback?.data) throw error;
        saved = { ...fallback, stale: true, reason: error.code || 'cache_store_unavailable' };
      }
    }
    const cache = {
      fetchedAt: new Date(saved.sectionFetchedAt?.[canonical.section || (path === '/players/profiles' ? 'profile' : '')] || saved.fetchedAt).toISOString(),
      stale: Boolean(saved.stale || saved.partial), reason: saved.reason || null,
    };
    if (cache.stale) logger.warn?.('[football-cache] stale snapshot', { path, reason: cache.reason, fetchedAt: cache.fetchedAt });
    return responseForProjection(saved.data, path, params, canonical, cache);
  }
  return { request, readQuota: async () => quotaState((await store.read(quotaPath)).value || {}) };
}
