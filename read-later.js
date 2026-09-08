(() => {
  const list = document.getElementById('reading-saved');
  if (!list) return;
  let storage;
  try { storage = localStorage; } catch (_error) { /* Readable empty state when storage is blocked. */ }
  const count = document.getElementById('reading-count');
  const status = document.getElementById('reading-status');
  const retry = document.getElementById('reading-retry');
  const feedback = document.getElementById('reading-action-status');
  const undo = document.getElementById('reading-undo');
  const suggestions = document.getElementById('reading-suggestions');
  const suggestionsStatus = document.getElementById('reading-suggestions-status');
  const suggestionsRetry = document.getElementById('reading-suggestions-retry');
  const apiBase = AM4SiteConfig.resolveApiBase(location.hostname);
  const states = new Map();
  let catalog = AM4Favorites.readCatalog(storage);
  let candidates = [];
  let suggestionsState = 'loading';
  let generation = 0;
  let suggestionsGeneration = 0;
  let lastRemoved = null;
  let restorePosition = true;
  const bookmark = '<svg viewBox="0 0 24 28" aria-hidden="true"><path d="M5 2h14a1 1 0 0 1 1 1v23l-8-5-8 5V3a1 1 0 0 1 1-1Z"/></svg><span>解除</span>';
  const kinds = {am4_story:'AM4 COLUMN',match_report:'試合解説',match_prediction:'試合予想',player_intro:'選手ストーリー',transfer_news:'移籍情報'};

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function rowId(prefix,id) { return `${prefix}-${String(id).replace(/[^\w-]/g,'-')}`; }
  function fixtureFor(item) {
    if (!item?.href?.startsWith('/article.html?')) return null;
    const params = new URLSearchParams(item.href.split('?')[1]);
    return params.get('id') === item.id ? params.get('fixtureId') : null;
  }
  function articleLink(item,anchor) {
    // Rebuild the local link from its ID; preserve the Notion mirror fallback locator.
    const params = new URLSearchParams({id:item.id,from:`/read-later#${anchor}`});
    const fixture = Number(fixtureFor(item));
    if (Number.isSafeInteger(fixture) && fixture > 0) params.set('fixtureId',String(fixture));
    return `/article.html?${params}`;
  }
  function articleItem(article,fixtureId) {
    return {type:'articles',id:String(article.id),label:article.title || 'AM4記事',detail:kinds[article.type] || 'AM4記事',href:AM4ArticleLoadState.articleHref(article,fixtureId || article.match?.fixtureId)};
  }
  async function timedFetch(url,options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),20000);
    try { return await fetch(url,{...options,signal:controller.signal}); }
    finally { clearTimeout(timer); }
  }
  function restoreRow() {
    if (!restorePosition || !/^#(?:saved|suggested)-[\w-]+$/.test(location.hash)) return;
    const anchor = location.hash.slice(1);
    const target = document.getElementById(anchor) || document.getElementById(anchor.replace(/^suggested-/, 'saved-'));
    target?.scrollIntoView({block:'center',behavior:'instant'});
  }
  function row(item,saved) {
    const card = node('article','reading-row');
    card.id = rowId(saved ? 'saved' : 'suggested',item.id);
    const copy = node('div','reading-row-copy');
    copy.append(node('p','reading-row-meta',item.detail));
    const heading = node('h3','');
    const missing = saved && states.get(item.id) === 'missing';
    const title = node(missing ? 'span' : 'a','',item.label);
    if (!missing) {
      title.id = `open-${card.id}`;
      title.href = articleLink(item,card.id);
    }
    heading.append(title);
    copy.append(heading);
    if (missing) copy.append(node('p','reading-row-message','現在この記事は公開されていません。保存はそのまま残しています。'));
    if (saved && states.get(item.id) === 'unavailable') copy.append(node('p','reading-row-message','最新情報を確認できませんでした。保存済みのリンクから開けます。'));
    card.append(copy);
    if (saved) {
      const remove = node('button','reading-remove');
      remove.type = 'button';
      remove.id = `remove-${card.id}`;
      remove.setAttribute('aria-label',`${item.label}をあとで読むから解除`);
      remove.innerHTML = bookmark;
      remove.addEventListener('click',() => removeArticle(item));
      card.append(remove);
    } else {
      const arrow = node('span','','→');
      arrow.setAttribute('aria-hidden','true');
      card.append(arrow);
    }
    return card;
  }
  function renderSaved() {
    const focusId = document.activeElement?.id;
    const favorites = AM4Favorites.read(storage);
    const items = AM4Favorites.resolveSavedItems(favorites,catalog).filter(item=>item.type === 'articles').reverse();
    count.textContent = `${items.length}件`;
    list.replaceChildren(...items.map(item=>row(item,true)));
    const pending = items.some(item=>states.get(item.id) === 'pending');
    const failed = items.some(item=>states.get(item.id) === 'unavailable' || states.get(item.id) === 'missing');
    list.setAttribute('aria-busy',String(pending));
    status.textContent = pending ? '保存した記事の最新情報を確認しています。' : '';
    retry.hidden = !failed;
    if (!items.length) {
      const empty = node('div','reading-empty');
      empty.append(node('h3','','読みたい一編を、ここに。'),node('p','','記事の右上にある「あとで読む」から追加できます。まずは下の候補やCOLUMN一覧から、気になる記事を探してみてください。'));
      const link = node('a','','COLUMNから記事を探す →');
      link.href = '/column';
      empty.append(link);
      list.append(empty);
    }
    if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
  }
  function renderSuggestions() {
    const saved = new Set(AM4Favorites.read(storage).articles);
    const items = candidates.filter(item=>!saved.has(item.id)).slice(0,3);
    suggestions.replaceChildren(...items.map(item=>row(item,false)));
    suggestions.setAttribute('aria-busy',String(suggestionsState === 'loading'));
    suggestionsRetry.hidden = suggestionsState !== 'failed';
    suggestionsStatus.textContent = suggestionsState === 'loading' ? '候補を読み込んでいます。'
      : suggestionsState === 'failed' ? '候補を取得できませんでした。COLUMN一覧からも探せます。'
      : items.length ? '' : 'ほかの記事はCOLUMN一覧や20 Seasonsから探せます。';
  }
  function removeArticle(item) {
    const favorites = AM4Favorites.read(storage);
    const remaining = favorites.articles.filter(id=>id !== item.id);
    if (!AM4Favorites.write(storage,{...favorites,articles:remaining})) {
      feedback.textContent = '解除できませんでした。ブラウザーの保存設定を確認してください。';
      return;
    }
    lastRemoved = item;
    feedback.textContent = 'あとで読むから解除しました。';
    undo.hidden = false;
    renderSaved();
    renderSuggestions();
    undo.focus({preventScroll:true});
    document.dispatchEvent(new CustomEvent('am4:favorites-changed'));
  }
  undo.addEventListener('click',() => {
    if (!lastRemoved) return;
    const favorites = AM4Favorites.read(storage);
    const articles = [...new Set([...favorites.articles,lastRemoved.id])];
    if (!AM4Favorites.write(storage,{...favorites,articles})) {
      feedback.textContent = '元に戻せませんでした。もう一度お試しください。';
      return;
    }
    feedback.textContent = 'あとで読むに戻しました。';
    undo.hidden = true;
    renderSaved();
    renderSuggestions();
    document.getElementById(`remove-${rowId('saved',lastRemoved.id)}`)?.focus({preventScroll:true});
    lastRemoved = null;
    document.dispatchEvent(new CustomEvent('am4:favorites-changed'));
  });
  async function loadSaved() {
    const ticket = ++generation;
    catalog = AM4Favorites.readCatalog(storage);
    const ids = AM4Favorites.read(storage).articles;
    ids.forEach(id=>states.set(id,'pending'));
    renderSaved();
    restoreRow();
    let next = 0;
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async () => {
      while (next < ids.length && ticket === generation) {
        const id = ids[next++];
        const fixtureId = fixtureFor(catalog[`articles:${id}`]);
        const result = await AM4ArticleLoadState.readArticle({fetcher:timedFetch,apiBase,id,fixtureId});
        if (ticket !== generation) return;
        states.set(id,result.state);
        if (result.state === 'ready') {
          const item = articleItem(result.article,fixtureId);
          catalog[`articles:${id}`] = item;
          AM4Favorites.remember(storage,item);
        }
        renderSaved();
      }
    }));
    if (ticket === generation) restoreRow();
  }
  async function loadSuggestions() {
    const ticket = ++suggestionsGeneration;
    suggestionsState = 'loading';
    renderSuggestions();
    try {
      const response = await timedFetch(`${apiBase}/articles?type=am4_story&page=1&pageSize=8`,{headers:{Accept:'application/json'}});
      if (!response.ok) throw new Error('Archive unavailable');
      const result = await response.json();
      if (!Array.isArray(result.items)) throw new Error('Invalid archive');
      if (ticket !== suggestionsGeneration) return;
      candidates = [...new Map(result.items.filter(article=>article.id).map(article=>[String(article.id),articleItem(article)])).values()];
      suggestionsState = 'ready';
    } catch (_error) {
      if (ticket !== suggestionsGeneration) return;
      suggestionsState = 'failed';
    }
    renderSuggestions();
    restoreRow();
  }
  for (const event of ['pointerdown','touchstart','wheel','keydown']) window.addEventListener(event,() => {restorePosition = false;},{passive:true});
  window.addEventListener('pageshow',event => {if (event.persisted) {void loadSaved();renderSuggestions();}});
  window.addEventListener('storage',event => {
    if (event.key === AM4Favorites.STORAGE_KEY || event.key === null) {void loadSaved();renderSuggestions();}
  });
  retry.addEventListener('click',() => {void loadSaved();});
  suggestionsRetry.addEventListener('click',() => {void loadSuggestions();});
  void loadSaved();
  void loadSuggestions();
})();
