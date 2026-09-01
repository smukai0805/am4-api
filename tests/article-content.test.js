const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMarkdownBlocks } = require("../article-content.js");

test("stored Markdown becomes safe editorial block types", () => {
  const blocks = parseMarkdownBlocks("## Turning point\n\n> Read the space first.\n\n- One\n- Two\n\nClosing paragraph.");
  assert.deepEqual(blocks, [
    { type: "heading", text: "Turning point" },
    { type: "quote", text: "Read the space first." },
    { type: "list", ordered: false, items: ["One", "Two"] },
    { type: "paragraph", text: "Closing paragraph." },
  ]);
});

test("stored Markdown tables retain headers and rows without HTML", () => {
  assert.deepEqual(parseMarkdownBlocks("| Club | Points |\n| --- | ---: |\n| AM4 | 4 |"), [
    { type: "table", headers: ["Club", "Points"], rows: [["AM4", "4"]] },
  ]);
});

test("Notion ordered list blocks separated by blank lines remain one agenda", () => {
  assert.deepEqual(parseMarkdownBlocks("1. 起点\n\n2. 転機\n\n3. 現在"), [
    { type: "list", ordered: true, items: ["起点", "転機", "現在"] },
  ]);
});
