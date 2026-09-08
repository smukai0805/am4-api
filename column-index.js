(() => {
  const list = document.getElementById('column-index-list');
  if (!list) return;
  const form = document.getElementById('column-index-search');
  const input = document.getElementById('column-query');
  const clear = document.getElementById('column-search-clear');
  const status = document.getElementById('column-index-status');
  const title = document.getElementById('column-results-title');
  const retry = document.getElementById('column-index-retry');
  const pagers = [...document.querySelectorAll('.column-pagination')];
  const apiBase = AM4SiteConfig.resolveApiBase(location.hostname);
  const pageSize = 8;
  let requestId = 0;
  let controller;

  function state() {
    const params = new URLSearchParams(location.search);
    const page = Number(params.get('page'));
    return {q:(params.get('q') || '').trim().slice(0,120), page:Number.isSafeInteger(page) && page > 0 ? page : 1};
  }
  function listUrl({q, page}) {
    const params = new URLSearchParams();
    if (q) params.set('q',q);
    if (page > 1) params.set('page',page);
    return `/column${params.size ? `?${params}` : ''}`;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function row(article, current) {
    const item = node('article','column-index-row');
    item.id = `story-${String(article.id).replace(/[^\w-]/g,'-')}`;
    const copy = node('div','');
    const meta = node('div','column-index-meta');
    meta.append(node('span','',article.story?.category || article.category || 'AM4 COLUMN'));
    const date = new Date(article.publishedAt);
    if (Number.isFinite(date.getTime())) {
      const time = node('time','',new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date));
      time.dateTime = date.toISOString();
      meta.append(time);
    }
    const heading = node('h3','');
    const link = node('a','',article.title || 'AM4 COLUMN');
    link.href = `/article.html?${new URLSearchParams({id:article.id, from:`${listUrl(current)}#${item.id}`})}`;
    heading.append(link);
    copy.append(meta,heading);
    const arrow = node('span','','→');
    arrow.setAttribute('aria-hidden','true');
    item.append(copy,arrow);
    return item;
  }
  function pagination(current, totalPages) {
    pagers.forEach(pager => {
      pager.replaceChildren();
      pager.hidden = totalPages <= 1;
      for (const [label, page, disabled] of [['← 前へ',current.page-1,current.page<=1],['次へ →',current.page+1,current.page>=totalPages]]) {
        const control = node(disabled ? 'span' : 'a','',label);
        if (disabled) control.setAttribute('aria-disabled','true');
        else control.href = listUrl({...current,page});
        if (label === '次へ →') pager.append(node('span','',`${current.page} / ${totalPages} ページ`));
        pager.append(control);
      }
    });
  }
  async function load({focus = false} = {}) {
    const ticket = ++requestId;
    controller?.abort();
    controller = new AbortController();
    const activeController = controller;
    const current = state();
    input.value = current.q;
    clear.hidden = !current.q;
    title.textContent = current.q ? `「${current.q}」の検索結果` : 'すべての記事';
    status.textContent = '記事を読み込んでいます。';
    list.setAttribute('aria-busy','true');
    list.replaceChildren();
    retry.hidden = true;
    pagers.forEach(pager => { pager.hidden = true; });
    const timeout = setTimeout(() => activeController.abort(),20000);
    try {
      const params = new URLSearchParams({type:'am4_story',page:current.page,pageSize});
      if (current.q) params.set('search',current.q);
      const response = await fetch(`${apiBase}/articles?${params}`,{headers:{Accept:'application/json'},signal:activeController.signal});
      if (!response.ok) throw new Error('Archive unavailable');
      const result = await response.json();
      if (ticket !== requestId) return;
      if (!Array.isArray(result.items) || !Number.isInteger(result.total) || !Number.isInteger(result.page) || result.page < 1 || !Number.isInteger(result.totalPages) || result.totalPages < 1) throw new Error('Invalid archive response');
      current.page = result.page;
      history.replaceState(null,'',`${listUrl(current)}${location.hash}`);
      list.replaceChildren(...result.items.filter(article=>article.id).map(article=>row(article,current)));
      if (!result.total) list.append(node('p','column-index-empty',current.q ? '該当する記事がありません。別の言葉で検索するか、検索を解除してください。' : '公開されたCOLUMNはまだありません。'));
      status.textContent = result.total ? `${(current.page-1)*pageSize+1}–${Math.min(current.page*pageSize,result.total)} / 全${result.total}件` : '0件';
      pagination(current,result.totalPages);
      if (focus) {
        title.scrollIntoView({block:'start',behavior:'instant'});
        title.focus({preventScroll:true});
      } else if (/^#story-[\w-]+$/.test(location.hash)) {
        document.getElementById(location.hash.slice(1))?.scrollIntoView({block:'center',behavior:'instant'});
      }
    } catch (_error) {
      if (ticket !== requestId) return;
      status.textContent = '記事を取得できませんでした。';
      list.append(node('p','column-index-empty','通信状態を確認して、もう一度お試しください。'));
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (ticket === requestId) list.setAttribute('aria-busy','false');
    }
  }
  function navigate(next) {
    const url = typeof next === 'string' ? next : listUrl(next);
    if (`${location.pathname}${location.search}${location.hash}` !== url) history.pushState(null,'',url);
    void load({focus:true});
  }
  form.addEventListener('submit',event => { event.preventDefault(); navigate({q:input.value.trim().slice(0,120),page:1}); });
  clear.addEventListener('click',() => navigate({q:'',page:1}));
  retry.addEventListener('click',() => { void load({focus:true}); });
  pagers.forEach(pager => pager.addEventListener('click',event => {
    const link = event.target.closest('a');
    if (!link || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  }));
  window.addEventListener('popstate',() => { void load(); });
  void load();
})();
