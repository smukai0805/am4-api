const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('SSR keeps the full legacy introduction above key players and moves match flow into disclosure', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1550125,
    status: 'NS',
    date: '2026-09-15',
    kickoff: '2026-09-15T18:45:00Z',
    competition: 'セリエA',
    home: { id: 503, name: 'Torino', logo: 'https://media.api-sports.io/football/teams/503.png' },
    away: { id: 497, name: 'AS Roma', logo: 'https://media.api-sports.io/football/teams/497.png' },
  };
  const introduction = 'TorinoはFiorentina戦で見せた中盤の粘りを土台に、序盤からRomaの中央進出を制限したい。両サイドの押し上げとセカンドボール回収を続けられれば、速攻から相手最終ラインを揺さぶる余地が生まれる。一方でRomaは保持時の立ち位置を整え、終盤まで試合の主導権を渡さない設計を持ち込む。ここまでが150文字を超える導入文であり、最後の文末マーカーまで必ず詳細画面に残る。';
  assert.ok(introduction.length > 150);
  const prediction = {
    id: 'torino-roma',
    type: 'match_prediction',
    body: [
      '## 予想スコア',
      'Torino 1-2 Roma',
      '本命：Roma',
      introduction,
      '',
      '## 予想される試合展開',
      'Romaが前進を継続する。',
      '',
      '## キーマン',
      'Torino：Rolando Mandragora — 中盤で前進を止める。',
      '',
      'Roma：Donyell Malen — 背後を突く。',
      '',
      '## 最後の一言',
      '本文末尾まで残す追加の結語マーカー。',
    ].join('\n'),
    summary: '一覧専用の短縮文…',
    deck: '一覧専用の短縮文…',
    prediction: {
      score: 'Torino 1-2 Roma',
      pick: 'Roma',
      keyPlayers: 'Torino：Rolando Mandragora — 中盤で前進を止める。\n\nRoma：Donyell Malen — 背後を突く。',
      matchOutlook: 'Romaが前進を継続する。',
      keyPlayerCards: [
        {
          playerName: 'Rolando Mandragora',
          clubName: 'Torino',
          reason: '中盤で前進を止める。',
          teamId: 503,
          side: 'home',
          playerId: 30810,
          photoUrl: 'https://media.api-sports.io/football/players/30810.png',
          logoUrl: 'https://media.api-sports.io/football/teams/503.png',
          resolved: true,
        },
        {
          playerName: 'Donyell Malen',
          clubName: 'AS Roma',
          reason: '背後を突く。',
          teamId: 497,
          side: 'away',
          playerId: 249,
          photoUrl: 'https://media.api-sports.io/football/players/249.png',
          logoUrl: 'https://media.api-sports.io/football/teams/497.png',
          resolved: true,
        },
      ],
    },
  };

  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { prediction },
    route: 'fixture',
    fixtureId: fixture.id,
  });
  const main = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));
  const scoreAt = main.indexOf('Torino 1-2 Roma');
  const watchAt = main.indexOf('試合の見どころ');
  const keyAt = main.indexOf('キーマン');
  const detailsAt = main.indexOf('<details class="match-prediction-more"');
  const outlookAt = main.indexOf('予想される試合展開');

  assert.ok(scoreAt >= 0 && scoreAt < watchAt && watchAt < keyAt);
  assert.ok(detailsAt >= 0 && detailsAt < outlookAt);
  assert.match(main, /players\/30810\.png/);
  assert.match(main, /players\/249\.png/);
  assert.ok(main.includes('最後の文末マーカーまで必ず詳細画面に残る。'));
  assert.ok(main.includes('本文末尾まで残す追加の結語マーカー。'));
  assert.equal(main.includes('一覧専用の短縮文…'), false);
  assert.equal((main.match(/class="match-player-card"/g) || []).length, 2);
});

test('SSR derives a legacy body-only score once and keeps custom sections in disclosure', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1550125,
    status: 'NS',
    date: '2026-09-15',
    kickoff: '2026-09-15T18:45:00Z',
    competition: 'セリエA',
    home: { id: 503, name: 'Torino', logo: 'https://media.api-sports.io/football/teams/503.png' },
    away: { id: 497, name: 'AS Roma', logo: 'https://media.api-sports.io/football/teams/497.png' },
  };
  const prediction = {
    id: 'legacy-score',
    type: 'match_prediction',
    body: [
      '## 予想スコア',
      'Torino 1-2 Roma',
      '本命：Roma',
      'スコアと本命を除いた導入本文は、そのまま見どころとして残す。',
      '',
      '## 最後の一言',
      '折りたたみ内の本文末尾マーカー。',
    ].join('\n'),
    prediction: {},
  };
  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { prediction },
    route: 'fixture',
    fixtureId: fixture.id,
  });
  const main = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));
  assert.equal((main.match(/Torino 1-2 Roma/g) || []).length, 1);
  assert.match(main, /スコアと本命を除いた導入本文は、そのまま見どころとして残す。/);
  assert.match(main, /折りたたみ内の本文末尾マーカー。/);
  assert.ok(main.indexOf('Torino 1-2 Roma') < main.indexOf('試合の見どころ'));
});

test('SSR excludes a club-qualified body score when the structured score is numeric only', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1557400,
    status: 'NS',
    date: '2026-09-15',
    kickoff: '2026-09-15T18:45:00Z',
    competition: 'プレミアリーグ',
    home: { id: 1346, name: 'Coventry', logo: 'https://media.api-sports.io/football/teams/1346.png' },
    away: { id: 51, name: 'Brighton', logo: 'https://media.api-sports.io/football/teams/51.png' },
  };
  const prediction = {
    id: 'coventry-brighton',
    type: 'match_prediction',
    body: [
      '## 1. 予想スコア',
      'Coventry City 1-2 Brighton & Hove Albion',
      '本命：Brighton & Hove Albion',
      'この導入本文はスコア行ではないため、見どころとして全文を残す。',
      '',
      '## 2. 予想される試合展開',
      'Brightonが保持を進める。',
    ].join('\n'),
    prediction: { score: '1-2', pick: 'Brighton & Hove Albion' },
  };
  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { prediction },
    route: 'fixture',
    fixtureId: fixture.id,
  });
  const main = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));
  assert.match(main, /<strong>1-2<\/strong>/);
  assert.equal(main.includes('Coventry City 1-2 Brighton &amp; Hove Albion'), false);
  assert.match(main, /この導入本文はスコア行ではないため、見どころとして全文を残す。/);
});

test('SSR keeps a published prediction as a labelled disclosure after full-time until its report is available', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1570387,
    status: 'FT',
    date: '2026-09-10',
    kickoff: '2026-09-10T17:00:00Z',
    competition: 'ラ・リーガ',
    home: { id: 126, name: 'RC Deportivo' },
    away: { id: 536, name: 'Sevilla' },
  };
  const prediction = {
    id: 'notion-match_prediction-completed-fallback',
    type: 'match_prediction',
    body: '## 試合の見どころ\n終了後も読めるべき公開済み予想本文。',
    prediction: { summary: '終了後も読めるべき公開済み予想本文。' },
  };
  const report = {
    id: 'notion-match_report-completed-preferred',
    type: 'match_report',
    body: '## 試合の見どころ\n解説が届いた場合はこちらを優先する。',
    report: { summary: '解説が届いた場合はこちらを優先する。' },
  };

  const fallbackPage = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { prediction }, route: 'fixture', fixtureId: fixture.id,
  });
  const fallbackMain = fallbackPage.slice(fallbackPage.indexOf('<section class="match-section'), fallbackPage.indexOf('<script id="am4-initial-match"'));
  assert.match(fallbackMain, /AM4 MATCH SUMMARY/);
  assert.match(fallbackMain, /試合解説を準備中です。公開・同期状況を確認しています。/);
  assert.match(fallbackMain, /<details class="match-editorial-disclosure"><summary>試合前のAM4予想を読む<\/summary>/);
  assert.match(fallbackMain, /AM4 PREDICTION/);
  assert.match(fallbackMain, /終了後も読めるべき公開済み予想本文。/);
  assert.match(fallbackMain, /href="\/article\.html\?id=notion-match_prediction-completed-fallback"/);

  const reportPage = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { prediction, report }, route: 'fixture', fixtureId: fixture.id,
  });
  const reportMain = reportPage.slice(reportPage.indexOf('<section class="match-section'), reportPage.indexOf('<script id="am4-initial-match"'));
  assert.match(reportMain, /AM4 MATCH SUMMARY/);
  assert.match(reportMain, /解説が届いた場合はこちらを優先する。/);
  assert.equal(reportMain.includes('notion-match_prediction-completed-fallback'), false);
});

test('SSR keeps every unmapped match-report body section through its final marker in the disclosure', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1570391,
    status: 'FT',
    date: '2026-09-16',
    kickoff: '2026-09-15T17:00:00Z',
    competition: 'ラ・リーガ',
    home: { id: 728, name: 'Rayo Vallecano' },
    away: { id: 540, name: 'Espanyol' },
  };
  const report = {
    id: 'notion-match_report-full-body',
    type: 'match_report',
    body: [
      '# Rayo Vallecano 2-1 Espanyol｜La Ligaの記録',
      '## 試合概要',
      '確定スコアに基づく主表示の要約。',
      '',
      '## 検証済みの得点記録',
      '確認済みイベントだけを本文へ残す。',
      '',
      '## 総括',
      '本文末尾まで展開できる最終マーカー。',
      '',
      '## 試合主要人物',
      'MOTM：Álvaro García（Rayo Vallecano）。',
    ].join('\n'),
    report: { keyFigures: 'MOTM：Álvaro García（Rayo Vallecano）。' },
  };
  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { report }, route: 'fixture', fixtureId: fixture.id,
  });
  const main = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));
  const disclosureAt = main.indexOf('<details class="match-report-more"');
  const finalMarkerAt = main.indexOf('本文末尾まで展開できる最終マーカー。');
  assert.ok(disclosureAt >= 0 && disclosureAt < finalMarkerAt);
  assert.match(main, /確認済みイベントだけを本文へ残す。/);
  assert.match(main, /本文末尾まで展開できる最終マーカー。/);
});

test('SSR renders a verified stored MOTM portrait on the first match document', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1550125,
    status: 'FT',
    date: '2026-09-15',
    kickoff: '2026-09-15T18:45:00Z',
    competition: 'セリエA',
    home: { id: 503, name: 'Torino', logo: 'https://media.api-sports.io/football/teams/503.png' },
    away: { id: 497, name: 'AS Roma', logo: 'https://media.api-sports.io/football/teams/497.png' },
  };
  const report = {
    id: 'notion-match_report-dybala',
    type: 'match_report',
    body: '## 試合主要人物\nMOTM：Paulo Dybala（AS Roma）：決勝点を決めた。',
    report: {
      keyFigures: 'MOTM：Paulo Dybala（AS Roma）：決勝点を決めた。',
      motmCard: {
        playerName: 'Paulo Dybala', playerId: 276, teamId: 497, side: 'away', clubName: 'AS Roma',
        photoUrl: 'https://media.api-sports.io/football/players/276.png',
        logoUrl: 'https://media.api-sports.io/football/teams/497.png',
        reason: '決勝点を決めた。', resolved: true,
      },
    },
  };
  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { report }, route: 'fixture', fixtureId: fixture.id,
  });
  const initial = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));
  assert.match(initial, /data-player-id="276"/);
  assert.match(initial, /data-team-id="497"/);
  assert.match(initial, /data-player-photo-url="https:\/\/media\.api-sports\.io\/football\/players\/276\.png"/);
  assert.match(initial, /players\/276\.png/);
  assert.match(initial, /AS Roma/);
  assert.match(initial, /決勝点を決めた。/);
  assert.match(initial, /href="\/article\.html\?id=notion-match_report-dybala"/);
});

test('SSR presents the Brentford report as an explicit AM4 MOTM selection while an older mirror is draining', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1557408,
    status: 'FT',
    date: '2026-09-18',
    kickoff: '2026-09-18T19:00:00Z',
    competition: 'Premier League',
    home: { id: 55, name: 'Brentford' },
    away: { id: 49, name: 'Chelsea' },
  };
  const report = {
    id: 'notion-match_report-3dfb49a367ef81b88fd7cc9f3677597b',
    type: 'match_report',
    body: '# 試合主要人物\n\n公式または信頼できる媒体によるMOTM／POTM発表は確認できなかったため、推測では選出しない。\n\n最も大きな影響を与えたのはSchade。',
    report: {
      keyFigures: '公式または信頼できる媒体によるMOTM／POTM発表は確認できなかったため、推測では選出しない。\n\n最も大きな影響を与えたのはSchade。',
    },
  };

  const page = renderMatchPage({
    detail: { fixture, events: null, lineups: null, statistics: null },
    editorials: { report }, route: 'fixture', fixtureId: fixture.id,
  });
  const main = page.slice(page.indexOf('<section class="match-section'), page.indexOf('<script id="am4-initial-match"'));

  assert.match(main, /AM4選出/);
  assert.match(main, /Kevin Schade/);
  assert.match(main, /終盤2得点に直接関与/);
  assert.doesNotMatch(main, /推測では選出しない/);

  const { renderArticleBody, renderArticlePage } = await import('../lib/article-page-html.js');
  const articleBody = renderArticleBody(report);
  assert.match(articleBody, /AM4独自MOTM：Kevin Schade（Brentford）/);
  assert.match(articleBody, /終盤2得点に直接関与/);
  assert.doesNotMatch(articleBody, /推測では選出しない/);
  const articlePage = renderArticlePage({ ...report, title: 'Brentford vs Chelsea｜試合解説' });
  assert.ok(articlePage.indexOf('/match-report-presentation.js?v=20260918-brentford-motm-v8')
    < articlePage.indexOf('/article-page.js?v=20260918-brentford-motm-v8'));
  const clientSource = fs.readFileSync(require.resolve('../article-page.js'), 'utf8');
  assert.match(clientSource, /AM4MatchReportPresentation\?\.withEditorialArticleMotm/);
});
