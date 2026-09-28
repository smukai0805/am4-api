import assert from 'node:assert/strict';
import test from 'node:test';

test('SSR source links preserve names and replace a legacy placeholder with a domain label', async () => {
  const { renderArticleBody } = await import('../lib/article-page-html.js');
  const html = renderArticleBody({
    body: '本文。',
    sources: [
      { title: '-', url: 'https://www.uefa.com/nationsleague/match/2047985' },
      { title: 'Official match centre', url: 'https://example.test/match' },
    ],
  });

  assert.match(html, />uefa\.com<\/a>/);
  assert.match(html, />Official match centre<\/a>/);
  assert.doesNotMatch(html, />-<\/a>/);
});

test('match SSR gives the same safe label to compact editorial sources', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1528907, status: 'NS', date: '2026-09-28', kickoff: '2026-09-28T18:45:00Z', competition: 'UEFA Nations League',
    home: { id: 5, name: 'Sweden' }, away: { id: 24, name: 'Poland' },
  };
  const prediction = {
    id: 'notion-match_prediction-source', type: 'match_prediction', body: '## 試合の見どころ\n本文。',
    sources: [{ title: '-', url: 'https://www.uefa.com/nationsleague/match/2047985' }],
    prediction: { score: 'Sweden 2-1 Poland', pick: 'Sweden', keyPlayers: '', matchOutlook: '本文。' },
  };
  const page = renderMatchPage({
    detail: { fixture, events: [], lineups: [], statistics: [] }, editorials: { prediction }, route: 'fixture', fixtureId: fixture.id,
  });

  assert.match(page, />uefa\.com<\/a>/);
  assert.doesNotMatch(page, />-<\/a>/);
});

test('match SSR renders an authored combined MOTM/POTM selection with its specific rationale', async () => {
  const { renderMatchPage } = await import('../lib/match-page-html.js');
  const fixture = {
    id: 1528899, status: 'FT', date: '2026-09-27', kickoff: '2026-09-27T18:45:00Z', competition: 'UEFA Nations League',
    home: { id: 25, name: 'Germany' }, away: { id: 1100, name: 'Greece' },
  };
  const report = {
    id: 'notion-match_report-combined-motm', type: 'match_report',
    body: '## 試合主要人物\n\nMOTM/POTM：Dimitrios Kourbelis（Greece／AM4独自選出）\n\n74分の決勝点が勝点3を決めた。',
    report: { summary: 'Greeceが勝利した。' },
  };
  const page = renderMatchPage({
    detail: { fixture, events: [], lineups: [], statistics: [] }, editorials: { report }, route: 'fixture', fixtureId: fixture.id,
  });

  assert.match(page, /match-player-card--motm/);
  assert.match(page, /Dimitrios Kourbelis/);
  assert.match(page, /74分の決勝点が勝点3を決めた/);
  assert.doesNotMatch(page, /選定基準：試合を動かす決定的な貢献/);
});
