const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const brand = fs.readFileSync(path.join(__dirname, '..', 'brand.css'), 'utf8');
const seriesPage = fs.readFileSync(path.join(__dirname, '..', 'column-series-page.js'), 'utf8');

test('home content stays visible when its optional reveal scripting cannot run', () => {
  assert.doesNotMatch(home, /\.reveal\{|\sreveal(?=[\s"])/);
  assert.doesNotMatch(home, /column-stagger|AM4ObserveColumnReveals/);
  assert.doesNotMatch(home, /opacity:0;\s*transform:translateY\((?:18|20)px\)/);
});

test('reduced motion styling remains an explicit progressive enhancement', () => {
  assert.match(home, /@media \(prefers-reduced-motion:reduce\)/);
});

test('20 Seasons cards are not hidden behind an optional reveal observer', () => {
  assert.doesNotMatch(brand, /\.twenty-season-reveal\{opacity:0/);
  assert.doesNotMatch(seriesPage, /twenty-season-reveal|observeReveals/);
});
