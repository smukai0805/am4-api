// Real-browser acceptance checks for the durable site monitor.  This module is
// server-only and dynamically imports Chromium so normal public requests never
// pay the browser startup cost.

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    // The monitor may hold a deployment-protection credential. Never allow a
    // configurable HTTP origin to receive that credential over the network.
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function safeBaseUrl(value) {
  return safeHttpsUrl(value || 'https://am4football.com');
}

function text(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function marker(value) {
  // Compare reader-visible text rather than Markdown punctuation. The same
  // persisted article legitimately appears as `<li>`, headings, or paragraphs
  // in SSR/client DOM, so a raw trailing "- " is not a delivery failure.
  const source = text(value)
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  return source.length > 72 ? source.slice(-72).trim() : source;
}

function visibleText(value) {
  return text(value).replace(/\s+/gu, ' ').trim();
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function predictionCardSide(card, fixture = null) {
  if (card?.side === 'home' || card?.side === 'away') return card.side;
  const teamId = positiveId(card?.teamId);
  if (!teamId) return null;
  if (teamId === positiveId(fixture?.home?.id)) return 'home';
  if (teamId === positiveId(fixture?.away?.id)) return 'away';
  return null;
}

function expectedCards(article, fixture = null) {
  if (article?.type === 'match_prediction') {
    // The public renderer deliberately shows at most one portrait for each
    // side. Extra same-side editorial references remain visible as prose so
    // no selected person is silently replaced. Mirror that actual display
    // contract here; otherwise the monitor can falsely demand a second card
    // which SSR intentionally does not render.
    const usedSides = new Set();
    return (Array.isArray(article?.prediction?.keyPlayerCards) ? article.prediction.keyPlayerCards : [])
      .flatMap((card) => {
        if (!card?.resolved || !positiveId(card.playerId) || !positiveId(card.teamId) || !card.photoUrl) return [];
        const side = predictionCardSide(card, fixture);
        // During real browser verification a fixture is always available. A
        // card without a verified home/away anchor is not a reader-visible
        // portrait and must be handled as a data-quality issue, not matched
        // to an arbitrary visual card.
        if (fixture && !side) return [];
        if (side && usedSides.has(side)) return [];
        if (side) usedSides.add(side);
        return [{
          kind: 'key_player', playerId: Number(card.playerId), teamId: Number(card.teamId),
          playerName: card.playerName, clubName: card.clubName, reason: card.reason, photoUrl: card.photoUrl,
        }];
      });
  }
  if (article?.type === 'match_report') {
    const card = article?.report?.motmCard;
    return card?.resolved && positiveId(card.playerId) && positiveId(card.teamId) && card.photoUrl
      ? [{ kind: 'motm', playerId: Number(card.playerId), teamId: Number(card.teamId), playerName: card.playerName, clubName: card.clubName, reason: card.reason, photoUrl: card.photoUrl }]
      : [];
  }
  return [];
}

export function expectedMonitorCards(article, fixture = null) {
  return expectedCards(article, fixture);
}

// `renderMatchPage` serializes its first-paint editorial data under the
// singular `editorial` key. Keep this small seam exported so the monitor's
// browser assertion is tied to the actual SSR contract rather than a separate
// shape that can silently drift.
export function initialEditorialForArticle(initial, articleType) {
  const editorials = initial?.editorial || {};
  return articleType === 'match_prediction' ? editorials.prediction : editorials.report;
}

function initialCardMatchesExpected(card, expected) {
  const actualName = String(card?.playerName || '').trim();
  const actualClub = String(card?.clubName || '').trim();
  const actualReason = String(card?.reason || '').trim();
  const expectedName = String(expected?.playerName || '').trim();
  const expectedClub = String(expected?.clubName || '').trim();
  const expectedReason = String(expected?.reason || '').trim();
  return Boolean(
    card?.resolved
    && Number(card.playerId) === Number(expected.playerId)
    && Number(card.teamId) === Number(expected.teamId)
    && String(card.photoUrl || card.photo || '') === String(expected.photoUrl || '')
    && actualName
    && actualClub
    && actualReason
    && (!expectedName || actualName === expectedName)
    && (!expectedClub || actualClub === expectedClub)
    && (!expectedReason || cardContainsAuthoredReason(actualReason, expectedReason)),
  );
}

// A client-side fallback may fill a card after the document loads, but it must
// not turn a missing first-paint card into a passing monitor result. Inspect
// the serialized SSR editorial structure as well as the live DOM below.
export function initialPayloadContainsExpectedCard(initial, articleType, expected) {
  const editorial = initialEditorialForArticle(initial, articleType);
  const cards = articleType === 'match_prediction'
    ? editorial?.prediction?.keyPlayerCards || []
    : [editorial?.report?.motmCard];
  return cards.some((card) => initialCardMatchesExpected(card, expected));
}

function htmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function initialEditorialHtml(html, articleType = null) {
  const source = String(html || '');
  if (!articleType) return source;
  const property = articleType === 'match_prediction' ? 'prediction' : 'report';
  const marker = `data-ssr-editorial="${property}"`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const next = source.indexOf('data-ssr-editorial="', start + marker.length);
  const mainEnd = source.indexOf('</main>', start);
  const end = [next, mainEnd].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? source.length;
  return source.slice(start, end);
}

export function initialHtmlContainsExpectedCard(html, expected, articleType = null) {
  const source = initialEditorialHtml(html, articleType);
  return [
    `data-player-id="${htmlAttribute(expected.playerId)}"`,
    `data-team-id="${htmlAttribute(expected.teamId)}"`,
    `data-player-photo-url="${htmlAttribute(expected.photoUrl)}"`,
  ].every((attribute) => source.includes(attribute));
}

// Paragraph tags preserve a rationale visually but `textContent` is permitted
// to concatenate adjacent paragraphs without their source newlines. Check
// every authored paragraph after visible-whitespace normalisation, rather
// than failing a complete rationale solely because of that DOM detail.
export function cardContainsAuthoredReason(cardText, reason) {
  const actual = visibleText(cardText);
  const paragraphs = text(reason).split(/\n\s*\n+/u).map(visibleText).filter(Boolean);
  return paragraphs.length > 0 && paragraphs.every((paragraph) => actual.includes(paragraph));
}

function fixtureFinished(fixture) {
  return ['FT', 'AET', 'PEN'].includes(String(fixture?.status || '').toUpperCase());
}

// A completed fixture deliberately presents its report on the fixture route,
// while retaining its pre-match prediction in the public article archive.
// Verify the latter through its own SSR route instead of either demanding a
// hidden live card or skipping the selected-player/photo check entirely.
function fixtureStatusFromInitial(initial) {
  const status = initial?.detail?.fixture?.status || initial?.fixture?.status || null;
  return status ? String(status).toUpperCase() : null;
}

export function matchEditorialVerificationRoute(article, fixture, fixtureInitial = null) {
  if (!['match_prediction', 'match_report'].includes(article?.type)) return null;
  // The reader-facing fixture document is the authoritative lifecycle seam.
  // A monitor-side provider fetch may briefly lag its SSR request; prefer the
  // state serialized by that actual document before falling back to the
  // previously resolved fixture object.
  const status = fixtureStatusFromInitial(fixtureInitial) || fixture?.status;
  return article?.type === 'match_prediction' && fixtureFinished({ status })
    ? 'archive'
    : 'fixture';
}

// Preview deployments can remain protected while the monitor performs its own
// browser verification. Vercel injects this system value only when Protection
// Bypass for Automation is enabled for the project; it is never written to a
// URL, page, log, or public response. These headers are installed per request
// below, never as context-wide browser headers, so third-party images/fonts
// cannot receive the credential.
export function browserContextOptions(env = process.env) {
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
}

export function browserSameOriginHeaders(env = process.env) {
  const bypass = String(env?.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  return bypass ? {
    'x-vercel-protection-bypass': bypass,
    'x-vercel-set-bypass-cookie': 'true',
  } : {};
}

export function isMonitorSameOriginRequest(requestUrl, baseUrl) {
  const request = safeHttpsUrl(requestUrl);
  const base = safeHttpsUrl(baseUrl);
  return Boolean(request && base && request.origin === base.origin);
}

// `route.continue({ headers })` can preserve an overridden header across a
// redirect. Remove every header this monitor injected when the redirected
// request is outside the protected AM4 origin; an image CDN must never receive
// a Preview bypass token (or a caller-supplied deployment credential).
export function headersWithoutScopedSecrets(requestHeaders = {}, scopedHeaders = {}) {
  const scoped = new Set(Object.keys(scopedHeaders || {}).map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(requestHeaders || {}).filter(([name]) => !scoped.has(name.toLowerCase())));
}

async function scopedBrowserContext(browser, origin, headers) {
  const context = await browser.newContext(browserContextOptions());
  if (!Object.keys(headers || {}).length) return context;
  await context.route('**/*', async (route) => {
    if (!isMonitorSameOriginRequest(route.request().url(), origin.href)) {
      // Explicitly pass a cleansed header map rather than relying on the
      // browser's redirect behaviour to drop credentials it did not create.
      await route.continue({ headers: headersWithoutScopedSecrets(route.request().headers(), headers) });
      return;
    }
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  return context;
}

export function defaultMonitorBrowserBaseUrl(env = process.env) {
  const configured = String(env?.SITE_MONITOR_BROWSER_BASE_URL || '').trim();
  if (configured) return configured;
  const previewHost = String(env?.VERCEL_URL || '').trim();
  return String(env?.VERCEL_ENV || '') === 'preview' && previewHost
    ? `https://${previewHost}`
    : 'https://am4football.com';
}

function labelForArticle(article, fixture, route = null) {
  if (article?.type === 'match_report') return 'report';
  // The existing product deliberately hides a completed fixture's old preview
  // badge while retaining the pre-match article in its archive/tab. Respect
  // that documented lifecycle rather than flagging it as a false regression.
  if (article?.type === 'match_prediction') {
    if (route === 'fixture') return 'prediction';
    if (route === 'archive') return null;
    if (!fixtureFinished(fixture)) return 'prediction';
  }
  return null;
}

async function defaultLaunch() {
  const [playwrightModule, chromiumModule] = await Promise.all([
    import('playwright-core'),
    import('@sparticuz/chromium'),
  ]);
  const chromium = chromiumModule.default || chromiumModule;
  const executablePath = await chromium.executablePath();
  return playwrightModule.chromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
}

function runtimeFailureClass(message) {
  const text = String(message || '').toLowerCase();
  if (/cannot find package|module not found/.test(text)) return 'module_missing';
  if (/enoent|no such file|does not exist|input directory/.test(text)) return 'runtime_asset_missing';
  if (/shared librar|\.so\b|libnss|glibc/.test(text)) return 'runtime_library_missing';
  if (/eacces|permission denied/.test(text)) return 'runtime_permission_denied';
  if (/enomem|out of memory|memory limit/.test(text)) return 'runtime_memory_exhausted';
  if (/timeout|timed out/.test(text)) return 'runtime_launch_timeout';
  if (/browser closed|closed unexpectedly/.test(text)) return 'runtime_closed_unexpectedly';
  if (/executable|chromium.*not|launch.*failed/.test(text)) return 'runtime_launch_failed';
  return 'runtime_unclassified';
}

function errorResult(error) {
  if (error instanceof BrowserTimeBudgetError) return { status: 'deferred', reason: 'time_budget_exhausted' };
  const message = error instanceof Error ? error.message : String(error || 'browser failure');
  const unavailable = /cannot find package|module not found|executable|chromium.*not|launch.*failed|enoent/i.test(message);
  return unavailable
    ? {
      status: 'unavailable', reason: 'browser_runtime_unavailable',
      runtimeFailure: runtimeFailureClass(message), error: message.slice(0, 500),
    }
    : { status: 'failed', failureKind: 'browser_assertion', error: message.slice(0, 500) };
}

class BrowserTimeBudgetError extends Error {
  constructor() {
    super('Browser verification stopped because the monitor time budget elapsed');
    this.name = 'BrowserTimeBudgetError';
  }
}

function browserBudgetMs(deadlineAt, timeoutMs) {
  const configured = Number(timeoutMs);
  const configuredMs = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null;
  const deadline = deadlineAt == null ? null : new Date(deadlineAt).getTime();
  const deadlineMs = Number.isFinite(deadline) ? deadline - Date.now() : null;
  if (deadlineMs != null && deadlineMs <= 0) return 0;
  if (configuredMs == null) return deadlineMs;
  return deadlineMs == null ? configuredMs : Math.min(configuredMs, deadlineMs);
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse the serialized HTTP response, not a DOM node after client scripts may
// enrich it. That makes first-paint checks evidence of SSR rather than of a
// later fallback that happens to restore the same card.
export function initialPayloadFromHtml(html, scriptId) {
  const expression = new RegExp(
    `<script\\b[^>]*\\bid=(["'])${regexEscape(scriptId)}\\1[^>]*>([\\s\\S]*?)<\\/script>`,
    'iu',
  );
  const raw = String(html || '').match(expression)?.[2] || '';
  if (!raw) throw new Error(`Initial payload #${scriptId} is missing`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Initial payload #${scriptId} is not valid JSON`);
  }
}

function withMonitorCacheKey(url, cacheKey) {
  if (cacheKey) url.searchParams.set('__siteMonitor', String(cacheKey).slice(0, 180));
  return url;
}

function tokyoFixtureDate(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const date = `${parts.year || ''}-${parts.month || ''}-${parts.day || ''}`;
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

function publicFixtureListDate(fixture = {}) {
  // Article Match Keys intentionally retain the provider's UTC date. The
  // public match centre, however, groups fixtures by Japan viewing date. A
  // 15:15 UTC kickoff belongs to the next day's list in Japan, so use the
  // verified kickoff instant when it is present and only fall back to the
  // legacy date for fixtures without one.
  return tokyoFixtureDate(fixture?.kickoff)
    || (/^\d{4}-\d{2}-\d{2}$/u.test(String(fixture?.date || '')) ? fixture.date : null);
}

// The public match centre deliberately uses `matchDate`, not the API's
// internal `date` parameter. Keep the browser monitor at that public URL
// seam so it verifies the same list a reader receives.
export function monitorFixtureBadgeUrl(baseUrl, fixture = {}, cacheKey = '') {
  const url = new URL('/', baseUrl);
  const matchDate = publicFixtureListDate(fixture);
  if (matchDate) url.searchParams.set('matchDate', matchDate);
  return withMonitorCacheKey(url, cacheKey);
}

async function verifyArticleDocument(page, baseUrl, article, cacheKey) {
  const url = new URL('/article.html', baseUrl);
  url.searchParams.set('id', article.id);
  withMonitorCacheKey(url, cacheKey);
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  if (!response || response.status() !== 200) throw new Error(`Article document status was ${response?.status?.() || 'unavailable'}`);
  const initialHtml = await response.text();
  if (!initialHtml.includes('id="am4-initial-article"')) throw new Error('Article initial HTML payload is missing');
  const apiArticle = await page.evaluate(async ({ id, cacheKey }) => {
    const query = new URLSearchParams({ id });
    if (cacheKey) query.set('__siteMonitor', cacheKey);
    const result = await fetch(`/api/articles?${query.toString()}`, { headers: { accept: 'application/json' } });
    if (!result.ok) throw new Error(`article API ${result.status}`);
    return result.json();
  }, { id: article.id, cacheKey: cacheKey ? String(cacheKey).slice(0, 180) : '' });
  if (text(apiArticle?.article?.body) !== text(article.body)) throw new Error('Article delivery API body differs from the verified mirror');
  const initial = initialPayloadFromHtml(initialHtml, 'am4-initial-article');
  if (text(initial?.body) !== text(article.body)) throw new Error('Article initial HTML body differs from delivery API');
  const tail = marker(article.body);
  if (tail && !visibleText(await page.locator('.article-body').innerText({ timeout: 10_000 })).includes(tail)) {
    throw new Error('Article client rendering does not contain the body tail');
  }
  return { url: url.href, tailChecked: Boolean(tail) };
}

async function verifyCard(page, expected, failedImages) {
  const selector = `.match-player-card[data-player-id="${expected.playerId}"][data-team-id="${expected.teamId}"]`;
  const card = page.locator(selector).first();
  if (await card.count() !== 1) throw new Error(`Selected ${expected.kind} card is missing for player ${expected.playerId}`);
  await card.waitFor({ state: 'visible', timeout: 12_000 });
  const details = await card.evaluate((element, expectedPhoto) => {
    const image = element.querySelector('.match-player-portrait img');
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      playerId: element.getAttribute('data-player-id'),
      imageUrl: image?.currentSrc || image?.src || null,
      complete: Boolean(image?.complete),
      naturalWidth: Number(image?.naturalWidth || 0),
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      expectedPhoto,
      text: element.innerText || element.textContent || '',
    };
  }, expected.photoUrl);
  if (!details.complete) {
    await page.waitForFunction((query) => {
      const image = document.querySelector(`${query} .match-player-portrait img`);
      return Boolean(image?.complete);
    }, selector, { timeout: 10_000 });
  }
  const complete = await card.evaluate((element) => {
    const image = element.querySelector('.match-player-portrait img');
    return {
      complete: Boolean(image?.complete),
      naturalWidth: Number(image?.naturalWidth || 0),
      src: image?.currentSrc || image?.src || null,
      visible: (() => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })(),
      text: element.innerText || element.textContent || '',
    };
  });
  if (!complete.complete || complete.naturalWidth <= 0) throw new Error(`Portrait did not load for player ${expected.playerId}`);
  if (complete.src !== expected.photoUrl) throw new Error(`Portrait URL does not match player ${expected.playerId}`);
  if (!complete.visible) throw new Error(`Portrait card is not visible for player ${expected.playerId}`);
  if (!complete.text.includes(String(expected.playerName || ''))) throw new Error(`Portrait card name mismatch for player ${expected.playerId}`);
  if (!complete.text.includes(String(expected.clubName || ''))) throw new Error(`Portrait card club mismatch for player ${expected.playerId}`);
  if (!cardContainsAuthoredReason(complete.text, expected.reason)) throw new Error(`Portrait card reason mismatch for player ${expected.playerId}`);
  if (failedImages.has(expected.photoUrl)) throw new Error(`Portrait request failed for player ${expected.playerId}`);
  return { playerId: expected.playerId, imageUrl: complete.src, naturalWidth: complete.naturalWidth };
}

async function verifyEditorialReaderLink(page, editorialId, articleId) {
  const readerLink = page.locator(`#${editorialId} .match-editorial-full-link a`).first();
  await readerLink.waitFor({ state: 'visible', timeout: 10_000 });
  const readerHref = await readerLink.getAttribute('href');
  if (readerHref !== `/article.html?id=${encodeURIComponent(articleId)}`) {
    throw new Error('Match editorial reader link points to the wrong article');
  }
}

function fixtureMatchDocumentUrl(baseUrl, fixture, cacheKey) {
  return withMonitorCacheKey(new URL(`/match.html?id=${encodeURIComponent(fixture.id)}`, baseUrl), cacheKey);
}

function archiveMatchDocumentUrl(baseUrl, article, cacheKey) {
  return withMonitorCacheKey(new URL(`/match.html?article=${encodeURIComponent(article.id)}`, baseUrl), cacheKey);
}

async function loadMatchDocument(page, url) {
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  if (!response || response.status() !== 200) throw new Error(`Match document status was ${response?.status?.() || 'unavailable'}`);
  const initialHtml = await response.text();
  if (!initialHtml.includes('id="am4-initial-match"')) throw new Error('Match initial HTML payload is missing');
  return { url, initialHtml, initial: initialPayloadFromHtml(initialHtml, 'am4-initial-match') };
}

function assertFixtureDocumentBound(document, fixture) {
  if (document?.initial?.source !== 'fixture' || Number(document.initial?.fixtureId) !== Number(fixture.id)) {
    throw new Error('Match fixture initial HTML is not bound to the expected fixture');
  }
}

function observeImageFailures(page, failedImages) {
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') failedImages.add(request.url());
  });
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) failedImages.add(response.url());
  });
}

async function verifyMatchDocument(page, baseUrl, article, fixture, failedImages, cacheKey, {
  route = matchEditorialVerificationRoute(article, fixture),
  initialDocument = null,
} = {}) {
  let document = initialDocument;
  if (!document) {
    const url = route === 'archive'
      ? archiveMatchDocumentUrl(baseUrl, article, cacheKey)
      : fixtureMatchDocumentUrl(baseUrl, fixture, cacheKey);
    document = await loadMatchDocument(page, url);
  }
  const { url, initialHtml, initial } = document;
  if (route === 'archive') {
    if (initial?.source !== 'archive' || initial?.archiveArticleId !== article.id) {
      throw new Error('Match archive initial HTML is not bound to the expected article');
    }
  } else {
    assertFixtureDocumentBound(document, fixture);
  }
  const entry = initialEditorialForArticle(initial, article.type);
  if (!entry || entry.id !== article.id) throw new Error('Match initial HTML points to the wrong editorial article');
  const expectedCardsForDisplay = expectedCards(article, fixture);
  for (const expected of expectedCardsForDisplay) {
    if (!initialPayloadContainsExpectedCard(initial, article.type, expected)) {
      throw new Error(`Initial SSR editorial card is missing for player ${expected.playerId}`);
    }
    if (!initialHtmlContainsExpectedCard(initialHtml, expected, article.type)) {
      throw new Error(`Initial SSR HTML card is missing for player ${expected.playerId}`);
    }
  }
  const cards = [];
  // This runs before opening a disclosure, changing tabs, or reloading the
  // page, which preserves the first-paint portrait test's cold context.
  for (const expected of expectedCardsForDisplay) cards.push(await verifyCard(page, expected, failedImages));
  const editorialId = article.type === 'match_prediction' ? 'prediction' : 'report';
  await verifyEditorialReaderLink(page, editorialId, article.id);
  const disclosure = page.locator('details.match-prediction-more, details.match-report-more').first();
  if (await disclosure.count()) {
    await disclosure.evaluate((element) => { element.open = true; });
    // The match detail intentionally presents selected structured sections;
    // `verifyArticleDocument` above is the full-body/tail assertion. Here we
    // verify that opening the detail exposes content and that its reader link
    // leads to that exact full article, rather than requiring a duplicate of
    // every body paragraph inside the compact match panel.
    const expanded = visibleText(await page.locator(`#${editorialId} .match-editorial-content`).innerText({ timeout: 10_000 }));
    if (!expanded) throw new Error('Expanded match editorial is empty');
  }
  // A short post-hydration observation catches the old regression where a
  // later client render removed an image that was present in SSR.
  await page.waitForTimeout(500);
  for (const expected of expectedCardsForDisplay) await verifyCard(page, expected, failedImages);
  await verifyEditorialReaderLink(page, editorialId, article.id);
  return { url: url.href, cards, route, fixtureStatus: fixtureStatusFromInitial(initial) || null };
}

async function verifyFixtureBadge(context, baseUrl, article, fixture, cacheKey, route = null) {
  const expected = labelForArticle(article, fixture, route);
  if (!expected) return { state: 'intentional_hidden' };
  const page = await context.newPage();
  try {
    const url = monitorFixtureBadgeUrl(baseUrl, fixture, cacheKey);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const expectedHref = `/match.html?id=${Number(fixture.id)}`;
    const link = page.locator(`a.fixture-card-tap-target[href="${expectedHref}"]`).first();
    try {
      await link.waitFor({ state: 'attached', timeout: 15_000 });
    } catch {
      // The list is client-rendered. Preserve compact, non-editorial evidence
      // so an absent card is distinguishable from an unreachable browser or a
      // missing badge, without saving page text or credentials in the queue.
      const state = await page.evaluate((expectedHref) => {
        const cards = [...document.querySelectorAll('a.fixture-card-tap-target')];
        return {
          selectedDate: document.querySelector('.fixture-filter-tab[aria-pressed="true"]')?.getAttribute('data-fixture-filter') || null,
          cards: cards.length,
          matchingCards: cards.filter((card) => card.getAttribute('href') === expectedHref).length,
        };
      }, expectedHref).catch(() => ({ selectedDate: null, cards: null, matchingCards: null }));
      throw new Error(`Fixture card is absent (fixtureId=${Number(fixture.id)}, selectedDate=${state.selectedDate || 'unknown'}, cards=${state.cards ?? 'unknown'}, matchingCards=${state.matchingCards ?? 'unknown'})`);
    }
    const row = link.locator('xpath=ancestor::article[contains(@class, "fixture-row")]').first();
    const badge = row.locator(`.fixture-content-badge--${expected}`).first();
    await badge.waitFor({ state: 'visible', timeout: 15_000 });
    const href = await link.getAttribute('href');
    if (href !== `/match.html?id=${Number(fixture.id)}`) throw new Error('Fixture label points to the wrong match detail');
    return { state: 'passed', kind: expected, href };
  } finally {
    await page.close();
  }
}

export async function verifySiteMonitorInBrowser({
  article,
  fixture = null,
  baseUrl = defaultMonitorBrowserBaseUrl(),
  cacheKey = `${article?.id || 'article'}-${Date.now()}`,
  sameOriginHeaders = null,
  launch = defaultLaunch,
  // The monitor passes a bounded duration so one slow page/image cannot
  // consume the Function's final durable-cleanup window. Direct callers may
  // omit it and retain the normal Playwright per-step timeouts.
  deadlineAt = null,
  timeoutMs = null,
} = {}) {
  const origin = safeBaseUrl(baseUrl);
  if (!article?.id || !origin) return { status: 'unavailable', reason: 'browser_input_invalid' };
  const budgetMs = browserBudgetMs(deadlineAt, timeoutMs);
  if (budgetMs != null && budgetMs <= 0) return { status: 'deferred', reason: 'time_budget_exhausted' };
  let browser;
  let deadlineTimer = null;
  let deadlineElapsed = false;
  let closing = null;
  const closeBrowser = async () => {
    if (!browser) return;
    if (!closing) {
      const active = browser;
      browser = null;
      closing = active.close().catch(() => {});
    }
    await closing;
  };
  const deadline = budgetMs == null ? null : new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      deadlineElapsed = true;
      void closeBrowser();
      reject(new BrowserTimeBudgetError());
    }, budgetMs);
  });
  try {
    const work = (async () => {
      const launched = await launch();
      if (deadlineElapsed) {
        await launched.close().catch(() => {});
        throw new BrowserTimeBudgetError();
      }
      browser = launched;
      // Some serverless Chromium builds tear down their process when the
      // last incognito context closes. Keep one deliberately blank context
      // alive while we rotate cold contexts for article/lifecycle/portrait
      // checks. It never opens AM4 (or any other URL), so it cannot warm a
      // browser verification or receive a deployment-protection credential.
      await browser.newContext(browserContextOptions());
      const scopedHeaders = {
          ...browserSameOriginHeaders(),
          ...(sameOriginHeaders || {}),
      };
      const createContext = () => scopedBrowserContext(browser, origin, scopedHeaders);

      const verifyArticleInFreshContext = async () => {
        // Article reads and portrait checks intentionally use separate browser
        // contexts. An article fetch must never warm the first-paint match
        // photo test through an in-context HTTP/JS cache.
        const articleContext = await createContext();
        const articlePage = await articleContext.newPage();
        // Do not close this context until the browser closes. Some serverless
        // Chromium builds terminate the process when a context is closed;
        // this page is isolated, so retaining it cannot warm the portrait
        // context that follows.
        return verifyArticleDocument(articlePage, origin, article, cacheKey);
      };

      const probePredictionLifecycle = async () => {
        const lifecycleContext = await createContext();
        const lifecyclePage = await lifecycleContext.newPage();
        const failedImages = new Set();
        observeImageFailures(lifecyclePage, failedImages);
        const fixtureDocument = await loadMatchDocument(lifecyclePage, fixtureMatchDocumentUrl(origin, fixture, cacheKey));
        assertFixtureDocumentBound(fixtureDocument, fixture);
        const route = matchEditorialVerificationRoute(article, fixture, fixtureDocument.initial);
        if (route === 'fixture') {
          // This is already a cold first navigation for the reader's
          // visible prediction card, so retain it for the portrait check.
          return {
            route, context: lifecycleContext, page: lifecyclePage,
            failedImages, initialDocument: fixtureDocument,
          };
        }
        // The archive portrait opens in another cold context. Keep this probe
        // alive until browser shutdown rather than closing an active
        // serverless Chromium context mid-run.
        return { route, context: null, page: null, failedImages: null, initialDocument: null };
      };

      // The article and lifecycle probe do not share a cache and can run in
      // parallel. This keeps the bounded worker time focused on the final,
      // cold portrait check instead of serialising two unrelated reads.
      const articleWork = verifyArticleInFreshContext();
      const predictionWork = fixture?.id && article.type === 'match_prediction'
        ? probePredictionLifecycle()
        : Promise.resolve(null);
      const [articleResult, predictionResult] = await Promise.allSettled([articleWork, predictionWork]);
      const predictionProbe = predictionResult.status === 'fulfilled' ? predictionResult.value : null;
      if (articleResult.status !== 'fulfilled' || predictionResult.status !== 'fulfilled') {
        throw articleResult.status === 'rejected' ? articleResult.reason : predictionResult.reason;
      }
      const articleCheck = articleResult.value;

      let matchCheck = null;
      let badgeCheck = null;
      if (fixture?.id && matchEditorialVerificationRoute(article, fixture)) {
        const route = predictionProbe?.route || matchEditorialVerificationRoute(article, fixture);
        let matchContext = predictionProbe?.context || null;
        let matchPage = predictionProbe?.page || null;
        let failedImages = predictionProbe?.failedImages || null;
        const initialDocument = predictionProbe?.initialDocument || null;

        if (!matchContext) {
          matchContext = await createContext();
          matchPage = await matchContext.newPage();
          failedImages = new Set();
          observeImageFailures(matchPage, failedImages);
        }
        matchCheck = await verifyMatchDocument(matchPage, origin, article, fixture, failedImages, cacheKey, { route, initialDocument });
        // Do not open the list until the selected portrait has passed its
        // cold initial SSR/image check above.
        badgeCheck = await verifyFixtureBadge(matchContext, origin, article, fixture, cacheKey, matchCheck?.route || null);
      }
      return { status: 'passed', checks: { article: articleCheck, match: matchCheck, badge: badgeCheck } };
    })();
    return deadline ? await Promise.race([work, deadline]) : await work;
  } catch (error) {
    // Closing Chromium at the time budget can make an in-flight `newPage()`
    // reject before the deadline promise wins the race. Preserve the distinct
    // durable "deferred" outcome instead of recording that expected closure
    // as a visual regression.
    if (deadlineElapsed) return { status: 'deferred', reason: 'time_budget_exhausted' };
    return errorResult(error);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await closeBrowser();
  }
}
