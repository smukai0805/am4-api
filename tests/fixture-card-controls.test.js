const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const home = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const matchCentre = fs.readFileSync(path.join(__dirname, "..", "match-centre.js"), "utf8");

test("saved league cards provide a real star toggle while fixture rows do not render club toggles", () => {
  assert.match(home, /for-you-favorite-toggle/);
  assert.match(home, /data-favorite-type.*leagues/);
  assert.doesNotMatch(matchCentre, /fixture-favorite-button--team/);
});

test("prediction and report badges stay on one line", () => {
  assert.match(home, /\.fixture-content-badges\{[^}]*flex-wrap:nowrap/);
});
