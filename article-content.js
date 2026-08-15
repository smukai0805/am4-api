(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4ArticleContent = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function tableCells(line) {
    return String(line).trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  }

  function isTableDivider(line) {
    const cells = tableCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function parseMarkdownBlocks(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line || /^-{3,}$/.test(line)) { index += 1; continue; }

      if (line.includes("|") && isTableDivider(lines[index + 1] || "")) {
        const headers = tableCells(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(tableCells(lines[index]));
          index += 1;
        }
        blocks.push({ type: "table", headers, rows });
        continue;
      }

      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        blocks.push({ type: "heading", text: heading[1].trim() });
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
          quote.push(lines[index].trim().replace(/^>\s?/, ""));
          index += 1;
        }
        blocks.push({ type: "quote", text: quote.join(" ") });
        continue;
      }

      const listItem = line.match(/^(?:([-*+])|(\d+)[.)])\s+(.+)$/);
      if (listItem) {
        const ordered = Boolean(listItem[2]);
        const items = [];
        while (index < lines.length) {
          const match = lines[index].trim().match(/^(?:([-*+])|(\d+)[.)])\s+(.+)$/);
          if (!match || Boolean(match[2]) !== ordered) break;
          items.push(match[3].trim());
          index += 1;
        }
        blocks.push({ type: "list", ordered, items });
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].trim();
        if (!next || /^#{1,6}\s+/.test(next) || /^>\s?/.test(next) || /^(?:[-*+]|\d+[.)])\s+/.test(next) ||
          (next.includes("|") && isTableDivider(lines[index + 1] || ""))) break;
        paragraph.push(next);
        index += 1;
      }
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    }
    return blocks;
  }

  return { parseMarkdownBlocks };
});
