(() => {
  const entityPath = /^\/(?:teams|players)\/[1-9]\d*\/?$/;
  let feedback = null;
  let resetTimer = null;

  function plainNavigation(event) {
    return !event.defaultPrevented && event.button === 0
      && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function ensureFeedback() {
    if (feedback) return feedback;
    const style = document.createElement('style');
    style.id = 'am4-entity-navigation-feedback-style';
    style.textContent = '#am4-entity-navigation-feedback{position:fixed;z-index:9999;top:max(10px,env(safe-area-inset-top));right:12px;display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:0 12px;border:1px solid rgba(157,194,255,.48);border-radius:999px;background:rgba(7,20,48,.94);box-shadow:0 8px 26px rgba(0,0,0,.38);color:#eff6ff;font:700 10px/1 system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;pointer-events:none;opacity:0;transform:translateY(-6px);transition:opacity .14s ease,transform .14s ease}#am4-entity-navigation-feedback.is-visible{opacity:1;transform:translateY(0)}#am4-entity-navigation-feedback[hidden]{display:none}.am4-entity-navigation-feedback-bar{width:19px;height:3px;overflow:hidden;border-radius:999px;background:rgba(154,190,255,.22)}.am4-entity-navigation-feedback-bar::after{display:block;width:58%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#78a8ff,#fff,#78a8ff);box-shadow:0 0 8px #bbd5ff;content:"";animation:am4-entity-navigation-progress .9s ease-in-out infinite}@keyframes am4-entity-navigation-progress{0%{transform:translateX(-110%)}100%{transform:translateX(200%)}}@media(prefers-reduced-motion:reduce){#am4-entity-navigation-feedback{transition:none}.am4-entity-navigation-feedback-bar::after{animation:none;transform:translateX(35%)}}';
    document.head.append(style);
    feedback = document.createElement('div');
    feedback.id = 'am4-entity-navigation-feedback';
    feedback.hidden = true;
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    const bar = document.createElement('span');
    bar.className = 'am4-entity-navigation-feedback-bar';
    bar.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'am4-entity-navigation-feedback-label';
    feedback.append(bar, label);
    document.body.append(feedback);
    return feedback;
  }

  function hideFeedback() {
    if (resetTimer != null) window.clearTimeout(resetTimer);
    resetTimer = null;
    if (!feedback) return;
    feedback.classList.remove('is-visible');
    feedback.hidden = true;
  }

  function showFeedback(kind) {
    const node = ensureFeedback();
    const label = node.querySelector('.am4-entity-navigation-feedback-label');
    if (label) label.textContent = kind === 'teams' ? 'チーム詳細を開いています' : '選手詳細を開いています';
    node.hidden = false;
    node.classList.add('is-visible');
    if (resetTimer != null) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(hideFeedback, 20_000);
  }

  document.addEventListener('click', (event) => {
    if (!plainNavigation(event)) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || link.target || link.hasAttribute('download') || link.hasAttribute('data-entity-tab')) return;
    let target;
    try { target = new URL(link.href, window.location.origin); } catch (_error) { return; }
    if (target.origin !== window.location.origin || !entityPath.test(target.pathname)) return;
    showFeedback(target.pathname.startsWith('/teams/') ? 'teams' : 'players');
  }, true);

  window.addEventListener('pageshow', hideFeedback);
})();
