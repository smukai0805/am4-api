import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserSameOriginHeaders,
  browserContextOptions,
  cardContainsAuthoredReason,
  defaultMonitorBrowserBaseUrl,
  expectedMonitorCards,
  headersWithoutScopedSecrets,
  initialHtmlContainsExpectedCard,
  initialEditorialForArticle,
  initialPayloadFromHtml,
  initialPayloadContainsExpectedCard,
  isMonitorSameOriginRequest,
  matchEditorialVerificationRoute,
  monitorFixtureBadgeUrl,
  verifySiteMonitorInBrowser,
} from '../lib/site-monitor-browser.js';

test('browser monitor keeps protected previews private while using Vercel automation bypass only when injected at runtime', () => {
  assert.equal(browserContextOptions({ VERCEL_AUTOMATION_BYPASS_SECRET: 'test-bypass' }).extraHTTPHeaders, undefined);
  assert.deepEqual(browserSameOriginHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: 'test-bypass' }), {
    'x-vercel-protection-bypass': 'test-bypass',
    'x-vercel-set-bypass-cookie': 'true',
  });
  assert.deepEqual(browserSameOriginHeaders({}), {});
});

test('browser monitor never sends deployment-protection headers to an external asset or HTTP origin', () => {
  const preview = 'https://preview.example.vercel.app';
  assert.equal(isMonitorSameOriginRequest('https://preview.example.vercel.app/match.html?id=1', preview), true);
  assert.equal(isMonitorSameOriginRequest('https://media.api-sports.io/football/players/1.png', preview), false);
  assert.equal(isMonitorSameOriginRequest('http://preview.example.vercel.app/match.html?id=1', preview), false);
});

test('browser monitor strips scoped credentials from an external redirect request', () => {
  const scoped = {
    'x-vercel-protection-bypass': 'bypass-secret',
    'x-vercel-set-bypass-cookie': 'true',
    'x-vercel-trusted-oidc-idp-token': 'short-lived-token',
  };
  assert.deepEqual(headersWithoutScopedSecrets({
    accept: 'image/avif,image/webp,*/*',
    'X-Vercel-Protection-Bypass': 'bypass-secret',
    'x-vercel-set-bypass-cookie': 'true',
    'X-Vercel-Trusted-Oidc-Idp-Token': 'short-lived-token',
  }, scoped), {
    accept: 'image/avif,image/webp,*/*',
  });
});

test('browser monitor inspects its own protected Preview unless a dedicated origin is configured', () => {
  assert.equal(
    defaultMonitorBrowserBaseUrl({ VERCEL_ENV: 'preview', VERCEL_URL: 'staging.example.vercel.app' }),
    'https://staging.example.vercel.app',
  );
  assert.equal(defaultMonitorBrowserBaseUrl({ VERCEL_ENV: 'production' }), 'https://am4football.com');
  assert.equal(
    defaultMonitorBrowserBaseUrl({ SITE_MONITOR_BROWSER_BASE_URL: 'https://check.example' }),
    'https://check.example',
  );
});

test('browser monitor opens the public match-centre date route when checking a fixture label', () => {
  const url = monitorFixtureBadgeUrl('https://am4football.com', { id: 1570376, date: '2026-09-13' }, 'monitor-check');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('matchDate'), '2026-09-13');
  assert.equal(url.searchParams.get('date'), null);
  assert.equal(url.searchParams.get('__siteMonitor'), 'monitor-check');
});

test('browser monitor uses Japan viewing date for a UTC fixture that crosses midnight', () => {
  const url = monitorFixtureBadgeUrl('https://am4football.com', {
    id: 1552759,
    // This remains the UTC identity date in the persisted Match Key, while
    // 15:15 UTC is 00:15 on the following day for the public JST list.
    date: '2026-09-13', kickoff: '2026-09-13T15:15:00+00:00',
  });
  assert.equal(url.searchParams.get('matchDate'), '2026-09-14');
});

test('browser monitor falls back to the persisted fixture date when kickoff is invalid', () => {
  const url = monitorFixtureBadgeUrl('https://am4football.com', {
    id: 1552759,
    date: '2026-09-13',
    kickoff: 'not-a-date',
  });
  assert.equal(url.searchParams.get('matchDate'), '2026-09-13');
});

test('browser monitor verifies finished predictions through their archive route', () => {
  assert.equal(
    matchEditorialVerificationRoute({ type: 'match_prediction' }, { status: 'FT' }),
    'archive',
  );
  assert.equal(
    matchEditorialVerificationRoute({ type: 'match_prediction' }, { status: 'AET' }),
    'archive',
  );
  assert.equal(
    matchEditorialVerificationRoute({ type: 'match_prediction' }, { status: 'PEN' }),
    'archive',
  );
  assert.equal(
    matchEditorialVerificationRoute({ type: 'match_prediction' }, { status: 'NS' }),
    'fixture',
  );
  assert.equal(
    matchEditorialVerificationRoute({ type: 'match_report' }, { status: 'FT' }),
    'fixture',
  );
  // The provider lookup used to select the monitor job can briefly lag the
  // actual reader-facing SSR request. The latter wins so a finished reader
  // page is checked through its archive rather than as a missing live card.
  assert.equal(
    matchEditorialVerificationRoute(
      { type: 'match_prediction' },
      { status: 'NS' },
      { detail: { fixture: { status: 'FT' } } },
    ),
    'archive',
  );
  assert.equal(
    matchEditorialVerificationRoute(
      { type: 'match_prediction' },
      { status: 'FT' },
      { detail: { fixture: { status: 'NS' } } },
    ),
    'fixture',
  );
});

test('browser monitor uses only verified structured card IDs, never prose guesses', () => {
  const cards = expectedMonitorCards({
    type: 'match_prediction',
    prediction: { keyPlayerCards: [
      { playerName: 'Known', playerId: 10, teamId: 20, photoUrl: 'https://images.example/10.png', resolved: true },
      { playerName: 'Guess', teamId: 21, photoUrl: 'https://images.example/guess.png', resolved: false },
    ] },
  });
  assert.deepEqual(cards, [{
    kind: 'key_player', playerId: 10, teamId: 20, playerName: 'Known', clubName: undefined, reason: undefined,
    photoUrl: 'https://images.example/10.png',
  }]);
});

test('browser monitor mirrors the one-home-one-away portrait contract', () => {
  const cards = expectedMonitorCards({
    type: 'match_prediction',
    prediction: { keyPlayerCards: [
      { playerName: 'First Home', playerId: 10, teamId: 20, side: 'home', photoUrl: 'https://images.example/10.png', resolved: true },
      { playerName: 'Second Home', playerId: 11, teamId: 20, side: 'home', photoUrl: 'https://images.example/11.png', resolved: true },
      { playerName: 'Away', playerId: 12, teamId: 21, side: 'away', photoUrl: 'https://images.example/12.png', resolved: true },
    ] },
  }, {
    home: { id: 20 }, away: { id: 21 },
  });
  assert.deepEqual(cards.map((card) => card.playerId), [10, 12]);
});

test('browser monitor reports unavailable when Chromium is not launchable rather than claiming repair success', async () => {
  const result = await verifySiteMonitorInBrowser({
    article: { id: 'article-1', body: '本文' },
    baseUrl: 'https://am4football.com',
    launch: async () => { throw new Error('Chromium executable not found'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'browser_runtime_unavailable');
  assert.equal(result.runtimeFailure, 'runtime_launch_failed');
});

test('browser monitor returns a distinct deferred result and closes Chromium when its worker budget expires', async () => {
  let closed = false;
  const result = await verifySiteMonitorInBrowser({
    article: { id: 'article-1', body: '本文' },
    baseUrl: 'https://am4football.com',
    timeoutMs: 20,
    launch: async () => ({
      async newContext() { return new Promise(() => {}); },
      async close() { closed = true; },
    }),
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'time_budget_exhausted');
  assert.equal(closed, true);
});

test('browser monitor reads the singular SSR editorial payload used by match pages', () => {
  const initial = {
    editorial: {
      prediction: { id: 'prediction-1' },
      report: { id: 'report-1' },
    },
  };
  assert.deepEqual(initialEditorialForArticle(initial, 'match_prediction'), { id: 'prediction-1' });
  assert.deepEqual(initialEditorialForArticle(initial, 'match_report'), { id: 'report-1' });
});

test('browser monitor requires a verified MOTM card in both the initial SSR payload and HTML', () => {
  const expected = {
    playerId: 276, teamId: 497, playerName: 'Paulo Dybala', clubName: 'AS Roma',
    reason: '決勝点を決めた。', photoUrl: 'https://media.api-sports.io/football/players/276.png',
  };
  const initial = {
    editorial: {
      report: {
        id: 'report-1',
        report: { motmCard: { ...expected, resolved: true } },
      },
    },
  };
  const html = '<section class="match-player-card" data-player-id="276" data-team-id="497" data-player-photo-url="https://media.api-sports.io/football/players/276.png"></section>';
  assert.equal(initialPayloadContainsExpectedCard(initial, 'match_report', expected), true);
  assert.equal(initialHtmlContainsExpectedCard(html, expected, 'match_report'), false);
  const scopedHtml = `<article data-ssr-editorial="report">${html}</article>`;
  assert.equal(initialHtmlContainsExpectedCard(scopedHtml, expected, 'match_report'), true);
  assert.equal(initialPayloadContainsExpectedCard({ editorial: { report: { id: 'report-1', report: {} } } }, 'match_report', expected), false);
  assert.equal(initialHtmlContainsExpectedCard('<section data-player-id="276"></section>', expected), false);
});

test('browser monitor parses the immutable response payload rather than a client-mutated DOM script', () => {
  const html = '<script id="am4-initial-match" type="application/json">{"editorial":{"report":{"id":"report-1"}}}</script>';
  assert.deepEqual(initialPayloadFromHtml(html, 'am4-initial-match'), { editorial: { report: { id: 'report-1' } } });
  assert.throws(() => initialPayloadFromHtml('<script id="am4-initial-match">not json</script>', 'am4-initial-match'), /not valid JSON/);
});

test('browser monitor requires every authored rationale paragraph while allowing HTML paragraph whitespace', () => {
  const reason = '選定基準：重要局面の貢献。\n\n決定機を演出して試合を動かした。';
  assert.equal(cardContainsAuthoredReason('AM4選出 選定基準：重要局面の貢献。\n決定機を演出して試合を動かした。', reason), true);
  assert.equal(cardContainsAuthoredReason('AM4選出 選定基準：重要局面の貢献。', reason), false);
});
