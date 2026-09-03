import test from 'node:test';
import assert from 'node:assert/strict';
import { articleCoverImage, articleMatchesSearch, articlePopularRank, articlePriority, articleTags } from '../lib/article-taxonomy.js';

test('article tags retain explicit editorial tags and safely derive useful legacy tags', () => {
  const article = {
    tags: ['#AC Milan', 'Arrigo Sacchi', 'tactics'],
    story: {
      category: '戦術史',
      relatedClubs: 'AC Milan / Real Madrid ほか',
    },
  };

  assert.deepEqual(articleTags(article), ['AC Milan', 'Arrigo Sacchi', 'tactics', 'Real Madrid']);
});

test('article search includes title, summary, body, and derived tags', () => {
  const article = {
    title: 'サッキのミラン',
    summary: '守備で攻める革命を読む。',
    body: 'ゾーン・プレスとハイラインを整理する。',
    story: { category: '戦術史', relatedClubs: 'AC Milan' },
  };

  assert.equal(articleMatchesSearch(article, 'ミラン'), true);
  assert.equal(articleMatchesSearch(article, 'ハイライン'), true);
  assert.equal(articleMatchesSearch(article, 'tactics'), true);
  assert.equal(articleMatchesSearch(article, 'ドルトムント'), false);
});

test('optional popularity and cover metadata never invent values', () => {
  assert.equal(articlePopularRank('2'), 2);
  assert.equal(articlePopularRank(0), null);
  assert.equal(articlePriority('100'), 100);
  assert.equal(articlePriority(0), 0);
  assert.equal(articleCoverImage({ coverImage: 'https://images.example/cover.jpg' }), 'https://images.example/cover.jpg');
  assert.equal(articleCoverImage({ coverImage: '/not-a-public-image.jpg' }), null);
});
