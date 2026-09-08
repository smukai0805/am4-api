(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.install(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function install(environment) {
    const document = environment?.document;
    const root = document?.documentElement;
    const topbar = document?.querySelector('[data-sticky-topbar]');
    const navigation = document?.querySelector('[data-sticky-navigation]');
    if (!root?.style || !topbar || !navigation) return null;

    const sync = () => {
      const topbarHeight = Math.ceil(topbar.getBoundingClientRect().height);
      const navigationHeight = Math.ceil(navigation.getBoundingClientRect().height);
      if (topbarHeight > 0) root.style.setProperty('--am4-topbar-height', `${topbarHeight}px`);
      if (navigationHeight > 0) root.style.setProperty('--am4-primary-nav-height', `${navigationHeight}px`);
      if (topbarHeight > 0 && navigationHeight > 0) {
        root.style.setProperty('--am4-primary-stack-height', `${topbarHeight + navigationHeight}px`);
      }
    };

    sync();
    let observer = null;
    if (typeof environment.ResizeObserver === 'function') {
      observer = new environment.ResizeObserver(sync);
      observer.observe(topbar);
      observer.observe(navigation);
    }
    environment.addEventListener?.('pageshow', sync);
    return { sync, disconnect: () => observer?.disconnect() };
  }

  return { install };
});
