// Small deterministic DOM double for reader integration tests, not a browser
// replacement. Real layout/interaction are checked separately in browser QA.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
  }
  set textContent(value) { this.children = []; this.text = String(value ?? ''); }
  get textContent() { return (this.text || '') + this.children.map(child=>child.textContent).join(''); }
  get childElementCount() { return this.children.filter(child=>child.tagName !== '#TEXT').length; }
  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class || ''; }
  set id(value) { this.attributes.id = value; }
  get id() { return this.attributes.id || ''; }
  set href(value) { this.attributes.href = value; }
  get href() { return this.attributes.href || ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...nodes) {
    nodes.forEach(node => {
      if (node.tagName === '#FRAGMENT') { this.append(...node.children); return; }
      if (typeof node === 'string') node = this.ownerDocument.createTextNode(node);
      node.parentElement = this; this.children.push(node);
    });
  }
  prepend(...nodes) { const existing = this.children; this.children = []; this.append(...nodes, ...existing); }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child=>child !== this); }
  before(node) { const parent=this.parentElement; if (!parent) return; parent.children.splice(parent.children.indexOf(this),0,node); node.parentElement=parent; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  matches(selector) {
    const clean = selector.replace(':first-child','');
    if (clean.startsWith('.')) return this.className.split(/\s+/).includes(clean.slice(1));
    if (clean.startsWith('#')) return this.id === clean.slice(1);
    return this.tagName.toLowerCase() === clean;
  }
  querySelectorAll(selector) {
    if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part.trim())))];
    if (selector.startsWith(':scope > ')) return this.children.filter(child=>child.matches(selector.slice(9)));
    const parts = selector.split(/\s+/);
    if (parts.length > 1) return this.querySelectorAll(parts[0]).flatMap(child=>child.querySelectorAll(parts.slice(1).join(' ')));
    return this.children.flatMap(child=>[...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)?.[1];
        if (!tag) continue;
        const node = this.ownerDocument.createElement(tag);
        for (const attr of token.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1],attr[2]);
        stack.at(-1).append(node);
        if (!['img','br','input'].includes(tag)) stack.push(node);
      } else stack.at(-1).append(this.ownerDocument.createTextNode(token));
    }
  }
}

function readerDocument() {
  const document = {
    title: '', createElement: tag=>new Element(tag, document),
    createTextNode: text=>{const node=new Element('#text', document);node.textContent=text;return node;},
    createDocumentFragment: ()=>new Element('#fragment', document),
    dispatchEvent() {},
  };
  document.root = document.createElement('main');
  document.root.innerHTML = '<a class="article-back" href="/">ホームへ戻る</a><span id="article-brand-pill"></span><article id="article-paper"></article>';
  document.querySelector = selector=>document.root.querySelector(selector);
  document.querySelectorAll = selector=>document.root.querySelectorAll(selector);
  document.getElementById = id=>document.querySelector(`#${id}`);
  return document;
}
module.exports = {readerDocument};
