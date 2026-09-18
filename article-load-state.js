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

  // `notionArticleId()` is the only source that creates these identifiers.
  // A valid mirror ID can briefly be absent between a public link/event and
  // the durable collector's next successful write. Do not give ordinary
  // unknown article IDs the same retry-only treatment.
  function isNotionMirrorArticleId(value) {
    return /^notion-(?:match_prediction|match_report|am4_story)-[a-z0-9]{16,}$/u.test(String(value || ''));
  }

  async function readArticle({fetcher, apiBase, id, fixtureId}) {
    try {
      const response = await fetcher(`${apiBase}/articles?id=${encodeURIComponent(id)}`,{headers:{Accept:'application/json'}});
      if (response.ok) {
        const data = await response.json();
        return {state:data.article?.id === id ? 'ready' : 'unavailable', article:data.article};
      }
      if (response.status !== 404) return {state:articleLoadState({status:response.status})};
      // A reader must never turn a Notion mirror miss into a live Notion scan.
      // The signed webhook/hourly collector owns upstream reads and will mirror
      // a newly public source page through the durable queue. An ordinary
      // unknown article remains a real 404 for the existing reader contract.
      return {state:isNotionMirrorArticleId(id) ? 'unavailable' : 'missing'};
    } catch (_error) { return {state:'unavailable'}; }
  }

  return { articleLoadState, articleHref, isNotionMirrorArticleId, readArticle };
});
