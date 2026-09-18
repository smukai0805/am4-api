(() => {
  const body = document.body;
  const kind = body?.dataset?.entityKind;
  const entityId = String(body?.dataset?.entityId || '');
  if (!['team', 'player'].includes(kind) || !/^[1-9]\d*$/.test(entityId)) return;

  const initialNode = document.getElementById('am4-entity-initial');
  let initial = {};
  try { initial = JSON.parse(initialNode?.textContent || '{}'); } catch (_error) { initial = {}; }
  const tabsShell = document.getElementById('entity-tabs-shell');
  const contentShell = document.getElementById('entity-content-shell');
  if (!tabsShell || !contentShell) return;

  let controller = null;
  let requestEpoch = 0;
  let careerAutoloadTimer = null;
  const allowedTabs = kind === 'team'
    ? new Set(['fixtures', 'roster', 'standings', 'rankings', 'columns'])
    : new Set(['stats', 'career', 'columns']);
  const defaultTab = kind === 'team' ? 'fixtures' : 'stats';

  function safePath(value, fallback = '/') {
    const text = String(value || '');
    return text.startsWith('/') && !text.startsWith('//') && !text.includes('\\') && text.length <= 1200 ? text : fallback;
  }

  function visibleSelection() {
    const url = new URL(window.location.href);
    const tab = allowedTabs.has(url.searchParams.get('tab')) ? url.searchParams.get('tab') : (allowedTabs.has(initial.tab) ? initial.tab : defaultTab);
    return {
      tab,
      league: url.searchParams.get('league') || '',
      season: url.searchParams.get('season') || '',
      cursor: '',
    };
  }

  function visiblePath(selection) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', selection.tab);
    if (selection.league) url.searchParams.set('league', selection.league); else url.searchParams.delete('league');
    if (selection.season) url.searchParams.set('season', selection.season); else url.searchParams.delete('season');
    url.searchParams.delete('cursor');
    return `${url.pathname}${url.search}`;
  }

  function endpoint(selection, returnPath) {
    const url = new URL(kind === 'team' ? '/api/fixtures' : '/api/player-photo', window.location.origin);
    url.searchParams.set(kind === 'team' ? 'teamData' : 'playerData', '1');
    url.searchParams.set(kind === 'team' ? 'teamId' : 'playerId', entityId);
    url.searchParams.set('tab', selection.tab);
    if (selection.league) url.searchParams.set('league', selection.league);
    if (selection.season) url.searchParams.set('season', selection.season);
    if (kind === 'player' && selection.cursor) url.searchParams.set('cursor', selection.cursor);
    url.searchParams.set('returnPath', safePath(returnPath, `/${kind === 'team' ? 'teams' : 'players'}/${entityId}`));
    return url;
  }

  function saveScroll() {
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState({ ...state, entityScrollY: Math.max(0, Math.round(window.scrollY || 0)) }, '', window.location.href);
  }

  function setBusy(busy) {
    contentShell.setAttribute('aria-busy', String(Boolean(busy)));
    contentShell.classList.toggle('is-loading', Boolean(busy));
    let status = contentShell.querySelector('.entity-loading-status');
    if (busy && !status) {
      status = document.createElement('div');
      status.className = 'entity-loading-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = '読み込み中';
      contentShell.prepend(status);
    }
    if (status) status.hidden = !busy;
  }

  function setCareerBusy(busy) {
    const career = contentShell.querySelector('.entity-career');
    if (!career) return;
    career.setAttribute('aria-busy', String(Boolean(busy)));
    career.classList.toggle('is-loading', Boolean(busy));
  }

  function cancelCareerAutoload() {
    if (careerAutoloadTimer != null) window.clearTimeout(careerAutoloadTimer);
    careerAutoloadTimer = null;
  }

  function nextCareerCursor() {
    const progress = contentShell.querySelector('.entity-career-progress[data-career-next-cursor]');
    const cursor = Number(progress?.dataset?.careerNextCursor);
    return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
  }

  function queueCareerAutoload(expectedEpoch = requestEpoch) {
    cancelCareerAutoload();
    if (kind !== 'player' || visibleSelection().tab !== 'career' || document.visibilityState === 'hidden') return;
    const cursor = nextCareerCursor();
    if (cursor == null) return;
    careerAutoloadTimer = window.setTimeout(() => {
      careerAutoloadTimer = null;
      if (expectedEpoch !== requestEpoch || visibleSelection().tab !== 'career' || nextCareerCursor() !== cursor) return;
      load({ ...visibleSelection(), tab: 'career', cursor: String(cursor) }, { historyMode: 'replace' });
    }, 90);
  }

  function updateScoreButton(button, hidden) {
    const score = button.dataset.score || '';
    button.setAttribute('aria-pressed', String(!hidden));
    button.textContent = hidden ? '•••' : score;
    button.setAttribute('aria-label', hidden ? '試合結果を表示' : `${score}。試合結果を隠す`);
  }

  function initialSpoilersRevealed() {
    try {
      return JSON.parse(localStorage.getItem('am4:navigation:match-list:v1') || '{}')?.spoilersRevealed === true;
    } catch (_error) { return false; }
  }

  function prepareScoreControls(root = document) {
    const revealed = initialSpoilersRevealed();
    root.querySelectorAll?.('[data-score-control]').forEach((button) => {
      if (!button.dataset.entityScoreInitialized) {
        button.dataset.entityScoreInitialized = 'true';
        updateScoreButton(button, !revealed);
      }
    });
  }

  function prepareImages(root = document) {
    root.querySelectorAll?.('.entity-image img').forEach((image) => {
      if (image.dataset.entityImageBound) return;
      image.dataset.entityImageBound = 'true';
      image.addEventListener('error', () => image.closest('.entity-image')?.classList.add('is-image-missing'), { once: true });
    });
  }

  function updateFavorites(root = document) {
    root.querySelectorAll?.('[data-entity-favorite]').forEach((button) => {
      const type = button.dataset.favoriteType;
      const id = button.dataset.favoriteId;
      const favoriteApi = window.AM4Favorites;
      if (!favoriteApi || !type || !id) return;
      const selected = favoriteApi.has(favoriteApi.read(localStorage), type, id);
      button.setAttribute('aria-pressed', String(selected));
      const symbol = button.querySelector('[aria-hidden="true"]');
      if (symbol) symbol.textContent = selected ? '★' : '☆';
    });
  }

  function prepareInteractive(root = document) {
    prepareScoreControls(root);
    prepareImages(root);
    updateFavorites(root);
  }

  function renderClientError(message) {
    contentShell.innerHTML = `<div class="entity-content-head"><h2>情報を取得できませんでした</h2></div><section class="entity-state entity-state--error" role="status"><h2>再試行できます</h2><p></p><button class="entity-retry" type="button" data-entity-retry>再試行</button></section>`;
    const text = contentShell.querySelector('.entity-state p');
    if (text) text.textContent = message || '時間をおいてもう一度お試しください。';
  }

  function appendCareerContent(contentHtml) {
    const template = document.createElement('template');
    template.innerHTML = contentHtml;
    const incoming = template.content.querySelector('.entity-career');
    const current = contentShell.querySelector('.entity-career');
    if (!incoming || !current) return false;
    const incomingTable = incoming.querySelector('.entity-career-table');
    const currentTable = current.querySelector('.entity-career-table');
    if (!incomingTable || !currentTable) return false;
    current.querySelector('.entity-career-progress')?.remove();
    current.querySelector('[data-career-append-error]')?.remove();
    incomingTable.querySelectorAll('.entity-career-row').forEach((row) => {
      currentTable.append(row);
    });
    const progress = incoming.querySelector('.entity-career-progress');
    if (progress) current.append(progress);
    // An empty final slice still confirms that no older records remain. Keep
    // already appended rows instead of replacing the complete career table.
    return true;
  }

  function renderCareerAppendError(message, cursor) {
    const career = contentShell.querySelector('.entity-career');
    if (!career) return renderClientError(message);
    career.querySelector('.entity-career-progress')?.remove();
    const state = document.createElement('section');
    state.className = 'entity-state entity-state--error';
    state.dataset.careerAppendError = 'true';
    state.setAttribute('role', 'status');
    const heading = document.createElement('h2');
    heading.textContent = '過去の記録を取得できませんでした';
    const copy = document.createElement('p');
    copy.textContent = message || '時間をおいてもう一度お試しください。';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'entity-retry';
    retry.dataset.careerRetry = String(cursor || '');
    retry.textContent = '再試行';
    state.append(heading, copy, retry);
    career.append(state);
  }

  async function load(selection, { historyMode = 'push', restoreScrollY = null } = {}) {
    if (!allowedTabs.has(selection.tab)) selection.tab = defaultTab;
    const nextPath = visiblePath(selection);
    const epoch = ++requestEpoch;
    const appendingCareer = kind === 'player' && selection.tab === 'career' && Boolean(selection.cursor)
      && Boolean(contentShell.querySelector('.entity-career'));
    cancelCareerAutoload();
    controller?.abort();
    controller = new AbortController();
    if (appendingCareer) setCareerBusy(true); else setBusy(true);
    try {
      const response = await fetch(endpoint(selection, nextPath), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (epoch !== requestEpoch) return;
      if (!response.ok || payload.state !== 'ready' || !payload.contentHtml || !payload.tabsHtml) {
        if (appendingCareer) {
          renderCareerAppendError(payload.message || 'この情報を取得できませんでした。', selection.cursor);
          return;
        }
        renderClientError(payload.message || 'この情報を取得できませんでした。');
        return;
      }
      // Background career pages append only rows. Replacing the tab strip on
      // every slice discards the user's keyboard focus while they navigate.
      if (!appendingCareer) tabsShell.innerHTML = payload.tabsHtml;
      if (!appendingCareer || !appendCareerContent(payload.contentHtml)) contentShell.innerHTML = payload.contentHtml;
      if (historyMode === 'push') {
        saveScroll();
        history.pushState({ entityScrollY: window.scrollY || 0 }, '', nextPath);
      } else if (historyMode === 'replace') {
        history.replaceState({ entityScrollY: window.scrollY || 0 }, '', nextPath);
      }
      prepareInteractive(contentShell);
      if (selection.tab === 'career') queueCareerAutoload(epoch);
      if (restoreScrollY != null) window.requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, Number(restoreScrollY) || 0), behavior: 'auto' }));
    } catch (error) {
      if (error?.name !== 'AbortError' && epoch === requestEpoch) {
        if (appendingCareer) renderCareerAppendError('この情報を取得できませんでした。もう一度お試しください。', selection.cursor);
        else renderClientError('この情報を取得できませんでした。もう一度お試しください。');
      }
    } finally {
      if (epoch === requestEpoch) {
        if (appendingCareer) setCareerBusy(false); else setBusy(false);
      }
    }
  }

  function selectionFromTab(target) {
    const current = visibleSelection();
    return { ...current, tab: target.dataset.entityTab || defaultTab, cursor: '' };
  }

  document.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[data-entity-tab]');
    if (tab && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      load(selectionFromTab(tab));
      return;
    }
    const retry = event.target.closest?.('[data-entity-retry]');
    if (retry) {
      event.preventDefault();
      load(visibleSelection(), { historyMode: 'replace' });
      return;
    }
    const careerRetry = event.target.closest?.('[data-career-retry]');
    if (careerRetry && kind === 'player') {
      event.preventDefault();
      load({ ...visibleSelection(), tab: 'career', cursor: careerRetry.dataset.careerRetry || '' }, { historyMode: 'replace' });
      return;
    }
    const score = event.target.closest?.('[data-score-control]');
    if (score) {
      event.preventDefault();
      updateScoreButton(score, score.getAttribute('aria-pressed') === 'true');
      return;
    }
    const favorite = event.target.closest?.('[data-entity-favorite]');
    if (favorite) {
      event.preventDefault();
      const api = window.AM4Favorites;
      const type = favorite.dataset.favoriteType;
      const id = favorite.dataset.favoriteId;
      if (!api || !type || !id) return;
      const label = favorite.dataset.favoriteLabel || (kind === 'team' ? '保存したクラブ' : '保存した選手');
      const href = `/${kind === 'team' ? 'teams' : 'players'}/${entityId}`;
      const saved = api.toggleWithItem(localStorage, type, id, {
        label,
        detail: kind === 'team' ? 'チーム詳細を確認' : '選手詳細を確認',
        href,
      });
      if (saved) updateFavorites(document);
    }
  });

  document.addEventListener('change', (event) => {
    const current = visibleSelection();
    if (kind === 'team' && event.target.matches('[data-team-league], [data-team-season]')) {
      const league = contentShell.querySelector('[data-team-league]')?.value || current.league;
      const season = contentShell.querySelector('[data-team-season]')?.value || current.season;
      load({ ...current, league, season, cursor: '' });
    }
    if (kind === 'player' && event.target.matches('[data-player-league], [data-player-season]')) {
      const league = contentShell.querySelector('[data-player-league]')?.value || '';
      const season = contentShell.querySelector('[data-player-season]')?.value || current.season;
      load({ ...current, tab: 'stats', league: league === 'all' ? '' : league, season, cursor: '' });
    }
  });

  window.addEventListener('popstate', (event) => {
    load(visibleSelection(), { historyMode: 'none', restoreScrollY: event.state?.entityScrollY });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') queueCareerAutoload();
  });
  window.addEventListener('pagehide', saveScroll);

  history.replaceState({ ...(history.state || {}), entityScrollY: window.scrollY || 0 }, '', window.location.href);
  prepareInteractive(document);
  queueCareerAutoload();
})();
