const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {readerDocument}=require('./helpers/reader-dom');
const code=fs.readFileSync(require.resolve('../column-index.js'),'utf8');
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const payload=(title='元のタイトル',page=1,total=10)=>({items:[{id:`story-${page}`,title,story:{category:'戦術史'},publishedAt:'2026-09-01'}],page,total,totalPages:Math.max(1,Math.ceil(total/8))});
async function setup(initial='/column', fetcher=async()=>({ok:true,json:async()=>payload()})) {
  const document=readerDocument();
  document.root.innerHTML='<form id="column-index-search"><input id="column-query"><button id="column-search-clear"></button></form><h2 id="column-results-title"></h2><p id="column-index-status"></p><nav class="column-pagination"></nav><div id="column-index-list"></div><button id="column-index-retry"></button><nav class="column-pagination"></nav>';
  const title=document.getElementById('column-results-title');
  title.focus=()=>{};title.scrollIntoView=()=>{};
  let location=new URL(initial,'https://am4football.com');
  const events={};
  const update=(_a,_b,url)=>{const next=new URL(url,location);for(const key of ['pathname','search','hash'])location[key]=next[key];};
  const context={document,location,URLSearchParams,URL,Intl,AbortController,
    AM4SiteConfig:require('../site-config'),fetch:fetcher,
    history:{replaceState:update,pushState:update},setTimeout:()=>1,clearTimeout:()=>{},
    window:{addEventListener:(type,fn)=>{events[type]=fn;}},
  };
  vm.runInNewContext(code,context);
  await drain();
  return {document,location,events,context};
}
test('compact archive fetches only requested page and preserves title and return context',async()=>{
  const requests=[];
  const {document}=await setup('/column?q=戦術&page=2',async url=>{requests.push(url);return{ok:true,json:async()=>payload('省略しない記事タイトル',2,10)};});
  assert.match(requests[0],/^\/api\/articles\?type=am4_story&page=2&pageSize=8&search=/);
  assert.equal(requests.length,1);
  const link=document.querySelector('.column-index-row').querySelector('a');
  assert.equal(link.textContent,'省略しない記事タイトル');
  const params=new URL(link.href,'https://am4football.com').searchParams;
  assert.equal(params.get('id'),'story-2');
  assert.equal(params.get('from'),'/column?q=%E6%88%A6%E8%A1%93&page=2#story-story-2');
  assert.equal(document.getElementById('column-index-status').textContent,'9–10 / 全10件');
});
test('slow previous search cannot overwrite new results and search always starts at page one',async()=>{
  const pending=[];
  const {document}=await setup('/column?page=2',url=>new Promise(resolve=>pending.push({url,resolve})));
  const input=document.getElementById('column-query');
  input.value='新しい検索';
  document.getElementById('column-index-search').listeners.submit({preventDefault(){}});
  pending[1].resolve({ok:true,json:async()=>payload('新しい結果',1,1)});await drain();
  assert.match(pending[1].url,/page=1/);
  pending[0].resolve({ok:true,json:async()=>payload('古い結果',2,10)});await drain();
  assert.match(document.getElementById('column-index-list').textContent,/新しい結果/);
  assert.doesNotMatch(document.getElementById('column-index-list').textContent,/古い結果/);
});
test('failed retrieval has retry and is distinct from zero search results',async()=>{
  let fails=true;
  const {document}=await setup('/column',async()=>fails?{ok:false}:{ok:true,json:async()=>({...payload('',1,0),items:[]})});
  assert.match(document.getElementById('column-index-status').textContent,/取得できません/);
  assert.equal(document.getElementById('column-index-retry').hidden,false);
  fails=false;document.getElementById('column-index-retry').listeners.click();await drain();
  assert.equal(document.getElementById('column-index-status').textContent,'0件');
  assert.equal(document.getElementById('column-index-retry').hidden,true);
});
test('pagination respects modified clicks and history navigation restores search input',async()=>{
  const {document,location,events}=await setup('/column?q=戦術');
  const pager=document.querySelector('.column-pagination');
  const next=pager.querySelector('a');next.closest=()=>next;
  pager.listeners.click({target:next,ctrlKey:true,preventDefault:()=>assert.fail('intercepted modified click')});
  assert.equal(location.search,'?q=%E6%88%A6%E8%A1%93');
  location.search='?q=歴史';events.popstate();await drain();
  assert.equal(document.getElementById('column-query').value,'歴史');
});
