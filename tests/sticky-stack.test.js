const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stack = require('../sticky-stack');

function setup({topbar=61.2,navigation=60.1,resizeObserver=true}={}) {
  const values={};
  const elements={
    '[data-sticky-topbar]':{height:topbar,getBoundingClientRect(){return{height:this.height};}},
    '[data-sticky-navigation]':{height:navigation,getBoundingClientRect(){return{height:this.height};}},
  };
  const observed=[];const listeners={};
  const environment={
    document:{documentElement:{style:{setProperty:(key,value)=>{values[key]=value;}}},querySelector:key=>elements[key]},
    addEventListener:(type,listener)=>{listeners[type]=listener;},
  };
  if(resizeObserver) environment.ResizeObserver=class{constructor(listener){this.listener=listener;}observe(element){observed.push(element);}disconnect(){}};
  const installed=stack.install(environment);
  return{values,elements,observed,listeners,installed};
}

test('measured header height places the fixed home tabs directly below it',()=>{
  const {values,observed}=setup();
  assert.deepEqual(values,{'--am4-topbar-height':'62px','--am4-primary-nav-height':'61px','--am4-primary-stack-height':'123px'});
  assert.equal(observed.length,2);
});

test('a later logo or text resize updates both the tab offset and page spacer',()=>{
  const state=setup();
  state.elements['[data-sticky-topbar]'].height=67;
  state.elements['[data-sticky-navigation]'].height=62;
  state.installed.sync();
  assert.equal(state.values['--am4-topbar-height'],'67px');
  assert.equal(state.values['--am4-primary-stack-height'],'129px');
  state.listeners.pageshow();
  assert.equal(state.values['--am4-primary-nav-height'],'62px');
});

test('the home and 20 Seasons pages opt into the same measured stack',()=>{
  for(const file of ['index.html','column-20-seasons.html']){
    const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    assert.match(html,/data-sticky-topbar/);
    assert.match(html,/data-sticky-navigation/);
    assert.match(html,/sticky-stack\.js/);
  }
  const home=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'..','brand.css'),'utf8');
  assert.match(home,/top:var\(--am4-topbar-height\)/);
  assert.match(home,/padding-top:var\(--am4-primary-stack-height\)/);
  assert.match(css,/\.twenty-seasons-page\{[^}]*overflow-x:clip/);
  assert.match(css,/\.twenty-seasons-nav\{[^}]*top:var\(--am4-topbar-height,65px\)/);
});
