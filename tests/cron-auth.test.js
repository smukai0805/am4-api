import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedCronRequest } from '../lib/cron-auth.js';

test('only requests carrying the configured Cron secret can access internal jobs', () => {
  const secret = 'test-secret';
  assert.equal(isAuthorizedCronRequest({ headers: {} }, secret), false);
  assert.equal(isAuthorizedCronRequest({ headers: { authorization: 'Bearer wrong' } }, secret), false);
  assert.equal(isAuthorizedCronRequest({ headers: { authorization: 'Bearer test-secret' } }, secret), true);
});
