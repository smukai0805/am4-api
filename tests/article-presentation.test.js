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

test("flattened consecutive agenda items are not displayed as a card introduction", () => {
  assert.equal(presentation.articleExcerpt("なぜ約50キロ離れた2クラブが宿敵になったのか 7. サッカー以前から始まった対抗意識 8. 1890年代の転機 9. 現代への道"), "");
  assert.equal(presentation.articleExcerpt("3行でわかるバロンドール 3. 1956年｜誕生 4. 初代受賞者の物語"), "");
  assert.equal(presentation.articleExcerpt("1. 守備が安定した。 2. 速攻が機能した。"), "守備が安定した。 2. 速攻が機能した。");
  assert.equal(presentation.articleExcerpt("2025. 進化するチームと、その理由。"), "進化するチームと、その理由。");
});

test("truncated live series excerpts and agenda-to-prose tails stay off cards", () => {
  assert.equal(presentation.articleExcerpt("前年14位のチームに、なぜ優勝の芽があったのか 7. 保持率42%台でも勝てた理由 8. ヴァーディ、マフレズ、カンテと支える選手たち 9. タイトル争いを本物にした3試合 10. 優勝が決まった夜 11. 同じ年の欧州 12. レスター..."), "");
  assert.equal(presentation.articleExcerpt("無冠の翌夏 7. スアレス加入とMSN 8. 縦への速さ 9. 春の欧州 10. 完成した三冠 11. 2014-15が残したもの 2014年夏、バルセロナは再出発した。"), "");
  assert.equal(presentation.articleExcerpt("目次 1. 序章 2. 戦術…"), "");
  const prose = "守備が安定した。 1. 回収 2. 前進 3. 決定力";
  assert.equal(presentation.articleExcerpt(prose), prose);
});

test("only the observed obsolete MOTM instruction is omitted, not player analysis or uncertainty", () => {
  const note = "MOTM / POTM：公式または信頼できる統一選出を確認できず。推測で設定しない。";
  assert.equal(presentation.readerEditorialText(`${note} Martín Satriano：21分に先制点。`), "Martín Satriano：21分に先制点。");
  assert.equal(presentation.readerEditorialText("負傷からの復帰日は確認できず。"), "負傷からの復帰日は確認できず。");
  assert.equal(presentation.readerEditorialText("AM4選出MOTM：Satriano。"), "AM4選出MOTM：Satriano。");
});
