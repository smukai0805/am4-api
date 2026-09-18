// Structured article relations for entity pages.  Display names are never used
// as a primary key: legacy club labels are accepted only when the entire label
// exactly matches AM4's existing, verified club dictionary.

import { isPublicArticle } from './article-visibility.js';
import { TEAM_IDS } from './team-ids.js';

const COLUMN_TYPES = new Set(['am4_story', 'player_intro']);

export function positiveId(value) {
  const text = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

function idsFrom(value) {
  const source = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of source) {
    const id = positiveId(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function clubLabels(value) {
  if (Array.isArray(value)) return value.flatMap(clubLabels);
  return String(value || '')
    .normalize('NFKC')
    .split(/[／/,、\n]+/u)
    .map((label) => label.replace(/\s+ほか$/u, '').trim())
    .filter(Boolean);
}

function teamIdsFromLegacyLabels(value) {
  const ids = [];
  for (const label of clubLabels(value)) {
    // `TEAM_IDS[label]` deliberately performs a full-label lookup.  In
    // particular, "United" and "City" must not relate an article to any club.
    const id = positiveId(TEAM_IDS[label]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function appendUnique(target, values) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
  return target;
}

export function articleRelatedTeamIds(article = {}) {
  const ids = [];
  appendUnique(ids, idsFrom(article.relatedTeamIds));
  appendUnique(ids, idsFrom(article.story?.relatedTeamIds));
  appendUnique(ids, idsFrom(article.match?.homeTeamId));
  appendUnique(ids, idsFrom(article.match?.awayTeamId));
  appendUnique(ids, idsFrom(article.player?.teamId));
  appendUnique(ids, idsFrom(article.transfer?.fromTeamId));
  appendUnique(ids, idsFrom(article.transfer?.toTeamId));
  appendUnique(ids, teamIdsFromLegacyLabels(article.story?.relatedClubs || article.relatedClubs));
  return ids;
}

export function articleRelatedPlayerIds(article = {}) {
  const ids = [];
  appendUnique(ids, idsFrom(article.relatedPlayerIds));
  appendUnique(ids, idsFrom(article.story?.relatedPlayerIds));
  appendUnique(ids, idsFrom(article.player?.playerId));
  appendUnique(ids, idsFrom(article.transfer?.playerId));
  return ids;
}

export function isRelatedColumnArticle(article = {}) {
  return isPublicArticle(article) && COLUMN_TYPES.has(article.type);
}

export function relatedColumnArticles(entries, { teamId = null, playerId = null, limit = 12 } = {}) {
  const safeTeamId = positiveId(teamId);
  const safePlayerId = positiveId(playerId);
  if (!safeTeamId && !safePlayerId) return [];
  const max = Math.min(Math.max(1, Number(limit) || 12), 24);
  return (Array.isArray(entries) ? entries : [])
    .filter(isRelatedColumnArticle)
    .filter((article) => (
      (safeTeamId && articleRelatedTeamIds(article).includes(safeTeamId))
      || (safePlayerId && articleRelatedPlayerIds(article).includes(safePlayerId))
    ))
    .sort((left, right) => new Date(right.publishedAt || 0) - new Date(left.publishedAt || 0))
    .slice(0, max);
}
