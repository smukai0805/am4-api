(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MotmTextPolicy = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function withoutAbstention(value) {
    return String(value || "").replace(
      /(?:^|\n|(?<=。))(?:(?:この試合で)?公式[^。\n]*(?:MOTM|POTM)|MOTM\s*[／/]\s*POTM)[^。\n]*(?:確認できず|確認できなかった|設定しない|記載しない|見つからなかった|見つからない|選出は行わない)[^。\n]*。[ \t]*(?:推測(?:では|で)?設定しない。)?/giu,
      "",
    ).trim();
  }

  function hasPositiveSelection(value) {
    return String(value || "").split(/\n|。/u).some((line) =>
      /MOTM|POTM|MVP|(?:Man|Player) of the Match/iu.test(line)
      && !/未|確認でき|設定しない|記載しない|見つから|不明|なし|候補|not |unknown|unavailable|unconfirmed/iu.test(line));
  }

  function am4SelectionParagraph(mom) {
    const name = String(mom?.name || "").trim();
    if (!name || name.length > 80 || !/^[\p{L}\p{M} .’'\-・]+$/u.test(name)) return "";
    const rating = Number(mom?.rating);
    const basis = Number.isFinite(rating) && rating >= 1 && rating <= 10
      ? `API-FOOTBALLの評価点${rating.toFixed(1)}を基に選出。`
      : "試合への貢献を基に選出。";
    return `AM4選出MOTM：${name}。${basis}`;
  }

  return { withoutAbstention, hasPositiveSelection, am4SelectionParagraph };
});
