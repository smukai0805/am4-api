// Buffered article-store adapter used only by the scheduled Notion mirror sync.
//
// The public article store keeps one lightweight index plus one Blob per article.
// A sync can update many articles at once. Calling the ordinary saveArticle()
// for every page would reread and rewrite the whole index for every article.
// This adapter keeps one consistent index snapshot in memory, buffers article
// writes, then writes each changed article and the index exactly once at flush.
//
// It also compacts legacy index rows while they are in memory. Older rows kept
// full prediction/report objects in articles/index.json even though list views
// only need metadata. Keeping those long editorial bodies out of the index cuts
// the bytes transferred on every archive/availability lookup without changing
// the full per-article Blob.

import { get, put } from '@vercel/blob';
import { isPublicArticle } from './article-visibility.js';
import { articleSearchText } from './article-taxonomy.js';

const INDEX_PATHNAME = 'articles/index.json';
const ARTICLE_WRITE_CONCURRENCY = 8;

function articlePathname(id) {
  return `articles/${id}.json`;
}

function compactNotion(notion) {
  if (!notion || typeof notion !== 'object') return null;
  return {
    pageId: notion.pageId ?? null,
    pageUrl: notion.pageUrl ?? null,
    updatedAt: notion.updatedAt ?? null,
    state: notion.state ?? null,
  };
}

function compactStory(story) {
  if (!story || typeof story !== 'object') return null;
  return {
    topicKey: story.topicKey ?? null,
    category: story.category ?? null,
    subject: story.subject ?? null,
    relatedClubs: story.relatedClubs ?? null,
    tags: Array.isArray(story.tags) ? story.tags : [],
    series: story.series ?? null,
    season: story.season ?? null,
  };
}

export function compactArticleIndexEntry(article = {}) {
  const body = typeof article.body === 'string' ? article.body : '';
  const compact = {
    id: article.id,
    type: article.type,
    title: article.title,
    publishedAt: article.publishedAt,
    hasScoreTable: article.hasScoreTable ?? null,
    isHereWeGo: article.isHereWeGo ?? null,
    status: article.status,
    public: article.public !== false,
    deck: article.deck ?? null,
    summary: article.summary ?? null,
    contentKind: article.contentKind ?? null,
    match: article.match ?? null,
    story: compactStory(article.story),
    notion: compactNotion(article.notion),
    subject: article.subject ?? null,
    club: article.club ?? null,
    scoreboard: article.scoreboard ?? null,
    relatedArticleId: article.relatedArticleId ?? null,
    transfer: article.transfer ?? null,
    player: article.player ?? null,
    tags: Array.isArray(article.tags) ? article.tags : [],
    priority: Number.isFinite(Number(article.priority)) ? Number(article.priority) : 0,
    popularRank: Number.isFinite(Number(article.popularRank)) ? Number(article.popularRank) : null,
    coverImage: article.coverImage ?? null,
    // Preserve an existing server-side search projection; compute one before
    // stripping legacy report/prediction objects when the row predates it.
    searchText: article.searchText || articleSearchText(article),
  };

  if (body && body.length <= 300) {
    compact.body = body;
    compact.sources = Array.isArray(article.sources) ? article.sources : [];
  }
  return compact;
}

function sortIndex(index) {
  index.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createSyncArticleStore({ blob = { get, put }, logger = console } = {}) {
  let index = null;
  let indexDirty = false;
  const pendingArticles = new Map();
  const stats = {
    indexReads: 0,
    indexWrites: 0,
    articleWrites: 0,
    compactedEntries: 0,
  };

  async function ensureIndex() {
    if (index) return index;
    const result = await blob.get(INDEX_PATHNAME, { access: 'private', useCache: false });
    stats.indexReads += 1;
    if (!result || !result.stream) {
      index = [];
      return index;
    }
    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed) ? parsed : [];
    const compacted = raw.map(compactArticleIndexEntry);
    stats.compactedEntries = raw.reduce(
      (count, entry, offset) => count + (jsonEqual(entry, compacted[offset]) ? 0 : 1),
      0,
    );
    indexDirty = stats.compactedEntries > 0;
    index = compacted;
    return index;
  }

  async function listArticles({ type, page = 1, pageSize = 10, includeHidden = false, publishedOnly = false } = {}) {
    const current = await ensureIndex();
    const visible = includeHidden ? current : current.filter((entry) => entry.public !== false);
    const published = publishedOnly ? visible.filter(isPublicArticle) : visible;
    const filtered = type ? published.filter((entry) => entry.type === type) : published;
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      page: safePage,
      pageSize,
      total,
      totalPages,
    };
  }

  async function getArticle(id, { includeHidden = false, publishedOnly = false } = {}) {
    if (pendingArticles.has(id)) {
      const article = pendingArticles.get(id);
      if (!includeHidden && article.public === false) return null;
      if (publishedOnly && !isPublicArticle(article)) return null;
      return article;
    }
    const result = await blob.get(articlePathname(id), { access: 'private', useCache: false });
    if (!result || !result.stream) return null;
    const article = JSON.parse(await new Response(result.stream).text());
    if (!includeHidden && article.public === false) return null;
    if (publishedOnly && !isPublicArticle(article)) return null;
    return article;
  }

  async function saveArticle(article) {
    if (!article?.id) throw new Error('article.id is required');
    const current = await ensureIndex();
    pendingArticles.set(article.id, article);
    const meta = compactArticleIndexEntry(article);
    const offset = current.findIndex((entry) => entry.id === article.id);
    if (offset >= 0) current[offset] = meta;
    else current.push(meta);
    sortIndex(current);
    indexDirty = true;
    return article;
  }

  async function flush() {
    const current = await ensureIndex();
    const articles = [...pendingArticles.values()];
    for (let offset = 0; offset < articles.length; offset += ARTICLE_WRITE_CONCURRENCY) {
      const batch = articles.slice(offset, offset + ARTICLE_WRITE_CONCURRENCY);
      await Promise.all(batch.map((article) => blob.put(
        articlePathname(article.id),
        JSON.stringify(article),
        {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json',
        },
      )));
      stats.articleWrites += batch.length;
    }

    if (indexDirty) {
      await blob.put(INDEX_PATHNAME, JSON.stringify(current), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      });
      stats.indexWrites += 1;
      indexDirty = false;
    }
    pendingArticles.clear();
    logger?.info?.('[notion sync] buffered article store', stats);
    return { ...stats };
  }

  return {
    listArticles,
    getArticle,
    saveArticle,
    flush,
    stats,
  };
}
