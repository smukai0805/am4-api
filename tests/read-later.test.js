const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {readerDocument} = require('./helpers/reader-dom');
const favorites = require('../favorites');
const code = fs.readFileSync(require.resolve('../read-later.js'),'utf8');
const drain = async () => {for(let i=0;i<50;i++) await Promise.resolve();};
const story = (id,type='am4_story') => ({id,type,title:`記事 ${id}`});
const response = (data,status=200) => ({ok:status===200,status,json:async()=>data});
async function setup({ids=[],catalog={},fetcher,hash=''}={}) {
  const document = readerDocument();
  const create = document.createElement;
  const scrolls = [];
  document.createElement = tag => {const el=create(tag); el.focus=()=>{document.activeElement=el;};el.scrollIntoView=()=>scrolls.push(el.id);return el;};
  document.root.innerHTML = '<h2 id="reading-saved-title"></h2><span id="reading-count"></span><p id="reading-status"></p><div id="reading-saved"></div><button id="reading-retry"></button><p id="reading-action-status"></p><button id="reading-undo"></button><div id="reading-suggestions"></div><p id="reading-suggestions-status"></p><button id="reading-suggestions-retry"></button>';
  const data = new Map();let failWrites=false;
  const storage = {getItem:key=>data.get(key)||null,setItem:(key,value)=>{if(failWrites)throw new Error('storage blocked');data.set(key,value);}};
  favorites.write(storage,{articles:ids,leagues:['39'],clubs:['42']});
  favorites.writeCatalog(storage,catalog);
  const requests=[];const events={};
  const context={document,localStorage:storage,URLSearchParams,AbortController,CustomEvent:class{},
    location:{hostname:'am4football.com',hash},setTimeout:()=>1,clearTimeout:()=>{},
    AM4SiteConfig:require('../site-config'),AM4Favorites:favorites,AM4ArticleLoadState:require('../article-load-state'),
    window:{addEventListener:(type,fn)=>{events[type]=fn;}},
    fetch:async url=>{requests.push(url);return fetcher?fetcher(url):response(url.includes('?id=')?{article:story(new URL(url,'https://am4football.com').searchParams.get('id'))}:{items:[story('a'),story('b'),story('c'),story('d')]});},
  };
  vm.runInNewContext(code,context);await drain();
  return {document,storage,requests,events,scrolls,failWrites:()=>{failWrites=true;}};
}
test('standalone reading list preserves saved IDs, sorts newest first and excludes saved recommendations',async()=>{
  const {document,storage,requests}=await setup({ids:['a','b']});
  assert.deepEqual(document.getElementById('reading-saved').querySelectorAll('h3').map(el=>el.textContent),['記事 b','記事 a']);
  assert.deepEqual(document.getElementById('reading-suggestions').querySelectorAll('h3').map(el=>el.textContent),['記事 c','記事 d']);
  assert.deepEqual(favorites.read(storage).articles,['a','b']);
  assert.deepEqual(favorites.read(storage).leagues,['39']);
  assert.equal(document.getElementById('reading-count').textContent,'2件');
  assert.equal(requests.length,3);
  assert.ok(requests.every(url=>url.startsWith('/api/articles?')));
  assert.equal(document.getElementById('reading-saved').querySelector('a').href,'/article.html?id=b&from=%2Fread-later%23saved-b');
});
test('no saved articles shows a reading empty state and working independent recommendations',async()=>{
  const {document}=await setup();
  assert.match(document.getElementById('reading-saved').textContent,/読みたい一編/);
  assert.equal(document.getElementById('reading-saved').querySelector('a').href,'/column');
  assert.equal(document.getElementById('reading-suggestions').querySelectorAll('article').length,3);
});
test('candidate failures cannot hide saved articles; retry restores only candidates',async()=>{
  let failed=true;
  const {document}=await setup({ids:['a'],fetcher:async url=>url.includes('?id=')?response({article:story('a')}):failed?response({},503):response({items:[story('b')]})});
  assert.match(document.getElementById('reading-saved').textContent,/記事 a/);
  assert.match(document.getElementById('reading-suggestions-status').textContent,/取得できません/);
  failed=false;document.getElementById('reading-suggestions-retry').listeners.click();await drain();
  assert.equal(document.getElementById('reading-suggestions-retry').hidden,true);
  assert.match(document.getElementById('reading-suggestions').textContent,/記事 b/);
});
test('temporary saved retrieval failure retains title and link; genuine missing items remain saved',async()=>{
  const {document,storage}=await setup({ids:['offline','missing'],catalog:{'articles:offline':{type:'articles',id:'offline',label:'以前保存した記事'}},fetcher:async url=>url.includes('id=offline')?response({},503):url.includes('id=missing')?response({},404):response({items:[]})});
  const rows=document.getElementById('reading-saved').querySelectorAll('article');
  assert.equal(rows[0].querySelector('a'),null);
  assert.match(rows[0].textContent,/保存はそのまま/);
  assert.equal(rows[1].querySelector('a').textContent,'以前保存した記事');
  assert.equal(document.getElementById('reading-retry').hidden,false);
  assert.deepEqual(favorites.read(storage).articles,['offline','missing']);
});
test('live Notion report before archive sync retains exact identity and fixture locator',async()=>{
  const article={...story('report','match_report'),match:{fixtureId:42}};
  const {document,requests}=await setup({ids:['report'],catalog:{'articles:report':{type:'articles',id:'report',href:'/article.html?id=report&fixtureId=42'}},fetcher:async url=>url.includes('?id=')?response({},404):url.includes('matchContent=1')?response({report:article}):response({items:[]})});
  const link=document.getElementById('reading-saved').querySelector('a');
  assert.equal(link.textContent,'記事 report');
  const params=new URL(link.href,'https://am4football.com').searchParams;
  assert.equal(params.get('fixtureId'),'42');
  assert.equal(params.get('from'),'/read-later#saved-report');
  assert.ok(requests.some(url=>url.includes('matchContent=1&fixtureId=42')));
});
test('remove and undo preserve other favorites and do not overwrite changes in another tab',async()=>{
  const {document,storage}=await setup({ids:['a','b']});
  document.getElementById('remove-saved-b').listeners.click();
  assert.deepEqual(favorites.read(storage).articles,['a']);
  assert.equal(document.activeElement.id,'reading-undo');
  favorites.write(storage,{...favorites.read(storage),articles:['a','c'],clubs:['99']});
  document.getElementById('reading-undo').listeners.click();
  assert.deepEqual(favorites.read(storage).articles,['a','c','b']);
  assert.deepEqual(favorites.read(storage).clubs,['99']);
  assert.equal(document.activeElement.id,'remove-saved-b');
});
test('failed removal keeps the article and reports failure next to its action',async()=>{
  const {document,storage,failWrites}=await setup({ids:['a']});
  failWrites();document.getElementById('remove-saved-a').listeners.click();
  assert.deepEqual(favorites.read(storage).articles,['a']);
  assert.match(document.getElementById('reading-action-status').textContent,/解除できません/);
  assert.match(document.getElementById('reading-saved').textContent,/記事 a/);
});
test('reading return locates its saved row and subsequent loading yields to reader interaction',async()=>{
  const {events,scrolls}=await setup({ids:['a'],hash:'#saved-a'});
  assert.ok(scrolls.includes('saved-a'));
  const count=scrolls.length;events.wheel();events.pageshow({persisted:true});await drain();
  assert.equal(scrolls.length,count);
});
test('storage changes sync saved rows and suggestions; late removed-article response cannot resurrect it',async()=>{
  let resolve;
  const {document,storage,events}=await setup({ids:['a'],fetcher:url=>url.includes('?id=')?new Promise(done=>{resolve=done;}):response({items:[story('a'),story('b')]})});
  favorites.write(storage,{...favorites.read(storage),articles:[]});
  events.storage({key:favorites.STORAGE_KEY});await drain();
  resolve(response({article:story('a')}));await drain();
  assert.equal(document.getElementById('reading-count').textContent,'0件');
  assert.match(document.getElementById('reading-suggestions').textContent,/記事 a/);
});
test('navigation enters an independent page, and legacy hash links migrate without article storage changes',()=>{
  const home=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const page=fs.readFileSync(require.resolve('../read-later.html'),'utf8');
  assert.match(home,/<a class="tag" href="\/read-later">あとで読む<\/a>/);
  assert.match(home,/location\.hash === '#for-you'\) location\.replace\('\/read-later'\)/);
  assert.doesNotMatch(home,/id="for-you"/);
  assert.doesNotMatch(page,/id="fixture-list"|id="lead-story"/);
  assert.match(page,/href="\/read-later" aria-current="page"/);
  assert.ok(JSON.parse(fs.readFileSync(require.resolve('../vercel.json'),'utf8')).rewrites.some(route=>route.source==='/read-later'));
});
test('a recommended article saved while reading returns to its new saved-list row',async()=>{
  const {document,scrolls}=await setup({ids:['a'],hash:'#suggested-a'});
  assert.equal(document.getElementById('suggested-a'),null);
  assert.ok(scrolls.includes('saved-a'));
});
test('late article metadata preserves keyboard focus on another article link',async()=>{
  let resolve;
  const {document}=await setup({ids:['a','b'],fetcher:url=>url.includes('id=b')?new Promise(done=>{resolve=done;}):url.includes('id=a')?response({article:story('a')}):response({items:[]})});
  document.getElementById('open-saved-a').focus();
  resolve(response({article:story('b')}));await drain();
  assert.equal(document.activeElement,document.getElementById('open-saved-a'));
});
