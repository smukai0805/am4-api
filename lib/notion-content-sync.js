// Notion is the editorial source of truth. This module is intentionally server-only:
// the browser reads the existing AM4 article archive and never receives a Notion token.

import matchArchive from '../match-archive.js';
import playerCards from '../prediction-key-players.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2026-03-11';
// General editorial content requires an explicit publication state. AM4's
// established match-editorial workflow is the narrow exception: finished-match
// reports and their paired predictions are marked `自動生成` in Notion when
// they are ready for the public match surface. Keep that exception scoped to
// these two types so a newly generated story and every review/private state
// remain non-public. Previously published legacy archives retain their own
// explicit publication record until their Notion page is moved to a review or
// private state; that compatibility behavior is intentionally separate.
const PUBLISHABLE_STATES = new Set(['公開準備', '公開済']);
const AUTO_PUBLISHABLE_MATCH_EDITORIAL_TYPES = new Set(['match_prediction', 'match_report']);

const MATCH_KEY_COMPETITION_LABELS = {
  premierleague: 'Premier League',
  laliga: 'La Liga',
  seriea: 'Serie A',
  bundesliga: 'Bundesliga',
  ligue1: 'Ligue 1',
  championsleague: 'Champions League',
  europaleague: 'Europa League',
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
// Keep an individual upstream operation well below the monitor worker's
// execution budget.  A rate-limit response is *not* slept through here: its
// Retry-After is returned to the durable queue, which resumes it no earlier
// than Notion requested and without holding a Vercel Function open.
const NOTION_REQUEST_TIMEOUT_MS = 8_000;
const NOTION_REQUEST_MAX_ATTEMPTS = 3;
const NOTION_RETRY_BASE_MS = 500;
const NOTION_RATE_LIMIT_FALLBACK_MS = 60_000;
const MIN_NOTION_BODY_STEP_MS = 5_000;
const MIN_SYNC_MEDIA_STEP_MS = 15_000;
// Bump this when the compact match identity changes so the next sync repairs
// older archive rows even if their Notion page itself was not edited.
const MATCH_IDENTITY_VERSION = 2;

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
  const number = value?.type === 'number' ? value.number : null;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function propertyPercentage(page, name) {
  const number = propertyNumber(page, name);
  return number != null && number >= 0 && number <= 100 ? number : null;
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

// These optional fields can be added to the existing editorial sources when
// an editor has a verified API-Football identity.  The sync accepts numeric,
// text, and multi-select values so the schema can evolve without forcing a
// one-off mass migration.  It never guesses IDs from article prose.
const RELATED_TEAM_IDS_PROPERTY_NAMES = [
  'Related Team IDs', 'relatedTeamIds', '関連チームID', '関連チーム IDs',
  'API-FOOTBALL Team IDs',
];
const RELATED_PLAYER_IDS_PROPERTY_NAMES = [
  'Related Player IDs', 'relatedPlayerIds', '関連選手ID', '関連選手 IDs',
  'API-FOOTBALL Player IDs',
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

function propertyPositiveIds(page, names) {
  const ids = [];
  const add = (candidate) => {
    const text = String(candidate ?? '').trim();
    if (!/^[1-9]\d*$/.test(text)) return;
    const id = Number(text);
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  };
  for (const name of names) {
    const property = page?.properties?.[name];
    if (!property) continue;
    if (property.type === 'multi_select') {
      property.multi_select?.forEach((item) => add(item?.name));
      continue;
    }
    if (property.type === 'relation') {
      property.relation?.forEach((item) => add(item?.id));
      continue;
    }
    const value = propertyText(page, name);
    value.split(/[／/,、\s\n]+/u).forEach(add);
  }
  return ids;
}

function explicitFixtureId(page) {
  return propertyInteger(page, FIXTURE_ID_PROPERTY_NAMES);
}

const normalizedMatchPart = matchArchive.normalizedPart;
const normalizedTeam = matchArchive.normalizedTeam;
const normalizedCompetition = matchArchive.normalizedCompetition;

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
  return matchArchive.canonicalMatchKey({ competition, date, homeTeam, awayTeam });
}

export function matchKeyForMatch({ competition, date, homeTeam, awayTeam } = {}) {
  const dateKey = String(date || '').slice(0, 10);
  const competitionKey = normalizedCompetition(competition);
  const competitionLabel = MATCH_KEY_COMPETITION_LABELS[competitionKey] || compact(competition);
  const parts = [competitionLabel, dateKey, compact(homeTeam), compact(awayTeam)];
  return parts.every(Boolean) ? parts.join('|') : null;
}

function matchKeyParts(matchKey) {
  const parts = String(matchKey || '').split('|').map(compact);
  if (parts.length !== 4 || !parts.every(Boolean) || !validDateKey(parts[1])) return null;
  return {
    competition: parts[0],
    date: parts[1],
    homeTeam: parts[2],
    awayTeam: parts[3],
  };
}

function matchMetadata(page) {
  const matchKey = propertyText(page, 'Match Key');
  const keyParts = matchKeyParts(matchKey);
  const homeTeam = propertyText(page, 'ホーム') || keyParts?.homeTeam || null;
  const awayTeam = propertyText(page, 'アウェイ') || keyParts?.awayTeam || null;
  const matchDate = propertyDate(page, '試合日') || keyParts?.date || null;
  const competition = propertyText(page, '大会') || keyParts?.competition || null;
  const homeTeamId = propertyInteger(page, HOME_TEAM_ID_PROPERTY_NAMES);
  const awayTeamId = propertyInteger(page, AWAY_TEAM_ID_PROPERTY_NAMES);
  return {
    identityVersion: MATCH_IDENTITY_VERSION,
    // A dedicated API-Football fixture ID is the durable link. Match Key keeps
    // older Notion records and manually authored entries usable as a fallback.
    fixtureId: explicitFixtureId(page) || fixtureIdFromMatchKey(matchKey),
    ...(homeTeamId ? { homeTeamId } : {}),
    ...(awayTeamId ? { awayTeamId } : {}),
    matchKey: matchKey || matchKeyForMatch({ competition, date: matchDate, homeTeam, awayTeam }),
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
  keyPlayers: ['キープレイヤー', 'キーマン', '注目選手', 'key player'],
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

export function isPublishableNotionState(state, type = null) {
  const normalizedState = String(state || '').trim();
  return PUBLISHABLE_STATES.has(normalizedState)
    || (normalizedState === '自動生成' && AUTO_PUBLISHABLE_MATCH_EDITORIAL_TYPES.has(type));
}

function isLegacyGeneratedState(state) {
  return String(state || '').trim() === '自動生成';
}

export function markdownExcerpt(markdown, limit = 150) {
  const lines = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const content = (line) => compact(String(line || '')
    .replace(/^>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, ''));
  const first = content(lines[0]).toLocaleLowerCase('en-US');
  const listed = lines.filter((line) => /^(?:[-*+]|\d+[.)])\s+/.test(line));
  const numbered = lines.filter((line) => /^\d+[.)]\s+/.test(line));
  const hasStructuralHeading = /^(?:目次|contents?|table\s+of\s+contents|agenda|アジェンダ|出典|sources?|references?)(?:$|\s|[:：])/u.test(first);
  if ((hasStructuralHeading && listed.length >= 2) || (numbered.length >= 2 && numbered.length === lines.length)) return '';
  const candidates = lines
    .filter((line) => !/^#{1,6}\s/.test(line))
    .map(content)
    .filter(Boolean);
  const value = compact(candidates.join(' '));
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || '').replace(/[),.;:]+$/u, ''));
    return /^https?:$/i.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sourceHeading(line) {
  const value = compact(String(line || '')
    .replace(/^>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*/g, ''))
    .toLocaleLowerCase('en-US');
  return /^(?:出典|参考|sources?|references?)(?:$|\s|[:：])/u.test(value);
}

function sourceEntriesFromLine(line) {
  const value = String(line || '');
  const entries = [];
  const seen = new Set();
  const add = (title, rawUrl) => {
    const url = safeSourceUrl(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    let fallbackTitle = compact(title)
      .replace(/^>\s?/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^(?:出典|参考|sources?|references?)\s*[:：]?\s*/iu, '')
      .replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/https?:\/\/\S+/gi, '')
      .trim();
    if (!fallbackTitle) {
      try { fallbackTitle = new URL(url).hostname.replace(/^www\./, ''); } catch { fallbackTitle = url; }
    }
    entries.push({ title: fallbackTitle, url });
  };
  const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let link;
  while ((link = markdownLink.exec(value))) add(link[1], link[2]);
  const bareUrl = /https?:\/\/[^\s)<]+/gi;
  let raw;
  while ((raw = bareUrl.exec(value))) {
    const before = value.slice(0, raw.index);
    const linkAlreadyAdded = entries.some((entry) => entry.url === safeSourceUrl(raw[0]));
    if (!linkAlreadyAdded) add(before, raw[0]);
  }
  return entries;
}

// Keep valid source references available in the structured reader UI, while
// leaving unparseable lines in the body rather than silently discarding them.
export function normalizeNotionContent(markdown) {
  const body = [];
  const sources = [];
  const sourceUrls = new Set();
  let inSourceBlock = false;
  for (const line of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^\s*#{1,6}\s+/.test(line);
    if (sourceHeading(line)) {
      inSourceBlock = true;
      continue;
    }
    if (inSourceBlock && heading) inSourceBlock = false;
    const markedSource = /^\s*(?:>|[-*+]\s*)?(?:出典|参考|sources?|references?)\s*[:：]/iu.test(line);
    const entries = (inSourceBlock || markedSource) ? sourceEntriesFromLine(line) : [];
    if (entries.length) {
      entries.forEach((entry) => {
        if (sourceUrls.has(entry.url)) return;
        sourceUrls.add(entry.url);
        sources.push(entry);
      });
      continue;
    }
    body.push(line);
  }
  return { body: body.join('\n').replace(/\n{3,}/g, '\n\n').trim(), sources };
}

function blockText(block) {
  const payload = block?.[block?.type];
  return richTextText(payload?.rich_text);
}

function blockMarkdown(block, orderedListIndex = 0) {
  const value = blockText(block);
  if (!value && block?.type !== 'divider') return '';
  switch (block?.type) {
    case 'heading_1': return `# ${value}`;
    case 'heading_2': return `## ${value}`;
    case 'heading_3': return `### ${value}`;
    case 'bulleted_list_item': return `- ${value}`;
    case 'numbered_list_item': return `${orderedListIndex || 1}. ${value}`;
    case 'quote':
    case 'callout': return `> ${value}`;
    case 'divider': return '---';
    case 'paragraph': return value;
    default: return value;
  }
}

// Notion represents every ordered-list item as an individual block. The item
// number is local to its contiguous list, not the page-wide block position.
// Keeping this pure seam also prevents a later renderer from receiving leaked
// internal indexes such as "35." and "36." as editorial copy.
export function notionBlocksToMarkdown(blocks) {
  const lines = [];
  let orderedListIndex = 0;
  for (const block of blocks || []) {
    if (block?.type === 'numbered_list_item') orderedListIndex += 1;
    else orderedListIndex = 0;
    const line = blockMarkdown(block, orderedListIndex);
    if (line) lines.push(line);
  }
  return lines.join('\n\n');
}

// Generated reports are written to Notion first, then travel through the
// normal page synchronizer.  These helpers intentionally keep the write
// payload narrow and schema-driven: a changed Notion schema must defer the
// fixture for review rather than silently creating a malformed public page.
const MAX_GENERATED_NOTION_BLOCKS = 100;
const MAX_NOTION_RICH_TEXT_CHARS = 1_800;

export class NotionSchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NotionSchemaError';
    this.code = 'NOTION_SCHEMA_UNSUPPORTED';
    this.details = details;
  }
}

function splitNotionText(value, limit = MAX_NOTION_RICH_TEXT_CHARS) {
  const parts = [];
  let current = '';
  for (const character of Array.from(String(value || ''))) {
    if (current.length + character.length > limit && current) {
      parts.push(current);
      current = '';
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function notionRichText(value) {
  return splitNotionText(value).map((content) => ({ type: 'text', text: { content } }));
}

function schemaOptions(definition) {
  const type = definition?.type;
  const options = definition?.[type]?.options;
  return Array.isArray(options) ? options.map((option) => String(option?.name || '')).filter(Boolean) : [];
}

function resolveSchemaChoice(definition, value, name) {
  const desired = compact(value);
  const options = schemaOptions(definition);
  const direct = options.find((option) => option === desired);
  const normalised = direct || options.find((option) => normalizedMatchPart(option) === normalizedMatchPart(desired))
    || options.find((option) => normalizedCompetition(option) === normalizedCompetition(desired));
  if (!normalised) {
    throw new NotionSchemaError(`Notion property ${name} does not contain the required option`, {
      property: name, value: desired, options,
    });
  }
  return normalised;
}

function propertyPayload(definition, value, name, { strictChoice = false } = {}) {
  if (!definition?.type) throw new NotionSchemaError(`Notion property ${name} is missing`, { property: name });
  const type = definition.type;
  const textValue = compact(value);
  if (type === 'title') return { title: notionRichText(textValue) };
  if (type === 'rich_text') return { rich_text: notionRichText(textValue) };
  if (type === 'date') return { date: { start: textValue } };
  if (type === 'number') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new NotionSchemaError(`Notion property ${name} requires a number`, { property: name, value });
    return { number: numeric };
  }
  if (type === 'select') {
    const choice = strictChoice ? resolveSchemaChoice(definition, textValue, name) : textValue;
    return { select: { name: choice } };
  }
  if (type === 'status') {
    const choice = strictChoice ? resolveSchemaChoice(definition, textValue, name) : textValue;
    return { status: { name: choice } };
  }
  if (type === 'multi_select') {
    const choice = strictChoice ? resolveSchemaChoice(definition, textValue, name) : textValue;
    return { multi_select: [{ name: choice }] };
  }
  throw new NotionSchemaError(`Notion property ${name} has an unsupported type`, { property: name, type });
}

function requiredSchemaProperty(schema, name, allowedTypes) {
  const definition = schema?.[name];
  if (!definition || !allowedTypes.includes(definition.type)) {
    throw new NotionSchemaError(`Notion property ${name} is unavailable for generated reports`, {
      property: name, type: definition?.type || null, allowedTypes,
    });
  }
  return definition;
}

function optionalSchemaProperty(schema, names, allowedTypes) {
  const name = names.find((candidate) => schema?.[candidate] && allowedTypes.includes(schema[candidate].type));
  return name ? { name, definition: schema[name] } : null;
}

function generatedReportTitle(match) {
  const date = validDateKey(match?.date) || '試合';
  const home = compact(match?.homeTeam || match?.home) || 'Home';
  const away = compact(match?.awayTeam || match?.away) || 'Away';
  const homeGoals = Number.isFinite(Number(match?.homeGoals)) ? Number(match.homeGoals) : '?';
  const awayGoals = Number.isFinite(Number(match?.awayGoals)) ? Number(match.awayGoals) : '?';
  return `${date} ${home} ${homeGoals}-${awayGoals} ${away}｜試合解説`.slice(0, 180);
}

function generatedPredictionTitle(match) {
  const date = validDateKey(match?.date) || '試合';
  const competition = compact(match?.competition) || 'Football';
  const home = compact(match?.homeTeam || match?.home) || 'Home';
  const away = compact(match?.awayTeam || match?.away) || 'Away';
  return `${date}｜${competition}｜${home} vs ${away}｜試合予想`.slice(0, 180);
}

function generatedReportProperties(schema, match, identity, now) {
  const title = requiredSchemaProperty(schema, '記事タイトル', ['title']);
  const state = requiredSchemaProperty(schema, '記事状態', ['select', 'status']);
  const matchKey = requiredSchemaProperty(schema, 'Match Key', ['rich_text', 'title']);
  const date = requiredSchemaProperty(schema, '試合日', ['date']);
  const competition = requiredSchemaProperty(schema, '大会', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const home = requiredSchemaProperty(schema, 'ホーム', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const away = requiredSchemaProperty(schema, 'アウェイ', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const publicationState = ['自動生成', '公開準備'].find((candidate) => schemaOptions(state).includes(candidate));
  if (!publicationState) {
    throw new NotionSchemaError('Notion report source has no approved generated publication state', {
      property: '記事状態', options: schemaOptions(state),
    });
  }
  const dateValue = validDateKey(match?.date);
  if (!dateValue || !identity.matchKey || !identity.homeTeam || !identity.awayTeam || !identity.competition) {
    throw new NotionSchemaError('Generated report lacks a complete fixture identity', {
      fixtureId: identity.fixtureId, date: dateValue, matchKey: identity.matchKey,
    });
  }
  const properties = {
    記事タイトル: propertyPayload(title, generatedReportTitle(match), '記事タイトル'),
    記事状態: propertyPayload(state, publicationState, '記事状態', { strictChoice: true }),
    'Match Key': propertyPayload(matchKey, identity.matchKey, 'Match Key'),
    試合日: propertyPayload(date, dateValue, '試合日'),
    大会: propertyPayload(competition, identity.competition, '大会', { strictChoice: ['select', 'status', 'multi_select'].includes(competition.type) }),
    ホーム: propertyPayload(home, identity.homeTeam, 'ホーム', { strictChoice: ['select', 'status', 'multi_select'].includes(home.type) }),
    アウェイ: propertyPayload(away, identity.awayTeam, 'アウェイ', { strictChoice: ['select', 'status', 'multi_select'].includes(away.type) }),
  };
  const fixtureId = Number(identity.fixtureId);
  const fixtureProperty = optionalSchemaProperty(schema, FIXTURE_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (fixtureProperty && Number.isSafeInteger(fixtureId) && fixtureId > 0) {
    properties[fixtureProperty.name] = propertyPayload(fixtureProperty.definition, fixtureId, fixtureProperty.name);
  }
  const generatedAt = optionalSchemaProperty(schema, ['生成日時'], ['date']);
  if (generatedAt) properties[generatedAt.name] = propertyPayload(generatedAt.definition, new Date(now()).toISOString(), generatedAt.name);
  const homeId = Number(identity.homeTeamId);
  const homeIdProperty = optionalSchemaProperty(schema, HOME_TEAM_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (homeIdProperty && Number.isSafeInteger(homeId) && homeId > 0) {
    properties[homeIdProperty.name] = propertyPayload(homeIdProperty.definition, homeId, homeIdProperty.name);
  }
  const awayId = Number(identity.awayTeamId);
  const awayIdProperty = optionalSchemaProperty(schema, AWAY_TEAM_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (awayIdProperty && Number.isSafeInteger(awayId) && awayId > 0) {
    properties[awayIdProperty.name] = propertyPayload(awayIdProperty.definition, awayId, awayIdProperty.name);
  }
  return { properties, publicationState };
}

function generatedPredictionProperties(schema, match, identity, prediction, now) {
  const title = requiredSchemaProperty(schema, '記事タイトル', ['title']);
  const state = requiredSchemaProperty(schema, '記事状態', ['select', 'status']);
  const matchKey = requiredSchemaProperty(schema, 'Match Key', ['rich_text', 'title']);
  const date = requiredSchemaProperty(schema, '試合日', ['date']);
  const competition = requiredSchemaProperty(schema, '大会', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const home = requiredSchemaProperty(schema, 'ホーム', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const away = requiredSchemaProperty(schema, 'アウェイ', ['rich_text', 'title', 'select', 'status', 'multi_select']);
  const score = requiredSchemaProperty(schema, '予想スコア', ['rich_text', 'title']);
  const pick = requiredSchemaProperty(schema, '本命', ['rich_text', 'title', 'select', 'status']);
  const confidence = requiredSchemaProperty(schema, '確信度', ['number']);
  const publicationState = ['自動生成', '公開準備'].find((candidate) => schemaOptions(state).includes(candidate));
  if (!publicationState) {
    throw new NotionSchemaError('Notion prediction source has no approved generated publication state', {
      property: '記事状態', options: schemaOptions(state),
    });
  }
  const dateValue = validDateKey(match?.date);
  const predictedScore = compact(prediction?.score);
  const predictedPick = compact(prediction?.pick);
  const predictedConfidence = Number(prediction?.confidence);
  if (
    !dateValue || !identity.matchKey || !identity.homeTeam || !identity.awayTeam || !identity.competition
    || !/^\d{1,2}-\d{1,2}$/u.test(predictedScore)
    || !predictedPick
    || !Number.isFinite(predictedConfidence)
    || predictedConfidence < 0
    || predictedConfidence > 100
  ) {
    throw new NotionSchemaError('Generated prediction lacks a complete verified fixture identity or prediction metadata', {
      fixtureId: identity.fixtureId, date: dateValue, matchKey: identity.matchKey,
    });
  }
  const properties = {
    記事タイトル: propertyPayload(title, generatedPredictionTitle(match), '記事タイトル'),
    記事状態: propertyPayload(state, publicationState, '記事状態', { strictChoice: true }),
    'Match Key': propertyPayload(matchKey, identity.matchKey, 'Match Key'),
    試合日: propertyPayload(date, dateValue, '試合日'),
    大会: propertyPayload(competition, identity.competition, '大会', { strictChoice: ['select', 'status', 'multi_select'].includes(competition.type) }),
    ホーム: propertyPayload(home, identity.homeTeam, 'ホーム', { strictChoice: ['select', 'status', 'multi_select'].includes(home.type) }),
    アウェイ: propertyPayload(away, identity.awayTeam, 'アウェイ', { strictChoice: ['select', 'status', 'multi_select'].includes(away.type) }),
    予想スコア: propertyPayload(score, predictedScore, '予想スコア'),
    本命: propertyPayload(pick, predictedPick, '本命', { strictChoice: ['select', 'status'].includes(pick.type) }),
    確信度: propertyPayload(confidence, Math.round(predictedConfidence), '確信度'),
  };
  const fixtureId = Number(identity.fixtureId);
  const fixtureProperty = optionalSchemaProperty(schema, FIXTURE_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (fixtureProperty && Number.isSafeInteger(fixtureId) && fixtureId > 0) {
    properties[fixtureProperty.name] = propertyPayload(fixtureProperty.definition, fixtureId, fixtureProperty.name);
  }
  const generatedAt = optionalSchemaProperty(schema, ['生成日時'], ['date']);
  if (generatedAt) properties[generatedAt.name] = propertyPayload(generatedAt.definition, new Date(now()).toISOString(), generatedAt.name);
  const homeId = Number(identity.homeTeamId);
  const homeIdProperty = optionalSchemaProperty(schema, HOME_TEAM_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (homeIdProperty && Number.isSafeInteger(homeId) && homeId > 0) {
    properties[homeIdProperty.name] = propertyPayload(homeIdProperty.definition, homeId, homeIdProperty.name);
  }
  const awayId = Number(identity.awayTeamId);
  const awayIdProperty = optionalSchemaProperty(schema, AWAY_TEAM_ID_PROPERTY_NAMES, ['number', 'rich_text', 'title']);
  if (awayIdProperty && Number.isSafeInteger(awayId) && awayId > 0) {
    properties[awayIdProperty.name] = propertyPayload(awayIdProperty.definition, awayId, awayIdProperty.name);
  }
  return { properties, publicationState };
}

// Preserve all generated text while keeping the creation atomic: Notion's
// create-page endpoint accepts at most 100 child blocks, so oversized output
// is deferred instead of publishing a partial report and silently losing its
// tail. Generated pages are intentionally flat; the normal page reader then
// follows every block without a nested-depth cutoff.
export function notionMarkdownToBlocks(markdown) {
  const blocks = [];
  const add = (type, value) => {
    for (const part of splitNotionText(value)) {
      blocks.push({ object: 'block', type, [type]: { rich_text: notionRichText(part) } });
    }
  };
  for (const rawLine of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      add(`heading_${heading[1].length}`, heading[2]);
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/u);
    if (bullet) {
      add('bulleted_list_item', bullet[1]);
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/u);
    if (numbered) {
      add('numbered_list_item', numbered[1]);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/u);
    if (quote) {
      add('quote', quote[1]);
      continue;
    }
    if (line === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }
    add('paragraph', line);
  }
  if (!blocks.length) throw new NotionSchemaError('Generated report body is empty');
  if (blocks.length > MAX_GENERATED_NOTION_BLOCKS) {
    throw new NotionSchemaError('Generated report exceeds the atomic Notion block limit', {
      blocks: blocks.length, maxBlocks: MAX_GENERATED_NOTION_BLOCKS,
    });
  }
  return blocks;
}

function safeGeneratedSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function generatedMarkdownWithSources(draft, sources) {
  const body = String(draft || '').replace(/\r\n?/g, '\n').trim();
  const sourceLines = (Array.isArray(sources) ? sources : []).map((source) => {
    const url = safeGeneratedSourceUrl(source?.url);
    if (!url) return null;
    const title = compact(source?.title) || '試合資料';
    return `- [${title.slice(0, 160)}](${url})`;
  }).filter(Boolean);
  if (!body) throw new NotionSchemaError('Generated report body is empty');
  if (!sourceLines.length) throw new NotionSchemaError('Generated report has no verified source references');
  return `${body}\n\n## 出典\n${[...new Set(sourceLines)].join('\n')}`;
}

export async function publishGeneratedMatchReport({
  match,
  draft,
  sources,
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  client: suppliedClient = null,
  now = () => new Date(),
  deadlineAt = null,
  consumeRequest = null,
} = {}) {
  const source = resolveSourceDefinitions(sourceIds).find((entry) => entry.type === 'match_report');
  if (!source) throw new NotionSchemaError('Match report source is unavailable');
  const identity = matchIdentity(match);
  const client = suppliedClient || createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  const schema = await client.sourceProperties(source.sourceId);
  const { properties, publicationState } = generatedReportProperties(schema, match, identity, now);
  const markdown = generatedMarkdownWithSources(draft, sources);
  const children = notionMarkdownToBlocks(markdown);
  let page;
  try {
    page = await client.createPage({
      parent: { type: 'data_source_id', data_source_id: source.sourceId },
      properties,
      children,
    });
  } catch (error) {
    // A POST timeout/5xx is ambiguous: Notion may have accepted the page even
    // though it did not return it to us.  Preserve that fact for the durable
    // worker so it performs a source lookup/manual hold instead of making a
    // second same-fixture page on its next attempt.
    if (
      error
      && (error.code === 'NOTION_REQUEST_TIMEOUT'
        || (error.code === 'NOTION_HTTP_ERROR' && Number(error.status) >= 500))
    ) error.notionCreateOutcomeUnknown = true;
    throw error;
  }
  if (!page?.id) throw new NotionSchemaError('Notion did not return a created page ID');
  return {
    page,
    sourceId: source.sourceId,
    sourceVersion: page.last_edited_time || page.created_time || null,
    identity,
    publicationState,
    markdown,
  };
}

// Prediction recovery shares the same schema-checked, atomic Notion writer as
// match reports, but deliberately requires preview-specific metadata.  It is
// called only after a fixture-first worker has confirmed that no source page
// already exists, so it cannot turn a mirror outage into a duplicate draft.
export async function publishGeneratedMatchPrediction({
  match,
  prediction,
  draft,
  sources,
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  client: suppliedClient = null,
  now = () => new Date(),
  deadlineAt = null,
  consumeRequest = null,
} = {}) {
  const source = resolveSourceDefinitions(sourceIds).find((entry) => entry.type === 'match_prediction');
  if (!source) throw new NotionSchemaError('Match prediction source is unavailable');
  const identity = matchIdentity(match);
  const client = suppliedClient || createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  const schema = await client.sourceProperties(source.sourceId);
  const { properties, publicationState } = generatedPredictionProperties(schema, match, identity, prediction, now);
  const markdown = generatedMarkdownWithSources(draft, sources);
  const children = notionMarkdownToBlocks(markdown);
  let page;
  try {
    page = await client.createPage({
      parent: { type: 'data_source_id', data_source_id: source.sourceId },
      properties,
      children,
    });
  } catch (error) {
    if (
      error
      && (error.code === 'NOTION_REQUEST_TIMEOUT'
        || (error.code === 'NOTION_HTTP_ERROR' && Number(error.status) >= 500))
    ) error.notionCreateOutcomeUnknown = true;
    throw error;
  }
  if (!page?.id) throw new NotionSchemaError('Notion did not return a created prediction page ID');
  return {
    page,
    sourceId: source.sourceId,
    sourceVersion: page.last_edited_time || page.created_time || null,
    identity,
    publicationState,
    markdown,
  };
}

export function notionArticleId(type, pageId) {
  return `notion-${type}-${String(pageId || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

export function notionPageToArticle({ type, page, markdown }) {
  const title = propertyText(page, '記事タイトル') || compact(page?.url).split('/').at(-1) || 'AM4記事';
  const content = normalizeNotionContent(markdown);
  const article = {
    id: notionArticleId(type, page?.id),
    type,
    contentKind: `notion_${type}`,
    title,
    publishedAt: propertyDate(page, '生成日時') || page?.last_edited_time || page?.created_time || new Date().toISOString(),
    body: content.body,
    deck: markdownExcerpt(content.body),
    summary: markdownExcerpt(content.body),
    sources: content.sources,
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
  const relatedTeamIds = propertyPositiveIds(page, RELATED_TEAM_IDS_PROPERTY_NAMES);
  const relatedPlayerIds = propertyPositiveIds(page, RELATED_PLAYER_IDS_PROPERTY_NAMES);
  if (relatedTeamIds.length) article.relatedTeamIds = relatedTeamIds;
  if (relatedPlayerIds.length) article.relatedPlayerIds = relatedPlayerIds;

  if (type === 'match_report') {
    article.match = matchMetadata(page);
    article.report = {
      ...editorialFieldsFromMarkdown(content.body, REPORT_FIELDS),
      ...editorialFields(page, REPORT_FIELDS),
    };
    return article;
  }
  if (type === 'match_prediction') {
    article.match = matchMetadata(page);
    article.prediction = {
      score: propertyText(page, '予想スコア') || null,
      pick: propertyText(page, '本命') || null,
      confidence: propertyPercentage(page, '確信度'),
      ...editorialFieldsFromMarkdown(content.body, PREDICTION_FIELDS),
      ...editorialFields(page, PREDICTION_FIELDS),
    };
    // Keep the authored name, club and rationale as one structured field in
    // the mirror. Provider IDs and image URLs are filled only after a match's
    // real fixture teams have been verified, never from free-form Notion text.
    const fixture = {
      home: { id: article.match.homeTeamId, name: article.match.homeTeam },
      away: { id: article.match.awayTeamId, name: article.match.awayTeam },
    };
    article.prediction.keyPlayerCards = playerCards.parsePredictionEntries(
      article.prediction.keyPlayers,
      fixture,
    ).filter((entry) => entry.type === 'player').map((entry) => ({
      playerName: entry.playerName,
      clubName: entry.clubName,
      clubLabel: entry.clubLabel,
      reason: entry.reason,
      teamId: entry.teamId,
      side: entry.side,
      resolved: false,
    }));
    return article;
  }
  article.story = {
    topicKey: propertyText(page, 'Topic Key') || null,
    category: propertyText(page, 'カテゴリ') || null,
    subject: propertyText(page, '主題') || null,
    relatedClubs: propertyText(page, '関連クラブ') || null,
    relatedTeamIds,
    relatedPlayerIds,
    tags: article.tags,
    ...twentySeasonsMetadata(page),
  };
  return article;
}

// The Notion body remains the source for selection and rationale. Verified
// provider IDs and media live in the public mirror, so retain them only when
// the newly parsed selection still resolves to the same side/team/player.
// The card merger declines a changed selection rather than carrying a
// portrait forward by name guesswork.
export function retainVerifiedPredictionKeyPlayerCards(article, existingArticle) {
  if (article?.type !== 'match_prediction' || !article?.prediction?.keyPlayers) return article;
  const retained = existingArticle?.prediction?.keyPlayerCards;
  if (!Array.isArray(retained) || !retained.some((card) => card?.resolved)) return article;
  const fixture = {
    home: { id: article.match?.homeTeamId, name: article.match?.homeTeam },
    away: { id: article.match?.awayTeamId, name: article.match?.awayTeam },
  };
  const cards = playerCards.mergePredictionCards(article.prediction.keyPlayers, retained, fixture);
  return {
    ...article,
    prediction: {
      ...article.prediction,
      keyPlayerCards: cards,
    },
  };
}

function resolveSourceDefinitions(sourceIds = {}) {
  return SOURCE_DEFINITIONS.map((source) => ({
    ...source,
    sourceId: sourceIds[source.type] || process.env[source.sourceEnv] || DEFAULT_SOURCE_IDS[source.type],
  }));
}

// Export a credentials-free description for the monitor and tests.  The
// monitor uses exactly these source IDs and types; it never creates a shadow
// publication rule for webhook or Cron traffic.
export function notionSourceDefinitions(sourceIds = {}) {
  return resolveSourceDefinitions(sourceIds).map(({ type, sourceEnv, sourceId }) => ({ type, sourceEnv, sourceId }));
}

function normalizedSourceId(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function sourceTypeForNotionPage(page, { sourceIds = {} } = {}) {
  const parent = page?.parent || {};
  const parentId = parent.data_source_id || parent.database_id || null;
  const normalizedParent = normalizedSourceId(parentId);
  if (!normalizedParent) return null;
  const source = resolveSourceDefinitions(sourceIds)
    .find((entry) => normalizedSourceId(entry.sourceId) === normalizedParent);
  return source?.type || null;
}

// A webhook is only a change signal, not an authoritative article payload.
// Its receiver reads the current page only after persisting the signed event,
// then queues the returned current source version. This deliberately returns
// outcomes rather than throwing so callers never mistake a transient upstream
// failure for a deletion or non-public transition.
export async function getNotionPageMonitorTarget({
  pageId,
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  deadlineAt = null,
  consumeRequest = null,
} = {}) {
  const id = String(pageId || '').trim();
  if (!id) return { outcome: 'invalid_page_id', pageId: null };
  let page;
  try {
    const client = createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
    page = await client.getPage(id);
  } catch (error) {
    if (error?.status === 404) {
      // This is the one confirmed upstream absence case. Network, auth, and
      // rate-limit failures remain retryable and are never treated as a
      // deletion/non-public editorial decision.
      return { outcome: 'not_found', pageId: id };
    }
    if (error?.code === 'NOTION_RATE_LIMITED') {
      return { outcome: 'rate_limited', pageId: id, retryAfterMs: positiveMilliseconds(error.retryAfterMs) };
    }
    if (error?.code === 'NOTION_USAGE_LIMIT') {
      return { outcome: 'usage_limit', pageId: id, quota: error.details || null };
    }
    if (error?.code === 'NOTION_DEADLINE_EXCEEDED') {
      return { outcome: 'time_budget_exhausted', pageId: id };
    }
    return { outcome: 'source_unavailable', pageId: id };
  }
  const sourceType = sourceTypeForNotionPage(page, { sourceIds });
  const sourceVersion = notionVersion(page);
  if (!sourceType || !sourceVersion) {
    return { outcome: 'untrusted_source', pageId: id, page, sourceType: sourceType || null, sourceVersion: sourceVersion || null };
  }
  return { outcome: 'eligible', pageId: id, page, sourceType, sourceVersion };
}

function sourceDefinitionsForTypes(sourceIds, types) {
  if (types == null) return resolveSourceDefinitions(sourceIds);
  const requested = new Set(Array.isArray(types) ? types : []);
  return resolveSourceDefinitions(sourceIds).filter((source) => requested.has(source.type));
}

function notionSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveMilliseconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : null;
}

export function notionRetryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/u.test(text)) return positiveMilliseconds(Number(text) * 1_000);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Number(now)) : null;
}

export class NotionRequestError extends Error {
  constructor(message, {
    code = 'NOTION_REQUEST_FAILED', status = null, retryAfterMs = null, retryable = false, details = null,
  } = {}) {
    super(message);
    this.name = 'NotionRequestError';
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
    this.retryAfterMs = positiveMilliseconds(retryAfterMs);
    this.retryable = Boolean(retryable);
    // A monitor-owned usage reservation may be attached for its caller. It
    // contains no request URL, body, credential, or editorial content.
    this.details = details && typeof details === 'object' ? details : null;
  }
}

function retryableNotionStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normaliseNotionRequestError(error) {
  if (error instanceof NotionRequestError) return error;
  return new NotionRequestError('Notion request failed', {
    code: 'NOTION_REQUEST_FAILED', retryable: true,
  });
}

function remainingDeadlineMs(deadlineAt, now) {
  if (deadlineAt == null) return null;
  const deadline = deadlineAt instanceof Date ? deadlineAt.getTime() : Number(deadlineAt);
  if (!Number.isFinite(deadline)) return null;
  return deadline - Number(now());
}

function deadlineHasMinimum(deadlineAt, minimumMs) {
  if (deadlineAt == null) return true;
  const deadline = deadlineAt instanceof Date ? deadlineAt.getTime() : Number(deadlineAt);
  return !Number.isFinite(deadline) || deadline - Date.now() >= Math.max(0, Number(minimumMs) || 0);
}

function deadlineOutcome(fields = {}) {
  return { outcome: 'time_budget_exhausted', ...fields };
}

export function createNotionClient({
  apiKey,
  fetcher = fetch,
  requestTimeoutMs = NOTION_REQUEST_TIMEOUT_MS,
  maxAttempts = NOTION_REQUEST_MAX_ATTEMPTS,
  sleep = notionSleep,
  now = () => Date.now(),
  deadlineAt = null,
  // Called immediately before every real HTTP attempt (including retries and
  // paginated/nested-block calls). Returning `{ ok: false }` or `false`
  // prevents the request altogether, which lets the durable monitor enforce
  // an actual API cap rather than an optimistic estimate.
  consumeRequest = null,
} = {}) {
  if (!apiKey) throw new Error('NOTION_API_KEY is not configured');

  const timeout = Math.max(250, positiveMilliseconds(requestTimeoutMs) || NOTION_REQUEST_TIMEOUT_MS);
  const attempts = Math.min(5, Math.max(1, Math.floor(Number(maxAttempts) || NOTION_REQUEST_MAX_ATTEMPTS)));

  async function fetchOnce(url, init, attempt) {
    const remaining = remainingDeadlineMs(deadlineAt, now);
    if (remaining != null && remaining <= 0) {
      throw new NotionRequestError('Notion request skipped because the worker time budget elapsed', {
        code: 'NOTION_DEADLINE_EXCEEDED', retryable: true,
      });
    }
    if (typeof consumeRequest === 'function') {
      let reservation;
      try {
        reservation = await consumeRequest({ attempt });
      } catch {
        throw new NotionRequestError('Notion usage reservation failed', {
          code: 'NOTION_USAGE_TRACKING_UNAVAILABLE', retryable: true,
        });
      }
      if (reservation === false || reservation?.ok === false) {
        throw new NotionRequestError('Notion request deferred because its usage cap was reached', {
          code: 'NOTION_USAGE_LIMIT', retryable: false, details: reservation || null,
        });
      }
    }
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const propagateAbort = () => controller.abort();
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort();
      else upstreamSignal.addEventListener('abort', propagateAbort, { once: true });
    }
    const timeoutForAttempt = remaining == null ? timeout : Math.max(1, Math.min(timeout, Math.floor(remaining)));
    const timer = setTimeout(() => controller.abort(), timeoutForAttempt);
    try {
      const { signal: _ignoredSignal, ...requestInit } = init;
      return await fetcher(url, { ...requestInit, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NotionRequestError('Notion request timed out', {
          code: 'NOTION_REQUEST_TIMEOUT', retryable: true,
        });
      }
      throw normaliseNotionRequestError(error);
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener?.('abort', propagateAbort);
    }
  }

  function responseError(response) {
    const status = Number(response?.status);
    if (status === 429) {
      return new NotionRequestError('Notion rate limit reached', {
        code: 'NOTION_RATE_LIMITED', status,
        retryAfterMs: notionRetryAfterMs(response.headers?.get?.('Retry-After'), now()) || NOTION_RATE_LIMIT_FALLBACK_MS,
        retryable: true,
      });
    }
    return new NotionRequestError(`Notion request failed (${status || 'unknown'})`, {
      code: 'NOTION_HTTP_ERROR', status: Number.isInteger(status) ? status : null,
      retryable: retryableNotionStatus(status),
    });
  }

  async function request(path, init = {}, { maxAttempts: requestedAttempts = attempts } = {}) {
    const url = `${NOTION_API_BASE}${path}`;
    const attemptLimit = Math.min(attempts, Math.max(1, Math.floor(Number(requestedAttempts) || 1)));
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      try {
        const response = await fetchOnce(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Notion-Version': NOTION_API_VERSION,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
        }, attempt + 1);
        if (!response?.ok) throw responseError(response);
        return await response.json();
      } catch (error) {
        const failure = normaliseNotionRequestError(error);
        // 429 is handed back to the queue immediately. Waiting inside this
        // request risks a 120-second Function timeout and would retry before
        // a persisted lease can recover from a process interruption.
        if (failure.code === 'NOTION_RATE_LIMITED' || failure.code === 'NOTION_DEADLINE_EXCEEDED' || !failure.retryable || attempt + 1 >= attemptLimit) {
          throw failure;
        }
        const delayMs = NOTION_RETRY_BASE_MS * (2 ** attempt);
        const remaining = remainingDeadlineMs(deadlineAt, now);
        if (remaining != null && remaining <= delayMs) {
          throw new NotionRequestError('Notion retry deferred because the worker time budget elapsed', {
            code: 'NOTION_DEADLINE_EXCEEDED', retryable: true,
          });
        }
        await sleep(delayMs);
      }
    }
    throw new NotionRequestError('Notion request retry loop exhausted', { retryable: true });
  }

  async function queryPages(sourceId, {
    filter = null,
    // A complete source reconciliation can be larger than one Function
    // invocation.  Keep the cursor opaque and let the durable caller persist
    // it only after it has made the returned rows durable in its own queue.
    // The default remains the old all-pages behaviour for existing callers;
    // a streaming callback disables that aggregate unless explicitly needed.
    startCursor = null,
    onPage = null,
    collectResults = typeof onPage !== 'function',
  } = {}) {
    const pages = collectResults ? [] : null;
    let cursor = startCursor || null;
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
      const results = Array.isArray(result.results) ? result.results : [];
      if (pages) pages.push(...results);
      cursor = result.has_more ? result.next_cursor : null;
      if (typeof onPage === 'function') {
        // Do not report a completed source until its final page has reached
        // the caller.  If this callback or the next Notion request fails, the
        // caller's last persisted `nextCursor` is the safe resume point.
        await onPage({
          sourceId,
          results,
          nextCursor: cursor,
          complete: !cursor,
        });
      }
    } while (cursor);
    return pages || [];
  }

  async function queryAll(sourceId) {
    return queryPages(sourceId);
  }

  async function getPage(pageId) {
    const id = String(pageId || '').trim();
    if (!id) throw new Error('Notion page id is required');
    return request(`/pages/${encodeURIComponent(id)}`);
  }

  async function sourceProperties(sourceId) {
    const cached = sourceSchemaCache.get(sourceId);
    if (cached && cached.expiresAt > Date.now()) return cached.properties;
    const source = await request(`/data_sources/${encodeURIComponent(sourceId)}`);
    const properties = source?.properties && typeof source.properties === 'object' ? source.properties : {};
    sourceSchemaCache.set(sourceId, { properties, expiresAt: Date.now() + SOURCE_SCHEMA_CACHE_MS });
    return properties;
  }

  // Creating a page is deliberately a single-attempt operation.  A timeout
  // or 5xx can leave the write outcome unknown; retrying the same POST here
  // could create a duplicate editorial page. The durable report worker first
  // re-queries by the verified fixture identity before it ever attempts a
  // second creation.
  async function createPage(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Notion page payload is required');
    return request('/pages', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, { maxAttempts: 1 });
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
    async function readChildren(parentId) {
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
      let orderedListIndex = 0;
      for (const block of blocks) {
        if (block?.type === 'numbered_list_item') orderedListIndex += 1;
        else orderedListIndex = 0;
        const line = blockMarkdown(block, orderedListIndex);
        if (line) lines.push(line);
        // Notion callouts and nested lists often hold their substantive text
        // in children.  Follow every depth; the request/deadline/usage gates
        // on `request` still bound a worker safely, whereas a fixed nesting
        // cutoff silently truncates a published article body.
        if (block.has_children) {
          const nested = await readChildren(block.id);
          if (nested) lines.push(nested);
        }
      }
      return lines.join('\n\n');
    }
    return (await readChildren(pageId)).trim();
  }

  return {
    queryAll, queryPages, queryFixtureId, queryTeamPair, pageMarkdown, getPage,
    sourceProperties, createPage,
  };
}

export function matchIdentity(input = {}) {
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

function matchesCompetitionAndDate(metadata, identity) {
  return Boolean(
    metadata.date
    && identity.dateCandidates.includes(String(metadata.date).slice(0, 10))
    && metadata.competition
    && identity.competition
    && normalizedCompetition(metadata.competition) === normalizedCompetition(identity.competition)
  );
}

function teamPairIdentityMatch(metadata, identity) {
  if (!identity.homeTeamId || !identity.awayTeamId) return false;
  if (!matchesCompetitionAndDate(metadata, identity)) return null;
  // A team pair alone is not a safe fixture identity: league/cup rematches and
  // reverse fixtures exist. Keep the same competition and one of the actual
  // provider/local calendar dates as part of this optional-ID fallback.
  if (metadata.homeTeamId === identity.homeTeamId && metadata.awayTeamId === identity.awayTeamId) {
    return { method: 'team_ids', score: 90 };
  }
  if (metadata.homeTeamId === identity.awayTeamId && metadata.awayTeamId === identity.homeTeamId) {
    return { method: 'reversed_team_ids', score: 75 };
  }
  return null;
}

function pageMatchesIdentity(page, identity) {
  const metadata = matchMetadata(page);
  const storedFixtureId = explicitFixtureId(page);
  // An explicit but different provider fixture ID is an authoritative conflict;
  // never let looser text matching override it.
  if (storedFixtureId) {
    return storedFixtureId === identity.fixtureId ? { method: 'fixture_id', score: 100 } : null;
  }
  const teamIdMatch = teamPairIdentityMatch(metadata, identity);
  if (teamIdMatch) return teamIdMatch;
  if (identity.matchKey && metadata.matchKey === identity.matchKey) return { method: 'match_key', score: 80 };

  const comparisons = identity.dateCandidates
    .map((date) => {
      const comparison = matchArchive.matchIdentityComparison(metadata, {
        competition: identity.competition,
        date,
        homeTeam: identity.homeTeam,
        awayTeam: identity.awayTeam,
      });
      return comparison && {
        ...comparison,
        // Prefer the provider's primary date when both timezone candidates
        // describe otherwise equivalent identities.
        score: comparison.score + (date === identity.date ? 1 : 0),
      };
    })
    .filter(Boolean);
  return comparisons.sort((left, right) => right.score - left.score)[0] || null;
}

function strongestIdentityMatch(pages, identity) {
  const candidates = [...new Map((pages || [])
    .map((page) => {
      const comparison = pageMatchesIdentity(page, identity);
      return comparison ? [page?.id || Symbol('notion-match'), { page, ...comparison }] : null;
    })
    .filter(Boolean)).values()];
  if (!candidates.length) return null;
  const highestScore = Math.max(...candidates.map((entry) => entry.score));
  const strongest = candidates.filter((entry) => entry.score === highestScore);
  if (strongest.length !== 1) {
    const identityKeys = new Set(strongest.map((entry) => (
      matchArchive.canonicalMatchKey(matchMetadata(entry.page))
    )));
    if (identityKeys.size !== 1 || identityKeys.has('')) {
      return { page: null, ambiguous: true, matchMethod: null };
    }
    const dated = strongest
      .map((entry) => ({
        ...entry,
        editedAt: Date.parse(entry.page?.last_edited_time || entry.page?.created_time || ''),
      }))
      .filter((entry) => Number.isFinite(entry.editedAt));
    const newestTime = dated.length ? Math.max(...dated.map((entry) => entry.editedAt)) : null;
    const newest = dated.filter((entry) => entry.editedAt === newestTime);
    if (newest.length === 1) return newest[0];
    return { page: null, ambiguous: true, matchMethod: null };
  }
  return strongest[0];
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
    logger?.info?.(`${logPrefix} ${type} fixture ID query`, { fixtureId: identity.fixtureId, count: fixtureCandidates.length, matched: Boolean(fixtureMatch?.page), ambiguous: Boolean(fixtureMatch?.ambiguous) });
    if (fixtureMatch?.ambiguous) return { page: null, ambiguous: true, queryCount };
    if (fixtureMatch?.page) return { page: fixtureMatch.page, matchMethod: fixtureMatch.method, queryCount };
  }
  if (identity.homeTeamId && identity.awayTeamId) {
    const teamCandidates = await client.queryTeamPair(sourceId, identity.homeTeamId, identity.awayTeamId);
    queryCount += teamCandidates.length;
    const teamMatch = strongestIdentityMatch(teamCandidates, identity);
    logger?.info?.(`${logPrefix} ${type} team ID query`, {
      homeTeamId: identity.homeTeamId,
      awayTeamId: identity.awayTeamId,
      count: teamCandidates.length,
      matched: Boolean(teamMatch?.page),
      ambiguous: Boolean(teamMatch?.ambiguous),
    });
    if (teamMatch?.ambiguous) return { page: null, ambiguous: true, queryCount };
    if (teamMatch?.page) return { page: teamMatch.page, matchMethod: teamMatch.method, queryCount };
  }
  let exactCandidates = [];
  if (identity.matchKey) {
    exactCandidates = await client.queryPages(sourceId, { filter: notionFilterForMatchKey(identity.matchKey) });
    queryCount += exactCandidates.length;
    logger?.info?.(`${logPrefix} ${type} exact query`, { matchKey: identity.matchKey, count: exactCandidates.length });
  }
  const exact = strongestIdentityMatch(exactCandidates, identity);
  if (exact?.ambiguous) return { page: null, ambiguous: true, queryCount };
  if (exact?.page) return { page: exact.page, matchMethod: exact.method, queryCount };

  // Team aliases cannot be sent safely as an OR filter. Query each actual
  // provider/local date candidate, then use the full canonical identity to
  // decide the match. This is deliberately not a blind ±1-day fuzzy search.
  // Notion authors can use an adjacent local calendar date for an evening
  // European fixture. Search the bounded ±48-hour window only after the
  // provider-ID, team-ID and exact Match Key paths above have failed. The
  // final comparator still requires the ordered clubs and a unique strongest
  // candidate; this is not a name-only fuzzy match.
  const fallbackDates = new Set(identity.dateCandidates);
  for (const date of identity.dateCandidates) {
    const timestamp = Date.parse(`${date}T12:00:00.000Z`);
    if (!Number.isFinite(timestamp)) continue;
    for (let offset = -2; offset <= 2; offset += 1) {
      fallbackDates.add(new Date(timestamp + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    }
  }
  const relaxedIdentity = { ...identity, dateCandidates: [...fallbackDates] };
  const dateCandidates = [];
  for (const date of relaxedIdentity.dateCandidates) {
    const pages = await client.queryPages(sourceId, { filter: notionFilterForDate(date) });
    queryCount += pages.length;
    dateCandidates.push(...pages);
  }
  const matched = strongestIdentityMatch(dateCandidates, relaxedIdentity);
  logger?.info?.(`${logPrefix} ${type} date fallback`, {
    matchKey: identity.matchKey,
    dateCandidates: identity.dateCandidates,
    count: dateCandidates.length,
    matched: Boolean(matched?.page),
    ambiguous: Boolean(matched?.ambiguous),
  });
  return { page: matched?.page || null, matchMethod: matched?.method || null, ambiguous: Boolean(matched?.ambiguous), queryCount };
}

// A generation worker must distinguish an existing source-of-truth report
// from a genuinely absent one before calling an AI model. Keep that lookup in
// this module so it uses the same fixture-ID, verified aliases, ordered-card,
// and bounded date-window rules as reader-facing Notion content.
export async function findNotionMatchPageTarget({
  match,
  type = 'match_report',
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  client: suppliedClient = null,
  logger = console,
  deadlineAt = null,
  consumeRequest = null,
} = {}) {
  const source = resolveSourceDefinitions(sourceIds).find((entry) => entry.type === type);
  if (!source) throw new Error(`Unknown Notion source type: ${type}`);
  const identity = matchIdentity(match);
  if (!identity.fixtureId && (!identity.date || !identity.homeTeam || !identity.awayTeam)) {
    throw new Error('fixture ID or complete ordered match identity is required');
  }
  const client = suppliedClient || createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  const found = await findNotionMatchPage({ client, sourceId: source.sourceId, identity, logger, type });
  return { ...found, identity, sourceId: source.sourceId };
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
        if (found.ambiguous) {
          result.errors[source.type] = 'ambiguous';
          logger?.warn?.('[match-content] article identity is ambiguous', { type: source.type, matchKey: identity.matchKey, queryCount: found.queryCount });
          return;
        }
        logger?.info?.('[match-content] article not found', { type: source.type, matchKey: identity.matchKey, queryCount: found.queryCount });
        return;
      }
      const state = propertyText(found.page, '記事状態');
      if (!isPublishableNotionState(state, source.type)) {
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

function hiddenArticleForNotionPage(article, page, state = null) {
  return {
    ...article,
    public: false,
    notion: {
      ...article.notion,
      pageId: page?.id || article.notion?.pageId || null,
      pageUrl: page?.url || article.notion?.pageUrl || null,
      updatedAt: page?.last_edited_time || page?.created_time || article.notion?.updatedAt || null,
      state: state || (page ? propertyText(page, '記事状態') : 'Notionで非公開または削除'),
    },
  };
}

// A monitor-created article that failed its final real-browser verification
// is kept privately for the exact source revision rather than being deleted.
// The hold prevents the hourly collector from immediately republishing the
// same unverified body; a genuine Notion edit has a new version and resumes
// the ordinary publication path without special handling.
function hasMonitorDeliveryHold(article, version) {
  const hold = article?.siteMonitor?.deliveryHold;
  return article?.public === false
    && hold
    && String(hold.sourceVersion || '')
    && String(hold.sourceVersion) === String(version || '');
}

async function hideArticle(existing, page, store, state = null) {
  const article = await store.getArticle(existing.id, { includeHidden: true });
  if (!article) return false;
  await store.saveArticle(hiddenArticleForNotionPage(article, page, state));
  return true;
}

function needsMatchIdentityRefresh(article, type) {
  return (type === 'match_prediction' || type === 'match_report')
    && article?.match?.identityVersion !== MATCH_IDENTITY_VERSION;
}

export function needsPredictionKeyPlayerRefresh(article, type) {
  if (type !== 'match_prediction' || !article?.prediction?.keyPlayers) return false;
  // Only the sync-owned fixture identity can safely resolve and persist an
  // unresolved card. Legacy pages without a fixture ID use the isolated media
  // sidecar at rendering time; treating them as stale here would reread and
  // rewrite every unchanged Notion page on every hourly run.
  const fixtureId = Number(article?.match?.fixtureId);
  if (!Number.isSafeInteger(fixtureId) || fixtureId <= 0) return false;
  const cards = article.prediction.keyPlayerCards;
  return !Array.isArray(cards) || cards.some((card) => card?.resolved !== true);
}

function notionVersion(page) {
  return page?.last_edited_time || page?.created_time || null;
}

function isExplicitlyArchivedNotionPage(page) {
  return page?.archived === true || page?.in_trash === true;
}

function shouldHideNotionPage(page, type) {
  if (isExplicitlyArchivedNotionPage(page)) return true;
  const state = propertyText(page, '記事状態');
  return !isPublishableNotionState(state, type) && !isLegacyGeneratedState(state);
}

// A Notion page can change state while this worker is waiting for a lease or
// preparing its Blob snapshot.  Hiding is destructive for readers, so it
// receives the same just-before-write source/version proof as a normal body
// update.  An unavailable re-read is never evidence that the page was hidden.
async function confirmNonPublicPageBeforeWrite({
  client,
  pageId,
  page,
  sourceIds,
  sourceType,
  sourceVersion,
  deadlineAt,
}) {
  if (!deadlineHasMinimum(deadlineAt, MIN_NOTION_BODY_STEP_MS)) {
    return deadlineOutcome({ page, sourceType, sourceVersion });
  }
  let latestPage;
  try {
    latestPage = await client.getPage(pageId);
  } catch (error) {
    return sourceUnavailableOutcome(error, { page, sourceType, sourceVersion });
  }
  const latestType = sourceTypeForNotionPage(latestPage, { sourceIds });
  const latestVersion = notionVersion(latestPage);
  if (
    latestType !== sourceType
    || !isSameNotionVersion(sourceVersion, latestVersion)
    || !shouldHideNotionPage(latestPage, sourceType)
  ) {
    return {
      outcome: 'source_changed',
      page: latestPage,
      sourceType: latestType || sourceType,
      sourceVersion: latestVersion,
    };
  }
  return { outcome: 'confirmed_non_public', page: latestPage, sourceType, sourceVersion: latestVersion };
}

async function hideCurrentArticleWithGuards({
  existingArticle,
  page,
  sourceType,
  store,
  state = null,
  beforeWrite = null,
  confirmBeforeSave = null,
}) {
  // Re-read the small local record so the snapshot and write preserve any
  // unrelated, newer derived fields rather than overwriting them with the
  // object observed at the beginning of this job.
  const currentArticle = await store.getArticle(existingArticle.id, { includeHidden: true });
  if (!currentArticle || currentArticle.public === false) return { outcome: 'non_public' };
  const hiddenArticle = hiddenArticleForNotionPage(currentArticle, page, state);
  if (typeof beforeWrite === 'function') {
    const allowed = await beforeWrite({
      existingArticle: currentArticle,
      article: hiddenArticle,
      page,
      sourceType,
      operation: 'hide',
    });
    if (allowed === false) return { outcome: 'write_cancelled' };
  }
  // The snapshot/lease guard can itself take long enough for an editor to
  // republish the page. Re-read once more immediately before the only
  // reader-facing write; without a cross-system transaction this is the
  // narrowest safe check, and a changed source is re-queued instead of hidden.
  if (typeof confirmBeforeSave === 'function') {
    const confirmation = await confirmBeforeSave();
    if (!confirmation || confirmation.outcome !== 'confirmed_non_public') {
      return confirmation || { outcome: 'source_unavailable' };
    }
  }
  await store.saveArticle(hiddenArticle);
  return { outcome: 'hidden', article: hiddenArticle };
}

function isSameNotionVersion(left, right) {
  return Boolean(left && right && String(left) === String(right));
}

function sourceUnavailableOutcome(error, fields = {}) {
  return {
    outcome: error?.code === 'NOTION_DEADLINE_EXCEEDED'
      ? 'time_budget_exhausted'
      : error?.code === 'NOTION_USAGE_LIMIT'
        ? 'usage_limit'
        : 'source_unavailable',
    ...fields,
    error: error instanceof Error ? error.message : 'Notion source unavailable',
    retryAfterMs: positiveMilliseconds(error?.retryAfterMs),
    quota: error?.details || null,
  };
}

// Query changes since the durable collector checkpoint.  The caller owns
// checkpoint persistence: a failed source scan must leave its prior watermark
// untouched.  The overlap is intentional; pages are de-duplicated by page id
// and source version when they enter the monitor queue.
export async function collectNotionChanges({
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  checkpoints = {},
  types = null,
  overlapMs = 2 * 60 * 1000,
  observedAt = new Date().toISOString(),
  deadlineAt = null,
  notBeforeBySource = {},
  consumeRequest = null,
  // A durable caller may persist this opaque query cursor after it has queued
  // a page of rows. The same `since` filter is reused on resume so pagination
  // never skips rows when a Function ends mid-source.
  cursors = {},
  onPage = null,
} = {}) {
  const client = createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  const sources = {};
  const errors = {};
  const deferred = {};
  const retryAfterMs = {};
  let quotaExceeded = null;
  const observedAtMs = Date.parse(observedAt);
  for (const source of sourceDefinitionsForTypes(sourceIds, types)) {
    const notBefore = String(notBeforeBySource?.[source.type] || '');
    const notBeforeMs = Date.parse(notBefore);
    if (Number.isFinite(notBeforeMs) && Number.isFinite(observedAtMs) && notBeforeMs > observedAtMs) {
      deferred[source.type] = new Date(notBeforeMs).toISOString();
      continue;
    }
    const checkpoint = checkpoints?.[source.type] || {};
    const resume = cursors?.[source.type] || {};
    const resumeCursor = String(resume.cursor || '').trim() || null;
    const prior = Date.parse(checkpoint.watermark || checkpoint.updatedAt || '');
    const checkpointSince = Number.isFinite(prior)
      ? new Date(Math.max(0, prior - Math.max(0, Number(overlapMs) || 0))).toISOString()
      : null;
    const resumeSince = Date.parse(resume.since || '');
    const since = resumeCursor && Number.isFinite(resumeSince)
      ? new Date(resumeSince).toISOString()
      : checkpointSince;
    try {
      // The durable monitor consumes pages inside `onPage` and persists its
      // continuation cursor before asking Notion for another one.  Retaining
      // the complete result set in that mode defeats pagination on a large
      // source, so keep the legacy aggregate only for callers without a
      // streaming callback.
      const retainAggregate = typeof onPage !== 'function';
      const unique = new Map();
      let latest = null;
      let pageCount = 0;
      const retainPages = (pages) => {
        pageCount += (pages || []).length;
        for (const page of pages || []) {
          const version = notionVersion(page);
          if (!latest || timestampForNotionVersion(version) > timestampForNotionVersion(latest)) latest = version;
          if (!retainAggregate) continue;
          const pageId = String(page?.id || '');
          if (!pageId) continue;
          const previous = unique.get(pageId);
          if (!previous || timestampForNotionVersion(notionVersion(page)) >= timestampForNotionVersion(notionVersion(previous))) {
            unique.set(pageId, page);
          }
        }
      };
      await client.queryPages(source.sourceId, {
        filter: since ? {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: since },
        } : null,
        startCursor: resumeCursor,
        onPage: async ({ results, nextCursor, complete }) => {
          retainPages(results);
          if (typeof onPage === 'function') {
            await onPage({
              sourceType: source.type,
              sourceId: source.sourceId,
              pages: results,
              nextCursor,
              complete,
              since,
            });
          }
        },
      });
      sources[source.type] = {
        sourceId: source.sourceId,
        pages: retainAggregate ? [...unique.values()] : [],
        pageCount,
        // First collection reads the source in full. After that, retain a
        // conservative overlap rather than skipping equal-timestamp edits.
        watermark: latest || checkpoint.watermark || observedAt,
        collectedAt: observedAt,
      };
    } catch (error) {
      if (error?.code === 'NOTION_USAGE_LIMIT') {
        errors[source.type] = 'quota_exceeded';
        quotaExceeded = error.details || { ok: false, exceeded: 'apiCalls' };
        break;
      }
      // Keep routine logs free of request bodies, identifiers, and provider
      // error text. Durable state records the source and bounded outcome.
      console.error('[site monitor] Notion change collection unavailable', {
        sourceType: source.type,
        code: error?.code || 'NOTION_REQUEST_FAILED',
        status: Number.isInteger(error?.status) ? error.status : null,
      });
      errors[source.type] = error?.code === 'NOTION_RATE_LIMITED' ? 'rate_limited' : 'unavailable';
      const retry = positiveMilliseconds(error?.retryAfterMs);
      if (retry) retryAfterMs[source.type] = retry;
    }
  }
  return { sources, errors, deferred, retryAfterMs, quotaExceeded };
}

// Reconciles a source independently of the delta watermark.  This is used by
// the durable match-report backfill, not by reader-facing requests.  The
// callback is intentionally page-granular so the caller can enqueue rows and
// persist the opaque Notion cursor before another upstream request is made.
// That makes an interrupted multi-page scan resumable without ever marking a
// partially read source as complete.
export async function collectNotionSourcePages({
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  types = null,
  cursors = {},
  deadlineAt = null,
  consumeRequest = null,
  onPage = null,
} = {}) {
  const client = createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  const sources = {};
  const errors = {};
  const retryAfterMs = {};
  let quotaExceeded = null;

  for (const source of sourceDefinitionsForTypes(sourceIds, types)) {
    // Streaming consumers own durable processing one Notion page at a time.
    // Avoid accumulating an entire collection in memory for that common
    // backfill path; retain the old aggregate contract only for direct
    // non-streaming callers.
    const retainAggregate = typeof onPage !== 'function';
    const pages = retainAggregate ? [] : null;
    let pageCount = 0;
    const cursor = String(cursors?.[source.type]?.cursor || '').trim() || null;
    try {
      await client.queryPages(source.sourceId, {
        startCursor: cursor,
        onPage: async ({ results, nextCursor, complete }) => {
          pageCount += (results || []).length;
          if (pages) pages.push(...results);
          if (typeof onPage === 'function') {
            await onPage({
              sourceType: source.type,
              sourceId: source.sourceId,
              pages: results,
              nextCursor,
              complete,
            });
          }
        },
      });
      sources[source.type] = {
        sourceId: source.sourceId,
        pages: pages || [],
        pageCount,
        complete: true,
      };
    } catch (error) {
      if (error?.code === 'NOTION_USAGE_LIMIT') {
        errors[source.type] = 'quota_exceeded';
        quotaExceeded = error.details || { ok: false, exceeded: 'apiCalls' };
        break;
      }
      errors[source.type] = error?.code === 'NOTION_RATE_LIMITED' ? 'rate_limited' : 'unavailable';
      const retry = positiveMilliseconds(error?.retryAfterMs);
      if (retry) retryAfterMs[source.type] = retry;
    }
  }
  return { sources, errors, retryAfterMs, quotaExceeded };
}

function timestampForNotionVersion(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// Synchronise exactly one current Notion page through the same normalisation,
// publication decision, archive store and key-player hydration as the normal
// sync.  It is deliberately not a generic "refresh" API: a page must still
// belong to one of the three AM4 source data sources and survive a second
// version check immediately before any Blob write.
export async function syncNotionPage({
  pageId,
  sourceType = null,
  expectedSourceVersion = null,
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  articleStore = null,
  hydratePredictionArticle = async (article) => article,
  hydrateReportArticle = async (article) => article,
  beforeWrite = null,
  flush = true,
  deadlineAt = null,
  consumeRequest = null,
  // This is an internal, code-owned recovery flag. It is never accepted from
  // a public request: a monitor job may release only its own same-version
  // browser-runtime hold after it has re-read and revalidated this Notion
  // page. Normal collection continues to keep a held revision private.
  releaseMonitorDeliveryHold = false,
} = {}) {
  const id = String(pageId || '').trim();
  if (!id) throw new Error('A Notion page id is required');
  const client = createNotionClient({ apiKey, fetcher, deadlineAt, consumeRequest });
  let page;
  try {
    page = await client.getPage(id);
  } catch (error) {
    // Network/auth failures are not evidence that an editor deleted or hid a
    // page.  Keep the healthy mirror intact and let the monitor retry.
    return sourceUnavailableOutcome(error, { pageId: id });
  }

  const inferredType = sourceTypeForNotionPage(page, { sourceIds });
  const type = sourceType || inferredType;
  if (!inferredType || !type || !sourceDefinitionsForTypes(sourceIds, [type]).length || inferredType !== type) {
    return { outcome: 'untrusted_source', pageId: id, sourceType: type || null };
  }
  const currentVersion = notionVersion(page);
  if (expectedSourceVersion && !isSameNotionVersion(expectedSourceVersion, currentVersion)) {
    return { outcome: 'source_changed', pageId: id, sourceType: type, sourceVersion: currentVersion };
  }

  const store = articleStore || await import('./article-store.js');
  const articleId = notionArticleId(type, page.id);
  const existingArticle = await store.getArticle(articleId, { includeHidden: true });

  const heldByFailedBrowser = hasMonitorDeliveryHold(existingArticle, currentVersion);
  const canReleaseMonitorDeliveryHold = heldByFailedBrowser
    && releaseMonitorDeliveryHold === true
    && existingArticle?.siteMonitor?.deliveryHold?.reason === 'browser_validation_failed';
  if (heldByFailedBrowser && !canReleaseMonitorDeliveryHold) {
    return {
      outcome: 'monitor_delivery_hold',
      page,
      sourceType: type,
      sourceVersion: currentVersion,
      articleId,
      article: existingArticle,
    };
  }

  if (!deadlineHasMinimum(deadlineAt, 2_000)) {
    return deadlineOutcome({ page, sourceType: type, sourceVersion: currentVersion, articleId });
  }

  if (shouldHideNotionPage(page, type)) {
    if (existingArticle && existingArticle.public !== false) {
      const confirmation = await confirmNonPublicPageBeforeWrite({
        client, pageId: id, page, sourceIds, sourceType: type,
        sourceVersion: currentVersion, deadlineAt,
      });
      if (confirmation.outcome !== 'confirmed_non_public') {
        return { ...confirmation, articleId };
      }
      const hidden = await hideCurrentArticleWithGuards({
        existingArticle,
        page: confirmation.page,
        sourceType: type,
        store,
        state: isExplicitlyArchivedNotionPage(confirmation.page) ? 'Notionでアーカイブまたは削除' : null,
        beforeWrite,
        confirmBeforeSave: () => confirmNonPublicPageBeforeWrite({
          client, pageId: id, page: confirmation.page, sourceIds, sourceType: type,
          sourceVersion: confirmation.sourceVersion, deadlineAt,
        }),
      });
      if (!['hidden', 'non_public', 'write_cancelled'].includes(hidden.outcome)) {
        return { ...hidden, articleId };
      }
      if (hidden.outcome === 'write_cancelled') {
        return { outcome: 'write_cancelled', page: confirmation.page, sourceType: type, sourceVersion: confirmation.sourceVersion, articleId };
      }
      if (hidden.outcome === 'hidden') {
        if (!deadlineHasMinimum(deadlineAt, 2_000)) {
          return deadlineOutcome({ page: confirmation.page, sourceType: type, sourceVersion: confirmation.sourceVersion, articleId });
        }
        if (flush && typeof store.flush === 'function') await store.flush();
        return { outcome: 'hidden', page: confirmation.page, sourceType: type, sourceVersion: confirmation.sourceVersion, articleId, article: hidden.article, previousArticle: existingArticle };
      }
    }
    return { outcome: 'non_public', page, sourceType: type, sourceVersion: currentVersion, articleId };
  }

  if (
    existingArticle?.notion?.updatedAt === currentVersion
    && existingArticle.public !== false
    && !needsMatchIdentityRefresh(existingArticle, type)
    && !needsPredictionKeyPlayerRefresh(existingArticle, type)
  ) {
    try {
      const indexed = typeof store.hasIndexedArticle === 'function'
        ? await store.hasIndexedArticle(existingArticle)
        : true;
      if (indexed) {
        return { outcome: 'unchanged', page, sourceType: type, sourceVersion: currentVersion, articleId, article: existingArticle };
      }
    } catch (error) {
      // The article record is known-good; an index read failure must not turn
      // it into a false absence or trigger an unverified body rewrite.
      return { outcome: 'storage_unavailable', page, sourceType: type, sourceVersion: currentVersion, articleId, error: error.message };
    }

    // Recover the narrow interruption window between an article Blob write
    // and its index switch. Verify the source version again immediately
    // before rebuilding the same compact derived record.
    let latestPage;
    if (!deadlineHasMinimum(deadlineAt, MIN_NOTION_BODY_STEP_MS)) {
      return deadlineOutcome({ page, sourceType: type, sourceVersion: currentVersion, articleId });
    }
    try {
      latestPage = await client.getPage(id);
    } catch (error) {
      return sourceUnavailableOutcome(error, { page, sourceType: type, sourceVersion: currentVersion });
    }
    const latestType = sourceTypeForNotionPage(latestPage, { sourceIds });
    const latestVersion = notionVersion(latestPage);
    if (latestType !== type || !isSameNotionVersion(currentVersion, latestVersion)) {
      return { outcome: 'source_changed', page: latestPage, sourceType: latestType || type, sourceVersion: latestVersion };
    }
    if (typeof beforeWrite === 'function') {
      const allowed = await beforeWrite({ existingArticle, article: existingArticle, page: latestPage, sourceType: type });
      if (allowed === false) return { outcome: 'write_cancelled', page: latestPage, sourceType: type, sourceVersion: latestVersion };
    }
    if (!deadlineHasMinimum(deadlineAt, 2_000)) {
      return deadlineOutcome({ page: latestPage, sourceType: type, sourceVersion: latestVersion, articleId });
    }
    await store.saveArticle(existingArticle);
    if (flush && typeof store.flush === 'function') await store.flush();
    return {
      outcome: 'reindexed', page: latestPage, sourceType: type, sourceVersion: latestVersion,
      articleId, article: existingArticle, previousArticle: existingArticle,
    };
  }

  let markdown;
  if (!deadlineHasMinimum(deadlineAt, MIN_NOTION_BODY_STEP_MS)) {
    return deadlineOutcome({ page, sourceType: type, sourceVersion: currentVersion, articleId });
  }
  try {
    markdown = await client.pageMarkdown(page.id);
  } catch (error) {
    return sourceUnavailableOutcome(error, { page, sourceType: type, sourceVersion: currentVersion });
  }
  const normalized = normalizeNotionContent(markdown);
  if (!normalized.body.trim()) {
    // Do not turn an empty or incompletely-read body into a destructive sync.
    return { outcome: 'empty_body', page, sourceType: type, sourceVersion: currentVersion, articleId };
  }

  let article = notionPageToArticle({ type, page, markdown });
  article = retainVerifiedPredictionKeyPlayerCards(article, existingArticle);
  if ((type === 'match_prediction' || type === 'match_report') && !deadlineHasMinimum(deadlineAt, MIN_SYNC_MEDIA_STEP_MS)) {
    return deadlineOutcome({ page, sourceType: type, sourceVersion: currentVersion, articleId });
  }
  try {
    if (type === 'match_prediction') {
      const hydrated = await hydratePredictionArticle(article, { existingArticle, sourceType: type });
      if (hydrated?.id === article.id) article = hydrated;
    }
    if (type === 'match_report') {
      const hydrated = await hydrateReportArticle(article, { existingArticle, sourceType: type });
      if (hydrated?.id === article.id) article = hydrated;
    }
  } catch (error) {
    // Structured media is additive. It must not stop a validated article body
    // from reaching the normal archive, and never removes retained media.
    console.warn('[site monitor] editorial media hydration unavailable', { pageId: id, message: error.message });
  }

  let latestPage;
  if (!deadlineHasMinimum(deadlineAt, MIN_NOTION_BODY_STEP_MS)) {
    return deadlineOutcome({ page, sourceType: type, sourceVersion: currentVersion, articleId });
  }
  try {
    latestPage = await client.getPage(id);
  } catch (error) {
    return sourceUnavailableOutcome(error, { page, sourceType: type, sourceVersion: currentVersion });
  }
  const latestType = sourceTypeForNotionPage(latestPage, { sourceIds });
  const latestVersion = notionVersion(latestPage);
  if (latestType !== type || !isSameNotionVersion(currentVersion, latestVersion)) {
    return { outcome: 'source_changed', page: latestPage, sourceType: latestType || type, sourceVersion: latestVersion };
  }
  if (typeof beforeWrite === 'function') {
    const allowed = await beforeWrite({ existingArticle, article, page: latestPage, sourceType: type });
    if (allowed === false) return { outcome: 'write_cancelled', page: latestPage, sourceType: type, sourceVersion: latestVersion };
  }
  if (!deadlineHasMinimum(deadlineAt, 2_000)) {
    return deadlineOutcome({ page: latestPage, sourceType: type, sourceVersion: latestVersion, articleId });
  }
  await store.saveArticle(article);
  if (flush && typeof store.flush === 'function') await store.flush();
  return {
    outcome: existingArticle ? 'updated' : 'created',
    page: latestPage,
    sourceType: type,
    sourceVersion: latestVersion,
    articleId,
    article,
    previousArticle: existingArticle || null,
  };
}

// Fetches compact database rows every run, then reads page blocks only for newly
// created or edited entries. That makes the 3-times-daily schedule inexpensive.
export async function syncNotionContent({
  apiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
  sourceIds,
  // A webhook only needs to mirror the two match-editorial sources. Keeping
  // this optional preserves the complete scheduled archive refresh.
  types = null,
  articleStore = null,
  hydratePredictionArticle = async (article) => article,
  hydrateReportArticle = async (article) => article,
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

  for (const source of sourceDefinitionsForTypes(sourceIds, types)) {
    try {
      const pages = await client.queryAll(source.sourceId);
      const returnedPageIds = new Set(pages.map((page) => String(page?.id || '')).filter(Boolean));
      for (const page of pages) {
        result.checked += 1;
        const existingArticle = existingByPageId.get(page.id);
        const state = propertyText(page, '記事状態');
        if (!isPublishableNotionState(state, source.type)) {
          // For sources outside the active match-editorial workflow,
          // `自動生成` cannot create a new public record. Older archive entries
          // may use it as source provenance while their explicit archive
          // publication was already approved. Do not erase that legacy archive
          // merely because a later sync sees the old provenance label.
          // Explicit review/non-public states still retract an existing mirror.
          if (
            existingArticle
            && existingArticle.public !== false
            && !isLegacyGeneratedState(state)
            && await hideArticle(existingArticle, page, store)
          ) result.hidden += 1;
          continue;
        }
        const updatedAt = page.last_edited_time || page.created_time || null;
        if (hasMonitorDeliveryHold(existingArticle, updatedAt)) {
          result.unchanged += 1;
          continue;
        }
        if (
          existingArticle?.notion?.updatedAt === updatedAt
          && existingArticle.public !== false
          && !needsMatchIdentityRefresh(existingArticle, source.type)
          && !needsPredictionKeyPlayerRefresh(existingArticle, source.type)
        ) {
          result.unchanged += 1;
          continue;
        }
        const markdown = await client.pageMarkdown(page.id);
        let article = notionPageToArticle({ type: source.type, page, markdown });
        article = retainVerifiedPredictionKeyPlayerCards(article, existingArticle);
        if (source.type === 'match_prediction') {
          try {
            const hydrated = await hydratePredictionArticle(article, { existingArticle, source });
            if (hydrated?.id === article.id) article = hydrated;
          } catch (error) {
            // Keep the normalized article and any verified retained cards if a
            // transient fixture/squad read fails. The next hourly mirror pass
            // can retry without regressing the display.
            console.warn('[notion sync] key-player media unavailable', {
              pageId: page.id,
              message: error instanceof Error ? error.message : 'Unknown player-card error',
            });
          }
        }
        if (source.type === 'match_report') {
          try {
            const hydrated = await hydrateReportArticle(article, { existingArticle, source });
            if (hydrated?.id === article.id) article = hydrated;
          } catch (error) {
            console.warn('[notion sync] MOTM media unavailable', {
              pageId: page.id,
              message: error instanceof Error ? error.message : 'Unknown MOTM media error',
            });
          }
        }
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
