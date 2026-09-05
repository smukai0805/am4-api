// Shared, lightweight editorial metadata helpers.  The archive can keep a
// small, explicit tag set when it is available, while older Notion records
// still get useful tags from their existing editorial taxonomy.

const IGNORED_TAGS = new Set(['am4', 'column', 'am4 column', 'その他', 'ほか']);

const CATEGORY_TAGS = new Map([
  ['戦術史', 'TACTICS'],
  ['クラブ史', 'CLUB HISTORY'],
  ['リーグ文化', 'LEAGUE CULTURE'],
  ['ライバル・ダービー', 'RIVALRY'],
  ['大会史', 'TOURNAMENT HISTORY'],
]);

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function tagKey(value) {
  return compact(value).toLocaleLowerCase('en-US');
}

function addTag(tags, value) {
  const normalized = compact(value).replace(/^#+\s*/, '').slice(0, 72);
  if (!normalized || IGNORED_TAGS.has(tagKey(normalized))) return;
  if (!tags.some((tag) => tagKey(tag) === tagKey(normalized))) tags.push(normalized);
}

function tagValues(value) {
  if (Array.isArray(value)) return value.flatMap(tagValues);
  return value == null ? [] : [value];
}

function clubTags(value) {
  return compact(value).split(/[／/,、\n]+/).map((club) => compact(club).replace(/\s+ほか$/u, '')).filter(Boolean);
}

function isTwentySeasonsStory(article = {}) {
  const explicitSeries = compact(article.story?.series).toLocaleLowerCase('en-US');
  if (explicitSeries === '20 seasons, 20 stories.') return true;
  const source = [article.story?.topicKey, article.story?.subject]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
  return /20\s*seasons\s*,?\s*20\s*stories\.?/u.test(source);
}

export function normalizeArticleTags(value) {
  const tags = [];
  tagValues(value).forEach((tag) => addTag(tags, tag));
  return tags;
}

export function articleTags(article = {}) {
  const tags = normalizeArticleTags([article.tags, article.story?.tags]);
  if (isTwentySeasonsStory(article)) addTag(tags, '20 SEASONS');
  const category = compact(article.story?.category || article.category);
  if (category) addTag(tags, CATEGORY_TAGS.get(category) || category);
  clubTags(article.story?.relatedClubs || article.relatedClubs).forEach((club) => addTag(tags, club));
  return tags.slice(0, 8);
}

export function articlePopularRank(value) {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

export function articlePriority(value) {
  const priority = Number(value);
  return Number.isFinite(priority) && priority > 0 ? priority : 0;
}

export function articleCoverImage(article = {}) {
  const image = article.coverImage || article.image || article.story?.coverImage || null;
  return typeof image === 'string' && /^https?:\/\//i.test(image) ? image : null;
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.map((block) => {
    if (typeof block === 'string') return block;
    if (Array.isArray(block?.items)) return block.items.join(' ');
    if (Array.isArray(block?.rows)) return block.rows.flat().join(' ');
    return block?.text || '';
  }).join(' ');
  return '';
}

export function normalizeArticleSearch(value) {
  return compact(value).toLocaleLowerCase('ja-JP');
}

export function articleSearchText(article = {}) {
  return normalizeArticleSearch([
    article.title,
    article.deck,
    article.summary,
    article.subject,
    article.story?.subject,
    article.story?.topicKey,
    article.story?.category,
    article.story?.relatedClubs,
    articleTags(article).join(' '),
    bodyText(article.body),
  ].filter(Boolean).join(' '));
}

export function articleMatchesSearch(article, search) {
  const query = normalizeArticleSearch(search);
  return !query || articleSearchText(article).includes(query);
}
