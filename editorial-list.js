(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4EditorialList = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function isMeaningfulNumericText(value) {
    return /^(?:\d+\s*(?:['′]|分)|(?:minute|min)\b|\d+\s*[-–:]\s*\d+|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d+(?:\.\d+)?\s*%)/iu.test(value);
  }

  function legacyOrdinalRun(lines, start) {
    const matches = [];
    let index = start;
    while (index < lines.length) {
      if (!lines[index].trim()) {
        index += 1;
        continue;
      }
      const match = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
      if (!match) break;
      matches.push({ number: Number(match[1]), text: match[2].trim() });
      index += 1;
    }
    if (matches.length < 2 || matches[0].number <= 1) return null;
    if (!matches.every((item, offset) => item.number === matches[0].number + offset)) return null;
    if (matches.some((item) => isMeaningfulNumericText(item.text))) return null;
    return { end: index, items: matches.map((item) => item.text) };
  }

  // Old archive records can contain Notion's page-wide block ordinal. Convert
  // each unambiguous non-one consecutive run into a semantic local list while
  // preserving surrounding prose and meaningful match numbers verbatim.
  function editorialBlocksWithLocalNumbering(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    const prose = [];
    let changed = false;
    const flushProse = () => {
      const text = prose.join("\n").trim();
      if (text) blocks.push({ type: "paragraph", text });
      prose.length = 0;
    };

    for (let index = 0; index < lines.length;) {
      const run = legacyOrdinalRun(lines, index);
      if (!run) {
        prose.push(lines[index]);
        index += 1;
        continue;
      }
      flushProse();
      blocks.push({ type: "ordered-list", items: run.items });
      changed = true;
      index = run.end;
    }
    flushProse();
    return changed ? blocks : null;
  }

  function numberedEditorialItems(value) {
    const blocks = editorialBlocksWithLocalNumbering(value);
    return blocks?.length === 1 && blocks[0].type === "ordered-list" ? blocks[0].items : null;
  }

  function turningPointBlocks(value) {
    const blocks = editorialBlocksWithLocalNumbering(value);
    // A legacy 2/3/4 run is already restarted at 1 below its introductory
    // paragraph. Only remove the duplicated leading 1 in that exact layout.
    if (blocks?.[0]?.type === "paragraph" && blocks[1]?.type === "ordered-list") {
      blocks[0].text = blocks[0].text.replace(/^1[.)]\s+(?=\S)/u, "");
    }
    return blocks;
  }

  return { editorialBlocksWithLocalNumbering, numberedEditorialItems, turningPointBlocks };
});
