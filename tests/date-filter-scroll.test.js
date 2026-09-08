const test=require('node:test');
const assert=require('node:assert/strict');
const {centerDateFilter}=require('../match-centre');

test('centering an offscreen date only scrolls its strip and cannot move the reading page',()=>{
  const calls=[];
  const container={scrollWidth:900,clientWidth:300,scrollLeft:200,getBoundingClientRect:()=>({left:100}),scrollTo:options=>calls.push(options)};
  const selected={getBoundingClientRect:()=>({left:500,width:60}),scrollIntoView:()=>assert.fail('ancestor scrolling must not occur')};
  centerDateFilter(container,selected,'smooth');
  assert.deepEqual(calls,[{left:480,behavior:'smooth'}]);
  assert.equal(Object.hasOwn(calls[0],'top'),false);
});

test('a date strip that already fits does not move or read a missing selection',()=>{
  const container={scrollWidth:300,clientWidth:300,scrollTo:()=>assert.fail('unnecessary scrolling')};
  centerDateFilter(container,{getBoundingClientRect:()=>assert.fail('unnecessary layout')});
  centerDateFilter(container,null);
});
