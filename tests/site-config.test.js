const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveApiBase } = require("../site-config.js");

test("local previews use the public adapter while deployments stay same-origin", () => {
  assert.equal(resolveApiBase("localhost"), "https://am4-api.vercel.app/api");
  assert.equal(resolveApiBase("preview.example"), "/api");
});
