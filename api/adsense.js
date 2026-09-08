const PUBLISHER_ID_PATTERN = /^(?:ca-)?pub-(?!0{16}$)\d{16}$/;

export function normalizeAdSensePublisherId(value) {
  const publisherId = typeof value === 'string' ? value.trim() : '';
  if (!PUBLISHER_ID_PATTERN.test(publisherId)) return null;
  return publisherId.startsWith('ca-') ? publisherId : `ca-${publisherId}`;
}

function adSenseLoaderSource(publisherId) {
  const source = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;
  return `(()=>{if(document.querySelector('script[data-am4-adsense="true"]'))return;const script=document.createElement("script");script.async=true;script.src=${JSON.stringify(source)};script.crossOrigin="anonymous";script.dataset.am4Adsense="true";document.head.append(script);})();`;
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

export default function handler(request, response) {
  return createAdSenseHandler({
    publisherId: process.env.GOOGLE_ADSENSE_PUBLISHER_ID,
  })(request, response);
}
