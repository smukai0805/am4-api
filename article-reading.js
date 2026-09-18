// Optional display enhancements; never a dependency of article retrieval.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4ArticleReading = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function appendReportSections(container, blocks, {open = false, onToggle = () => {}, locale = 'ja'} = {}) {
    const document = container.ownerDocument;
    const lead = document.createElement('div');
    lead.className = 'match-editorial-grid';
    const more = blocks.filter(block => block.dataset.reportField !== 'keyFigures');
    lead.append(...blocks.filter(block => block.dataset.reportField === 'keyFigures'));
    container.append(lead);
    if (!more.length) return;
    const details = document.createElement('details');
    details.className = 'match-report-more';
    details.open = open;
    const summary = document.createElement('summary');
    const title = document.createElement('strong');
    title.textContent = locale === 'ja' ? '試合のレビュー・分析を読む' : 'Read the match review & analysis';
    const topics = document.createElement('span');
    topics.className = 'match-report-topics';
    topics.textContent = more.map(block => block.querySelector('h3')?.textContent).filter(Boolean).join(' / ');
    const action = document.createElement('span');
    action.className = 'match-report-more-action';
    const sync = () => { action.textContent = details.open ? (locale === 'ja' ? '閉じる ↑' : 'Show less ↑') : (locale === 'ja' ? 'さらに表示 ↓' : 'Show more ↓'); };
    sync();
    summary.append(title, topics, action);
    const grid = document.createElement('div');
    grid.className = 'match-editorial-grid';
    grid.append(...more);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'match-report-close';
    close.textContent = locale === 'ja' ? 'レビュー・分析を閉じる ↑' : 'Close review & analysis ↑';
    close.addEventListener('click', () => {
      details.open = false;
      summary.scrollIntoView({block:'start', behavior:'instant'});
      summary.focus({preventScroll:true});
    });
    details.addEventListener('toggle', () => { sync(); onToggle(details.open); });
    details.append(summary, grid, close);
    container.append(details);
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (_error) { return null; }
  }

  function linkTokens(value) {
    const text = String(value ?? '');
    const tokens = [];
    // One balanced parenthesis pair supports common Wikipedia/source URLs.
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>]*?\))+)\)|https?:\/\/[^\s<>"'\u3000]+/gi;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) tokens.push({text:text.slice(cursor, match.index)});
      let candidate = match[2] || match[0];
      if (!match[2]) {
        candidate = candidate.replace(/[.,;!?:、。，；！？：）】」』]+$/u, '');
        while (candidate.endsWith(')') && (candidate.match(/\)/g) || []).length > (candidate.match(/\(/g) || []).length) {
          candidate = candidate.slice(0, -1);
        }
      }
      const href = safeUrl(candidate);
      if (href) {
        tokens.push({text:match[1] || candidate, href});
        if (!match[2] && candidate.length < match[0].length) tokens.push({text:match[0].slice(candidate.length)});
      } else tokens.push({text:match[0]});
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) tokens.push({text:text.slice(cursor)});
    return tokens.length ? tokens : [{text}];
  }

  function appendLinkedText(container, value) {
    const document = container.ownerDocument;
    linkTokens(value).forEach((token) => {
      if (!token.href) { container.append(document.createTextNode(token.text)); return; }
      const link = document.createElement('a');
      link.href = token.href;
      link.textContent = token.text;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      container.append(link);
    });
  }

  function enhanceArticle(body, {cleanText = value => value} = {}) {
    const document = body.ownerDocument;
    // Only plain-text leaves from the existing renderer; never reparse HTML or
    // touch the table/list structure, existing links or interactive actions.
    body.querySelectorAll('p, li, blockquote, td, th').forEach((element) => {
      if (element.childElementCount) return;
      const text = cleanText(element.textContent);
      const fragment = document.createDocumentFragment();
      appendLinkedText(fragment, text);
      element.replaceChildren(fragment);
    });
    const paper = body.closest('.article-paper');
    if (paper?.querySelector('.article-kicker')?.textContent.trim() === 'AM4 COLUMN') {
      enhanceColumn(body, paper);
      return;
    }
    const headings = [...body.querySelectorAll(':scope > h2')].filter(heading =>
      !/^(?:目次|アジェンダ|agenda|contents|table of contents)$/i.test(heading.textContent.trim()),
    );
    if (headings.length < 2 || body.querySelector('.article-toc')) return;
    const details = document.createElement('details');
    details.className = 'article-toc';
    const summary = document.createElement('summary');
    summary.textContent = `この記事の目次（${headings.length}項目）`;
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'この記事の目次');
    const list = document.createElement('ol');
    headings.forEach((heading, index) => {
      heading.id = heading.id || `article-section-${index + 1}`;
      heading.tabIndex = -1;
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      item.append(link);
      list.append(item);
    });
    nav.append(list);
    details.append(summary, nav);
    body.prepend(details);
  }

  function headingKey(value) {
    return String(value ?? '').normalize('NFKC').trim()
      .replace(/^(?:【\d+】|\[\d+\]|\d+[.、)．])\s*/, '')
      .replace(/[\s「」『』“”"'‘’]/g, '').toLocaleLowerCase('ja');
  }

  function enhanceColumn(body, paper) {
    if (body.dataset.columnReading === 'v1') return;
    const document = body.ownerDocument;
    paper.classList.add('article-column-reader');
    const all = [...body.querySelectorAll(':scope > h2')];
    const isAgenda = heading => /^(?:目次|アジェンダ|agenda|contents|table of contents)$/i.test(heading.textContent.trim());
    const isPoints = heading => /^(?:3行要約|３行要約|三行要約|この記事のポイント)$/.test(heading.textContent.trim());
    const isSources = heading => /^(?:出典|参考文献|参考資料|sources|references)$/i.test(heading.textContent.trim());
    const agenda = all.find(isAgenda);
    const agendaList = agenda?.nextElementSibling;
    const points = all.find(isPoints);
    let inSources = false;
    const readingCharacters = [...body.children].reduce((total, node) => {
      if (node.matches('h2')) inSources = isSources(node);
      if (inSources || node === agenda || node === agendaList || !node.matches('h2, p, ul, ol, blockquote, .article-table-wrap')) return total;
      return total + node.textContent.replace(/\s/g, '').length;
    }, 0);
    // Keep the previous article-section IDs, including summary/source headings,
    // so already shared fragments still identify the same passage.
    all.filter(heading => !isAgenda(heading)).forEach((heading, index) => {
      let id = `article-section-${index + 1}`;
      let suffix = 2;
      while (!heading.id && document.getElementById(id)) id = `article-section-${index + 1}-${suffix++}`;
      heading.id = heading.id || id;
      heading.tabIndex = -1;
    });
    if (points) {
      points.textContent = 'この記事のポイント';
      points.classList.add('article-points-heading');
      if (points.nextElementSibling?.matches('ul, ol')) points.nextElementSibling.classList.add('article-points-list');
    }
    const candidates = all.filter(heading => !isAgenda(heading) && !isPoints(heading) && !isSources(heading));
    const entries = agendaList?.matches('ul, ol') ? [...agendaList.children].filter(node => node.matches('li')) : [];
    const matched = entries.map(item => candidates.find(heading => headingKey(heading.textContent) === headingKey(item.textContent)));
    // An authored agenda is removable only when every entry has a unique target.
    // Preserve unmatched notes and unusual content instead of discarding them.
    const mappedAgenda = entries.length > 0 && matched.every(Boolean) && new Set(matched).size === entries.length;
    const headings = mappedAgenda ? candidates.filter(heading => matched.includes(heading)) : candidates;
    body.dataset.columnReading = 'v1';
    if (headings.length < 2) return;
    body.querySelectorAll(':scope > .article-toc').forEach(toc => toc.remove());
    const details = document.createElement('section');
    details.className = 'article-toc article-column-toc';
    let tocId = 'article-contents';
    let tocSuffix = 2;
    while (document.getElementById(tocId)) tocId = `article-contents-${tocSuffix++}`;
    details.id = tocId;
    const summary = document.createElement('h2');
    summary.className = 'article-toc-heading';
    summary.tabIndex = -1;
    summary.textContent = '目次';
    const count = document.createElement('span');
    count.className = 'article-toc-count';
    count.textContent = `${headings.length}項目`;
    summary.append(count);
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'この記事の目次');
    const list = document.createElement('ol');
    headings.forEach((heading, index) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.setAttribute('href', `#${heading.id}`);
      const number = document.createElement('span');
      number.className = 'article-toc-number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = String(index + 1).padStart(2, '0');
      const label = document.createElement('span');
      label.textContent = heading.textContent;
      link.append(number, label);
      link.addEventListener('click', () => heading.focus({preventScroll:true}));
      item.append(link);
      list.append(item);
    });
    nav.append(list);
    details.append(summary, nav);
    if (mappedAgenda) {
      agenda.before(details);
      agenda.remove();
      agendaList.remove();
    } else headings[0].before(details);
    const back = document.createElement('a');
    back.className = 'article-toc-return';
    back.setAttribute('href', `#${tocId}`);
    back.textContent = '目次に戻る';
    back.addEventListener('click', () => summary.focus({preventScroll:true}));
    const end = all.find(isSources) || body.querySelector('.article-sources, .article-tags, .article-footer-actions');
    if (end) end.before(back);
    else body.append(back);
    const meta = paper.querySelector('.article-meta');
    if (meta && !meta.querySelector('.article-reading-time')) {
      if (readingCharacters > 0) {
        const time = document.createElement('span');
        time.className = 'article-reading-time';
        time.textContent = `読む目安 約${Math.max(1, Math.ceil(readingCharacters / 500))}分`;
        meta.append(time);
      }
    }
  }

  function splitSummary(value) {
    const text = String(value ?? '');
    if (text.length <= 300) return {lead:text, rest:''};
    const sentence = text.indexOf('。', 140);
    const end = sentence >= 140 && sentence < 260 ? sentence + 1 : 180;
    return {lead:text.slice(0, end), rest:text.slice(end)};
  }

  return {linkTokens, appendLinkedText, enhanceArticle, splitSummary, appendReportSections, headingKey};
});
