const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const home = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const matchCentre = fs.readFileSync(path.join(__dirname, "..", "match-centre.js"), "utf8");

test("saved league cards provide a real star toggle while fixture rows do not render club toggles", () => {
  assert.match(home, /for-you-favorite-toggle/);
  assert.match(home, /data-favorite-type.*leagues/);
  assert.match(home, /document\.createElement\(item\.type === 'leagues' \? 'div' : 'a'\)/);
  assert.match(home, /event\.preventDefault\(\);/);
  assert.match(home, /event\.stopPropagation\(\);/);
  assert.doesNotMatch(matchCentre, /fixture-favorite-button--team/);
});

test("prediction and report badges stay on one line", () => {
  assert.match(home, /\.fixture-content-badges\{[^}]*flex-wrap:nowrap/);
});

test("primary navigation and selected date stay available while fixtures scroll", () => {
  assert.match(home, /\.topbar\{[^}]*position:fixed/);
  assert.match(home, /\.tagnav-wrap\{[^}]*position:fixed/);
  assert.match(home, /\.matchday-dates\{[^}]*position:sticky/);
});
