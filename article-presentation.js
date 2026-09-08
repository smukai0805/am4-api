(function (root, factory) {
  const motmTextPolicy = typeof module === "object" && module.exports
    ? require("./motm-text-policy.js")
    : root?.AM4MotmTextPolicy;
  const api = factory(motmTextPolicy);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4ArticlePresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function (motmTextPolicy) {
  function compact(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  function formatTokyoDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
      return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日`;
    } catch (_error) {
      return "";
    }
  }

  function normalizeConfidence(value) {
    // Notion's number property distinguishes null from the explicit numeric
    // value 0. Do not coerce null/empty strings through Number(), otherwise an
    // unknown value becomes a made-up 0% confidence.
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value < 0 || value > 100) return null;
    return value;
  }

  function normalizedLines(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function lineContent(line) {
    return compact(String(line || "")
      .replace(/^>\s?/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\*\*/g, ""));
  }

  function isNavigationExcerpt(lines) {
    if (!lines.length) return false;
    const first = lineContent(lines[0]).toLocaleLowerCase("en-US");
    const listed = lines.filter((line) => /^(?:[-*+]|\d+[.)])\s+/.test(line));
    const numbered = lines.filter((line) => /^\d+[.)]\s+/.test(line));
    const heading = /^(?:目次|contents?|table\s+of\s+contents|agenda|アジェンダ|出典|sources?|references?)(?:$|\s|[:：])/u.test(first);
    // A label alone is not enough: only structural heading + a list is treated
    // as a contents/source block. This keeps ordinary prose mentioning an
    // agenda from being discarded.
    if (heading && listed.length >= 2) return true;
    // Notion's list index can already have flattened an agenda into one line.
    // Require consecutive item numbers and heading-like (not sentence) text.
    const flat = compact(lines.join(" "));
    const markers = [...flat.matchAll(/(?:^|\s)(\d{1,2})[.)]\s+/g)];
    if (markers.length >= 2 && markers.every((marker, index) =>
      !index || Number(marker[1]) === Number(markers[index - 1][1]) + 1)) {
      const items = markers.map((marker, index) => flat.slice(
        marker.index + marker[0].length, markers[index + 1]?.index ?? flat.length,
      ));
      const isHeadingText = (value) => {
        const text = value.trim().replace(/\.{3,}$/, "");
        return Boolean(text) && !/[。！？]|[.!?](?:\s|$)/u.test(text);
      };
      const prefix = flat.slice(0, markers[0].index).trim();
      // The final item may be truncated with "...", or run into the opening
      // prose. Two complete heading entries still identify the agenda. Never
      // discard an ordinary introductory sentence followed by numbered points.
      const completeItems = items.slice(0, -1);
      if ((!prefix || isHeadingText(prefix)) && (items.every(isHeadingText) ||
        (completeItems.length >= 2 && completeItems.every(isHeadingText)))) return true;
    }
    // A sequence of two or more numbered entries without explanatory prose is
    // also navigation, even when a Notion source omitted the heading.
    return numbered.length >= 2 && numbered.length === lines.length;
  }

  function articleExcerpt(value, limit = 150) {
    const lines = normalizedLines(value);
    if (isNavigationExcerpt(lines)) return "";
    const text = compact(lines
      .filter((line) => !/^#{1,6}\s+/.test(line))
      .map(lineContent)
      .filter(Boolean)
      .join(" "));
    if (!text) return "";
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 150;
    return text.length <= safeLimit ? text : `${text.slice(0, Math.max(1, safeLimit - 1)).trimEnd()}…`;
  }

  function withoutMotmAbstention(value) {
    return motmTextPolicy?.withoutAbstention?.(value) ?? String(value || "").trim();
  }

  function readerEditorialText(value) {
    return withoutMotmAbstention(value);
  }

  return { compact, formatTokyoDate, normalizeConfidence, normalizedLines, isNavigationExcerpt, articleExcerpt, readerEditorialText, withoutMotmAbstention };
});
