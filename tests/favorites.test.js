const test = require("node:test");
const assert = require("node:assert/strict");
const favorites = require("../favorites.js");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function failingStorage(initial = {}) {
  const storage = memoryStorage(initial);
  return {
    ...storage,
    setItem: () => { throw new Error("storage unavailable"); },
  };
}

test("invalid saved data is treated as an empty favourites collection", () => {
  const storage = memoryStorage({ [favorites.STORAGE_KEY]: "not-json" });
  assert.deepEqual(favorites.read(storage), favorites.emptyFavorites());
});

test("toggling a favourite persists it and toggling again removes it", () => {
  const storage = memoryStorage();
  assert.deepEqual(favorites.toggle(storage, "players", "j-hato").players, ["j-hato"]);
  assert.equal(favorites.has(favorites.read(storage), "players", "j-hato"), true);
  assert.deepEqual(favorites.toggle(storage, "players", "j-hato").players, []);
});

test("provider club references remain stable when saved locally", () => {
  const storage = memoryStorage();
  favorites.toggle(storage, "clubs", "team-40");
  assert.deepEqual(favorites.read(storage).clubs, ["team-40"]);
});

test("normalisation removes duplicates and unsupported values", () => {
  assert.deepEqual(
    favorites.normalize({ leagues: ["league-39", "league-39", null], clubs: ["arsenal", "arsenal", null], players: "bad" }),
    { leagues: ["league-39"], clubs: ["arsenal"], players: [], articles: [] },
  );
});

test("league favourites persist separately from club favourites", () => {
  const storage = memoryStorage();
  favorites.toggle(storage, "leagues", "league-39");
  favorites.toggle(storage, "clubs", "team-40");
  assert.deepEqual(favorites.read(storage), {
    leagues: ["league-39"], clubs: ["team-40"], players: [], articles: [],
  });
});

test("a saved league can be removed without discarding its restoration metadata", () => {
  const storage = memoryStorage();
  const league = {
    type: "leagues",
    id: "league-39",
    label: "プレミアリーグ",
    detail: "プレミアリーグの試合を優先表示",
    href: "#fixtures",
  };

  favorites.toggleWithItem(storage, "leagues", league.id, league);
  assert.deepEqual(favorites.read(storage).leagues, ["league-39"]);

  favorites.toggleWithItem(storage, "leagues", league.id, league);
  assert.deepEqual(favorites.read(storage).leagues, []);
  assert.deepEqual(favorites.readCatalog(storage)["leagues:league-39"], league);
});

test("count includes all supported favourite types", () => {
  assert.equal(
    favorites.count({ clubs: ["arsenal"], players: ["j-hato"], articles: ["mainoo"] }),
    3,
  );
});

test("a failed storage write does not report a favourite as saved", () => {
  const storage = failingStorage();
  assert.equal(favorites.toggle(storage, "articles", "saved-story"), null);
  assert.deepEqual(favorites.read(storage), favorites.emptyFavorites());
});

test("saved item metadata is stored independently from the homepage catalog", () => {
  const storage = memoryStorage();
  const item = favorites.remember(storage, {
    type: "articles",
    id: "article-from-detail",
    label: "詳細ページで保存した記事",
    detail: "あとで読む",
    href: "/article.html?id=article-from-detail",
  });

  assert.deepEqual(item, {
    type: "articles",
    id: "article-from-detail",
    label: "詳細ページで保存した記事",
    detail: "あとで読む",
    href: "/article.html?id=article-from-detail",
  });
  assert.deepEqual(favorites.readCatalog(storage), {
    "articles:article-from-detail": item,
  });
});

test("a favourite is not added when its restoration metadata cannot be stored", () => {
  const storage = failingStorage();
  assert.equal(favorites.toggleWithItem(storage, "articles", "story", { label: "Story" }), null);
  assert.deepEqual(favorites.read(storage), favorites.emptyFavorites());
});

test("legacy saved IDs without metadata remain resolvable placeholders", () => {
  const resolved = favorites.resolveSavedItems(
    { leagues: [], clubs: ["team-40"], players: [], articles: ["older-article"] },
    {},
  );

  assert.deepEqual(resolved.map((item) => [item.type, item.id, item.href]), [
    ["clubs", "team-40", "/#fixtures"],
    ["articles", "older-article", "/article.html?id=older-article"],
  ]);
});
