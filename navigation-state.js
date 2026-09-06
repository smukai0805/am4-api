(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4NavigationState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const MATCH_STATE_KEY = "am4:navigation:match-list:v1";
  const HOME_STATE_KEY = "am4:navigation:home:v1";
  const MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const MATCH_PARAMS = ["matchDate", "matchMode", "matchFilter", "matchStatus"];
  const MODES = new Set(["date", "round"]);
  const STATUSES = new Set(["all", "upcoming", "live", "finished"]);

  function text(value, max = 120) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function dateKey(value) {
    const candidate = text(value, 10);
    const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? candidate
      : "";
  }

  function internalPath(value, fallback) {
    const path = text(value, 800);
    if (path.startsWith("#")) return path;
    return /^\/(?![\\/])/.test(path) && !path.includes("\\") ? path : fallback;
  }

  function normalizeMatchState(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const mode = MODES.has(source.mode) ? source.mode : "date";
    const status = STATUSES.has(source.status) ? source.status : "all";
    const expandedGroups = [...new Set((Array.isArray(source.expandedGroups) ? source.expandedGroups : [])
      .map((group) => text(group, 240))
      .filter(Boolean))].slice(0, 100);
    const scrollY = Number(source.scrollY);
    const savedAt = Number(source.savedAt);
    return {
      date: dateKey(source.date),
      mode,
      filter: text(source.filter, 120),
      status,
      expandedGroups,
      spoilersRevealed: source.spoilersRevealed === true,
      scrollY: Number.isFinite(scrollY) && scrollY > 0 ? Math.round(scrollY) : 0,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
    };
  }

  function parseMatchListUrl(search = "") {
    const params = new URLSearchParams(search);
    if (!MATCH_PARAMS.some((name) => params.has(name))) return null;
    return normalizeMatchState({
      date: params.get("matchDate"),
      mode: params.get("matchMode"),
      filter: params.get("matchFilter"),
      status: params.get("matchStatus"),
    });
  }

  function matchListUrl(href, value) {
    const state = normalizeMatchState(value);
    const base = typeof globalThis?.location?.origin === "string" ? globalThis.location.origin : "https://am4football.invalid";
    const url = new URL(href || "/", base);
    MATCH_PARAMS.forEach((name) => url.searchParams.delete(name));
    if (state.date) url.searchParams.set("matchDate", state.date);
    if (state.mode !== "date") url.searchParams.set("matchMode", state.mode);
    if (state.filter) url.searchParams.set("matchFilter", state.filter);
    if (state.status !== "all") url.searchParams.set("matchStatus", state.status);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function readRecord(storage, key, now = Date.now()) {
    try {
      const value = JSON.parse(storage?.getItem(key) || "null");
      if (!value || typeof value !== "object") return null;
      const savedAt = Number(value.savedAt);
      if (!Number.isFinite(savedAt) || savedAt <= 0 || now - savedAt > MAX_AGE_MS) return null;
      return value;
    } catch (_error) {
      return null;
    }
  }

  function writeRecord(storage, key, value, now = Date.now()) {
    const record = { ...value, savedAt: now };
    try {
      storage?.setItem(key, JSON.stringify(record));
      return record;
    } catch (_error) {
      return null;
    }
  }

  function readMatchListState({ search = "", storage, now = Date.now() } = {}) {
    const urlState = parseMatchListUrl(search);
    // A bare home URL is intentionally a fresh entry point. Device-only state
    // may augment an explicit shared selection, but must not choose a stale
    // date, mode, filter, or scroll position on the visitor's behalf.
    if (!urlState) return null;
    const stored = readRecord(storage, MATCH_STATE_KEY, now);
    const storedState = normalizeMatchState(stored || {});
    const sameSelection = storedState.date === urlState.date
      && storedState.mode === urlState.mode
      && storedState.filter === urlState.filter
      && storedState.status === urlState.status;
    return normalizeMatchState({
      ...urlState,
      ...(sameSelection ? {
        expandedGroups: storedState.expandedGroups,
        spoilersRevealed: storedState.spoilersRevealed,
        scrollY: storedState.scrollY,
      } : {}),
    });
  }

  function writeMatchListState(storage, value, now = Date.now()) {
    return writeRecord(storage, MATCH_STATE_KEY, {
      ...normalizeMatchState(value),
      returnUrl: internalPath(value?.returnUrl, "/#fixtures"),
    }, now);
  }

  function readMatchReturnUrl(storage, fallback = "/#fixtures", now = Date.now()) {
    const record = readRecord(storage, MATCH_STATE_KEY, now);
    return internalPath(record?.returnUrl, fallback);
  }

  function writeHomeState(storage, { returnUrl, scrollY = 0 } = {}, now = Date.now()) {
    return writeRecord(storage, HOME_STATE_KEY, {
      returnUrl: internalPath(returnUrl, "/"),
      scrollY: Number.isFinite(Number(scrollY)) && Number(scrollY) > 0 ? Math.round(Number(scrollY)) : 0,
    }, now);
  }

  function readHomeState(storage, now = Date.now()) {
    const record = readRecord(storage, HOME_STATE_KEY, now);
    if (!record) return null;
    return {
      returnUrl: internalPath(record.returnUrl, "/"),
      scrollY: Number.isFinite(Number(record.scrollY)) && Number(record.scrollY) > 0 ? Math.round(Number(record.scrollY)) : 0,
    };
  }

  return {
    MATCH_STATE_KEY,
    HOME_STATE_KEY,
    MAX_AGE_MS,
    normalizeMatchState,
    parseMatchListUrl,
    matchListUrl,
    readMatchListState,
    writeMatchListState,
    readMatchReturnUrl,
    writeHomeState,
    readHomeState,
  };
});
