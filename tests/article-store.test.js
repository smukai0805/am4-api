import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicArticle } from '../lib/article-visibility.js';

test('only explicitly published and public articles are eligible for the public API', () => {
  assert.equal(isPublicArticle({ status: 'published', public: true }), true);
  assert.equal(isPublicArticle({ status: 'published' }), true);
  assert.equal(isPublicArticle({ status: 'draft', public: true }), false);
  assert.equal(isPublicArticle({ status: 'published', public: false }), false);
  assert.equal(isPublicArticle({ public: true }), false);
});
