const PUBLISHER_ID_PATTERN = /^(?:ca-)?pub-(?!0{16}$)\d{16}$/;

export function normalizeAdSensePublisherId(value) {
  const publisherId = typeof value === 'string' ? value.trim() : '';
  if (!PUBLISHER_ID_PATTERN.test(publisherId)) return null;
  return publisherId.startsWith('ca-') ? publisherId : `ca-${publisherId}`;
}

function adSenseLoaderSource(publisherId) {
  const source = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;
  return `(()=>{const load=()=>{if(document.querySelector('script[data-am4-adsense="true"]'))return;const path=location.pathname;const article=path==="/article.html"&&document.getElementById("am4-initial-article")&&document.querySelector(".article-body")?.textContent?.trim().length>=180;const match=path==="/match.html"&&document.getElementById("am4-initial-match")&&document.querySelector('[data-ssr-editorial]:not([data-ssr-editorial-pending="true"])')?.textContent?.trim().length>=180;if(!article&&!match)return;const script=document.createElement("script");script.async=true;script.src=${JSON.stringify(source)};script.crossOrigin="anonymous";script.dataset.am4Adsense="true";document.head.append(script);};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",load,{once:true});else load();})();`;
}

export function createAdSenseHandler({ publisherId } = {}) {
  const client = normalizeAdSensePublisherId(publisherId);

  return function handler(_request, response) {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (!client) return response.status(204).end();
    return response.status(200).send(adSenseLoaderSource(client));
  };
}
