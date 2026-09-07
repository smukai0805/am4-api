(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchEditorialFallback = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const editorialTypes = [
    ["match_prediction", "prediction"],
    ["match_report", "report"],
  ];

  function missingEditorialTypes(editorial) {
    return editorialTypes
      .filter(([, property]) => !editorial?.[property])
      .map(([type]) => type);
  }

  function publishedArchiveCandidates(results) {
    const successful = (results || []).filter((result) => result?.status === "fulfilled");
    if (!successful.length) throw new Error("Published AM4 editorial archive unavailable");
    return successful.flatMap((result) => Array.isArray(result.value?.items) ? result.value.items : []);
  }

  // Archive lists deliberately contain public metadata only. `notion.pageId`
  // belongs to the single-article response, so it must not be required while
  // choosing which public record to fetch next.
  function isPublishedNotionListItem(article, type) {
    return article?.type === type
      && article?.status === "published"
      && article?.public !== false
      && article?.contentKind === `notion_${type}`;
  }

  function selectPublishedArchiveEditorial(results, type, matchesFixture) {
    const candidates = new Map();
    publishedArchiveCandidates(results).forEach((article) => {
      if (article?.id) candidates.set(article.id, article);
    });
    return [...candidates.values()].find((article) => (
      isPublishedNotionListItem(article, type)
      && typeof matchesFixture === "function"
      && matchesFixture(article)
    )) || null;
  }

  async function withPublishedFallback(editorial, readPublished) {
    const current = editorial && typeof editorial === "object" ? editorial : {};
    const result = {
      ...current,
      prediction: current.prediction || null,
      report: current.report || null,
      errors: current.errors && typeof current.errors === "object" ? { ...current.errors } : {},
    };
    const missing = missingEditorialTypes(result);
    if (!missing.length || typeof readPublished !== "function") return result;

    const restored = await Promise.allSettled(missing.map((type) => readPublished(type)));
    restored.forEach((outcome, index) => {
      const type = missing[index];
      if (outcome.status !== "fulfilled") {
        if (!result.errors[type]) result.errors[type] = "unavailable";
        return;
      }
      if (!outcome.value) return;
      const [, property] = editorialTypes.find(([candidate]) => candidate === type);
      result[property] = outcome.value;
    });
    return result;
  }

  return {
    missingEditorialTypes,
    publishedArchiveCandidates,
    selectPublishedArchiveEditorial,
    withPublishedFallback,
  };
});
