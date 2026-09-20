import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export function recordFootballCacheRead(metadata) {
  if (metadata) context.getStore()?.push(metadata);
}
export function recordFootballCacheFailure() {
  context.getStore()?.push({ stale: true, unavailable: true });
}

export function withFootballCacheMetadata(handler) {
  return function footballCacheHandler(req, res) {
    return context.run([], async () => {
      function metadata() {
        const reads = context.getStore() || [];
        const dates = reads.map((read) => Date.parse(read.fetchedAt)).filter(Number.isFinite);
        if (!dates.length && !reads.some((read) => read.unavailable)) return null;
        return {
          fetchedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
          stale: reads.some((read) => read.stale),
          ...(reads.some((read) => read.unavailable) ? { unavailable: true } : {}),
        };
      }
      const json = typeof res.json === 'function' ? res.json.bind(res) : null;
      if (json) res.json = (body) => {
        const freshness = metadata();
        const errors = body?.error || (body?.errors && Object.keys(body.errors).length);
        if (errors || freshness?.stale) res.setHeader('Cache-Control', 'no-store');
        if (freshness) {
          if (freshness.fetchedAt) res.setHeader('X-AM4-Data-Fetched-At', freshness.fetchedAt);
          res.setHeader('X-AM4-Data-Stale', String(freshness.stale));
        }
        return json(freshness && body && typeof body === 'object' && !Array.isArray(body)
          ? { ...body, dataFreshness: freshness } : body);
      };
      if (typeof res.send === 'function') {
        const send = res.send.bind(res);
        res.send = (body) => {
          const freshness = metadata();
          if (freshness?.stale) {
            res.setHeader('Cache-Control', 'no-store');
            if (typeof body === 'string' && /<body\b/i.test(body)) {
              const timestamp = freshness.fetchedAt ? new Intl.DateTimeFormat('ja-JP', {
                timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
              }).format(new Date(freshness.fetchedAt)) : '時刻確認中';
              body = body.replace(/(<main\b[^>]*>)/i, `$1<p role="status" data-am4-data-stale="true">一部の試合データを更新できないため、保存済みの情報を表示しています（最終取得 ${timestamp} JST）。</p>`);
            }
          }
          return send(body);
        };
      }
      return handler(req, res);
    });
  };
}
