(function () {
  const SAMPLE_ARTICLES = {
    "jorrel-hato-next-step": {
      id: "jorrel-hato-next-step",
      type: "player_intro",
      title: "Jorrel Hato — 静かな18歳が選んだ次の一歩",
      subject: "Jorrel Hato",
      club: "Chelsea",
      publishedAt: "2026-08-15T00:00:00+09:00",
      deck: "数字だけでは見えない決断の背景を、プレースタイルと歩んできた道から読み解く。",
      readTime: "約8分",
      body: [
        { type: "heading", text: "静けさの奥にある速さ" },
        { type: "paragraph", text: "派手な身振りより、次に起きることを先に読む。Hatoの魅力を一言で表すなら、その静かな速さにある。ボールが届く前の立ち位置と、相手の選択肢を一つずつ消していく判断が、プレー全体のリズムをつくる。" },
        { type: "quote", text: "速く走る前に、速く決める。AM4が注目したのは、その一瞬の準備だ。" },
        { type: "heading", text: "新しい環境で問われるもの" },
        { type: "paragraph", text: "新天地では、守備範囲の広さだけでなく、ボール保持時にどこまで試合を前へ動かせるかが問われる。左サイドから中央へ運ぶ選択、逆サイドを使う視野、そして失った直後の戻り。複数の役割をつなぐ力が、次の一歩を決める。" },
        { type: "paragraph", text: "この記事はAM4の記事体験を確認するための編集デモです。公開前には取材・出典確認・事実確認を行い、正式版へ差し替えます。" }
      ],
    },
    "mainoo-old-trafford": {
      id: "mainoo-old-trafford",
      type: "match_report",
      title: "Mainooの劇的弾で Old Traffordが歓喜",
      subject: "Manchester United vs Liverpool",
      publishedAt: "2026-08-15T00:00:00+09:00",
      deck: "終盤に生まれた一撃が、拮抗した90分を決着させた。勝敗の分岐点を読み解く。",
      readTime: "約6分",
      scoreboard: { home: "Manchester United", away: "Liverpool", homeScore: 3, awayScore: 2 },
      body: [
        { type: "heading", text: "試合を変えた中央の一歩" },
        { type: "paragraph", text: "両チームが前へ出る時間と構える時間を繰り返すなか、中央の小さな立ち位置の差が決定的な場面を生んだ。Mainooは受けるために下がるのではなく、相手の視線が外れた瞬間に一列前へ進んだ。" },
        { type: "quote", text: "決勝点は突然ではない。数分前から積み重なった位置取りの先にあった。" },
        { type: "heading", text: "スコア以上に残ったもの" },
        { type: "paragraph", text: "3対2という数字は激しい試合を物語るが、AM4が残したいのは、観客の空気が変わった数秒間だ。奪った直後の縦への判断と、迷わずボックスへ入った動きがスタジアムを一つにした。" },
        { type: "paragraph", text: "この試合解説はレイアウト確認用の編集デモであり、実際の試合結果ではありません。実データの記事は確認済みの結果と出典を伴って公開します。" }
      ],
    },
  };

  const paper = document.getElementById("article-paper");
  const id = new URLSearchParams(location.search).get("id");
  const apiBase = AM4SiteConfig.resolveApiBase(location.hostname);

  function articleTypeLabel(type) {
    return {
      player_intro: "Player Story",
      match_report: "Match Report",
      match_prediction: "Match Preview",
      am4_story: "AM4 Stories",
      transfer_news: "Transfer Wire",
    }[type] || "AM4 Story";
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
      // Known editorial demos remain readable when the archive is unavailable.
    }
    if (SAMPLE_ARTICLES[id]) return renderArticle(SAMPLE_ARTICLES[id], true);
    renderMissing();
  })();
})();
