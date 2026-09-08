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

test("prediction and report badges remain individually compact", () => {
  assert.match(home, /\.fixture-content-badge\{[^}]*white-space:nowrap/);
});

test("a concealed score reveals in place without opening the match detail", () => {
  assert.match(home, /\.fixture-scoreboard--result-control\{[^}]*pointer-events:auto/);
  assert.match(matchCentre, /scoreCaption\.textContent = "タップしたら試合結果を表示"/);
  assert.match(matchCentre, /scoreboard\.addEventListener\("click", \(event\) => \{/);
  assert.match(matchCentre, /event\.stopPropagation\(\);/);
  assert.match(matchCentre, /revealedFixtureResults\.add\(fixtureRevealKey\);/);
  assert.match(matchCentre, /scoreValue\.replaceChildren\(\);/);
  assert.match(matchCentre, /scoreDisplayParts\(fullScores\.home, fullScores\.away, false\)/);
  assert.match(matchCentre, /revealedFixtureResults\.delete\(fixtureRevealKey\);/);
  assert.match(matchCentre, /if \(!spoilersRevealed\) revealedFixtureResults\.clear\(\);/);
});

test("primary navigation and selected date stay available while fixtures scroll", () => {
  const primaryNavigation = fs.readFileSync(path.join(__dirname, "..", "primary-navigation.css"), "utf8");
  assert.match(primaryNavigation, /\.primary-navigation-page \.topbar,[\s\S]*?position:sticky/);
  assert.match(primaryNavigation, /\.primary-tabbar\{[^}]*position:sticky/);
  assert.match(home, /\.matchday-dates-sticky\{[^}]*position:sticky/);
  assert.match(home, /\.matchday-home\{[^}]*overflow:visible/);
  assert.match(home, /\.matchday-board\{[^}]*overflow:visible/);
});
