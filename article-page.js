(function () {

  const paper = document.getElementById("article-paper");
  const id = new URLSearchParams(location.search).get("id");
  const apiBase = AM4SiteConfig.resolveApiBase(location.hostname);

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
    if (!value) return "公開日未設定";
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
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
    save.textContent = "記事を保存";

    const body = document.createElement("div");
    body.className = "article-body";
    renderScoreboard(body, article.scoreboard);
    appendBody(body, article);
    renderSources(body, article.sources);
    renderArticleTags(body, article);
    const actions = document.createElement("div");
    actions.className = "article-actions article-footer-actions";
    actions.append(save);
    body.append(actions);
    const related = document.createElement("section");
    related.className = "article-related";
    related.hidden = true;
    body.append(related);
    paper.replaceChildren(header, body);

    function syncFavorite() {
      const selected = AM4Favorites.has(AM4Favorites.read(localStorage), "articles", article.id);
      save.setAttribute("aria-pressed", String(selected));
      save.textContent = selected ? "記事を保存済み" : "記事を保存";
    }
    save.addEventListener("click", () => { AM4Favorites.toggle(localStorage, "articles", article.id); syncFavorite(); });
    syncFavorite();
    renderRecommendedArticles(article, related);
  }

  function renderMissing() {
    paper.innerHTML = '<div class="article-state"><h1>記事が見つかりません</h1><p>URLを確認するか、ホームから別の記事を選んでください。</p><a class="brand-button" href="/">ホームへ戻る</a></div>';
    document.title = "記事が見つかりません｜AM4 Football";
  }

  (async function loadArticle() {
    if (!id) return renderMissing();
    try {
      const response = await fetch(`${apiBase}/articles?id=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        if (data.article) return renderArticle(data.article);
      }
    } catch (_error) {
      // Article data is published only from the server-side archive.
    }
    renderMissing();
  })();
})();
