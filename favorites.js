(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4Favorites = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const STORAGE_KEY = "am4:favorites:v1";
  const TYPES = ["clubs", "players", "articles"];

  function emptyFavorites() {
    return { clubs: [], players: [], articles: [] };
  }

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    return TYPES.reduce((result, type) => {
      result[type] = Array.isArray(source[type])
        ? [...new Set(source[type].filter((id) => typeof id === "string" && id.trim()))]
        : [];
      return result;
    }, emptyFavorites());
  }

  function read(storage) {
    try {
      return normalize(JSON.parse(storage.getItem(STORAGE_KEY) || "null"));
    } catch (_error) {
      return emptyFavorites();
    }
  }

  function write(storage, favorites) {
    const clean = normalize(favorites);
    storage.setItem(STORAGE_KEY, JSON.stringify(clean));
    return clean;
  }

  function toggle(storage, type, id) {
    if (!TYPES.includes(type)) throw new Error(`Unknown favorite type: ${type}`);
    const favorites = read(storage);
    const exists = favorites[type].includes(id);
    favorites[type] = exists
      ? favorites[type].filter((current) => current !== id)
      : [...favorites[type], id];
    return write(storage, favorites);
  }

  function has(favorites, type, id) {
    return Boolean(favorites[type] && favorites[type].includes(id));
  }

  function count(favorites) {
    return TYPES.reduce((total, type) => total + favorites[type].length, 0);
  }

  return { STORAGE_KEY, emptyFavorites, normalize, read, write, toggle, has, count };
});

