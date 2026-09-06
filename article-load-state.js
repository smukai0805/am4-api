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

  return { articleLoadState };
});
