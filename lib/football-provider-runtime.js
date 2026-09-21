import './blob-environment.js';
import { createHash } from 'node:crypto';
import { createFootballProviderCache, createMemoryProviderStore, FootballProviderError } from './football-provider-cache.js';
import { recordFootballCacheRead, recordFootballCacheFailure } from './football-cache-context.js';

const clients = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);

function blobStore(blob) {
  return {
    async read(path) {
      const result = await blob.get(path, { access: 'private', useCache: false });
      if (!result?.stream) return { value: null, etag: null };
      if (!result.etag) throw new Error('Provider cache read requires an ETag');
      return { value: JSON.parse(await new Response(result.stream).text()), etag: result.etag };
    },
    async write(path, value, expected = null) {
      const result = await blob.put(path, JSON.stringify(value), {
        access: 'private', addRandomSuffix: false,
        allowOverwrite: Boolean(expected), ...(expected ? { ifMatch: expected } : {}),
        contentType: 'application/json', cacheControlMaxAge: 60,
      });
      if (!result.etag) throw new Error('Provider cache write requires an ETag');
      return { value, etag: result.etag };
    },
  };
}

async function createClient(apiKey) {
  let store;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    store = blobStore(await import('@vercel/blob'));
  } else if (process.env.VERCEL) {
    // Scaling must not silently fall back to a per-instance quota/cache.
    throw new FootballProviderError('Persistent football cache is not configured', 'cache_store_unavailable');
  } else store = createMemoryProviderStore();
  const keyId = hash(apiKey);
  const environment = process.env.VERCEL_ENV === 'production' ? 'production'
    : process.env.VERCEL_ENV === 'preview' ? `preview-${hash(process.env.VERCEL_URL || 'preview')}` : 'development';
  return createFootballProviderCache({
    store,
    prefix: `football-provider-cache/v1/${keyId}/${environment}`,
    // Previews sharing the same provider key also share its daily budget.
    quotaPrefix: `football-provider-cache/v1/${keyId}/shared`,
    dailyBudget: Math.min(6500, Math.max(1, Number(process.env.AM4_FOOTBALL_DAILY_BUDGET) || 6500)),
    async fetchProvider(path, params, { timeoutMs = 6000 } = {}) {
      const url = new URL(`https://v3.football.api-sports.io${path}`);
      for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
      // Log actual transmissions, not visits or cache hits. Never log the key.
      console.info('[football-provider-request]', JSON.stringify({ path, requestKey: hash(url.toString()), at: new Date().toISOString() }));
      const response = await fetch(url, {
        headers: { 'x-apisports-key': apiKey },
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1000, Number(timeoutMs) || 6000))),
      });
      if (!response.ok) throw new FootballProviderError(`API-Football HTTP ${response.status}`, response.status === 429 ? 'rate_limit' : 'provider_unavailable');
      return { data: await response.json(), remaining: response.headers.get('x-ratelimit-requests-remaining') };
    },
  });
}

export async function cachedFootballFetch(path, params, options = {}) {
  const apiKey = options.apiKey || process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new FootballProviderError('API_FOOTBALL_KEY is not configured', 'configuration');
  const clientKey = hash(`${apiKey}:${process.env.BLOB_READ_WRITE_TOKEN || ''}:${process.env.VERCEL_ENV || ''}:${process.env.VERCEL_URL || ''}`);
  if (!clients.has(clientKey)) clients.set(clientKey, createClient(apiKey).catch((error) => { clients.delete(clientKey); throw error; }));
  try {
    const result = await (await clients.get(clientKey)).request(path, params, options);
    recordFootballCacheRead(result._am4Cache);
    return result;
  } catch (error) {
    recordFootballCacheFailure();
    throw error;
  }
}
