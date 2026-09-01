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

  function renderArticle(article, isSample) {
    document.title = `${article.title}｜AM4`;
    const header = document.createElement("header");
    header.className = "article-header";
    header.innerHTML = '<div class="article-kicker"><span></span><span></span></div><h1 class="article-title"></h1><p class="article-deck"></p><div class="article-meta"></div><div class="article-actions"></div>';
    header.querySelector(".article-kicker span:first-child").textContent = articleTypeLabel(article.type);
    header.querySelector(".article-kicker span:last-child").textContent = isSample ? "AM4 Editorial Demo" : "AM4 Archive";
    header.querySelector(".article-title").textContent = article.title;
    const deck = header.querySelector(".article-deck");
    deck.textContent = article.deck || article.summary || "AM4が届ける、スコアの先にある物語。";
    const meta = header.querySelector(".article-meta");
    const published = article.publishedAt ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }).format(new Date(article.publishedAt)) : "公開日未設定";
    meta.textContent = `${published} · ${article.readTime || "AM4編集部"}`;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "favorite-btn";
    save.dataset.favoriteType = "articles";
    save.dataset.favoriteId = article.id;
    save.textContent = "記事を保存";
    header.querySelector(".article-actions").append(save);

    const body = document.createElement("div");
    body.className = "article-body";
    renderScoreboard(body, article.scoreboard);
    appendBody(body, article);
    renderSources(body, article.sources);
    paper.replaceChildren(header, body);

    function syncFavorite() {
      const selected = AM4Favorites.has(AM4Favorites.read(localStorage), "articles", article.id);
      save.setAttribute("aria-pressed", String(selected));
      save.textContent = selected ? "記事を保存済み" : "記事を保存";
    }
    save.addEventListener("click", () => { AM4Favorites.toggle(localStorage, "articles", article.id); syncFavorite(); });
    syncFavorite();
  }

  function renderMissing() {
    paper.innerHTML = '<div class="article-state"><h1>記事が見つかりません</h1><p>URLを確認するか、ホームから別の記事を選んでください。</p><a class="brand-button" href="/">ホームへ戻る</a></div>';
    document.title = "記事が見つかりません｜AM4";
  }

  (async function loadArticle() {
    if (!id) return renderMissing();
    try {
      const response = await fetch(`${apiBase}/articles?id=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        if (data.article) return renderArticle(data.article, false);
      }
    } catch (_error) {
      // Article data is published only from the server-side archive.
    }
    renderMissing();
  })();
})();
