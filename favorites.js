(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4Favorites = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const STORAGE_KEY = "am4:favorites:v1";
  const CATALOG_STORAGE_KEY = "am4:favorites:catalog:v1";
  // Leagues and clubs are stored independently so the same lightweight local
  // preference can later map directly onto account-level favourite entities.
  const TYPES = ["leagues", "clubs", "players", "articles"];

  function emptyFavorites() {
    return { leagues: [], clubs: [], players: [], articles: [] };
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

  function storedText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function internalHref(value, fallback) {
    const href = storedText(value);
    if (!href) return fallback;
    if (href.startsWith("/") || href.startsWith("#")) return href;
    return fallback;
  }

  function defaultSavedItem(type, id) {
    const labels = {
      leagues: "保存したリーグ",
      clubs: "保存したクラブ",
      players: "保存した選手",
      articles: "保存した記事",
    };
    const details = {
      leagues: "試合一覧で確認",
      clubs: "チーム詳細を確認",
      players: "選手詳細を確認",
      articles: "記事の公開状況を確認",
    };
    const teamId = type === "clubs" ? String(id || "").match(/^team-([1-9]\d*)$/)?.[1] : null;
    const playerId = type === "players" && /^[1-9]\d*$/.test(String(id || "")) ? String(id) : null;
    const href = type === "articles"
      ? `/article.html?id=${encodeURIComponent(id)}`
      : teamId ? `/teams/${teamId}`
        : playerId ? `/players/${playerId}`
          : "/#fixtures";
    return { type, id, label: labels[type] || "保存済み", detail: details[type] || "保存済み", href };
  }

  function normalizeCatalogItem(value, key = "") {
    const source = value && typeof value === "object" ? value : {};
    const [keyType, ...keyId] = String(key).split(":");
    const type = TYPES.includes(source.type) ? source.type : TYPES.includes(keyType) ? keyType : null;
    const id = storedText(source.id) || keyId.join(":").trim();
    if (!type || !id) return null;
    const fallback = defaultSavedItem(type, id);
    const storedHref = internalHref(source.href, fallback.href);
    // Upgrade only the old generic match-list destination for a now verified
    // numeric team/player ID. Explicit custom destinations remain untouched.
    const href = ["/#fixtures", "#fixtures"].includes(storedHref) && fallback.href !== "/#fixtures"
      ? fallback.href
      : storedHref;
    return {
      type,
      id,
      label: storedText(source.label) || fallback.label,
      detail: storedText(source.detail) || fallback.detail,
      href,
    };
  }

  function normalizeCatalog(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.entries(source).reduce((result, [key, item]) => {
      const clean = normalizeCatalogItem(item, key);
      if (clean) result[`${clean.type}:${clean.id}`] = clean;
      return result;
    }, {});
  }

  function readCatalog(storage) {
    try {
      return normalizeCatalog(JSON.parse(storage.getItem(CATALOG_STORAGE_KEY) || "null"));
    } catch (_error) {
      return {};
    }
  }

  function writeCatalog(storage, catalog) {
    const clean = normalizeCatalog(catalog);
    try {
      storage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(clean));
      return clean;
    } catch (_error) {
      return null;
    }
  }

  function remember(storage, item) {
    const clean = normalizeCatalogItem(item);
    if (!clean) return null;
    const catalog = readCatalog(storage);
    catalog[`${clean.type}:${clean.id}`] = clean;
    const saved = writeCatalog(storage, catalog);
    return saved ? clean : null;
  }

  function resolveSavedItems(favorites, catalog) {
    const saved = normalize(favorites);
    const known = normalizeCatalog(catalog);
    return TYPES.flatMap((type) => saved[type].map((id) => (
      known[`${type}:${id}`] || defaultSavedItem(type, id)
    )));
  }

  function write(storage, favorites) {
    const clean = normalize(favorites);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(clean));
      return clean;
    } catch (_error) {
      return null;
    }
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

  function toggleWithItem(storage, type, id, item) {
    if (!TYPES.includes(type)) throw new Error(`Unknown favorite type: ${type}`);
    const favorites = read(storage);
    const exists = favorites[type].includes(id);
    if (!exists && item && !remember(storage, { ...item, type, id })) return null;
    favorites[type] = exists
      ? favorites[type].filter((current) => current !== id)
      : [...favorites[type], id];
    return write(storage, favorites);
  }

  function has(favorites, type, id) {
    return Boolean(favorites[type] && favorites[type].includes(id));
  }

  function count(favorites) {
    return TYPES.reduce((total, type) => total + (Array.isArray(favorites?.[type]) ? favorites[type].length : 0), 0);
  }

  return {
    STORAGE_KEY,
    CATALOG_STORAGE_KEY,
    emptyFavorites,
    normalize,
    read,
    write,
    toggle,
    toggleWithItem,
    has,
    count,
    normalizeCatalog,
    readCatalog,
    writeCatalog,
    remember,
    resolveSavedItems,
  };
});
