const test = require("node:test");
const assert = require("node:assert/strict");
const { editorialBlocksWithLocalNumbering, numberedEditorialItems, turningPointBlocks } = require("../editorial-list.js");

test("turning points remove only the duplicated introductory ordinal before a restarted list", () => {
  const value = "1. 早い失点後の反応：攻撃を急がなかった。\n\n2. Havertzの二つの仕事：25分と50分。\n\n3. 決定機の質：xGは2.11-0.35。\n\n4. Rayaの終盤の1セーブ。";
  assert.deepEqual(turningPointBlocks(value), [
    {type:"paragraph",text:"早い失点後の反応：攻撃を急がなかった。"},
    {type:"ordered-list",items:["Havertzの二つの仕事：25分と50分。","決定機の質：xGは2.11-0.35。","Rayaの終盤の1セーブ。"]},
  ]);
  assert.match(editorialBlocksWithLocalNumbering(value)[0].text, /^1\./);
  assert.equal(turningPointBlocks("1. 早い失点後の反応。"), null);
  assert.equal(turningPointBlocks("1.5%の差。"), null);
  assert.equal(turningPointBlocks("1分に失点。"), null);
});

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
