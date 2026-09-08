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
  const nav = html.match(new RegExp(`<nav class="${className}"[^>]*>([\\s\\S]*?)</nav>`));
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

test('20 Seasons keeps four full-width mobile tap targets', () => {
  const css=fs.readFileSync(path.join(__dirname,'..','brand.css'),'utf8');
  assert.match(css,/\.twenty-seasons-nav a\{[^}]*min-height:44px/);
  assert.match(css,/@media\(max-width:680px\)\{\.twenty-seasons-nav\{[^}]*gap:5px[^}]*padding-inline:12px[^}]*\}\.twenty-seasons-nav a\{[^}]*flex:1 1 0[^}]*min-width:0/);
});
