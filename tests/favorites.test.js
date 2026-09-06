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

test("count includes all supported favourite types", () => {
  assert.equal(
    favorites.count({ clubs: ["arsenal"], players: ["j-hato"], articles: ["mainoo"] }),
    3,
  );
});
