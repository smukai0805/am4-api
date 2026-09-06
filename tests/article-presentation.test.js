const test = require("node:test");
const assert = require("node:assert/strict");
const presentation = require("../article-presentation.js");

test("article dates use Tokyo time and invalid values stay empty", () => {
  assert.equal(
    presentation.formatTokyoDate("2026-09-05T16:30:00.000Z"),
    "2026年9月6日",
  );
  assert.equal(presentation.formatTokyoDate("not-a-date"), "");
  assert.equal(presentation.formatTokyoDate(null), "");
});

test("only an explicitly defined numeric confidence is displayable", () => {
  for (const value of [null, undefined, "", "0", "unknown", Number.NaN, -1, 101]) {
    assert.equal(presentation.normalizeConfidence(value), null, String(value));
  }
  assert.equal(presentation.normalizeConfidence(0), 0);
  assert.equal(presentation.normalizeConfidence(72.4), 72.4);
});

test("card excerpts keep prose and bullets but reject structural table-of-contents text", () => {
  assert.equal(presentation.articleExcerpt("通常の本文です。背景を簡潔に紹介します。"), "通常の本文です。背景を簡潔に紹介します。");
  assert.equal(presentation.articleExcerpt("- 守備の安定\n- 速攻への対応"), "守備の安定 速攻への対応");
  assert.equal(presentation.articleExcerpt("## 目次\n1. 序章\n2. 戦術\n3. 結論"), "");
  assert.equal(presentation.articleExcerpt(""), "");
});
