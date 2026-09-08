const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {readerDocument} = require('./helpers/reader-dom');
const source = fs.readFileSync(path.join(__dirname, '../article-page.js'), 'utf8');
const reading = require('../article-reading');
const series = require('../column-series');

const article = {
  id:'stable-existing-id', type:'am4_story', title:'変えない記事タイトル',
  body:'## 同じ見出し\n\n失ってはいけない本文。\n\n> 引用も維持。\n\n1. 元のリスト\n2. その続き\n\n## 同じ見出し\n\n| 項目 | 値 |\n| --- | --- |\n| 得点 | 2 |\n\n出典 https://example.org/archive。',
  story:{series:series.SERIES_NAME,season:'2015-16'}, sources:[], tags:['歴史'],
};

async function load({enhancer=reading, status=200, recommendationsFail=false, seriesPageStalls=false, from='', storageFails=false}={}) {
  const document = readerDocument();
  const saved = new Map();
  const localStorage = {getItem:key=>saved.get(key) ?? null, setItem:(key,value)=>{if(storageFails) throw new Error('storage unavailable'); saved.set(key,value);}};
  const requests = [];
  const context = {document, localStorage, sessionStorage:localStorage, URL, URLSearchParams,
    location:{hostname:'am4football.com',search:`?id=stable-existing-id&from=${encodeURIComponent(from)}`},
    AM4SiteConfig:require('../site-config'), AM4ArticlePresentation:require('../article-presentation'),
    AM4ArticleContent:require('../article-content'), AM4ArticleLoadState:require('../article-load-state'),
    AM4Favorites:require('../favorites'), CustomEvent:class{},
    fetch:async url=>{
      requests.push(url);
      if (url.includes('?id=')) return {ok:status===200,status,json:async()=>({article})};
      if (recommendationsFail) throw new Error('offline');
      if (seriesPageStalls && url.includes('&page=2')) return new Promise(()=>{});
      return {ok:true,json:async()=>({items:[article,{...article,id:'next',title:'次の記事',story:{...article.story,season:'2016-17'}}],totalPages:seriesPageStalls ? 2 : 1})};
    },
  };
  context.window = {...context, AM4ArticleReading:enhancer, AM4ColumnSeries:series};
  vm.runInNewContext(source, context);
  // Drain promise-only fetch/render tasks without timers or network.
  for (let index=0; index<15; index++) await Promise.resolve();
  return {document, requests};
}

test('existing ID renders body, duplicate headings, lists, tables, quotes and working save with enhancements', async () => {
  const {document,requests} = await load();
  assert.equal(requests[0], '/api/articles?id=stable-existing-id');
  assert.equal(document.querySelector('.article-title').textContent, article.title);
  assert.match(document.querySelector('.article-body').textContent, /失ってはいけない本文。/);
  assert.equal(document.querySelector('blockquote').textContent, '引用も維持。');
  assert.equal(document.querySelector('td').textContent, '得点');
  assert.match(document.querySelector('.article-body').textContent, /元のリストその続き/);
  const headings = document.querySelector('.article-body').querySelectorAll(':scope > h2');
  assert.deepEqual(headings.map(heading=>heading.id), ['article-section-1','article-section-2']);
  assert.deepEqual(document.querySelector('.article-toc').querySelectorAll('a').map(link=>link.href), ['#article-section-1','#article-section-2']);
  assert.ok(document.querySelector('.article-body').querySelectorAll('a').some(link=>link.href==='https://example.org/archive'));
  const save = document.querySelector('.favorite-btn');
  save.listeners.click();
  assert.equal(save.getAttribute('aria-pressed'), 'true');
  assert.match(document.querySelector('.article-back').href, /\/column\/20-seasons#season-2015-16/);
  assert.ok(document.querySelector('.article-series-navigation').querySelectorAll('a').some(link=>link.href==='/article.html?id=next'));
});

test('top and bottom Read Later buttons stay in sync without changing article body', async () => {
  const {document} = await load();
  const top = document.querySelector('.read-later-button');
  const bottom = document.querySelector('.article-footer-actions').querySelector('.favorite-btn');
  const text = document.querySelector('blockquote').textContent;
  top.listeners.click();
  assert.equal(bottom.getAttribute('aria-pressed'),'true');
  assert.equal(top.getAttribute('aria-label'),'あとで読むから解除');
  bottom.listeners.click();
  assert.equal(top.getAttribute('aria-pressed'),'false');
  assert.equal(document.querySelector('blockquote').textContent,text);
});

test('failed storage remains unsaved and is explained beside the top control', async () => {
  const {document} = await load({storageFails:true});
  const top = document.querySelector('.read-later-button');
  top.listeners.click();
  assert.equal(top.getAttribute('aria-pressed'),'false');
  assert.match(document.querySelector('.article-top-save-status').textContent,/保存できません/);
  assert.match(document.querySelector('.article-body').textContent,/失ってはいけない本文/);
});

test('COLUMN return preserves search, page and row even for a series article; external paths are rejected', async () => {
  const from='/column?q=歴史&page=2#story-stable-existing-id';
  const valid=await load({from});
  assert.equal(valid.document.querySelector('.article-back').href,from);
  assert.equal(valid.document.querySelector('.article-back').textContent,'← COLUMN一覧へ戻る');
  for (const from of ['//evil.example/column','/column/evil','https://evil.example/column']) {
    const invalid=await load({from});
    assert.match(invalid.document.querySelector('.article-back').href,/^\/column\/20-seasons/);
  }
});

test('a legacy saved-list return migrates to the dedicated reading page, including series stories', async () => {
  const from='/?matchDate=2026-09-08&matchFilter=2026-09-08#for-you';
  const {document}=await load({from});
  assert.equal(document.querySelector('.article-back').href,'/read-later');
  assert.equal(document.querySelector('.article-back').textContent,'← あとで読むへ戻る');
  assert.ok(document.querySelector('.article-series-navigation'));
});

test('an optional reading enhancement exception cannot remove the loaded article', async () => {
  const {document} = await load({enhancer:{enhanceArticle(){throw new Error('optional enhancement broke');}}});
  assert.equal(document.querySelector('.article-title').textContent, article.title);
  assert.match(document.querySelector('.article-body').textContent, /失ってはいけない本文。/);
  assert.equal(document.querySelector('.article-state'), null);
});

test('missing optional JS or recommendations failure cannot remove article, save or collection return', async () => {
  const {document} = await load({enhancer:null,recommendationsFail:true});
  assert.ok(document.querySelector('.article-body'));
  assert.ok(document.querySelector('.favorite-btn'));
  assert.equal(document.querySelector('.article-state'), null);
  assert.match(document.querySelector('.article-back').href, /20-seasons/);
});

test('existing missing and temporary failure states stay distinct with retry', async () => {
  const missing = await load({status:404});
  assert.match(missing.document.title, /記事が見つかりません/);
  const unavailable = await load({status:503});
  assert.match(unavailable.document.title, /記事を取得できませんでした/);
  assert.equal(typeof unavailable.document.querySelector('button').listeners.click, 'function');
});

test('a stalled optional series page does not delay existing recommendation cards', async () => {
  const {document,requests} = await load({seriesPageStalls:true});
  assert.ok(requests.some(url=>url.includes('&page=2')));
  assert.ok(document.querySelector('.article-body'));
  assert.equal(document.querySelector('.article-related').hidden, false);
  assert.equal(document.querySelector('.article-related-card').href, '/article.html?id=next');
});


test('saved and suggested article returns preserve the dedicated reading row and reject unsafe destinations', async () => {
  for (const from of ['/read-later','/read-later#saved-stable-existing-id','/read-later#suggested-stable-existing-id']) {
    const {document}=await load({from});
    assert.equal(document.querySelector('.article-back').href,from);
    assert.equal(document.querySelector('.article-back').textContent,'← あとで読むへ戻る');
    assert.match(document.querySelector('.article-body').textContent,/失ってはいけない本文/);
  }
  for (const from of ['//evil.example/read-later','/read-later/evil','/read-later?url=https://evil.example']) {
    const {document}=await load({from});
    assert.match(document.querySelector('.article-back').href,/^\/column\/20-seasons/);
  }
});
