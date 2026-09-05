// Shared browser-safe helpers for AM4 editorial series pages. The Notion
// archive remains the source of titles and excerpts; this file only knows how
// to recognise the existing series taxonomy and lay out the fixed season span.
(function attachColumnSeries(root) {
  const SERIES_NAME = '20 Seasons, 20 Stories.';
  const FIRST_SEASON_START = 2006;
  const LAST_SEASON_START = 2025;

  function compact(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[–—―ー]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalized(value) {
    return compact(value).toLocaleLowerCase('en-US');
  }

  function hasSeriesName(value) {
    return /20\s*seasons\s*,?\s*20\s*stories\.?/u.test(normalized(value));
  }

  function validSeason(value) {
    const match = compact(value).match(/\b(20(?:0[6-9]|1\d|2[0-5]))\s*-\s*(\d{2}|20\d{2})\b/u);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2].length === 2
      ? Math.floor(start / 100) * 100 + Number(match[2])
      : Number(match[2]);
    return end === start + 1 ? `${start}-${String(end).slice(-2)}` : null;
  }

  function seasons() {
    return Array.from(
      { length: LAST_SEASON_START - FIRST_SEASON_START + 1 },
      (_, index) => {
        const start = FIRST_SEASON_START + index;
        return `${start}-${String(start + 1).slice(-2)}`;
      },
    );
  }

  function storyText(article = {}) {
    return [
      article?.story?.topicKey,
      article?.story?.subject,
      article?.title,
    ].filter(Boolean).join(' ');
  }

  function isTwentySeasonsStory(article = {}) {
    return normalized(article?.story?.series) === normalized(SERIES_NAME) || hasSeriesName(storyText(article));
  }

  function seasonForStory(article = {}) {
    const explicit = validSeason(article?.story?.season);
    return explicit || validSeason(storyText(article));
  }

  function storyPriority(article = {}) {
    const value = Number(article?.priority ?? article?.story?.priority);
    return Number.isFinite(value) ? value : 0;
  }

  function storyTimestamp(article = {}) {
    const timestamp = Date.parse(article?.publishedAt || article?.notion?.updatedAt || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function storyWins(candidate, current) {
    const priorityDifference = storyPriority(candidate) - storyPriority(current);
    if (priorityDifference) return priorityDifference > 0;
    const timestampDifference = storyTimestamp(candidate) - storyTimestamp(current);
    if (timestampDifference) return timestampDifference > 0;
    return String(candidate?.id || '') < String(current?.id || '');
  }

  function storiesBySeason(articles = []) {
    const selected = new Map();
    (Array.isArray(articles) ? articles : []).forEach((article) => {
      if (!isTwentySeasonsStory(article)) return;
      const season = seasonForStory(article);
      if (!season) return;
      const current = selected.get(season);
      if (!current || storyWins(article, current)) selected.set(season, article);
    });
    return selected;
  }

  const api = {
    SERIES_NAME,
    FIRST_SEASON_START,
    LAST_SEASON_START,
    compact,
    seasons,
    validSeason,
    isTwentySeasonsStory,
    seasonForStory,
    storiesBySeason,
  };

  root.AM4ColumnSeries = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? window : globalThis));
