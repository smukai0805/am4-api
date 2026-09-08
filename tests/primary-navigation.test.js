const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pages = [
  ['index.html', 'tagnav', null],
  ['column.html', 'column-index-nav', 'COLUMN'],
  ['column-20-seasons.html', 'twenty-seasons-nav', '20 Seasons'],
  ['read-later.html', 'column-index-nav', 'あとで読む'],
];
const expected = [
  ['試合', '/#fixtures'],
  ['COLUMN', '/column'],
  ['20 Seasons', '/column/20-seasons'],
  ['あとで読む', '/read-later'],
];

function navigation(file, className) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const nav = html.match(new RegExp(`<nav class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</nav>`));
  assert.ok(nav, `${file} has its primary navigation`);
  return [...nav[1].matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)].map(([,attributes,label]) => ({
    label: label.trim(),
    href: attributes.match(/href="([^"]+)"/)?.[1],
    current: /aria-current="(?:page|location)"/.test(attributes),
  }));
}

function destination(href) {
  return href === '#fixtures' ? '/#fixtures' : href;
}

test('every primary navigation keeps the same four labels, order and destinations', () => {
  for (const [file, className] of pages) {
    assert.deepEqual(navigation(file,className).map(({label,href})=>[label,destination(href)]), expected, file);
  }
});

test('standalone destinations mark only their own tab as current', () => {
  for (const [file,className,current] of pages.filter(page=>page[2])) {
    const tabs=navigation(file,className);
    assert.deepEqual(tabs.filter(tab=>tab.current).map(tab=>tab.label),[current],file);
  }
});

test('all four pages use one bar component and one stylesheet', () => {
  for (const [file] of pages) {
    const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    assert.match(html,/class="[^"]*primary-navigation-page/);
    assert.match(html,/<nav class="[^"]*primary-tabbar/);
    assert.match(html,/href="\/primary-navigation\.css\?v=20260908-primary-navigation-v1"/);
  }
});

test('the shared bar fixes identical position, spacing, mobile sizing and focus across pages', () => {
  const css=fs.readFileSync(path.join(__dirname,'..','primary-navigation.css'),'utf8');
  assert.match(css,/--am4-topbar-height:76px/);
  assert.match(css,/--am4-primary-nav-height:65px/);
  assert.match(css,/\.primary-tabbar\{[^}]*top:var\(--am4-topbar-height\)[^}]*height:var\(--am4-primary-nav-height\)[^}]*gap:8px[^}]*padding:10px clamp\(16px,5vw,64px\)/);
  assert.match(css,/\.primary-tabbar a\{[^}]*min-height:44px/);
  assert.match(css,/@media\(max-width:600px\)\{[^}]*\.primary-tabbar\{gap:5px;padding-inline:12px;\}[^}]*\.primary-tabbar a\{flex:1 1 0/);
  assert.match(css,/\.primary-tabbar a:focus-visible\{[^}]*outline:2px solid/);
  assert.match(css,/\.primary-tabbar a\[aria-current\],\s*\.primary-tabbar a\.active/);
  const home=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  assert.match(home,/\.matchday-dates-sticky\{position:sticky;top:var\(--am4-primary-stack-height\)/);
});
