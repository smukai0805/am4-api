(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4MatchReportPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const nameKey = value => String(value || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ø/g, "o")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function selectedMotm(value, players = []) {
    // Presentation of an explicit editorial selection, never an inferred award.
    const selection = String(value || "").match(/^\s*(?:Man of the Match|Player of the Match|MOTM|POTM|AM4\s*MOTM)\s*[：:]\s*([^（(\n。:：]+)/iu);
    const name = selection?.[1]?.trim();
    if (!name || name.length > 80 || !/^[\p{L}\p{M} .’'\-・]+$/u.test(name)
      || /未|確認|選出|なし|不明|候補|該当|推測|unknown|none|unavailable|not\s|pending|unconfirmed|tbc|tbd/iu.test(name)) return null;
    const wanted = nameKey(name);
    const wantedParts = wanted.split(" ");
    const matches = new Map();
    for (const entry of players) {
      const player = entry?.player || entry;
      const id = Number(player?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const candidate = nameKey(player.name);
      const parts = candidate.split(" ");
      const exact = candidate === wanted;
      // Accept M. Ødegaard for Martin Ødegaard, but not a different first name
      // or an ambiguous surname shared by two participants.
      const abbreviated = parts.length === wantedParts.length && parts.length > 1
        && parts.every((part, index) => part === wantedParts[index]
          || (index < parts.length - 1 && part.length === 1 && wantedParts[index].startsWith(part)));
      const surnameOnly = parts.length === 1 && wantedParts.length > 1 && candidate === wantedParts.at(-1);
      if (exact || abbreviated || surnameOnly) matches.set(id, { ...player, id });
    }
    return { name, player: matches.size === 1 ? [...matches.values()][0] : null };
  }

  return { selectedMotm };
});
