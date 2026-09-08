import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAdSenseHandler,
  normalizeAdSensePublisherId,
} from '../api/adsense.js';

const root = path.resolve(import.meta.dirname, '..');
const publisherId = `pub-${'1'.repeat(16)}`;
const clientId = `ca-${publisherId}`;
const zeroPublisherId = `pub-${'0'.repeat(16)}`;

function responseSpy() {
  const headers = new Map();
  return {
    body: undefined,
    statusCode: undefined,
    headers,
    setHeader(name, value) {
      headers.set(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    end(body = '') {
      this.body = body;
      return this;
    },
  };
}

test('AdSense publisher IDs are normalized only when they are real-looking publisher IDs', () => {
  assert.equal(normalizeAdSensePublisherId(publisherId), clientId);
  assert.equal(normalizeAdSensePublisherId(` ${clientId} `), clientId);
  assert.equal(normalizeAdSensePublisherId(''), null);
  assert.equal(normalizeAdSensePublisherId('pub-XXXXXXXXXXXXXXXX'), null);
  assert.equal(normalizeAdSensePublisherId(`ca-${zeroPublisherId}`), null);
  assert.equal(normalizeAdSensePublisherId('not-a-publisher'), null);
});

test('AdSense loader stays empty when no publisher ID is configured', () => {
  const response = responseSpy();
  createAdSenseHandler({ publisherId: '' })({}, response);

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers.get('Content-Type'), 'application/javascript; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('AdSense loader emits a single third-party script only for a configured publisher ID', () => {
  const response = responseSpy();
  createAdSenseHandler({ publisherId })({}, response);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, new RegExp(`pagead2\\.googlesyndication\\.com/pagead/js/adsbygoogle\\.js\\?client=${clientId}`));
  assert.match(response.body, /document\.head\.append/);
  assert.doesNotMatch(response.body, /<ins\b|adsbygoogle\.push/);
});

test('every public AM4 entry point links to privacy and only uses the first-party AdSense loader', () => {
  const pages = ['index.html', 'match.html', 'article.html', 'column-20-seasons.html', 'privacy.html'];

  for (const page of pages) {
    const document = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(document, /href="\/privacy"/);
    assert.match(document, /<script async src="\/api\/adsense\.js"><\/script>/);
    assert.doesNotMatch(document, /ca-pub-|googlesyndication\.com/);
  }
});

test('privacy policy covers the required disclosures without claiming AdSense is already active', () => {
  const privacy = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');

  for (const heading of [
    'AM4 Footballについて',
    'アクセス解析について',
    'Cookieの使用について',
    '第三者配信広告サービスについて',
    'Googleによるデータ利用について',
    '個人情報の取り扱い',
    '免責事項',
    '著作権について',
    'プライバシーポリシーの変更について',
  ]) {
    assert.match(privacy, new RegExp(heading));
  }

  assert.match(privacy, /Google AdSenseを含む第三者配信広告サービスを利用する場合があります/);
  assert.doesNotMatch(privacy, /Google AdSenseを利用しています/);
});

test('the homepage contains no exposed sample or version-marked fallback content', () => {
  const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.doesNotMatch(homepage, /SAMPLE FALLBACK|SAMPLE DATA|mainoo-old-trafford|matchday first \/ v0\.5|新しいコラムを準備中です/);
});

test('20 Seasons only describes published content and legacy prototypes stay out of deployments', () => {
  const seriesPage = fs.readFileSync(path.join(root, 'column-series-page.js'), 'utf8');
  const seriesHtml = fs.readFileSync(path.join(root, 'column-20-seasons.html'), 'utf8');
  const ignored = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');

  assert.doesNotMatch(seriesPage, /Coming Soon|STORIES ARE BEING PREPARED/);
  assert.doesNotMatch(seriesHtml, /STORIES ARE BEING PREPARED/);
  for (const file of ['football-hub.html', 'el-blanco.html', 'el-blanco-players.html', 'sample-football-data.js', 'docs/', 'tests/']) {
    assert.match(ignored, new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('privacy resolves consistently in Vercel and local Vite previews', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const vite = fs.readFileSync(path.join(root, 'vite.config.mjs'), 'utf8');

  assert.deepEqual(vercel.rewrites?.find(({ source }) => source === '/privacy'), {
    source: '/privacy',
    destination: '/privacy.html',
  });
  assert.match(vite, /url\.pathname==='\/privacy'/);
});
