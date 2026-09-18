// Select an explicitly connected staging Blob store only for the isolated
// monitor Preview. The normal BLOB_* variables remain untouched everywhere
// else, including Production. This avoids pointing a test deployment at the
// reader-facing store merely because Vercel shares Preview environment names.

export const MONITOR_PREVIEW_BLOB_PREFIX = 'AM4_MONITOR_PREVIEW_';

export function configureMonitorPreviewBlobEnvironment(env = process.env) {
  if (String(env.AM4_MONITOR_STAGING || '') !== '1') return false;
  // Vercel's resource connection applies the chosen prefix to its canonical
  // `READ_WRITE_TOKEN` variable. The store id is deliberately derived from
  // the token rather than copied into another deployment variable.
  const token = String(env[`${MONITOR_PREVIEW_BLOB_PREFIX}READ_WRITE_TOKEN`] || '').trim();
  const storeId = token.split('_')[3] || '';
  // Never fall back to the normal Production-capable credentials when a
  // deployment claims to be staging. Failing closed is safer than a repair
  // test accidentally writing an article to the live store.
  if (!token || !storeId) throw new Error('AM4 monitor staging Blob credentials are incomplete');
  env.BLOB_READ_WRITE_TOKEN = token;
  env.BLOB_STORE_ID = storeId;
  return true;
}

configureMonitorPreviewBlobEnvironment();
