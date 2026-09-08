(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4ArticleLoadState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function articleLoadState({ status, hasArticle, error } = {}) {
    if (error) return "unavailable";
    if (Number(status) === 404) return "missing";
    if (Number(status) >= 200 && Number(status) < 300 && hasArticle) return "ready";
    return "unavailable";
  }

  function articleHref(article, fixtureId = article?.match?.fixtureId) {
    const params = new URLSearchParams({id:article.id});
    const id = Number(fixtureId);
    if (['match_report','match_prediction'].includes(article.type) && Number.isSafeInteger(id) && id > 0) params.set('fixtureId',String(id));
    return `/article.html?${params}`;
  }

  async function readArticle({fetcher, apiBase, id, fixtureId}) {
    try {
      const response = await fetcher(`${apiBase}/articles?id=${encodeURIComponent(id)}`,{headers:{Accept:'application/json'}});
      if (response.ok) {
        const data = await response.json();
        return {state:data.article?.id === id ? 'ready' : 'unavailable', article:data.article};
      }
      const fixture = Number(fixtureId);
      if (response.status !== 404 || !Number.isSafeInteger(fixture) || fixture <= 0) return {state:articleLoadState({status:response.status})};
      // A new published Notion article may be readable before the archive mirror
      // catches up. The public endpoint and exact article ID remain authoritative.
      const live = await fetcher(`${apiBase}/articles?matchContent=1&fixtureId=${fixture}`,{headers:{Accept:'application/json'}});
      if (!live.ok) return {state:'unavailable'};
      const data = await live.json();
      const article = [data.report,data.prediction].find(item=>item?.id === id && ['match_report','match_prediction'].includes(item.type));
      if (article) return {state:'ready',article};
      return {state:data.partial || Object.values(data.errors || {}).some(Boolean) ? 'unavailable' : 'missing'};
    } catch (_error) { return {state:'unavailable'}; }
  }

  return { articleLoadState, articleHref, readArticle };
});
