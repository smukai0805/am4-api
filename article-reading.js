// Optional display enhancements; never a dependency of article retrieval.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4ArticleReading = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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

  function splitSummary(value) {
    const text = String(value ?? '');
    if (text.length <= 300) return {lead:text, rest:''};
    const sentence = text.indexOf('。', 140);
    const end = sentence >= 140 && sentence < 260 ? sentence + 1 : 180;
    return {lead:text.slice(0, end), rest:text.slice(end)};
  }

  return {linkTokens, appendLinkedText, enhanceArticle, splitSummary};
});
