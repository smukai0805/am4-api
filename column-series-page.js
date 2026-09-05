(() => {
  const root = document.getElementById('twenty-seasons-grid');
  const status = document.getElementById('twenty-seasons-status');
  const series = window.AM4ColumnSeries;
  if (!root || !status || !series) return;

  const PERIODS = new Map([
    ['2006-07', '2006 — 2009'],
    ['2010-11', '2010 — 2014'],
    ['2015-16', '2015 — 2019'],
    ['2020-21', '2020 — 2024'],
    ['2025-26', '2025 — 2026'],
  ]);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function seasonLabel(season) {
    const [start, end] = String(season).split('-');
    return `${start} — ${end}`;
  }

  function dateLabel(value) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
  }

  function categoryLabel(article) {
    const category = String(article?.story?.category || article?.category || '').trim();
    return category || 'AM4 COLUMN';
  }

  function excerpt(article) {
    const value = String(article?.summary || article?.deck || '').replace(/\s+/g, ' ').trim();
    return /(?:^|\s)(?:3行要約|アジェンダ)(?:\s|$)/u.test(value) ? '' : value;
  }

  function arrow() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('class', 'twenty-seasons-arrow');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 12h13M13 6l6 6-6 6');
    icon.append(path);
    return icon;
  }

  function seasonCard(season, article, index) {
    const available = Boolean(article?.id);
    const card = node(available ? 'a' : 'article', `twenty-season-card ${available ? 'is-available' : 'is-coming-soon'} twenty-season-reveal`);
    card.style.setProperty('--twenty-season-delay', String(index % 5));
    if (available) {
      card.href = `/article.html?id=${encodeURIComponent(article.id)}`;
      card.setAttribute('aria-label', `${article.title || season}を読む`);
    } else {
      card.setAttribute('aria-label', `${season}の物語は準備中です`);
    }

    const head = node('div', 'twenty-season-card-head');
    head.append(node('span', 'twenty-season-kicker', 'SEASON'), node('time', 'twenty-season-year', seasonLabel(season)));
    card.append(head);

    if (available) {
      card.append(node('span', 'twenty-season-category', categoryLabel(article)));
      card.append(node('h2', 'twenty-season-title', article.title || season));
      const copy = excerpt(article);
      if (copy) card.append(node('p', 'twenty-season-excerpt', copy));
      const footer = node('span', 'twenty-season-card-footer');
      const publishedAt = dateLabel(article.publishedAt);
      if (publishedAt) footer.append(node('time', 'twenty-season-date', publishedAt));
      footer.append(node('span', 'twenty-season-read', 'READ STORY'), arrow());
      card.append(footer);
    } else {
      card.append(node('p', 'twenty-season-pending', 'Coming Soon'));
      card.append(node('p', 'twenty-season-pending-copy', 'このシーズンの物語を準備しています。'));
    }
    return card;
  }

  function render(articles) {
    const bySeason = series.storiesBySeason(articles);
    const fragment = document.createDocumentFragment();
    series.seasons().forEach((season, index) => {
      const period = PERIODS.get(season);
      if (period) {
        const divider = node('div', 'twenty-season-period');
        divider.append(node('span', '', period), node('span', '', 'SEASONS'));
        fragment.append(divider);
      }
      fragment.append(seasonCard(season, bySeason.get(season), index));
    });
    root.replaceChildren(fragment);
    observeReveals();
    const published = bySeason.size;
    status.textContent = published
      ? `${published} / 20 STORIES AVAILABLE`
      : 'STORIES ARE BEING PREPARED';
  }

  function renderArchiveState(kind, message) {
    root.replaceChildren(node('p', `twenty-seasons-archive-state ${kind}`, message));
  }

  function observeReveals() {
    const cards = Array.from(root.querySelectorAll('.twenty-season-reveal'));
    if (reducedMotion || !('IntersectionObserver' in window)) {
      cards.forEach((card) => card.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
        .forEach((entry, index) => {
          entry.target.style.setProperty('--twenty-season-delay', String(index % 5));
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -7% 0px' });
    cards.forEach((card) => observer.observe(card));
  }

  async function loadStories() {
    const apiBase = window.AM4SiteConfig?.resolveApiBase(location.hostname) || '';
    const all = [];
    let page = 1;
    let totalPages = 1;
    do {
      const response = await fetch(`${apiBase}/articles?type=am4_story&page=${page}&pageSize=100`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Article archive request failed (${response.status})`);
      const payload = await response.json();
      all.push(...(Array.isArray(payload?.items) ? payload.items : []));
      totalPages = Math.max(1, Number(payload?.totalPages) || 1);
      page += 1;
    } while (page <= totalPages);
    return all;
  }

  renderArchiveState('is-loading', 'STORIES ARE LOADING');
  status.textContent = 'LOADING ARCHIVE';
  loadStories()
    .then(render)
    .catch((error) => {
      console.warn('20 Seasons archive unavailable.', error);
      status.textContent = 'ARCHIVE UNAVAILABLE';
      renderArchiveState('is-error', '記事を読み込めませんでした。時間をおいて再度お試しください。');
    });
})();
