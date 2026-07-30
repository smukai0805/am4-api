// lib/article-store.js
//
// 選手紹介記事(player_intro)・試合解説記事(match_report)の永久保存用ストア。
// 「下書きログに1ファイル追記していく」方式(academy-core.js/match-report-core.jsの
// 旧saveDraft())から、記事1本ごとに恒久的なレコードとして保存する方式に変更した。
//
// 【保存構成】Vercel Blob(プライベートストア、このリポジトリの既存パターンを踏襲)。
//   - articles/index.json : 一覧・ページネーション用の軽量メタデータ配列(新着順)。
//     フル本文は含まない(一覧表示のたびに全記事の本文を読み込まずに済むようにするため)。
//   - articles/{id}.json  : 記事1本ごとの完全なレコード(本文・出典含む)。
// 個別ファイル+インデックスファイルの2層構成にすることで、一覧取得はindex.jsonだけを
// 読めば済み、個別記事の取得もid直読みで済む(全件を読んでからフィルタする必要がない)。
//
// 【レコードの形】
// {
//   id: string,              // スラッグ。例: '2026-05-03-manchester-united-vs-liverpool'
//   type: 'player_intro' | 'match_report',
//   title: string,
//   publishedAt: string,     // ISO8601
//   body: string,             // Markdown本文
//   hasScoreTable: boolean,  // match_reportの場合、採点表つきフル版かどうか
//   sources: Array<{ title: string|null, url: string }>,
//   status: 'draft' | 'published', // 現状は自動公開しないため、常にdraftで保存される
// }

import { put, get } from '@vercel/blob';

const INDEX_PATHNAME = 'articles/index.json';

function articlePathname(id) {
  return `articles/${id}.json`;
}

// タイトル・日付等から、URLやファイル名に使えるスラッグを生成する。
// 英数字以外はハイフンに置き換え、連続ハイフン・前後のハイフンを整理する。
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // アクセント記号除去(é→e等)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function loadIndex() {
  try {
    const result = await get(INDEX_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('article index load error:', err.message);
    return [];
  }
}

async function saveIndex(index) {
  await put(INDEX_PATHNAME, JSON.stringify(index), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

// 記事1本を保存する(新規作成/上書き更新の両方に対応、idが既存なら上書き)。
export async function saveArticle(article) {
  if (!article.id) throw new Error('article.id is required');

  await put(articlePathname(article.id), JSON.stringify(article), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });

  const index = await loadIndex();
  const meta = {
    id: article.id,
    type: article.type,
    title: article.title,
    publishedAt: article.publishedAt,
    hasScoreTable: article.hasScoreTable ?? null,
    status: article.status,
    // 短文(移籍速報など、300字以下)の場合のみ一覧メタデータにも本文・出典を含める。
    // 一覧取得だけで表示が完結できるようにするため(試合解説・選手紹介のような
    // 長文記事は個別取得(?id=)側でのみ本文を返す設計を維持し、index.jsonの肥大化を防ぐ)。
    ...(article.body && article.body.length <= 300
      ? { body: article.body, sources: article.sources || [] }
      : {}),
  };
  const filtered = index.filter(e => e.id !== article.id);
  filtered.push(meta);
  filtered.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  await saveIndex(filtered);

  return article;
}

export async function getArticle(id) {
  try {
    const result = await get(articlePathname(id), { access: 'private', useCache: false });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (err) {
    console.error(`article load error (${id}):`, err.message);
    return null;
  }
}

// 一覧・ページネーション用。typeを指定すると絞り込み、指定しなければ全種別混合。
export async function listArticles({ type, page = 1, pageSize = 10 } = {}) {
  const index = await loadIndex();
  const filtered = type ? index.filter(e => e.type === type) : index;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  return { items, page: safePage, pageSize, total, totalPages };
}
