const test = require("node:test");
const assert = require("node:assert/strict");
const { editorialBlocksWithLocalNumbering, numberedEditorialItems } = require("../editorial-list.js");

test("a serialized Notion list uses semantic local numbering instead of stale page-wide block indexes", () => {
  assert.deepEqual(numberedEditorialItems("35. 最初の要点\n\n36. 次の要点"), ["最初の要点", "次の要点"]);
});

test("a standalone meaningful number is preserved as prose rather than treated as a list", () => {
  assert.equal(numberedEditorialItems("35. 分に決勝点が入った。"), null);
  assert.equal(numberedEditorialItems("保持率は35.36%だった。"), null);
  assert.equal(numberedEditorialItems("35. 35分に決勝点が入った。\n36. 36分にもチャンスがあった。"), null);
});

test("a stale list run is normalized even when editorial prose surrounds it", () => {
  assert.deepEqual(editorialBlocksWithLocalNumbering([
    "この試合の転機は3つある。",
    "",
    "35. 最初の要点",
    "",
    "36. 次の要点",
    "",
    "ここから終盤の管理に入った。",
  ].join("\n")), [
    { type: "paragraph", text: "この試合の転機は3つある。" },
    { type: "ordered-list", items: ["最初の要点", "次の要点"] },
    { type: "paragraph", text: "ここから終盤の管理に入った。" },
  ]);
});
