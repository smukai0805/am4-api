// Server-rendered entity pages.  Their first response intentionally contains
// the resolved name, profile, selected tab, and available data; the browser
// script only enhances later tab/filter changes and never replaces this shell
// with a blank loading screen.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function metric(value) {
  return value != null && value !== '' && Number.isFinite(Number(value)) ? String(value) : '—';
}

function formatTokyoDate(value, { includeTime = true } = {}) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '日時未定';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const base = `${parts.year}年${parts.month}月${parts.day}日(${parts.weekday})`;
  return includeTime ? `${base} ${parts.hour}:${parts.minute}` : base;
}

function formatMonth(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '日時未定';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric',
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}年${parts.month}月`;
}

function localReturnPath(value) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
}

function withReturn(href, returnPath) {
  const safeReturn = localReturnPath(returnPath);
  return safeReturn === '/' ? href : `${href}?return=${encodeURIComponent(safeReturn)}`;
}

function teamHref(teamId, returnPath = '/') {
  const id = positiveId(teamId);
  return id ? withReturn(`/teams/${id}`, returnPath) : null;
}

function playerHref(playerId, returnPath = '/') {
  const id = positiveId(playerId);
  return id ? withReturn(`/players/${id}`, returnPath) : null;
}

function teamPathForSelection(teamId, data) {
  const id = positiveId(teamId);
  if (!id) return '/teams';
  const query = new URLSearchParams();
  if (data?.tab) query.set('tab', data.tab);
  const leagueId = positiveId(data?.selection?.leagueId);
  const season = Number(data?.selection?.season);
  if (leagueId) query.set('league', String(leagueId));
  if (Number.isSafeInteger(season)) query.set('season', String(season));
  const search = query.toString();
  return `/teams/${id}${search ? `?${search}` : ''}`;
}

function entityImage({ src, alt, kind = 'club', className = '' } = {}) {
  const label = escapeHtml(alt || '');
  const fallback = kind === 'player' ? '●' : '◆';
  return `<span class="entity-image entity-image--${kind} ${escapeHtml(className)}">${src
    ? `<img src="${escapeHtml(src)}" alt="${label}" loading="lazy" decoding="async">`
    : ''}<span class="entity-image-fallback" aria-hidden="true">${fallback}</span></span>`;
}

function rosterStatIcon(kind, label) {
  const shapes = {
    appearance: '<circle cx="12" cy="7" r="3.1"></circle><path d="M4.5 20c.8-4.1 3.5-6.4 7.5-6.4s6.7 2.3 7.5 6.4"></path>',
    goal: '<circle cx="12" cy="12" r="8.4"></circle><path d="m12 7.5 2.7 1.9-1.1 3.2h-3.2l-1.1-3.2L12 7.5Z"></path><path d="m9.3 9.4-2.6 1.9.8 3.1m7.8-5-2.6 1.9-.8 3.1m-5.4-1.8-1.2 3.8m5.8-3.8 1.2 3.8"></path>',
    assist: '<circle cx="18.2" cy="5.8" r="2.3"></circle><path d="M14.8 6.5c-1.4.2-2.5.9-3.4 2"></path><path d="M4 16.5c2.6-.1 4.4-1.3 5.4-3.7l1.4-3.8 3.1 1.2-.6 3.5c1.9.9 4 1.8 6.5 2.5 1.1.3 1.6 1.1 1.4 2.2-.2 1-1 1.6-2.4 1.6H6.4c-1.8 0-2.7-1.2-2.4-3.5Z"></path><path d="m10.4 12.3 3.2 1.2M7.6 18h11.1"></path>',
    yellow: '<rect x="7.4" y="3.5" width="9.2" height="17" rx="1.3"></rect>',
    red: '<rect x="7.4" y="3.5" width="9.2" height="17" rx="1.3"></rect>',
  };
  return `<span class="entity-roster-stat-heading"><svg class="entity-stat-icon entity-stat-icon--${kind}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes[kind]}</svg><span class="sr-only">${escapeHtml(label)}</span></span>`;
}

function globalHeader(active = '') {
  const navItems = [
    ['試合', '/', 'fixtures'],
    ['COLUMN', '/column', 'column'],
    ['20 Seasons', '/column/20-seasons', 'seasons'],
    ['あとで読む', '/read-later', 'saved'],
  ];
  return `<header class="topbar entity-topbar">
  <a class="wordmark" href="/" aria-label="AM4 Football ホーム"><img src="/am4-logo.png" alt="AM4"><small>Football</small></a>
  <span class="lang">日本語</span>
</header>
<nav class="primary-tabbar entity-global-nav" aria-label="主要ナビゲーション">${navItems.map(([label, href, key]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

function stateView(section) {
  if (section?.state === 'error') {
    return `<section class="entity-state entity-state--error" role="status"><h2>情報を取得できませんでした</h2><p>${escapeHtml(section.message || '時間をおいてもう一度お試しください。')}</p><button class="entity-retry" type="button" data-entity-retry>再試行</button></section>`;
  }
  if (section?.state === 'empty') {
    return `<section class="entity-state" role="status"><h2>表示できる情報はありません</h2><p>${escapeHtml(section.message || 'この条件ではデータがありません。')}</p></section>`;
  }
  return '';
}

function renderArticleCards(items) {
  if (!Array.isArray(items) || !items.length) return stateView({ state: 'empty', message: '公開済みの関連COLUMNはありません。' });
  return `<div class="entity-article-grid">${items.map((article) => `<a class="entity-article-card" href="/article.html?id=${encodeURIComponent(article.id)}">
    <span class="entity-article-meta">COLUMN · <time datetime="${escapeHtml(article.publishedAt || '')}">${escapeHtml(formatTokyoDate(article.publishedAt, { includeTime: false }))}</time></span>
    <strong>${escapeHtml(article.title || 'AM4 COLUMN')}</strong>
    ${article.summary || article.deck ? `<span>${escapeHtml(article.summary || article.deck)}</span>` : ''}
  </a>`).join('')}</div>`;
}

function renderTeamFilters(data) {
  const options = Array.isArray(data.competitions) ? data.competitions : [];
  const selection = data.selection;
  if (!options.length) return `<p class="entity-filter-note">大会・シーズン情報を${data.competitionState === 'error' ? '取得できませんでした。' : '確認できません。'}</p>`;
  const leagueRows = [];
  const seenLeagues = new Set();
  for (const option of options) {
    if (!seenLeagues.has(option.leagueId)) {
      seenLeagues.add(option.leagueId);
      leagueRows.push(option);
    }
  }
  const seasons = options.filter((option) => option.leagueId === selection?.leagueId);
  return `<div class="entity-filters" aria-label="大会・シーズンを選択">
    <label>大会<select data-team-league>${leagueRows.map((option) => `<option value="${option.leagueId}"${option.leagueId === selection?.leagueId ? ' selected' : ''}>${escapeHtml(option.leagueName || `大会 ${option.leagueId}`)}</option>`).join('')}</select></label>
    <label>シーズン<select data-team-season>${seasons.map((option) => `<option value="${option.season}"${option.season === selection?.season ? ' selected' : ''}>${escapeHtml(String(option.season))}/${String(option.season + 1).slice(-2)}</option>`).join('')}</select></label>
  </div>`;
}

function fixtureEditorials(fixture) {
  if (!Array.isArray(fixture.editorials)) return '';
  const labels = [];
  if (fixture.editorials.includes('prediction')) labels.push('予想あり');
  if (fixture.editorials.includes('report')) labels.push('解説あり');
  return labels.length ? `<span class="entity-fixture-editorials">${labels.map((label) => `<span>${label}</span>`).join('')}</span>` : '';
}

function fixtureCard(fixture, returnPath) {
  const matchHref = positiveId(fixture.fixtureId) ? `/match.html?id=${fixture.fixtureId}` : null;
  const homeHref = teamHref(fixture.home?.id, returnPath);
  const awayHref = teamHref(fixture.away?.id, returnPath);
  const scoreKnown = fixture.score?.home != null && fixture.score?.away != null;
  const teams = `<div class="entity-fixture-teams">
    <span class="entity-fixture-team">${homeHref ? `<a href="${homeHref}" class="entity-team-link">${entityImage({ src: fixture.home?.logo, alt: fixture.home?.name })}<span>${escapeHtml(fixture.home?.name || 'ホーム')}</span></a>` : `${entityImage({ src: fixture.home?.logo, alt: fixture.home?.name })}<span>${escapeHtml(fixture.home?.name || 'ホーム')}</span>`}</span>
    <span class="entity-fixture-team">${awayHref ? `<a href="${awayHref}" class="entity-team-link">${entityImage({ src: fixture.away?.logo, alt: fixture.away?.name })}<span>${escapeHtml(fixture.away?.name || 'アウェイ')}</span></a>` : `${entityImage({ src: fixture.away?.logo, alt: fixture.away?.name })}<span>${escapeHtml(fixture.away?.name || 'アウェイ')}</span>`}</span>
  </div>`;
  return `<article class="entity-fixture-card">${matchHref ? `<a class="entity-fixture-main-link" href="${matchHref}" aria-label="${escapeHtml(`${fixture.home?.name || ''} 対 ${fixture.away?.name || ''}の試合詳細`)}"></a>` : ''}${teams}
    <div class="entity-fixture-side"><span class="entity-fixture-competition">${escapeHtml(fixture.leagueName || '大会情報なし')}</span><time datetime="${escapeHtml(fixture.kickoff || '')}">${escapeHtml(fixture.kickoff ? formatTokyoDate(fixture.kickoff) : '日時未定')}</time>${fixture.round ? `<span>${escapeHtml(fixture.round)}</span>` : ''}${fixtureEditorials(fixture)}</div>
    <div class="entity-fixture-result">${scoreKnown
      ? `<button type="button" class="entity-score-control" data-score-control data-score="${fixture.score.home}–${fixture.score.away}" aria-label="スコアを表示または非表示">${fixture.score.home}–${fixture.score.away}</button>`
      : `<span>${escapeHtml(fixture.status?.label || '試合前')}</span>`}<small>${escapeHtml(fixture.status?.label || '')}</small></div>
  </article>`;
}

function fixtureList(title, fixtures, returnPath) {
  if (!Array.isArray(fixtures) || !fixtures.length) return '';
  const byMonth = new Map();
  fixtures.forEach((fixture) => {
    const key = fixture.kickoff ? formatMonth(fixture.kickoff) : '日時未定';
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(fixture);
  });
  return `<section class="entity-fixture-section"><h2>${escapeHtml(title)}</h2>${[...byMonth.entries()].map(([month, rows]) => `<section class="entity-month"><h3>${escapeHtml(month)}</h3>${rows.map((fixture) => fixtureCard(fixture, returnPath)).join('')}</section>`).join('')}</section>`;
}

function renderTeamFixtures(section, returnPath) {
  if (section?.state !== 'ready') return stateView(section);
  const body = [
    fixtureList('次の試合', section.upcoming, returnPath),
    fixtureList('直近の結果', section.recent, returnPath),
    fixtureList('日時未定・変更あり', section.unscheduled, returnPath),
  ].filter(Boolean).join('');
  return body || stateView({ state: 'empty', message: 'この条件の試合はありません。' });
}

function renderTeamRoster(section, returnPath) {
  if (section?.state !== 'ready') return stateView(section);
  const labels = { GK: 'ゴールキーパー', DF: 'ディフェンダー', MF: 'ミッドフィルダー', FW: 'フォワード', OTHER: 'ポジション未確認' };
  const statistics = [
    ['appearance', 'appearances', '出場'],
    ['goal', 'goals', '得点'],
    ['assist', 'assists', 'アシスト'],
    ['yellow', 'yellow', 'イエローカード'],
    ['red', 'red', 'レッドカード'],
  ];
  const groups = new Map();
  section.players.forEach((player) => {
    if (!groups.has(player.position)) groups.set(player.position, []);
    groups.get(player.position).push(player);
  });
  return `<p class="entity-scope">${escapeHtml(section.scope)}</p>${[...groups.entries()].map(([position, players]) => `<section class="entity-roster-group"><h2>${labels[position] || labels.OTHER}<small>${players.length}人</small></h2><div class="entity-roster-list"><div class="entity-roster-columns"><span>選手</span>${statistics.map(([kind, , label]) => rosterStatIcon(kind, label)).join('')}</div>${players.map((player) => {
    const href = playerHref(player.playerId, returnPath);
    const identity = `<span class="entity-roster-player"><span class="entity-roster-photo">${entityImage({ src: player.photo, alt: player.name, kind: 'player' })}</span><span class="entity-shirt" aria-label="背番号 ${metric(player.number)}">${metric(player.number)}</span><span class="entity-roster-name"><strong>${escapeHtml(player.name || '選手名未取得')}</strong>${player.nationality ? `<small>${escapeHtml(player.nationality)}</small>` : ''}</span></span>`;
    const stats = `<dl class="entity-mini-stats">${statistics.map(([, key, label]) => `<div><dt class="sr-only">${label}</dt><dd>${metric(player[key])}</dd></div>`).join('')}</dl>`;
    const row = `${identity}${stats}`;
    return `<article class="entity-roster-row">${href ? `<a href="${href}" class="entity-roster-row-link">${row}</a>` : `<div class="entity-roster-row-static">${row}</div>`}</article>`;
  }).join('')}</div></section>`).join('')}`;
}

function renderTeamStandings(section, returnPath) {
  if (section?.state !== 'ready') return stateView(section);
  const zoneLabels = {
    champions_league: 'チャンピオンズリーグ',
    europa_league: 'ヨーロッパリーグ',
    conference_league: 'カンファレンスリーグ',
    relegation: '降格',
  };
  const signedMetric = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric >= 0 ? '+' : ''}${numeric}` : '—';
  };
  const groups = Array.isArray(section.groups) ? section.groups : [];
  if (!groups.length) return stateView({ state: 'empty', message: 'この大会の順位表は提供されていません。' });
  const tableHeader = `<div class="match-standing-row match-standing-row--head" role="row"><span role="columnheader" title="順位">#</span><span role="columnheader"></span><span role="columnheader" title="クラブ">CLUB</span><span role="columnheader" title="試合">P</span><span role="columnheader" title="勝">W</span><span role="columnheader" title="分">D</span><span role="columnheader" title="敗">L</span><span role="columnheader" title="得失点差">+/-</span><span role="columnheader" title="勝点">PTS</span></div>`;
  const tables = groups.map((group) => `<section class="entity-standings-group">${groups.length > 1 && group.label ? `<p class="entity-scope">${escapeHtml(group.label)}</p>` : ''}<div class="match-standings-table" role="table" aria-label="${escapeHtml(`${group.label || '大会'} 順位`)}">${tableHeader}${group.rows.map((row) => {
    const href = teamHref(row.teamId, returnPath);
    const classes = ['match-standing-row'];
    if (zoneLabels[row.zone]) classes.push(`match-standing-row--zone-${row.zone}`);
    if (row.highlighted) classes.push('match-standing-row--fixture-team');
    const teamName = escapeHtml(row.name || 'クラブ');
    const crest = row.logo ? `<img class="match-standing-logo" src="${escapeHtml(row.logo)}" alt="" width="22" height="22" loading="lazy" decoding="async">` : '';
    const crestLink = href && crest ? `<a href="${href}" class="match-standing-team-link" aria-label="${teamName}のチーム詳細">${crest}</a>` : crest;
    const club = href ? `<a href="${href}">${teamName}</a>` : teamName;
    const values = [metric(row.played), metric(row.wins), metric(row.draws), metric(row.losses), signedMetric(row.goalsDiff), metric(row.points)];
    const ariaLabel = `${metric(row.rank)}. ${row.name || 'クラブ'}, ${metric(row.played)} P, ${metric(row.wins)} W, ${metric(row.draws)} D, ${metric(row.losses)} L, ${signedMetric(row.goalsDiff)}, ${metric(row.points)} PTS`;
    return `<div class="${classes.join(' ')}" role="row" aria-label="${escapeHtml(ariaLabel)}"><span class="match-standing-rank" role="cell">${metric(row.rank)}</span><span class="match-standing-crest" role="cell">${crestLink}</span><span class="match-standing-club" role="cell">${club}</span>${values.map((value, index) => `<span${index === values.length - 1 ? ' class="match-standing-points"' : ''} role="cell">${value}</span>`).join('')}</div>`;
  }).join('')}</div></section>`).join('');
  const legend = (Array.isArray(section.qualificationLegend) ? section.qualificationLegend : []).filter((zone) => zoneLabels[zone]);
  return `${tables}${legend.length ? `<ul class="match-standing-legend">${legend.map((zone) => `<li class="match-standing-legend-item match-standing-legend-item--${escapeHtml(zone)}">${escapeHtml(zoneLabels[zone] || zone)}</li>`).join('')}</ul>` : ''}`;
}

function rankingCard(label, rows, returnPath) {
  if (!rows?.length) return '';
  return `<section class="entity-ranking-card"><h2>${escapeHtml(label)}</h2><ol>${rows.map((row) => {
    const href = playerHref(row.playerId, returnPath);
    const identity = `<span class="entity-ranking-player-identity">${entityImage({ src: row.photo, alt: row.name, kind: 'player' })}<span>${escapeHtml(row.name || '選手')}</span></span>`;
    const rowHtml = `<b>${row.rank}</b>${identity}<strong>${metric(row.value)}</strong>`;
    return `<li>${href
      ? `<a href="${href}" class="entity-ranking-player-link">${rowHtml}</a>`
      : `<span class="entity-ranking-player-static">${rowHtml}</span>`}</li>`;
  }).join('')}</ol></section>`;
}

function renderTeamRankings(section, returnPath) {
  if (section?.state !== 'ready') return stateView(section);
  const body = [
    rankingCard('得点', section.rankings.goals, returnPath),
    rankingCard('アシスト', section.rankings.assists, returnPath),
    rankingCard('出場時間', section.rankings.minutes, returnPath),
    rankingCard('イエローカード', section.rankings.yellow, returnPath),
    rankingCard('レッドカード', section.rankings.red, returnPath),
  ].filter(Boolean).join('');
  return `<p class="entity-scope">${escapeHtml(section.scope || '')}</p><div class="entity-ranking-grid">${body}</div>`;
}

function teamTabs(data, basePath) {
  const columnsVisible = data.columns?.state === 'error' || data.columns?.items?.length > 0;
  const tabs = [['fixtures', '試合'], ['roster', '所属選手'], ['standings', '順位'], ['rankings', 'トッププレイヤー']];
  if (columnsVisible) tabs.push(['columns', 'COLUMN']);
  const selection = data.selection;
  const query = selection ? `&league=${selection.leagueId}&season=${selection.season}` : '';
  return `<nav class="entity-tabs" aria-label="チーム情報">${tabs.map(([key, label]) => `<a data-entity-tab="${key}" href="${basePath}?tab=${key}${query}"${data.tab === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

function renderTeamSection(data, returnPath) {
  if (data.tab === 'fixtures') return renderTeamFixtures(data.section, returnPath);
  if (data.tab === 'roster') return renderTeamRoster(data.section, returnPath);
  if (data.tab === 'standings') return renderTeamStandings(data.section, returnPath);
  if (data.tab === 'rankings') return renderTeamRankings(data.section, returnPath);
  return data.section?.state === 'error' ? stateView(data.section) : renderArticleCards(data.section?.items);
}

export function renderTeamPageFragments(data, { teamId = null, requestPath = '/' } = {}) {
  const id = positiveId(teamId || data?.team?.id);
  const basePath = id ? `/teams/${id}` : '/teams';
  const returnPath = localReturnPath(requestPath);
  const label = { fixtures: '試合', roster: '所属選手', standings: '順位', rankings: 'トッププレイヤー', columns: 'COLUMN' }[data.tab] || '試合';
  return {
    tabsHtml: teamTabs(data, basePath),
    contentHtml: `<div class="entity-content-head"><h2>${escapeHtml(label)}</h2>${data.tab !== 'columns' ? renderTeamFilters(data) : ''}</div><div data-entity-content>${renderTeamSection(data, returnPath)}</div>`,
  };
}

function playerHero(player, returnPath) {
  const currentHref = teamHref(player.currentTeam?.id, returnPath);
  const favoriteId = positiveId(player.id);
  const club = player.currentTeam ? `${entityImage({ src: player.currentTeam.logo, alt: player.currentTeam.name })}<span>${escapeHtml(player.currentTeam.name || 'クラブ')}</span>` : '<span class="entity-muted">現在のクラブ情報は未取得です</span>';
  return `<header class="entity-hero entity-hero--player"><div class="entity-portrait">${entityImage({ src: player.photo, alt: player.name, kind: 'player' })}</div><div class="entity-hero-copy"><p class="entity-kicker">PLAYER</p><h1>${escapeHtml(player.name || '選手')}</h1>${player.firstname && player.firstname !== player.name ? `<p class="entity-subtitle">${escapeHtml(player.firstname)}${player.lastname ? ` ${escapeHtml(player.lastname)}` : ''}</p>` : ''}<p class="entity-current-club">${currentHref ? `<a href="${currentHref}" class="entity-team-link">${club}</a>` : club}</p></div><button class="favorite-btn entity-favorite" type="button" data-entity-favorite data-favorite-type="players" data-favorite-id="${favoriteId || ''}" data-favorite-label="${escapeHtml(player.name || '選手')}"><span aria-hidden="true">☆</span><span class="sr-only">お気に入りを切り替える</span></button></header>`;
}

function playerProfile(player) {
  const fields = [
    ['nationality', '国籍', player.nationality || '—'],
    ['number', '背番号', metric(player.number)],
    ['age', '年齢', metric(player.age)],
    ['birth', '生年月日', player.birth?.date || '—'],
    ['position', 'ポジション', player.position || '—'],
    ...(player.height ? [['height', '身長', player.height]] : []),
    ...(player.weight ? [['weight', '体重', player.weight]] : []),
  ];
  return `<section class="entity-profile-panel" aria-labelledby="entity-profile-heading"><h2 id="entity-profile-heading">選手プロフィール</h2><dl class="entity-profile-grid">${fields.map(([key, label, value]) => `<div class="entity-profile-item entity-profile-item--${key}"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>`;
}

function renderPlayerFilters(section, history = []) {
  if (!section || (section.state !== 'ready' && section.state !== 'empty')) return '';
  const seasons = [...new Set([section.season, ...history.map((row) => row?.season)].filter((season) => Number.isInteger(season)))].sort((left, right) => right - left);
  return `<div class="entity-filters" aria-label="大会・シーズンを選択"><label>大会<select data-player-league><option value="all"${section.selectedLeagueId === 'all' ? ' selected' : ''}>すべての大会</option>${(section.leagues || []).map((league) => `<option value="${league.leagueId}"${league.leagueId === section.selectedLeagueId ? ' selected' : ''}>${escapeHtml(league.leagueName || `大会 ${league.leagueId}`)}</option>`).join('')}</select></label><label>シーズン<select data-player-season>${seasons.map((season) => `<option value="${season}"${season === section.season ? ' selected' : ''}>${season}/${String(season + 1).slice(-2)}</option>`).join('')}</select></label></div>`;
}

function statGroup(title, values) {
  return `<section class="entity-stat-detail-group"><h3>${escapeHtml(title)}</h3><dl>${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${metric(value)}</dd></div>`).join('')}</dl></section>`;
}

function statGrid(summary, { season, scope }) {
  const primary = [['出場', summary.appearances], ['先発', summary.starts], ['出場時間', summary.minutes], ['得点', summary.goals], ['アシスト', summary.assists]];
  const seasonLabel = Number.isInteger(season) ? `${season}/${String(season + 1).slice(-2)}` : '選択シーズン';
  return `<section class="entity-stat-panel" aria-labelledby="entity-season-stats-heading"><header class="entity-stat-panel-head"><p>${escapeHtml(seasonLabel)} · ${escapeHtml(scope)}</p><h3 id="entity-season-stats-heading">詳しいスタッツ</h3></header><dl class="entity-stat-grid">${primary.map(([label, value]) => `<div><dt>${label}</dt><dd>${metric(value)}</dd></div>`).join('')}</dl><div class="entity-stat-detail-grid">${statGroup('攻撃', [['シュート', summary.shots], ['枠内シュート', summary.shotsOnTarget], ['キーパス', summary.keyPasses], ['ドリブル成功', summary.dribblesCompleted]])}${statGroup('プレー', [['パス', summary.passes], ['タックル', summary.tackles], ['インターセプト', summary.interceptions], ['デュエル勝利', summary.duelsWon]])}${statGroup('規律', [['イエロー', summary.yellow], ['レッド', summary.red], ['被ファウル', summary.foulsDrawn], ['ファウル', summary.foulsCommitted]])}</div></section>`;
}

function renderPlayerStats(section) {
  if (section?.state !== 'ready') return stateView(section);
  const selectedLeague = (section.leagues || []).find((league) => league.leagueId === section.selectedLeagueId);
  return statGrid(section.summary || {}, {
    season: section.season,
    scope: selectedLeague?.leagueName || 'すべての大会',
  });
}

function renderPlayerCareer(section, returnPath) {
  if (section?.state !== 'ready') return stateView(section);
  const rows = Array.isArray(section.rows) ? section.rows : [];
  const cursor = Number(section.nextCursor);
  const hasNext = Number.isSafeInteger(cursor) && cursor > 0;
  const progress = hasNext ? `<p class="entity-career-progress" data-career-next-cursor="${cursor}" role="status">キャリアを読み込んでいます</p>` : '';
  return `<section class="entity-career"><p class="entity-scope">APIで確認できる年度のみを新しい順に表示しています。代表戦は含めません。</p><div class="entity-career-table"><div class="entity-career-columns" aria-hidden="true"><span>SEASON</span><span>CLUB</span><span>出場</span><span>時間</span><span>得点</span><span>A</span></div>${rows.map((row) => {
    const href = teamHref(row.teamId, returnPath);
    const club = `<span class="entity-career-club">${entityImage({ src: row.teamLogo, alt: row.teamName })}<span>${escapeHtml(row.teamName || 'クラブ')}</span></span>`;
    const values = `<span class="entity-career-value" aria-label="出場">${metric(row.appearances)}</span><span class="entity-career-value" aria-label="出場時間">${metric(row.minutes)}</span><span class="entity-career-value" aria-label="得点">${metric(row.goals)}</span><span class="entity-career-value" aria-label="アシスト">${metric(row.assists)}</span>`;
    return `<article class="entity-career-row"><span class="entity-career-season">${row.season}/${String(row.season + 1).slice(-2)}</span>${href ? `<a href="${href}" class="entity-career-team-link">${club}</a>` : club}${values}</article>`;
  }).join('')}</div>${progress}</section>`;
}

function playerTabs(data, basePath) {
  const columnsVisible = data.columns?.state === 'error' || data.columns?.items?.length > 0;
  const tabs = [['stats', 'スタッツ'], ['career', 'キャリア']];
  if (columnsVisible) tabs.push(['columns', 'COLUMN']);
  const stats = data.section && data.tab === 'stats' ? data.section : null;
  const query = stats ? `&season=${stats.season}${stats.selectedLeagueId !== 'all' ? `&league=${stats.selectedLeagueId}` : ''}` : '';
  return `<nav class="entity-tabs" aria-label="選手情報">${tabs.map(([key, label]) => `<a data-entity-tab="${key}" href="${basePath}?tab=${key}${key === 'stats' ? query : ''}"${data.tab === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

function renderPlayerSection(data, returnPath) {
  if (data.tab === 'stats') return renderPlayerStats(data.section);
  if (data.tab === 'career') return renderPlayerCareer(data.section, returnPath);
  return data.section?.state === 'error' ? stateView(data.section) : renderArticleCards(data.section?.items);
}

export function renderPlayerPageFragments(data, { playerId = null, requestPath = '/' } = {}) {
  const id = positiveId(playerId || data?.player?.id);
  const basePath = id ? `/players/${id}` : '/players';
  const returnPath = localReturnPath(requestPath);
  const label = { stats: 'スタッツ', career: 'キャリア', columns: 'COLUMN' }[data.tab] || 'スタッツ';
  return {
    tabsHtml: playerTabs(data, basePath),
    contentHtml: `<div class="entity-content-head"><h2>${escapeHtml(label)}</h2>${data.tab === 'stats' ? renderPlayerFilters(data.section, data.history) : ''}</div><div data-entity-content>${renderPlayerSection(data, returnPath)}</div>`,
  };
}

function sharedHead({ title, description, canonical }) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="theme-color" content="#060a17"><meta property="og:site_name" content="AM4 Football"><meta property="og:locale" content="ja_JP"><link rel="canonical" href="${escapeHtml(canonical)}"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/brand.css?v=20260913-company-contact-v1"><link rel="stylesheet" href="/night-stage.css?v=20260908-light-ribbons-v3"><link rel="stylesheet" href="/primary-navigation.css?v=20260908-primary-navigation-v1"><link rel="stylesheet" href="/team-player-pages.css?v=20260914-entity-pages-v8"><script async src="/api/adsense.js"></script></head>`;
}

export function renderEntityErrorPage({ status = 404, title, heading, message }) {
  return `${sharedHead({ title, description: message, canonical: 'https://am4football.com/' })}<body class="primary-navigation-page entity-page"><div class="entity-page-shell">${globalHeader()}<main class="entity-shell"><section class="entity-state entity-state--error"><p class="entity-kicker">${status}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><a class="entity-back-link" href="/">試合一覧へ戻る</a></section></main></div></body></html>`;
}

export function renderTeamPage(data, { origin = 'https://am4football.com', requestPath = null } = {}) {
  const team = data.team;
  const favoriteTeamId = positiveId(team.id);
  const path = `/teams/${team.id}`;
  const returnPath = localReturnPath(requestPath || teamPathForSelection(team.id, data));
  const canonical = `${origin}${path}`;
  const currentLeague = data.currentCompetition?.leagueName || null;
  const selectedLeague = data.selection
    ? `表示対象: ${data.selection.leagueName || '大会'} ${data.selection.season}/${String(data.selection.season + 1).slice(-2)}`
    : null;
  const fragments = renderTeamPageFragments(data, { teamId: team.id, requestPath: returnPath });
  const teamSubtitle = team.englishName && team.englishName !== team.name ? team.englishName : team.code;
  return `${sharedHead({ title: `${team.name || 'チーム'}｜AM4 Football`, description: `${team.name || 'クラブ'}の試合、所属選手、順位、トッププレイヤーをAM4で確認。`, canonical })}<body class="primary-navigation-page entity-page entity-page--team" data-entity-kind="team" data-entity-id="${team.id}">${globalHeader()}<main class="entity-shell"><header class="entity-hero entity-hero--team"><div class="entity-crest">${entityImage({ src: team.logo, alt: team.name })}</div><div class="entity-hero-copy"><p class="entity-kicker">TEAM</p><h1>${escapeHtml(team.name || 'クラブ')}</h1>${teamSubtitle ? `<p class="entity-subtitle">${escapeHtml(teamSubtitle)}</p>` : ''}${currentLeague ? `<p class="entity-league">現在の所属リーグ: ${escapeHtml(currentLeague)}</p>` : data.competitionState === 'error' ? '<p class="entity-league">現在の所属リーグは取得できませんでした</p>' : ''}${selectedLeague ? `<p class="entity-display-target">${escapeHtml(selectedLeague)}</p>` : ''}</div><button class="favorite-btn entity-favorite" type="button" data-entity-favorite data-favorite-type="clubs" data-favorite-id="team-${favoriteTeamId || ''}" data-favorite-label="${escapeHtml(team.name || 'クラブ')}"><span aria-hidden="true">☆</span><span class="sr-only">お気に入りを切り替える</span></button></header><div id="entity-tabs-shell">${fragments.tabsHtml}</div><section id="entity-content-shell" class="entity-content">${fragments.contentHtml}</section></main><script id="am4-entity-initial" type="application/json">${safeJson(data)}</script><script src="/favorites.js?v=20260907-score-visibility-v1"></script><script src="/entity-navigation-feedback.js?v=20260914-entity-navigation-v1" defer></script><script src="/entity-page.js?v=20260914-entity-pages-v3" defer></script></body></html>`;
}

export function renderPlayerPage(data, { origin = 'https://am4football.com', requestPath = null } = {}) {
  const player = data.player;
  const path = `/players/${player.id}`;
  const returnPath = localReturnPath(requestPath || `${path}${data.tab ? `?tab=${data.tab}` : ''}`);
  const canonical = `${origin}${path}`;
  const fragments = renderPlayerPageFragments(data, { playerId: player.id, requestPath: returnPath });
  return `${sharedHead({ title: `${player.name || '選手'}｜AM4 Football`, description: `${player.name || '選手'}のプロフィール、スタッツ、キャリアをAM4で確認。`, canonical })}<body class="primary-navigation-page entity-page entity-page--player" data-entity-kind="player" data-entity-id="${player.id}">${globalHeader()}<main class="entity-shell">${playerHero(player, returnPath)}<div id="entity-tabs-shell">${fragments.tabsHtml}</div>${playerProfile(player)}<section id="entity-content-shell" class="entity-content">${fragments.contentHtml}</section></main><script id="am4-entity-initial" type="application/json">${safeJson(data)}</script><script src="/favorites.js?v=20260907-score-visibility-v1"></script><script src="/entity-navigation-feedback.js?v=20260914-entity-navigation-v1" defer></script><script src="/entity-page.js?v=20260914-entity-pages-v3" defer></script></body></html>`;
}
