import playerCards from '../prediction-key-players.js';
import reportPresentation from '../match-report-presentation.js';
import { motmCardReference } from './match-report-motm-data.js';
import {
  articleDescription,
  escapeHtml,
} from './article-page-html.js';

const SITE_ORIGIN = 'https://am4football.com';

function text(value) {
  return String(value ?? '');
}

function safeIsoDate(value) {
  const raw = text(value).trim();
  // `new Date(null)` is the Unix epoch. Older editorial archives intentionally
  // have no kickoff timestamp, so treat an absent value as absent rather than
  // rendering a misleading 1970-01-01 kickoff.
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeMatchKey(value) {
  const key = text(value).trim();
  return key && key.length <= 320 ? key : null;
}

// Reader navigation must stay on the active deployment. Canonical URLs remain
// absolute for SEO, but an SSR Preview must never send its isolated article
// verification back to Production.
function articleReaderHref(articleId) {
  const id = text(articleId).trim();
  return `/article.html?id=${encodeURIComponent(id)}`;
}

function safeHttpUrl(value) {
  const source = text(value).trim();
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function matchCanonicalUrl({ fixtureId, articleId, matchKey } = {}) {
  const numericId = Number(fixtureId);
  if (Number.isInteger(numericId) && numericId > 0) {
    return `${SITE_ORIGIN}/match.html?id=${numericId}`;
  }
  const article = text(articleId).trim();
  if (article) return `${SITE_ORIGIN}/match.html?article=${encodeURIComponent(article)}`;
  const key = safeMatchKey(matchKey);
  if (key) return `${SITE_ORIGIN}/match.html?matchKey=${encodeURIComponent(key)}`;
  return `${SITE_ORIGIN}/match.html`;
}

function formatKickoff(fixture = {}) {
  const kickoff = safeIsoDate(fixture.kickoff);
  if (kickoff) {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(kickoff));
  }
  const date = text(fixture.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

function fixtureScore(fixture = {}) {
  const home = fixture.goals?.home;
  const away = fixture.goals?.away;
  return home != null && away != null ? `${home} – ${away}` : 'VS';
}

function fixtureName(fixture = {}) {
  const home = text(fixture.home?.name).trim() || 'Home';
  const away = text(fixture.away?.name).trim() || 'Away';
  return `${home} vs ${away}`;
}

// Keep the first response aligned with the client-side overview. A preview
// carries the prediction and a completed fixture leads with its report.  A
// missing report is an operational state, not permission to present a
// pre-match prediction as the completed-match article: retain that prediction
// only in an explicitly labelled disclosure. Archives are the one intentional
// exception because they are editorial-only destinations.
function fixtureLifecycle(fixture = {}) {
  const status = text(fixture.status).trim().toUpperCase();
  if (['NS', 'TBD'].includes(status)) return 'upcoming';
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'].includes(status)) return 'live';
  if (['FT', 'AET', 'PEN'].includes(status)) return 'finished';
  return 'other';
}

function visibleEditorialTypes(detail = {}, editorials = {}) {
  if (detail?.archive) return ['prediction', 'report'];
  const lifecycle = fixtureLifecycle(detail?.fixture);
  if (lifecycle === 'upcoming' || lifecycle === 'live') return ['prediction'];
  if (lifecycle === 'finished') {
    if (editorials?.report?.id) return ['report'];
    // Always render the report-pending primary surface after full time. The
    // prediction remains available as a clearly marked pre-match disclosure,
    // never as the completed fixture's lead editorial.
    return editorials?.prediction?.id ? ['report', 'prediction'] : ['report'];
  }
  return [];
}

function eventStructuredData(fixture, canonical, description) {
  const home = text(fixture?.home?.name).trim();
  const away = text(fixture?.away?.name).trim();
  const kickoff = safeIsoDate(fixture?.kickoff);
  const venue = text(fixture?.venue?.name).trim();
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: fixtureName(fixture),
    description,
    url: canonical,
    ...(kickoff ? { startDate: kickoff } : {}),
    ...(home ? { homeTeam: { '@type': 'SportsTeam', name: home } } : {}),
    ...(away ? { awayTeam: { '@type': 'SportsTeam', name: away } } : {}),
    ...(venue ? { location: { '@type': 'Place', name: venue } } : {}),
  };
}

function editorialLabel(type) {
  return type === 'prediction' ? 'AM4 PREDICTION' : 'AM4 MATCH SUMMARY';
}

function editorialLinkLabel(type) {
  return type === 'prediction' ? '試合予想を全文で読む' : '試合解説を全文で読む';
}

function normalizeEditorialHeading(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/^\s*(?:#{1,6}\s*|\d+\s*[.．:：)）]\s*)/u, '')
    .replace(/[\s\-‐‑–—_:：・、。,.()（）\[\]【】]/gu, '');
}

function headingMatches(value, aliases = []) {
  const normalized = normalizeEditorialHeading(value);
  if (!normalized) return false;
  return aliases.some((alias) => {
    const candidate = normalizeEditorialHeading(alias);
    return candidate && (normalized.includes(candidate) || candidate.includes(normalized));
  });
}

function markdownSections(value) {
  const sections = [];
  let current = null;
  text(value).replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u);
    if (heading) {
      if (current?.body.trim()) sections.push(current);
      current = { heading: heading[1], body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  });
  if (current?.body.trim()) sections.push(current);
  return sections;
}

function compactLine(value) {
  return text(value).replace(/\*\*/g, '').replace(/\s+/g, '').trim();
}

function isPredictionScoreOrPickLine(value, prediction = {}) {
  const line = compactLine(value);
  if (!line) return true;
  const score = compactLine(prediction.score);
  if (score && line === score) return true;
  if (/^(?:本命|pick)\s*[:：]/iu.test(text(value).replace(/\*\*/g, '').trim())) return true;
  return /^(?:予想(?:スコア)?|score)\s*[:：]/iu.test(text(value).replace(/\*\*/g, '').trim());
}

function isStandalonePredictionScoreLine(value) {
  const line = text(value).replace(/\*\*/g, '').trim();
  return line.length <= 160
    && !/[。！？!?]/u.test(line)
    && /\d+\s*(?:-|–|—)\s*\d+/u.test(line);
}

function predictionScoreFromBody(article) {
  const section = markdownSections(article?.body)
    .find((entry) => headingMatches(entry.heading, ['予想スコア', 'score prediction', 'prediction score']));
  return text(section?.body).split('\n')
    .map((line) => line.replace(/\*\*/g, '').trim())
    .find((line) => /\d+\s*(?:-|–|—)\s*\d+/u.test(line)) || '';
}

function predictionPickFromBody(article) {
  const section = markdownSections(article?.body)
    .find((entry) => headingMatches(entry.heading, ['予想スコア', 'score prediction', 'prediction score']));
  const line = text(section?.body).split('\n')
    .map((entry) => entry.replace(/\*\*/g, '').trim())
    .find((entry) => /^(?:本命|pick)\s*[:：]/iu.test(entry));
  return line?.replace(/^(?:本命|pick)\s*[:：]\s*/iu, '').trim() || '';
}

// Legacy Notion predictions often start with a score section and then an
// unheaded introduction. That introduction is article body, not the 150-char
// list deck. Keep every authored line except the score/pick metadata.
function predictionIntroduction(article) {
  const lines = text(article?.body).replace(/\r\n?/g, '\n').split('\n');
  const prediction = {
    ...(article?.prediction || {}),
    score: text(article?.prediction?.score).trim() || predictionScoreFromBody(article),
  };
  const scoreHeading = ['予想スコア', 'score prediction', 'prediction score'];
  let inScoreSection = false;
  let sawScore = false;
  const collected = [];
  for (const line of lines) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u);
    if (heading) {
      if (inScoreSection) break;
      inScoreSection = headingMatches(heading[1], scoreHeading);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length) collected.push('');
      continue;
    }
    const isMetadata = isPredictionScoreOrPickLine(trimmed, prediction)
      || (inScoreSection && isStandalonePredictionScoreLine(trimmed));
    if (isMetadata) {
      sawScore = true;
      continue;
    }
    if (inScoreSection || sawScore || !lines.some((entry) => /^\s*#{1,6}\s+/u.test(entry))) collected.push(line);
  }
  return collected.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function predictionDetailLead(article, aliases = []) {
  const section = markdownSections(article?.body).find((entry) => headingMatches(entry.heading, aliases));
  if (section?.body.trim()) return section.body.trim();
  const introduction = predictionIntroduction(article);
  if (introduction) return introduction;
  // A dedicated structured field remains useful when body is genuinely
  // unavailable, but summary/deck are list and SEO excerpts and never qualify.
  return text(article?.body).trim() ? '' : text(article?.prediction?.summary).trim();
}

function editorialValue(article, kind, field, aliases = []) {
  const structured = text(article?.[kind]?.[field]).trim();
  if (structured) return structured;
  const section = markdownSections(article?.body).find((entry) => headingMatches(entry.heading, aliases));
  if (section?.body.trim()) return section.body.trim();
  if (field === 'summary' && kind !== 'prediction') return text(article?.summary || article?.deck).trim();
  return '';
}

function stripRepeatedEditorialHeading(value, aliases = []) {
  const lines = text(value).replace(/\r\n?/g, '\n').split('\n');
  const first = lines[0]?.trim() || '';
  if (/^(?:#{1,6}\s+|\d+\s*[.．:：)）]\s*)/u.test(first) && headingMatches(first, aliases)) lines.shift();
  return lines.join('\n').trim();
}

function renderEditorialText(value, aliases = []) {
  const cleaned = stripRepeatedEditorialHeading(value, aliases);
  if (!cleaned) return '';
  const blocks = [];
  let pendingList = null;
  const flushList = () => {
    if (!pendingList?.items.length) return;
    blocks.push(`<${pendingList.type} class="match-editorial-list">${pendingList.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${pendingList.type}>`);
    pendingList = null;
  };

  cleaned.split(/\n\s*\n+/u).forEach((paragraph) => {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    const list = lines.every((line) => /^[-*+]\s+/u.test(line))
      ? { type: 'ul', items: lines.map((line) => line.replace(/^[-*+]\s+/u, '')) }
      : lines.every((line) => /^\d+[.)．]\s+/u.test(line))
        ? { type: 'ol', items: lines.map((line) => line.replace(/^\d+[.)．]\s+/u, '')) }
        : null;
    if (list) {
      if (pendingList?.type !== list.type) flushList();
      if (!pendingList) pendingList = { type: list.type, items: [] };
      pendingList.items.push(...list.items);
      return;
    }
    flushList();
    blocks.push(`<p>${escapeHtml(lines.join(' '))}</p>`);
  });
  flushList();
  return blocks.join('');
}

function compactEditorialBlock({ label, value, aliases = [], field = '', reportField = '' } = {}) {
  const body = renderEditorialText(value, [label, ...aliases]);
  if (!body) return '';
  const attributes = [
    field ? ` data-ssr-editorial-field="${escapeHtml(field)}"` : '',
    reportField ? ` data-report-field="${escapeHtml(reportField)}"` : '',
  ].join('');
  return `<article class="match-editorial-block"${attributes}><h3>${escapeHtml(label)}</h3>${body}</article>`;
}

function compactEditorialSources(article) {
  const links = (Array.isArray(article?.sources) ? article.sources : []).map((source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return '';
    const label = text(source?.title).trim() || new URL(url).hostname;
    return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`;
  }).filter(Boolean).join('');
  return links ? `<section class="match-editorial-sources"><h3>出典</h3><ul>${links}</ul></section>` : '';
}

function fallbackEditorialBlocks(article) {
  return markdownSections(article?.body).map((entry) => compactEditorialBlock({
    label: entry.heading.replace(/^\s*\d+\s*[.．:：)）]\s*/u, '') || 'AM4分析',
    value: entry.body,
    aliases: [entry.heading],
  })).filter(Boolean);
}

function additionalPredictionBlocks(article, knownAliases = []) {
  return markdownSections(article?.body)
    .filter((entry) => !knownAliases.some((aliases) => headingMatches(entry.heading, aliases)))
    .map((entry) => compactEditorialBlock({
      label: entry.heading.replace(/^\s*\d+\s*[.．:：)）]\s*/u, '') || 'AM4分析',
      value: entry.body,
      aliases: [entry.heading],
    }))
    .filter(Boolean);
}

// A compact report can have a structured summary and MOTM while its long-form
// body still contains verified sections that were not mapped to a named
// report property. Keep those sections behind the existing disclosure rather
// than silently reducing the match page to an excerpt. The full article link
// remains available too, but opening "さらに表示" must reach the body tail.
function additionalReportBlocks(article, knownAliases = []) {
  return markdownSections(article?.body)
    .filter((entry) => !knownAliases.some((aliases) => headingMatches(entry.heading, aliases)))
    .map((entry) => compactEditorialBlock({
      label: entry.heading.replace(/^\s*\d+\s*[.．:：)）]\s*/u, '') || 'AM4分析',
      value: entry.body,
      aliases: [entry.heading],
      reportField: 'additional',
    }))
    .filter(Boolean);
}

function compactPredictionEditorial(article, detail) {
  const prediction = article?.prediction || {};
  const score = text(prediction.score).trim() || predictionScoreFromBody(article);
  const pick = text(prediction.pick).trim() || predictionPickFromBody(article);
  const rawConfidence = prediction.confidence;
  const confidence = rawConfidence === '' || rawConfidence == null ? null : Number(rawConfidence);
  const keyPlayerAliases = ['キープレイヤー', 'キーマン', '注目選手', 'key player'];
  const matchOutlookAliases = ['予想される試合展開', '試合展開', 'match flow'];
  const summaryAliases = ['3行要約', '予想要約', 'summary', '試合の見どころ'];
  const summary = predictionDetailLead(article, summaryAliases);
  const matchOutlook = editorialValue(article, 'prediction', 'matchOutlook', matchOutlookAliases);
  const keyPlayers = editorialValue(article, 'prediction', 'keyPlayers', keyPlayerAliases);
  const cardSource = Array.isArray(prediction.keyPlayerCards) && prediction.keyPlayerCards.length
    ? prediction.keyPlayerCards
    : keyPlayers;
  const cardContent = playerCards.renderPrediction(cardSource, detail?.fixture, playerCards.participants(detail));
  const keyBlock = (keyPlayers || (Array.isArray(cardSource) && cardSource.length))
    ? `<article class="match-editorial-block match-editorial-block--key-players" data-ssr-editorial-field="keyPlayers"><h3>キーマン</h3><div class="match-player-cards">${cardContent}</div></article>`
    : '';
  const summaryBlock = compactEditorialBlock({
    label: '試合の見どころ', value: summary, aliases: summaryAliases, field: 'summary',
  });

  const fields = [
    ['予想される試合展開', 'matchOutlook', matchOutlookAliases],
    ['前節レビュー', 'previousReview', ['前節レビュー', '前節の振り返り', 'previous match']],
    ['前節からの修正', 'adjustments', ['前節からの修正', '修正ポイント', 'adjustment']],
    ['戦術的な噛み合わせ', 'tacticalMatchup', ['戦術的な噛み合わせ', '戦術分析', 'tactical']],
    ['欠場情報', 'absences', ['欠場情報', '欠場者', 'absence']],
    ['予想の根拠', 'rationale', ['予想の根拠', '根拠', 'reason']],
  ];
  let moreBlocks = fields.map(([label, field, aliases]) => compactEditorialBlock({
    label, field, aliases, value: editorialValue(article, 'prediction', field, aliases),
  })).filter(Boolean);
  const knownAliases = [
    ['予想スコア', 'score prediction', 'prediction score'],
    summaryAliases,
    keyPlayerAliases,
    ...fields.map(([, , aliases]) => aliases),
  ];
  moreBlocks = [...moreBlocks, ...additionalPredictionBlocks(article, knownAliases)];
  const values = [
    score ? `<strong>${escapeHtml(score)}</strong>` : '',
    pick ? `<span class="match-prediction-pick"><small>本命</small><b>${escapeHtml(pick)}</b></span>` : '',
    Number.isFinite(confidence) ? `<span class="match-prediction-pick"><small>確信度</small><b>${escapeHtml(`${Math.round(confidence)}%`)}</b></span>` : '',
  ].filter(Boolean).join('');
  const topics = fields.map(([label]) => label).join(' / ');
  const more = moreBlocks.length || compactEditorialSources(article)
    ? `<details class="match-prediction-more" data-ssr-prediction-more="true"><summary><strong>予想の根拠・戦術を読む</strong><span class="match-report-topics">${escapeHtml(topics)}</span><span class="match-report-more-action">さらに表示 ↓</span></summary><div class="match-editorial-grid">${moreBlocks.join('')}</div>${compactEditorialSources(article)}</details>`
    : '';
  return `<div class="match-editorial-content match-editorial-content--prediction" data-ssr-prediction-compact="true">
  ${values ? `<div class="match-editorial-hero match-editorial-hero--prediction"><div class="match-prediction-values">${values}</div></div>` : ''}
  ${summaryBlock ? `<div class="match-editorial-grid" data-ssr-prediction-summary="true">${summaryBlock}</div>` : ''}
  ${keyBlock ? `<div class="match-editorial-grid" data-ssr-prediction-key-players="true">${keyBlock}</div>` : ''}
  ${more}
</div>`;
}

function compactReportEditorial(article, detail) {
  const report = article?.report || {};
  const reportAliases = [
    ['試合の見どころ', 'summary', ['3行要約', '試合要約', '試合概要', 'summary']],
    ['試合主要人物', 'keyFigures', ['試合主要人物', '主要人物', 'MOTM', 'key figure']],
    ['試合を分けたポイント', 'turningPoints', ['試合を分けたポイント', '勝負を分けたポイント', 'turning point']],
    ['前半レビュー', 'firstHalf', ['前半レビュー', 'first half']],
    ['後半レビュー', 'secondHalf', ['後半レビュー', 'second half']],
    ['戦術分析', 'tactics', ['戦術分析', '戦術解説', '戦術的なポイント', 'tactical']],
    ['個人パフォーマンス', 'individualPerformance', ['個人パフォーマンス', '個人評価', 'individual']],
    ['主要スタッツ', 'mainStats', ['主要スタッツ', '主なスタッツ', 'key stats']],
    ['結果の意味', 'resultMeaning', ['結果の意味', 'what the result']],
    ['次戦への課題', 'nextMatchFocus', ['次戦への課題', 'next match']],
  ];
  const summary = editorialValue(article, 'report', 'summary', reportAliases[0][2]);
  const keyFigures = editorialValue(article, 'report', 'keyFigures', reportAliases[1][2]);
  const players = playerCards.participants(detail);
  const storedMotm = motmCardReference(report.motmCard, detail?.fixture);
  const selection = reportPresentation.selectedMotm(keyFigures, players)
    || reportPresentation.editorialAm4Motm(article.id, keyFigures, players);
  const visibleKeyFigures = reportPresentation.withoutMotmAbstention(keyFigures);
  const keyBlock = storedMotm
    ? `<article class="match-editorial-block match-editorial-block--motm" data-report-field="keyFigures"><h3>MOTM</h3><div class="match-player-cards">${playerCards.renderMotm(storedMotm, {motm:true,label:'AM4選出'})}</div></article>`
    : selection
    ? `<article class="match-editorial-block match-editorial-block--motm" data-report-field="keyFigures"><h3>MOTM</h3><div class="match-player-cards">${playerCards.renderMotm(playerCards.motmReference(visibleKeyFigures, selection, detail?.fixture, players), {motm:true,label:'AM4選出'})}</div></article>`
    : compactEditorialBlock({label:'試合主要人物', value:visibleKeyFigures, aliases:reportAliases[1][2],field:'keyFigures',reportField:'keyFigures'});

  let moreBlocks = reportAliases.slice(2).map(([label, field, aliases]) => compactEditorialBlock({
    label, field, aliases, reportField: field, value: editorialValue(article, 'report', field, aliases),
  })).filter(Boolean);
  const knownAliases = reportAliases.map(([, , aliases]) => aliases);
  const bodyOnlyBlocks = additionalReportBlocks(article, knownAliases);
  if (!Object.values(report).some((value) => text(value).trim())) {
    moreBlocks = fallbackEditorialBlocks(article);
  } else {
    moreBlocks = [...moreBlocks, ...bodyOnlyBlocks];
  }
  const topics = reportAliases.slice(2).map(([label]) => label).join(' / ');
  const more = moreBlocks.length || compactEditorialSources(article)
    ? `<details class="match-report-more" data-ssr-report-more="true"><summary><strong>試合のレビュー・分析を読む</strong><span class="match-report-topics">${escapeHtml(topics)}</span><span class="match-report-more-action">さらに表示 ↓</span></summary><div class="match-editorial-grid">${moreBlocks.join('')}</div>${compactEditorialSources(article)}</details>`
    : '';
  return `<div class="match-editorial-content match-editorial-content--report" data-ssr-report-compact="true">
  ${summary ? `<div class="match-editorial-hero">${renderEditorialText(summary, reportAliases[0][2])}</div>` : ''}
  ${keyBlock ? `<div class="match-editorial-grid">${keyBlock}</div>` : ''}
  ${more}
</div>`;
}

function renderEditorial(type, article, { disclosure = false, detail } = {}) {
  if (!article?.id) {
    if (type !== 'report') return '';
    return `<article class="match-initial-editorial" id="report" data-ssr-editorial="report" data-ssr-editorial-pending="true">
  <div class="match-section-head"><h2>${editorialLabel('report')}</h2></div>
  <p class="match-editorial-pending">試合解説を準備中です。公開・同期状況を確認しています。</p>
</article>`;
  }
  const content = `${type === 'prediction' ? compactPredictionEditorial(article, detail) : compactReportEditorial(article, detail)}
  <p class="match-editorial-full-link"><a href="${escapeHtml(articleReaderHref(article.id))}">${editorialLinkLabel(type)}</a></p>`;
  return `<article class="match-initial-editorial" id="${type === 'prediction' ? 'prediction' : 'report'}" data-ssr-editorial="${type}">
  <div class="match-section-head"><h2>${editorialLabel(type)}</h2></div>
  ${disclosure ? `<details class="match-editorial-disclosure"><summary>試合前のAM4予想を読む</summary>${content}</details>` : content}
</article>`;
}

function renderFixtureBoard(fixture = {}) {
  const home = text(fixture.home?.name).trim() || 'Home';
  const away = text(fixture.away?.name).trim() || 'Away';
  const competition = text(fixture.competition).trim() || '大会情報';
  const status = text(fixture.statusLong || fixture.status).trim();
  const competitionLogo = safeHttpUrl(fixture.competitionLogo);
  const crest = (team, name) => {
    const logo = safeHttpUrl(team?.logo);
    return `<span class="match-crest">${logo
      ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(`${name}のエンブレム`)}" width="76" height="76" decoding="async">`
      : `<span class="match-crest-fallback" aria-hidden="true">${escapeHtml(name.slice(0, 3))}</span>`
    }</span>`;
  };
  const teamIdentity = (team, name) => {
    const id = Number(team?.id);
    const content = `${crest(team, name)}<h2>${escapeHtml(name)}</h2>`;
    return Number.isInteger(id) && id > 0
      ? `<a class="match-team-link" href="/teams/${id}">${content}</a>`
      : `<div class="match-team-identity">${content}</div>`;
  };
  const facts = [
    ['キックオフ', formatKickoff(fixture)],
    ['大会', competition],
    ['ラウンド', text(fixture.roundLabel || fixture.round).trim()],
    ['ステータス', status],
    ['会場', [fixture.venue?.name, fixture.venue?.city].filter(Boolean).join(' · ')],
    ['主審', text(fixture.referee).trim()],
  ].filter(([, value]) => value);

  return `<article class="match-board" data-ssr-match-board="true">
  <h1 class="sr-only">${escapeHtml(fixtureName(fixture))}</h1>
  <div class="match-competition">${competitionLogo ? `<img src="${escapeHtml(competitionLogo)}" alt="" width="32" height="32" decoding="async">` : ''}<span>${escapeHtml(competition)}</span>${fixture.competitionCountry ? `<small>${escapeHtml(fixture.competitionCountry)}</small>` : ''}</div>
  <p class="match-meta">${escapeHtml([formatKickoff(fixture), text(fixture.roundLabel || fixture.round).trim(), status].filter(Boolean).join(' · '))}</p>
  <div class="match-score-grid">
    <div class="match-team match-team--home">${teamIdentity(fixture.home, home)}</div>
    <div class="match-score"><strong>${escapeHtml(fixtureScore(fixture))}</strong><span>${fixture.goals?.home != null && fixture.goals?.away != null ? 'SCORE' : 'KICKOFF'}</span></div>
    <div class="match-team match-team--away">${teamIdentity(fixture.away, away)}</div>
  </div>
  ${facts.length ? `<dl class="match-facts">${facts.map(([label, value]) => `<div class="match-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
</article>`;
}

function pageShell({ title, head, main, initialMatch = null }) {
  const initial = initialMatch
    ? `<script id="am4-initial-match" type="application/json">${jsonForHtml(initialMatch)}</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="theme-color" content="#060a17">
  ${head}
  <script async src="/api/adsense.js"></script>
  <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+JP:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/brand.css?v=20260913-company-contact-v1">
  <link rel="stylesheet" href="/night-stage.css?v=20260908-light-ribbons-v3">
  <link rel="stylesheet" href="/reading.css?v=20260912-player-cards-v2">
</head>
<body class="match-page">
  <header class="brand-topbar">
    <a class="brand-wordmark" href="/" aria-label="AM4 Football ホームへ"><img src="/am4-logo.png" alt="AM4"><small>Football</small></a>
    <span class="brand-pill">Match Centre</span>
  </header>
  <main class="match-shell" id="match-page" aria-live="polite">
    <a class="match-back" href="/#fixtures">試合一覧へ戻る</a>
    ${main}
  </main>
  <footer class="brand-footer"><span>© AM4 Football</span><span class="footer-links"><a class="footer-privacy-link" href="/privacy">プライバシーポリシー</a><a class="footer-privacy-link" href="/company">企業情報</a><a class="footer-privacy-link" href="/contact">お問い合わせ</a></span><span>Editorial Match OS</span></footer>
  ${initial}
  <script src="/favorites.js?v=20260906-am4-improvements-v1"></script>
  <script src="/article-load-state.js?v=20260908-reading-navigation-v1"></script>
  <script src="/site-config.js"></script>
  <script src="/football-data.js?v=20260907-archive-match-v2"></script>
  <script src="/article-presentation.js?v=20260913-motm-copy-v7"></script>
  <script src="/article-reading.js?v=20260908-reading-navigation-v1"></script>
  <script src="/match-archive.js?v=20260918-match-identity-v6"></script>
  <script src="/editorial-list.js?v=20260908-match-report-v2"></script>
  <script src="/match-report-presentation.js?v=20260913-motm-copy-v7"></script>
  <script src="/match-detail-loader.js?v=20260907-archive-match-v2"></script>
  <script src="/match-editorial-fallback.js?v=20260907-editorial-restore-v2"></script>
  <script src="/match-transition.js?v=20260910-match-transition-v1"></script>
  <script src="/navigation-state.js?v=20260906-navigation-v2"></script>
  <script src="/entity-navigation-feedback.js?v=20260914-entity-navigation-v1"></script>
  <script src="/player-display.js"></script>
  <script src="/formation-layout.js?v=20260911-lineup-fix-v1"></script>
  <script src="/prediction-key-players.js?v=20260913-prediction-key-v10"></script>
  <script src="/match-detail.js?v=20260913-prediction-key-v10"></script>
</body>
</html>`;
}

export function renderMatchPage({
  detail = {},
  editorials = {},
  route = 'fixture',
  fixtureId = null,
  archiveArticleId = null,
  canonicalKey = null,
} = {}) {
  const fixture = detail.fixture || {};
  const canonical = matchCanonicalUrl({
    fixtureId: route === 'fixture' ? fixtureId : null,
    articleId: route === 'archive' ? archiveArticleId : null,
    matchKey: route === 'archive' ? canonicalKey : null,
  });
  const editorialTypes = visibleEditorialTypes(detail, editorials);
  const lifecycle = fixtureLifecycle(fixture);
  const descriptionSource = editorialTypes.map((type) => editorials[type]).find(Boolean)
    || editorials.prediction || editorials.report || { title: fixtureName(fixture) };
  const description = `${fixtureName(fixture)}。${articleDescription(descriptionSource)}`.slice(0, 180);
  const title = `${fixtureName(fixture)}｜AM4 Football`;
  const { cacheControl: _cacheControl, ...initialDetail } = detail;
  const initialMatch = {
    version: 1,
    source: route,
    fixtureId: Number.isInteger(Number(fixtureId)) ? Number(fixtureId) : null,
    archiveArticleId: archiveArticleId || null,
    canonicalKey: canonicalKey || null,
    detail: initialDetail,
    editorial: {
      prediction: editorials.prediction || null,
      report: editorials.report || null,
      errors: editorials.errors || {},
    },
  };
  const head = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<script id="am4-match-structured-data" type="application/ld+json">${jsonForHtml(eventStructuredData(fixture, canonical, description))}</script>`,
  ].join('\n  ');
  const archiveNotice = detail.archive
    ? '<p class="match-overview-copy">公開済みのAM4記事から、過去試合の主要情報と解説を表示しています。</p>'
    : '';
  const main = `${renderFixtureBoard(fixture)}
<section class="match-section match-initial-panel" id="overview" data-ssr-match-panel="true">
${archiveNotice}
${editorialTypes.map((type) => renderEditorial(type, editorials[type], {
  disclosure: (lifecycle === 'live' || lifecycle === 'finished') && type === 'prediction', detail,
})).join('\n')}
</section>`;
  return pageShell({ title, head, main, initialMatch });
}

export function renderMatchErrorPage({ title, heading, message } = {}) {
  return pageShell({
    title: title || '試合が見つかりません｜AM4 Football',
    head: '<meta name="robots" content="noindex">',
    main: `<section class="match-page-state"><h1>${escapeHtml(heading || '試合が見つかりません')}</h1><p>${escapeHtml(message || 'URLを確認するか、試合一覧から別の試合を選んでください。')}</p></section>`,
  });
}
