const test=require('node:test');
const assert=require('node:assert/strict');
const {readerDocument}=require('./helpers/reader-dom');
const {appendReportSections}=require('../article-reading');

function setup(fields, options={}) {
  const document=readerDocument();
  const content=document.createElement('div');
  const blocks=fields.map(([field,label,text])=>{
    const block=document.createElement('article');
    block.dataset.reportField=field;
    const h=document.createElement('h3'); h.textContent=label;
    const p=document.createElement('p'); p.textContent=text;
    block.append(h,p); return block;
  });
  appendReportSections(content,blocks,options);
  return {content,blocks};
}
test('MOTM stays visible and every later block is retained, in order, under explicit review topics',()=>{
  const fields=[['playerOfMatch','MOTM','Haalandと選出理由。'],['keyFigures','試合主要人物','CostaとAït-Nouri。'],['turningPoints','試合を分けたポイント','元のポイント。'],['firstHalf','前半レビュー','前半の全文。'],['tactics','戦術分析','戦術の全文。']];
  const {content,blocks}=setup(fields);
  const details=content.querySelector('details');
  assert.equal(details.open,false);
  assert.equal(content.children[0].children[0],blocks[0]);
  assert.equal(content.children[0].children[1],blocks[1]);
  assert.deepEqual(details.querySelectorAll('article'),blocks.slice(2));
  assert.deepEqual(content.querySelectorAll('p').map(p=>p.textContent),fields.map(f=>f[2]));
  assert.match(details.querySelector('summary').textContent,/前半レビュー \/ 戦術分析/);
});
test('disclosure remembers opening and bottom close returns keyboard focus to its summary',()=>{
  let saved=false;
  const fields=[['secondHalf','後半レビュー','省略しない後半。']];
  const {content}=setup(fields,{onToggle:open=>{saved=open;}});
  const details=content.querySelector('details');
  details.open=true; details.listeners.toggle();
  assert.equal(saved,true);
  const restored=setup(fields,{open:saved});
  assert.equal(restored.content.querySelector('details').open,true);
  const summary=details.querySelector('summary');
  let focused=false,scrolled=false;
  summary.focus=()=>{focused=true;};summary.scrollIntoView=()=>{scrolled=true;};
  details.querySelector('button').listeners.click();
  details.listeners.toggle();
  assert.equal(details.open,false);assert.equal(saved,false);
  assert.ok(focused&&scrolled);
  assert.equal(details.querySelector('p').textContent,'省略しない後半。');
});
test('no empty disclosure when only MOTM exists, and late MOTM has a visible insertion point',()=>{
  const only=setup([['keyFigures','MOTM','理由']]);
  assert.equal(only.content.querySelector('details'),null);
  const late=setup([['firstHalf','前半レビュー','全文']]);
  assert.equal(late.content.children[0].className,'match-editorial-grid');
  assert.equal(late.content.children[0].childElementCount,0);
  assert.equal(late.content.children[1].tagName,'DETAILS');
});
