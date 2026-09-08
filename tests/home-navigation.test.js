const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup({hash='#favorites'}={}) {
  const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const navCode = source.slice(source.indexOf('  // ページ内ナビ：')).split('</script>')[0];
  const frames = [];
  const listeners = {};
  const events = [];
  let prepared = false;
  function element(id, top, shown = true) {
    return { id, hidden: false, style: {}, getClientRects: () => shown ? [{}] : [],
      getBoundingClientRect: () => ({ top, bottom: 132 }),
      scrollIntoView: () => { events.push(['scroll', id, prepared]); },
      focus: options => { events.push(['focus', id, options.preventScroll]); },
    };
  }
  const sections = [element('fixtures', -500), element('lead-story', 1800), element('favorites', 0, false)];
  const tabs = sections.map(target => ({ target, attrs: {href: `#${target.id}`},
    getAttribute(key) { return this.attrs[key]; },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    closest() { return this; }, classList: { toggle() {} },
  }));
  const nav = { querySelectorAll: () => tabs, getBoundingClientRect: () => ({bottom:132}),
    addEventListener: (type, fn) => { listeners[`nav:${type}`] = fn; },
  };
  const location = {hash};
  const document = {
    querySelector: () => nav, getElementById: id => sections.find(s => s.id === id),
    addEventListener: (type,fn) => { listeners[`document:${type}`]=fn; },
    dispatchEvent: event => { prepared = true; events.push(['prepare', event.type]); },
  };
  const history = {pushState: (_state, _unused, hash) => { location.hash = hash; events.push(['history', hash]); }};
  const requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  const window = { location, history, requestAnimationFrame, setTimeout: fn => frames.push(fn),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  vm.runInNewContext(navCode, {document, window, location, history, requestAnimationFrame,
    CustomEvent: class { constructor(type, options) { this.type=type; this.detail=options?.detail; } },
    MutationObserver: class { observe() {} },
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  return {tabs, listeners, events, flush};
}

test('scrollspy excludes CSS-hidden favorites rather than stealing current section', () => {
  const {tabs, flush} = setup();
  flush();
  assert.equal(tabs[0].attrs['aria-current'], 'location');
  assert.equal(tabs[2].attrs['aria-current'], undefined);
});

test('an arriving section realigns after asynchronous loading, then yields to reader interaction',()=>{
  const {listeners,events,flush}=setup({hash:'#lead-story'});
  listeners['document:am4:data-ready']();flush();
  assert.ok(events.some(event=>event[0]==='scroll'&&event[1]==='lead-story'));
  events.length=0;
  listeners.wheel();
  listeners['document:am4:data-ready']();flush();
  assert.deepEqual(events,[]);
});

test('a COLUMN page destination keeps native navigation while scrollspy still identifies the home section',()=>{
  const {tabs,listeners,events}=setup();
  tabs[1].attrs.href='/column';
  listeners['nav:click']({target:tabs[1],button:0,preventDefault:()=>assert.fail('page link intercepted')});
  assert.deepEqual(events,[]);
});

test('returning to a saved reading position takes precedence over initial hash alignment',()=>{
  const {listeners,events,flush}=setup({hash:'#lead-story'});
  listeners['document:am4:data-ready']({detail:{restoredHomeScroll:true}});
  flush();
  listeners['document:am4:data-ready']();flush();
  assert.deepEqual(events,[]);
});

test('COLUMN navigation settles section visibility before computing the scroll destination', () => {
  const {tabs, listeners, events, flush} = setup();
  let prevented = false;
  listeners['nav:click']({target:tabs[1],button:0,preventDefault:()=>{prevented=true;}});
  flush();
  assert.equal(prevented, true);
  assert.deepEqual(events.map(event=>event[0]), ['prepare', 'history', 'scroll', 'focus']);
  assert.deepEqual(events.at(-2), ['scroll','lead-story',true]);
  assert.deepEqual(events.at(-1), ['focus','lead-story',true]);
  assert.equal(tabs[1].target.tabIndex, -1);
});

test('modified clicks keep native new-tab navigation', () => {
  const {tabs, listeners, events} = setup();
  listeners['nav:click']({target:tabs[1],button:0,ctrlKey:true,preventDefault:()=>assert.fail('modified click intercepted')});
  assert.deepEqual(events, []);
});
