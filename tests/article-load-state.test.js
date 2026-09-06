const test = require("node:test");
const assert = require("node:assert/strict");
const { articleLoadState } = require("../article-load-state.js");

test("article loading distinguishes a missing article from temporary failures", () => {
  assert.equal(articleLoadState({ status: 404, hasArticle: false }), "missing");
  assert.equal(articleLoadState({ status: 500, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ status: 503, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ error: new TypeError("network") }), "unavailable");
  assert.equal(articleLoadState({ status: 200, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ status: 200, hasArticle: true }), "ready");
});
