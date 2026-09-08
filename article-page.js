(function () {

  const paper = document.getElementById("article-paper");
  const id = new URLSearchParams(location.search).get("id");
  const fixtureId = new URLSearchParams(location.search).get('fixtureId');
  const apiBase = AM4SiteConfig.resolveApiBase(location.hostname);
  const articleBack = document.querySelector(".article-back");
  const homeState = window.AM4NavigationState?.readHomeState(sessionStorage);
  if (articleBack && homeState?.returnUrl) articleBack.href = homeState.returnUrl;
  // A list return URL is explicit and limited to this route, never an external redirect.
  const columnReturn = new URLSearchParams(location.search).get('from');
  const fromColumn = /^\/column(?:\?[^#]*)?(?:#story-[\w-]+)?$/.test(columnReturn || '') ? columnReturn : null;
  if (articleBack && fromColumn) {
    articleBack.href = fromColumn;
    articleBack.textContent = '← COLUMN一覧へ戻る';
  }

  function articleTypeLabel(type) {
    return {
      player_intro: "Player Story",
      match_report: "Match Report",
      match_prediction: "Match Preview",
      am4_story: "AM4 COLUMN",
      transfer_news: "Transfer Wire",
    }[type] || "AM4 COLUMN";
  }

  function appendBody(container, article) {
    const blocks = Array.isArray(article.body)
      ? article.body
      : AM4ArticleContent.parseMarkdownBlocks(article.body);
    blocks.forEach((block) => {
      if (block.type === "list") {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        block.items.forEach((text) => {
          const item = document.createElement("li");
          item.textContent = text;
          list.append(item);
        });
        container.append(list);
        return;
      }
      if (block.type === "table") {
        const wrap = document.createElement("div");
        wrap.className = "article-table-wrap";
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        block.headers.forEach((text) => {
          const cell = document.createElement("th");
          cell.scope = "col";
          cell.textContent = text;
          headRow.append(cell);
        });
        head.append(headRow);
        const body = document.createElement("tbody");
        block.rows.forEach((values) => {
          const row = document.createElement("tr");
          values.forEach((text) => {
            const cell = document.createElement("td");
            cell.textContent = text;
            row.append(cell);
          });
          body.append(row);
        });
        table.append(head, body);
        wrap.append(table);
        container.append(wrap);
        return;
      }
      const tag = block.type === "heading" ? "h2" : block.type === "quote" ? "blockquote" : "p";
      const node = document.createElement(tag);
      node.textContent = block.text;
      container.append(node);
    });
  }

  function renderScoreboard(container, scoreboard) {
    if (!scoreboard) return;
    const board = document.createElement("div");
    board.className = "article-scoreboard";
    const home = document.createElement("span");
    const score = document.createElement("strong");
    const away = document.createElement("span");
    home.textContent = scoreboard.home || scoreboard.homeTeam || "Home";
    away.textContent = scoreboard.away || scoreboard.awayTeam || "Away";
    const homeScore = scoreboard.homeScore ?? scoreboard.homeGoals ?? "-";
    const awayScore = scoreboard.awayScore ?? scoreboard.awayGoals ?? "-";
    score.textContent = `${homeScore} – ${awayScore}`;
    board.append(home, score, away);
    container.append(board);
  }

  function renderSources(container, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    const section = document.createElement("section");
    section.className = "article-sources";
    const heading = document.createElement("h2");
    heading.textContent = "出典";
    section.append(heading);
    sources.forEach((source) => {
      let url;
      try { url = new URL(source.url); } catch (_error) { return; }
      if (!/^https?:$/.test(url.protocol)) return;
      const paragraph = document.createElement("p");
      const link = document.createElement("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || url.hostname;
      paragraph.append(link);
      section.append(paragraph);
    });
    if (section.children.length > 1) container.append(section);
  }

  function compactArticleText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  function articleTags(article) {
    const tags = Array.isArray(article.tags) ? article.tags : [];
    return tags
      .map((tag) => compactArticleText(tag).replace(/^#+\s*/, ""))
      .filter(Boolean)
      .filter((tag, index, list) => list.findIndex((item) => item.toLocaleLowerCase("en-US") === tag.toLocaleLowerCase("en-US")) === index)
      .slice(0, 8);
  }

  function displayArticleTag(value) {
    const tag = compactArticleText(value).replace(/^#+\s*/, "");
    const latinTag = /^[\p{Script=Latin}\p{Number}\s&.'’+\-]+$/u.test(tag);
    return `#${latinTag ? tag.toLocaleUpperCase("en-US") : tag}`;
  }

  function formatArticleDate(value) {
    return AM4ArticlePresentation.formatTokyoDate(value) || "公開日未設定";
  }

  function renderArticleTags(container, article) {
    if (article.type !== "am4_story") return null;
    const tags = articleTags(article);
    if (!tags.length) return null;
    const section = document.createElement("section");
    section.className = "article-tags";
    const heading = document.createElement("h2");
    heading.textContent = "Tags";
    const list = document.createElement("div");
    list.className = "article-tags-list";
    tags.forEach((tag) => {
      const link = document.createElement("a");
      link.className = "article-tag-link";
      link.href = `/?columnTag=${encodeURIComponent(tag)}#lead-story`;
      link.textContent = displayArticleTag(tag);
      link.setAttribute("aria-label", `${displayArticleTag(tag)}でAM4 COLUMNを絞り込む`);
      list.append(link);
    });
    section.append(heading, list);
    container.append(section);
    return section;
  }

  function sharedTagCount(currentArticle, candidate) {
    const current = new Set(articleTags(currentArticle).map((tag) => tag.toLocaleLowerCase("en-US")));
    return articleTags(candidate).filter((tag) => current.has(tag.toLocaleLowerCase("en-US"))).length;
  }

  function compareRecommendedArticles(currentArticle, left, right) {
    const leftRank = Number.isInteger(Number(left.popularRank)) && Number(left.popularRank) > 0 ? Number(left.popularRank) : Number.POSITIVE_INFINITY;
    const rightRank = Number.isInteger(Number(right.popularRank)) && Number(right.popularRank) > 0 ? Number(right.popularRank) : Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const sharedDifference = sharedTagCount(currentArticle, right) - sharedTagCount(currentArticle, left);
    if (sharedDifference) return sharedDifference;
    return new Date(right.publishedAt || 0) - new Date(left.publishedAt || 0);
  }

  function renderRecommendedCard(article) {
    const card = document.createElement("a");
    card.className = "article-related-card";
    card.href = `/article.html?id=${encodeURIComponent(article.id)}`;
    card.setAttribute("aria-label", `${article.title || "AM4 COLUMN"}を読む`);
    if (typeof article.coverImage === "string" && /^https?:\/\//i.test(article.coverImage)) {
      const image = document.createElement("img");
      image.src = article.coverImage;
      image.alt = "";
      image.loading = "lazy";
      card.append(image);
    }
    const date = document.createElement("time");
    date.dateTime = article.publishedAt || "";
    date.textContent = formatArticleDate(article.publishedAt);
    const title = document.createElement("h3");
    title.textContent = article.title || "AM4 COLUMN";
    const tags = document.createElement("div");
    tags.className = "article-related-card-tags";
    articleTags(article).slice(0, 2).forEach((tag) => {
      const chip = document.createElement("span");
      chip.textContent = displayArticleTag(tag);
      tags.append(chip);
    });
    card.append(date, title, tags);
    return card;
  }

  async function renderRecommendedArticles(currentArticle, container) {
    if (currentArticle.type !== "am4_story") {
      container.remove();
      return;
    }
    try {
      const response = await fetch(`${apiBase}/articles?type=am4_story&pageSize=100`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`articles unavailable (${response.status})`);
      const data = await response.json();
      const articles = Array.isArray(data.items) ? data.items : [];
      if (window.AM4ColumnSeries?.isTwentySeasonsStory(currentArticle)) {
        // Only series navigation needs the full archive. Failure of this extra
        // read must not remove the article or its already available cards.
        void (async () => {
          try {
            const all = [...articles];
            const totalPages = Math.max(1, Number(data.totalPages) || 1);
            for (let page = 2; page <= totalPages; page += 1) {
              const response = await fetch(`${apiBase}/articles?type=am4_story&pageSize=100&page=${page}`, { headers: { Accept:"application/json" } });
              if (!response.ok) throw new Error('Series unavailable');
              const payload = await response.json();
              if (!Array.isArray(payload.items)) throw new Error('Series unavailable');
              all.push(...payload.items);
            }
            renderSeriesNavigation(currentArticle, all, container);
          } catch (_error) { /* Keep the collection return link and article. */ }
        })();
      }
      const recommended = articles
        .filter((article) => article.id && article.id !== currentArticle.id)
        .sort((left, right) => compareRecommendedArticles(currentArticle, left, right))
        .slice(0, 4);
      if (!recommended.length) {
        container.remove();
        return;
      }
      const hasManualPopularity = recommended.some((article) => Number.isInteger(Number(article.popularRank)) && Number(article.popularRank) > 0);
      const heading = document.createElement("h2");
      heading.textContent = hasManualPopularity ? "よく読まれている記事" : "関連する記事";
      const intro = document.createElement("p");
      intro.className = "article-related-intro";
      intro.textContent = hasManualPopularity ? "AM4 COLUMN" : "同じテーマのAM4 COLUMN";
      const grid = document.createElement("div");
      grid.className = "article-related-grid";
      recommended.forEach((article) => grid.append(renderRecommendedCard(article)));
      container.append(heading, intro, grid);
      container.hidden = false;
    } catch (_error) {
      container.remove();
    }
  }

  function renderSeriesNavigation(article, articles, before) {
    const navigation = window.AM4ColumnSeries?.storyNavigation(article, articles);
    if (!navigation) return;
    const nav = document.createElement("nav");
    nav.className = "article-series-navigation";
    nav.setAttribute("aria-label", "20 Seasonsの読み進め方");
    const collection = document.createElement("a");
    collection.className = "article-series-return";
    collection.href = `/column/20-seasons#season-${navigation.season}`;
    collection.textContent = "20 Seasons, 20 Stories. · シーズン一覧へ";
    nav.append(collection);
    [["前の公開ストーリー", navigation.previous], ["次の公開ストーリー", navigation.next]].forEach(([label, story]) => {
      if (!story?.id) return;
      const link = document.createElement("a");
      link.href = `/article.html?id=${encodeURIComponent(story.id)}`;
      const small = document.createElement("small");
      small.textContent = `${label} · ${window.AM4ColumnSeries.seasonForStory(story)}`;
      const title = document.createElement("span");
      title.textContent = story.title || small.textContent;
      link.append(small, title);
      nav.append(link);
    });
    before.before(nav);
  }

  function renderArticle(article) {
    document.title = `${article.title}｜AM4 Football`;
    const header = document.createElement("header");
    header.className = "article-header";
    header.innerHTML = '<div class="article-kicker"><span></span></div><h1 class="article-title"></h1><div class="article-meta"></div>';
    header.querySelector(".article-kicker span:first-child").textContent = articleTypeLabel(article.type);
    header.querySelector(".article-title").textContent = article.title;
    const brandPill = document.getElementById("article-brand-pill");
    if (brandPill) brandPill.textContent = articleTypeLabel(article.type);
    const meta = header.querySelector(".article-meta");
    const published = formatArticleDate(article.publishedAt);
    meta.textContent = `${published} · ${article.readTime || "AM4編集部"}`;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "favorite-btn";
    save.dataset.favoriteType = "articles";
    save.dataset.favoriteId = article.id;
    save.dataset.favoriteLabel = article.title || "AM4記事";
    save.dataset.favoriteDetail = articleTypeLabel(article.type);
    const savedHref = AM4ArticleLoadState.articleHref(article, fixtureId || article.match?.fixtureId);
    save.dataset.favoriteHref = savedHref;
    save.textContent = "あとで読む";
    const topSave = document.createElement('button');
    topSave.type = 'button';
    topSave.className = 'favorite-btn read-later-button';
    topSave.innerHTML = '<svg class="bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z"></path></svg><span></span>';
    const topStatus = document.createElement('p');
    topStatus.className = 'article-top-save-status';
    topStatus.setAttribute('role','status');
    const topActions = document.getElementById('article-top-actions');
    if (topActions) topActions.replaceChildren(topSave, topStatus);
    else header.querySelector('.article-kicker').append(topSave, topStatus);
    const saveStatus = document.createElement("p");
    saveStatus.className = "article-save-status";
    saveStatus.setAttribute("aria-live", "polite");
    const archiveKey = window.AM4MatchArchive?.isPublishedMatchEditorial(article)
      ? window.AM4MatchArchive.canonicalMatchKey(article.match)
      : null;
    const archiveLink = archiveKey ? document.createElement("a") : null;
    if (archiveLink) {
      const params = new URLSearchParams({
        article: article.id,
        matchKey: archiveKey,
      });
      const fixtureId = Number(article.match?.fixtureId);
      if (Number.isInteger(fixtureId) && fixtureId > 0) params.set("id", String(fixtureId));
      archiveLink.className = "brand-button article-match-link";
      archiveLink.href = `/match.html?${params}#overview`;
      archiveLink.textContent = "試合アーカイブを開く";
    }

    const body = document.createElement("div");
    body.className = "article-body";
    renderScoreboard(body, article.scoreboard);
    appendBody(body, article);
    renderSources(body, article.sources);
    renderArticleTags(body, article);
    const actions = document.createElement("div");
    actions.className = "article-actions article-footer-actions";
    if (archiveLink) actions.append(archiveLink);
    actions.append(save, saveStatus);
    body.append(actions);
    const related = document.createElement("section");
    related.className = "article-related";
    related.hidden = true;
    body.append(related);
    paper.replaceChildren(header, body);

    function syncFavorite() {
      const selected = AM4Favorites.has(AM4Favorites.read(localStorage), "articles", article.id);
      save.setAttribute("aria-pressed", String(selected));
      save.textContent = selected ? "あとで読むに追加済み" : "あとで読む";
      topSave.setAttribute('aria-pressed', String(selected));
      topSave.setAttribute('aria-label', selected ? 'あとで読むから解除' : 'あとで読むに追加');
      topSave.querySelector('span').textContent = selected ? '追加済み' : 'あとで読む';
    }
    const toggleFavorite = () => {
      const saved = AM4Favorites.toggleWithItem(localStorage, "articles", article.id, {
        label: article.title || "AM4記事",
        detail: articleTypeLabel(article.type),
        href: savedHref,
      });
      if (!saved) {
        saveStatus.textContent = "この端末に保存できませんでした。ブラウザーの保存容量または設定を確認してください。";
        topStatus.textContent = saveStatus.textContent;
        return;
      }
      saveStatus.textContent = "";
      topStatus.textContent = '';
      syncFavorite();
      document.dispatchEvent(new CustomEvent("am4:favorites-changed"));
    };
    save.addEventListener('click', toggleFavorite);
    topSave.addEventListener('click', toggleFavorite);
    window.addEventListener?.('pageshow', syncFavorite);
    window.addEventListener?.('storage', syncFavorite);
    syncFavorite();
    // Enhancements are isolated from the successful article load. No optional
    // TOC/link/series failure may turn readable content into an error screen.
    try {
      window.AM4ArticleReading?.enhanceArticle(body, {
        cleanText: article.type === "match_report"
          ? (value) => window.AM4ArticlePresentation?.readerEditorialText?.(value) ?? value
          : (value) => value,
      });
      if (articleBack && !fromColumn && window.AM4ColumnSeries?.isTwentySeasonsStory(article)) {
        const season = window.AM4ColumnSeries.seasonForStory(article);
        articleBack.href = `/column/20-seasons${season ? `#season-${season}` : ""}`;
        articleBack.textContent = "← 20 Seasonsの一覧へ戻る";
      }
    } catch (_error) { /* The original article remains readable. */ }
    renderRecommendedArticles(article, related);
  }

  function renderMissing() {
    paper.innerHTML = '<div class="article-state"><h1>記事が見つかりません</h1><p>URLを確認するか、ホームから別の記事を選んでください。</p><a class="brand-button" href="/">ホームへ戻る</a></div>';
    document.title = "記事が見つかりません｜AM4 Football";
  }

  function renderUnavailable() {
    paper.innerHTML = '<div class="article-state"><h1>記事を取得できませんでした</h1><p>一時的な通信障害の可能性があります。時間をおいてもう一度お試しください。</p><button class="brand-button" type="button">もう一度試す</button></div>';
    paper.querySelector("button").addEventListener("click", loadArticle);
    document.title = "記事を取得できませんでした｜AM4 Football";
  }

  async function loadArticle() {
    if (!id) return renderMissing();
    try {
      const result = await AM4ArticleLoadState.readArticle({fetcher:fetch,apiBase,id,fixtureId});
      if (result.state === 'ready') return renderArticle(result.article);
      return result.state === 'missing' ? renderMissing() : renderUnavailable();
    } catch (error) {
      AM4ArticleLoadState.articleLoadState({ error });
      return renderUnavailable();
    }
  }

  loadArticle();
})();
