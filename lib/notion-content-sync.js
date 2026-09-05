// Notion is the editorial source of truth. This module is intentionally server-only:
// the browser reads the existing AM4 article archive and never receives a Notion token.

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2026-03-11';
const PUBLISHABLE_STATES = new Set(['自動生成', '公開準備', '公開済']);

// Match Key is intentionally strict. These are only explicit, football-specific
// aliases that refer to the same club; this is not a fuzzy search. Keeping the
// mapping here (rather than in UI code) makes the Notion boundary predictable.
const TEAM_KEY_ALIASES = {
  acmilan: 'acmilan',
  milan: 'acmilan',
  internazionale: 'inter',
  inter: 'inter',
  intermilan: 'inter',
  manchesterunited: 'manchesterunited',
  manunited: 'manchesterunited',
  parissaintgermain: 'parissaintgermain',
  psg: 'parissaintgermain',
  atleticomadrid: 'atleticomadrid',
  malaga: 'malaga',
  bayernmunchen: 'bayernmuenchen',
  bayernmunich: 'bayernmuenchen',
  borussiamonchengladbach: 'borussiamonchengladbach',
  borussiamgladbach: 'borussiamonchengladbach',
  // API-Football commonly uses these short labels while AM4's Notion editors
  // use the clubs' full names. Keep this as an explicit identity registry,
  // rather than a fuzzy word-removal rule, so separate clubs cannot join by
  // accident. The team-ID route below is preferred whenever it is available.
  newcastle: 'newcastleunited',
  newcastleunited: 'newcastleunited',
  bournemouth: 'bournemouth',
  afcbournemouth: 'bournemouth',
  brighton: 'brightonandhovealbion',
  brightonandhovealbion: 'brightonandhovealbion',
  leeds: 'leedsunited',
  leedsunited: 'leedsunited',
  ipswich: 'ipswichtown',
  ipswichtown: 'ipswichtown',
  celta: 'celtavigo',
  celtavigo: 'celtavigo',
  coventry: 'coventrycity',
  coventrycity: 'coventrycity',
  tottenham: 'tottenhamhotspur',
  tottenhamhotspur: 'tottenhamhotspur',
  stuttgart: 'vfbstuttgart',
  vfbstuttgart: 'vfbstuttgart',
  cologne: '1fckoln',
  koln: '1fckoln',
  '1fckoln': '1fckoln',
  mainz: 'mainz05',
  mainz05: 'mainz05',
  paderborn: 'scpaderborn',
  scpaderborn: 'scpaderborn',
  freiburg: 'scfreiburg',
  scfreiburg: 'scfreiburg',
  deportivo: 'deportivolacoruna',
  rcdeportivo: 'deportivolacoruna',
  deportivolacoruna: 'deportivolacoruna',
};

const MATCH_KEY_COMPETITION_LABELS = {
  premierleague: 'Premier League',
  laliga: 'La Liga',
  seriea: 'Serie A',
  bundesliga: 'Bundesliga',
  ligue1: 'Ligue 1',
  championsleague: 'Champions League',
};

// These IDs identify the AM4-owned sources, not credentials. They can be overridden
// for a copied workspace without changing application code.
const DEFAULT_SOURCE_IDS = {
  match_report: 'd9c69a0d-7471-4624-a697-56d7d43ec2b8',
  match_prediction: 'b4743ad8-9ca9-462c-b90d-406e3e0a0c4b',
  am4_story: 'd0b2c5e2-70f1-488d-872e-d57fa5282842',
};
const SOURCE_SCHEMA_CACHE_MS = 60 * 60 * 1000;
const sourceSchemaCache = new Map();

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

function propertyTags(page, names) {
  for (const name of names) {
    const property = page?.properties?.[name];
    if (!property) continue;
    if (property.type === 'multi_select') return property.multi_select.map((item) => item?.name).filter(Boolean);
    const text = propertyText(page, name);
    if (text) return text.split(/[／/,、\n]+/).map((tag) => compact(tag).replace(/^#+\s*/, '')).filter(Boolean);
  }
  return [];
}

function propertyUrl(page, names) {
  for (const name of names) {
    const property = page?.properties?.[name];
    if (!property) continue;
    if (property.type === 'url' && property.url) return property.url;
    if (property.type === 'files') {
      const file = property.files?.[0];
      const url = file?.file?.url || file?.external?.url;
      if (url) return url;
    }
  }
  return null;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// "20 Seasons, 20 Stories." deliberately reuses the existing editorial
// taxonomy. Topic Key and 主題 are already required for AM4 stories, so this
// adds no Notion property or second source of truth. Keep the matcher strict:
// a season only belongs to the series when the explicit series name is present.
const TWENTY_SEASONS_SERIES = '20 Seasons, 20 Stories.';

function normalizedSeriesText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[–—―ー]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function twentySeasonsMetadata(page) {
  const topicKey = propertyText(page, 'Topic Key');
  const subject = propertyText(page, '主題');
  const title = propertyText(page, '記事タイトル');
  const source = normalizedSeriesText([topicKey, subject, title].filter(Boolean).join(' '));
  const isSeries = /20\s*seasons\s*,?\s*20\s*stories\.?/iu.test(source);
  if (!isSeries) return { series: null, season: null };

  const match = source.match(/\b(20(?:0[6-9]|1\d|2[0-5]))\s*-\s*(\d{2}|20\d{2})\b/u);
  if (!match) return { series: TWENTY_SEASONS_SERIES, season: null };

  const start = Number(match[1]);
  const end = match[2].length === 2
    ? Math.floor(start / 100) * 100 + Number(match[2])
    : Number(match[2]);
  const season = end === start + 1 ? `${start}-${String(end).slice(-2)}` : null;
  return { series: TWENTY_SEASONS_SERIES, season };
}

function fixtureIdFromMatchKey(matchKey) {
  const match = String(matchKey || '').match(/(?:^|\D)(\d{5,})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

const FIXTURE_ID_PROPERTY_NAMES = [
  'Fixture ID', 'fixture ID', 'fixtureId', '試合ID', '試合 ID', 'API-FOOTBALL Fixture ID',
];

// The current AM4 editorial sources do not yet have these properties. Reading
// them opportunistically means the API can switch to provider team IDs as soon
// as the editorial workflow adds them, without a front-end or matching rewrite.
const HOME_TEAM_ID_PROPERTY_NAMES = [
  'Home Team ID', 'home team ID', 'homeTeamId', 'home_team_id',
  'ホームチームID', 'ホームチーム ID', 'API-FOOTBALL Home Team ID',
];
const AWAY_TEAM_ID_PROPERTY_NAMES = [
  'Away Team ID', 'away team ID', 'awayTeamId', 'away_team_id',
  'アウェイチームID', 'アウェイチーム ID', 'API-FOOTBALL Away Team ID',
];

function propertyInteger(page, names) {
  for (const name of names) {
    const numeric = propertyNumber(page, name);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    const value = propertyText(page, name).trim();
    if (/^[1-9]\d*$/.test(value)) return Number(value);
  }
  return null;
}

function explicitFixtureId(page) {
  return propertyInteger(page, FIXTURE_ID_PROPERTY_NAMES);
}

function normalizedMatchPart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Recompose Japanese voiced kana after removing Latin combining accents.
    // Without this, プレミアリーグ becomes フレミアリク and will not match.
    .normalize('NFC')
    .replace(/[^a-z0-9ぁ-んァ-ヶー一-龯]/gi, '')
    .toLowerCase();
}

function normalizedTeam(value) {
  const normalized = normalizedMatchPart(value);
  return TEAM_KEY_ALIASES[normalized] || normalized;
}

function normalizedCompetition(value) {
  const normalized = normalizedMatchPart(value);
  const aliases = {
    'プレミアリーグ': 'premierleague', premierleague: 'premierleague',
    'ラリーガ': 'laliga', laliga: 'laliga',
    'セリエa': 'seriea', seriea: 'seriea',
    'ブンデスリーガ': 'bundesliga', bundesliga: 'bundesliga',
    'リーグアン': 'ligue1', ligue1: 'ligue1',
    'チャンピオンズリーグ': 'championsleague', championsleague: 'championsleague',
  };
  return aliases[normalized] || normalized;
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0, 10))
    ? String(value).slice(0, 10)
    : null;
}

function dateKeyInTimeZone(value, timeZone) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}

function matchDateCandidates({ date, kickoff, timezone } = {}) {
  const candidates = new Set();
  const add = (value) => {
    const dateKey = validDateKey(value);
    if (dateKey) candidates.add(dateKey);
  };

  // API-FOOTBALL's fixture date is the primary Match Key date. For legacy
  // Notion records only, also allow the real kickoff day in UTC, Tokyo, and
  // the provider's declared timezone. This resolves midnight boundaries
  // without treating arbitrary adjacent dates as the same match.
  add(date);
  if (kickoff) {
    add(dateKeyInTimeZone(kickoff, 'UTC'));
    add(dateKeyInTimeZone(kickoff, 'Asia/Tokyo'));
    if (timezone && timezone !== 'UTC') add(dateKeyInTimeZone(kickoff, timezone));
  }
  return [...candidates];
}

export function canonicalMatchKey({ competition, date, homeTeam, awayTeam } = {}) {
  const dateKey = String(date || '').slice(0, 10);
  const parts = [normalizedCompetition(competition), dateKey, normalizedTeam(homeTeam), normalizedTeam(awayTeam)];
  return parts.every(Boolean) ? parts.join('|') : null;
}

export function matchKeyForMatch({ competition, date, homeTeam, awayTeam } = {}) {
  const dateKey = String(date || '').slice(0, 10);
  const competitionKey = normalizedCompetition(competition);
  const competitionLabel = MATCH_KEY_COMPETITION_LABELS[competitionKey] || compact(competition);
  const parts = [competitionLabel, dateKey, compact(homeTeam), compact(awayTeam)];
  return parts.every(Boolean) ? parts.join('|') : null;
}

function matchMetadata(page) {
  const matchKey = propertyText(page, 'Match Key');
  const homeTeam = propertyText(page, 'ホーム') || null;
  const awayTeam = propertyText(page, 'アウェイ') || null;
  const matchDate = propertyDate(page, '試合日');
  const competition = propertyText(page, '大会') || null;
  const homeTeamId = propertyInteger(page, HOME_TEAM_ID_PROPERTY_NAMES);
  const awayTeamId = propertyInteger(page, AWAY_TEAM_ID_PROPERTY_NAMES);
  return {
    // A dedicated API-Football fixture ID is the durable link. Match Key keeps
    // older Notion records and manually authored entries usable as a fallback.
    fixtureId: explicitFixtureId(page) || fixtureIdFromMatchKey(matchKey),
    ...(homeTeamId ? { homeTeamId } : {}),
    ...(awayTeamId ? { awayTeamId } : {}),
    matchKey: matchKey || null,
    canonicalKey: canonicalMatchKey({ competition, date: matchDate, homeTeam, awayTeam }),
    homeTeam,
    awayTeam,
    date: matchDate,
    competition,
  };
}

function idPropertyDefinition(properties, names) {
  const name = names.find((candidate) => properties?.[candidate]);
  const type = name ? properties[name]?.type : null;
  return name && ['number', 'rich_text', 'title'].includes(type) ? { name, type } : null;
}

function idPropertyFilter(definition, value) {
  if (!definition || !Number.isInteger(Number(value)) || Number(value) <= 0) return null;
  const id = Number(value);
  if (definition.type === 'number') return { property: definition.name, number: { equals: id } };
  if (definition.type === 'rich_text') return { property: definition.name, rich_text: { equals: String(id) } };
  if (definition.type === 'title') return { property: definition.name, title: { equals: String(id) } };
  return null;
}

function firstPropertyText(page, names) {
  for (const name of names) {
    const value = propertyText(page, name);
    if (value) return value;
  }
  return null;
}

function editorialFields(page, definitions) {
  return Object.fromEntries(Object.entries(definitions)
    .map(([key, names]) => [key, firstPropertyText(page, names)])
    .filter(([, value]) => Boolean(value)));
}

function cleanEditorialMarkdown(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizedEditorialHeading(value) {
  return normalizedMatchPart(value);
}

// A Notion callout is commonly used for AM4's three-line summary. It is
// represented as a block quote by blockMarkdown(), so treat it as a heading
// when it is followed by its child list/paragraphs.
function markdownEditorialSections(markdown) {
  const sections = [];
  let current = null;
  const flush = () => {
    const body = cleanEditorialMarkdown(current?.body);
    if (current?.heading && body) sections.push({ heading: current.heading, body });
  };

  String(markdown || '').replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const calloutHeading = line.match(/^>\s*(?:\*\*)?(3行要約|３行要約|予想3行要約|AM4要約)(?:\*\*)?\s*$/i);
    if (heading || calloutHeading) {
      flush();
      current = { heading: heading ? heading[1] : calloutHeading[1], body: '' };
      return;
    }
    if (current) current.body += `${line}\n`;
  });
  flush();
  return sections;
}

function editorialFieldsFromMarkdown(markdown, definitions) {
  const sections = markdownEditorialSections(markdown);
  return Object.fromEntries(Object.entries(definitions)
    .map(([field, aliases]) => {
      const normalizedAliases = aliases.map(normalizedEditorialHeading);
      const matches = sections.filter((section) => normalizedAliases.some((alias) => normalizedEditorialHeading(section.heading).includes(alias)));
      if (!matches.length) return [field, null];
      const value = matches.map((section) => (matches.length > 1 ? `${section.heading}\n${section.body}` : section.body)).join('\n\n');
      return [field, value];
    })
    .filter(([, value]) => Boolean(value)));
}

const PREDICTION_FIELDS = {
  summary: ['3行要約', '３行要約', '予想3行要約', 'AM4要約'],
  previousReview: ['前節レビュー', '前節の振り返り'],
  adjustments: ['前節からの修正', '修正ポイント', '予想修正'],
  tacticalMatchup: ['戦術的な噛み合わせ', '戦術分析', '戦術的ポイント'],
  keyPlayers: ['キープレイヤー', '注目選手'],
  absences: ['欠場情報', '欠場者', '出場停止'],
  matchOutlook: ['予想される試合展開', '試合展開', '展開予想'],
  rationale: ['予想の根拠', '根拠'],
};

const REPORT_FIELDS = {
  summary: ['3行要約', '３行要約', '試合要約', 'AM4要約'],
  keyFigures: ['試合主要人物', '主要人物', 'MOTM'],
  turningPoints: ['試合を分けたポイント', '勝負を分けたポイント'],
  firstHalf: ['前半レビュー', '前半'],
  secondHalf: ['後半レビュー', '後半'],
  tactics: ['戦術分析', '戦術解説', '戦術的なポイント', '戦術ポイント'],
  individualPerformance: ['個人パフォーマンス', '個人評価'],
  mainStats: ['主要スタッツ', '主なスタッツ'],
  resultMeaning: ['結果の意味', '結果が示すこと'],
  nextMatchFocus: ['次戦への課題', '次戦に向けて'],
};

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
    tags: propertyTags(page, ['タグ', 'Tags', 'Tag']),
    priority: propertyNumber(page, '表示優先度') ?? propertyNumber(page, '一覧優先度') ?? propertyNumber(page, 'Priority'),
    popularRank: propertyNumber(page, '人気順位') ?? propertyNumber(page, 'Popular Rank'),
    coverImage: propertyUrl(page, ['カバー画像', 'Cover Image', 'Image']),
    notion: {
      pageId: page?.id || null,
      pageUrl: page?.url || null,
      updatedAt: page?.last_edited_time || page?.created_time || null,
      state: propertyText(page, '記事状態') || null,
    },
  };

  if (type === 'match_report') {
    article.match = matchMetadata(page);
    article.report = {
      ...editorialFieldsFromMarkdown(markdown, REPORT_FIELDS),
      ...editorialFields(page, REPORT_FIELDS),
    };
    return article;
  }
  if (type === 'match_prediction') {
    article.match = matchMetadata(page);
    article.prediction = {
      score: propertyText(page, '予想スコア') || null,
      pick: propertyText(page, '本命') || null,
      confidence: propertyNumber(page, '確信度'),
      ...editorialFieldsFromMarkdown(markdown, PREDICTION_FIELDS),
      ...editorialFields(page, PREDICTION_FIELDS),
    };
    return article;
  }
  article.story = {
    topicKey: propertyText(page, 'Topic Key') || null,
    category: propertyText(page, 'カテゴリ') || null,
    subject: propertyText(page, '主題') || null,
    relatedClubs: propertyText(page, '関連クラブ') || null,
    tags: article.tags,
    ...twentySeasonsMetadata(page),
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

  async function queryPages(sourceId, { filter = null } = {}) {
    const pages = [];
    let cursor = null;
    do {
      const body = {
        page_size: 100,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        ...(filter ? { filter } : {}),
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

  async function queryAll(sourceId) {
    return queryPages(sourceId);
  }

  async function sourceProperties(sourceId) {
    const cached = sourceSchemaCache.get(sourceId);
    if (cached && cached.expiresAt > Date.now()) return cached.properties;
    const source = await request(`/data_sources/${encodeURIComponent(sourceId)}`);
    const properties = source?.properties && typeof source.properties === 'object' ? source.properties : {};
    sourceSchemaCache.set(sourceId, { properties, expiresAt: Date.now() + SOURCE_SCHEMA_CACHE_MS });
    return properties;
  }

  async function queryFixtureId(sourceId, fixtureId) {
    // Fixture ID is optional on the current AM4 sources. When it is added in
    // Notion later, use it before legacy Match Key fallback without requiring
    // a database-wide scan. A schema lookup failure must not suppress a valid
    // Match Key lookup, so it degrades quietly to the existing route.
    try {
      const properties = await sourceProperties(sourceId);
      const filter = idPropertyFilter(idPropertyDefinition(properties, FIXTURE_ID_PROPERTY_NAMES), fixtureId);
      return filter ? queryPages(sourceId, { filter }) : [];
    } catch {
      return [];
    }
  }

  async function queryTeamPair(sourceId, homeTeamId, awayTeamId) {
    try {
      const properties = await sourceProperties(sourceId);
      const homeFilter = idPropertyFilter(idPropertyDefinition(properties, HOME_TEAM_ID_PROPERTY_NAMES), homeTeamId);
      const awayFilter = idPropertyFilter(idPropertyDefinition(properties, AWAY_TEAM_ID_PROPERTY_NAMES), awayTeamId);
      if (!homeFilter || !awayFilter) return [];
      return queryPages(sourceId, { filter: { and: [homeFilter, awayFilter] } });
    } catch {
      return [];
    }
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

  return { queryAll, queryPages, queryFixtureId, queryTeamPair, pageMarkdown };
}

function matchIdentity(input = {}) {
  const date = validDateKey(input.date);
  const competition = compact(input.competition);
  const homeTeam = compact(input.homeTeam || input.home);
  const awayTeam = compact(input.awayTeam || input.away);
  const fixtureId = Number(input.fixtureId);
  const homeTeamId = Number(input.homeTeamId || input.homeId);
  const awayTeamId = Number(input.awayTeamId || input.awayId);
  const dateCandidates = matchDateCandidates({
    date,
    kickoff: input.kickoff,
    timezone: input.timezone,
  });
  const canonicalKey = canonicalMatchKey({ competition, date, homeTeam, awayTeam });
  const canonicalKeys = dateCandidates
    .map((candidate) => canonicalMatchKey({ competition, date: candidate, homeTeam, awayTeam }))
    .filter(Boolean);
  const matchKey = matchKeyForMatch({ competition, date, homeTeam, awayTeam });
  return {
    fixtureId: Number.isInteger(fixtureId) && fixtureId > 0 ? fixtureId : null,
    homeTeamId: Number.isInteger(homeTeamId) && homeTeamId > 0 ? homeTeamId : null,
    awayTeamId: Number.isInteger(awayTeamId) && awayTeamId > 0 ? awayTeamId : null,
    competition,
    date,
    dateCandidates,
    homeTeam,
    awayTeam,
    canonicalKey,
    canonicalKeys,
    matchKey,
  };
}

function hasExactExplicitFixtureId(page, fixtureId) {
  return Boolean(fixtureId && explicitFixtureId(page) === fixtureId);
}

function hasExactTeamPair(metadata, identity) {
  if (!identity.homeTeamId || !identity.awayTeamId) return false;
  if (metadata.homeTeamId !== identity.homeTeamId || metadata.awayTeamId !== identity.awayTeamId) return false;
  // A team pair alone is not a safe fixture identity: league/cup rematches and
  // reverse fixtures exist. Keep the same competition and one of the actual
  // provider/local calendar dates as part of this optional-ID fallback.
  return Boolean(
    metadata.date
    && identity.dateCandidates.includes(String(metadata.date).slice(0, 10))
    && metadata.competition
    && identity.competition
    && normalizedCompetition(metadata.competition) === normalizedCompetition(identity.competition)
  );
}

function pageMatchesIdentity(page, identity) {
  const metadata = matchMetadata(page);
  if (hasExactExplicitFixtureId(page, identity.fixtureId)) return 'fixture_id';
  if (hasExactTeamPair(metadata, identity)) return 'team_ids';
  if (identity.matchKey && metadata.matchKey === identity.matchKey) return 'match_key';
  if (!metadata.canonicalKey || !identity.canonicalKeys.includes(metadata.canonicalKey)) return null;
  // canonicalKey includes the competition, an actual provider/local date,
  // home and away after explicit aliases only. This makes the fallback
  // deterministic rather than an unsafe team-name-only association.
  return String(metadata.date || '').slice(0, 10) === identity.date
    ? 'canonical_match_key'
    : 'timezone_match_key';
}

function strongestIdentityMatch(pages, identity) {
  const candidates = (pages || []).map((page) => ({ page, method: pageMatchesIdentity(page, identity) })).filter((entry) => entry.method);
  const priority = { fixture_id: 5, team_ids: 4, match_key: 3, canonical_match_key: 2, timezone_match_key: 1 };
  return candidates.sort((a, b) => priority[b.method] - priority[a.method])[0] || null;
}

function notionFilterForMatchKey(matchKey) {
  return {
    property: 'Match Key',
    rich_text: { equals: matchKey },
  };
}

function notionFilterForDate(date) {
  return {
    property: '試合日',
    date: { equals: date },
  };
}

function articleFromPage(type, page, markdown) {
  return notionPageToArticle({ type, page, markdown });
}

async function findNotionMatchPage({ client, sourceId, identity, logger, type }) {
  const logPrefix = '[match-content]';
  let queryCount = 0;
  if (identity.fixtureId) {
    const fixtureCandidates = await client.queryFixtureId(sourceId, identity.fixtureId);
    queryCount += fixtureCandidates.length;
    const fixtureMatch = strongestIdentityMatch(fixtureCandidates, identity);
    logger?.info?.(`${logPrefix} ${type} fixture ID query`, { fixtureId: identity.fixtureId, count: fixtureCandidates.length, matched: Boolean(fixtureMatch) });
    if (fixtureMatch) return { page: fixtureMatch.page, matchMethod: fixtureMatch.method, queryCount };
  }
  if (identity.homeTeamId && identity.awayTeamId) {
    const teamCandidates = await client.queryTeamPair(sourceId, identity.homeTeamId, identity.awayTeamId);
    queryCount += teamCandidates.length;
    const teamMatch = strongestIdentityMatch(teamCandidates, identity);
    logger?.info?.(`${logPrefix} ${type} team ID query`, {
      homeTeamId: identity.homeTeamId,
      awayTeamId: identity.awayTeamId,
      count: teamCandidates.length,
      matched: Boolean(teamMatch),
    });
    if (teamMatch) return { page: teamMatch.page, matchMethod: teamMatch.method, queryCount };
  }
  let exactCandidates = [];
  if (identity.matchKey) {
    exactCandidates = await client.queryPages(sourceId, { filter: notionFilterForMatchKey(identity.matchKey) });
    queryCount += exactCandidates.length;
    logger?.info?.(`${logPrefix} ${type} exact query`, { matchKey: identity.matchKey, count: exactCandidates.length });
  }
  const exact = strongestIdentityMatch(exactCandidates, identity);
  if (exact) return { page: exact.page, matchMethod: exact.method, queryCount };

  // Team aliases cannot be sent safely as an OR filter. Query each actual
  // provider/local date candidate, then use the full canonical identity to
  // decide the match. This is deliberately not a blind ±1-day fuzzy search.
  const dateCandidates = [];
  for (const date of identity.dateCandidates) {
    const pages = await client.queryPages(sourceId, { filter: notionFilterForDate(date) });
    queryCount += pages.length;
    dateCandidates.push(...pages);
  }
  const matched = strongestIdentityMatch(dateCandidates, identity);
  logger?.info?.(`${logPrefix} ${type} date fallback`, {
    matchKey: identity.matchKey,
    dateCandidates: identity.dateCandidates,
    count: dateCandidates.length,
    matched: Boolean(matched),
  });
  return { page: matched?.page || null, matchMethod: matched?.method || null, queryCount };
}

// Reads only the two AM4 editorial sources for one fixture. This is deliberately
// separate from the archive synchronizer: a newly authored Notion page can reach
// MATCH DETAIL without waiting for a full Blob mirror refresh.
export async function fetchNotionMatchContent({
  match,
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  logger = console,
} = {}) {
  const identity = matchIdentity(match);
  if (!identity.canonicalKey || !identity.matchKey) {
    throw new Error('competition, date, homeTeam and awayTeam are required for a Match Key');
  }
  const client = createNotionClient({ apiKey, fetcher });
  const definitions = resolveSourceDefinitions(sourceIds)
    .filter((source) => source.type === 'match_prediction' || source.type === 'match_report');
  const result = {
    matchKey: identity.matchKey,
    canonicalKey: identity.canonicalKey,
    prediction: null,
    report: null,
    errors: {},
  };

  logger?.info?.('[match-content] match identity', {
    fixtureId: identity.fixtureId,
    homeTeamId: identity.homeTeamId,
    awayTeamId: identity.awayTeamId,
    matchKey: identity.matchKey,
    canonicalKey: identity.canonicalKey,
    dateCandidates: identity.dateCandidates,
  });

  await Promise.all(definitions.map(async (source) => {
    try {
      const found = await findNotionMatchPage({ client, sourceId: source.sourceId, identity, logger, type: source.type });
      if (!found.page) {
        logger?.info?.('[match-content] article not found', { type: source.type, matchKey: identity.matchKey, queryCount: found.queryCount });
        return;
      }
      const state = propertyText(found.page, '記事状態');
      if (!isPublishableNotionState(state)) {
        logger?.info?.('[match-content] matched article is not publishable', { type: source.type, pageId: found.page.id, state, matchKey: identity.matchKey });
        return;
      }
      const markdown = await client.pageMarkdown(found.page.id);
      const article = articleFromPage(source.type, found.page, markdown);
      if (source.type === 'match_prediction') result.prediction = article;
      if (source.type === 'match_report') result.report = article;
      logger?.info?.('[match-content] article matched', {
        type: source.type,
        pageId: found.page.id,
        matchMethod: found.matchMethod,
        matchKey: identity.matchKey,
      });
    } catch (error) {
      result.errors[source.type] = 'unavailable';
      logger?.error?.('[match-content] Notion source unavailable', {
        type: source.type,
        matchKey: identity.matchKey,
        message: error instanceof Error ? error.message : 'Unknown Notion error',
      });
    }
  }));

  logger?.info?.('[match-content] result', {
    matchKey: identity.matchKey,
    prediction: Boolean(result.prediction),
    report: Boolean(result.report),
    errors: Object.keys(result.errors),
  });
  return result;
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
