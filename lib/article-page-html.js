import articleContent from '../article-content.js';

const SITE_ORIGIN = 'https://am4football.com';
const DEFAULT_DESCRIPTION = 'AM4 Footballが届ける海外サッカーの物語と試合解説。';

const ARTICLE_TYPE_LABELS = {
  player_intro: 'Player Story',
  match_report: 'Match Report',
  match_prediction: 'Match Preview',
  am4_story: 'AM4 COLUMN',
  transfer_news: 'Transfer Wire',
};

function text(value) {
  return String(value ?? '');
}

export function escapeHtml(value) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function safeIsoDate(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function articleFreshnessDate(article = {}) {
  return safeIsoDate(article.updatedAt)
    || safeIsoDate(article.notion?.updatedAt)
    || safeIsoDate(article.publishedAt);
}

function formatTokyoDate(value) {
  const date = safeIsoDate(value);
  if (!date) return '公開日未設定';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date(date));
}

function articleTypeLabel(type) {
  return ARTICLE_TYPE_LABELS[type] || 'AM4 COLUMN';
}

function articleBlocks(article) {
  if (Array.isArray(article?.body)) return article.body;
  return articleContent.parseMarkdownBlocks(article?.body);
}

function readerEditorialText(value) {
  const stripExternalAwardClause = (sentence) => {
    const cleaned = String(sentence || '').replace(
      /(?:^|[、,]\s*)(?:Sky\s*Sport|Sofascore|FotMob|Sports Mole|UEFA|FIFA)[^、。！？!?]*(?:評価(?:点)?|評点|MVP|MOTM|POTM|選出)[^、。！？!?]*(?=[、。！？!?]|$)/giu,
      (match, offset, source) => {
        const before = source.slice(0, offset).trimEnd();
        const next = source.charAt(offset + match.length);
        if (!before) return '';
        return next === '、' || next === ',' ? '' : (/し$/u.test(before) ? 'た' : '');
      },
    ).replace(/^[、,]\s*/u, '').trim();
    return /[^\s、。！？!?]/u.test(cleaned) ? cleaned : '';
  };
  const sentences = text(value).replace(/\*\*/g, '').split(/\n+/)
    .flatMap((line) => line.match(/[^。！？!?]+[。！？!?]?/gu) || []).map(stripExternalAwardClause).map((line) => line.trim()).filter(Boolean);
  const isInternalMotmCopy = (sentence) => [
    /api[-\s]?football|api[-\s]?sports/iu,
    /(?:Sky\s*Sport|Sofascore|FotMob|Sports Mole|UEFA|FIFA)[^。！？!?]*(?:評価(?:点)?|評点|MVP|MOTM|POTM|選出)/iu,
    /(?:評価点|同評価|出場時間の順|得点・アシストへの関与[^。！？!?]*(?:比較|順))/iu,
    /(?:公式|信頼できる(?:媒体|情報源)?|外部(?:媒体|情報源)?)[^。！？!?]*(?:MOTM|POTM|MVP)[^。！？!?]*(?:確定|確認|発表|選出|設定|情報)[^。！？!?]*(?:ない|ず|ません|行わない|しない)/iu,
    /(?:推測|憶測)[^。！？!?]*(?:選出|設定)[^。！？!?]*(?:ない|ず|ません|行わない|しない)/iu,
    /(?:MOTM|POTM|MVP)[^。！？!?]*(?:確定情報|確認でき|選出は行わない|選出しない|設定しない|見つから)/iu,
    /選出(?:しない|(?:を|は)?行わない)|設定(?:しない|(?:を|は)?行わない)/u,
    /(?:信頼できる|公式|外部)[^。！？!?]*(?:記録|情報|媒体)[^。！？!?]*(?:照合|確認|限定|推測)/iu,
    /(?:推測|憶測)[^。！？!?]*(?:加えていない|避け(?:た|る)|しない|せず)/iu,
  ].some((pattern) => pattern.test(sentence));
  return sentences.filter((sentence) => !isInternalMotmCopy(sentence)).join(' ').trim();
}

function visibleArticleBlocks(article) {
  const clean = article?.type === 'match_report' ? readerEditorialText : text;
  return articleBlocks(article).map((block) => {
    if (Array.isArray(block?.items)) return { ...block, items: block.items.map(clean).filter(Boolean) };
    if (Array.isArray(block?.rows)) return {
      ...block,
      headers: (block.headers || []).map(clean),
      rows: block.rows.map((row) => (Array.isArray(row) ? row.map(clean) : [])),
    };
    return { ...block, text: clean(block?.text) };
  }).filter((block) => blockText(block).trim());
}

function blockText(block) {
  if (Array.isArray(block?.items)) return block.items.join(' ');
  if (Array.isArray(block?.rows)) return block.rows.flat().join(' ');
  return text(block?.text);
}

export function articleDescription(article = {}) {
  const preferred = [article.summary, article.deck].find((value) => text(value).trim());
  const clean = article.type === 'match_report' ? readerEditorialText : text;
  const source = clean(preferred) || visibleArticleBlocks(article).map(blockText).join(' ') || article.title || DEFAULT_DESCRIPTION;
  const compact = text(source).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (compact.length <= 155) return compact || DEFAULT_DESCRIPTION;
  return `${compact.slice(0, 154).trimEnd()}…`;
}

export function articleCanonicalUrl(id) {
  return `${SITE_ORIGIN}/article.html?id=${encodeURIComponent(text(id))}`;
}

function renderScoreboard(scoreboard) {
  if (!scoreboard) return '';
  const home = scoreboard.home || scoreboard.homeTeam || 'Home';
  const away = scoreboard.away || scoreboard.awayTeam || 'Away';
  const homeScore = scoreboard.homeScore ?? scoreboard.homeGoals ?? '-';
  const awayScore = scoreboard.awayScore ?? scoreboard.awayGoals ?? '-';
  return `<div class="article-scoreboard"><span>${escapeHtml(home)}</span><strong>${escapeHtml(`${homeScore} – ${awayScore}`)}</strong><span>${escapeHtml(away)}</span></div>`;
}

export function renderArticleBody(article = {}) {
  const body = visibleArticleBlocks(article).map((block) => {
    if (block?.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = Array.isArray(block.items) ? block.items : [];
      return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
    }
    if (block?.type === 'table') {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const head = `<thead><tr>${headers.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('')}</tr></thead>`;
      const tableRows = rows.map((row) => `<tr>${(Array.isArray(row) ? row : []).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
      return `<div class="article-table-wrap"><table>${head}<tbody>${tableRows}</tbody></table></div>`;
    }
    if (block?.type === 'heading') return `<h2>${escapeHtml(block.text)}</h2>`;
    if (block?.type === 'quote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
    return `<p>${escapeHtml(blockText(block))}</p>`;
  }).join('');

  const sources = Array.isArray(article.sources) ? article.sources : [];
  const sourceLinks = sources.map((source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return '';
    const label = text(source?.title).trim() || new URL(url).hostname;
    return `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></p>`;
  }).filter(Boolean).join('');
  const sourceSection = sourceLinks ? `<section class="article-sources"><h2>出典</h2>${sourceLinks}</section>` : '';

  return `<div class="article-body">${renderScoreboard(article.scoreboard)}${body}${sourceSection}</div>`;
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function articleStructuredData(article, { canonical, description, image }) {
  const publishedAt = safeIsoDate(article.publishedAt);
  const updatedAt = articleFreshnessDate(article);
  return {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: text(article.title).trim() || 'AM4 Football',
    description,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    ...(publishedAt ? { datePublished: publishedAt } : {}),
    ...(updatedAt ? { dateModified: updatedAt } : {}),
    ...(image ? { image } : {}),
    author: { '@type': 'Organization', name: 'AM4 Football' },
    publisher: { '@type': 'Organization', name: 'AM4 Football' },
    inLanguage: 'ja',
  };
}

function pageShell({ title, head, main, initialArticle = null }) {
  const initial = initialArticle
    ? `<script id="am4-initial-article" type="application/json">${jsonForHtml(initialArticle)}</script>`
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
  <link rel="stylesheet" href="/reading.css?v=20260910-column-readability-v1">
</head>
<body class="article-page">
  <header class="brand-topbar">
    <a class="brand-wordmark" href="/" aria-label="AM4 Football ホームへ"><img src="/am4-logo.png" alt="AM4"><small>Football</small></a>
    <div class="article-top-actions" id="article-top-actions"><span class="brand-pill" id="article-brand-pill">AM4 COLUMN</span></div>
  </header>
  <main class="article-shell">
    <a class="article-back" href="/">← ホームへ戻る</a>
    ${main}
  </main>
  <footer class="brand-footer"><span>© AM4 Football</span><span class="footer-links"><a class="footer-privacy-link" href="/privacy">プライバシーポリシー</a><a class="footer-privacy-link" href="/company">企業情報</a><a class="footer-privacy-link" href="/contact">お問い合わせ</a></span><span>Some Moments Matter More.</span></footer>
  ${initial}
  <script src="/favorites.js?v=20260906-am4-improvements-v1"></script>
  <script src="/site-config.js"></script>
  <script src="/football-data.js"></script>
  <script src="/match-archive.js?v=20260918-match-identity-v6"></script>
  <script src="/article-presentation.js?v=20260913-motm-copy-v7"></script>
  <script src="/article-load-state.js?v=20260908-reading-navigation-v1"></script>
  <script src="/navigation-state.js?v=20260906-navigation-v2"></script>
  <script src="/entity-navigation-feedback.js?v=20260914-entity-navigation-v1"></script>
  <script src="/article-content.js"></script>
  <script src="/article-reading.js?v=20260908-reading-navigation-v1"></script>
  <script src="/column-series.js?v=20260908-safe-reading-v1"></script>
  <script src="/article-page.js?v=20260913-motm-copy-v7"></script>
</body>
</html>`;
}

export function renderArticlePage(article = {}) {
  const canonical = articleCanonicalUrl(article.id);
  const description = articleDescription(article);
  const image = safeHttpUrl(article.coverImage);
  const title = `${text(article.title).trim() || 'AM4 Football'}｜AM4 Football`;
  const publishedAt = safeIsoDate(article.publishedAt);
  const structuredData = articleStructuredData(article, { canonical, description, image });
  const head = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    '<meta property="og:type" content="article">',
    '<meta property="og:locale" content="ja_JP">',
    '<meta property="og:site_name" content="AM4 Football">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}">`] : []),
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    ...(publishedAt ? [`<meta property="article:published_time" content="${escapeHtml(publishedAt)}">`] : []),
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<script id="am4-article-structured-data" type="application/ld+json">${jsonForHtml(structuredData)}</script>`,
  ].join('\n  ');
  const main = `<article class="article-paper" id="article-paper" aria-live="polite"><header class="article-header"><div class="article-kicker"><span>${escapeHtml(articleTypeLabel(article.type))}</span></div><h1 class="article-title">${escapeHtml(article.title)}</h1><div class="article-meta">${escapeHtml(`${formatTokyoDate(article.publishedAt)} · ${article.readTime || 'AM4編集部'}`)}</div></header>${renderArticleBody(article)}</article>`;
  return pageShell({ title, head, main, initialArticle: article });
}

export function renderArticleErrorPage({ title, heading, message }) {
  const head = '<meta name="robots" content="noindex">\n  <meta name="description" content="AM4 Footballの記事ページです。">';
  const main = `<article class="article-paper" id="article-paper" aria-live="polite"><div class="article-state"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><a class="brand-button" href="/">ホームへ戻る</a></div></article>`;
  return pageShell({ title, head, main });
}

function xmlEscape(value) {
  return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderSitemapXml(articles = []) {
  const staticUrls = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/column`, `${SITE_ORIGIN}/column/20-seasons`];
  const articleUrls = articles
    .filter((article) => text(article?.id).trim())
    .map((article) => {
      const lastmod = articleFreshnessDate(article)?.slice(0, 10);
      return `<url><loc>${xmlEscape(articleCanonicalUrl(article.id))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...staticUrls.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`), ...articleUrls].join('')}</urlset>`;
}
