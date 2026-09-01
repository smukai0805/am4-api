// Notion is the editorial source of truth. This module is intentionally server-only:
// the browser reads the existing AM4 article archive and never receives a Notion token.

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2026-03-11';
const PUBLISHABLE_STATES = new Set(['自動生成', '公開準備', '公開済']);

// These IDs identify the AM4-owned sources, not credentials. They can be overridden
// for a copied workspace without changing application code.
const DEFAULT_SOURCE_IDS = {
  match_report: 'd9c69a0d-7471-4624-a697-56d7d43ec2b8',
  match_prediction: 'b4743ad8-9ca9-462c-b90d-406e3e0a0c4b',
  am4_story: 'd0b2c5e2-70f1-488d-872e-d57fa5282842',
};

const SOURCE_DEFINITIONS = [
  { type: 'match_report', sourceEnv: 'NOTION_MATCH_REPORTS_SOURCE_ID' },
  { type: 'match_prediction', sourceEnv: 'NOTION_MATCH_PREDICTIONS_SOURCE_ID' },
  { type: 'am4_story', sourceEnv: 'NOTION_AM4_STORIES_SOURCE_ID' },
];

function richTextText(value) {
  if (!Array.isArray(value)) return '';
  return value.map((part) => part?.plain_text || part?.text?.content || '').join('').trim();
}

function propertyText(page, name) {
  const property = page?.properties?.[name];
  if (!property) return '';
  if (property.type === 'title') return richTextText(property.title);
  if (property.type === 'rich_text') return richTextText(property.rich_text);
  if (property.type === 'select') return property.select?.name || '';
  if (property.type === 'status') return property.status?.name || '';
  if (property.type === 'number') return property.number == null ? '' : String(property.number);
  if (property.type === 'unique_id') {
    const value = property.unique_id;
    return value?.number == null ? '' : `${value.prefix ? `${value.prefix}-` : ''}${value.number}`;
  }
  return '';
}

function propertyDate(page, name) {
  const value = page?.properties?.[name];
  return value?.type === 'date' ? value.date?.start || null : null;
}

function propertyNumber(page, name) {
  const value = page?.properties?.[name];
  const number = value?.type === 'number' ? Number(value.number) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fixtureIdFromMatchKey(matchKey) {
  const match = String(matchKey || '').match(/(?:^|\D)(\d{5,})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function matchMetadata(page) {
  const matchKey = propertyText(page, 'Match Key');
  const homeTeam = propertyText(page, 'ホーム') || null;
  const awayTeam = propertyText(page, 'アウェイ') || null;
  const matchDate = propertyDate(page, '試合日');
  const competition = propertyText(page, '大会') || null;
  return {
    fixtureId: fixtureIdFromMatchKey(matchKey),
    matchKey: matchKey || null,
    homeTeam,
    awayTeam,
    date: matchDate,
    competition,
  };
}

export function isPublishableNotionState(state) {
  return PUBLISHABLE_STATES.has(String(state || '').trim());
}

export function markdownExcerpt(markdown, limit = 150) {
  const candidates = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^[-*+]\s/.test(line) && !/^>\s?出典/.test(line))
    .map((line) => line.replace(/^>\s?/, '').replace(/\*\*/g, ''));
  const value = compact(candidates.join(' '));
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function blockText(block) {
  const payload = block?.[block?.type];
  return richTextText(payload?.rich_text);
}

function blockMarkdown(block, index) {
  const value = blockText(block);
  if (!value && block?.type !== 'divider') return '';
  switch (block?.type) {
    case 'heading_1': return `# ${value}`;
    case 'heading_2': return `## ${value}`;
    case 'heading_3': return `### ${value}`;
    case 'bulleted_list_item': return `- ${value}`;
    case 'numbered_list_item': return `${index + 1}. ${value}`;
    case 'quote':
    case 'callout': return `> ${value}`;
    case 'divider': return '---';
    case 'paragraph': return value;
    default: return value;
  }
}

function notionArticleId(type, pageId) {
  return `notion-${type}-${String(pageId || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

export function notionPageToArticle({ type, page, markdown }) {
  const title = propertyText(page, '記事タイトル') || compact(page?.url).split('/').at(-1) || 'AM4記事';
  const article = {
    id: notionArticleId(type, page?.id),
    type,
    contentKind: `notion_${type}`,
    title,
    publishedAt: propertyDate(page, '生成日時') || page?.last_edited_time || page?.created_time || new Date().toISOString(),
    body: markdown,
    deck: markdownExcerpt(markdown),
    summary: markdownExcerpt(markdown),
    sources: [],
    status: 'published',
    public: true,
    notion: {
      pageId: page?.id || null,
      pageUrl: page?.url || null,
      updatedAt: page?.last_edited_time || page?.created_time || null,
      state: propertyText(page, '記事状態') || null,
    },
  };

  if (type === 'match_report') {
    article.match = matchMetadata(page);
    return article;
  }
  if (type === 'match_prediction') {
    article.match = matchMetadata(page);
    article.prediction = {
      score: propertyText(page, '予想スコア') || null,
      pick: propertyText(page, '本命') || null,
      confidence: propertyNumber(page, '確信度'),
    };
    return article;
  }
  article.story = {
    topicKey: propertyText(page, 'Topic Key') || null,
    category: propertyText(page, 'カテゴリ') || null,
    subject: propertyText(page, '主題') || null,
    relatedClubs: propertyText(page, '関連クラブ') || null,
  };
  return article;
}

function resolveSourceDefinitions(sourceIds = {}) {
  return SOURCE_DEFINITIONS.map((source) => ({
    ...source,
    sourceId: sourceIds[source.type] || process.env[source.sourceEnv] || DEFAULT_SOURCE_IDS[source.type],
  }));
}

function createNotionClient({ apiKey, fetcher }) {
  if (!apiKey) throw new Error('NOTION_API_KEY is not configured');
  async function request(path, init = {}) {
    const response = await fetcher(`${NOTION_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_API_VERSION,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Notion request failed (${response.status})`);
    return response.json();
  }

  async function queryAll(sourceId) {
    const pages = [];
    let cursor = null;
    do {
      const body = {
        page_size: 100,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const result = await request(`/data_sources/${encodeURIComponent(sourceId)}/query`, {
        method: 'POST', body: JSON.stringify(body),
      });
      pages.push(...(Array.isArray(result.results) ? result.results : []));
      cursor = result.has_more ? result.next_cursor : null;
    } while (cursor);
    return pages;
  }

  async function pageMarkdown(pageId) {
    async function readChildren(parentId, depth = 0) {
      const blocks = [];
      let cursor = null;
      do {
        const params = new URLSearchParams({ page_size: '100' });
        if (cursor) params.set('start_cursor', cursor);
        const result = await request(`/blocks/${encodeURIComponent(parentId)}/children?${params}`);
        blocks.push(...(Array.isArray(result.results) ? result.results : []));
        cursor = result.has_more ? result.next_cursor : null;
      } while (cursor);

      const lines = [];
      for (const [index, block] of blocks.entries()) {
        const line = blockMarkdown(block, index);
        if (line) lines.push(line);
        // Notion callouts and nested lists often hold their substantive text in
        // children. Keep traversal bounded for predictable cron execution.
        if (block.has_children && depth < 3) {
          const nested = await readChildren(block.id, depth + 1);
          if (nested) lines.push(nested);
        }
      }
      return lines.join('\n\n');
    }
    return (await readChildren(pageId)).trim();
  }

  return { queryAll, pageMarkdown };
}

async function allStoredArticles(store) {
  const first = await store.listArticles({ page: 1, pageSize: 100, includeHidden: true });
  const items = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await store.listArticles({ page, pageSize: 100, includeHidden: true });
    items.push(...next.items);
  }
  return items;
}

async function hideArticle(existing, page, store, state = null) {
  const article = await store.getArticle(existing.id, { includeHidden: true });
  if (!article) return false;
  await store.saveArticle({
    ...article,
    public: false,
    notion: {
      ...article.notion,
      pageId: page?.id || article.notion?.pageId || null,
      pageUrl: page?.url || article.notion?.pageUrl || null,
      updatedAt: page?.last_edited_time || page?.created_time || article.notion?.updatedAt || null,
      state: state || (page ? propertyText(page, '記事状態') : 'Notionで非公開または削除'),
    },
  });
  return true;
}

// Fetches compact database rows every run, then reads page blocks only for newly
// created or edited entries. That makes the 3-times-daily schedule inexpensive.
export async function syncNotionContent({
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  articleStore = null,
} = {}) {
  const client = createNotionClient({ apiKey, fetcher });
  // Keep the pure page normalizers loadable in lightweight unit tests. The Blob
  // dependency is only needed in a real server-side synchronization.
  const store = articleStore || await import('./article-store.js');
  const existing = await allStoredArticles(store);
  const existingByPageId = new Map(existing
    .filter((item) => item?.notion?.pageId)
    .map((item) => [item.notion.pageId, item]));
  const result = { checked: 0, created: 0, updated: 0, hidden: 0, unchanged: 0, errors: {} };

  for (const source of resolveSourceDefinitions(sourceIds)) {
    try {
      const pages = await client.queryAll(source.sourceId);
      const returnedPageIds = new Set(pages.map((page) => String(page?.id || '')).filter(Boolean));
      for (const page of pages) {
        result.checked += 1;
        const existingArticle = existingByPageId.get(page.id);
        const state = propertyText(page, '記事状態');
        if (!isPublishableNotionState(state)) {
          if (existingArticle && existingArticle.public !== false && await hideArticle(existingArticle, page, store)) result.hidden += 1;
          continue;
        }
        const updatedAt = page.last_edited_time || page.created_time || null;
        if (existingArticle?.notion?.updatedAt === updatedAt && existingArticle.public !== false) {
          result.unchanged += 1;
          continue;
        }
        const markdown = await client.pageMarkdown(page.id);
        const article = notionPageToArticle({ type: source.type, page, markdown });
        await store.saveArticle(article);
        existingByPageId.set(page.id, { ...article, public: true });
        if (existingArticle) result.updated += 1;
        else result.created += 1;
      }
      // A page archived or deleted in Notion is absent from a data-source
      // query. Retract its public mirror only after this source completed
      // successfully; a transient Notion failure must never unpublish content.
      for (const article of existing) {
        const pageId = String(article?.notion?.pageId || '');
        if (
          article?.type === source.type
          && pageId
          && !returnedPageIds.has(pageId)
          && article.public !== false
          && await hideArticle(article, null, store)
        ) {
          result.hidden += 1;
        }
      }
    } catch (error) {
      console.error(`[notion sync] ${source.type} unavailable:`, error);
      result.errors[source.type] = 'unavailable';
    }
  }
  return result;
}
