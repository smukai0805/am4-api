import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureMonitorPreviewBlobEnvironment,
  MONITOR_PREVIEW_BLOB_PREFIX,
} from '../lib/blob-environment.js';

test('isolated monitor Preview replaces only its process-local Blob credentials', () => {
  const env = {
    AM4_MONITOR_STAGING: '1',
    BLOB_READ_WRITE_TOKEN: 'live-token',
    BLOB_STORE_ID: 'store-live',
    [`${MONITOR_PREVIEW_BLOB_PREFIX}READ_WRITE_TOKEN`]: 'vercel_blob_rw_store-preview_secret',
  };
  assert.equal(configureMonitorPreviewBlobEnvironment(env), true);
  assert.equal(env.BLOB_READ_WRITE_TOKEN, 'vercel_blob_rw_store-preview_secret');
  assert.equal(env.BLOB_STORE_ID, 'store-preview');
});

test('a claimed staging deployment fails closed when its dedicated Blob connection is absent', () => {
  assert.throws(
    () => configureMonitorPreviewBlobEnvironment({ AM4_MONITOR_STAGING: '1', BLOB_READ_WRITE_TOKEN: 'live-token' }),
    /staging Blob credentials are incomplete/,
  );
  assert.equal(configureMonitorPreviewBlobEnvironment({ BLOB_READ_WRITE_TOKEN: 'live-token' }), false);
});
