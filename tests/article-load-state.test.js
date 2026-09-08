const test = require("node:test");
const assert = require("node:assert/strict");
const { articleLoadState } = require("../article-load-state.js");
const {articleHref,readArticle}=require('../article-load-state.js');

test("article loading distinguishes a missing article from temporary failures", () => {
  assert.equal(articleLoadState({ status: 404, hasArticle: false }), "missing");
  assert.equal(articleLoadState({ status: 500, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ status: 503, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ error: new TypeError("network") }), "unavailable");
  assert.equal(articleLoadState({ status: 200, hasArticle: false }), "unavailable");
  assert.equal(articleLoadState({ status: 200, hasArticle: true }), "ready");
});

test('a saved published match article stays readable before archive sync, with its exact identity',async()=>{
  const article={id:'notion-report-a',type:'match_report',body:'失ってはいけない解説'};
  const href=articleHref(article,123);
  assert.equal(href,'/article.html?id=notion-report-a&fixtureId=123');
  const calls=[];
  const fetcher=async url=>{calls.push(url);return url.includes('matchContent')?{ok:true,json:async()=>({report:article})}:{ok:false,status:404};};
  const result=await readArticle({fetcher,apiBase:'/api',id:article.id,fixtureId:123});
  assert.equal(result.state,'ready');assert.equal(result.article,article);
  assert.deepEqual(calls,['/api/articles?id=notion-report-a','/api/articles?matchContent=1&fixtureId=123']);
  const wrong=await readArticle({fetcher,apiBase:'/api',id:'another-report',fixtureId:123});
  assert.equal(wrong.state,'missing');
});

test('saved previews resolve by ID even when a report is also published',async()=>{
  const prediction={id:'prediction-a',type:'match_prediction',body:'元の事前予想'};
  const result=await readArticle({apiBase:'/api',id:prediction.id,fixtureId:123,
    fetcher:async url=>url.includes('matchContent')?{ok:true,json:async()=>({prediction,report:{id:'report-a',type:'match_report'}})}:{ok:false,status:404}});
  assert.equal(result.article,prediction);
});

test('normal articles and archive outages do not trigger a match lookup, partial responses stay unavailable',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return{ok:false,status:503};};
  assert.equal((await readArticle({fetcher,apiBase:'/api',id:'a',fixtureId:123})).state,'unavailable');
  assert.equal(calls,1);
  assert.equal(articleHref({id:'column',type:'am4_story'},123),'/article.html?id=column');
  const partial=await readArticle({apiBase:'/api',id:'a',fixtureId:123,fetcher:async url=>url.includes('matchContent')?{ok:true,json:async()=>({partial:true,errors:{match_report:true}})}:{ok:false,status:404}});
  assert.equal(partial.state,'unavailable');
});
