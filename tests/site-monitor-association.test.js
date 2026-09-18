import assert from 'node:assert/strict';
import test from 'node:test';

import {
  associationRepairArticle,
  resolveVerifiedFixtureForArticle,
} from '../lib/site-monitor-association.js';

const article = {
  id: 'notion-match_prediction-1', type: 'match_prediction',
  match: {
    fixtureId: null, competition: 'Champions League', date: '2026-09-15',
    homeTeam: 'Club Brugge', awayTeam: 'AS Monaco',
    matchKey: 'Champions League|2026-09-15|Club Brugge|AS Monaco',
  },
};

function fixture(id, home = 'Club Brugge', away = 'AS Monaco') {
  return {
    id, date: '2026-09-15', kickoff: '2026-09-15T19:00:00Z', timezone: 'UTC',
    competition: 'UEFA Champions League',
    home: { id: 569, name: home, logo: 'https://media.api-sports.io/football/teams/569.png' },
    away: { id: 91, name: away, logo: 'https://media.api-sports.io/football/teams/91.png' },
  };
}

test('resolves one uniquely matching CL fixture using complete competition/date/home/away identity', async () => {
  const expected = fixture(101);
  const result = await resolveVerifiedFixtureForArticle(article, {
    fetcher: async () => ({
      response: [{
        fixture: { id: 101, date: expected.kickoff, timezone: 'UTC' },
        league: { name: 'UEFA Champions League' },
        teams: { home: expected.home, away: expected.away },
      }], errors: {},
    }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 101);
  const repaired = associationRepairArticle(article, result.fixture);
  assert.equal(repaired.match.fixtureId, 101);
  assert.equal(repaired.match.homeTeamId, 569);
  assert.equal(repaired.match.awayTeamId, 91);
});

test('refuses ambiguous fixtures and explicit fixture IDs whose full identity conflicts', async () => {
  const ambiguous = await resolveVerifiedFixtureForArticle(article, {
    fetcher: async () => ({
      response: [101, 102].map((id) => ({
        fixture: { id, date: '2026-09-15T19:00:00Z', timezone: 'UTC' },
        league: { name: 'UEFA Champions League' },
        teams: { home: { id: 569, name: 'Club Brugge' }, away: { id: 91, name: 'AS Monaco' } },
      })), errors: {},
    }),
  });
  assert.deepEqual(ambiguous, { state: 'ambiguous', candidates: [101, 102] });

  const wrongId = await resolveVerifiedFixtureForArticle({
    ...article,
    match: { ...article.match, fixtureId: 999 },
  }, {
    getFixture: async () => fixture(999, 'Real Madrid', 'Barcelona'),
  });
  assert.equal(wrongId.state, 'fixture_conflict');
});

test('uses a unique ordered home/away pair in the bounded ±48-hour window for timezone-safe recovery', async () => {
  const dates = [];
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'La Liga', date: '2026-09-14',
      homeTeam: 'Celta', awayTeam: 'Málaga',
      matchKey: 'La Liga|2026-09-14|Celta|Málaga',
    },
  }, {
    fetcher: async (_path, query) => {
      dates.push(query.date);
      if (query.date !== '2026-09-16') return { response: [], errors: {} };
      return {
        response: [{
          fixture: { id: 777, date: '2026-09-16T00:30:00+02:00', timezone: 'Europe/Madrid' },
          league: { name: 'La Liga' },
          teams: {
            home: { id: 538, name: 'Celta Vigo' },
            away: { id: 531, name: 'Malaga' },
          },
        }],
        errors: {},
      };
    },
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 777);
  assert.match(result.method, /within_48h/);
  assert.deepEqual(dates, ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
});

test('normalizes TSG Hoffenheim to the provider 1899 Hoffenheim name inside the ordered ±48-hour window', async () => {
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'Bundesliga', date: '2026-09-05',
      homeTeam: 'TSG Hoffenheim', awayTeam: 'Borussia Dortmund',
      matchKey: 'Bundesliga|2026-09-05|TSG Hoffenheim|Borussia Dortmund',
    },
  }, {
    fetcher: async (_path, query) => ({
      response: query.date === '2026-09-07' ? [{
        fixture: { id: 1575150, date: '2026-09-07T20:30:00+02:00', timezone: 'Europe/Berlin' },
        league: { name: 'Bundesliga' },
        teams: {
          home: { id: 320, name: '1899 Hoffenheim' },
          away: { id: 165, name: 'Borussia Dortmund' },
        },
      }] : [],
      errors: {},
    }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 1575150);
  assert.match(result.method, /within_48h/);

  const reversed = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'Bundesliga', date: '2026-09-05',
      homeTeam: 'TSG Hoffenheim', awayTeam: 'Borussia Dortmund',
    },
  }, {
    fetcher: async () => ({
      response: [{
        fixture: { id: 1575151, date: '2026-09-07T20:30:00+02:00', timezone: 'Europe/Berlin' },
        league: { name: 'Bundesliga' },
        teams: {
          home: { id: 165, name: 'Borussia Dortmund' },
          away: { id: 320, name: '1899 Hoffenheim' },
        },
      }],
      errors: {},
    }),
  });
  assert.equal(reversed.state, 'not_found');
});

test('reconciles the remaining production editorial aliases through one unique ordered ±48-hour fixture', async () => {
  const cases = [
    { articleId: 'brest-psg-report', type: 'match_report', articleDate: '2026-09-13', providerDate: '2026-09-14', id: 1552757, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Brest', awayTeam: 'Paris Saint-Germain', providerHome: 'Stade Brestois 29', providerAway: 'Paris Saint Germain' },
    { articleId: 'brest-psg-prediction', type: 'match_prediction', articleDate: '2026-09-13', providerDate: '2026-09-14', id: 1552757, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Brest', awayTeam: 'Paris Saint-Germain', providerHome: 'Stade Brestois 29', providerAway: 'Paris Saint Germain' },
    { articleId: 'bayern-bodo-report', type: 'match_report', articleDate: '2026-09-10', providerDate: '2026-09-11', id: 1635632, competition: 'Champions League', providerCompetition: 'UEFA Champions League', homeTeam: 'Bayern Munich', awayTeam: 'Bodø/Glimt', providerHome: 'Bayern München', providerAway: 'Bodo/Glimt' },
    { articleId: 'lehavre-brest-report', type: 'match_report', articleDate: '2026-09-05', providerDate: '2026-09-06', id: 1552748, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Le Havre', awayTeam: 'Brest', providerHome: 'Le Havre', providerAway: 'Stade Brestois 29' },
    { articleId: 'lehavre-brest-prediction', type: 'match_prediction', articleDate: '2026-09-05', providerDate: '2026-09-06', id: 1552748, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Le Havre', awayTeam: 'Brest', providerHome: 'Le Havre', providerAway: 'Stade Brestois 29' },
    { articleId: 'lemans-brest-report', type: 'match_report', articleDate: '2026-08-22', providerDate: '2026-08-23', id: 1552731, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Le Mans', awayTeam: 'Brest', providerHome: 'Le Mans', providerAway: 'Stade Brestois 29' },
    { articleId: 'brest-toulouse-report', type: 'match_report', articleDate: '2026-08-29', providerDate: '2026-08-30', id: 1552739, competition: 'Ligue 1', providerCompetition: 'Ligue 1', homeTeam: 'Brest', awayTeam: 'Toulouse', providerHome: 'Stade Brestois 29', providerAway: 'Toulouse' },
    { articleId: 'celtic-ferencvaros-prediction', type: 'match_prediction', articleDate: '2026-09-17', providerDate: '2026-09-18', id: 1636247, competition: 'Europa League', providerCompetition: 'UEFA Europa League', homeTeam: 'Celtic', awayTeam: 'Ferencváros', providerHome: 'Celtic', providerAway: 'Ferencvarosi TC' },
    { articleId: 'lillestrom-torreense-prediction', type: 'match_prediction', articleDate: '2026-09-17', providerDate: '2026-09-18', id: 1636287, competition: 'Europa League', providerCompetition: 'UEFA Europa League', homeTeam: 'Lillestrøm', awayTeam: 'Torreense', providerHome: 'Lillestrom', providerAway: 'Torreense' },
    { articleId: 'olympiacos-jagiellonia-prediction', type: 'match_prediction', articleDate: '2026-09-16', providerDate: '2026-09-17', id: 1636309, competition: 'Europa League', providerCompetition: 'UEFA Europa League', homeTeam: 'Olympiacos', awayTeam: 'Jagiellonia', providerHome: 'Olympiakos Piraeus', providerAway: 'Jagiellonia' },
    { articleId: 'hapoel-dinamo-prediction', type: 'match_prediction', articleDate: '2026-09-16', providerDate: '2026-09-17', id: 1636265, competition: 'Europa League', providerCompetition: 'UEFA Europa League', homeTeam: 'Hapoel Beer-Sheva', awayTeam: 'GNK Dinamo', providerHome: 'Hapoel Beer Sheva', providerAway: 'Dinamo Zagreb' },
    { articleId: 'ararat-sparta-report', type: 'match_report', articleDate: '2026-09-16', providerDate: '2026-09-17', id: 1636217, competition: 'Europa League', providerCompetition: 'UEFA Europa League', homeTeam: 'Ararat-Armenia', awayTeam: 'Sparta Prague', providerHome: 'Ararat-Armenia', providerAway: 'Sparta Praha' },
  ];

  for (const [index, entry] of cases.entries()) {
    const result = await resolveVerifiedFixtureForArticle({
      id: `notion-${entry.articleId}`,
      type: entry.type,
      match: {
        fixtureId: null,
        competition: entry.competition,
        date: entry.articleDate,
        homeTeam: entry.homeTeam,
        awayTeam: entry.awayTeam,
      },
    }, {
      fetcher: async (_path, query) => ({
        response: query.date === entry.providerDate ? [{
          fixture: { id: entry.id, date: `${entry.providerDate}T20:00:00Z`, timezone: 'UTC' },
          league: { name: entry.providerCompetition },
          teams: {
            home: { id: 10_000 + index * 2, name: entry.providerHome },
            away: { id: 10_001 + index * 2, name: entry.providerAway },
          },
        }] : [],
        errors: {},
      }),
    });
    assert.equal(result.state, 'resolved', entry.articleId);
    assert.equal(result.fixture.id, entry.id, entry.articleId);
    assert.match(result.method, /within_48h/, entry.articleId);
  }
});

test('bounds the five-day timezone-safe fixture lookup while retaining every candidate date', async () => {
  let inFlight = 0;
  let highestInFlight = 0;
  const dates = [];
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: { ...article.match, date: '2026-09-14' },
  }, {
    fetcher: async (_path, query) => {
      dates.push(query.date);
      inFlight += 1;
      highestInFlight = Math.max(highestInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { response: [], errors: {} };
    },
  });
  assert.equal(result.state, 'not_found');
  assert.equal(highestInFlight, 3);
  assert.deepEqual([...dates].sort(), ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
});

test('uses the unique ordered home/away pair as the final ±48-hour fallback when competition labels differ', async () => {
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'Notion competition label unavailable', date: '2026-09-14',
      homeTeam: 'RC Celta', awayTeam: 'Málaga',
    },
  }, {
    fetcher: async (_path, query) => ({
      response: query.date === '2026-09-16' ? [{
        fixture: { id: 780, date: '2026-09-16T00:30:00+02:00', timezone: 'Europe/Madrid' },
        league: { name: 'La Liga' },
        teams: {
          home: { id: 538, name: 'Celta de Vigo' },
          away: { id: 531, name: 'Malaga' },
        },
      }] : [],
      errors: {},
    }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 780);
  assert.match(result.method, /ordered_teams_within_48h/);
});

test('prefers a complete identity match over an otherwise-valid ordered-pair fallback', async () => {
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'La Liga', date: '2026-09-14',
      homeTeam: 'Celta', awayTeam: 'Málaga',
    },
  }, {
    fetcher: async (_path, query) => ({
      response: query.date === '2026-09-16' ? [{
        fixture: { id: 781, date: '2026-09-16T00:30:00+02:00', timezone: 'Europe/Madrid' },
        league: { name: 'La Liga' },
        teams: { home: { id: 538, name: 'Celta Vigo' }, away: { id: 531, name: 'Malaga' } },
      }] : query.date === '2026-09-15' ? [{
        fixture: { id: 782, date: '2026-09-15T18:00:00Z', timezone: 'UTC' },
        league: { name: 'Copa del Rey' },
        teams: { home: { id: 538, name: 'Celta Vigo' }, away: { id: 531, name: 'Malaga' } },
      }] : [],
      errors: {},
    }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 781);
  assert.doesNotMatch(result.method, /ordered_teams_within_48h/);
});

test('normalizes RC Celta and Celta de Vigo but never accepts a reversed home/away card', async () => {
  const celticArticle = {
    ...article,
    match: {
      ...article.match,
      competition: 'La Liga', date: '2026-09-14',
      homeTeam: 'RC Celta', awayTeam: 'Málaga',
      matchKey: 'La Liga|2026-09-14|RC Celta|Málaga',
    },
  };
  const direct = await resolveVerifiedFixtureForArticle(celticArticle, {
    fetcher: async () => ({
      response: [{
        fixture: { id: 778, date: '2026-09-16T00:30:00+02:00', timezone: 'Europe/Madrid' },
        league: { name: 'La Liga' },
        teams: { home: { id: 538, name: 'Celta de Vigo' }, away: { id: 531, name: 'Malaga' } },
      }], errors: {},
    }),
  });
  assert.equal(direct.state, 'resolved');
  assert.equal(direct.fixture.id, 778);

  const reversed = await resolveVerifiedFixtureForArticle(celticArticle, {
    fetcher: async () => ({
      response: [{
        fixture: { id: 779, date: '2026-09-16T00:30:00+02:00', timezone: 'Europe/Madrid' },
        league: { name: 'La Liga' },
        teams: { home: { id: 531, name: 'Malaga' }, away: { id: 538, name: 'Celta de Vigo' } },
      }], errors: {},
    }),
  });
  assert.equal(reversed.state, 'not_found');
});

test('does not turn an ambiguous bare Deportivo label into Deportivo La Coruna', async () => {
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: {
      ...article.match,
      competition: 'La Liga', date: '2026-09-14',
      homeTeam: 'Deportivo', awayTeam: 'Sevilla',
    },
  }, {
    fetcher: async () => ({
      response: [{
        fixture: { id: 790, date: '2026-09-15T20:00:00Z', timezone: 'UTC' },
        league: { name: 'La Liga' },
        teams: { home: { id: 544, name: 'Deportivo La Coruna' }, away: { id: 536, name: 'Sevilla' } },
      }],
      errors: {},
    }),
  });
  assert.equal(result.state, 'not_found');
});

test('repairs a stale persisted fixture ID only when a different full fixture identity is unique', async () => {
  const result = await resolveVerifiedFixtureForArticle({
    ...article,
    match: { ...article.match, fixtureId: 999 },
  }, {
    getFixture: async () => fixture(999, 'Real Madrid', 'Barcelona'),
    recoverConflictingFixtureId: true,
    fetcher: async () => ({
      response: [{
        fixture: { id: 101, date: '2026-09-15T19:00:00Z', timezone: 'UTC' },
        league: { name: 'UEFA Champions League' },
        teams: { home: { id: 569, name: 'Club Brugge' }, away: { id: 91, name: 'AS Monaco' } },
      }],
      errors: {},
    }),
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.fixture.id, 101);
  assert.equal(result.replacedFixtureId, 999);
  assert.match(result.method, /^repaired_fixture_id:/);
});
